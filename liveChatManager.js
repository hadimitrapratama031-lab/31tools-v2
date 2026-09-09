// ══════════════════════════════════════════════════════════════════════════
// LIVE CHAT MANAGER — modul BARU & TERPISAH untuk fitur "Live Chat Support"
// antara User (App Desktop) dan Admin (Admin Web).
//
// Desain sengaja SATU koleksi (`liveChatMessages`) sebagai single source of
// truth — daftar percakapan (sidebar Admin), status unread, last message, dsb
// semua dihitung on-the-fly dari koleksi ini (agregasi), BUKAN disimpan
// terpisah di koleksi/dokumen "conversation" sendiri.
//
// REALTIME: reuse hub WebSocket yang SUDAH ADA di server.js (wsSendToUser buat
// push ke User yang bersangkutan, broadcastAdmin buat push ke SEMUA Admin yang
// sedang buka halaman Live Chat) — TIDAK bikin WebSocket server baru sama
// sekali, konsisten dengan pola realtime fitur lain (transaction:update,
// steamAccounts:order:update, dst).
//
// EXPIRY PESAN — 24 JAM SEJAK createdAt (PER PESAN, BUKAN pergantian hari):
//   Setiap pesan hidup TEPAT 24 jam sejak `createdAt`-nya masing-masing.
//   Pesan yang dikirim jam 23:00 tetap ada saat lewat tengah malam, dan baru
//   hilang jam 23:00 keesokan harinya — sengaja TIDAK ada logic "hapus semua
//   begitu tanggal berganti" di mana pun di modul ini.
//   1) TTL index MongoDB (expireAfterSeconds: 86400) di field `createdAt` —
//      penghapusan asli di level database, background task Mongo (jalan
//      tiap ~60 detik) yang menghapus dokumen begitu umurnya > 24 jam.
//   2) Karena background task Mongo itu tidak instan (bisa telat beberapa
//      puluh detik dari 24 jam presisi), SEMUA query baca (getUserMessages,
//      conversationSummary, listConversations, getUnreadCountForUser) juga
//      memfilter eksplisit `createdAt >= (sekarang - 24 jam)` — jadi pesan
//      yang sudah lewat 24 jam TIDAK PERNAH ikut tampil di APP maupun Admin
//      Web, walau proses TTL Mongo belum sempat jalan.
//   3) `cleanupExpiredMessages()` — cron ringan tiap 5 menit (dipanggil dari
//      server.js) yang secara aktif men-DELETE pesan berumur > 24 jam
//      langsung dari database (murni berdasar umur/`createdAt`, BUKAN
//      berdasar pergantian tanggal) — pelengkap TTL index supaya data lama
//      benar-benar tidak menumpuk di DB, terlepas dari kapan Mongo TTL sweep
//      kebetulan jalan.
// ══════════════════════════════════════════════════════════════════════════

const sanitizeHtml = require('sanitize-html');

const MAX_TEXT_LEN = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — cukup untuk screenshot, ringan buat DB
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX = 8; // maks 8 pesan / 10 detik / user — anti spam ringan, tanpa dependency baru
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // dipakai filter "Sedang Aktif" di sidebar Admin
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // masa aktif pesan: 24 jam sejak createdAt masing-masing

// Filter Mongo `createdAt >= (sekarang - 24 jam)` — dipakai di SEMUA query baca
// supaya pesan yang umurnya sudah lewat 24 jam tidak pernah ikut ditampilkan,
// terlepas dari kapan TTL index Mongo kebetulan jalan membersihkannya.
function notExpiredFilter() {
  return { createdAt: { $gte: new Date(Date.now() - MESSAGE_TTL_MS) } };
}

