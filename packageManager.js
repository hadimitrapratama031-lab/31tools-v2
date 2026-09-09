// ══════════════════════════════════════════════════════════════════════════
// PACKAGE MANAGER — pengaturan paket Public/Gold/Platinum (harga, masa aktif,
// benefit, limit download Game & Bypass, aktif/nonaktif, badge) yang diatur
// dari halaman "Upgrade Paket" di Admin Web dan dibaca oleh App (menu Upgrade
// Paket) + oleh server.js buat hitung limit download harian user (menggantikan
// konstanta DOWNLOAD_LIMITS yang tadinya di-hardcode).
//
// Disimpan di collection `settings` (_id: 'packages') — SATU dokumen, dibaca
// ulang dari DB tiap kali dibutuhkan (tanpa cache di memori) supaya perubahan
// dari Admin Web langsung berlaku (realtime, tanpa restart), sama seperti pola
// webhookManager.js/voucherManager.js di project ini.
//
// Cara pakai dari server.js:
//   const packageManager = require('./packageManager')({ getDb: () => db });
//   const packages = await packageManager.getPackages();
//   const limits   = await packageManager.getDownloadLimits(); // buat consumeDownloadQuota
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS_ID = 'packages';
const DURATION_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const DURATION_UNIT_LABEL = { minutes: 'Menit', hours: 'Jam', days: 'Hari' };

const DEFAULTS = {
  _id: SETTINGS_ID,
  public: {
    description: 'Akses gratis dengan limit download harian terbatas.',
    benefits: ['Akses Game & Bypass dasar', 'Limit download harian terbatas', 'Update game & tutorial gratis'],
    gameLimit: 3,
    bypassLimit: 3
  },
  gold: {
    price: 25000,
    durationAmount: 30,
    durationUnit: 'days',
    description: 'Buat kamu yang mau download game & bypass lebih leluasa tiap hari.',
    benefits: [
      'Download Game hingga 4x per hari',
      'Download Bypass hingga 4x per hari',
      'Akses konten & tutorial khusus Gold',
      'Prioritas antrian download lebih cepat',
      'Badge role Gold di Discord'
    ],
    gameLimit: 4,
    bypassLimit: 4,
    active: true,
    badge: ''
  },
  platinum: {
    price: 50000,
    durationAmount: 30,
    durationUnit: 'days',
    description: 'Paket paling lengkap — download sepuasnya tanpa batas harian.',
    benefits: [
      'Download Game TANPA BATAS',
      'Download Bypass TANPA BATAS',
      'Akses seluruh konten & tutorial Platinum',
      'Prioritas antrian download tercepat',
      'Badge role Platinum di Discord',
      'Dukungan prioritas dari Admin'
    ],
    gameLimit: null, // null = unlimited
    bypassLimit: null,
    active: true,
    badge: 'Best Value'
  },
  updatedAt: null
};

