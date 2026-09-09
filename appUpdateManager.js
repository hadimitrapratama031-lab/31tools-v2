// ══════════════════════════════════════════════════════════════════════════
// APP UPDATE MANAGER — Auto Update & Force Update (sumber: GitHub Releases)
// ══════════════════════════════════════════════════════════════════════════
// Satu dokumen konfigurasi disimpan di collection `settings` (_id tetap,
// sama seperti pola AUTO_REMOVE_SETTINGS_ID / leaderboardWeek yang sudah ada
// di server.js) supaya konsisten dengan modul lain di project ini.
//
// Alur:
//   - Admin Web mengubah versi terbaru, link installer (GitHub Release),
//     changelog, dan toggle Auto Update / Force Update lewat
//     GET/PUT /api/admin/app-update.
//   - App (Electron) memanggil GET /api/app-update (endpoint PUBLIK, tanpa
//     login) setiap kali dibuka, membandingkan versi lokal (package.json)
//     dengan `latestVersion` dari DB, lalu menentukan apakah perlu
//     menampilkan halaman update / mengunci seluruh menu (force update).
//   - Perubahan disiarkan realtime ke semua client App yang sedang online
//     lewat WebSocket (event `app-update:config`) supaya kalau admin
//     mengaktifkan Force Update saat user sedang pakai app, app langsung
//     terkunci tanpa perlu dibuka ulang.
// ══════════════════════════════════════════════════════════════════════════

const APP_UPDATE_SETTINGS_ID = 'appUpdateConfig';

const DEFAULT_CONFIG = {
  _id: APP_UPDATE_SETTINGS_ID,
  autoUpdateEnabled: true,
  forceUpdateEnabled: false,
  latestVersion: '1.0.0',
  changelog: '',
  downloadUrl: '',       // link file installer (.exe) di GitHub Release
  releaseUrl: '',         // link halaman GitHub Release (opsional, buat "Lihat Detail")
  fileSize: 0,             // ukuran file dalam bytes (opsional, kalau diketahui)
  fileSizeLabel: '',       // label manual kalau admin mau isi sendiri, misal "58 MB"
  forceUpdateMessage: 'Versi aplikasi kamu sudah tidak didukung. Silakan update ke versi terbaru untuk melanjutkan.',
  history: [],             // riwayat versi (opsional): [{ version, changelog, downloadUrl, releasedAt }]
  updatedAt: null,
  updatedBy: null
};

// Membandingkan 2 versi semver sederhana ("1.2.10" vs "1.3.0", dst).
// Return: 1 kalau a > b, -1 kalau a < b, 0 kalau sama.
// Toleran terhadap prefix "v" (v1.2.3) dan segmen non-angka (di-treat 0).
function compareVersions(a, b) {
  const norm = (v) => String(v || '0').trim().replace(/^v/i, '').split(/[.\-+]/).map(s => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = norm(a), pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

module.exports = function appUpdateManagerFactory({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  async function getConfig() {
    const database = db();
    if (!database) return { ...DEFAULT_CONFIG };
    let doc = await database.collection('settings').findOne({ _id: APP_UPDATE_SETTINGS_ID });
    if (!doc) {
      doc = { ...DEFAULT_CONFIG };
      await database.collection('settings').updateOne(
        { _id: APP_UPDATE_SETTINGS_ID },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }
    return { ...DEFAULT_CONFIG, ...doc };
  }

  // Payload yang dikirim ke APP (publik) — tidak perlu field admin-only seperti `updatedBy`.
  function toPublicPayload(cfg) {
    return {
      autoUpdateEnabled: !!cfg.autoUpdateEnabled,
      forceUpdateEnabled: !!cfg.forceUpdateEnabled,
      latestVersion: cfg.latestVersion || '1.0.0',
      changelog: cfg.changelog || '',
      downloadUrl: cfg.downloadUrl || '',
      releaseUrl: cfg.releaseUrl || '',
      fileSize: cfg.fileSize || 0,
      fileSizeLabel: cfg.fileSizeLabel || '',
      forceUpdateMessage: cfg.forceUpdateMessage || DEFAULT_CONFIG.forceUpdateMessage,
      history: Array.isArray(cfg.history) ? cfg.history.slice(0, 20) : []
    };
  }

  async function updateConfig(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = { ...current };

    if (typeof patch.autoUpdateEnabled === 'boolean') next.autoUpdateEnabled = patch.autoUpdateEnabled;
    if (typeof patch.forceUpdateEnabled === 'boolean') next.forceUpdateEnabled = patch.forceUpdateEnabled;
    if (typeof patch.latestVersion === 'string' && patch.latestVersion.trim()) next.latestVersion = patch.latestVersion.trim();
    if (typeof patch.changelog === 'string') next.changelog = patch.changelog;
    if (typeof patch.downloadUrl === 'string') next.downloadUrl = patch.downloadUrl.trim();
    if (typeof patch.releaseUrl === 'string') next.releaseUrl = patch.releaseUrl.trim();
    if (typeof patch.fileSize === 'number' && patch.fileSize >= 0) next.fileSize = patch.fileSize;
    if (typeof patch.fileSizeLabel === 'string') next.fileSizeLabel = patch.fileSizeLabel.trim();
    if (typeof patch.forceUpdateMessage === 'string' && patch.forceUpdateMessage.trim()) next.forceUpdateMessage = patch.forceUpdateMessage.trim();

    // Force Update hanya boleh aktif kalau Auto Update juga aktif (kalau tidak,
    // app tidak akan pernah tahu ada versi baru untuk dipaksa update).
    if (next.forceUpdateEnabled && !next.autoUpdateEnabled) next.autoUpdateEnabled = true;

    // Validasi dasar: kalau Auto/Force Update mau diaktifkan, downloadUrl wajib diisi
    // dan sebaiknya mengarah ke GitHub Release.
    if ((next.autoUpdateEnabled) && !next.downloadUrl) {
      throw new Error('Link download (GitHub Release) wajib diisi sebelum mengaktifkan Auto Update.');
    }

    // Riwayat versi (opsional) — kalau admin submit array history, dipakai apa adanya
    // (sudah divalidasi di route). Kalau versi berubah dan history belum punya entri
    // untuk versi baru ini, otomatis catat satu entri baru di depan.
    if (Array.isArray(patch.history)) {
      next.history = patch.history.slice(0, 20);
    } else if (next.latestVersion !== current.latestVersion) {
      const already = (next.history || []).some(h => h.version === next.latestVersion);
      if (!already) {
        next.history = [
          { version: next.latestVersion, changelog: next.changelog, downloadUrl: next.downloadUrl, releasedAt: new Date().toISOString() },
          ...(next.history || [])
        ].slice(0, 20);
      }
    }

    next.updatedAt = new Date().toISOString();
    next.updatedBy = adminName || 'Admin';

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: APP_UPDATE_SETTINGS_ID },
      { $set: setFields },
      { upsert: true }
    );

    const publicPayload = toPublicPayload(next);
    // Siarkan realtime ke semua App client yang online — begitu admin simpan,
    // client yang sedang berjalan langsung dapat notifikasi tanpa perlu restart app.
    try { wsBroadcastAll && wsBroadcastAll('app-update:config', publicPayload); } catch (e) { /* noop */ }

    return next;
  }

  return {
    APP_UPDATE_SETTINGS_ID,
    compareVersions,
    getConfig,
    updateConfig,
    toPublicPayload
  };
};