module.exports = function createLiveChatManager({
  getDb, wsSendToUser, broadcastAdmin, wsBroadcastAll, isUserOnline, isAdminOnline, logActivity,
  notifyAdminsNewMessage
}) {
  function db() { return getDb(); }

  // ── Anti Spam / Rate Limit pengiriman pesan (in-memory, per discordId) ──
  const rateMap = new Map();
  function checkRateLimit(discordId) {
    const now = Date.now();
    let arr = (rateMap.get(discordId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) { rateMap.set(discordId, arr); return false; }
    arr.push(now);
    rateMap.set(discordId, arr);
    return true;
  }
  // Bersihkan entry lama dari memori tiap 5 menit biar tidak numpuk (user yang
  // sudah lama tidak kirim pesan otomatis hilang dari rateMap).
  setInterval(() => {
    const now = Date.now();
    for (const [id, arr] of rateMap.entries()) {
      const fresh = arr.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) rateMap.delete(id); else rateMap.set(id, fresh);
    }
  }, 5 * 60 * 1000);

  // ── Sanitasi pesan — Anti XSS. Chat ini teks polos (bukan HTML formatting),
  // jadi seluruh tag di-strip total (allowedTags: []), bukan cuma di-escape,
  // supaya tidak ada celah injeksi lewat atribut/markup apa pun.
  function sanitizeText(text) {
    if (!text) return '';
    const cleaned = sanitizeHtml(String(text), { allowedTags: [], allowedAttributes: {} }).trim();
    return cleaned.slice(0, MAX_TEXT_LEN);
  }

  // Validasi attachment gambar — pola SAMA PERSIS dengan
  // validateBannerImageFields() di server.js (data URI base64, size cap).
  function validateImage(imageData) {
    if (!imageData) return null;
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(imageData).trim());
    if (!m) throw new Error('Format gambar tidak didukung. Gunakan JPG, PNG, WEBP, atau GIF.');
    const approxBytes = Math.ceil((m[2].length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) throw new Error(`Ukuran gambar maksimal ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB.`);
    return imageData;
  }

  function publicMessage(doc) {
    if (!doc) return null;
    return {
      _id: doc._id,
      discordId: doc.discordId,
      sender: doc.sender, // 'user' | 'admin'
      senderName: doc.senderName || (doc.sender === 'admin' ? 'Admin' : 'User'),
      senderAvatar: doc.senderAvatar || null,
      text: doc.text || '',
      imageData: doc.imageData || null,
      createdAt: doc.createdAt,
      readByAdmin: !!doc.readByAdmin,
      readByUser: !!doc.readByUser
    };
  }

  async function ensureIndexes() {
    try {
      // TTL 24 jam — lihat catatan AUTO DELETE di header file ini.
      await db().collection('liveChatMessages').createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
      await db().collection('liveChatMessages').createIndex({ discordId: 1, createdAt: 1 });
      await db().collection('liveChatMessages').createIndex({ discordId: 1, sender: 1, readByAdmin: 1 });
      await db().collection('liveChatMessages').createIndex({ discordId: 1, sender: 1, readByUser: 1 });
    } catch (e) {
      console.warn('[LiveChat] Gagal buat index:', e.message);
    }
  }

  async function conversationSummary(discordId) {
    const lastArr = await db().collection('liveChatMessages').find({ discordId, ...notExpiredFilter() }).sort({ createdAt: -1 }).limit(1).toArray();
    const unreadCount = await db().collection('liveChatMessages').countDocuments({ discordId, sender: 'user', readByAdmin: false, ...notExpiredFilter() });
    const user = await db().collection('users').findOne({ discordId }, { projection: { username: 1, avatarUrl: 1 } });
    return {
      discordId,
      username: user?.username || discordId,
      avatarUrl: user?.avatarUrl || null,
      online: isUserOnline(discordId),
      lastMessage: lastArr[0] ? publicMessage(lastArr[0]) : null,
      lastActivity: lastArr[0]?.createdAt || null,
      unreadCount
    };
  }

  // ── User kirim pesan (App Desktop) ──
  async function sendUserMessage(user, { text, imageData }) {
    if (!checkRateLimit(user.discordId)) throw new Error('Terlalu banyak pesan dikirim, tunggu sebentar ya.');
    const cleanText = sanitizeText(text);
    const img = validateImage(imageData);
    if (!cleanText && !img) throw new Error('Pesan tidak boleh kosong.');

    const doc = {
      discordId: user.discordId,
      sender: 'user',
      senderName: user.username || 'User',
      senderAvatar: user.avatarUrl || null,
      text: cleanText,
      imageData: img,
      createdAt: new Date(),
      readByAdmin: false,
      readByUser: true
    };
    const result = await db().collection('liveChatMessages').insertOne(doc);
    doc._id = result.insertedId;
    const pub = publicMessage(doc);

    broadcastAdmin('livechat:message', pub);
    broadcastAdmin('livechat:conversation', await conversationSummary(user.discordId));

    // Notifikasi DM ke Admin (Discord Bot) — HANYA saat benar-benar ada pesan
    // baru dari User (persis titik ini, setelah insert sukses). Pesan lengkap
    // (`pub`, sudah punya _id unik) di-pass ke notifyAdminsNewMessage supaya
    // embed DM bisa menampilkan isi pesan, nama user, dan waktunya. Best-effort,
    // fire-and-forget — tidak boleh menggagalkan/menunda pengiriman pesan chat
    // itu sendiri kalau DM gagal terkirim. Anti-spam (1 pesan = 1 DM, aman dari
    // reconnect/duplicate call) ditangani di notifyAdminsNewMessage() lewat
    // notifDedup + eventId = _id pesan ini (reuse sendDiscordDM, TIDAK ada
    // sistem dedup baru).
    if (typeof notifyAdminsNewMessage === 'function') {
      Promise.resolve().then(() => notifyAdminsNewMessage(pub)).catch(() => {});
    }

    return pub;
  }

  // ── Admin balas (Admin Web) ──
  async function sendAdminMessage(discordId, { text, imageData }, admin) {
    const cleanText = sanitizeText(text);
    const img = validateImage(imageData);
    if (!cleanText && !img) throw new Error('Pesan tidak boleh kosong.');

    const doc = {
      discordId,
      sender: 'admin',
      senderName: admin?.username || 'Admin',
      senderAvatar: null,
      text: cleanText,
      imageData: img,
      createdAt: new Date(),
      readByAdmin: true,
      readByUser: false
    };
    const result = await db().collection('liveChatMessages').insertOne(doc);
    doc._id = result.insertedId;
    const pub = publicMessage(doc);

    // Push ke User yang bersangkutan (semua device/instance yang lagi online) +
    // ke SEMUA Admin lain yang sedang buka halaman Live Chat (biar tidak ada
    // admin yang salah kirim balasan dobel ke user yang sama).
    wsSendToUser(discordId, 'livechat:message', pub);
    broadcastAdmin('livechat:message', pub);
    broadcastAdmin('livechat:conversation', await conversationSummary(discordId));
    return pub;
  }

  async function getUserMessages(discordId) {
    const rows = await db().collection('liveChatMessages').find({ discordId, ...notExpiredFilter() }).sort({ createdAt: 1 }).toArray();
    return rows.map(publicMessage);
  }

  async function markReadByUser(discordId) {
    await db().collection('liveChatMessages').updateMany(
      { discordId, sender: 'admin', readByUser: false, ...notExpiredFilter() },
      { $set: { readByUser: true } }
    );
  }

  async function markReadByAdmin(discordId) {
    const result = await db().collection('liveChatMessages').updateMany(
      { discordId, sender: 'user', readByAdmin: false, ...notExpiredFilter() },
      { $set: { readByAdmin: true } }
    );
    if (result.modifiedCount > 0) {
      broadcastAdmin('livechat:conversation', await conversationSummary(discordId));
      broadcastAdmin('livechat:read', { discordId });
    }
  }

  async function getUnreadCountForUser(discordId) {
    return db().collection('liveChatMessages').countDocuments({ discordId, sender: 'admin', readByUser: false, ...notExpiredFilter() });
  }

  // ── Daftar percakapan buat sidebar Admin Web (Search + Filter) ──
  async function listConversations({ filter, search } = {}) {
    const pipeline = [
      // Pesan yang sudah lewat masa aktif 24 jam TIDAK ikut dihitung sama
      // sekali di sidebar Admin (last message/unread/lastActivity) — lihat
      // catatan EXPIRY PESAN di header file ini.
      { $match: notExpiredFilter() },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: '$discordId',
          lastMessage: { $last: '$$ROOT' },
          lastActivity: { $last: '$createdAt' },
          unreadCount: {
            $sum: { $cond: [{ $and: [{ $eq: ['$sender', 'user'] }, { $eq: ['$readByAdmin', false] }] }, 1, 0] }
          }
        }
      },
      { $sort: { lastActivity: -1 } }
    ];
    const rows = await db().collection('liveChatMessages').aggregate(pipeline).toArray();
    const discordIds = rows.map(r => r._id);
    const users = discordIds.length
      ? await db().collection('users').find({ discordId: { $in: discordIds } }, { projection: { discordId: 1, username: 1, avatarUrl: 1 } }).toArray()
      : [];
    const userMap = new Map(users.map(u => [u.discordId, u]));

    let list = rows.map(r => {
      const u = userMap.get(r._id);
      return {
        discordId: r._id,
        username: u?.username || r._id,
        avatarUrl: u?.avatarUrl || null,
        online: isUserOnline(r._id),
        lastMessage: publicMessage(r.lastMessage),
        lastActivity: r.lastActivity,
        unreadCount: r.unreadCount
      };
    });

    if (filter === 'unread') list = list.filter(c => c.unreadCount > 0);
    else if (filter === 'online') list = list.filter(c => c.online);
    else if (filter === 'offline') list = list.filter(c => !c.online);
    else if (filter === 'active') {
      const threshold = Date.now() - ACTIVE_WINDOW_MS;
      list = list.filter(c => c.lastActivity && new Date(c.lastActivity).getTime() > threshold);
    }

    if (search) {
      const q = String(search).trim().toLowerCase();
      if (q) list = list.filter(c => (c.username || '').toLowerCase().includes(q) || String(c.discordId).includes(q));
    }
    return list;
  }

  // ── Cleanup backend — hapus pesan yang UMURNYA sudah > 24 jam dari
  // createdAt masing-masing (BUKAN berdasar pergantian tanggal/hari sama
  // sekali). Dipanggil berkala tiap 5 menit dari server.js sebagai pelengkap
  // TTL index Mongo, supaya dokumen expired benar-benar tidak menumpuk di DB
  // walau TTL background task Mongo kebetulan belum sempat jalan. Aman
  // dipanggil kapan pun/berkali-kali (idempotent — hanya menghapus dokumen
  // yang memang sudah lewat 24 jam saat itu).
  async function cleanupExpiredMessages() {
    if (!db()) return 0;
    try {
      const cutoff = new Date(Date.now() - MESSAGE_TTL_MS);
      const result = await db().collection('liveChatMessages').deleteMany({ createdAt: { $lt: cutoff } });
      const deletedCount = result?.deletedCount || 0;
      if (deletedCount > 0 && typeof logActivity === 'function') {
        logActivity({
          type: 'livechat_expire_cleanup',
          status: 'success',
          description: `${deletedCount} pesan Live Chat Support kedaluwarsa (>24 jam) dibersihkan dari database.`,
          meta: { deletedCount }
        }).catch(() => {});
      }
      return deletedCount;
    } catch (e) {
      console.warn('[LiveChat] Gagal cleanup pesan kedaluwarsa:', e.message);
      return 0;
    }
  }

  return {
    ensureIndexes,
    sendUserMessage,
    sendAdminMessage,
    getUserMessages,
    markReadByUser,
    markReadByAdmin,
    getUnreadCountForUser,
    listConversations,
    conversationSummary,
    cleanupExpiredMessages,
    isAdminOnline
  };
};