module.exports = function createPackageManager({ getDb }) {

  async function ensureIndexes() { /* settings pakai _id custom, tidak perlu index tambahan */ }

  function normalizeTierInput(tier, input = {}, { partial = false } = {}) {
    const out = {};
    const isPaid = tier === 'gold' || tier === 'platinum';

    if (isPaid) {
      if (input.price !== undefined || !partial) {
        const price = Number(input.price);
        if (!Number.isFinite(price) || price < 0) throw new Error(`Harga paket ${tier} tidak valid.`);
        out.price = Math.round(price);
      }
      if (input.durationAmount !== undefined || input.durationUnit !== undefined || !partial) {
        const unit = input.durationUnit !== undefined ? input.durationUnit : (partial ? undefined : 'days');
        if (unit !== undefined) {
          if (!DURATION_UNIT_MS.hasOwnProperty(unit)) throw new Error(`Satuan masa aktif paket ${tier} tidak valid.`);
          out.durationUnit = unit;
        }
        if (input.durationAmount !== undefined || !partial) {
          const amount = Number(input.durationAmount);
          if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Masa aktif paket ${tier} harus lebih dari 0.`);
          out.durationAmount = amount;
        }
      }
      if (input.active !== undefined) out.active = !!input.active;
      else if (!partial) out.active = true;
      if (input.badge !== undefined) out.badge = String(input.badge || '').slice(0, 40);
      else if (!partial) out.badge = '';
    }

    if (input.benefits !== undefined) {
      if (!Array.isArray(input.benefits)) throw new Error(`Benefit paket ${tier} harus berupa daftar.`);
      out.benefits = input.benefits.map(b => String(b || '').trim()).filter(Boolean).slice(0, 30);
    } else if (!partial) {
      out.benefits = [];
    }

    if (input.description !== undefined) {
      out.description = String(input.description || '').trim().slice(0, 200);
    } else if (!partial) {
      out.description = '';
    }

    for (const key of ['gameLimit', 'bypassLimit']) {
      if (input[key] !== undefined) {
        const raw = input[key];
        if (raw === null || raw === '' || raw === 'unlimited') {
          out[key] = null; // unlimited
        } else {
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
            throw new Error(`${key === 'gameLimit' ? 'Limit Game' : 'Limit Bypass'} paket ${tier} tidak valid.`);
          }
          out[key] = num;
        }
      } else if (!partial) {
        out[key] = null;
      }
    }

    return out;
  }

  async function getPackages() {
    const db = getDb();
    if (!db) return JSON.parse(JSON.stringify(DEFAULTS));
    const doc = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) return JSON.parse(JSON.stringify(DEFAULTS));
    // Merge dangkal per tier biar field baru yang belum pernah disimpan tetap ada defaultnya
    // (mis. server baru di-update tapi dokumen settings lama belum punya field itu).
    return {
      _id: SETTINGS_ID,
      public: { ...DEFAULTS.public, ...(doc.public || {}) },
      gold: { ...DEFAULTS.gold, ...(doc.gold || {}) },
      platinum: { ...DEFAULTS.platinum, ...(doc.platinum || {}) },
      updatedAt: doc.updatedAt || null
    };
  }

  async function updateTier(tier, input) {
    if (!['public', 'gold', 'platinum'].includes(tier)) throw new Error('Paket tidak dikenal.');
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const normalized = normalizeTierInput(tier, input, { partial: true });
    const set = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(normalized)) set[`${tier}.${k}`] = v;
    await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
    return getPackages();
  }

  // Dipakai server.js buat ganti konstanta DOWNLOAD_LIMITS lama (yang tadinya
  // hardcode) — public/gold/platinum ambil dari Admin Web, admin (internal role)
  // tetap selalu unlimited dan tidak bisa diubah lewat sini.
  async function getDownloadLimits() {
    const pkgs = await getPackages();
    const toLimit = (v) => (v === null || v === undefined ? Infinity : v);
    return {
      public:   { game: toLimit(pkgs.public.gameLimit),   bypass: toLimit(pkgs.public.bypassLimit) },
      gold:     { game: toLimit(pkgs.gold.gameLimit),     bypass: toLimit(pkgs.gold.bypassLimit) },
      platinum: { game: toLimit(pkgs.platinum.gameLimit), bypass: toLimit(pkgs.platinum.bypassLimit) },
      admin:    { game: Infinity, bypass: Infinity }
    };
  }

  // Ringkasan buat ditampilkan ke App (menu Upgrade Paket) — harga & durasi
  // paid tier SELALU ikut Admin Web, tidak pernah di-hardcode di sisi App.
  function tierPublic(tier, data) {
    const base = {
      tier,
      description: data.description || '',
      benefits: data.benefits || [],
      limits: {
        game: data.gameLimit === null || data.gameLimit === undefined ? null : data.gameLimit,
        bypass: data.bypassLimit === null || data.bypassLimit === undefined ? null : data.bypassLimit
      }
    };
    if (tier === 'public') return base;
    return {
      ...base,
      price: data.price,
      durationAmount: data.durationAmount,
      durationUnit: data.durationUnit,
      durationLabel: `${data.durationAmount} ${DURATION_UNIT_LABEL[data.durationUnit] || ''}`,
      active: !!data.active,
      badge: data.badge || ''
    };
  }

  async function getPackagesPublic() {
    const pkgs = await getPackages();
    return {
      public: tierPublic('public', pkgs.public),
      gold: tierPublic('gold', pkgs.gold),
      platinum: tierPublic('platinum', pkgs.platinum),
      updatedAt: pkgs.updatedAt
    };
  }

  function durationMs(tierData) {
    return tierData.durationAmount * (DURATION_UNIT_MS[tierData.durationUnit] || 0);
  }

  return {
    SETTINGS_ID, DURATION_UNIT_MS, DURATION_UNIT_LABEL, DEFAULTS,
    ensureIndexes,
    getPackages, updateTier, getDownloadLimits, getPackagesPublic, durationMs
  };
};
