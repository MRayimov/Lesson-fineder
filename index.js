require('dotenv').config();
const { Telegraf } = require('telegraf');
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
  WHERE chat_id = ? AND title LIKE ?
  ORDER BY created_at DESC
  LIMIT 5
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

// ---- 0) Guruhdagi har qanday xabarda a’zolikni kuzatib boramiz (private chat emas) ----
// OLDINGI (muammo): next() yo‘q edi, zanjir to‘xtab qoladi
// bot.on('message', (ctx) => { ... });

// TO‘G‘RISI:
bot.on('message', (ctx, next) => {
	try {
		const m = ctx.message;
		const chat = m.chat;
		const isGroup =
			chat && (chat.type === 'group' || chat.type === 'supergroup');
		if (isGroup) {
			// user ↔ chat a’zolikni yozib boramiz
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
	return next(); // <<< MUHIM: keyingi handlerlarga o'tkazamiz (masalan, /find)
});

// ---- 1) Guruhga video tashlanganda indekslash (caption yoki file_name nom sifatida) ----
bot.on(['video', 'document'], ctx => {
	try {
		const msg = ctx.message;
		console.log(
			'[INDEX] chat',
			msg.chat.id,
			'msg',
			msg.message_id,
			'caption=',
			msg.caption,
			'file=',
			msg.document?.file_name
		);
		const chat = msg.chat;
		if (!isGroup(chat)) return;

		let title = normalizeTitle(msg.caption);
		if (!title && msg.document?.file_name) {
			title = normalizeTitle(msg.document.file_name.replace(/\.[^.]+$/, ''));
		}

		const isVideo =
			!!msg.video ||
			(msg.document?.mime_type && msg.document.mime_type.startsWith('video/'));

		if (!isVideo || !title) return;

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

// ---- 2) /find komanda: guruhda → faqat shu guruhdan; private → a’zo bo‘lgan guruhlardan ----
bot.command('find', async ctx => {
	const msg = ctx.message;
	const chat = msg.chat;

	// /find buyrug‘idan keyingi matnni olish ("/find My video" yoki "/find\nMy video")
	const fullText = ctx.message.text || '';
	console.log(
		'[FIND] from',
		ctx.from.id,
		'in chat',
		ctx.chat.id,
		'text=',
		fullText
	);
	const q = normalizeTitle(
		fullText.replace(/^\/find(@[a-zA-Z0-9_]+)?/i, '')
	).trim();
	if (!q) {
		return ctx.reply('Qidiruv: /find <video nomi>');
	}

	try {
		if (isGroup(chat)) {
			// --- Guruh ichida qidirish: faqat shu guruhdan forward ---
			const chatId = String(chat.id);

			const ex = exactVideo.get(chatId, q.toLowerCase());
			if (ex) {
				await ctx.telegram.forwardMessage(chatId, chatId, ex.message_id);
				return;
			}

			const like = likeVideos.all(chatId, `%${q}%`);
			if (like.length === 1) {
				await ctx.telegram.forwardMessage(chatId, chatId, like[0].message_id);
				return;
			}
			if (like.length > 1) {
				const list = like.map(r => `• ${r.title}`).join('\n');
				await ctx.reply(`Yaqin variantlar:\n${list}\n\nAniqroq nom kiriting.`);
				return;
			}

			// topilmadi — hech narsa yubormaymiz (xohlasangiz xabar yozing)
			return;
		} else {
			// --- Private chat: foydalanuvchi a’zo bo‘lgan (va bot ham a’zo) guruhlarda qidirish ---
			const userId = String(msg.from.id);
			const chats = findUserChats.all(userId);
			if (!chats.length) {
				// bot foydalanuvchini hech bir guruhda uchratmagan
				return ctx.reply(
					'Siz bo‘lgan guruhlarda mening xabarim yo‘q. Avval guruhda /find ishlating yoki oddiy xabar yozing.'
				);
			}

			// 1) aniq mosliklarni tekshiramiz
			const exactHits = [];
			for (const c of chats) {
				const row = exactVideo.get(c.chat_id, q.toLowerCase());
				if (row)
					exactHits.push({
						chat_id: row.chat_id,
						message_id: row.message_id,
						chat_title: row.chat_title,
					});
			}

			if (exactHits.length === 1) {
				await ctx.telegram.forwardMessage(
					userId,
					exactHits[0].chat_id,
					exactHits[0].message_id
				);
				return;
			}
			if (exactHits.length > 1) {
				const list = exactHits
					.map((h, i) => `${i + 1}) ${h.chat_title || h.chat_id}`)
					.join('\n');
				await ctx.reply(
					`Bu nom bir nechta guruhda topildi:\n${list}\nAniqroq yozing (guruh nomi yoki qo‘shimcha so‘zlar).`
				);
				return;
			}

			// 2) LIKE qidiruv
			const likeHits = [];
			for (const c of chats) {
				const rows = likeVideos.all(c.chat_id, `%${q}%`);
				for (const r of rows) {
					likeHits.push({
						chat_id: r.chat_id,
						title: r.title,
						message_id: r.message_id,
						chat_title: r.chat_title,
					});
				}
				if (likeHits.length >= 6) break; // cheklaymiz
			}

			if (likeHits.length === 1) {
				await ctx.telegram.forwardMessage(
					userId,
					likeHits[0].chat_id,
					likeHits[0].message_id
				);
				return;
			}
			if (likeHits.length > 1) {
				const grouped = likeHits
					.slice(0, 10)
					.map(h => `• [${h.chat_title || h.chat_id}] ${h.title}`)
					.join('\n');
				await ctx.reply(
					`Aniq moslik topilmadi, lekin yaqin variantlar bor:\n${grouped}\n\nAniqroq nom kiriting.`
				);
				return;
			}

			// umuman topilmadi — jim yoki xabar
			// return ctx.reply('Topilmadi.');
			return;
		}
	} catch (e) {
		console.error('find error', e);
	}
});

// ---- /help ----
bot.command('help', ctx => {
	ctx.reply(
		`Qoidalar:
• Video faqat guruhga tashlangan bo‘lsa indekslanadi (caption — nom sifatida).
• Qidiruv ENDI faqat /find orqali:
   – Guruhda: /find <nom> → shu guruhdan forward
   – Private: /find <nom> → siz a’zo bo‘lgan guruhlarda qidiradi
• BotFather: /setprivacy → Disable (guruh xabarlarini ko‘rish va a’zolikni bilish uchun).`
	);
});

// ---- Start ----
bot.launch().then(() => console.log('Bot is running...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
