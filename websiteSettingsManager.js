// ══════════════════════════════════════════════════════════════════════════
// WEBSITE SETTINGS MANAGER — pengaturan Landing Page (Netlify) yang diatur
// dari halaman "Website Settings" di Admin Web: Hero, Banner, Discord, FAQ,
// System Requirements, Versi Website, dan mode Statistik (auto/manual).
//
// Disimpan di collection `settings` (_id: 'websiteSettings') — SATU dokumen,
// dibaca ulang dari DB tiap kali dibutuhkan (tanpa cache di memori), persis
// pola appUpdateManager.js/packageManager.js di project ini, supaya
// perubahan dari Admin Web langsung tampil realtime di website tanpa perlu
// redeploy.
//
// Info Download EXE (versi, changelog, ukuran file, link installer) SENGAJA
// TIDAK diduplikasi di sini — itu sudah dikelola appUpdateManager.js (halaman
// "App Update" Admin Web) dan dipakai bersama oleh App & Website supaya satu
// sumber data yang sama (single source of truth).
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS_ID = 'websiteSettings';

const DEFAULTS = {
  _id: SETTINGS_ID,
  heroTitle: '31 Tools',
  heroSubtitle: 'Satu aplikasi untuk akses ribuan game & bypass premium — cepat, aman, dan selalu update.',
  heroBannerUrl: '',
  logoUrl: '',
  discordInviteUrl: '',       // kosong = fallback ke env DISCORD_INVITE_URL
  discordCommunityText: 'Gabung ke komunitas Discord kami untuk update terbaru, request game, dan dukungan langsung dari admin & sesama member.',
  systemRequirements: [
    'OS: Windows 10/11 64-bit',
    'Processor: Intel Core i3 atau setara',
    'Memory: 4 GB RAM',
    'Storage: 2 GB ruang kosong',
    'Internet: Koneksi stabil untuk login & download'
  ],
  faq: [], // [{ id, question, answer, order }]
  websiteVersion: '1.0.0',
  statsMode: 'auto', // 'auto' = hitung dari DB, 'manual' = pakai manualStats
  manualStats: { totalGames: 0, totalUsers: 0, totalDownloads: 0 },
  updatedAt: null,
  updatedBy: null
};

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = function createWebsiteSettingsManager({ getDb }) {
  const db = () => getDb();

  async function getSettings() {
    const database = db();
    if (!database) return JSON.parse(JSON.stringify(DEFAULTS));
    const doc = await database.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) return JSON.parse(JSON.stringify(DEFAULTS));
    // Merge dangkal biar field baru yang belum pernah disimpan tetap ada defaultnya.
    return {
      ...DEFAULTS,
      ...doc,
      manualStats: { ...DEFAULTS.manualStats, ...(doc.manualStats || {}) },
      systemRequirements: Array.isArray(doc.systemRequirements) ? doc.systemRequirements : DEFAULTS.systemRequirements,
      faq: Array.isArray(doc.faq) ? doc.faq : []
    };
  }

  // Payload publik dipakai landing page — tidak perlu updatedBy.
  function toPublicPayload(cfg) {
    return {
      heroTitle: cfg.heroTitle || DEFAULTS.heroTitle,
      heroSubtitle: cfg.heroSubtitle || DEFAULTS.heroSubtitle,
      heroBannerUrl: cfg.heroBannerUrl || '',
      logoUrl: cfg.logoUrl || '',
      discordInviteUrl: cfg.discordInviteUrl || process.env.DISCORD_INVITE_URL || '',
      discordCommunityText: cfg.discordCommunityText || DEFAULTS.discordCommunityText,
      systemRequirements: cfg.systemRequirements || [],
      websiteVersion: cfg.websiteVersion || DEFAULTS.websiteVersion
    };
  }

  function toPublicFaq(cfg) {
    return (cfg.faq || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(f => ({ id: f.id, question: f.question, answer: f.answer }));
  }

  async function getPublicStats({ gamesCount, usersCount, downloadsCount }) {
    const cfg = await getSettings();
    if (cfg.statsMode === 'manual') {
      return {
        totalGames: Number(cfg.manualStats.totalGames) || 0,
        totalUsers: Number(cfg.manualStats.totalUsers) || 0,
        totalDownloads: Number(cfg.manualStats.totalDownloads) || 0
      };
    }
    return {
      totalGames: gamesCount || 0,
      totalUsers: usersCount || 0,
      totalDownloads: downloadsCount || 0
    };
  }

  function normalizeFaqInput(faq) {
    if (!Array.isArray(faq)) throw new Error('FAQ harus berupa daftar.');
    return faq.map((f, i) => ({
      id: f.id || genId(),
      question: String(f.question || '').trim().slice(0, 200),
      answer: String(f.answer || '').trim().slice(0, 2000),
      order: Number.isFinite(f.order) ? f.order : i
    })).filter(f => f.question && f.answer);
  }

  async function updateSettings(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getSettings();
    const next = { ...current };

    if (typeof patch.heroTitle === 'string') next.heroTitle = patch.heroTitle.trim().slice(0, 120);
    if (typeof patch.heroSubtitle === 'string') next.heroSubtitle = patch.heroSubtitle.trim().slice(0, 300);
    if (typeof patch.heroBannerUrl === 'string') next.heroBannerUrl = patch.heroBannerUrl.trim();
    if (typeof patch.logoUrl === 'string') next.logoUrl = patch.logoUrl.trim();
    if (typeof patch.discordInviteUrl === 'string') next.discordInviteUrl = patch.discordInviteUrl.trim();
    if (typeof patch.discordCommunityText === 'string') next.discordCommunityText = patch.discordCommunityText.trim().slice(0, 500);
    if (typeof patch.websiteVersion === 'string' && patch.websiteVersion.trim()) next.websiteVersion = patch.websiteVersion.trim();

    if (Array.isArray(patch.systemRequirements)) {
      next.systemRequirements = patch.systemRequirements.map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
    }

    if (Array.isArray(patch.faq)) {
      next.faq = normalizeFaqInput(patch.faq);
    }

    if (patch.statsMode === 'auto' || patch.statsMode === 'manual') next.statsMode = patch.statsMode;
    if (patch.manualStats && typeof patch.manualStats === 'object') {
      next.manualStats = {
        totalGames: Math.max(0, Number(patch.manualStats.totalGames) || 0),
        totalUsers: Math.max(0, Number(patch.manualStats.totalUsers) || 0),
        totalDownloads: Math.max(0, Number(patch.manualStats.totalDownloads) || 0)
      };
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

  return {
    SETTINGS_ID,
    getSettings,
    updateSettings,
    toPublicPayload,
    toPublicFaq,
    getPublicStats
  };
};
