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

const SETTINGS_ID = 'appCustomization';

// ── BACKGROUND IMAGE — upload/URL validation ────────────────────────────
// Dipakai oleh validateBackgroundImageUrl() di bawah. Limit & whitelist
// MIME ini SAMA yang dipakai frontend (aczImageFile di admin.js) —
// divalidasi ulang di sini karena frontend bisa di-bypass (edit request
// manual/curl langsung ke PUT /api/admin/app-customization).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — request user: 10MB, bukan 4MB/10KB
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
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s) return; // kosong = hapus image, valid

  if (s.startsWith('data:')) {
    // Upload — base64 data URI dari FileReader.readAsDataURL() (admin.js).
    const mime = dataUriMime(s);
    if (!IMAGE_MIME_WHITELIST.includes(mime)) {
      throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.');
    }
    if (dataUriByteSize(s) > MAX_IMAGE_BYTES) {
      throw new Error('Ukuran gambar maksimal 10 MB.');
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
    // Validasi KETAT (throw kalau invalid) untuk Background Image BARU yang
    // dikirim Admin — 10MB/MIME whitelist. Dicek di sini (SEBELUM merge &
    // simpan), bukan di dalam mergeDefaults(), supaya jalur GET/getConfig()
    // baca doc lama tetap aman apapun isinya (lihat komentar
    // validateBackgroundImageUrl di atas). Kalau patch.background.image.url
    // tidak dikirim (undefined) sama sekali, berarti Admin cuma ganti
    // field lain (fit/position/opacity/dll) — TIDAK divalidasi ulang.
    if (patch.background && patch.background.image && typeof patch.background.image.url === 'string') {
      validateBackgroundImageUrl(patch.background.image.url);
    }

    const database = db();
    const current = await getConfig();
    const next = mergeDefaults({
      background: { ...current.background, ...(patch.background || {}) },
      branding: { ...current.branding, ...(patch.branding || {}) }
    });
    // Merge dangkal nested object (background.image/gradient/overlay,
    // branding.logo/text) supaya PATCH parsial (Admin cuma ganti 1 bagian,
    // mis. cuma opacity image) tidak menghapus field lain yang tidak dikirim.
    if (patch.background) {
      next.background = mergeDefaults({
        background: {
          mode: patch.background.mode ?? current.background.mode,
          color: patch.background.color ?? current.background.color,
          gradient: { ...current.background.gradient, ...(patch.background.gradient || {}) },
          image: { ...current.background.image, ...(patch.background.image || {}) },
          overlay: { ...current.background.overlay, ...(patch.background.overlay || {}) }
        }
      }).background;
    }
    if (patch.branding) {
      next.branding = mergeDefaults({
        branding: {
          logo: { ...current.branding.logo, ...(patch.branding.logo || {}) },
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
    return next;
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

  return { getConfig, updateConfig, toPublicPayload, broadcastUpdate, DEFAULTS, FONT_WHITELIST };
};
