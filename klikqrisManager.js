// ══════════════════════════════════════════════════════════════════════════
// KLIKQRIS MANAGER — client tipis buat API KlikQRIS (PG KlikQRIS, mode
// In-House QRIS — https://klikqris.com/dokumentasi-api). Modul ini
// menggantikan pakasirManager.js secara penuh dan MENIRU bentuk return value-nya
// (payment.order_id / .fee / .total_payment / .payment_method / .payment_number /
// .project / .expired_at) supaya transactionManager.js dan steamAccountOrderManager.js
// TIDAK PERLU diubah sama sekali — keduanya cuma menyimpan apa pun yang ada di
// object `payment` yang dikembalikan modul pembayaran yang aktif.
//
// PENTING soal keamanan webhook: KlikQRIS MENGIRIM `signature` di setiap
// response create-transaction DAN di setiap payload webhook. Signature webhook
// WAJIB dicocokkan dengan signature yang diterima saat create transaction
// (bukan dihitung ulang pakai HMAC lokal — KlikQRIS tidak menerbitkan formula
// HMAC publik, jadi mekanisme resminya adalah "cocokkan signature awal vs
// signature webhook", persis anjuran di bagian "Double Security" dokumentasi).
// Signature disimpan di setiap dokumen transaksi (field `signature`) sejak
// createTransaction(), lalu dicek lewat verifyWebhookSignature() di server.js
// SEBELUM webhook dipercaya.
//
// Sebagai lapisan kedua (fallback wajib, sesuai anjuran resmi dokumentasi:
// "Kami sarankan tetap menggunakan API status untuk pengecekan yang lebih
// valid"), server.js SELALU memanggil ulang getTransactionDetail() ke KlikQRIS
// sebelum benar-benar mengaktifkan paket/produk — signature webhook yang valid
// SAJA tidak cukup, status juga dikonfirmasi langsung ke server KlikQRIS.
//
// SANDBOX vs PRODUCTION: kredensial (API Key + Merchant ID) disimpan TERPISAH
// per mode di collection `settings` (_id: 'klikqris'), base URL otomatis
// mengikuti field `mode` yang aktif — mengganti mode dari Admin Web langsung
// berlaku ke transaksi berikutnya tanpa redeploy/ubah source code.
//
// Cara pakai dari server.js:
//   const klikqrisManager = require('./klikqrisManager')({ getDb: () => db });
//   const cfg = await klikqrisManager.getSettings();
//   const tx  = await klikqrisManager.createTransaction({ orderId, amount, keterangan });
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const SETTINGS_ID = 'klikqris';
const PROD_BASE_URL = 'https://klikqris.com/api';
const SANDBOX_BASE_URL = 'https://klikqris.com/api/sandbox';

// KlikQRIS (mode In-House QRIS) cuma punya SATU metode pembayaran: QRIS.
// Beda dari Pakasir yang punya banyak metode (VA bank dkk). Field ini tetap
// disediakan dengan bentuk yang sama (array {key,label,group}) supaya kode
// pemanggil yang sebelumnya render daftar metode Pakasir (mis. dropdown
// metode bayar di App) tetap jalan tanpa perlu tahu detail provider — cuma
// sekarang isinya cuma satu opsi.
const PAYMENT_METHODS = [
  { key: 'qris', label: 'QRIS (semua e-wallet & m-banking)', group: 'qris' }
];
const PAYMENT_METHOD_KEYS = PAYMENT_METHODS.map(m => m.key);

// ── Sanitasi keterangan transaksi yang dikirim ke KlikQRIS ──────────────────
// Permintaan eksplisit: keterangan yang dikirim ke payment gateway TIDAK BOLEH
// menampilkan istilah internal (nama produk/tools/bypass/game installer/dll).
// Data internal aslinya tetap disimpan lengkap di database (lihat productName/
// transactionType di transactionManager & steamAccountOrderManager) — cuma
// STRING yang dikirim ke KlikQRIS yang disaring lewat fungsi ini.
const INTERNAL_TERM_PATTERN = /\b(tools?|bypass(?:er)?|installer|cheat(?:er)?|hack(?:er|ing)?|inject(?:or)?|crack(?:ed|er)?|mod(?:ded|ding)?|loader|patch(?:er)?|trainer|exploit)\b/gi;

