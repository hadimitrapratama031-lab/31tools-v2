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
//
// ── PERF (halaman Setting Banner di Admin Web lambat dibuka/disimpan) ──────
// PENYEBAB UTAMA sama persis dengan yang sudah pernah diaudit & diperbaiki
// di App Customization (lihat appCustomizationManager.js toAdminPayload()):
// tiap banner.image.url upload disimpan sebagai data URI base64 LANGSUNG di
// dokumen (bisa sampai ~6.7MB base64 dari batas 5MB/banner), dan SEBELUM
// optimasi ini base64 itu ikut utuh di body JSON setiap kali GET/PUT
// /api/admin/dashboard-banner dipanggil — dikali sampai MAX_BANNERS (20)
// banner sekaligus, jadi bisa >100MB bolak-balik hanya untuk buka halaman.
//
// Fix (pola SAMA PERSIS dengan App Customization, diperluas untuk array N
// banner alih-alih 1 field gambar):
//  1. toAdminPayload()/toPublicPayload() TIDAK PERNAH mengirim data URI berat
//     mentah — diganti path endpoint ringan (/api/admin/dashboard-banner/
//     image/:id atau /api/dashboard-banner/image/:id, lihat server.js) yang
//     menyajikan gambar yang SAMA PERSIS lewat <img src="..."> terpisah,
//     paralel, lazy (tidak nge-block parsing JSON config), dan ikut HTTP
//     cache browser biasa.
//  2. Endpoint admin (?thumb=1) menyajikan THUMBNAIL (resize ringan lewat
//     `sharp`, sudah jadi dependency project — dipakai persis pola yang sama
//     dengan catalogEmbedColor.js: require aman try/catch, gagal load native
//     binding TIDAK BOLEH bikin server crash, cuma fallback ke gambar
//     original apa adanya) — bukan storage/sistem gambar baru, cuma
//     transform on-the-fly dari data yang SUDAH tersimpan, di-cache di
//     memori (lihat thumbCache di bawah) supaya tidak resize ulang tiap
//     request yang sama.
//  3. Admin Web (admin.js) sisi Save juga TIDAK mengirim ulang image.url
//     kalau admin tidak benar-benar upload/ganti gambar banner itu (lihat
//     _imageTouched di dbnCleanBanner()/dbnSave() admin.js) — updateConfig()
//     di bawah mengisi balik dari banner tersimpan (by id) kalau field ini
//     tidak dikirim. Kombinasi load ringan + save parsial ini yang
//     menghilangkan bottleneck utama, TANPA mengubah struktur dokumen/skema
//     database sama sekali (source of truth tetap dokumen `settings` yang
//     sama, field image.url tetap data URI base64 penuh di DB).
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

// Require aman: kalau native binding `sharp` gagal dimuat di platform deploy
// tertentu, halaman Setting Banner TIDAK BOLEH ikut rusak — efeknya cuma
// endpoint thumbnail (?thumb=1) diam-diam fallback menyajikan gambar
// original apa adanya (masih benar, cuma tidak diperkecil). Pola SAMA
// PERSIS dengan catalogEmbedColor.js.
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[DashboardBanner] Module "sharp" gagal dimuat — thumbnail Setting Banner akan fallback ke gambar original:', e.message);
}

const SETTINGS_ID = 'dashboardBanner';

