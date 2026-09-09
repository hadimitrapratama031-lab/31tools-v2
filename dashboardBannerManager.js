// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD BANNER MANAGER — MULTI BANNER DINAMIS di halaman Dashboard APP
// (elemen `.dash-banner` / carousel di app/index.html), diatur penuh dari
// Admin Web ("Setting Banner") dan berubah REALTIME ke APP tanpa
// restart/reload.
//
// UPGRADE dari versi SATU banner statis -> N banner (Banner 1, 2, 3, dst,
// masing-masing setting sendiri: gambar, eyebrow, judul, deskripsi, status
// aktif/nonaktif, urutan, tombol/action). TIDAK ada sistem/collection baru
// dibuat untuk ini — tetap SATU dokumen di collection `settings` (_id sama:
// 'dashboardBanner'), sekarang menyimpan array `banners: [...]` alih-alih
// field banner tunggal di root dokumen. Dokumen versi LAMA (root-level
// title/eyebrow/dst, tanpa `banners`) otomatis dimigrasikan jadi array 1
// banner begitu dibaca (lihat mergeDefaults()) — data lama tidak hilang.
//
// PENTING — ini BUKAN sistem banner carousel multi-slide (koleksi `banners`,
// endpoint /api/banners & /api/admin/banners, Code Banner/iframe sandbox)
// yang sudah ada di project ini. Sistem carousel lama itu TIDAK disentuh
// sama sekali di sini — dibiarkan idle di codebase, tidak dipakai fitur ini.
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
//
// MODEL SAVE: satu dokumen -> satu array. Admin Web mengedit SELURUH array
// banner (tambah/edit/hapus/ubah urutan/ubah status) di sisi client sebagai
// draft, lalu klik "Simpan Perubahan" SEKALI mengirim seluruh array lewat
// PUT /api/admin/dashboard-banner (pola SAMA PERSIS dengan aczSave()/
// dbnSave() versi lama — bukan endpoint CRUD terpisah per banner). Ini
// pola yang SUDAH ADA di project ini (satu PUT = satu source of truth),
// bukan sistem baru.
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SETTINGS_ID = 'dashboardBanner';

// ── VALIDASI GAMBAR (upload) — pola SAMA PERSIS dengan MAX_IMAGE_BYTES/
// IMAGE_MIME_WHITELIST di appCustomizationManager.js. Limit diturunkan ke
// 5MB (bukan 10MB App Customization) karena ini kartu banner kecil, bukan
// full background App — tetap ada limit eksplisit per banner, tidak percaya
// validasi frontend saja.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per banner
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// Batas jumlah banner — jaring pengaman supaya dokumen `settings` (yang
// menyimpan gambar sebagai data URI base64) tidak membengkak tak terbatas.
// Bukan batas yang diminta user secara eksplisit, tapi konsisten dengan
// prinsip "jangan percaya input tak terbatas" yang dipakai manager lain di
// project ini.
const MAX_BANNERS = 20;

// ── DAFTAR HALAMAN INTERNAL APP YANG VALID (buttonTargetPage) — diambil dari
// data-page/route navigasi yang SUDAH ADA di app/index.html (nav-item &
// pm-item yang punya setNav(page) sendiri, lihat setNav() di app/app.js).
// SENGAJA whitelist tertutup (bukan string bebas) supaya admin tidak bisa
// salah ketik dan bikin tombol banner tidak ke mana-mana. Halaman "detail"
// (butuh parameter game/produk) SENGAJA tidak masuk daftar ini karena bukan
// tujuan navigasi yang berdiri sendiri.
const PAGE_WHITELIST = [
  { id: 'home', label: 'Dashboard' },
  { id: 'mygames', label: 'Games' },
  { id: 'explore', label: 'Bypass' },
  { id: 'belipaket', label: 'Beli Paket' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'requestgame', label: 'Request Game' }, // nav-item data-page="requestgame" (app/index.html), sebelumnya kelewat waktu whitelist ini dibuat
  { id: 'setting', label: 'Settings' },
  { id: 'transaksi', label: 'Transaksi' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'history', label: 'History' }
];
const PAGE_IDS = PAGE_WHITELIST.map(p => p.id);

