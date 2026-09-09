// ══════════════════════════════════════════════════════════════════════════
// CLOUD FIX MANAGER — konfigurasi fitur "Cloud FIX" (halaman Settings)
// ══════════════════════════════════════════════════════════════════════════
// STRUKTUR SAMA PERSIS dengan activeToolsManager.js (satu dokumen di koleksi
// `settings`, endpoint publik buat App + endpoint admin buat Admin Web,
// broadcast realtime via WS) — dan SEKARANG PERILAKUNYA JUGA SAMA PERSIS:
// App men-download link ZIP yang diatur admin lalu meng-extract-nya SENDIRI
// langsung ke folder Steam (lewat IPC main process, lihat 'cloud-fix-install'
// di main.js), BUKAN cuma membuka link eksternal seperti sebelumnya. Karena
// itu field-nya sekarang zipUrl + version, identik dengan Active Tools.
//
// Alur:
//   - Admin Web mengatur link ZIP GitHub, versi, deskripsi, dan toggle
//     Aktif/Nonaktif lewat GET/PUT /api/admin/cloud-fix (di halaman Active
//     Tools, bukan menu terpisah).
//   - App memanggil GET /api/cloud-fix (PUBLIK, sama seperti /api/active-tools)
//     buat tahu link ZIP + versi + status fitur ini, lalu men-download &
//     meng-extract-nya sendiri lewat IPC main process kalau user menekan
//     tombol Cloud FIX.
//   - Perubahan disiarkan realtime ke semua client App yang sedang online
//     lewat WebSocket (event `cloud-fix:config`).
// ══════════════════════════════════════════════════════════════════════════

const CLOUD_FIX_SETTINGS_ID = 'cloudFixConfig';

const DEFAULT_CONFIG = {
  _id: CLOUD_FIX_SETTINGS_ID,
  enabled: false,
  zipUrl: '',
  version: '',
  description: 'Jalankan Cloud FIX untuk membantu memperbaiki masalah "Unable to Sync" pada Cloud Status di Steam.',
  updatedAt: null,
  updatedBy: null
};

module.exports = function cloudFixManagerFactory({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  async function getConfig() {
    const database = db();
    if (!database) return { ...DEFAULT_CONFIG };
    let doc = await database.collection('settings').findOne({ _id: CLOUD_FIX_SETTINGS_ID });
    if (!doc) {
      doc = { ...DEFAULT_CONFIG };
      await database.collection('settings').updateOne(
        { _id: CLOUD_FIX_SETTINGS_ID },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }
    // BUG FIX (migrasi field lama): dokumen yang tersimpan dari versi sebelumnya
    // (cuma punya field `url`, bukan `zipUrl`+`version`) tetap termuat dengan
    // aman lewat spread DEFAULT_CONFIG di bawah — field lama `url` diabaikan
    // begitu saja (bukan error), admin tinggal isi ulang zipUrl & version sekali.
    return { ...DEFAULT_CONFIG, ...doc };
  }

  // Payload yang dikirim ke APP (publik) — tidak perlu field admin-only seperti `updatedBy`.
  function toPublicPayload(cfg) {
    return {
      enabled: !!cfg.enabled,
      zipUrl: cfg.zipUrl || '',
      version: cfg.version || '',
      description: cfg.description || DEFAULT_CONFIG.description
    };
  }

  async function updateConfig(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.zipUrl === 'string') next.zipUrl = patch.zipUrl.trim();
    if (typeof patch.version === 'string') next.version = patch.version.trim();
    if (typeof patch.description === 'string' && patch.description.trim()) next.description = patch.description.trim();

    // Validasi dasar: kalau fitur mau diaktifkan, link ZIP & versi wajib diisi —
    // App butuh keduanya untuk menampilkan status & menjalankan proses download
    // + extract (sama seperti Active Tools).
    if (next.enabled && !next.zipUrl) {
      throw new Error('Link ZIP GitHub wajib diisi sebelum mengaktifkan Cloud FIX.');
    }
    if (next.enabled && !next.version) {
      throw new Error('Versi Cloud FIX wajib diisi sebelum mengaktifkan fitur ini.');
    }

    next.updatedAt = new Date().toISOString();
    next.updatedBy = adminName || 'Admin';

    // `url` (field lama) sengaja dibuang total kalau masih ada sisa dari
    // dokumen versi sebelumnya, supaya tidak ada field basi nyangkut di DB.
    delete next.url;

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: CLOUD_FIX_SETTINGS_ID },
      { $set: setFields, $unset: { url: '' } },
      { upsert: true }
    );

    const publicPayload = toPublicPayload(next);
    // Siarkan realtime ke semua App client yang online — begitu admin simpan,
    // kartu Cloud FIX di halaman Settings langsung ter-update tanpa restart.
    try { wsBroadcastAll && wsBroadcastAll('cloud-fix:config', publicPayload); } catch (e) { /* noop */ }

    return next;
  }

  return {
    CLOUD_FIX_SETTINGS_ID,
    getConfig,
    updateConfig,
    toPublicPayload
  };
};