function sanitizeKeterangan(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(INTERNAL_TERM_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}\s./-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Kalau setelah disaring hasilnya kosong/terlalu pendek (mis. nama produk
  // TERNYATA cuma terdiri dari istilah internal), jangan kirim sisa apa pun —
  // pakai label generik yang aman sepenuhnya.
  if (cleaned.length < 3) return fallback || 'Pembelian Produk Digital';
  return cleaned.slice(0, 100);
}

// Label keterangan siap-pakai buat tiap jenis transaksi di sistem ini.
function keteranganUpgradePaket(tier) {
  const t = String(tier || '').toLowerCase();
  if (t === 'gold') return 'Pembelian Paket Gold';
  if (t === 'platinum') return 'Pembelian Paket Platinum';
  return sanitizeKeterangan(`Pembelian Paket ${tier}`, 'Pembelian Paket');
}

function keteranganProdukDigital(productName) {
  return sanitizeKeterangan(productName ? `Pembelian ${productName}` : '', 'Pembelian Produk Digital');
}

function keteranganDiscordBot(productName) {
  return sanitizeKeterangan(productName ? `Pembelian ${productName}` : '', 'Pembelian Produk Digital');
}

function normalizeStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID') return 'SUCCESS';
  return s; // SUCCESS | PENDING | EXPIRED
}

