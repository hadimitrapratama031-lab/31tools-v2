// ══════════════════════════════════════════════════════════════════════════
// DISCORD NOTIFY MANAGER — pengganti webhookManager.js lama.
// ══════════════════════════════════════════════════════════════════════════
// PERUBAHAN UTAMA vs webhookManager.js:
//   - Sebelumnya tiap configKey menyimpan URL webhook Discord (dibuat manual
//     lewat "Create Webhook" di Discord, ditempel ke Admin Web).
//   - Sekarang tiap configKey menyimpan `discord_channel_id` — dipilih admin
//     dari dropdown channel yang diambil LANGSUNG dari server Discord (lewat
//     Bot yang sudah terhubung, REST API `/guilds/{id}/channels`), BUKAN
//     ditempel manual. Pengiriman pesan juga lewat Bot REST API
//     (`POST /channels/{id}/messages`), bukan lagi POST ke URL webhook.
//   - Tidak ada satupun webhook URL yang disimpan atau dipakai lagi di modul
//     ini.
//
// STRUKTUR & DAFTAR KATEGORI/GROUP/PENGGABUNGAN (CATEGORIES, GROUPS,
// MERGED_CONFIGS) SENGAJA TIDAK DIUBAH SAMA SEKALI dari webhookManager.js —
// supaya semua pemanggil di server.js (`webhookManager.sendCategoryWebhook
// ('purchase', ...)`, dst — ada di 20+ tempat) TETAP JALAN TANPA DIUBAH,
// dan Admin Web tetap menampilkan kategori & pengelompokan yang sama persis
// seperti sebelumnya. Yang berubah HANYA cara data disimpan (channel ID,
// bukan URL) dan cara pesan dikirim (Bot API, bukan webhook POST).
//
// KOLEKSI DATABASE: `notification_channel_settings` (menggantikan
// `webhookSettings` yang lama — collection lama TIDAK dipakai/ditulis lagi
// oleh modul ini). Field per dokumen (satu per configKey):
//   - notification_type   : configKey (mis. 'package_lifecycle')
//   - category             : group key (mis. 'paket') — buat referensi cepat
//   - discord_channel_id   : ID channel Discord tujuan (atau null)
//   - enabled               : true/false
//   - status                : 'unknown' | 'valid' | 'invalid'
//   - lastError, lastCheckedAt
//   - created_at, updated_at
//
// DETEKSI CHANNEL HILANG/BERUBAH: kalau pengiriman gagal karena channel
// sudah dihapus atau Bot kehilangan akses (404/403 dari Discord), status
// configKey otomatis ditandai 'invalid' + lastError diisi pesan yang jelas,
// supaya Admin Web bisa munculkan badge invalid & minta admin pilih ulang
// channel — TANPA pernah membuat proses utama (login/download/purchase dst)
// gagal (best-effort, sama seperti sebelumnya).
//
// Cara pakai dari server.js (TIDAK BERUBAH — tetap nama & signature lama):
//   const webhookManager = require('./discordNotifyManager')({ getDb: () => db });
//   await webhookManager.sendCategoryWebhook('download_success', { title, description });
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { buildEmbed, field, BRAND, toDmEmbed } = require('./notifTemplates');
const notifDedup = require('./notifDedup');

const DISCORD_API = 'https://discord.com/api/v10';
const COLLECTION = 'notification_channel_settings';
const LEGACY_COLLECTION = 'webhookSettings'; // dibaca sekali (read-only) cuma buat bawa flag enabled/disabled lama

// Tipe channel Discord yang bisa dipakai kirim pesan teks/embed biasa.
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;
const SENDABLE_CHANNEL_TYPES = new Set([GUILD_TEXT, GUILD_ANNOUNCEMENT]);

