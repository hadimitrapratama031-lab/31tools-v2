// ══════════════════════════════════════════════════════════════════════════
// STEAM ACCOUNT ORDER MANAGER — riwayat pembelian produk Steam Account
// Marketplace lewat KlikQRIS. Modul ini terpisah dari transactionManager.js
// (Upgrade Paket) — collection Mongo sendiri (`steamAccountOrders`, order_id
// prefix STM), supaya alur pembayaran lain yang sudah jalan tidak disentuh.
//
// Status: pending -> completed | failed | expired | cancelled (final).
//
// Cara pakai dari server.js:
//   const steamAccountOrderManager = require('./steamAccountOrderManager')({ getDb: () => db });
//   await steamAccountOrderManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');
const { customAlphabet } = require('nanoid');

const COLLECTION = 'steamAccountOrders';
const genInvoicePart = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);
// Sama seperti order Upgrade Paket — batas waktu bayar 10 menit.
const EXPIRY_MS = 10 * 60 * 1000;

function unwrapFindOneAndUpdate(result) {
  if (result && typeof result === 'object' && 'value' in result) return result.value;
  return result || null;
}

module.exports = function createSteamAccountOrderManager({ getDb }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(COLLECTION).createIndex({ orderId: 1 }, { unique: true }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ discordId: 1, createdAt: -1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ status: 1, expiresAt: 1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ productId: 1 }).catch(() => {});
  }

  function generateOrderId() {
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
    return `STM${ymd}${genInvoicePart()}`;
  }

  // Satu user cuma boleh punya SATU order pending aktif per akun Steam yang
  // sama di satu waktu — biar tidak numpuk invoice ganda buat akun yang sama.
  async function getActivePendingForUser(discordId, productId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({
      discordId, productId, status: 'pending', expiresAt: { $gt: new Date() }
    }, { sort: { createdAt: -1 } });
  }

  // Semua productId yang punya order PENDING aktif milik 1 user — 1 query,
  // dipakai listing App biar tombol produk bisa langsung tampil "PEMBAYARAN
  // DIPROSES" tanpa N query per produk (lihat steamAccountManager.listPublicForUser).
  async function listActivePendingProductIdsForUser(discordId) {
    const db = getDb();
    if (!db || !discordId) return new Set();
    const rows = await db.collection(COLLECTION).find({
      discordId, status: 'pending', expiresAt: { $gt: new Date() }
    }).project({ productId: 1 }).toArray();
    return new Set(rows.map(r => r.productId));
  }

  // CATATAN: dulu ada getAnyActivePendingForProduct() yang mencegah 2 user
  // berbeda sama-sama punya invoice pending buat 1 akun yang sama — itu HANYA
  // relevan waktu akun bersifat 1x-jual (SOLD). Sekarang Steam Account adalah
  // UNLIMITED USER / SHARED PRODUCT (lihat steamAccountManager.js), jadi
  // banyak user BOLEH punya order pending untuk akun yang sama secara
  // bersamaan — fungsi itu dihapus sepenuhnya, bukan cuma tidak dipanggil.

  async function createPendingOrder({ discordId, username, productId, productName, amount, method, payment, productSnapshot }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const now = new Date();
    const doc = {
      orderId: payment.order_id,
      discordId, username: username || null,
      productId, productName,
      amount,
      fee: payment.fee ?? null,
      totalPayment: payment.total_payment ?? amount,
      paymentMethod: payment.payment_method || method,
      paymentNumber: payment.payment_number || null,
      project: payment.project || null,
      provider: payment.provider || 'klikqris',
      paymentMode: payment.mode || null,
      qrisUrl: payment.qrisUrl || null,
      qrisImage: payment.qrisImage || null,
      signature: payment.signature || null,
      status: 'pending',
      productSnapshot, // { name, description, price, imageData, imageUrl, gamesCount } saat order dibuat
      discordTicket: null,
      createdAt: now,
      expiresAt: new Date(Math.min(
        now.getTime() + EXPIRY_MS,
        payment.expired_at ? new Date(payment.expired_at).getTime() : Infinity
      )),
      completedAt: null,
      updatedAt: now
    };
    await db.collection(COLLECTION).insertOne(doc);
    return doc;
  }

  async function getByOrderId(orderId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({ orderId });
  }

  async function getById(id) {
    const db = getDb();
    if (!db || !ObjectId.isValid(id)) return null;
    return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
  }

  async function listByUser(discordId, { limit = 50 } = {}) {
    const db = getDb();
    if (!db) return [];
    return db.collection(COLLECTION).find({ discordId }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  // PERF FIX: sama seperti transactionManager.listAll — `productSnapshot`
  // (imageData base64) & `qrisImage` bikin list admin lambat padahal tabel
  // Order di Admin Web tidak pernah menampilkannya (lihat staOrderRowHtml di
  // admin.js). `lite: true` exclude keduanya di query-level. publicOrder()
  // biasa (dipakai App buat halaman bayar) tidak berubah sama sekali.
  async function listAll({ status, discordId, q, limit = 100, skip = 0, lite = false } = {}) {
    const db = getDb();
    if (!db) return { items: [], total: 0 };
    const filter = {};
    if (status) filter.status = status;
    if (discordId) filter.discordId = discordId;
    if (q) filter.$or = [
      { orderId: { $regex: q, $options: 'i' } },
      { username: { $regex: q, $options: 'i' } },
      { productName: { $regex: q, $options: 'i' } }
    ];
    const findOptions = lite ? { projection: { qrisImage: 0, 'productSnapshot.imageData': 0 } } : undefined;
    const [items, total] = await Promise.all([
      db.collection(COLLECTION).find(filter, findOptions).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(COLLECTION).countDocuments(filter)
    ]);
    return { items, total };
  }

  // Transisi status atomic — sama pola persis transactionManager.
  async function transitionFromPending(orderId, { status, paymentMethod, completedAt, extra = {} }) {
    const db = getDb();
    if (!db) return { ok: false };
    const set = { status, updatedAt: new Date(), ...extra };
    if (paymentMethod) set.paymentMethod = paymentMethod;
    if (completedAt) set.completedAt = new Date(completedAt);
    const result = await db.collection(COLLECTION).findOneAndUpdate(
      { orderId, status: 'pending' },
      { $set: set },
      { returnDocument: 'after' }
    );
    const doc = unwrapFindOneAndUpdate(result);
    return { ok: !!doc, order: doc };
  }

  async function setDiscordTicket(orderId, discordTicket) {
    const db = getDb();
    if (!db) return null;
    await db.collection(COLLECTION).updateOne({ orderId }, { $set: { discordTicket, updatedAt: new Date() } });
    return getByOrderId(orderId);
  }

  async function sweepExpired() {
    const db = getDb();
    if (!db) return [];
    const now = new Date();
    const candidates = await db.collection(COLLECTION).find({ status: 'pending', expiresAt: { $lte: now } }).toArray();
    const expired = [];
    for (const o of candidates) {
      const result = await transitionFromPending(o.orderId, { status: 'expired' });
      if (result.ok) expired.push(result.order);
    }
    return expired;
  }

  function publicOrder(o) {
    if (!o) return null;
    return {
      id: String(o._id),
      orderId: o.orderId,
      productId: o.productId,
      productName: o.productName,
      amount: o.amount,
      fee: o.fee,
      totalPayment: o.totalPayment,
      paymentMethod: o.paymentMethod,
      paymentNumber: o.status === 'pending' ? o.paymentNumber : undefined,
      qrisUrl: o.status === 'pending' ? (o.qrisUrl || null) : undefined,
      qrisImage: o.status === 'pending' ? (o.qrisImage || null) : undefined,
      qrDataUrl: o.status === 'pending' ? (o.qrisImage || o.qrisUrl || null) : undefined,
      provider: o.provider || 'klikqris',
      status: o.status,
      createdAt: o.createdAt,
      expiresAt: o.expiresAt,
      completedAt: o.completedAt,
      username: o.username,
      discordId: o.discordId,
      discordTicket: o.discordTicket || null,
      productSnapshot: o.productSnapshot
    };
  }

  return {
    EXPIRY_MS,
    ensureIndexes, generateOrderId,
    getActivePendingForUser, listActivePendingProductIdsForUser, createPendingOrder,
    getByOrderId, getById, listByUser, listAll,
    transitionFromPending, setDiscordTicket, sweepExpired,
    publicOrder
  };
};