module.exports = function createKlikqrisManager({ getDb }) {

  async function ensureIndexes() { /* settings pakai _id custom, tidak perlu index tambahan */ }

  function isValidMethod(method) {
    // KlikQRIS cuma QRIS — tapi kalau `method` tidak dikirim sama sekali
    // (banyak pemanggil lama otomatis pakai default 'qris'), tetap dianggap valid.
    if (!method) return true;
    return PAYMENT_METHOD_KEYS.includes(String(method));
  }

  // ── Pengaturan gateway (halaman "KlikQRIS Settings" Admin Web) ──
  async function getSettings() {
    const db = getDb();
    const empty = {
      enabled: false, mode: 'sandbox',
      sandbox: { apiKey: '', merchantId: '' },
      production: { apiKey: '', merchantId: '' },
      updatedAt: null
    };
    if (!db) return empty;
    const doc = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) return empty;
    return {
      enabled: !!doc.enabled,
      mode: doc.mode === 'production' ? 'production' : 'sandbox',
      sandbox: {
        apiKey: (doc.sandbox && doc.sandbox.apiKey) || '',
        merchantId: (doc.sandbox && doc.sandbox.merchantId) || ''
      },
      production: {
        apiKey: (doc.production && doc.production.apiKey) || '',
        merchantId: (doc.production && doc.production.merchantId) || ''
      },
      updatedAt: doc.updatedAt || null
    };
  }

  function maskKey(key) {
    const k = key || '';
    if (!k) return '';
    return k.length > 8 ? `${k.slice(0, 4)}${'•'.repeat(Math.max(4, k.length - 8))}${k.slice(-4)}` : '••••';
  }

  // Versi buat ditampilkan ke Admin — API Key disamarkan, tidak pernah dikirim utuh ke frontend.
  function maskSettings(cfg) {
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      webhookUrl: cfg.webhookUrl,
      sandbox: {
        merchantId: cfg.sandbox.merchantId,
        hasApiKey: !!cfg.sandbox.apiKey,
        apiKeyMasked: maskKey(cfg.sandbox.apiKey)
      },
      production: {
        merchantId: cfg.production.merchantId,
        hasApiKey: !!cfg.production.apiKey,
        apiKeyMasked: maskKey(cfg.production.apiKey)
      },
      updatedAt: cfg.updatedAt
    };
  }

  async function updateSettings({ enabled, mode, sandboxApiKey, sandboxMerchantId, productionApiKey, productionMerchantId }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const current = await getSettings();
    const update = { updatedAt: new Date() };
    if (enabled !== undefined) update.enabled = !!enabled;
    if (mode !== undefined) update.mode = mode === 'production' ? 'production' : 'sandbox';

    update.sandbox = {
      apiKey: (sandboxApiKey !== undefined && String(sandboxApiKey).trim())
        ? String(sandboxApiKey).trim() : current.sandbox.apiKey,
      merchantId: sandboxMerchantId !== undefined
        ? String(sandboxMerchantId || '').trim() : current.sandbox.merchantId
    };
    update.production = {
      apiKey: (productionApiKey !== undefined && String(productionApiKey).trim())
        ? String(productionApiKey).trim() : current.production.apiKey,
      merchantId: productionMerchantId !== undefined
        ? String(productionMerchantId || '').trim() : current.production.merchantId
    };

    // Jangan pernah campur credential Sandbox dengan Production — masing-masing
    // mode punya field-nya sendiri, tidak ada fallback silang di sini sama sekali.
    await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: update }, { upsert: true });
    return getSettings();
  }

  // `forcedMode` (opsional) dipakai buat MEMAKSA activeCreds pakai mode
  // tertentu (misal mode YANG TERSIMPAN di transaksi saat dibuat) alih-alih
  // ikut mode GLOBAL yang sedang aktif di Admin sekarang. Ini WAJIB dipakai
  // di refreshTransactionFromKlikqris/refreshSteamAccountOrderFromKlikqris —
  // kalau Admin ganti mode Sandbox<->Production SETELAH sebuah transaksi
  // pending dibuat, cek status transaksi lama itu HARUS tetap ke environment
  // tempat dia dibuat (order_id sandbox tidak akan pernah ketemu di endpoint
  // production, dan sebaliknya) — bukan ikut mode yang sedang aktif sekarang.
  function activeCreds(cfg, forcedMode) {
    const mode = (forcedMode === 'production' || forcedMode === 'sandbox')
      ? forcedMode
      : (cfg.mode === 'production' ? 'production' : 'sandbox');
    const creds = cfg[mode];
    const baseUrl = mode === 'production' ? PROD_BASE_URL : SANDBOX_BASE_URL;
    return { mode, apiKey: creds.apiKey, merchantId: creds.merchantId, baseUrl };
  }

  function assertConfigured(cfg, forcedMode) {
    if (!cfg.enabled) throw new Error('Payment gateway KlikQRIS sedang dinonaktifkan oleh Admin.');
    const { apiKey, merchantId, mode } = activeCreds(cfg, forcedMode);
    if (!apiKey || !merchantId) {
      throw new Error(`KlikQRIS belum dikonfigurasi Admin untuk mode ${mode.toUpperCase()} (API Key/Merchant ID belum diisi).`);
    }
  }

  function authHeaders(creds) {
    return { 'x-api-key': creds.apiKey, 'id_merchant': creds.merchantId, 'Content-Type': 'application/json' };
  }

  // ── Create Transaction (POST /qris/create) ──
  // `keterangan` WAJIB sudah disaring (pakai keteranganUpgradePaket/
  // keteranganProdukDigital/keteranganDiscordBot/sanitizeKeterangan) SEBELUM
  // dipanggil — modul ini tidak menyaring ulang supaya pemanggil yang secara
  // eksplisit mau kirim string tertentu tetap bisa (dipakai internal saja).
  async function createTransaction({ orderId, amount, keterangan, callbackUrl }) {
    const cfg = await getSettings();
    assertConfigured(cfg);
    const creds = activeCreds(cfg);
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Nominal transaksi tidak valid.');

    const body = {
      order_id: orderId,
      id_merchant: creds.merchantId,
      amount: amt,
      keterangan: keterangan || 'Pembelian Produk Digital'
    };
    if (callbackUrl) body.callback_url = callbackUrl;

    let data;
    try {
      const res = await axios.post(`${creds.baseUrl}/qris/create`, body, {
        headers: authHeaders(creds), timeout: 15000
      });
      data = res.data;
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Gagal membuat transaksi KlikQRIS.';
      throw new Error(msg);
    }
    if (!data || data.status !== true || !data.data) {
      throw new Error((data && data.message) || 'Response KlikQRIS tidak sesuai format yang diharapkan.');
    }
    const d = data.data;
    const totalAmount = Math.round(Number(d.total_amount ?? d.amount ?? amt));

    // Bentuk return dibuat SEPERSIS mungkin dengan payment object Pakasir lama
    // (order_id/fee/total_payment/payment_method/payment_number/project/
    // expired_at) supaya transactionManager.js & steamAccountOrderManager.js
    // TIDAK PERLU diubah. Field tambahan (qrisUrl/qrisImage/signature/mode)
    // dilampirkan juga untuk dipakai UI QRIS & validasi webhook.
    return {
      order_id: d.order_id || orderId,
      amount: amt,
      fee: totalAmount - amt,
      total_payment: totalAmount,
      payment_method: 'qris',
      // `payment_number` diisi URL gambar QRIS (bukan angka VA) — dipakai
      // sebagai fallback field yang sudah ada di skema lama; UI App sebaiknya
      // pakai field `qrisUrl`/`qrisImage` yang lebih eksplisit di bawah.
      payment_number: d.qris_url || null,
      project: creds.merchantId,
      expired_at: d.expired_at || null,
      // ── field khusus KlikQRIS ──
      provider: 'klikqris',
      mode: creds.mode,
      qrisUrl: d.qris_url || null,
      qrisImage: d.qris_image || null,
      signature: d.signature || null,
      keterangan: d.keterangan || body.keterangan
    };
  }

  // ── Check Status Manual (GET /qris/status/{order_id}) — SUMBER KEBENARAN
  // status pembayaran, dipakai sebagai fallback webhook & konfirmasi wajib
  // sebelum fulfillment (lihat catatan keamanan di header file ini). ──
  async function getTransactionDetail({ orderId, mode }) {
    const cfg = await getSettings();
    assertConfigured(cfg, mode);
    const creds = activeCreds(cfg, mode);
    let data;
    try {
      const res = await axios.get(`${creds.baseUrl}/qris/status/${encodeURIComponent(orderId)}`, {
        headers: authHeaders(creds), timeout: 15000
      });
      data = res.data;
    } catch (e) {
      if (e.response?.status === 404) return null; // order tidak ditemukan di KlikQRIS
      const msg = e.response?.data?.message || e.message || 'Gagal mengecek status transaksi KlikQRIS.';
      throw new Error(msg);
    }
    if (!data || data.status !== true || !data.data) return null;
    const d = data.data;
    return {
      order_id: d.order_id,
      amount: Math.round(Number(d.amount ?? d.total_amount)),
      total_amount: Math.round(Number(d.total_amount ?? d.amount)),
      status: normalizeStatus(d.status),
      payment_method: 'qris',
      completed_at: d.paid_at || null,
      signature: d.signature || null
    };
  }

  // KlikQRIS (per dokumentasi resmi saat ini) TIDAK menyediakan endpoint
  // pembatalan transaksi manual seperti Pakasir (`/api/transactioncancel`).
  // Fungsi ini tetap disediakan (best-effort, sama seperti versi Pakasir)
  // supaya pemanggil di server.js tidak perlu tahu detail ini — cukup selalu
  // mengembalikan `false` (tidak ada aksi ke provider), status lokal tetap
  // sepenuhnya dikendalikan oleh transactionManager/steamAccountOrderManager
  // (transaksi ditandai 'expired'/'cancelled' di DB kita sendiri).
  async function cancelTransaction() {
    return false;
  }

  // Cocokkan signature webhook dengan signature yang tersimpan sejak
  // createTransaction() — INI VALIDASI WAJIB sebelum webhook dipercaya sama
  // sekali (lihat header file). Perbandingan dilakukan dengan panjang tetap
  // (timing-safe) untuk menghindari timing attack sederhana.
  function verifyWebhookSignature(storedSignature, incomingSignature) {
    const a = String(storedSignature || '');
    const b = String(incomingSignature || '');
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Riwayat transaksi (GET /qris/history) — dipakai halaman Admin Web kalau
  // memang dibutuhkan; TIDAK dipakai sebagai sumber kebenaran status (sumber
  // kebenaran tetap collection lokal `transactions`/`steamAccountOrders`).
  async function getHistory({ page = 1 } = {}) {
    const cfg = await getSettings();
    assertConfigured(cfg);
    const creds = activeCreds(cfg);
    const res = await axios.get(`${creds.baseUrl}/qris/history`, {
      headers: authHeaders(creds), params: { page }, timeout: 15000
    });
    if (!res.data || res.data.status !== true) return { items: [], total: 0, page: 1 };
    const d = res.data.data || {};
    return { items: d.data || [], total: d.total || 0, page: d.current_page || page };
  }

  // Test koneksi ringan buat halaman "KlikQRIS Settings" — panggil status
  // dengan order_id dummy; auth yang lolos (bahkan kalau ordernya sendiri
  // tidak ketemu/404) menandakan API Key/Merchant ID valid.
  async function testConnection() {
    const cfg = await getSettings();
    const { apiKey, merchantId, mode, baseUrl } = activeCreds(cfg);
    if (!apiKey || !merchantId) return { ok: false, message: `API Key/Merchant ID mode ${mode.toUpperCase()} belum diisi.` };
    try {
      const res = await axios.get(`${baseUrl}/qris/status/__connection_test__`, {
        headers: authHeaders({ apiKey, merchantId }), timeout: 10000
      });
      if (res.data && res.data.status === false && /merchant|api.?key|auth|unauthor/i.test(res.data.message || '')) {
        return { ok: false, message: res.data.message };
      }
      return { ok: true, message: `Koneksi ke KlikQRIS (${mode.toUpperCase()}) berhasil.` };
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) {
        // 404 = transaksi dummy memang tidak ada, TAPI itu tandanya auth-nya lolos.
        return { ok: true, message: `Koneksi ke KlikQRIS (${mode.toUpperCase()}) berhasil.` };
      }
      if (status === 401 || status === 403) {
        return { ok: false, message: e.response?.data?.message || 'API Key/Merchant ID ditolak KlikQRIS.' };
      }
      return { ok: false, message: e.response?.data?.message || e.message || 'Gagal konek ke KlikQRIS.' };
    }
  }

  // Test create transaction sungguhan (nominal kecil) — dipakai tombol
  // "Test Create Transaction" di halaman KlikQRIS Settings.
  async function testCreateTransaction() {
    const cfg = await getSettings();
    assertConfigured(cfg);
    const orderId = `TEST${Date.now()}`;
    const payment = await createTransaction({ orderId, amount: 1000, keterangan: 'Test Create Transaction' });
    return { ok: true, payment };
  }

  return {
    SETTINGS_ID, PAYMENT_METHODS, PAYMENT_METHOD_KEYS,
    ensureIndexes, isValidMethod,
    getSettings, updateSettings, maskSettings, assertConfigured, activeCreds,
    createTransaction, getTransactionDetail, cancelTransaction,
    verifyWebhookSignature, getHistory,
    testConnection, testCreateTransaction,
    sanitizeKeterangan, keteranganUpgradePaket, keteranganProdukDigital, keteranganDiscordBot
  };
};
