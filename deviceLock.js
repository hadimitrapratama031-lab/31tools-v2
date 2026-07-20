// ══════════════════════════════════════════════════════════════════════════
// DEVICE LOCK — 1 akun hanya bisa dipakai di 1 perangkat.
// ══════════════════════════════════════════════════════════════════════════
// Cara kerja singkat:
//  1. Login pertama kali -> perangkat yang dipakai OTOMATIS didaftarkan sebagai
//     "perangkat utama" akun itu (collection `devices`, 1 dokumen per discordId).
//  2. Login berikutnya -> fingerprint perangkat yang login dicocokkan dengan yang
//     tersimpan. Fingerprint dihitung dari KOMBINASI 4 komponen hardware (bukan
//     cuma 1 macam data kayak MAC Address/Computer Name yang gampang dipalsukan):
//       - MachineGuid Windows (registry)
//       - CPU (nama + jumlah core/thread)
//       - Motherboard (vendor + serial/model)
//       - Disk utama (model + serial)
//  3. TOLERAN terhadap perubahan kecil: kalau MINIMAL 3 dari 4 komponen tetap cocok
//     (misal user ganti disk atau ada bug Windows regenerate 1 identifier), login
//     tetap diizinkan & komponen yang berubah itu diperbarui diam-diam — supaya user
//     yang sah tidak gampang ke-lock out gara-gara update Windows / ganti part kecil.
//     Kalau yang cocok cuma 2 ke bawah, dianggap PERANGKAT LAIN -> login ditolak.
//  4. Semua kejadian penting (registrasi, login sukses, ditolak, direset admin, dst)
//     dicatat ke collection `deviceLogs` buat audit trail.
//
// Cara pakai dari server.js:
//   const deviceLock = require('./deviceLock')({ getDb: () => db });
//   const result = await deviceLock.verifyOrRegister(discordId, username, deviceInfo);
//   if (!result.allowed) return res.status(403).json({ error: result.reason });
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const DEVICES_COLLECTION = 'devices';
const LOGS_COLLECTION = 'deviceLogs';

// Minimal berapa dari 4 komponen yang harus cocok supaya dianggap perangkat yang sama.
const MATCH_THRESHOLD = 3;
const COMPONENT_KEYS = ['machineGuid', 'cpu', 'board', 'disk'];

