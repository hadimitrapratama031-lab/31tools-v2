// ══════════════════════════════════════════════════════════════════════════
// RYU KEY MANAGER — API Key "Ryu API" (generator.ryuu.lol/api/download/{appId})
// dikelola dari Admin Web (collection `ryuApiKeys`), TERPISAH dari:
//   - hubcapKeyManager.js (HubCap, endpoint/domain beda: hubcapmanifest.com)
//   - RYUU_API_KEY di .env (dipakai fitur BYPASS "Ryuu Generator" yang sudah
//     ada duluan, endpoint-nya bukan /api/download/, dan bukan buat game)
// Fitur ini KHUSUS buat DOWNLOAD GAME — dipakai sebagai alternatif/fallback
// kalau HubCap kehabisan kuota harian, admin tinggal pilih provider "Ryu"
// pas nambah/cari Game di Admin Web.
//
// Pola & perilakunya SAMA PERSIS dengan hubcapKeyManager.js (auto rotation,
// cooldown, CRUD, broadcast realtime) — bedanya:
//   - Auth pakai header `X-Auth-Key` (bukan `Authorization: Bearer`).
//   - Ryu API TIDAK menyediakan endpoint stats/usage publik (tidak seperti
//     hubcapmanifest.com/api/v1/user/stats), jadi tidak ada dailyUsage/
//     dailyLimit — status key murni dari hasil request terakhir (aktif/
//     kena limit-error/nonaktif).
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { ObjectId } = require('mongodb');

const COLLECTION = 'ryuApiKeys';
const COOLDOWN_MS = 60 * 1000; // 1 menit cooldown per key yang kena limit/error, sama seperti HubCap