// ── GROUPS & CATEGORIES & MERGED_CONFIGS — SAMA PERSIS dengan webhookManager.js lama ──
const GROUPS = [
  { key: 'user',         label: 'User Notification',           icon: '👤' },
  { key: 'game',         label: 'Game Notification',           icon: '🎮' },
  { key: 'bypass',       label: 'Bypass Notification',         icon: '🛠️' },
  { key: 'paket',        label: 'Package Notification',        icon: '📦' },
  { key: 'request_game', label: 'Request Game Notification',   icon: '📥' },
  { key: 'steam_account', label: 'Steam Account Notification', icon: '🕹️' },
  { key: 'marketplace',   label: 'Marketplace Notification',   icon: '🛒' },
  { key: 'update',       label: 'Update Notification',         icon: '🚀' },
  { key: 'admin',        label: 'Admin Activity Notification', icon: '🛡️' },
  { key: 'security',     label: 'Security Notification',       icon: '🔐' }
];
const GROUP_MAP = Object.fromEntries(GROUPS.map(g => [g.key, g]));

const CATEGORIES = [
  { key: 'download_success', label: 'Download Game Berhasil',        icon: '✅', color: 0x3ddc97, badge: 'game',     group: 'game',         desc: 'Terkirim tiap user berhasil download & pasang Game.',                                                        configKey: 'download_activity' },
  { key: 'download_failed',  label: 'Download Game Gagal',           icon: '❌', color: 0xff6b81, badge: 'game',     group: 'game',         desc: 'Terkirim tiap proses download/instalasi Game user gagal di tengah jalan.',                                   configKey: 'download_activity' },
  { key: 'bypass_download_success', label: 'Download Bypass Berhasil', icon: '✅', color: 0x3ddc97, badge: 'bypass', group: 'bypass',       desc: 'Terkirim tiap user berhasil download & pasang Bypass.',                                                       configKey: 'download_activity' },
  { key: 'bypass_download_failed',  label: 'Download Bypass Gagal',   icon: '❌', color: 0xff6b81, badge: 'bypass', group: 'bypass',       desc: 'Terkirim tiap proses download/instalasi Bypass user gagal di tengah jalan.',                                  configKey: 'download_activity' },
  { key: 'purchase',         label: 'Pembelian Paket',                icon: '💳', color: 0xffd76a, badge: 'paket',    group: 'paket',        desc: 'Terkirim saat admin mengaktifkan/mengubah paket (Gold/Platinum/Admin) seorang user.',                         configKey: 'package_lifecycle' },
  { key: 'renewal',          label: 'Perpanjangan Paket',             icon: '🔄', color: 0xa78bfa, badge: 'paket',    group: 'paket',        desc: 'Terkirim saat admin memperpanjang atau mereset masa aktif paket user.',                                       configKey: 'package_lifecycle' },
  { key: 'period_low',       label: 'Paket Hampir Berakhir',          icon: '⏳', color: 0xffb84d, badge: 'paket',    group: 'paket',        desc: 'Terkirim saat masa aktif Gold/Platinum user tersisa < 24 jam.',                                               configKey: 'package_lifecycle' },
  { key: 'period_expired',   label: 'Paket Berakhir',                 icon: '🚫', color: 0xff6b81, badge: 'paket',    group: 'paket',        desc: 'Terkirim saat masa aktif Gold/Platinum user habis & otomatis turun ke Public.',                              configKey: 'package_lifecycle' },
  { key: 'payment',          label: 'Pembayaran (Payment Gateway)',   icon: '💳', color: 0x2ecc71, badge: 'payment',  group: 'paket',        desc: 'Terkirim tiap status transaksi pembayaran berubah: lunas, gagal, kedaluwarsa, atau dibatalkan.',            configKey: 'package_lifecycle' },
  { key: 'quota_low',        label: 'Limit Download Hampir Habis',   icon: '⚠️', color: 0xffb84d, badge: 'user',     group: 'user',         desc: 'Terkirim saat sisa limit download harian user tinggal 1x.' },
  { key: 'quota_empty',      label: 'Limit Download Habis',          icon: '⛔', color: 0xff6b81, badge: 'user',     group: 'user',         desc: 'Terkirim saat limit download harian user sudah habis (0x tersisa).' },
  { key: 'announcement',     label: 'Pengumuman / Informasi Admin',  icon: '📢', color: 0x7c5cff, badge: 'admin',    group: 'admin',        desc: 'Terkirim saat admin mengirim pengumuman ke satu user atau semua user.' },
  { key: 'login',            label: 'Login Akun',                    icon: '🔑', color: 0x3498db, badge: 'user',     group: 'user',         desc: 'Opsional — terkirim tiap user berhasil login lewat Discord OAuth.', optional: true },
  { key: 'device_security',  label: 'Keamanan Perangkat (Device Lock)', icon: '🔒', color: 0xe67e22, badge: 'security', group: 'security',  desc: 'Opsional — perangkat baru terdaftar, login ditolak (perangkat beda), device direset/diizinkan ganti oleh admin.', optional: true, configKey: 'security_system' },
  { key: 'watermark_alert',  label: 'Watermark Terdeteksi Perangkat Lain', icon: '🔎', color: 0xe67e22, badge: 'security', group: 'security', desc: 'Opsional — file Game/Bypass hasil watermark terdeteksi dipakai di perangkat yang beda dari saat download. Informasi saja, TIDAK auto-ban.', optional: true, configKey: 'security_system' },
  { key: 'system_error',     label: 'Error Sistem',                  icon: '🛠️', color: 0xff4d4d, badge: 'system',   group: 'security',     desc: 'Opsional — error tak tertangani di server (crash, promise rejection, dll).', optional: true, configKey: 'security_system' },
  { key: 'voucher',          label: 'Voucher',                       icon: '🎟️', color: 0xffd76a, badge: 'voucher',  group: 'paket',        desc: 'Opsional — terkirim tiap voucher berhasil diklaim user.', optional: true, configKey: 'package_lifecycle' },
  { key: 'game_new',         label: 'Game Baru',                     icon: '🎮', color: 0x2ecc71, badge: 'game',     group: 'game',         desc: 'Opsional — terkirim saat admin menambahkan Game baru ke katalog. TERPISAH dari Update Aplikasi.', optional: true },
  { key: 'game_edit',        label: 'Update Game',                    icon: '✏️', color: 0x7c5cff, badge: 'game',     group: 'game',         desc: 'Opsional — terkirim saat admin mengubah/mengedit data Game yang sudah ada di katalog. TERPISAH dari Game Baru.', optional: true },
  { key: 'bypass_new',       label: 'Bypass Baru',                   icon: '🛠️', color: 0x2ecc71, badge: 'bypass',   group: 'bypass',       desc: 'Opsional — terkirim saat admin menambahkan Bypass baru ke katalog. TERPISAH dari Update Aplikasi.', optional: true },
  { key: 'bypass_edit',      label: 'Update Bypass',                  icon: '✏️', color: 0x7c5cff, badge: 'bypass',   group: 'bypass',       desc: 'Opsional — terkirim saat admin mengubah/mengedit data Bypass yang sudah ada di katalog. TERPISAH dari Bypass Baru.', optional: true },
  { key: 'app_update',       label: 'Update Aplikasi',                icon: '🚀', color: 0x9b59b6, badge: 'update',   group: 'update',       desc: 'Opsional — terkirim saat admin merilis versi App baru (Auto/Force Update). TERPISAH dari Game Baru/Bypass Baru.', optional: true },
  { key: 'role_change',      label: 'Perubahan Role/Limit User',    icon: '🔁', color: 0x3498db, badge: 'user',     group: 'user',         desc: 'Opsional — terkirim saat role/paket user berubah (dari Admin Panel, /setpaket, atau sinkronisasi Discord→App).', optional: true },
  { key: 'admin_activity',   label: 'Aktivitas Admin',               icon: '🛡️', color: 0x3498db, badge: 'admin',    group: 'admin',        desc: 'Opsional — terkirim untuk aksi moderasi admin (ban/unban/suspend/reset device, dll).', optional: true },
  { key: 'game_request',     label: 'Request Game',                  icon: '📥', color: 0x4facfe, badge: 'request_game', group: 'request_game', desc: 'Terkirim saat user membuat Request Game baru, dan saat admin approve/reject request.' },
  { key: 'steam_account_purchase', label: 'Pembelian & Status Akun Steam', icon: '🕹️', color: 0xffd76a, badge: 'steam_account', group: 'steam_account', desc: 'Terkirim saat pembelian Akun Steam lunas, gagal dialokasikan, kedaluwarsa, atau dibatalkan.' },
  { key: 'gold_trial',       label: 'Gold Trial',                    icon: '🎁', color: 0xffd76a, badge: 'trial',    group: 'paket',        desc: 'Opsional — terkirim tiap user berhasil klaim Gold Trial gratis.', optional: true, configKey: 'package_lifecycle' },
  // Marketplace (Product bundel Game/Bypass, dibeli via KlikQRIS atau di-whitelist
  // admin) — kategori BARU sendiri, terpisah dari 'payment' (Upgrade Paket) dan
  // 'steam_account_purchase' (Steam Account), sesuai pola tiap jenis pembelian
  // dapat channel sendiri.
  { key: 'marketplace_purchase', label: 'Pembelian Marketplace',     icon: '🛒', color: 0xffd76a, badge: 'marketplace', group: 'marketplace', desc: 'Terkirim saat pembelian Marketplace Product lunas, kedaluwarsa, atau dibatalkan.' }
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function configKeyOf(category) {
  return CATEGORY_MAP[category]?.configKey || category;
}

const MERGED_CONFIGS = {
  download_activity: {
    label: 'Download Game & Bypass', icon: '⬇️', group: 'game', optional: false,
    desc: 'Gabungan notifikasi Download Game (Berhasil/Gagal) & Download Bypass (Berhasil/Gagal) — satu channel untuk keempatnya.',
    legacyKeys: ['download_success', 'download_failed', 'bypass_download_success', 'bypass_download_failed']
  },
  package_lifecycle: {
    label: 'Paket, Voucher & Pembayaran', icon: '📦', group: 'paket', optional: false,
    desc: 'Gabungan notifikasi Pembelian Paket, Perpanjangan, Voucher, Gold Trial, Pembayaran (Payment Gateway), Paket Hampir Berakhir, dan Paket Berakhir — satu channel untuk semuanya.',
    legacyKeys: ['purchase', 'renewal', 'voucher', 'gold_trial', 'payment', 'period_low', 'period_expired']
  },
  security_system: {
    label: 'Keamanan & Sistem', icon: '🔐', group: 'security', optional: true,
    desc: 'Gabungan notifikasi Keamanan Perangkat (Device Lock), Watermark Terdeteksi, dan Error Sistem — satu channel untuk ketiganya.',
    legacyKeys: ['device_security', 'watermark_alert', 'system_error']
  }
};

function buildConfigs() {
  const seen = new Map();
  for (const cat of CATEGORIES) {
    const ck = cat.configKey || cat.key;
    if (seen.has(ck)) continue;
    const merged = MERGED_CONFIGS[ck];
    seen.set(ck, {
      key: ck,
      label: merged ? merged.label : cat.label,
      icon: merged ? merged.icon : cat.icon,
      group: merged ? merged.group : cat.group,
      desc: merged ? merged.desc : cat.desc,
      optional: merged ? !!merged.optional : !!cat.optional
    });
  }
  return [...seen.values()];
}
const CONFIGS = buildConfigs();
const CONFIG_KEYS = CONFIGS.map(c => c.key);
const CONFIG_MAP = Object.fromEntries(CONFIGS.map(c => [c.key, c]));

function isValidCategory(key) { return CATEGORY_KEYS.includes(key); }
function isValidConfig(key) { return CONFIG_KEYS.includes(key); }

module.exports = function createDiscordNotifyManager({ getDb }) {
  const APP_NAME = process.env.APP_NAME || '31 Tools';
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const GUILD_ID = process.env.DISCORD_GUILD_ID || '';

  function isBotConfigured() { return !!(BOT_TOKEN && GUILD_ID); }

  // ── Bot REST helper — pola sama dengan discordTicketManager.js/
  // discordAutoOrderManager.js (bot token langsung ke REST API, bukan
  // discord.js Client, biar ringan). Retry otomatis sekali kalau kena
  // rate limit (429).
  async function discordRequest(method, url, data) {
    const res = await axios({
      method,
      url: `${DISCORD_API}${url}`,
      data,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      validateStatus: () => true,
      timeout: 15000
    });
    if (res.status === 429) {
      const retryAfter = Math.ceil((res.data?.retry_after || 1) * 1000);
      await new Promise(r => setTimeout(r, retryAfter));
      return discordRequest(method, url, data);
    }
    if (res.status >= 400) {
      const err = new Error(res.data?.message || `Discord API error ${res.status}`);
      err.status = res.status;
      err.discordCode = res.data?.code;
      throw err;
    }
    return res.data;
  }

  // Daftar channel teks server Discord yang terhubung — dipakai Admin Web
  // buat isi dropdown pemilih channel (request #3). Tidak pernah throw:
  // kalau Bot belum terkonfigurasi/gagal, balikin array kosong + flag error.
  async function listGuildChannels() {
    if (!isBotConfigured()) return { channels: [], error: 'Discord Bot belum dikonfigurasi (DISCORD_BOT_TOKEN/DISCORD_GUILD_ID).' };
    try {
      const raw = await discordRequest('GET', `/guilds/${GUILD_ID}/channels`);
      const parentNames = Object.fromEntries(
        (raw || []).filter(c => c.type === 4).map(c => [c.id, c.name])
      );
      const channels = (raw || [])
        .filter(c => SENDABLE_CHANNEL_TYPES.has(c.type))
        .map(c => ({
          id: c.id,
          name: c.name,
          type: c.type === GUILD_ANNOUNCEMENT ? 'announcement' : 'text',
          parentName: c.parent_id ? (parentNames[c.parent_id] || null) : null,
          position: c.position || 0
        }))
        .sort((a, b) => a.position - b.position);
      return { channels, error: null };
    } catch (e) {
      const msg = e.status === 401 ? 'Bot Token tidak valid.' : (e.status === 403 ? 'Bot tidak punya akses ke server ini.' : e.message);
      return { channels: [], error: msg };
    }
  }

  async function getBotStatus() {
    if (!isBotConfigured()) return { connected: false, reason: 'not_configured' };
    try {
      await discordRequest('GET', `/guilds/${GUILD_ID}`);
      return { connected: true };
    } catch (e) {
      return { connected: false, reason: e.status === 401 ? 'invalid_token' : (e.status === 403 ? 'no_access' : 'unknown'), error: e.message };
    }
  }

  function defaultDoc(configKey) {
    const meta = CONFIG_MAP[configKey];
    return {
      _id: configKey,
      notification_type: configKey,
      category: meta?.group || null,
      discord_channel_id: null,
      enabled: !meta?.optional,
      status: 'unknown',
      lastError: null,
      lastCheckedAt: null,
      created_at: new Date(),
      updated_at: new Date()
    };
  }

  // ── MIGRASI RINGAN dari collection lama `webhookSettings` (best-effort,
  // sekali jalan per configKey): channel ID TIDAK BISA diturunkan dari URL
  // webhook lama (beda konsep total), jadi yang dibawa cuma flag enabled/
  // disabled-nya (preferensi admin), status selalu mulai dari 'unknown'
  // sampai admin pilih channel barunya. Tidak pernah menghapus/mengubah
  // collection lama (read-only), dan tidak pernah dijalankan ulang kalau
  // dokumen baru sudah ada.
  const migratedKeys = new Set();
  async function migrateEnabledFlagFromLegacy(configKey) {
    if (migratedKeys.has(configKey)) return;
    const db = getDb();
    if (!db) return;
    try {
      const col = db.collection(COLLECTION);
      const existing = await col.findOne({ _id: configKey });
      if (existing) { migratedKeys.add(configKey); return; }

      const legacyKeys = MERGED_CONFIGS[configKey]?.legacyKeys || [configKey];
      const legacyDocs = await db.collection(LEGACY_COLLECTION).find({ _id: { $in: legacyKeys } }).toArray();
      const doc = defaultDoc(configKey);
      if (legacyDocs.length) {
        const anyEnabled = legacyDocs.some(d => d.enabled !== false);
        doc.enabled = anyEnabled;
      }
      await col.updateOne({ _id: configKey }, { $setOnInsert: doc }, { upsert: true });
    } catch (e) {
      console.warn(`[DiscordNotify] Migrasi flag enabled "${configKey}" gagal (dilewati, tidak fatal):`, e.message);
    }
    migratedKeys.add(configKey);
  }
  async function ensureMigrated() {
    for (const ck of CONFIG_KEYS) await migrateEnabledFlagFromLegacy(ck);
  }

  async function readConfigDoc(configKey) {
    const db = getDb();
    if (!db) return defaultDoc(configKey);
    const doc = await db.collection(COLLECTION).findOne({ _id: configKey });
    return doc || defaultDoc(configKey);
  }

  async function getAll() {
    await ensureMigrated();
    const db = getDb();
    const saved = db ? await db.collection(COLLECTION).find({}).toArray() : [];
    const savedMap = Object.fromEntries(saved.map(d => [d._id, d]));

    return CONFIGS.map(meta => {
      const doc = savedMap[meta.key] || defaultDoc(meta.key);
      const grp = GROUP_MAP[meta.group] || null;
      return {
        key: meta.key,
        label: meta.label,
        icon: meta.icon,
        group: meta.group || null,
        groupLabel: grp?.label || null,
        groupIcon: grp?.icon || null,
        description: meta.desc,
        optional: !!meta.optional,
        discordChannelId: doc.discord_channel_id || null,
        enabled: doc.enabled !== false,
        status: doc.status || 'unknown',
        lastError: doc.lastError || null,
        lastCheckedAt: doc.lastCheckedAt || null,
        updatedAt: doc.updated_at || null
      };
    });
  }

  async function getOne(configKey) {
    if (!isValidConfig(configKey)) throw new Error('Kategori notifikasi tidak dikenal: ' + configKey);
    await ensureMigrated();
    return readConfigDoc(configKey);
  }

  // Simpan channel ID & status enabled/disabled satu configKey. Dipanggil
  // dari PUT /api/admin/notification-channels/:category.
  async function upsert(configKey, { discordChannelId, enabled } = {}) {
    if (!isValidConfig(configKey)) throw new Error('Kategori notifikasi tidak dikenal: ' + configKey);
    await ensureMigrated();
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');

    const trimmedId = (discordChannelId === undefined) ? undefined : ((discordChannelId || '').trim() || null);
    const current = await readConfigDoc(configKey);
    const channelChanged = trimmedId !== undefined && trimmedId !== (current.discord_channel_id || null);

    const meta = CONFIG_MAP[configKey];
    const next = {
      _id: configKey,
      notification_type: configKey,
      category: meta?.group || null,
      discord_channel_id: trimmedId !== undefined ? trimmedId : (current.discord_channel_id || null),
      enabled: enabled !== undefined ? !!enabled : (current.enabled !== false),
      status: channelChanged ? 'unknown' : (current.status || 'unknown'),
      lastError: channelChanged ? null : (current.lastError || null),
      lastCheckedAt: channelChanged ? null : (current.lastCheckedAt || null),
      created_at: current.created_at || new Date(),
      updated_at: new Date()
    };

    await db.collection(COLLECTION).updateOne({ _id: configKey }, { $set: next }, { upsert: true });

    const grp = GROUP_MAP[meta.group] || null;
    return {
      key: configKey, label: meta.label, icon: meta.icon, group: meta.group || null,
      groupLabel: grp?.label || null, groupIcon: grp?.icon || null, description: meta.desc,
      optional: !!meta.optional, discordChannelId: next.discord_channel_id, enabled: next.enabled,
      status: next.status, lastError: next.lastError, lastCheckedAt: next.lastCheckedAt, updatedAt: next.updated_at
    };
  }

  async function recordResult(configKey, ok, errorMsg) {
    const db = getDb();
    if (!db) return;
    try {
      await db.collection(COLLECTION).updateOne(
        { _id: configKey },
        { $set: { status: ok ? 'valid' : 'invalid', lastError: ok ? null : (errorMsg || 'Gagal mengirim'), lastCheckedAt: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.warn('[DiscordNotify] Gagal mencatat status', configKey, ':', e.message);
    }
  }

  // ── PENGIRIMAN — signature & nama TIDAK BERUBAH dari webhookManager.js
  // lama, dipanggil dari server.js pakai nama category lama. Best-effort
  // mutlak: tidak pernah throw ke pemanggil.
  //
  //   plainEmbed  : true = kirim embed APA ADANYA (field polos, TANPA dibungkus
  //                 inline-code/kotak abu-abu) — WAJIB dipakai kalau ada field
  //                 berisi markdown link (mis. "[Click Here to Download](url)"),
  //                 karena inline-code (toDmEmbed) mematikan link jadi teks
  //                 polos. Kategori lama (buildEmbed generik, gaya "badge")
  //                 TIDAK pakai flag ini — tetap seperti sebelumnya.
  async function sendCategoryWebhook(category, { title, description, color, fields, thumbnail, image, channelId: overrideChannelId, embed: rawEmbed, eventId, plainEmbed, components } = {}) {
    const configKey = configKeyOf(category);
    const logResult = (status, extra = {}) => {
      const eventName = rawEmbed?.title || title || category;
      console.log(`[Notif][BOT] event=${eventName} eventId=${eventId || '-'} category=${category} config=${configKey} status=${status} at=${new Date().toISOString()}${extra.reason ? ` reason=${extra.reason}` : ''}${extra.error ? ` error="${extra.error}"` : ''}`);
    };
    if (!isValidCategory(category)) {
      console.warn('[DiscordNotify] Kategori tidak dikenal, dilewati:', category);
      logResult('FAILED', { reason: 'unknown_category' });
      return { sent: false, reason: 'unknown_category' };
    }
    if (!isBotConfigured()) {
      logResult('SKIPPED', { reason: 'bot_not_configured' });
      return { sent: false, reason: 'bot_not_configured' };
    }
    try {
      await ensureMigrated();
      const doc = await readConfigDoc(configKey);
      const targetChannelId = overrideChannelId || doc.discord_channel_id;
      if (!doc.enabled && !overrideChannelId) { logResult('SKIPPED', { reason: 'disabled' }); return { sent: false, reason: 'disabled' }; }
      if (!targetChannelId) { logResult('SKIPPED', { reason: 'not_configured' }); return { sent: false, reason: 'not_configured' }; }

      const meta = CATEGORY_MAP[category];
      const embed = rawEmbed || {
        title: title || `${meta.icon} ${meta.label}`,
        description: description || '',
        color: color ?? meta.color,
        fields: fields || [],
        timestamp: new Date().toISOString(),
        footer: { text: `${APP_NAME} · ${meta.label} · ${BRAND}` }
      };
      if (!rawEmbed) {
        if (thumbnail) embed.thumbnail = { url: thumbnail };
        if (image) embed.image = { url: image };
      }

      // ── ANTI-SPAM — sama persis seperti sebelumnya, dedup key sekarang
      // pakai channel ID (bukan URL) sebagai identitas saluran tujuan.
      const dedupKey = `notify:${category}:${targetChannelId}`;
      const dedupCheck = notifDedup.shouldSend({
        key: dedupKey,
        eventId,
        content: { title: embed.title, description: embed.description, fields: embed.fields }
      });
      if (!dedupCheck.send) {
        logResult('SKIPPED', { reason: 'duplicate_suppressed' });
        return { sent: false, reason: 'duplicate_suppressed', count: dedupCheck.count };
      }

      await discordRequest('POST', `/channels/${targetChannelId}/messages`, {
        embeds: [plainEmbed ? embed : toDmEmbed(embed)],
        ...(components && components.length ? { components } : {})
      });

      if (!overrideChannelId) await recordResult(configKey, true);
      logResult('SUCCESS');
      return { sent: true };
    } catch (e) {
      let errMsg = e.message;
      if (e.status === 404) errMsg = 'Channel tidak ditemukan (mungkin sudah dihapus).';
      else if (e.status === 403) errMsg = 'Bot tidak punya izin mengirim pesan ke channel ini.';
      console.warn(`[DiscordNotify] Gagal kirim notif kategori "${category}" (config: ${configKey}):`, errMsg);
      if (!overrideChannelId) await recordResult(configKey, false, errMsg);
      logResult('FAILED', { error: errMsg });
      return { sent: false, reason: 'request_failed', error: errMsg };
    }
  }

  // Kirim pesan uji coba — dipakai tombol "Send Test" di Admin Web. BYPASS
  // status enabled (supaya admin bisa uji dulu sebelum mengaktifkan), tapi
  // tetap wajib ada channel ID-nya.
  async function testWebhook(configKey, channelIdOverride) {
    if (!isValidConfig(configKey)) throw new Error('Kategori tidak dikenal: ' + configKey);
    if (!isBotConfigured()) return { sent: false, error: 'Discord Bot belum dikonfigurasi.' };
    await ensureMigrated();
    const doc = await readConfigDoc(configKey);
    const targetChannelId = (channelIdOverride || '').trim() || doc.discord_channel_id;
    if (!targetChannelId) return { sent: false, error: 'Belum ada channel yang dipilih.' };

    const meta = CONFIG_MAP[configKey];
    try {
      await discordRequest('POST', `/channels/${targetChannelId}/messages`, {
        embeds: [buildEmbed({
          status: 'success',
          title: `Test Notification — ${meta.label}`,
          description: `Channel untuk **${meta.label}** berhasil terhubung ke ${APP_NAME}. Notifikasi jenis ini akan muncul di channel ini.`,
          fields: [field('📂 Kategori', meta.label, true)],
          appName: APP_NAME,
          footerNote: meta.label
        })]
      });
      await recordResult(configKey, true);
      return { sent: true };
    } catch (e) {
      const errMsg = e.status === 404 ? 'Channel tidak ditemukan.' : (e.status === 403 ? 'Bot tidak punya izin mengirim pesan ke channel ini.' : e.message);
      await recordResult(configKey, false, errMsg);
      return { sent: false, error: errMsg };
    }
  }

  return {
    CATEGORIES,
    CONFIGS,
    GROUPS,
    isValidCategory,
    isValidConfig,
    isBotConfigured,
    getBotStatus,
    listGuildChannels,
    getAll,
    getOne,
    upsert,
    sendCategoryWebhook,
    testWebhook
  };
};