function sha256(str) {
  if (!str) return null;
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function maskSerial(serial) {
  if (!serial) return null;
  const s = String(serial).trim();
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

// Hitung hash tiap komponen + fingerprint gabungan dari raw device info yang dikirim app.
function computeComponents(deviceInfo = {}) {
  const components = {
    machineGuid: sha256(deviceInfo.machineGuid),
    cpu:         sha256(`${deviceInfo.cpuName || ''}|${deviceInfo.cpuCores || ''}|${deviceInfo.cpuThreads || ''}`),
    board:       sha256(`${deviceInfo.boardVendor || ''}|${deviceInfo.boardModel || ''}|${deviceInfo.boardSerial || ''}`),
    disk:        sha256(`${deviceInfo.diskModel || ''}|${deviceInfo.diskSerial || ''}`)
  };
  const fingerprint = sha256(COMPONENT_KEYS.map(k => components[k] || '').join('::'));
  return { components, fingerprint };
}

// Bagian info yang aman ditampilkan ke admin (tidak menyimpan serial mentah).
function sanitizeInfo(deviceInfo = {}) {
  return {
    pcName:          deviceInfo.pcName || null,
    windowsUsername: deviceInfo.windowsUsername || null,
    osName:          deviceInfo.osName || null,
    osVersion:       deviceInfo.osVersion || null,
    osBuild:         deviceInfo.osBuild || null,
    arch:            deviceInfo.arch || null,
    cpuName:         deviceInfo.cpuName || null,
    cpuCores:        deviceInfo.cpuCores || null,
    cpuThreads:      deviceInfo.cpuThreads || null,
    ramTotalBytes:   deviceInfo.ramTotalBytes || null,
    gpuName:         deviceInfo.gpuName || null,
    boardVendor:     deviceInfo.boardVendor || null,
    boardModel:      deviceInfo.boardModel || null,
    boardSerialMasked: maskSerial(deviceInfo.boardSerial),
    diskModel:       deviceInfo.diskModel || null,
    diskSizeBytes:   deviceInfo.diskSizeBytes || null,
    diskSerialMasked: maskSerial(deviceInfo.diskSerial),
    appVersion:      deviceInfo.appVersion || null
  };
}

module.exports = function createDeviceLock({ getDb }) {

  async function logEvent({ discordId, username, action, detail = {}, byAdmin = false, adminNote = null, ip = null }) {
    const db = getDb();
    if (!db) return;
    try {
      await db.collection(LOGS_COLLECTION).insertOne({
        discordId, username: username || null, action, detail, byAdmin, adminNote: adminNote || null, ip: ip || null,
        createdAt: new Date()
      });
    } catch (e) {
      console.warn('[DeviceLock] Gagal mencatat log:', e.message);
    }
  }

  async function getDevice(discordId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(DEVICES_COLLECTION).findOne({ _id: discordId });
  }

  async function getLogs(discordId, limit = 50) {
    const db = getDb();
    if (!db) return [];
    return db.collection(LOGS_COLLECTION)
      .find({ discordId })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .toArray();
  }

  // ── INTI: dipanggil app tiap sesi login (login Discord baru ATAU "Masuk Sekarang"
  // pakai token tersimpan) — mendaftarkan perangkat pertama kali, atau mencocokkan
  // fingerprint utk login berikutnya. TIDAK PERNAH throw ke pemanggil kalau DB belum
  // siap — cukup fail-open (allowed:true) supaya device lock tidak jadi single point
  // of failure yang mengunci semua orang kalau DB lagi bermasalah.
  async function verifyOrRegister(discordId, username, deviceInfo = {}, meta = {}) {
    const db = getDb();
    if (!db) return { allowed: true, status: 'db_unavailable' };

    const { components, fingerprint } = computeComponents(deviceInfo);
    const info = sanitizeInfo(deviceInfo);
    const now = new Date();
    const existing = await getDevice(discordId);

    // 1) BELUM PERNAH ADA PERANGKAT TERDAFTAR -> daftarkan sebagai perangkat utama.
    if (!existing) {
      await db.collection(DEVICES_COLLECTION).updateOne(
        { _id: discordId },
        { $set: { _id: discordId, fingerprint, components, info, registeredAt: now, lastLoginAt: now, lastActiveAt: now, pendingChange: false } },
        { upsert: true }
      );
      await logEvent({ discordId, username, action: 'device_registered', detail: { pcName: info.pcName }, ip: meta.ip });
      return { allowed: true, status: 'registered' };
    }

    // 2) ADMIN SEDANG MENGIZINKAN "GANTI DEVICE" -> login berikutnya (siapa pun itu)
    // otomatis didaftarkan ulang sebagai perangkat utama baru, satu kali pakai.
    if (existing.pendingChange) {
      await db.collection(DEVICES_COLLECTION).updateOne(
        { _id: discordId },
        { $set: { fingerprint, components, info, registeredAt: now, lastLoginAt: now, lastActiveAt: now, pendingChange: false } }
      );
      await logEvent({ discordId, username, action: 'device_change_used', detail: { pcName: info.pcName }, ip: meta.ip });
      return { allowed: true, status: 'change_used' };
    }

    // 3) COCOKKAN FINGERPRINT — toleran, minimal 3 dari 4 komponen harus sama persis.
    const matchedKeys = COMPONENT_KEYS.filter(k => existing.components?.[k] && existing.components[k] === components[k]);
    const matchCount = matchedKeys.length;

    if (matchCount === COMPONENT_KEYS.length) {
      // Cocok semua -> update info kosmetik (pcName dll bisa berubah tanpa masalah) & jejak aktivitas.
      await db.collection(DEVICES_COLLECTION).updateOne(
        { _id: discordId },
        { $set: { info, lastLoginAt: now, lastActiveAt: now } }
      );
      return { allowed: true, status: 'match' };
    }

    if (matchCount >= MATCH_THRESHOLD) {
      // Cocok sebagian besar (toleransi perubahan kecil, mis. ganti disk) -> tetap izinkan,
      // perbarui fingerprint & komponen yang berubah, catat ke log biar admin tahu ada perubahan.
      const changedKeys = COMPONENT_KEYS.filter(k => !matchedKeys.includes(k));
      await db.collection(DEVICES_COLLECTION).updateOne(
        { _id: discordId },
        { $set: { fingerprint, components, info, lastLoginAt: now, lastActiveAt: now } }
      );
      await logEvent({ discordId, username, action: 'minor_change_tolerated', detail: { changedComponents: changedKeys, pcName: info.pcName }, ip: meta.ip });
      return { allowed: true, status: 'tolerated' };
    }

    // 4) TIDAK COCOK (perangkat berbeda) -> TOLAK. Catat percobaannya (device lama TIDAK
    // ditimpa), biar admin bisa lihat siapa/perangkat apa yang mencoba login.
    await logEvent({
      discordId, username, action: 'login_rejected',
      detail: { attemptedInfo: info, matchedComponents: matchedKeys, boundPcName: existing.info?.pcName || null },
      ip: meta.ip
    });
    return {
      allowed: false,
      status: 'rejected',
      reason: `Akun ini sudah terikat ke perangkat lain (${existing.info?.pcName || 'perangkat terdaftar'}). Hubungi admin kalau ini kesalahan atau kamu ganti perangkat.`
    };
  }

  // ── ADMIN: Reset Device — langsung lepas ikatan sekarang. Login berikutnya dari
  // perangkat MANAPUN otomatis didaftarkan sebagai perangkat baru.
  async function resetDevice(discordId, { adminNote, username } = {}) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const existing = await getDevice(discordId);
    if (!existing) throw new Error('User ini belum punya perangkat terikat.');
    await db.collection(DEVICES_COLLECTION).deleteOne({ _id: discordId });
    await logEvent({ discordId, username, action: 'device_reset', byAdmin: true, adminNote, detail: { previousPcName: existing.info?.pcName || null } });
    return { success: true };
  }

  // ── ADMIN: Ganti Device — TIDAK langsung melepas ikatan (device lama tetap bisa
  // login seperti biasa sampai ada login lain). Login berikutnya dari perangkat APAPUN
  // (baru atau lama) akan didaftarkan ulang sebagai perangkat utama baru, sekali pakai.
  async function allowDeviceChange(discordId, { adminNote, username } = {}) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const existing = await getDevice(discordId);
    if (!existing) throw new Error('User ini belum punya perangkat terikat — tidak perlu ganti device, cukup login biasa.');
    await db.collection(DEVICES_COLLECTION).updateOne({ _id: discordId }, { $set: { pendingChange: true } });
    await logEvent({ discordId, username, action: 'device_change_allowed', byAdmin: true, adminNote });
    return { success: true };
  }

  return {
    MATCH_THRESHOLD,
    COMPONENT_KEYS,
    getDevice,
    getLogs,
    verifyOrRegister,
    resetDevice,
    allowDeviceChange
  };
};