// ══════════════════════════════════════════════════════════════════════════
// PERF FIX (root cause "Setting Banner lambat dibuka", diaudit ulang) —
// SEBELUM fix ini, base64 tiap banner (bisa 5-10MB/banner) disimpan LANGSUNG
// di dalam field `image.url` pada SATU dokumen `settings` (_id: 'dashboardBanner').
// toAdminPayload()/toPublicBanner() memang sudah tidak mengirim base64 itu ke
// browser (diganti path endpoint gambar) — TAPI getBannerImageAsset() (dipanggil
// endpoint gambar) tetap memanggil getConfig(), yang membaca ULANG SELURUH
// dokumen `settings` (termasuk base64 SEMUA banner lain) dari MongoDB, method
// SATU KALI PER GAMBAR. Kartu list Admin Web memuat gambar tiap banner lewat
// <img> terpisah secara paralel — jadi buka halaman dengan N banner = N kali
// baca dokumen raksasa itu utuh dari database (bisa >100MB bolak-balik ke
// MongoDB walau browser sendiri cuma terima thumbnail kecil), plus resiko
// dokumen kena batas 16MB per-dokumen MongoDB begitu banner ber-gambar makin
// banyak.
//
// FIX — pindahkan BYTES gambar (bukan metadata) ke koleksi terpisah
// `dashboardBannerImages` (satu dokumen kecil per banner, _id = banner id,
// otomatis terindeks lewat _id bawaan MongoDB). Dokumen `settings` sekarang
// HANYA berisi metadata ringan per banner (teks + penanda LOCAL_IMAGE_MARKER
// kalau banner itu punya gambar upload) — jadi getConfig() (dipanggil di
// hampir semua fungsi termasuk getBannerImageAsset) selalu ringan & cepat,
// TIDAK PERNAH lagi ikut membawa base64. Endpoint gambar baru query LANGSUNG
// ke `dashboardBannerImages` by _id (satu dokumen kecil, bukan seluruh
// koleksi banner) hanya untuk banner yang memang diminta. Tidak mengubah
// endpoint/response shape yang dipakai Admin Web maupun App sama sekali —
// murni perubahan lapisan penyimpanan.
// ══════════════════════════════════════════════════════════════════════════
const IMAGES_COLLECTION = 'dashboardBannerImages';
const LOCAL_IMAGE_MARKER = 'local-upload'; // pengganti data URI di dalam dokumen `settings` — penanda "gambarnya ada di IMAGES_COLLECTION", BUKAN data URI sungguhan jadi tidak pernah "berat"
function isLocalMarker(v) { return v === LOCAL_IMAGE_MARKER; }

// ── Thumbnail preview khusus Admin Web (list card + live preview) — lebar
// cukup untuk kartu banner kecil di Admin Web, jauh dari ukuran carousel
// App sebenarnya. Kualitas/ukuran original 5-10MB TIDAK PERNAH disentuh/
// dirusak di database, ini murni turunan sementara untuk tampilan admin.
const THUMB_MAX_WIDTH = 480;
const THUMB_WEBP_QUALITY = 62;

