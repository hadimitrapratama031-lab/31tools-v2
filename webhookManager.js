// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK MANAGER — webhook Discord terpisah PER KATEGORI notifikasi
// ══════════════════════════════════════════════════════════════════════════
// Sebelumnya semua notifikasi (download, limit, masa aktif, pengumuman, dst)
// dikirim lewat SATU webhook global (DISCORD_NOTIF_WEBHOOK_URL / DISCORD_WEBHOOK_URL
// di .env), jadi semua nyampur di satu channel Discord dan cuma bisa diganti
// lewat redeploy env var.
//
// Modul ini menggantinya jadi N webhook independen (satu per kategori),
// disimpan di database (collection `webhookSettings`, satu dokumen per
// kategori) supaya:
//   - Bisa diatur & diganti kapan saja dari Admin Web (halaman Webhook Settings),
//     TANPA perlu restart server/app — setiap kirim notifikasi SELALU baca
//     ulang dari DB dulu (tidak ada cache di memori), jadi perubahan langsung
//     berlaku (realtime).
//   - Tiap kategori bisa di-enable/disable & diganti URL-nya sendiri-sendiri,
//     tanpa saling ganggu kategori lain.
//   - Kalau suatu kategori belum diatur / URL-nya salah / request-nya gagal,
//     itu TIDAK PERNAH melempar error ke pemanggil (best-effort) — cukup
//     dicatat ke console.warn & status kategori itu ditandai 'invalid',
//     proses utama (download, login, dst) tetap lanjut normal.
//
// Cara pakai dari server.js:
//   const webhookManager = require('./webhookManager')({ getDb: () => db });
//   await webhookManager.sendCategoryWebhook('download_success', { title, description });
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { buildEmbed, field } = require('./notifTemplates');

const COLLECTION = 'webhookSettings';