const BANNER_DEFAULTS = {
  id: null, // di-assign saat dibuat, lihat newBannerId()
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
  active: true,
  order: 0
};

function newBannerId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `bnr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

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
// biasa (mergeBanner()) — supaya doc lama tetap aman dibaca apapun isinya.
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
function validateBannerImageUrl(v, label) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return; // kosong = hapus gambar, valid (APP fallback ke gradient default, lihat toPublicBanner)

  if (s.startsWith('data:')) {
    const mime = dataUriMime(s);
    if (!IMAGE_MIME_WHITELIST.includes(mime)) {
      throw new Error(`${label}: format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.`);
    }
    if (dataUriByteSize(s) > MAX_IMAGE_BYTES) {
      throw new Error(`${label}: ukuran gambar maksimal 5 MB.`);
    }
    return;
  }
  if (/^https?:\/\//i.test(s)) return; // Link URL — divalidasi cuma format prefix-nya
  throw new Error(`${label}: Image URL tidak valid. Gunakan link http(s):// atau upload file.`);
}

module.exports = function createDashboardBannerManager({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  // ── Merge satu item banner ke bentuk lengkap+aman (dipakai buat baca DAN
  // sebelum simpan) — TIDAK PERNAH throw, field yang aneh/kosong jatuh ke
  // default (sama filosofi dengan mergeDefaults() versi single-banner lama).
  function mergeBanner(raw, index) {
    const d = raw || {};
    const img = d.image || {};

    const buttonTargetType = ['page', 'url'].includes(d.buttonTargetType) ? d.buttonTargetType : BANNER_DEFAULTS.buttonTargetType;
    const buttonTargetPage = PAGE_IDS.includes(d.buttonTargetPage) ? d.buttonTargetPage : BANNER_DEFAULTS.buttonTargetPage;
    const buttonTargetUrl = (/^https?:\/\//i.test(String(d.buttonTargetUrl || '').trim())) ? String(d.buttonTargetUrl).trim() : '';

    return {
      id: (typeof d.id === 'string' && d.id.trim()) ? d.id.trim() : newBannerId(),
      image: {
        source: ['upload', 'url'].includes(img.source)
          ? img.source
          : (/^https?:\/\//i.test(String(img.url || '')) ? 'url' : BANNER_DEFAULTS.image.source),
        url: sanitizeImageUrl(img.url)
      },
      eyebrow: (typeof d.eyebrow === 'string') ? d.eyebrow.trim().slice(0, 60) : BANNER_DEFAULTS.eyebrow,
      title: (typeof d.title === 'string') ? d.title.trim().slice(0, 100) : BANNER_DEFAULTS.title,
      description: (typeof d.description === 'string') ? d.description.trim().slice(0, 240) : BANNER_DEFAULTS.description,
      buttonText: (typeof d.buttonText === 'string' && d.buttonText.trim()) ? d.buttonText.trim().slice(0, 40) : BANNER_DEFAULTS.buttonText,
      buttonTargetType,
      buttonTargetPage,
      buttonTargetUrl,
      active: (typeof d.active === 'boolean') ? d.active : BANNER_DEFAULTS.active,
      // Urutan = posisi di array (source of truth urutan adalah URUTAN ARRAY
      // itu sendiri, bukan field `order` yang bisa nyasar/duplikat kalau
      // ditulis manual) — field ini tetap disimpan supaya kompatibel dengan
      // konsumen lama yang mungkin baca `order`, tapi selalu di-derive ulang
      // dari index saat merge, TIDAK PERNAH dipercaya dari input mentah.
      order: index
    };
  }

  // ── Migrasi dokumen versi LAMA (single-banner, field di root dokumen,
  // tanpa `banners` array) -> array 1 banner. Dipanggil di dalam
  // mergeDefaults() setiap kali baca, supaya data lama TIDAK PERNAH hilang
  // walau belum pernah di-save ulang lewat versi baru ini.
  function migrateLegacyDoc(d) {
    if (Array.isArray(d.banners)) return d.banners;
    // Doc lama (atau doc kosong) — kalau ada minimal satu field khas versi
    // lama, bungkus jadi array 1 banner supaya isi lama tetap tampil di APP.
    const hasLegacyFields = d.title || d.eyebrow || d.description || (d.image && d.image.url);
    if (!hasLegacyFields) return [];
    return [{
      id: newBannerId(),
      image: d.image || {},
      eyebrow: d.eyebrow,
      title: d.title,
      description: d.description,
      buttonText: d.buttonText,
      buttonTargetType: d.buttonTargetType,
      buttonTargetPage: d.buttonTargetPage,
      buttonTargetUrl: d.buttonTargetUrl,
      active: true
    }];
  }

  function mergeDefaults(doc) {
    const d = doc || {};
    const rawBanners = migrateLegacyDoc(d);
    const banners = (Array.isArray(rawBanners) ? rawBanners : []).map((b, i) => mergeBanner(b, i));

    return {
      _id: SETTINGS_ID,
      banners,
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

  // Payload publik SATU banner (dipakai APP lewat GET /api/dashboard-banner)
  // — HANYA field yang memang perlu ditampilkan/dipakai APP.
  function toPublicBanner(b) {
    return {
      id: b.id,
      imageUrl: b.image.url,
      eyebrow: b.eyebrow,
      title: b.title,
      description: b.description,
      buttonText: b.buttonText,
      buttonTargetType: b.buttonTargetType,
      buttonTargetPage: b.buttonTargetPage,
      buttonTargetUrl: b.buttonTargetUrl,
      order: b.order
    };
  }

  // Payload publik LENGKAP (array) — HANYA banner yang `active`, sudah
  // terurut sesuai urutan array (poin "Urutan banner" permintaan), plus
  // `version` global (dari updatedAt dokumen) dipakai APP buat cache-bust
  // gambar Image URL (link), sama pola dengan versi single-banner lama.
  function toPublicPayload(cfg) {
    const activeBanners = cfg.banners.filter(b => b.active).map(toPublicBanner);
    return {
      banners: activeBanners,
      version: cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0
    };
  }

  async function updateConfig(patch, updatedBy) {
    const incoming = Array.isArray(patch && patch.banners) ? patch.banners : [];
    if (incoming.length > MAX_BANNERS) {
      throw new Error(`Maksimal ${MAX_BANNERS} banner.`);
    }

    // Validasi KETAT tiap banner SEBELUM disimpan — satu banner invalid
    // menggagalkan SELURUH save (pola sama dengan validasi single-banner
    // lama: tidak ada simpan sebagian).
    incoming.forEach((raw, i) => {
      const label = `Banner ${i + 1}`;
      const img = raw && raw.image;
      if (img && typeof img.url === 'string') {
        validateBannerImageUrl(img.url, label);
      }
      if (raw && raw.buttonTargetType === 'url' && typeof raw.buttonTargetUrl === 'string' && raw.buttonTargetUrl.trim()) {
        if (!/^https?:\/\//i.test(raw.buttonTargetUrl.trim())) {
          throw new Error(`${label}: URL tombol harus diawali http:// atau https://`);
        }
      }
      if (raw && raw.buttonTargetType === 'page' && typeof raw.buttonTargetPage === 'string' && raw.buttonTargetPage && !PAGE_IDS.includes(raw.buttonTargetPage)) {
        throw new Error(`${label}: Tujuan Halaman APP tidak valid.`);
      }
    });

    // mergeBanner() men-derive `order` dari index array (urutan array =
    // urutan tampil, lihat catatan di mergeBanner()) & mengisi `id` baru
    // untuk banner yang memang belum punya id (banner baru dari tombol
    // "+ Tambah Banner" di Admin Web).
    const banners = incoming.map((raw, i) => mergeBanner(raw, i));

    const next = {
      _id: SETTINGS_ID,
      banners,
      updatedAt: new Date(),
      updatedBy: updatedBy || 'Admin'
    };

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

  return { getConfig, updateConfig, toPublicPayload, broadcastUpdate, BANNER_DEFAULTS, PAGE_WHITELIST, MAX_BANNERS };
};