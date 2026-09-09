// ══════════════════════════════════════════════════════════════════════════
// WATERMARK DETECTION MANAGER — "Automatic Watermark Detection" untuk
// download Game & Bypass. Modul terpisah (pola sama dgn deviceLock.js,
// discordAutoOrderManager.js, dst): satu tanggung jawab, reusable, TIDAK
// mengubah alur download/inject yang sudah ada — cuma "menumpang" di
// titik-titik yang sudah ada (lihat INTEGRATION di server.js/main.js).
//
// PRINSIP PENTING (sesuai requirement):
//   - TIDAK PERNAH auto-ban/auto-suspend. Modul ini CUMA mencatat log &
//     mengirim notifikasi realtime ke Admin Web. Semua tindakan ke akun
//     tetap manual oleh admin (lewat halaman user/ban yang sudah ada).
//   - TIDAK false-positive: sebuah "alert" HANYA dibuat kalau (a) blob
//     watermark berhasil didekripsi & lolos verifikasi AEAD (AES-256-GCM,
//     otomatis menolak file yang diubah/corrupt), (b) signature internal
//     (hash) yang dihitung ulang di server cocok, (c) Download ID-nya
//     benar-benar terdaftar di database, DAN (d) Device ID saat ini
//     berbeda dari Device ID saat download. Kalau salah satu gagal, event
//     itu dilewati diam-diam (bukan dianggap "perangkat berbeda").
//
// Cara pakai dari server.js:
//   const watermarkManager = require('./watermarkManager')({
//     getDb: () => db, deviceLock, logActivity, broadcastAdmin,
//     webhookManager, buildEmbed, field, APP_NAME
//   });
//   await watermarkManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const WATERMARKS_COLLECTION = 'downloadWatermarks';
const ALERTS_COLLECTION = 'watermarkAlerts';
const BLOB_PREFIX = 'WMK1:';

