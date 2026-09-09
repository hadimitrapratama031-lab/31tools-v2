// ══════════════════════════════════════════════════════════════════════════
// WELCOME POPUP MANAGER — popup selamat datang otomatis untuk user baru
// ══════════════════════════════════════════════════════════════════════════
// Satu dokumen konfigurasi disimpan di collection `settings` (_id tetap),
// pola yang sama dengan websiteSettingsManager.js / maintenanceManager.js
// supaya konsisten dengan modul lain di project ini — dibaca ulang dari DB
// tiap kali dibutuhkan (tanpa cache di memori), jadi perubahan dari Admin
// Web langsung berlaku realtime tanpa perlu redeploy/restart App.
//
// Alur "hanya tampil 1x per akun":
//   - Tiap user (koleksi `users`) punya field `welcomePopupSeenVersion`.
//   - Config popup punya `version` (number, mulai dari 1).
//   - Popup ditampilkan ke user KALAU DAN HANYA KALAU: enabled === true DAN
//     user.welcomePopupSeenVersion !== config.version (termasuk saat field
//     itu belum pernah ada sama sekali di user, alias belum pernah lihat).
//   - Begitu user menutup popup (tombol "Mulai Sekarang" ATAU "Jangan
//     Tampilkan Lagi" — dua-duanya sama-sama menandai sudah dilihat),
//     App memanggil POST /api/welcome-popup/seen yang menyimpan
//     welcomePopupSeenVersion = version saat ini -> tidak muncul lagi.
//   - "Paksa tampil kembali ke seluruh user" di Admin Web = increment
//     `version`. Karena version berubah, SEMUA user (walau sudah pernah
//     menandai versi lama) otomatis dianggap "belum lihat" versi baru.
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS_ID = 'welcomePopupConfig';

const DEFAULT_ITEMS = [
  '🎮 Anda dapat menginstal seluruh Game Public secara gratis.',
  '📥 Akun Public memiliki limit 3x download setiap hari.',
  '📚 Setiap game telah dilengkapi video tutorial instalasi yang dapat diakses langsung di aplikasi.',
  '⭐ Anda dapat meng-upgrade ke Paket Gold atau Platinum untuk mendapatkan limit download lebih besar dan fitur tambahan.',
  '💬 Jika mengalami kendala, Anda dapat menghubungi tim support melalui Discord.'
];

const DEFAULTS = {
  _id: SETTINGS_ID,
  enabled: true,
  title: '👋 Selamat Datang di 31 Store!',
  description: 'Terima kasih telah bergabung. Berikut beberapa informasi yang perlu Anda ketahui:',
  bannerUrl: '',
  items: DEFAULT_ITEMS.slice(),
  primaryButtonText: 'Mulai Sekarang',
  secondaryButtonText: 'Jangan Tampilkan Lagi',
  version: 1,
  updatedAt: null,
  updatedBy: null
};

module.exports = function createWelcomePopupManager({ getDb }) {
  const db = () => getDb();

  async function getConfig() {
    const database = db();
    if (!database) return JSON.parse(JSON.stringify(DEFAULTS));
    let doc = await database.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) {
      doc = { ...DEFAULTS };
      await database.collection('settings').updateOne(
        { _id: SETTINGS_ID },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }
    return {
      ...DEFAULTS,
      ...doc,
      items: Array.isArray(doc.items) && doc.items.length ? doc.items : DEFAULT_ITEMS.slice()
    };
  }

  // Payload yang dikirim ke App — tidak perlu updatedAt/updatedBy.
  function toPublicPayload(cfg) {
    return {
      title: cfg.title || DEFAULTS.title,
      description: cfg.description || '',
      bannerUrl: cfg.bannerUrl || '',
      items: cfg.items || [],
      primaryButtonText: cfg.primaryButtonText || DEFAULTS.primaryButtonText,
      secondaryButtonText: cfg.secondaryButtonText || DEFAULTS.secondaryButtonText,
      version: cfg.version || 1
    };
  }

  async function updateConfig(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.title === 'string') next.title = patch.title.trim().slice(0, 150);
    if (typeof patch.description === 'string') next.description = patch.description.trim().slice(0, 500);
    if (typeof patch.bannerUrl === 'string') next.bannerUrl = patch.bannerUrl.trim();
    if (typeof patch.primaryButtonText === 'string' && patch.primaryButtonText.trim()) {
      next.primaryButtonText = patch.primaryButtonText.trim().slice(0, 40);
    }
    if (typeof patch.secondaryButtonText === 'string' && patch.secondaryButtonText.trim()) {
      next.secondaryButtonText = patch.secondaryButtonText.trim().slice(0, 40);
    }
    if (Array.isArray(patch.items)) {
      next.items = patch.items
        .map(s => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!next.items.length) next.items = DEFAULT_ITEMS.slice();
    }

    next.updatedAt = new Date().toISOString();
    next.updatedBy = adminName || 'Admin';

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: SETTINGS_ID },
      { $set: setFields },
      { upsert: true }
    );

    return next;
  }

  // "Paksa tampil kembali ke seluruh user" — increment version supaya SEMUA
  // user (termasuk yang sudah pernah menutup popup) dianggap belum lihat lagi.
  async function forceReshow(adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = {
      ...current,
      version: (Number(current.version) || 1) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: adminName || 'Admin'
    };

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: SETTINGS_ID },
      { $set: setFields },
      { upsert: true }
    );

    return next;
  }

  // Dipanggil GET /api/welcome-popup — menentukan apakah popup harus tampil
  // untuk user ini sekarang (dicek server-side, bukan cuma di App, supaya
  // tidak bisa "diakalin" dengan clear localStorage dsb).
  function shouldShow(cfg, user) {
    if (!cfg.enabled) return false;
    const seenVersion = user && user.welcomePopupSeenVersion;
    return seenVersion !== cfg.version;
  }

  return {
    SETTINGS_ID,
    getConfig,
    updateConfig,
    forceReshow,
    toPublicPayload,
    shouldShow
  };
};
