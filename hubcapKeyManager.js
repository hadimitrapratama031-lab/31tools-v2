// ══════════════════════════════════════════════════════════════════════════
// HUBCAP KEY MANAGER — API Key HubCap sekarang dikelola dari Admin Web
// (collection `hubcapApiKeys`), BUKAN cuma dari .env lagi.
// ══════════════════════════════════════════════════════════════════════════
// Kenapa dipisah jadi modul sendiri (mirip pola webhookManager.js):
//   - Admin bisa Tambah/Edit/Hapus/Aktifkan/Nonaktifkan API Key kapan saja
//     lewat Admin Web, TANPA perlu redeploy/restart server — setiap operasi
//     baca-tulis SELALU lewat DB (tidak ada key yang "beku" di .env).
//   - Auto Rotation: kalau key yang lagi dipakai kena limit harian (429) atau
//     ditolak (401/403), otomatis pindah ke key aktif berikutnya, realtime,
//     tanpa restart apapun. Kalau SEMUA key kena limit, ditandai `allLimited`
//     supaya Admin Web bisa tampilkan status itu ke admin.
//   - Monitoring: tiap key dicek statusnya ke hubcapmanifest.com/api/v1/user/stats
//     pakai key itu sendiri (di-cache singkat biar gak boros kuota), supaya
//     Daily Usage / Daily Limit / Remaining / Status yang tampil di Admin Web
//     itu data ASLI dari HubCap, bukan cuma tebakan lokal.
//   - Semua perubahan (tambah/edit/hapus/limit/auto-rotation/error) dicatat ke
//     Logs (lewat logActivity) DAN di-broadcast realtime ke Admin Web yang
//     sedang buka halaman Hubcap API (lewat broadcastAdmin('hubcap:update')).
//
// Cara pakai dari server.js:
//   const hubcapKeyManager = require('./hubcapKeyManager')({
//     getDb: () => db, HUBCAP_BASE_URL, broadcastAdmin, logActivity
//   });
//   await hubcapKeyManager.migrateLegacyEnvKeys(); // sekali, dipanggil setelah DB konek
//   const active = await hubcapKeyManager.getActiveKey(); // { _id, name, key }
//   await hubcapKeyManager.markLimited(active, 'HTTP 429');
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { ObjectId } = require('mongodb');

const COLLECTION = 'hubcapApiKeys';
const COOLDOWN_MS = 60 * 1000;       // 1 menit cooldown per key yang kena limit/error, sama seperti perilaku lama
const STATS_CACHE_MS = 20 * 1000;    // cache status/usage per key 20 detik — jangan tembak hubcapmanifest tiap kali admin buka halaman