module.exports = function createRyuKeyManager({ getDb, RYU_BASE_URL, broadcastAdmin, logActivity }) {
  let cache = [];
  let loaded = false;
  let rotationIndex = 0;
  const cooldownUntil = {};
  const cooldownReason = {};
  const lastCheckedStatus = {}; // id -> 'ok' | 'error' (dari request terakhir, bukan polling aktif)

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

  function activeKeys() { return cache.filter(k => k.active !== false); }

  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}${'•'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
  }

  function isOnCooldown(id) { return (cooldownUntil[id] || 0) > Date.now(); }

  async function getActiveKey() {
    await ensureLoaded();
    const keys = activeKeys();
    if (!keys.length) return null;
    for (let i = 0; i < keys.length; i++) {
      const idx = (rotationIndex + i) % keys.length;
      const k = keys[idx];
      if (!isOnCooldown(String(k._id))) { rotationIndex = idx; return k; }
    }
    return keys[0]; // semua cooldown — fallback ke key pertama, caller cek allLimited via snapshot
  }

  async function markSuccess(keyDoc) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    lastCheckedStatus[id] = 'ok';
    delete cooldownReason[id];
    if (cooldownUntil[id]) delete cooldownUntil[id];
  }

  async function markLimited(keyDoc, reason) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    lastCheckedStatus[id] = 'error';
    cooldownUntil[id] = Date.now() + COOLDOWN_MS;
    cooldownReason[id] = reason || 'Limit / ditolak';

    const keys = activeKeys();
    const idx = keys.findIndex(k => String(k._id) === id);
    if (keys.length) rotationIndex = (idx >= 0 ? idx + 1 : 0) % keys.length;

    const allLimited = keys.length > 0 && keys.every(k => isOnCooldown(String(k._id)));

    if (allLimited) {
      await _logActivity({
        type: 'ryu_all_limited', status: 'error',
        description: `Seluruh API Key Ryu (${keys.length}) telah mencapai batas / ditolak. Tidak ada key aktif tersisa untuk sementara.`,
        meta: { totalKeys: keys.length }
      }).catch(() => {});
    } else if (keys.length > 1) {
      const next = keys[rotationIndex];
      await _logActivity({
        type: 'ryu_auto_rotation', status: 'warning',
        description: `Auto Rotation: API Key Ryu "${keyDoc.name}" ${reason ? `(${reason}) ` : ''}dipindah ke "${next?.name || '(tidak diketahui)'}" secara otomatis.`,
        meta: { fromKeyId: id, toKeyId: next ? String(next._id) : null }
      }).catch(() => {});
    }

    await _logActivity({
      type: 'ryu_key_limit', status: 'warning',
      description: `API Key Ryu "${keyDoc.name}" mencapai limit/ditolak: ${reason || 'tidak diketahui'}.`,
      meta: { keyId: id, reason: reason || null }
    }).catch(() => {});

    _broadcastAdmin('ryu:update', await getMonitorSnapshot());
  }

  async function markError(keyDoc, reason) {
    if (!keyDoc) return;
    const id = String(keyDoc._id);
    lastCheckedStatus[id] = 'error';
    await _logActivity({
      type: 'ryu_api_error', status: 'error',
      description: `Error memakai API Key Ryu "${keyDoc.name}": ${reason || 'unknown error'}.`,
      meta: { keyId: id, reason: reason || null }
    }).catch(() => {});
    _broadcastAdmin('ryu:update', await getMonitorSnapshot());
  }

  async function getMonitorSnapshot() {
    await ensureLoaded();
    const active = await getActiveKey();
    const keys = cache.map(k => {
      const id = String(k._id);
      let status;
      if (k.active === false) status = 'inactive';
      else if (isOnCooldown(id)) status = 'limited';
      else if (lastCheckedStatus[id] === 'error') status = 'error';
      else status = 'active';
      return {
        id, name: k.name, maskedKey: maskKey(k.key),
        active: k.active !== false, status,
        isCurrent: !!active && String(active._id) === id,
        cooldownUntil: cooldownUntil[id] || null,
        error: cooldownReason[id] || null,
        createdAt: k.createdAt || null
      };
    });
    const active_ = activeKeys();
    const allLimited = active_.length > 0 && active_.every(k => isOnCooldown(String(k._id)));
    return {
      keys, currentKeyId: active ? String(active._id) : null,
      totalKeys: cache.length, activeCount: active_.length,
      allLimited, checkedAt: new Date()
    };
  }

  // ── CRUD ──
  async function addKey({ name, key }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!key || !key.trim()) throw new Error('API Key wajib diisi.');
    const doc = { name: (name || '').trim() || `Ryu Key ${cache.length + 1}`, key: key.trim(), active: true, createdAt: new Date() };
    const result = await db.collection(COLLECTION).insertOne(doc);
    await reload();
    await _logActivity({
      type: 'ryu_key_add', status: 'success',
      description: `Admin menambahkan API Key Ryu baru "${doc.name}".`,
      meta: { keyId: result.insertedId }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('ryu:update', snapshot);
    return snapshot;
  }

  async function updateKey(id, { name, key, active }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!ObjectId.isValid(id)) throw new Error('ID API Key tidak valid.');
    const update = {};
    if (name !== undefined && name !== null) update.name = String(name).trim() || 'Ryu Key';
    if (key !== undefined && key !== null && String(key).trim()) update.key = String(key).trim();
    if (active !== undefined) update.active = !!active;
    if (!Object.keys(update).length) throw new Error('Tidak ada perubahan yang dikirim.');

    const existing = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('API Key tidak ditemukan.');

    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: update });
    if (update.active === true) { delete cooldownUntil[id]; delete cooldownReason[id]; delete lastCheckedStatus[id]; }
    await reload();

    const label = update.name || existing.name;
    const changedFields = Object.keys(update).map(f => f === 'key' ? 'API Key' : f === 'active' ? 'status aktif' : 'nama').join(', ');
    await _logActivity({
      type: 'ryu_key_edit', status: 'success',
      description: `Admin mengubah API Key Ryu "${label}" (${changedFields}).`,
      meta: { keyId: id, fields: Object.keys(update) }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('ryu:update', snapshot);
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
    delete cooldownUntil[id]; delete cooldownReason[id]; delete lastCheckedStatus[id];
    await reload();
    await _logActivity({
      type: 'ryu_key_delete', status: 'warning',
      description: `Admin menghapus API Key Ryu "${existing.name}".`,
      meta: { keyId: id }
    }).catch(() => {});
    const snapshot = await getMonitorSnapshot();
    _broadcastAdmin('ryu:update', snapshot);
    return snapshot;
  }

  return {
    getActiveKey, markSuccess, markLimited, markError, getMonitorSnapshot,
    addKey, updateKey, toggleKey, deleteKey,
    hasAnyKey: async () => { await ensureLoaded(); return cache.length > 0; },
    hasActiveKey: async () => { await ensureLoaded(); return activeKeys().length > 0; }
  };
};
