// ══════════════════════════════════════════════════════════════════════════
// MAINTENANCE MODE MANAGER — kunci seluruh App saat sedang maintenance
// ══════════════════════════════════════════════════════════════════════════
// Satu dokumen konfigurasi disimpan di collection `settings` (_id tetap),
// pola yang sama dengan appUpdateManager.js supaya konsisten dengan modul lain
// di project ini.
//
// Alur:
//   - Admin Web mengatur aktif/nonaktif, judul, deskripsi, pesan tambahan,
//     banner, estimasi selesai, dan whitelist Discord ID lewat
//     GET/PUT /api/admin/maintenance.
//   - App (Electron) memanggil GET /api/maintenance-status (endpoint PUBLIK,
//     tanpa wajib login — soalnya maintenance harus bisa mengunci App bahkan
//     SEBELUM user sempat login) setiap kali dibuka. Kalau App punya token
//     tersimpan (user pernah login sebelumnya), token itu ikut dikirim lewat
//     header Authorization supaya server bisa cek apakah discordId user
//     tersebut masuk whitelist / role-nya admin (yang otomatis selalu bypass).
//   - Perubahan disiarkan REALTIME ke semua App yang sedang online & login
//     lewat WebSocket (event `maintenance:config`) — payload dikirim PER USER
//     (bukan broadcast identik ke semua orang), karena status "bypass"
//     tergantung whitelist/role masing-masing user. Lihat broadcastToClients().
// ══════════════════════════════════════════════════════════════════════════

const MAINTENANCE_SETTINGS_ID = 'maintenanceConfig';

const DEFAULT_CONFIG = {
  _id: MAINTENANCE_SETTINGS_ID,
  enabled: false,
  title: 'Sedang Maintenance',
  description: 'Aplikasi sedang dalam perbaikan untuk meningkatkan layanan.',
  message: 'Mohon maaf atas ketidaknyamanannya. Silakan coba lagi beberapa saat lagi.',
  bannerUrl: '',
  estimatedCompletion: '', // ISO datetime string (opsional) — kalau kosong, tidak ditampilkan
  whitelist: [],           // [{ discordId, note }]
  updatedAt: null,
  updatedBy: null
};

module.exports = function maintenanceManagerFactory({ getDb, wsClients, wsSendToUser }) {
  const db = () => getDb();

  async function getConfig() {
    const database = db();
    if (!database) return { ...DEFAULT_CONFIG };
    let doc = await database.collection('settings').findOne({ _id: MAINTENANCE_SETTINGS_ID });
    if (!doc) {
      doc = { ...DEFAULT_CONFIG };
      await database.collection('settings').updateOne(
        { _id: MAINTENANCE_SETTINGS_ID },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }
    return { ...DEFAULT_CONFIG, ...doc };
  }

  // Admin (role 'admin') SELALU bypass otomatis tanpa perlu didaftarkan di
  // whitelist — sesuai permintaan "Whitelist User (Admin tetap bisa masuk)".
  // Whitelist tambahan dipakai untuk developer/tester lain yang bukan admin.
  function computeBypass(cfg, discordId, role) {
    if (role === 'admin') return true;
    if (!discordId) return false;
    return (cfg.whitelist || []).some(w => w.discordId === discordId);
  }

  // Payload yang dikirim ke APP (publik) — whitelist TIDAK ikut disertakan
  // (supaya daftar Discord ID user lain tidak bocor ke client), cuma hasil
  // akhir `bypass` untuk user yang sedang cek.
  function toPublicPayload(cfg, bypass) {
    return {
      enabled: !!cfg.enabled,
      title: cfg.title || DEFAULT_CONFIG.title,
      description: cfg.description || '',
      message: cfg.message || '',
      bannerUrl: cfg.bannerUrl || '',
      estimatedCompletion: cfg.estimatedCompletion || '',
      bypass: !!bypass
    };
  }

  async function updateConfig(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.title === 'string') next.title = patch.title.trim() || DEFAULT_CONFIG.title;
    if (typeof patch.description === 'string') next.description = patch.description;
    if (typeof patch.message === 'string') next.message = patch.message;
    if (typeof patch.bannerUrl === 'string') next.bannerUrl = patch.bannerUrl.trim();
    if (typeof patch.estimatedCompletion === 'string') next.estimatedCompletion = patch.estimatedCompletion.trim();

    if (Array.isArray(patch.whitelist)) {
      next.whitelist = patch.whitelist
        .map(w => ({ discordId: String(w.discordId || '').trim(), note: String(w.note || '').trim() }))
        .filter(w => w.discordId);
    }

    next.updatedAt = new Date().toISOString();
    next.updatedBy = adminName || 'Admin';

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: MAINTENANCE_SETTINGS_ID },
      { $set: setFields },
      { upsert: true }
    );

    return next;
  }

  // Siarkan realtime ke SEMUA client App yang sedang online & login. Beda
  // dengan wsBroadcastAll biasa (kirim payload identik ke semua orang) —
  // di sini payload dihitung PER USER karena status `bypass` tergantung
  // whitelist/role masing-masing. Query role user connected dilakukan sekali
  // (batch, bukan satu-satu) supaya tetap ringan walau banyak user online.
  async function broadcastToClients() {
    const database = db();
    if (!database || !wsClients) return;
    const cfg = await getConfig();
    const discordIds = Array.from(wsClients.keys());
    if (!discordIds.length) return;

    let roleMap = new Map();
    try {
      const users = await database.collection('users').find(
        { discordId: { $in: discordIds } },
        { projection: { discordId: 1, role: 1 } }
      ).toArray();
      roleMap = new Map(users.map(u => [u.discordId, u.role]));
    } catch (e) { /* best-effort — kalau query gagal, semua dianggap tidak bypass */ }

    for (const discordId of discordIds) {
      const bypass = computeBypass(cfg, discordId, roleMap.get(discordId));
      try { wsSendToUser(discordId, 'maintenance:config', toPublicPayload(cfg, bypass)); } catch (e) { /* noop */ }
    }
  }

  return {
    MAINTENANCE_SETTINGS_ID,
    getConfig,
    updateConfig,
    computeBypass,
    toPublicPayload,
    broadcastToClients
  };
};
