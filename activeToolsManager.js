// ══════════════════════════════════════════════════════════════════════════
// ACTIVE TOOLS MANAGER — konfigurasi fitur "Active Tools" (halaman Settings)
// ══════════════════════════════════════════════════════════════════════════
// Satu dokumen konfigurasi disimpan di collection `settings` (_id tetap,
// sama pola dengan APP_UPDATE_SETTINGS_ID di appUpdateManager.js) supaya
// konsisten dengan modul lain di project ini.
//
// Alur:
//   - Admin Web mengatur link ZIP GitHub, versi tools, deskripsi, dan
//     toggle Aktif/Nonaktif fitur lewat GET/PUT /api/admin/active-tools.
//   - App (Electron) memanggil GET /api/active-tools (endpoint PUBLIK,
//     tanpa login, karena butuh dicek begitu app dibuka) untuk tahu link
//     ZIP + versi + deskripsi terbaru, lalu men-download & meng-extract-nya
//     sendiri lewat IPC main process (lihat main.js).
//   - Perubahan disiarkan realtime ke semua client App yang sedang online
//     lewat WebSocket (event `active-tools:config`) supaya kartu Active
//     Tools di halaman Settings langsung ter-update tanpa perlu restart app.
// ══════════════════════════════════════════════════════════════════════════

const ACTIVE_TOOLS_SETTINGS_ID = 'activeToolsConfig';

// `activationMethod`:
//   - 'link'       : SISTEM LAMA — download ZIP, tutup Steam, extract (tidak berubah sama sekali).
//   - 'powershell' : SISTEM BARU — App menjalankan `powershellCommand` apa adanya.
//                    App TIDAK exit/kill/restart Steam untuk metode ini — script
//                    PowerShell yang diisi admin diasumsikan SUDAH mengurus itu sendiri
//                    (lihat catatan di 'active-tools-run-powershell' di main.js).
const DEFAULT_CONFIG = {
  _id: ACTIVE_TOOLS_SETTINGS_ID,
  enabled: false,
  activationMethod: 'link',
  zipUrl: '',
  version: '',
  powershellCommand: '',
  description: 'Jalankan Active Tools sebelum download/install game agar game dapat terdeteksi di Steam Library.',
  updatedAt: null,
  updatedBy: null
};

module.exports = function activeToolsManagerFactory({ getDb, wsBroadcastAll }) {
  const db = () => getDb();

  async function getConfig() {
    const database = db();
    if (!database) return { ...DEFAULT_CONFIG };
    let doc = await database.collection('settings').findOne({ _id: ACTIVE_TOOLS_SETTINGS_ID });
    if (!doc) {
      doc = { ...DEFAULT_CONFIG };
      await database.collection('settings').updateOne(
        { _id: ACTIVE_TOOLS_SETTINGS_ID },
        { $setOnInsert: doc },
        { upsert: true }
      );
    }
    // `{ ...DEFAULT_CONFIG, ...doc }` otomatis ngasih activationMethod:'link' &
    // powershellCommand:'' ke dokumen LAMA yang dibuat sebelum fitur ini ada —
    // jadi config lama tetap jalan sebagai metode Link tanpa perlu migrasi data.
    return { ...DEFAULT_CONFIG, ...doc };
  }

  // Payload yang dikirim ke APP (publik) — tidak perlu field admin-only seperti `updatedBy`.
  function toPublicPayload(cfg) {
    return {
      enabled: !!cfg.enabled,
      activationMethod: cfg.activationMethod === 'powershell' ? 'powershell' : 'link',
      zipUrl: cfg.zipUrl || '',
      version: cfg.version || '',
      powershellCommand: cfg.powershellCommand || '',
      description: cfg.description || DEFAULT_CONFIG.description
    };
  }

  async function updateConfig(patch, adminName) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const current = await getConfig();
    const next = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.activationMethod === 'link' || patch.activationMethod === 'powershell') next.activationMethod = patch.activationMethod;
    if (typeof patch.zipUrl === 'string') next.zipUrl = patch.zipUrl.trim();
    if (typeof patch.version === 'string') next.version = patch.version.trim();
    if (typeof patch.powershellCommand === 'string') next.powershellCommand = patch.powershellCommand.trim();
    if (typeof patch.description === 'string' && patch.description.trim()) next.description = patch.description.trim();

    // Validasi dasar tergantung metode yang AKTIF dipilih — cuma field metode yang
    // dipakai yang wajib diisi, field metode yang lain boleh kosong/tetap tersimpan
    // apa adanya (supaya admin bisa gonta-ganti metode tanpa kehilangan data yang
    // sudah diisi di metode satunya).
    if (next.enabled && next.activationMethod === 'link') {
      if (!next.zipUrl) throw new Error('Link ZIP GitHub wajib diisi sebelum mengaktifkan Active Tools (metode Link).');
      if (!next.version) throw new Error('Versi Tools wajib diisi sebelum mengaktifkan Active Tools (metode Link).');
    }
    if (next.enabled && next.activationMethod === 'powershell') {
      if (!next.powershellCommand) throw new Error('PowerShell Command wajib diisi sebelum mengaktifkan Active Tools (metode PowerShell).');
    }

    next.updatedAt = new Date().toISOString();
    next.updatedBy = adminName || 'Admin';

    const { _id, ...setFields } = next;
    await database.collection('settings').updateOne(
      { _id: ACTIVE_TOOLS_SETTINGS_ID },
      { $set: setFields },
      { upsert: true }
    );

    const publicPayload = toPublicPayload(next);
    // Siarkan realtime ke semua App client yang online — begitu admin simpan,
    // kartu Active Tools di halaman Settings langsung ter-update tanpa restart.
    try { wsBroadcastAll && wsBroadcastAll('active-tools:config', publicPayload); } catch (e) { /* noop */ }

    return next;
  }

  return {
    ACTIVE_TOOLS_SETTINGS_ID,
    getConfig,
    updateConfig,
    toPublicPayload
  };
};
