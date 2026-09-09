// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD BANNER MANAGER — SATU kartu banner statis di halaman Dashboard
// APP (elemen `.dash-banner` di app/index.html), sekarang bisa diatur penuh
// dari Admin Web ("Setting Banner") dan berubah REALTIME ke APP tanpa
// restart/reload.
//
// PENTING — ini BUKAN sistem banner carousel multi-slide (koleksi `banners`,
// endpoint /api/banners & /api/admin/banners, Code Banner/iframe sandbox, dot
// indicator, auto-slide) yang sudah ada di project ini. Sistem carousel lama
// itu TIDAK disentuh sama sekali di sini — dibiarkan idle di codebase, tidak
// dipakai fitur ini. Fitur ini murni redesign kartu `.dash-banner` yang
// sebelumnya hardcode di HTML jadi manageable, SATU banner saja.
//
// Pola arsitektur SAMA PERSIS dengan appCustomizationManager.js/
// welcomePopupManager.js/maintenanceManager.js di project ini: satu dokumen
// konfigurasi disimpan di collection `settings` (_id tetap), dibaca ulang
// dari DB tiap kali dibutuhkan (TANPA cache di memori) — jadi perubahan dari
// Admin Web langsung berlaku tanpa redeploy/restart App. Realtime memakai
// WebSocket App yang SUDAH ADA (wsBroadcastAll) — TIDAK ada sistem realtime
// baru. WS cuma bawa SINYAL RINGAN {changed, version} (bukan payload gambar
// base64 penuh — base64 bisa besar & rawan gagal terkirim utuh lewat WS,
// alasan SAMA PERSIS dengan App Customization), App yang menerima sinyal ini
// WAJIB fetch ulang lewat REST GET /api/dashboard-banner yang sudah ada.
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS_ID = 'dashboardBanner';

// ── VALIDASI GAMBAR (upload) — pola SAMA PERSIS dengan MAX_IMAGE_BYTES/
// IMAGE_MIME_WHITELIST di appCustomizationManager.js. Limit diturunkan ke
// 5MB (bukan 10MB App Customization) karena ini cuma SATU kartu banner
// kecil, bukan full background App — tetap ada limit eksplisit, tidak
// percaya validasi frontend saja.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// ── DAFTAR HALAMAN INTERNAL APP YANG VALID (buttonTargetPage) — diambil dari
// data-page/route navigasi yang SUDAH ADA di app/index.html (nav-item &
// pm-item yang punya setNav(page) sendiri, lihat setNav() di app/app.js).
// SENGAJA whitelist tertutup (bukan string bebas) supaya admin tidak bisa
// salah ketik dan bikin tombol banner tidak ke mana-mana. Halaman "detail"
// (butuh parameter game/produk, mis. page-detail/page-tutorial-detail/
// page-marketplace-detail/page-steam-account-detail) SENGAJA tidak masuk
// daftar ini karena bukan tujuan navigasi yang berdiri sendiri.
const PAGE_WHITELIST = [
  { id: 'home', label: 'Dashboard' },
  { id: 'mygames', label: 'Games' },
  { id: 'explore', label: 'Bypass' },
  { id: 'belipaket', label: 'Beli Paket' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'setting', label: 'Settings' },
  { id: 'transaksi', label: 'Transaksi' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'history', label: 'History' }
];
const PAGE_IDS = PAGE_WHITELIST.map(p => p.id);

const DEFAULTS = {
  _id: SETTINGS_ID,
  image: {
    source: 'upload', // 'upload' | 'url' — cuma penanda UI Admin Web (tab aktif terakhir), url tetap satu-satunya field yang dipakai APP
    url: ''
  },
  eyebrow: 'Featured This Week',
  title: 'Elden Ring',
  description: 'Jelajahi Lands Between, kumpulkan kekuatan runa, dan hadapi para Demigod dalam dunia terbuka yang luas.',
  buttonText: 'Lihat Detail',
  buttonTargetType: 'page', // 'page' | 'url'
  buttonTargetPage: 'mygames',
  buttonTargetUrl: '',
  updatedAt: null,
  updatedBy: null
};

function sanitizeImageUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (s.startsWith('data:image/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

// ── Validasi KETAT (throw kalau invalid), dipanggil dari updateConfig()
// SEBELUM merge & simpan — SAMA POLA dengan validateBackgroundImageUrl() di
// appCustomizationManager.js. sanitizeImageUrl() di atas sengaja dibiarkan
// longgar (format-only, tidak pernah throw) karena dipakai juga di jalur GET
// biasa (mergeDefaults()) — supaya doc lama tetap aman dibaca apapun isinya.
function dataUriMime(dataUri) {
  const m = /^data:([^;,]+)/i.exec(dataUri);
  return m ? m[1].toLowerCase() : '';
}
function dataUriByteSize(dataUri) {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) return Infinity;
  const base64 = dataUri.slice(commaIdx + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
function validateBannerImageUrl(v) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return; // kosong = hapus gambar, valid (APP fallback ke gradient default, lihat toPublicPayload)

  if (s.startsWith('data:')) {
    const mime = dataUriMime(s);
    if (!IMAGE_MIME_WHITELIST.includes(mime)) {
      throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.');
    }
    if (dataUriByteSize(s) > MAX_IMAGE_BYTES) {
      throw new Error('Ukuran gambar maksimal 5 MB.');
    }
    return;
  }
  if (/^https?:\/\//i.test(s)) return; // Link URL — divalidasi cuma format prefix-nya (poin #5 permintaan)
  throw new Error('Image URL tidak valid. Gunakan link http(s):// atau upload file.');
}

module.exports = function createDashboardBannerManager({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  function mergeDefaults(doc) {
    const d = doc || {};
    const img = d.image || {};

    const buttonTargetType = ['page', 'url'].includes(d.buttonTargetType) ? d.buttonTargetType : DEFAULTS.buttonTargetType;
    const buttonTargetPage = PAGE_IDS.includes(d.buttonTargetPage) ? d.buttonTargetPage : DEFAULTS.buttonTargetPage;
    const buttonTargetUrl = sanitizeImageUrl(d.buttonTargetUrl) || (/^https?:\/\//i.test(String(d.buttonTargetUrl || '').trim()) ? String(d.buttonTargetUrl).trim() : '');

    return {
      _id: SETTINGS_ID,
      image: {
        source: ['upload', 'url'].includes(img.source)
          ? img.source
          : (/^https?:\/\//i.test(String(img.url || '')) ? 'url' : DEFAULTS.image.source),
        url: sanitizeImageUrl(img.url)
      },
      eyebrow: (typeof d.eyebrow === 'string') ? d.eyebrow.trim().slice(0, 60) : DEFAULTS.eyebrow,
      title: (typeof d.title === 'string') ? d.title.trim().slice(0, 100) : DEFAULTS.title,
      description: (typeof d.description === 'string') ? d.description.trim().slice(0, 240) : DEFAULTS.description,
      buttonText: (typeof d.buttonText === 'string' && d.buttonText.trim()) ? d.buttonText.trim().slice(0, 40) : DEFAULTS.buttonText,
      buttonTargetType,
      buttonTargetPage,
      buttonTargetUrl,
      updatedAt: d.updatedAt || null,
      updatedBy: d.updatedBy || null
    };
  }

  async function getConfig() {
    const database = db();
    if (!database) return mergeDefaults(null);
    const doc = await database.collection('settings').findOne({ _id: SETTINGS_ID });
    return mergeDefaults(doc);
  }

  // Payload publik (dipakai APP lewat GET /api/dashboard-banner) — HANYA
  // field yang memang perlu ditampilkan/dipakai APP (poin #7 permintaan).
  // `updatedBy` (audit trail internal Admin Web) SENGAJA tidak diekspos di
  // sini, lihat getConfig()/GET admin di server.js untuk versi lengkapnya.
  function toPublicPayload(cfg) {
    return {
      imageUrl: cfg.image.url,
      eyebrow: cfg.eyebrow,
      title: cfg.title,
      description: cfg.description,
      buttonText: cfg.buttonText,
      buttonTargetType: cfg.buttonTargetType,
      buttonTargetPage: cfg.buttonTargetPage,
      buttonTargetUrl: cfg.buttonTargetUrl,
      version: cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0
    };
  }

  async function updateConfig(patch, updatedBy) {
    // Validasi KETAT gambar BARU (kalau field image.url memang dikirim) —
    // SEBELUM merge & simpan, sama pola dengan appCustomizationManager.js.
    if (patch.image && typeof patch.image.url === 'string') {
      validateBannerImageUrl(patch.image.url);
    }
    // Validasi URL tombol (mode Link Eksternal) — pola SAMA PERSIS dengan
    // validateBannerImageFields() di server.js (banner carousel lama):
    // harus diawali http:// atau https://.
    if (patch.buttonTargetType === 'url' && typeof patch.buttonTargetUrl === 'string' && patch.buttonTargetUrl.trim()) {
      if (!/^https?:\/\//i.test(patch.buttonTargetUrl.trim())) {
        throw new Error('URL tombol harus diawali http:// atau https://');
      }
    }
    // Tujuan Halaman APP wajib dari whitelist (poin #6 permintaan) — kalau
    // Admin (atau request manual/curl) mengirim page di luar whitelist,
    // tolak dengan pesan jelas daripada diam-diam fallback ke default.
    if (patch.buttonTargetType === 'page' && typeof patch.buttonTargetPage === 'string' && patch.buttonTargetPage && !PAGE_IDS.includes(patch.buttonTargetPage)) {
      throw new Error('Tujuan Halaman APP tidak valid.');
    }

    const current = await getConfig();
    const merged = {
      image: { ...current.image, ...(patch.image || {}) },
      eyebrow: patch.eyebrow ?? current.eyebrow,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      buttonText: patch.buttonText ?? current.buttonText,
      buttonTargetType: patch.buttonTargetType ?? current.buttonTargetType,
      buttonTargetPage: patch.buttonTargetPage ?? current.buttonTargetPage,
      buttonTargetUrl: patch.buttonTargetUrl ?? current.buttonTargetUrl
    };
    const next = mergeDefaults(merged);
    next.updatedAt = new Date();
    next.updatedBy = updatedBy || 'Admin';

    const database = db();
    if (database) {
      await database.collection('settings').updateOne(
        { _id: SETTINGS_ID },
        { $set: next },
        { upsert: true }
      );
    }
    return next;
  }

  // Dipanggil setelah save berhasil — push SINYAL RINGAN ke SEMUA App yang
  // sedang online lewat wsBroadcastAll existing (TIDAK ada WebSocket baru).
  // App yang menerima sinyal ini WAJIB refetch lewat GET /api/dashboard-banner
  // (lihat loadDashboardBanner() di app/app.js) — payload gambar base64 tidak
  // pernah lewat WS sama sekali, sama alasan dengan App Customization.
  async function broadcastUpdate() {
    const cfg = await getConfig();
    const payload = toPublicPayload(cfg);
    wsBroadcastAll('dashboard-banner:update', { changed: true, version: payload.version });
    return payload;
  }

  return { getConfig, updateConfig, toPublicPayload, broadcastUpdate, DEFAULTS, PAGE_WHITELIST };
};
