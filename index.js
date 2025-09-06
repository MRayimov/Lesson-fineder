// bot.js
require('dotenv').config();
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// ---------- HTTP keep-alive agent to reduce ETIMEDOUT ----------
const agent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 10000,
	timeout: 30000,
});

// ---------- Bot ----------
const bot = new Telegraf(process.env.BOT_TOKEN, {
	telegram: { agent },
});

// ---------- SQLite ----------
const db = new Database('videos.db');
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS videos (
    chat_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    chat_title TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(chat_id, title)
  );

  CREATE TABLE IF NOT EXISTS user_memberships (
    user_id    TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    last_seen  INTEGER NOT NULL,
    chat_title TEXT,
    UNIQUE(user_id, chat_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_chat_title
    ON videos(chat_id, title);
  CREATE INDEX IF NOT EXISTS idx_videos_chat_created
    ON videos(chat_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_chat
    ON user_memberships(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_user_last
    ON user_memberships(user_id, last_seen DESC);
`);

const upsertVideo = db.prepare(`
  INSERT INTO videos (chat_id, title, message_id, chat_title, created_at)
  VALUES (@chat_id, @title, @message_id, @chat_title, @created_at)
  ON CONFLICT(chat_id, title) DO UPDATE SET
    message_id=excluded.message_id,
    chat_title=excluded.chat_title,
    created_at=excluded.created_at
`);

const exactVideo = db.prepare(`
  SELECT chat_id, message_id, chat_title FROM videos
  WHERE chat_id = ? AND LOWER(title) = LOWER(?)
  LIMIT 1
`);

const likeVideos = db.prepare(`
  SELECT chat_id, title, message_id, chat_title FROM videos
  WHERE chat_id = ? AND INSTR(LOWER(title), LOWER(?)) > 0
  ORDER BY created_at DESC
  LIMIT 5
`);

const listChatVideos = db.prepare(`
  SELECT chat_id, title, message_id, chat_title, created_at
  FROM videos
  WHERE chat_id = ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);
const countChatVideos = db.prepare(
	`SELECT COUNT(*) AS c FROM videos WHERE chat_id = ?`
);

const listUserVideos = db.prepare(`
  SELECT v.chat_id, v.title, v.message_id, v.chat_title, v.created_at
  FROM videos v
  JOIN user_memberships um ON um.chat_id = v.chat_id
  WHERE um.user_id = ?
  ORDER BY v.created_at DESC
  LIMIT ? OFFSET ?
`);
const countUserVideos = db.prepare(`
  SELECT COUNT(*) AS c
  FROM videos v
  JOIN user_memberships um ON um.chat_id = v.chat_id
  WHERE um.user_id = ?
`);

const upsertMembership = db.prepare(`
  INSERT INTO user_memberships (user_id, chat_id, last_seen, chat_title)
  VALUES (@user_id, @chat_id, @last_seen, @chat_title)
  ON CONFLICT(user_id, chat_id) DO UPDATE SET
    last_seen=excluded.last_seen,
    chat_title=COALESCE(excluded.chat_title, user_memberships.chat_title)
`);

const findUserChats = db.prepare(`
  SELECT chat_id, chat_title FROM user_memberships
  WHERE user_id = ?
  ORDER BY last_seen DESC
`);

// ---------- Helpers ----------
const isGroup = chat =>
	chat && (chat.type === 'group' || chat.type === 'supergroup');
const normalizeTitle = s => (s || '').trim().replace(/\s+/g, ' ');
const trunc = (s, n = 50) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// ---------- Rate limit & retry helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Global throttle (~25 msgs/sec)
let lastGlobal = 0;
async function globalThrottle() {
	const now = Date.now();
	const delta = now - lastGlobal;
	const minGap = 40; // ms
	if (delta < minGap) await sleep(minGap - delta);
	lastGlobal = Date.now();
}

// Per-chat queue (≈ 1 msg/sec per chat)
const chatLocks = new Map();
function queueForChat(chatId, task) {
	const key = String(chatId);
	const prev = chatLocks.get(key) || Promise.resolve();
	const next = prev
		.catch(() => {}) // keep chain alive
		.then(async () => {
			await sleep(1100);
			return task();
		});
	chatLocks.set(key, next);
	return next;
}

// Unified Telegram call with retry_after support
async function tgCall(fn) {
	try {
		await globalThrottle();
		return await fn();
	} catch (e) {
		const retry =
			e?.on?.parameters?.retry_after ??
			e?.parameters?.retry_after ??
			e?.response?.parameters?.retry_after;
		const is429 =
			e?.code === 429 ||
			e?.statusCode === 429 ||
			e?.description?.includes?.('Too Many Requests');
		if (is429 && retry) {
			await sleep((Number(retry) + 1) * 1000);
			await globalThrottle();
			return await fn();
		}
		throw e;
	}
}

// Safe wrappers (always use these for send/edit/forward)
async function safeReply(ctx, text, extra) {
	const targetId = String(ctx.chat?.id || ctx.from?.id);
	return queueForChat(targetId, () => tgCall(() => ctx.reply(text, extra)));
}
async function safeAnswerCb(ctx, text, extra) {
	const targetId = String(ctx.chat?.id || ctx.from?.id);
	return queueForChat(targetId, () =>
		tgCall(() => ctx.answerCbQuery(text, extra))
	);
}
async function safeForward(telegram, toId, fromChatId, messageId) {
	const targetId = String(toId);
	return queueForChat(targetId, () =>
		tgCall(() =>
			telegram.forwardMessage(targetId, fromChatId, Number(messageId))
		)
	);
}
async function safeEditReplyMarkup(ctx, markup) {
	const targetId = String(ctx.chat?.id || ctx.from?.id);
	return queueForChat(targetId, () =>
		tgCall(() => ctx.editMessageReplyMarkup(markup))
	);
}

// ---------- Commands ----------
bot.telegram.setMyCommands([
	{ command: 'help', description: 'Yordam' },
	{ command: 'find', description: 'Dars qidirish: /find <nom>' },
	{ command: 'darslar', description: '📚 Darslar menyusi' },
]);

// 0) Track memberships on any message in groups
bot.on('message', (ctx, next) => {
	try {
		const m = ctx.message;
		const chat = m?.chat;
		if (isGroup(chat) && !m.from?.is_bot) {
			upsertMembership.run({
				user_id: String(m.from.id),
				chat_id: String(chat.id),
				last_seen: Date.now(),
				chat_title: chat.title || null,
			});
		}
	} catch (e) {
		console.error('membership upsert error', e);
	}
	return next();
});

// 1) Index videos/documents with captions or file_name
bot.on(['video', 'document'], ctx => {
	try {
		const msg = ctx.message;
		const chat = msg.chat;
		if (!isGroup(chat)) return;

		let title = normalizeTitle(msg.caption);
		if (!title && msg.document?.file_name) {
			title = normalizeTitle(msg.document.file_name.replace(/\.[^.]+$/, ''));
		}

		const isVideoType =
			!!msg.video ||
			(msg.document?.mime_type && msg.document.mime_type.startsWith('video/'));

		if (!isVideoType || !title) return;

		upsertVideo.run({
			chat_id: String(chat.id),
			title,
			message_id: msg.message_id,
			chat_title: chat.title || null,
			created_at: Date.now(),
		});
	} catch (e) {
		console.error('index error', e);
	}
});

// 1a) Re-index on caption edits for video-like messages
bot.on('edited_message', ctx => {
	try {
		const msg = ctx.update.edited_message;
		const chat = msg.chat;
		if (!isGroup(chat)) return;

		const title = normalizeTitle(msg.caption);
		const looksLikeVideo =
			!!msg.video ||
			!!msg.animation ||
			!!msg.video_note ||
			(msg.document?.mime_type && msg.document.mime_type.startsWith('video/'));

		if (!looksLikeVideo || !title) return;

		upsertVideo.run({
			chat_id: String(chat.id),
			title,
			message_id: msg.message_id,
			chat_title: chat.title || null,
			created_at: Date.now(),
		});
	} catch (e) {
		console.error('edited index error', e);
	}
});

// 2) /find
bot.command('find', async ctx => {
	const msg = ctx.message;
	const chat = msg.chat;

	const fullText = ctx.message.text || '';
	const m = fullText.replace(/^\/find(@[a-zA-Z0-9_]+)?/i, '').trim();
	const q = normalizeTitle(
		m.startsWith('"') && m.endsWith('"') && m.length > 1 ? m.slice(1, -1) : m
	);

	if (!q) {
		return safeReply(ctx, 'Qidiruv: /find <video nomi> yoki /find "aniq nom"');
	}

	try {
		if (isGroup(chat)) {
			const chatId = String(chat.id);

			const ex = exactVideo.get(chatId, q.toLowerCase());
			if (ex) {
				return safeForward(ctx.telegram, chatId, chatId, ex.message_id).catch(
					() =>
						safeReply(
							ctx,
							'Xabar topildi, lekin forward qilib bo‘lmadi (o‘chirilgan bo‘lishi mumkin).'
						)
				);
			}

			const like = likeVideos.all(chatId, q);
			if (like.length === 1) {
				return safeForward(
					ctx.telegram,
					chatId,
					chatId,
					like[0].message_id
				).catch(() =>
					safeReply(ctx, 'Xabar topildi, lekin forward qilib bo‘lmadi.')
				);
			}
			if (like.length > 1) {
				const list = like.map(r => `• ${r.title}`).join('\n');
				return safeReply(
					ctx,
					`Yaqin variantlar:\n${list}\n\nAniqroq nom kiriting.`
				);
			}

			return safeReply(
				ctx,
				'Topilmadi. Nomi aniqroq yoki to‘liq yozib ko‘ring.'
			);
		} else {
			// Private: search across user memberships
			const userId = String(msg.from.id);
			const chats = findUserChats.all(userId);
			if (!chats.length) {
				return safeReply(
					ctx,
					'Siz bilan umumiy guruhlarda indekslangan darslar topilmadi. Avval guruhda /find yoki 📚 Darslar menyusini sinab ko‘ring.'
				);
			}

			// exact matches across chats
			const exactHits = [];
			for (const c of chats) {
				const row = exactVideo.get(c.chat_id, q.toLowerCase());
				if (row) exactHits.push(row);
			}
			if (exactHits.length === 1) {
				return safeForward(
					ctx.telegram,
					userId,
					exactHits[0].chat_id,
					exactHits[0].message_id
				).catch(() => safeReply(ctx, 'Topildi, lekin forward qilib bo‘lmadi.'));
			}
			if (exactHits.length > 1) {
				const list = exactHits
					.map((h, i) => `${i + 1}) ${h.chat_title || h.chat_id}`)
					.join('\n');
				return safeReply(
					ctx,
					`Bu nom bir nechta guruhda topildi:\n${list}\nAniqroq yozing (guruh nomi yoki qo‘shimcha so‘zlar).`
				);
			}

			// fuzzy hits across chats
			const likeHits = [];
			for (const c of chats) {
				const rows = likeVideos.all(c.chat_id, q);
				for (const r of rows) likeHits.push(r);
				if (likeHits.length >= 6) break;
			}
			if (likeHits.length === 1) {
				return safeForward(
					ctx.telegram,
					userId,
					likeHits[0].chat_id,
					likeHits[0].message_id
				).catch(() => safeReply(ctx, 'Topildi, lekin forward qilib bo‘lmadi.'));
			}
			if (likeHits.length > 1) {
				const grouped = likeHits
					.slice(0, 10)
					.map(h => `• [${h.chat_title || h.chat_id}] ${h.title}`)
					.join('\n');
				return safeReply(
					ctx,
					`Aniq moslik topilmadi, lekin yaqin variantlar bor:\n${grouped}\n\nAniqroq nom kiriting.`
				);
			}

			return safeReply(
				ctx,
				'Hech narsa topilmadi. Nomi aniqroq yozib ko‘ring.'
			);
		}
	} catch (e) {
		console.error('find error', e);
	}
});

// 3) 📚 Darslar menyusi
bot.command('darslar', async ctx => showLessonsMenu(ctx));
bot.hears('📚 Darslar', async ctx => showLessonsMenu(ctx));

async function showLessonsMenu(ctx, offset = 0) {
	const chat = ctx.chat;
	const limit = 8; // slightly smaller page to reduce spam

	if (isGroup(chat)) {
		const chatId = String(chat.id);
		const total = countChatVideos.get(chatId).c;
		if (total === 0) {
			return safeReply(
				ctx,
				'Bu guruhda indekslangan darslar topilmadi. Video tashlab, caption ga nom yozing.'
			);
		}
		const rows = listChatVideos.all(chatId, limit, offset);

		const kb = rows.map(r => [
			Markup.button.callback(
				trunc(r.title, 48),
				`L|${r.chat_id}|${r.message_id}`
			),
		]);

		const nav = [];
		if (offset > 0) {
			nav.push(
				Markup.button.callback(
					'⬅️ Oldingi',
					`P|chat|${chatId}|${Math.max(0, offset - limit)}`
				)
			);
		}
		if (offset + limit < total) {
			nav.push(
				Markup.button.callback(
					'Keyingi ➡️',
					`P|chat|${chatId}|${offset + limit}`
				)
			);
		}
		if (nav.length) kb.push(nav);

		return safeReply(
			ctx,
			`📚 Darslar (${offset + 1}–${Math.min(
				offset + limit,
				total
			)} / ${total})`,
			Markup.inlineKeyboard(kb)
		);
	} else {
		const userId = String(ctx.from.id);
		const total = countUserVideos.get(userId).c;
		if (total === 0) {
			return safeReply(
				ctx,
				'Siz bo‘lgan guruhlarda indekslangan darslar topilmadi.'
			);
		}
		const rows = listUserVideos.all(userId, limit, offset);

		const kb = rows.map(r => [
			Markup.button.callback(
				trunc(`[${r.chat_title || r.chat_id}] ${r.title}`, 48),
				`L|${r.chat_id}|${r.message_id}`
			),
		]);

		const nav = [];
		if (offset > 0) {
			nav.push(
				Markup.button.callback(
					'⬅️ Oldingi',
					`P|user|${userId}|${Math.max(0, offset - limit)}`
				)
			);
		}
		if (offset + limit < total) {
			nav.push(
				Markup.button.callback(
					'Keyingi ➡️',
					`P|user|${userId}|${offset + limit}`
				)
			);
		}
		if (nav.length) kb.push(nav);

		return safeReply(
			ctx,
			`📚 Darslar (${offset + 1}–${Math.min(
				offset + limit,
				total
			)} / ${total})`,
			Markup.inlineKeyboard(kb)
		);
	}
}

// 4) Callback handler with debounce
const handledCallbacks = new Set();
setInterval(() => handledCallbacks.clear(), 30000); // clean every 30s

bot.on('callback_query', async ctx => {
	try {
		const id = ctx.callbackQuery.id;
		if (handledCallbacks.has(id)) {
			return safeAnswerCb(ctx, '⏳', { cache_time: 2 }).catch(() => {});
		}
		handledCallbacks.add(id);

		const data = ctx.callbackQuery.data || '';
		if (data.startsWith('L|')) {
			const [, chatId, messageId] = data.split('|');
			const isPrivate = ctx.chat?.type === 'private';
			const targetId = isPrivate ? String(ctx.from.id) : String(ctx.chat.id);

			await safeForward(ctx.telegram, targetId, chatId, messageId).catch(() =>
				safeAnswerCb(
					ctx,
					'Forward qilib bo‘lmadi (xabar o‘chirilgan bo‘lishi mumkin).',
					{ show_alert: true }
				)
			);
			await safeAnswerCb(ctx, 'Yuborildi.').catch(() => {});
			// remove keyboard to reduce duplicate taps
			await safeEditReplyMarkup(ctx, undefined).catch(() => {});
			return;
		}

		if (data.startsWith('P|')) {
			// pagination
			const parts = data.split('|'); // P|chat|<chatId>|<offset> or P|user|<userId>|<offset>
			const scope = parts[1];
			const offset = Number(parts[3] || 0);
			await safeAnswerCb(ctx, '⏭️').catch(() => {});
			return showLessonsMenu(ctx, offset);
		}
	} catch (e) {
		console.error('callback error', e);
	}
});

// 5) /help
bot.command('help', ctx => {
	return safeReply(
		ctx,
		`Qoidalar:
• Video faqat guruhga tashlangan bo‘lsa indekslanadi (caption — nom sifatida).
• Qidiruv faqat /find orqali:
   – Guruhda: /find <nom> → shu guruhdan forward
   – Private: /find <nom> → siz bor guruhlarda qidiradi
• 📚 Darslar: /darslar yoki "📚 Darslar" tugmasi
   – Guruhda: shu guruh darslari ro‘yxati
   – Private: siz bor guruhlardagi darslar ro‘yxati
• BotFather: /setprivacy → Disable (guruh xabarlarini ko‘rish va a’zolikni bilish uchun).`,
		Markup.keyboard([['📚 Darslar']]).resize()
	);
});

// ---------- Central error catcher ----------
bot.catch(async (err, ctx) => {
	console.error('Unhandled bot error:', err);
	if (ctx?.chat?.type === 'private') {
		try {
			await safeReply(ctx, 'Kutilmagan texnik nosozlik. Qayta urinib ko‘ring.');
		} catch {}
	}
});

// ---------- Start ----------
bot.launch().then(() => console.log('Bot is running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