// Cache in-memori sederhana (BUKAN collection DB baru, best-effort, boleh
// kosong lagi kapan saja) — kunci `${id}:${updatedAtMs}` supaya otomatis
// "batal" begitu banner diedit/disave ulang (updatedAt berubah -> key baru),
// tidak perlu invalidasi manual. Dibatasi jumlah entry, pola SAMA PERSIS
// dengan colorCache di catalogEmbedColor.js, supaya tidak tumbuh tanpa batas
// kalau banner sering diganti-ganti.
const THUMB_CACHE_MAX_ENTRIES = 100;
const thumbCache = new Map(); // key -> { mime, buffer }
function thumbCacheSet(key, val) {
  if (thumbCache.size >= THUMB_CACHE_MAX_ENTRIES) {
    const oldestKey = thumbCache.keys().next().value;
    if (oldestKey !== undefined) thumbCache.delete(oldestKey);
  }
  thumbCache.set(key, val);
}

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
  if (isLocalMarker(s)) return s; // sudah tersimpan di IMAGES_COLLECTION, bukan data URI mentah
  if (s.startsWith('data:image/')) return s; // upload BARU/BELUM diproses updateConfig() — dipindah ke IMAGES_COLLECTION lalu diganti marker sebelum disimpan (lihat updateConfig())
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
// ── Decode data URI -> {mime, buffer}, dipakai bareng oleh getBannerImageAsset
// (endpoint gambar) & (tidak sama sekali oleh jalur simpan/baca biasa — field
// mentah di DB tidak pernah didekode kecuali memang mau disajikan sebagai
// file gambar). TIDAK PERNAH throw — data URI aneh/korup cukup dianggap
// "tidak ada gambar" (null), sama filosofi dengan sanitizeImageUrl().
function decodeDataUri(dataUri) {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(dataUri || '');
  if (!m) return null;
  try {
    return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
  } catch (e) {
    return null;
  }
}
function validateBannerImageUrl(v, label) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return; // kosong = hapus gambar, valid (APP fallback ke gradient default, lihat toPublicBanner)
  if (isLocalMarker(s)) return; // sudah tervalidasi & tersimpan sebelumnya di IMAGES_COLLECTION

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
  //
  // PERF: kalau imageUrl adalah data URI upload (bisa 5MB), diganti path
  // endpoint ringan GET /api/dashboard-banner/image/:id (lihat server.js) —
  // App memuatnya lewat <img src="..."> terpisah (sudah pola yang App pakai
  // dari dulu untuk Image URL/link biasa, lihat _dashBannerImgSrc() di
  // app/app.js — otomatis dapat cache-busting ?v= juga karena bukan lagi
  // data: URI). Gambarnya SAMA PERSIS, cuma jalur pengirimannya dipisah dari
  // JSON config supaya GET ini ringan & cepat di-parse walau banner banyak.
  function toPublicBanner(b) {
    const local = isLocalMarker(b.image.url);
    return {
      id: b.id,
      imageUrl: local ? `/api/dashboard-banner/image/${encodeURIComponent(b.id)}` : b.image.url,
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

  // Payload ADMIN (dipakai GET & PUT-response /api/admin/dashboard-banner)
  // — SEMUA banner (termasuk nonaktif, admin perlu edit semuanya), tapi
  // data URI berat diganti path endpoint thumbnail ringan
  // (/api/admin/dashboard-banner/image/:id?thumb=1) — lihat catatan PERF di
  // atas file ini. TIDAK mengubah apapun yang tersimpan di DB, murni lapisan
  // response HTTP. url yang sudah http(s) biasa (mode "Image URL") dibiarkan
  // apa adanya karena memang sudah ringan.
  function toAdminPayload(cfg) {
    const version = cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0;
    const banners = cfg.banners.map((b) => {
      const local = isLocalMarker(b.image.url);
      return {
        ...b,
        image: {
          source: b.image.source,
          url: local ? `/api/admin/dashboard-banner/image/${encodeURIComponent(b.id)}?thumb=1&v=${version}` : b.image.url
        }
      };
    });
    return {
      _id: cfg._id,
      banners,
      updatedAt: cfg.updatedAt,
      updatedBy: cfg.updatedBy,
      version
    };
  }

  // ── Ambil bytes gambar SATU banner (original atau thumbnail) — dipakai
  // endpoint GET /api/dashboard-banner/image/:id (App) & GET
  // /api/admin/dashboard-banner/image/:id (Admin Web, ?thumb=1). Dibaca
  // ULANG dari DB tiap kali (getConfig() TANPA cache), konsisten dengan
  // prinsip realtime project ini — cuma HASIL RESIZE thumbnail yang
  // di-cache di memori (thumbCache), bukan datanya.
  // Return: { status: 'ok', mime, buffer } | { status: 'redirect', url } |
  //         { status: 'notfound' }
  async function getBannerImageAsset(id, { thumb } = {}) {
    // getConfig() sekarang SELALU ringan (dokumen `settings` tidak lagi
    // menyimpan base64 — lihat catatan PERF FIX di atas file), jadi baca ini
    // aman dipanggil per-request tanpa jadi bottleneck.
    const cfg = await getConfig();
    const banner = cfg.banners.find(b => b.id === id);
    const url = banner && banner.image && banner.image.url;
    if (!url) return { status: 'notfound' };

    if (/^https?:\/\//i.test(url)) return { status: 'redirect', url };
    if (!isLocalMarker(url)) return { status: 'notfound' };

    const database = db();
    if (!database) return { status: 'notfound' };

    // Query LANGSUNG ke dokumen kecil banner ini saja (by _id, terindeks
    // bawaan MongoDB) — BUKAN dokumen `settings` gabungan, ini inti fix-nya:
    // N banner di halaman = N query kecil independen, bukan N kali baca
    // dokumen besar yang sama berulang-ulang.
    const imgDoc = await database.collection(IMAGES_COLLECTION).findOne({ _id: id });
    if (!imgDoc || !imgDoc.data) return { status: 'notfound' };
    const buffer = Buffer.isBuffer(imgDoc.data) ? imgDoc.data : Buffer.from(imgDoc.data.buffer || imgDoc.data);
    const mime = imgDoc.mime || 'image/jpeg';
    const updatedMs = imgDoc.updatedAt ? new Date(imgDoc.updatedAt).getTime() : 0;

    if (!thumb || !sharp) return { status: 'ok', mime, buffer };

    const cacheKey = `${id}:${updatedMs}`;
    const cached = thumbCache.get(cacheKey);
    if (cached) return { status: 'ok', mime: cached.mime, buffer: cached.buffer };

    try {
      const resized = await sharp(buffer)
        .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: THUMB_WEBP_QUALITY })
        .toBuffer();
      const result = { mime: 'image/webp', buffer: resized };
      thumbCacheSet(cacheKey, result);
      return { status: 'ok', mime: result.mime, buffer: result.buffer };
    } catch (e) {
      console.warn('[DashboardBanner] Gagal membuat thumbnail, fallback ke gambar original:', e.message);
      return { status: 'ok', mime, buffer };
    }
  }

  // Simpan bytes gambar SATU banner ke IMAGES_COLLECTION (dipanggil dari
  // updateConfig() untuk banner yang gambarnya BENAR-BENAR baru/diganti di
  // sesi edit ini — dataUri adalah data: URI mentah dari Admin Web).
  async function persistBannerImage(id, dataUri) {
    const decoded = decodeDataUri(dataUri);
    if (!decoded) return false;
    const database = db();
    if (!database) return false;
    await database.collection(IMAGES_COLLECTION).updateOne(
      { _id: id },
      { $set: { mime: decoded.mime, data: decoded.buffer, updatedAt: new Date() } },
      { upsert: true }
    );
    return true;
  }
  async function deleteBannerImage(id) {
    const database = db();
    if (!database) return;
    await database.collection(IMAGES_COLLECTION).deleteOne({ _id: id }).catch(() => {});
  }

  async function updateConfig(patch, updatedBy) {
    const incoming = Array.isArray(patch && patch.banners) ? patch.banners : [];
    if (incoming.length > MAX_BANNERS) {
      throw new Error(`Maksimal ${MAX_BANNERS} banner.`);
    }

    // ── PERF — SAVE PARSIAL PER BANNER ────────────────────────────────────
    // Admin Web (dbnCleanBanner() di admin.js) SENGAJA tidak mengirim ulang
    // `image.url` untuk banner yang gambarnya TIDAK disentuh di sesi edit
    // ini (cuma ganti teks/status/urutan/dll) — base64 bisa beberapa MB per
    // banner, dikali sampai 20 banner percuma dikirim ulang kalau memang
    // tidak berubah. Di sini, untuk tiap banner masuk yang punya `id` cocok
    // dengan banner YANG SUDAH TERSIMPAN dan tidak menyertakan image.url
    // (field-nya bukan string sama sekali — beda dengan string kosong '',
    // yang berarti admin memang mau MENGHAPUS gambar), isi balik dari
    // gambar yang sudah tersimpan supaya tidak hilang. Banner BARU (tanpa id
    // yang cocok) tetap wajib bawa gambarnya sendiri kalau mau ada gambar.
    const current = await getConfig();
    const currentById = new Map(current.banners.map(b => [b.id, b]));
    incoming.forEach((raw) => {
      const hasUrlField = raw && raw.image && typeof raw.image.url === 'string';
      if (!hasUrlField && raw && typeof raw.id === 'string' && currentById.has(raw.id)) {
        const existingImg = currentById.get(raw.id).image;
        raw.image = { source: existingImg.source, url: existingImg.url };
      }
    });

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

    // ── PERF FIX — pindahkan bytes gambar BARU/DIGANTI ke IMAGES_COLLECTION,
    // dokumen `settings` (next.banners di bawah) TIDAK PERNAH menyimpan data
    // URI mentah lagi, hanya LOCAL_IMAGE_MARKER. Jalan SETELAH mergeBanner()
    // supaya setiap banner (termasuk yang baru) sudah punya `id` final untuk
    // dipakai sebagai key IMAGES_COLLECTION. Best-effort/sequential (jumlah
    // banner yang benar-benar diedit gambarnya dalam satu Save biasanya
    // sedikit, tidak perlu paralel agresif ke DB yang sama).
    for (const b of banners) {
      const rawUrl = b.image.url;
      if (typeof rawUrl === 'string' && rawUrl.startsWith('data:')) {
        await persistBannerImage(b.id, rawUrl);
        b.image.url = LOCAL_IMAGE_MARKER;
      } else if (!rawUrl) {
        // Kosong = admin menghapus gambar ATAU pindah ke mode Link URL —
        // hapus file lama di IMAGES_COLLECTION supaya tidak jadi sampah
        // (best-effort, tidak menggagalkan save kalau gagal).
        await deleteBannerImage(b.id);
      }
      // rawUrl berupa http(s):// atau sudah LOCAL_IMAGE_MARKER (tidak
      // disentuh admin di sesi ini) -> dibiarkan apa adanya.
    }

    // Banner yang DIHAPUS admin di sesi edit ini (ada di `current`, tidak ada
    // lagi di `banners` hasil akhir) — bersihkan juga file gambarnya kalau
    // ada, supaya IMAGES_COLLECTION tidak menumpuk entry banner yang sudah
    // tidak ada.
    const nextIds = new Set(banners.map(b => b.id));
    for (const oldBanner of current.banners) {
      if (!nextIds.has(oldBanner.id) && isLocalMarker(oldBanner.image.url)) {
        await deleteBannerImage(oldBanner.id);
      }
    }

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

  return { getConfig, updateConfig, toPublicPayload, toAdminPayload, getBannerImageAsset, broadcastUpdate, BANNER_DEFAULTS, PAGE_WHITELIST, MAX_BANNERS };
};