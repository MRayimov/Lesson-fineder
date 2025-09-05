require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ---- SQLite ----
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
    user_id   TEXT NOT NULL,
    chat_id   TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    chat_title TEXT,
    UNIQUE(user_id, chat_id)
  );

  -- Indekslar (tezlik uchun)
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

/* LIKE o‘rniga INSTR+LOWER bilan barqaror qidiruv */
const likeVideos = db.prepare(`
  SELECT chat_id, title, message_id, chat_title FROM videos
  WHERE chat_id = ? AND INSTR(LOWER(title), LOWER(?)) > 0
  ORDER BY created_at DESC
  LIMIT 5
`);

/* Menyu ro‘yxatlari uchun */
const listChatVideos = db.prepare(`
  SELECT chat_id, title, message_id, chat_title, created_at
  FROM videos
  WHERE chat_id = ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);
const countChatVideos = db.prepare(`
  SELECT COUNT(*) AS c FROM videos WHERE chat_id = ?
`);
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

// Helpers
const isGroup = chat =>
	chat && (chat.type === 'group' || chat.type === 'supergroup');
const normalizeTitle = s => (s || '').trim().replace(/\s+/g, ' ');
const trunc = (s, n = 50) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/* /start va /help komandalarini ro‘yxatdan o‘tkazamiz */
bot.telegram.setMyCommands([
	{ command: 'help', description: 'Yordam' },
	{ command: 'find', description: 'Dars qidirish: /find <nom>' },
	{ command: 'darslar', description: '📚 Darslar menyusi' },
]);

// ---- 0) Guruhdagi har qanday xabarda a’zolikni kuzatamiz ----
bot.on('message', (ctx, next) => {
	try {
		const m = ctx.message;
		const chat = m.chat;
		const inGroup =
			chat && (chat.type === 'group' || chat.type === 'supergroup');
		if (inGroup && !m.from.is_bot) {
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
	return next(); // /find, menyu va boshqalarga yo‘l beramiz
});

// ---- 1) Video/Document kelganda indekslash ----
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

// ---- 1a) Caption tahrir bo‘lsa qayta indekslash ----
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

// ---- 2) /find komanda ----
bot.command('find', async ctx => {
	const msg = ctx.message;
	const chat = msg.chat;

	const fullText = ctx.message.text || '';
	const m = fullText.replace(/^\/find(@[a-zA-Z0-9_]+)?/i, '').trim();
	const q = normalizeTitle(
		m.startsWith('"') && m.endsWith('"') && m.length > 1 ? m.slice(1, -1) : m
	);

	if (!q) {
		return ctx.reply('Qidiruv: /find <video nomi> yoki /find "aniq nom"');
	}

	try {
		if (isGroup(chat)) {
			const chatId = String(chat.id);

			const ex = exactVideo.get(chatId, q.toLowerCase());
			if (ex) {
				return ctx.telegram
					.forwardMessage(chatId, chatId, ex.message_id)
					.catch(() =>
						ctx.reply(
							'Xabar topildi, lekin forward qilib bo‘lmadi (o‘chirilgan bo‘lishi mumkin).'
						)
					);
			}

			const like = likeVideos.all(chatId, q);
			if (like.length === 1) {
				return ctx.telegram
					.forwardMessage(chatId, chatId, like[0].message_id)
					.catch(() =>
						ctx.reply('Xabar topildi, lekin forward qilib bo‘lmadi.')
					);
			}
			if (like.length > 1) {
				const list = like.map(r => `• ${r.title}`).join('\n');
				return ctx.reply(`Yaqin variantlar:\n${list}\n\nAniqroq nom kiriting.`);
			}

			return ctx.reply('Topilmadi. Nomi aniqroq yoki to‘liq yozib ko‘ring.');
		} else {
			// Private: foydalanuvchi bor guruhlar bo‘yicha qidirish
			const userId = String(msg.from.id);
			const chats = findUserChats.all(userId);
			if (!chats.length) {
				return ctx.reply(
					'Siz bilan umumiy guruhlarda indekslangan darslar topilmadi. Avval guruhda /find yoki 📚 Darslar menyusini sinab ko‘ring.'
				);
			}

			// 1) aniq moslik
			const exactHits = [];
			for (const c of chats) {
				const row = exactVideo.get(c.chat_id, q.toLowerCase());
				if (row) exactHits.push(row);
			}
			if (exactHits.length === 1) {
				return ctx.telegram
					.forwardMessage(userId, exactHits[0].chat_id, exactHits[0].message_id)
					.catch(() => ctx.reply('Topildi, lekin forward qilib bo‘lmadi.'));
			}
			if (exactHits.length > 1) {
				const list = exactHits
					.map((h, i) => `${i + 1}) ${h.chat_title || h.chat_id}`)
					.join('\n');
				return ctx.reply(
					`Bu nom bir nechta guruhda topildi:\n${list}\nAniqroq yozing (guruh nomi yoki qo‘shimcha so‘zlar).`
				);
			}

			// 2) LIKE
			const likeHits = [];
			for (const c of chats) {
				const rows = likeVideos.all(c.chat_id, q);
				for (const r of rows) likeHits.push(r);
				if (likeHits.length >= 6) break;
			}
			if (likeHits.length === 1) {
				return ctx.telegram
					.forwardMessage(userId, likeHits[0].chat_id, likeHits[0].message_id)
					.catch(() => ctx.reply('Topildi, lekin forward qilib bo‘lmadi.'));
			}
			if (likeHits.length > 1) {
				const grouped = likeHits
					.slice(0, 10)
					.map(h => `• [${h.chat_title || h.chat_id}] ${h.title}`)
					.join('\n');
				return ctx.reply(
					`Aniq moslik topilmadi, lekin yaqin variantlar bor:\n${grouped}\n\nAniqroq nom kiriting.`
				);
			}

			return ctx.reply('Hech narsa topilmadi. Nomi aniqroq yozib ko‘ring.');
		}
	} catch (e) {
		console.error('find error', e);
	}
});

// ---- 3) 📚 Darslar menyusi ----
// /darslar komanda va “📚 Darslar” tugmasi orqali ishga tushadi
bot.command('darslar', async ctx => showLessonsMenu(ctx));
bot.hears('📚 Darslar', async ctx => showLessonsMenu(ctx));

async function showLessonsMenu(ctx, offset = 0) {
	const chat = ctx.chat;
	const limit = 10;

	if (isGroup(chat)) {
		// Guruhdagi darslar
		const chatId = String(chat.id);
		const total = countChatVideos.get(chatId).c;
		if (total === 0) {
			return ctx.reply(
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

		// sahifalash
		const nav = [];
		if (offset > 0)
			nav.push(
				Markup.button.callback(
					'⬅️ Oldingi',
					`P|chat|${chatId}|${Math.max(0, offset - limit)}`
				)
			);
		if (offset + limit < total)
			nav.push(
				Markup.button.callback(
					'Keyingi ➡️',
					`P|chat|${chatId}|${offset + limit}`
				)
			);
		if (nav.length) kb.push(nav);

		return ctx.reply(
			`📚 Darslar (${offset + 1}–${Math.min(
				offset + limit,
				total
			)} / ${total})`,
			Markup.inlineKeyboard(kb)
		);
	} else {
		// Private: foydalanuvchi bor guruhlardagi darslar
		const userId = String(ctx.from.id);
		const total = countUserVideos.get(userId).c;
		if (total === 0) {
			return ctx.reply(
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
		if (offset > 0)
			nav.push(
				Markup.button.callback(
					'⬅️ Oldingi',
					`P|user|${userId}|${Math.max(0, offset - limit)}`
				)
			);
		if (offset + limit < total)
			nav.push(
				Markup.button.callback(
					'Keyingi ➡️',
					`P|user|${userId}|${offset + limit}`
				)
			);
		if (nav.length) kb.push(nav);

		return ctx.reply(
			`📚 Darslar (${offset + 1}–${Math.min(
				offset + limit,
				total
			)} / ${total})`,
			Markup.inlineKeyboard(kb)
		);
	}
}

// Callback handlerlar:
//  - L|<chatId>|<messageId>  → shu xabarni forward qiladi
//  - P|chat|<chatId>|<offset> → guruh sahifalash
//  - P|user|<userId>|<offset> → private sahifalash
bot.on('callback_query', async ctx => {
	try {
		const data = ctx.callbackQuery.data || '';
		if (data.startsWith('L|')) {
			const [, chatId, messageId] = data.split('|');
			const isPrivate = ctx.chat?.type === 'private';
			const targetId = isPrivate ? String(ctx.from.id) : String(ctx.chat.id);

			await ctx.telegram
				.forwardMessage(targetId, chatId, Number(messageId))
				.catch(() =>
					ctx.answerCbQuery(
						'Forward qilib bo‘lmadi (xabar o‘chirilgan bo‘lishi mumkin).',
						{ show_alert: true }
					)
				);
			await ctx.answerCbQuery('Yuborildi.');
			return;
		}

		if (data.startsWith('P|')) {
			const parts = data.split('|'); // P|chat|<chatId>|<offset> yoki P|user|<userId>|<offset>
			const scope = parts[1];
			const id = parts[2];
			const offset = Number(parts[3] || 0);

			if (scope === 'chat') {
				return showLessonsMenu(ctx, offset); // guruh kontekstida chat.id baribir mavjud
			}
			if (scope === 'user') {
				// Private kontekstida ham ayni funksiya ishlaydi (showLessonsMenu ichida private yo‘li bor)
				return showLessonsMenu(ctx, offset);
			}
		}
	} catch (e) {
		console.error('callback error', e);
	}
});

// ---- /help ----
bot.command('help', ctx => {
	return ctx.reply(
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

// ---- Start ----
bot.launch().then(() => console.log('Bot is running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