module.exports = function createHubcapKeyManager({ getDb, HUBCAP_BASE_URL, broadcastAdmin, logActivity }) {
  let cache = [];              // salinan lokal dokumen key dari DB, di-reload tiap ada perubahan
  let loaded = false;
  let rotationIndex = 0;       // index (dalam activeKeys()) key yang sedang "giliran" dipakai
  const cooldownUntil = {};    // id -> timestamp ms boleh dipakai lagi (limit/error)
  const cooldownReason = {};   // id -> alasan terakhir kena cooldown
  const statsCache = {};       // id -> { data, fetchedAt }

  function noop() {}
  const _broadcastAdmin = typeof broadcastAdmin === 'function' ? broadcastAdmin : noop;
  const _logActivity = typeof logActivity === 'function' ? logActivity : async () => {};

  async function reload() {
    const db = getDb();
    if (!db) return;
    cache = await db.collection(COLLECTION).find({}).sort({ createdAt: 1 }).toArray();
    loaded = true;
  }
  async function ensureLoaded() { if (!loaded) await reload(); }

  // Migrasi satu kali: kalau collection masih kosong TAPI ada HUBCAP_API_KEY* lama
  // di .env, import jadi entri DB supaya rotasi lama tetap jalan tanpa admin harus
  // input ulang manual. Aman dipanggil berkali-kali (no-op kalau collection sudah ada isinya).
  async function migrateLegacyEnvKeys() {
    const db = getDb();
    if (!db) return;
    try {
      const count = await db.collection(COLLECTION).countDocuments();
      if (count > 0) { await reload(); return; }
      const envKeys = [
        process.env.HUBCAP_API_KEY,
        process.env.HUBCAP_API_KEY_2,
        process.env.HUBCAP_API_KEY_3,
        process.env.HUBCAP_API_KEY_4
      ].filter(Boolean);
      if (!envKeys.length) { await reload(); return; }
      const docs = envKeys.map((k, i) => ({
        name: `Legacy ENV Key ${i + 1}`,
        key: k,
        active: true,
        source: 'env-migration',
        createdAt: new Date()
      }));
      await db.collection(COLLECTION).insertMany(docs);
      console.log(`[HubcapKeyManager] Migrasi ${docs.length} API Key dari .env ke database.`);
      await reload();
    } catch (e) {
      console.warn('[HubcapKeyManager] Gagal migrasi legacy env keys:', e.message);
    }
  }

  function activeKeys() { return cache.filter(k => k.active !== false); }

  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}${'•'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
  }

  function isOnCooldown(id) { return (cooldownUntil[id] || 0) > Date.now(); }

  // Status "murni rotasi" (tanpa network) — dipakai buat pilih key mana yang giliran.
  function localStatus(keyDoc) {
    const id = String(keyDoc._id);
    if (keyDoc.active === false) return 'inactive';
    if (isOnCooldown(id)) return 'limited';
    return 'active';
  }

  // Ambil usage/limit ASLI dari hubcapmanifest.com pakai key itu sendiri (GET /api/v1/user/stats).
  // Di-cache singkat per key supaya buka halaman Monitoring berkali-kali tidak boros kuota.
  async function fetchStats(keyDoc, force = false) {
    const id = String(keyDoc._id);
    const cached = statsCache[id];
    if (!force && cached && (Date.now() - cached.fetchedAt) < STATS_CACHE_MS) return cached.data;

    let data;
    try {
      const res = await axios.get(`${HUBCAP_BASE_URL}/api/v1/user/stats`, {
        headers: { Authorization: `Bearer ${keyDoc.key}` },
        timeout: 10000,
        validateStatus: () => true
      });
      if (res.status === 200 && res.data) {
        data = { ok: true, httpStatus: 200, ...res.data };
      } else {
        data = { ok: false, httpStatus: res.status, error: res.data?.error || `HTTP ${res.status}` };
      }
    } catch (e) {
      data = { ok: false, httpStatus: null, error: e.message || 'Gagal menghubungi hubcapmanifest.com' };
    }
    statsCache[id] = { data, fetchedAt: Date.now() };
    return data;
  }

  // Pilih key aktif berikutnya buat dipakai (dipanggil sebelum tiap request ke HubCap).
  // Mengembalikan null kalau tidak ada key aktif sama sekali.
  async function getActiveKey() {
    await ensureLoaded();
    const keys = activeKeys();
    if (!keys.length) return null;

    for (let i = 0; i < keys.length; i++) {
      const idx = (rotationIndex + i) % keys.length;
      const k = keys[idx];
      if (!isOnCooldown(String(k._id))) { rotationIndex = idx; return k; }
    }
    // Semua key lagi cooldown — tetap kembalikan key pertama sebagai fallback
    // (perilaku sama seperti sebelumnya), tapi caller sebaiknya cek allLimited via getMonitorSnapshot().
    return keys[0];
  }

  // Dipanggil saat request ke HubCap sukses pakai key ini — hapus status error/limited-nya.
  async function markSuccess(keyDoc) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    delete cooldownReason[id];
    if (cooldownUntil[id]) delete cooldownUntil[id];
  }

  // Dipanggil saat key kena limit harian (429) atau ditolak (401/403) — auto pindah ke key berikutnya.
  async function markLimited(keyDoc, reason) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    cooldownUntil[id] = Date.now() + COOLDOWN_MS;
    cooldownReason[id] = reason || 'Limit harian tercapai';

    const keys = activeKeys();
    const idx = keys.findIndex(k => String(k._id) === id);
    if (keys.length) rotationIndex = (idx >= 0 ? idx + 1 : 0) % keys.length;

    const allLimited = keys.length > 0 && keys.every(k => isOnCooldown(String(k._id)));

    if (allLimited) {
      await _logActivity({
        type: 'hubcap_all_limited',
        status: 'error',
        description: `Seluruh API Key HubCap (${keys.length}) telah mencapai batas harian / ditolak. Tidak ada key aktif tersisa untuk sementara.`,
        meta: { totalKeys: keys.length }
      }).catch(() => {});
    } else if (keys.length > 1) {
      const next = keys[rotationIndex];
      await _logActivity({
        type: 'hubcap_auto_rotation',
        status: 'warning',
        description: `Auto Rotation: API Key "${keyDoc.name}" ${reason ? `(${reason}) ` : ''}dipindah ke "${next?.name || '(tidak diketahui)'}" secara otomatis.`,
        meta: { fromKeyId: id, toKeyId: next ? String(next._id) : null }
      }).catch(() => {});
    }

    await _logActivity({
      type: 'hubcap_key_limit',
      status: 'warning',
      description: `API Key HubCap "${keyDoc.name}" mencapai limit/ditolak: ${reason || 'tidak diketahui'}.`,
      meta: { keyId: id, reason: reason || null }
    }).catch(() => {});

    delete statsCache[id]; // paksa refresh angka usage pas dicek lagi
    _broadcastAdmin('hubcap:update', await getMonitorSnapshot());
  }

  // Dipanggil saat request ke HubCap gagal karena sebab LAIN (bukan limit/auth) — dicatat tapi tidak cooldown.
  async function markError(keyDoc, reason) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    await _logActivity({
      type: 'hubcap_api_error',
      status: 'error',
      description: `Error memakai API Key HubCap "${keyDoc.name}": ${reason || 'unknown error'}.`,
      meta: { keyId: id, reason: reason || null }
    }).catch(() => {});
    _broadcastAdmin('hubcap:update', await getMonitorSnapshot());
  }

  // Snapshot lengkap buat halaman Monitoring & daftar API Key di Admin Web.
  // `force=true` dipakai tombol Refresh manual — bypass cache 20 detik supaya
  // admin langsung lihat angka usage/limit paling baru dari hubcapmanifest.com.
  async function getMonitorSnapshot(force = false) {
    await ensureLoaded();
    const active = await getActiveKey();
    const results = await Promise.all(cache.map(async (k) => {
      const id = String(k._id);
      const stats = await fetchStats(k, force).catch(() => ({ ok: false, error: 'Gagal mengambil status' }));
      const dailyUsage = stats?.ok ? (stats.daily_usage ?? stats.api_key_usage_count ?? null) : null;
      const dailyLimit = stats?.ok ? (stats.daily_limit ?? stats.custom_api_limit ?? stats.role_daily_limit ?? null) : null;
      let status;
      if (k.active === false) status = 'inactive';
      else if (isOnCooldown(id)) status = 'limited';
      else if (stats && stats.ok === false) status = 'error';
      else status = 'active';

      return {
        id,
        name: k.name,
        maskedKey: maskKey(k.key),
        active: k.active !== false,
        status, // 'active' | 'limited' | 'error' | 'inactive'
        isCurrent: !!active && String(active._id) === id,
        dailyUsage,
        dailyLimit,
        remaining: (dailyLimit != null && dailyUsage != null) ? Math.max(0, dailyLimit - dailyUsage) : null,
        canMakeRequests: stats?.ok ? (stats.can_make_requests ?? null) : null,
        cooldownUntil: cooldownUntil[id] || null,
        error: stats?.ok === false ? stats.error : (cooldownReason[id] || null),
        createdAt: k.createdAt || null
      };
    }));

    const active_ = activeKeys();
    const allLimited = active_.length > 0 && active_.every(k => isOnCooldown(String(k._id)));

    return {
      keys: results,
      currentKeyId: active ? String(active._id) : null,
      totalKeys: cache.length,
      activeCount: active_.length,
      allLimited,
      checkedAt: new Date()
    };
  }

  // ── CRUD ──
  async function addKey({ name, key }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!key || !key.trim()) throw new Error('API Key wajib diisi.');
    const doc = { name: (name || '').trim() || `API Key ${cache.length + 1}`, key: key.trim(), active: true, createdAt: new Date() };
    const result = await db.collection(COLLECTION).insertOne(doc);
    await reload();
    await _logActivity({
      type: 'hubcap_key_add', status: 'success',
      description: `Admin menambahkan API Key HubCap baru "${doc.name}".`,
      meta: { keyId: result.insertedId }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('hubcap:update', snapshot);
    return snapshot;
  }

  async function updateKey(id, { name, key, active }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!ObjectId.isValid(id)) throw new Error('ID API Key tidak valid.');
    const update = {};
    if (name !== undefined && name !== null) update.name = String(name).trim() || 'API Key';
    if (key !== undefined && key !== null && String(key).trim()) update.key = String(key).trim();
    if (active !== undefined) update.active = !!active;
    if (!Object.keys(update).length) throw new Error('Tidak ada perubahan yang dikirim.');

    const existing = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('API Key tidak ditemukan.');

    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: update });
    delete statsCache[id];
    if (update.active === true) { delete cooldownUntil[id]; delete cooldownReason[id]; }
    await reload();

    const label = update.name || existing.name;
    const changedFields = Object.keys(update).map(f => f === 'key' ? 'API Key' : f === 'active' ? 'status aktif' : 'nama').join(', ');
    await _logActivity({
      type: 'hubcap_key_edit', status: 'success',
      description: `Admin mengubah API Key HubCap "${label}" (${changedFields}).`,
      meta: { keyId: id, fields: Object.keys(update) }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('hubcap:update', snapshot);
    return snapshot;
  }

  async function toggleKey(id, active) {
    return updateKey(id, { active: !!active });
  }

  async function deleteKey(id) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!ObjectId.isValid(id)) throw new Error('ID API Key tidak valid.');
    const existing = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('API Key tidak ditemukan.');
    await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
    delete statsCache[id]; delete cooldownUntil[id]; delete cooldownReason[id];
    await reload();
    await _logActivity({
      type: 'hubcap_key_delete', status: 'warning',
      description: `Admin menghapus API Key HubCap "${existing.name}".`,
      meta: { keyId: id }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('hubcap:update', snapshot);
    return snapshot;
  }

  // ════════════════════════════════════════════════════════════════════════
  // ENDPOINT GRATIS ("Free - No usage count" di dokumentasi resmi HubCap):
  // /api/v1/library, /api/v1/status/{app_id}, /api/v1/search — TIDAK memotong
  // kuota harian API Key sama sekali. Auth-nya TETAP pakai Bearer key yang
  // sama (bukan token terpisah), tapi cooldown/limit yang dipakai buat
  // download manifest (kuota harian, lihat markLimited di atas) TIDAK relevan
  // dan TIDAK BOLEH dipakai di sini — kalau dipaksa pakai getActiveKey() yang
  // sama:
  //   1. Key yang sedang cooldown gara-gara kuota download habis jadi ikut
  //      diskip buat endpoint gratis ini juga, padahal harusnya tetap bisa
  //      dipakai (bikin browsing Request Game lambat/gagal tanpa alasan).
  //   2. Kalau endpoint gratis ini kena 429 (rate-limit sesaat, BUKAN kuota
  //      harian — dokumentasinya jelas bilang "No usage count"), kode lama
  //      memanggil markLimited() yang taruh key itu di cooldown PANJANG
  //      (dipakai buat kuota harian) dan bisa memicu alert "Semua API Key
  //      HubCap kena limit" di Admin — padahal kuota download key itu masih
  //      penuh sama sekali. Ini akar masalah "daily limit dari apikey hubcap
  //      padahal library itu free token".
  // Makanya dipisah total: state cooldown sendiri (short-lived, cuma buat
  // rotasi lokal kalau ada rate-limit sesaat), TIDAK menyentuh cooldownUntil/
  // cooldownReason/rotationIndex punya endpoint berbayar, TIDAK memanggil
  // markLimited(), TIDAK broadcast 'hubcap:update' / log 'hubcap_key_limit'.
  // ════════════════════════════════════════════════════════════════════════
  const freeEndpointCooldownUntil = {}; // id -> timestamp ms, cuma buat skip sesaat kalau 429
  const FREE_ENDPOINT_COOLDOWN_MS = 5000; // 5 detik — cukup buat lewatin rate-limit sesaat, jauh lebih pendek dari COOLDOWN_MS kuota harian

  // Pilih key aktif buat endpoint GRATIS — mengabaikan cooldown kuota-harian
  // (isOnCooldown) sepenuhnya, hanya skip key yang: (a) dinonaktifkan admin,
  // atau (b) baru saja 429 di endpoint gratis ini sendiri (cooldown pendek
  // terpisah di atas). Round-robin pakai index sendiri supaya tidak
  // mengganggu urutan rotasi endpoint berbayar.
  let freeRotationIndex = 0;
  async function getKeyForFreeEndpoint() {
    await ensureLoaded();
    const keys = activeKeys();
    if (!keys.length) return null;
    for (let i = 0; i < keys.length; i++) {
      const idx = (freeRotationIndex + i) % keys.length;
      const k = keys[idx];
      const id = String(k._id);
      if ((freeEndpointCooldownUntil[id] || 0) <= Date.now()) { freeRotationIndex = idx; return k; }
    }
    // Semua lagi cooldown sesaat (jarang) — tetap kembalikan key pertama, biarkan caller retry singkat.
    return keys[0];
  }

  // 429 di endpoint gratis = rate-limit sesaat (dokumentasi HubCap eksplisit
  // "No usage count"), BUKAN kuota harian habis — jadi cukup skip key ini
  // beberapa detik lokal saja, TANPA menyentuh cooldown kuota-harian, TANPA
  // log/alert admin (supaya tidak menimbulkan false alarm "semua key limit").
  function markFreeEndpointRateLimited(keyDoc) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    freeEndpointCooldownUntil[id] = Date.now() + FREE_ENDPOINT_COOLDOWN_MS;
    const keys = activeKeys();
    const idx = keys.findIndex(k => String(k._id) === id);
    if (keys.length) freeRotationIndex = (idx >= 0 ? idx + 1 : 0) % keys.length;
  }

  return {
    migrateLegacyEnvKeys,
    getActiveKey,
    markSuccess,
    markLimited,
    markError,
    getMonitorSnapshot,
    addKey,
    updateKey,
    toggleKey,
    deleteKey,
    hasAnyKey: async () => { await ensureLoaded(); return cache.length > 0; },
    hasActiveKey: async () => { await ensureLoaded(); return activeKeys().length > 0; },
    // Khusus endpoint gratis HubCap (library/status/search) — lihat komentar di atas.
    getKeyForFreeEndpoint,
    markFreeEndpointRateLimited
  };
};