// Daftar kategori notifikasi yang tersedia. Ini SATU-SATUNYA sumber kebenaran
// (dipakai juga oleh Admin Web lewat GET /api/admin/webhooks) — kalau mau nambah
// kategori baru di masa depan, cukup tambah entri di sini.
const CATEGORIES = [
  { key: 'download_success', label: 'Download Berhasil',            icon: '✅', color: 0x3ddc97, desc: 'Terkirim tiap user berhasil download & pasang Game/Bypass.' },
  { key: 'download_failed',  label: 'Download Gagal',                icon: '❌', color: 0xff6b81, desc: 'Terkirim tiap proses download/instalasi user gagal di tengah jalan.' },
  { key: 'purchase',         label: 'Pembelian Paket',                icon: '💳', color: 0xffd76a, desc: 'Terkirim saat admin mengaktifkan/mengubah paket (Gold/Platinum/Admin) seorang user.' },
  { key: 'renewal',          label: 'Perpanjangan Paket',             icon: '🔄', color: 0xa78bfa, desc: 'Terkirim saat admin memperpanjang atau mereset masa aktif paket user.' },
  { key: 'quota_low',        label: 'Limit Download Hampir Habis',   icon: '⚠️', color: 0xffb84d, desc: 'Terkirim saat sisa limit download harian user tinggal 1x.' },
  { key: 'quota_empty',      label: 'Limit Download Habis',          icon: '⛔', color: 0xff6b81, desc: 'Terkirim saat limit download harian user sudah habis (0x tersisa).' },
  { key: 'period_low',       label: 'Paket Hampir Berakhir',          icon: '⏳', color: 0xffb84d, desc: 'Terkirim saat masa aktif Gold/Platinum user tersisa < 24 jam.' },
  { key: 'period_expired',   label: 'Paket Berakhir',                 icon: '🚫', color: 0xff6b81, desc: 'Terkirim saat masa aktif Gold/Platinum user habis & otomatis turun ke Public.' },
  { key: 'announcement',     label: 'Pengumuman / Informasi Admin',  icon: '📢', color: 0x7c5cff, desc: 'Terkirim saat admin mengirim pengumuman ke satu user atau semua user.' },
  { key: 'login',            label: 'Login Akun',                    icon: '🔑', color: 0x3498db, desc: 'Opsional — terkirim tiap user berhasil login lewat Discord OAuth.', optional: true },
  { key: 'device_security',  label: 'Keamanan Perangkat (Device Lock)', icon: '🔒', color: 0xff8fa3, desc: 'Opsional — perangkat baru terdaftar, login ditolak (perangkat beda), device direset/diizinkan ganti oleh admin.', optional: true },
  { key: 'system_error',     label: 'Error Sistem',                  icon: '🛠️', color: 0xff4d4d, desc: 'Opsional — error tak tertangani di server (crash, promise rejection, dll).', optional: true }
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function isValidCategory(key) {
  return CATEGORY_KEYS.includes(key);
}

// Validasi format dasar URL webhook Discord. Tidak memanggil network sama
// sekali di sini — cuma cek bentuknya masuk akal, biar admin langsung dapat
// feedback kalau salah tempel URL.
function isPlausibleWebhookUrl(url) {
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+/.test(url);
}

module.exports = function createWebhookManager({ getDb }) {
  const APP_NAME = process.env.APP_NAME || 'Nova Launcher';

  function defaultDoc(category) {
    const meta = CATEGORY_MAP[category];
    return {
      _id: category,
      url: null,
      // Kategori "system_error" sengaja default OFF karena sifatnya opsional —
      // kategori lain default ON supaya begitu admin isi URL-nya langsung aktif.
      enabled: !meta?.optional,
      status: 'unknown', // 'unknown' | 'valid' | 'invalid' — 'unknown' = belum pernah diuji/dipakai
      lastError: null,
      lastCheckedAt: null,
      updatedAt: new Date()
    };
  }

  // Ambil SEMUA kategori (termasuk yang belum pernah disentuh admin — diisi nilai
  // default supaya Admin Web selalu dapat daftar lengkap 10 kategori, bukan cuma
  // yang sudah pernah disimpan ke DB).
  async function getAll() {
    const db = getDb();
    const saved = db ? await db.collection(COLLECTION).find({}).toArray() : [];
    const savedMap = Object.fromEntries(saved.map(d => [d._id, d]));

    return CATEGORIES.map(meta => {
      const doc = savedMap[meta.key] || defaultDoc(meta.key);
      return {
        key: meta.key,
        label: meta.label,
        icon: meta.icon,
        description: meta.desc,
        optional: !!meta.optional,
        url: doc.url || null,
        enabled: doc.enabled !== false,
        status: doc.status || 'unknown',
        lastError: doc.lastError || null,
        lastCheckedAt: doc.lastCheckedAt || null,
        updatedAt: doc.updatedAt || null
      };
    });
  }

  async function getOne(category) {
    if (!isValidCategory(category)) throw new Error('Kategori webhook tidak dikenal: ' + category);
    const db = getDb();
    if (!db) return defaultDoc(category);
    const doc = await db.collection(COLLECTION).findOne({ _id: category });
    return doc || defaultDoc(category);
  }

  // Simpan URL & status enabled/disabled satu kategori. Dipanggil dari
  // PUT /api/admin/webhooks/:category.
  async function upsert(category, { url, enabled } = {}) {
    if (!isValidCategory(category)) throw new Error('Kategori webhook tidak dikenal: ' + category);
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');

    const trimmedUrl = (url === undefined) ? undefined : (url || '').trim() || null;
    if (trimmedUrl && !isPlausibleWebhookUrl(trimmedUrl)) {
      throw new Error('URL webhook tidak valid. Formatnya harus seperti https://discord.com/api/webhooks/xxx/yyy');
    }

    const current = await getOne(category);
    const urlChanged = trimmedUrl !== undefined && trimmedUrl !== (current.url || null);

    const next = {
      _id: category,
      url: trimmedUrl !== undefined ? trimmedUrl : (current.url || null),
      enabled: enabled !== undefined ? !!enabled : (current.enabled !== false),
      // Ganti URL -> status lama sudah tidak relevan lagi, balik ke 'unknown' sampai
      // diuji/dipakai ulang. Kalau cuma toggle enabled/disabled, status lama dipertahankan.
      status: urlChanged ? 'unknown' : (current.status || 'unknown'),
      lastError: urlChanged ? null : (current.lastError || null),
      lastCheckedAt: urlChanged ? null : (current.lastCheckedAt || null),
      updatedAt: new Date()
    };

    await db.collection(COLLECTION).updateOne({ _id: category }, { $set: next }, { upsert: true });

    const meta = CATEGORY_MAP[category];
    return { key: category, label: meta.label, icon: meta.icon, description: meta.desc, optional: !!meta.optional, ...next };
  }

  // Catat hasil kirim (sukses/gagal) ke DB supaya status Valid/Invalid di Admin Web
  // selalu mencerminkan kondisi TERAKHIR (baik dari Test Webhook maupun dari
  // pengiriman notifikasi asli sehari-hari).
  async function recordResult(category, ok, errorMsg) {
    const db = getDb();
    if (!db) return;
    try {
      await db.collection(COLLECTION).updateOne(
        { _id: category },
        { $set: { status: ok ? 'valid' : 'invalid', lastError: ok ? null : (errorMsg || 'Gagal mengirim'), lastCheckedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.warn('[WebhookManager] Gagal mencatat status kategori', category, ':', e.message);
    }
  }

  // ── PENGIRIMAN — dipanggil dari server.js tiap ada event ──
  // Best-effort MUTLAK: apapun yang terjadi (belum diatur, disabled, URL invalid,
  // request gagal/timeout), fungsi ini TIDAK PERNAH throw. Cukup return status &
  // catat ke console.warn/DB, supaya proses utama pemanggil tidak pernah terganggu.
  async function sendCategoryWebhook(category, { title, description, color, fields, thumbnail, image, url: overrideUrl, embed: rawEmbed } = {}) {
    if (!isValidCategory(category)) {
      console.warn('[WebhookManager] Kategori tidak dikenal, dilewati:', category);
      return { sent: false, reason: 'unknown_category' };
    }
    try {
      const doc = await getOne(category);
      const targetUrl = overrideUrl || doc.url;
      if (!doc.enabled && !overrideUrl) return { sent: false, reason: 'disabled' };
      if (!targetUrl) return { sent: false, reason: 'not_configured' };

      const meta = CATEGORY_MAP[category];
      // `rawEmbed` — kalau pemanggil sudah bikin embed lengkap sendiri (lewat
      // notifTemplates.buildEmbed), pakai itu APA ADANYA supaya field Status/
      // Waktu Kejadian/thumbnail/image yang sudah disusun tidak ketimpa/dobel.
      // Kalau tidak, tetap dukung bentuk lama (title/description/color/fields)
      // demi kompatibilitas mundur.
      const embed = rawEmbed || {
        title: title || `${meta.icon} ${meta.label}`,
        description: description || '',
        color: color ?? meta.color,
        fields: fields || [],
        timestamp: new Date().toISOString(),
        footer: { text: `${APP_NAME} · ${meta.label}` }
      };
      if (!rawEmbed) {
        if (thumbnail) embed.thumbnail = { url: thumbnail };
        if (image) embed.image = { url: image };
      }

      await axios.post(targetUrl, {
        username: APP_NAME,
        embeds: [embed]
      });

      if (!overrideUrl) await recordResult(category, true);
      return { sent: true };
    } catch (e) {
      const errMsg = e.response?.data?.message || e.message;
      console.warn(`[WebhookManager] Gagal kirim webhook kategori "${category}":`, errMsg);
      if (!overrideUrl) await recordResult(category, false, errMsg);
      return { sent: false, reason: 'request_failed', error: errMsg };
    }
  }

  // Kirim pesan uji coba — dipakai tombol "Test Webhook" di Admin Web. Sengaja
  // BYPASS status enabled (supaya admin bisa uji dulu sebelum mengaktifkan),
  // tapi tetap wajib ada URL-nya (baik yang sudah tersimpan atau yang baru
  // diketik & dikirim langsung lewat parameter `urlOverride`).
  async function testWebhook(category, urlOverride) {
    if (!isValidCategory(category)) throw new Error('Kategori webhook tidak dikenal: ' + category);
    const doc = await getOne(category);
    const targetUrl = (urlOverride || '').trim() || doc.url;
    if (!targetUrl) return { sent: false, error: 'Belum ada URL webhook yang diisi untuk kategori ini.' };
    if (!isPlausibleWebhookUrl(targetUrl)) return { sent: false, error: 'Format URL webhook tidak valid.' };

    const meta = CATEGORY_MAP[category];
    try {
      await axios.post(targetUrl, {
        username: APP_NAME,
        embeds: [buildEmbed({
          status: 'success',
          title: `Test Webhook — ${meta.label}`,
          description: `Webhook kategori **${meta.label}** berhasil terhubung ke ${APP_NAME}. Notifikasi jenis ini akan muncul di channel ini.`,
          fields: [field('📂 Kategori', meta.label, true)],
          appName: APP_NAME,
          footerNote: meta.label
        })]
      });
      await recordResult(category, true);
      return { sent: true };
    } catch (e) {
      const errMsg = e.response?.data?.message || e.message;
      await recordResult(category, false, errMsg);
      return { sent: false, error: errMsg };
    }
  }

  return {
    CATEGORIES,
    isValidCategory,
    getAll,
    getOne,
    upsert,
    sendCategoryWebhook,
    testWebhook
  };
};
