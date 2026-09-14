// ══════════════════════════════════════════════════════════════════════════
// APP CUSTOMIZATION MANAGER — background & branding (logo + teks "31 Tools")
// App Desktop, diatur dari halaman "App Customization" di Admin Web.
//
// Pola SAMA PERSIS dengan welcomePopupManager.js/maintenanceManager.js/
// websiteSettingsManager.js di project ini: satu dokumen konfigurasi
// disimpan di collection `settings` (_id tetap), dibaca ulang dari DB tiap
// kali dibutuhkan (tanpa cache di memori) — jadi perubahan dari Admin Web
// langsung berlaku tanpa perlu redeploy/restart App.
//
// Realtime memakai WebSocket App yang SUDAH ADA (wsBroadcastAll, lihat
// server.js) — TIDAK membuat sistem realtime baru sama sekali. Gambar
// (logo & background image) disimpan sebagai data URI base64 langsung di
// dokumen ini, pola yang sama dipakai banner/produk Marketplace/dll di
// project ini (bodyParser limit sudah dinaikkan ke 8mb di server.js).
// ══════════════════════════════════════════════════════════════════════════

const r2Storage = require('./r2Storage');

const SETTINGS_ID = 'appCustomization';

// ── BACKGROUND IMAGE & LOGO — upload/URL validation ─────────────────────
// Dipakai oleh validateBackgroundImageUrl()/validateLogoImageUrl() di bawah.
// Limit & whitelist MIME ini SAMA yang dipakai frontend (aczImageFile/
// aczLogoFile di admin.js) — divalidasi ULANG di sini karena frontend bisa
// di-bypass (edit request manual/curl langsung ke PUT
// /api/admin/app-customization).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Background — 10 MB
const LOGO_MAX_BYTES = 5 * 1024 * 1024;   // Logo — 5 MB (permintaan: upload logo maksimal 5MB)
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// ── FONT STYLE (Brand Text) ─────────────────────────────────────────────
// Daftar font TERBATAS (whitelist) yang sudah dipastikan tersedia untuk App
// Desktop lewat Google Fonts (dipasang di app/index.html, pola SAMA PERSIS
// dengan Inter/Cinzel yang sudah dipakai App sebelumnya) — jadi TIDAK ada
// font baru yang "cuma ada di browser Admin tapi tidak ada di App" (poin
// #14 permintaan). Tiap entri juga punya fallback stack ke font sistem,
// jadi kalau App kebetulan offline saat font online gagal dimuat, teks
// TETAP tampil pakai font fallback — tidak pernah gagal render (App tidak
// bergantung penuh ke internet untuk font).
const FONT_WHITELIST = [
  { id: 'Inter', label: 'Inter', stack: "'Inter', 'Segoe UI', sans-serif" },
  { id: 'Poppins', label: 'Poppins', stack: "'Poppins', 'Segoe UI', sans-serif" },
  { id: 'Roboto', label: 'Roboto', stack: "'Roboto', 'Segoe UI', sans-serif" },
  { id: 'Montserrat', label: 'Montserrat', stack: "'Montserrat', 'Segoe UI', sans-serif" },
  { id: 'Space Grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', 'Segoe UI', sans-serif" },
  { id: 'Orbitron', label: 'Orbitron', stack: "'Orbitron', 'Segoe UI', sans-serif" },
  { id: 'Rajdhani', label: 'Rajdhani', stack: "'Rajdhani', 'Segoe UI', sans-serif" },
  { id: 'Bebas Neue', label: 'Bebas Neue', stack: "'Bebas Neue', Impact, sans-serif" },
  { id: 'Oswald', label: 'Oswald', stack: "'Oswald', 'Segoe UI', sans-serif" },
  { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', 'Segoe UI', sans-serif" }
];
const FONT_IDS = FONT_WHITELIST.map(f => f.id);
const FONT_WEIGHTS = [400, 500, 600, 700, 800];

const DEFAULTS = {
  _id: SETTINGS_ID,
  background: {
    mode: 'gradient', // 'solid' | 'gradient' | 'image'
    color: '#0B1020',
    gradient: {
      type: 'linear', // 'linear' | 'radial'
      angle: 135,
      stops: [
        { color: '#0B1020', pos: 0 },
        { color: '#101F55', pos: 100 }
      ]
    },
    image: {
      source: 'upload', // 'upload' | 'url' — cuma penanda UI Admin Web, url tetap satu2nya field yang dipakai App
      url: '',
      key: null,      // R2 object key (null kalau url eksternal http(s), atau data lama belum dimigrasi)
      mimeType: '',    // MIME asli file yang diupload ke R2
      fileSize: 0,     // ukuran byte file yang diupload ke R2
      fit: 'cover',      // 'cover' | 'contain' | 'fill'
      position: 'center', // 'center' | 'top' | 'bottom' | 'left' | 'right'
      opacity: 1,
      blur: 0
    },
    overlay: {
      enabled: false,
      color: '#000000',
      opacity: 0.4
    }
  },
  branding: {
    logo: {
      enabled: false,
      url: '',
      key: null,      // R2 object key (null kalau url eksternal http(s), atau data lama belum dimigrasi)
      mimeType: '',
      fileSize: 0,     // ukuran byte file logo (JANGAN ketuker dengan `size` di bawah — itu ukuran tampilan/px)
      size: 20,
      opacity: 1
    },
    text: {
      enabled: true,
      value: '31 Tools',
      fontFamily: 'Inter',
      fontSize: 16,
      fontWeight: 600
    }
  },
  updatedAt: null,
  updatedBy: null
};

function clamp01(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}
function clampInt(n, min, max, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
function isHex(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim());
}
function sanitizeColor(v, fallback) {
  return isHex(v) ? v.trim() : fallback;
}
function sanitizeImageUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (s.startsWith('data:image/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

// ── Validasi ketat KHUSUS Background Image (dipanggil dari updateConfig(),
// BUKAN dari mergeDefaults()) ───────────────────────────────────────────
// sanitizeImageUrl() di atas sengaja dibiarkan longgar (format-only, tidak
// pernah throw) karena dipakai juga oleh mergeDefaults() di jalur GET biasa
// (getConfig()) — kalau divalidasi ketat & throw di situ, doc lama yang
// (secara teori) sudah tersimpan sebelum validasi ini ada bisa bikin App
// gagal total tiap kali fetch config (GET ikut ke-block). Validasi
// size/MIME 10MB HANYA relevan saat Admin benar2 mengirim gambar BARU lewat
// PUT /api/admin/app-customization — makanya ditaruh di sini, dipanggil
// eksplisit dari updateConfig() sebelum di-merge & disimpan, dan THROW
// Error (bukan diam2 di-sanitize jadi '') supaya PUT balas 400 dengan pesan
// jelas ke Admin Web (lihat catch di route PUT, server.js — sudah
// meneruskan e.message apa adanya ke response).
function dataUriMime(dataUri) {
  const m = /^data:([^;,]+)/i.exec(dataUri);
  return m ? m[1].toLowerCase() : '';
}
function dataUriByteSize(dataUri) {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) return Infinity; // data URI ganjil/rusak -> anggap kelewat besar, biar ditolak
  const base64 = dataUri.slice(commaIdx + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
function validateBackgroundImageUrl(v) {
  validateUploadedImageUrl(v, MAX_IMAGE_BYTES, '10 MB');
}
// LOGO — validasi SAMA PERSIS polanya dengan background di atas (MIME
// whitelist + byte-size dari data URI base64), cuma limit-nya beda
// (LOGO_MAX_BYTES = 5MB, sesuai permintaan). Dipanggil eksplisit dari
// updateConfig() untuk patch.branding.logo.url — SEBELUMNYA logo TIDAK
// PERNAH divalidasi ukuran/MIME-nya sama sekali di backend (cuma dicek di
// admin.js/frontend, yang bisa di-bypass), jadi walau limit di UI dinaikkan
// ke 5MB, backend tetap jadi pagar terakhir yang sesungguhnya menegakkan itu.
function validateLogoImageUrl(v) {
  validateUploadedImageUrl(v, LOGO_MAX_BYTES, '5 MB');
}
function validateUploadedImageUrl(v, maxBytes, maxLabel) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return; // kosong = hapus image, valid

  if (s.startsWith('data:')) {
    // Upload — base64 data URI dari FileReader.readAsDataURL() (admin.js).
    const mime = dataUriMime(s);
    if (!IMAGE_MIME_WHITELIST.includes(mime)) {
      throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.');
    }
    if (dataUriByteSize(s) > maxBytes) {
      throw new Error(`Ukuran gambar maksimal ${maxLabel}.`);
    }
    return;
  }
  if (/^https?:\/\//i.test(s)) {
    // Image URL — tidak bisa dicek ukuran/MIME file remote-nya dari sini
    // tanpa fetch (di luar scope, dan bisa lambat/gagal karena alasan
    // jaringan di luar kendali kita). Kalau nanti gagal dimuat, App fallback
    // ke background sebelumnya (applyAppBackground() di app.js) & Admin Web
    // menampilkan error di preview (aczImageUrlInput, admin.js).
    return;
  }
  throw new Error('Image URL tidak valid. Gunakan link http(s):// atau upload file.');
}

// ── R2 UPLOAD — dipanggil dari updateConfig() untuk background.image.url
// ATAU branding.logo.url, SEBELUM apa pun disimpan ke MongoDB. Mengembalikan
// field baru yang siap di-merge (fields) DAN key R2 lama yang sudah tidak
// dipakai lagi & aman dihapus SETELAH config baru berhasil tersimpan
// (deleteOldKey) — pemanggil (updateConfig) yang menentukan kapan actual
// delete dieksekusi, supaya urutan "upload baru dulu, baru hapus lama"
// (poin #6 spek) selalu terjaga di satu tempat.
async function resolveImagePatch(rawUrl, prefix, currentField, maxBytes, maxLabel) {
  const s = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const currentKey = currentField && currentField.key ? currentField.key : null;

  if (!s) {
    // Admin menghapus gambar (field url dikosongkan dari Admin Web).
    return { fields: { url: '', key: null, mimeType: '', fileSize: 0 }, deleteOldKey: currentKey };
  }
  if (s.startsWith('data:')) {
    // Upload baru dari Admin Web (FileReader -> base64 data URI) — validasi
    // ketat MIME/ukuran DULU (sama seperti sebelumnya, lempar Error kalau
    // invalid), BARU upload buffer-nya ke R2. Kalau upload gagal (network/
    // credential R2), Error dilempar ke atas dan updateConfig() TIDAK PERNAH
    // menyentuh database — background/logo lama tetap utuh.
    validateUploadedImageUrl(s, maxBytes, maxLabel);
    const uploaded = await r2Storage.uploadDataUri(s, prefix);
    return {
      fields: { url: uploaded.url, key: uploaded.key, mimeType: uploaded.mimeType, fileSize: uploaded.size },
      deleteOldKey: (currentKey && currentKey !== uploaded.key) ? currentKey : null
    };
  }
  if (/^https?:\/\//i.test(s)) {
    // Admin mengisi Image URL eksternal langsung (mode "url", bukan upload)
    // — tidak ada file baru yang perlu diupload ke R2. Kalau sebelumnya ada
    // gambar hasil upload R2, object itu sudah tidak dipakai lagi -> aman
    // dihapus setelah config baru tersimpan.
    return { fields: { url: s, key: null, mimeType: '', fileSize: 0 }, deleteOldKey: currentKey };
  }
  throw new Error('Image URL tidak valid. Gunakan link http(s):// atau upload file.');
}

module.exports = function createAppCustomizationManager({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  function mergeDefaults(doc) {
    const d = doc || {};
    const bg = d.background || {};
    const grad = bg.gradient || {};
    const img = bg.image || {};
    const overlay = bg.overlay || {};
    const branding = d.branding || {};
    const logo = branding.logo || {};
    const text = branding.text || {};

    const stopsRaw = Array.isArray(grad.stops) && grad.stops.length >= 2 ? grad.stops : DEFAULTS.background.gradient.stops;
    const stops = stopsRaw.slice(0, 3).map((s, i) => ({
      color: sanitizeColor(s?.color, DEFAULTS.background.gradient.stops[Math.min(i, 1)].color),
      pos: clampInt(s?.pos, 0, 100, i === 0 ? 0 : 100)
    }));

    return {
      _id: SETTINGS_ID,
      background: {
        mode: ['solid', 'gradient', 'image'].includes(bg.mode) ? bg.mode : DEFAULTS.background.mode,
        color: sanitizeColor(bg.color, DEFAULTS.background.color),
        gradient: {
          type: grad.type === 'radial' ? 'radial' : 'linear',
          angle: clampInt(grad.angle, 0, 360, DEFAULTS.background.gradient.angle),
          stops
        },
        image: {
          // source cuma dipakai Admin Web (tombol Upload Image / Image URL
          // tetap sinkron dengan mode terakhir dipakai) — kalau tidak
          // dikirim/tidak valid, ditebak dari bentuk url (http(s):// -> url,
          // selain itu -> upload), bukan sistem baru, cuma metadata kecil.
          source: ['upload', 'url'].includes(img.source)
            ? img.source
            : (/^https?:\/\//i.test(String(img.url || '')) ? 'url' : DEFAULTS.background.image.source),
          url: sanitizeImageUrl(img.url),
          key: (typeof img.key === 'string' && img.key) ? img.key : null,
          mimeType: typeof img.mimeType === 'string' ? img.mimeType : '',
          fileSize: Number.isFinite(Number(img.fileSize)) ? Number(img.fileSize) : 0,
          fit: ['cover', 'contain', 'fill'].includes(img.fit) ? img.fit : DEFAULTS.background.image.fit,
          position: ['center', 'top', 'bottom', 'left', 'right'].includes(img.position) ? img.position : DEFAULTS.background.image.position,
          opacity: clamp01(img.opacity, 1),
          blur: clampInt(img.blur, 0, 20, 0)
        },
        overlay: {
          enabled: !!overlay.enabled,
          color: sanitizeColor(overlay.color, DEFAULTS.background.overlay.color),
          opacity: clamp01(overlay.opacity, DEFAULTS.background.overlay.opacity)
        }
      },
      branding: {
        logo: {
          enabled: !!logo.enabled,
          url: sanitizeImageUrl(logo.url),
          key: (typeof logo.key === 'string' && logo.key) ? logo.key : null,
          mimeType: typeof logo.mimeType === 'string' ? logo.mimeType : '',
          fileSize: Number.isFinite(Number(logo.fileSize)) ? Number(logo.fileSize) : 0,
          size: clampInt(logo.size, 14, 48, DEFAULTS.branding.logo.size),
          opacity: clamp01(logo.opacity, 1)
        },
        text: {
          enabled: text.enabled !== false,
          value: (typeof text.value === 'string' && text.value.trim()) ? text.value.trim().slice(0, 40) : DEFAULTS.branding.text.value,
          fontFamily: FONT_IDS.includes(text.fontFamily) ? text.fontFamily : DEFAULTS.branding.text.fontFamily,
          fontSize: clampInt(text.fontSize, 12, 28, DEFAULTS.branding.text.fontSize),
          fontWeight: FONT_WEIGHTS.includes(Number(text.fontWeight)) ? Number(text.fontWeight) : DEFAULTS.branding.text.fontWeight
        }
      },
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

  // Payload yang dikirim ke App (public, tidak perlu updatedBy) — SAMA
  // persis dengan struktur config (tidak ada rahasia di sini), cuma
  // dipisah namanya supaya jelas mana yang "boleh dikirim ke client".
  function toPublicPayload(cfg) {
    return {
      background: cfg.background,
      branding: cfg.branding,
      version: cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0
    };
  }

  async function updateConfig(patch, updatedBy) {
    const database = db();
    const current = await getConfig();

    // ── Resolve gambar (background image & logo) ke Cloudflare R2 SEBELUM
    // apa pun disimpan ke MongoDB. resolveImagePatch() sudah menjalankan
    // validasi ketat (MIME whitelist + limit ukuran, sama seperti
    // sebelumnya) DULU, baru upload — jadi kalau invalid ATAU upload ke R2
    // gagal, Error dilempar di sini dan seluruh fungsi berhenti sebelum
    // baris database manapun tersentuh (background/logo lama tetap utuh,
    // poin #6/#12 spek). Kalau field url tidak dikirim (undefined), berarti
    // Admin cuma ganti field lain (fit/opacity/dll) — tidak disentuh.
    let bgImagePatch = null, bgDeleteKey = null;
    if (patch.background && patch.background.image && typeof patch.background.image.url === 'string') {
      const resolved = await resolveImagePatch(
        patch.background.image.url, 'app-customization/background',
        current.background.image, MAX_IMAGE_BYTES, '10 MB'
      );
      bgImagePatch = resolved.fields;
      bgDeleteKey = resolved.deleteOldKey;
    }
    let logoPatch = null, logoDeleteKey = null;
    if (patch.branding && patch.branding.logo && typeof patch.branding.logo.url === 'string') {
      const resolved = await resolveImagePatch(
        patch.branding.logo.url, 'app-customization/logo',
        current.branding.logo, LOGO_MAX_BYTES, '5 MB'
      );
      logoPatch = resolved.fields;
      logoDeleteKey = resolved.deleteOldKey;
    }

    const next = mergeDefaults({
      background: { ...current.background, ...(patch.background || {}) },
      branding: { ...current.branding, ...(patch.branding || {}) }
    });
    // Merge dangkal nested object (background.image/gradient/overlay,
    // branding.logo/text) supaya PATCH parsial (Admin cuma ganti 1 bagian,
    // mis. cuma opacity image) tidak menghapus field lain yang tidak dikirim.
    // bgImagePatch/logoPatch (hasil upload R2, kalau ada) di-spread PALING
    // AKHIR supaya url/key/mimeType/fileSize yang tersimpan selalu yang R2
    // baru, bukan data URI mentah dari patch asli.
    if (patch.background) {
      next.background = mergeDefaults({
        background: {
          mode: patch.background.mode ?? current.background.mode,
          color: patch.background.color ?? current.background.color,
          gradient: { ...current.background.gradient, ...(patch.background.gradient || {}) },
          image: { ...current.background.image, ...(patch.background.image || {}), ...(bgImagePatch || {}) },
          overlay: { ...current.background.overlay, ...(patch.background.overlay || {}) }
        }
      }).background;
    }
    if (patch.branding) {
      next.branding = mergeDefaults({
        branding: {
          logo: { ...current.branding.logo, ...(patch.branding.logo || {}), ...(logoPatch || {}) },
          text: { ...current.branding.text, ...(patch.branding.text || {}) }
        }
      }).branding;
    }
    next.updatedAt = new Date();
    next.updatedBy = updatedBy || 'Admin';

    if (database) {
      await database.collection('settings').updateOne(
        { _id: SETTINGS_ID },
        { $set: next },
        { upsert: true }
      );
    }

    // Baru hapus object R2 LAMA setelah config baru berhasil tersimpan di
    // MongoDB — kalau updateOne() di atas gagal (exception), baris di bawah
    // ini tidak pernah tereksekusi, jadi object lama tidak ikut terhapus.
    // Best-effort (tidak pernah throw, lihat r2Storage.deleteObject) supaya
    // kegagalan cleanup tidak membuat Save yang sudah sukses balik gagal.
    if (bgDeleteKey) r2Storage.deleteObject(bgDeleteKey).catch(() => {});
    if (logoDeleteKey) r2Storage.deleteObject(logoDeleteKey).catch(() => {});

    return next;
  }

  // ── PERF (halaman App Customization di Admin Web lambat dibuka/disimpan)
  // ────────────────────────────────────────────────────────────────────
  // PENYEBAB UTAMA yang ditemukan saat audit: background.image.url dan
  // branding.logo.url disimpan sebagai data URI base64 LANGSUNG di dokumen
  // config (sampai ~13MB & ~6.7MB base64 dari batas 10MB/5MB) — dan
  // SEBELUM optimasi ini, base64 itu ikut utuh di body JSON setiap kali
  // GET /api/admin/app-customization dipanggil (tiap halaman dibuka) DAN
  // setiap kali PUT (Save) dikirim, walau admin cuma ganti warna/slider
  // lain. Untuk koneksi/hosting yang tidak kencang, transfer ~15-20MB
  // bolak-balik itulah yang bikin buka halaman & Save terasa 1-2 menit.
  //
  // toAdminPayload() TIDAK mengubah apa yang tersimpan di database sama
  // sekali (getConfig()/updateConfig() tetap apa adanya, source of truth
  // tetap DB) — cuma dipakai di lapisan HTTP response (server.js, endpoint
  // admin) untuk MENGGANTI isi field url yang berupa data URI base64 berat
  // dengan path endpoint ringan (/api/app-customization/background-image
  // atau /api/app-customization/logo, lihat server.js) yang isinya SAMA
  // PERSIS gambarnya, tinggal di-load browser lewat <img>/CSS url() secara
  // terpisah & paralel (tidak mem-block parsing JSON config, dan otomatis
  // ikut HTTP cache browser). url yang SUDAH berupa http(s) biasa (mode
  // "Image URL", bukan upload) dibiarkan apa adanya karena sudah ringan.
  //
  // Admin Web (admin.js) di sisi Save juga sudah diubah supaya TIDAK
  // mengirim ulang field url ini kalau admin tidak benar-benar
  // upload/ganti gambar baru (lihat _aczImageTouched/_aczLogoTouched) —
  // dua perubahan ini (load ringan + save parsial) yang menghilangkan
  // bottleneck utamanya, tanpa mengubah struktur database/skema config
  // sama sekali.
  function isHeavyDataUri(v) {
    return typeof v === 'string' && v.startsWith('data:');
  }
  // Dipakai HANYA di toAdminPayload() (admin-only, tidak pernah dikirim ke
  // App/public) — supaya Admin Web bisa menampilkan badge "Migrasi ke R2
  // pending" pada gambar lama yang belum dipindah r2Storage (lihat
  // migrate-images-to-r2.js) tanpa perlu menebak dari bentuk URL sendiri.
  //   'r2'       -> sudah tersimpan di R2 (image.key ada)
  //   'legacy'   -> MASIH base64 di MongoDB, belum dimigrasi
  //   'external' -> URL http(s) eksternal (bukan upload, bukan R2)
  //   'none'     -> tidak ada gambar
  function imageStorageStatus(imgField) {
    if (!imgField || !imgField.url) return 'none';
    if (imgField.key) return 'r2';
    if (isHeavyDataUri(imgField.url)) return 'legacy';
    return 'external';
  }
  function toAdminPayload(cfg) {
    const version = cfg.updatedAt ? new Date(cfg.updatedAt).getTime() : 0;
    const out = {
      background: { ...cfg.background, image: { ...cfg.background.image } },
      branding: { ...cfg.branding, logo: { ...cfg.branding.logo } },
      updatedAt: cfg.updatedAt,
      updatedBy: cfg.updatedBy
    };
    // Dihitung SEBELUM url diganti path endpoint ringan di bawah (supaya
    // deteksi 'legacy' masih bisa melihat data URI aslinya).
    out.background.image.storageStatus = imageStorageStatus(cfg.background.image);
    out.branding.logo.storageStatus = imageStorageStatus(cfg.branding.logo);
    if (isHeavyDataUri(out.background.image.url)) {
      out.background.image.url = `/api/app-customization/background-image?v=${version}`;
    }
    if (isHeavyDataUri(out.branding.logo.url)) {
      out.branding.logo.url = `/api/app-customization/logo?v=${version}`;
    }
    return out;
  }

  // Dipanggil setelah save berhasil — push realtime ke SEMUA App yang
  // sedang online & login (wsBroadcastAll SUDAH ADA di server.js, dipakai
  // bersama fitur lain seperti games:update/bypasses:update). TIDAK ada
  // WebSocket/koneksi baru yang dibuat di sini.
  //
  // FIX (background Image tidak ter-apply di App): sebelumnya di sini
  // broadcast PAYLOAD PENUH lewat WS, termasuk background.image.url /
  // branding.logo.url yang berupa data URI base64 — bisa beberapa MB.
  // Pesan WS sebesar itu rawan gagal terkirim utuh (kepotong di proxy/
  // hosting, dsb), dan di App (app.js) JSON.parse yang gagal cuma
  // `return` diam-diam tanpa log — jadi App diam-diam TETAP pakai
  // background lama, sedangkan branding.text (payload kecil) selalu
  // berhasil. Sekarang ikut pola yang SUDAH ADA di project ini (lihat
  // steamAccounts:products:update / marketplace:products:update di
  // server.js): broadcast SINYAL RINGAN saja, App fetch ulang config
  // lengkap lewat REST /api/app-customization (endpoint yang SUDAH ADA,
  // tidak dibuat baru) — payload besar tidak pernah lewat WS lagi.
  async function broadcastUpdate() {
    const cfg = await getConfig();
    const payload = toPublicPayload(cfg);
    wsBroadcastAll('app-customization:update', { changed: true, version: payload.version });
    return payload;
  }

  return { getConfig, updateConfig, toPublicPayload, toAdminPayload, broadcastUpdate, DEFAULTS, FONT_WHITELIST };
};