module.exports = function createWatermarkManager({ getDb, deviceLock, logActivity, broadcastAdmin, webhookManager, buildEmbed, field, APP_NAME }) {
  // Kunci enkripsi diturunkan dari WATERMARK_SECRET (.env). Kalau admin belum
  // sempat mengisinya, fallback ke JWT_SECRET (sudah wajib ada di project ini)
  // supaya fitur tetap langsung jalan tanpa setup tambahan — tapi tetap
  // disarankan mengisi WATERMARK_SECRET sendiri di .env untuk produksi.
  const SECRET = process.env.WATERMARK_SECRET || process.env.JWT_SECRET || 'fallback-watermark-secret-ganti-di-env';
  const KEY = crypto.scryptSync(SECRET, 'auto-watermark-detection-salt', 32);

  function computeSignature(payload) {
    return crypto.createHmac('sha256', KEY)
      .update([payload.downloadId, payload.discordId, payload.productType, payload.productId, payload.deviceId, payload.downloadedAt].join('|'))
      .digest('hex');
  }

  // ── Enkripsi (AES-256-GCM — authenticated, jadi otomatis menolak blob yang
  // diubah/corrupt saat didekripsi, tanpa perlu pengecekan tambahan). ──
  function encryptPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return BLOB_PREFIX + [iv, ciphertext, authTag].map(b => b.toString('base64')).join('.');
  }

  function decryptBlob(blob) {
    if (typeof blob !== 'string' || !blob.startsWith(BLOB_PREFIX)) return null;
    const parts = blob.slice(BLOB_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    try {
      const [iv, ciphertext, authTag] = parts.map(p => Buffer.from(p, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const payload = JSON.parse(plain.toString('utf8'));
      // Verifikasi ulang signature internal — pertahanan berlapis di atas AEAD.
      if (payload.signature !== computeSignature(payload)) return null;
      return payload;
    } catch (e) {
      return null; // blob rusak/dipalsukan/pakai key beda -> BUKAN dianggap "device mismatch"
    }
  }

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(WATERMARKS_COLLECTION).createIndex({ discordId: 1 }).catch(() => {});
    await db.collection(WATERMARKS_COLLECTION).createIndex({ productType: 1, productId: 1 }).catch(() => {});
    await db.collection(ALERTS_COLLECTION).createIndex({ downloadId: 1, deviceIdDetected: 1 }, { unique: true }).catch(() => {});
    await db.collection(ALERTS_COLLECTION).createIndex({ detectedAt: -1 }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════════════════
  // ISSUE — dipanggil server.js tiap kali user MEMULAI download Game/Bypass
  // (setelah lolos cek role/limit yang sudah ada, TIDAK menggantikannya).
  // Server yang membuat & menandatangani watermark (bukan client) supaya
  // tidak bisa dipalsukan dari sisi App.
  // ══════════════════════════════════════════════════════════════════════
  async function issueWatermark({ user, productType, productId, deviceInfo, ip }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!['game', 'bypass'].includes(productType)) throw new Error('productType harus game/bypass.');

    const collectionName = productType === 'game' ? 'games' : 'bypasses';
    let productName = 'Item';
    try {
      const { ObjectId } = require('mongodb');
      if (ObjectId.isValid(productId)) {
        const prod = await db.collection(collectionName).findOne({ _id: new ObjectId(productId) });
        if (prod?.name) productName = prod.name;
      }
    } catch (e) { /* biarkan default 'Item', jangan sampai proses issue watermark gagal gara-gara ini */ }

    const { fingerprint } = deviceLock.computeComponents(deviceInfo || {});
    const downloadId = crypto.randomUUID();
    const downloadedAt = new Date().toISOString();

    const payload = {
      downloadId, discordId: user.discordId, userId: String(user._id || ''), username: user.username,
      productType, productId: String(productId), productName, deviceId: fingerprint, downloadedAt
    };
    payload.signature = computeSignature(payload);
    const blob = encryptPayload(payload);

    await db.collection(WATERMARKS_COLLECTION).insertOne({
      _id: downloadId,
      discordId: user.discordId, username: user.username, userId: String(user._id || ''),
      productType, productId: String(productId), productName,
      deviceIdAtDownload: fingerprint,
      pcNameAtDownload: (deviceInfo?.pcName || null),
      ip: ip || null,
      downloadedAt: new Date(),
      lastSeenAt: null
    });

    return { downloadId, blob };
  }

  // ══════════════════════════════════════════════════════════════════════
  // SCAN — dipanggil App tiap kali dijalankan (launcher startup, di
  // background, lihat main.js `scan-watermarks` & app/app.js). Menerima
  // sekumpulan blob yang ditemukan launcher di folder Game/Bypass lokal +
  // info perangkat SAAT INI, lalu dicocokkan ke database.
  // ══════════════════════════════════════════════════════════════════════
  async function processScanBatch({ user, deviceInfo, items }) {
    const db = getDb();
    if (!db || !Array.isArray(items) || !items.length) return { scanned: 0, alerts: 0 };

    const { fingerprint: currentFingerprint } = deviceLock.computeComponents(deviceInfo || {});
    let scanned = 0, alerts = 0;

    for (const raw of items) {
      const blob = typeof raw === 'string' ? raw : raw?.blob;
      const payload = decryptBlob(blob);
      if (!payload) continue; // rusak/dipalsukan/format lama -> dilewati, TIDAK dianggap mismatch
      scanned++;

      const record = await db.collection(WATERMARKS_COLLECTION).findOne({ _id: payload.downloadId });
      if (!record) continue; // Download ID tidak dikenal DB -> dilewati (no false detection)

      if (record.deviceIdAtDownload === currentFingerprint) {
        // Perangkat sama seperti saat download -> normal, cukup update jejak terakhir dilihat.
        db.collection(WATERMARKS_COLLECTION).updateOne({ _id: record._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
        continue;
      }

      // ── Device ID BERBEDA -> indikasi file dipakai di perangkat lain. ──
      const now = new Date();
      const existingAlert = await db.collection(ALERTS_COLLECTION).findOne({ downloadId: record._id, deviceIdDetected: currentFingerprint });
      const isNewAlert = !existingAlert;

      await db.collection(ALERTS_COLLECTION).updateOne(
        { downloadId: record._id, deviceIdDetected: currentFingerprint },
        {
          $setOnInsert: {
            downloadId: record._id, discordId: record.discordId, username: record.username, userId: record.userId,
            productType: record.productType, productId: record.productId, productName: record.productName,
            deviceIdAtDownload: record.deviceIdAtDownload, downloadedAt: record.downloadedAt,
            status: 'device_mismatch', firstDetectedAt: now
          },
          $set: {
            deviceIdDetected: currentFingerprint,
            detectedByDiscordId: user?.discordId || null,     // akun yang sedang login saat terdeteksi (bisa beda dgn pemilik asli)
            detectedByUsername: user?.username || null,
            pcNameDetected: deviceInfo?.pcName || null,
            detectedAt: now
          },
          $inc: { detectionCount: 1 }
        },
        { upsert: true }
      );
      alerts++;

      if (isNewAlert) {
        logActivity({
          type: 'watermark_device_mismatch',
          username: record.username, discordId: record.discordId, status: 'warning',
          description: `Indikasi file "${record.productName}" (${record.productType === 'game' ? 'Game' : 'Bypass'}) milik ${record.username} terdeteksi dipakai di perangkat lain (Download ID: ${record.downloadId}).`,
          meta: {
            downloadId: record.downloadId, productType: record.productType, productId: record.productId,
            deviceIdAtDownload: record.deviceIdAtDownload, deviceIdDetected: currentFingerprint,
            detectedByDiscordId: user?.discordId || null
          }
        }).catch(() => {});

        broadcastAdmin('watermark:alert', {
          downloadId: record.downloadId, discordId: record.discordId, username: record.username,
          userId: record.userId, productType: record.productType, productName: record.productName,
          deviceIdAtDownload: record.deviceIdAtDownload, deviceIdDetected: currentFingerprint,
          downloadedAt: record.downloadedAt, detectedAt: now, status: 'device_mismatch'
        });

        // Notifikasi Discord opsional (default OFF, admin aktifkan sendiri di
        // halaman Webhook Settings kalau mau) — pola sama persis dgn
        // device_security di server.js.
        webhookManager.sendCategoryWebhook('watermark_alert', {
          embed: buildEmbed({
            status: 'security', badge: 'security',
            title: '🔎 Watermark Terdeteksi di Perangkat Lain',
            description: `File **${record.productName}** milik **${record.username}** terdeteksi dipakai di perangkat yang BERBEDA dari saat pertama kali di-download.`,
            username: record.username, userId: record.discordId,
            fields: [
              field('🧾 Download ID', record.downloadId, true),
              field('📦 Produk', record.productName, true),
              field('🖥️ Perangkat Asal', record.deviceIdAtDownload?.slice(0, 12) + '…', true),
              field('🖥️ Perangkat Terdeteksi', currentFingerprint.slice(0, 12) + '…', true)
            ],
            appName: APP_NAME,
            footerNote: 'Watermark Detection — informasi saja, TIDAK auto-ban'
          })
        }).catch(() => {});
      }
    }

    return { scanned, alerts };
  }

  // ══════════════════════════════════════════════════════════════════════
  // ADMIN — daftar alert & statistik singkat utk halaman Admin Web.
  // ══════════════════════════════════════════════════════════════════════
  async function listAlerts({ limit = 50, skip = 0, discordId } = {}) {
    const db = getDb();
    if (!db) return { items: [], total: 0 };
    const filter = discordId ? { discordId } : {};
    const [items, total] = await Promise.all([
      db.collection(ALERTS_COLLECTION).find(filter).sort({ detectedAt: -1 }).skip(skip).limit(Math.min(limit, 200)).toArray(),
      db.collection(ALERTS_COLLECTION).countDocuments(filter)
    ]);
    return { items, total };
  }

  async function getStats() {
    const db = getDb();
    if (!db) return { totalWatermarks: 0, totalAlerts: 0, uniqueUsersFlagged: 0 };
    const [totalWatermarks, totalAlerts, uniqueUsersFlagged] = await Promise.all([
      db.collection(WATERMARKS_COLLECTION).countDocuments({}),
      db.collection(ALERTS_COLLECTION).countDocuments({}),
      db.collection(ALERTS_COLLECTION).distinct('discordId').then(a => a.length)
    ]);
    return { totalWatermarks, totalAlerts, uniqueUsersFlagged };
  }

  return { ensureIndexes, issueWatermark, processScanBatch, listAlerts, getStats };
};
