// ══════════════════════════════════════════════════════════════════════════
// MARKETPLACE ORDER MANAGER — riwayat pembelian Marketplace Product lewat
// KlikQRIS. Collection Mongo sendiri (`marketplaceOrders`, order_id prefix
// MKT), terpisah dari transactionManager.js (Upgrade Paket) dan
// steamAccountOrderManager.js (Steam Account) — pola & bentuk data SENGAJA
// dibuat sama persis dengan keduanya supaya server.js bisa reuse cara
// pemanggilan (webhook, sweep expiry, dst) tanpa kejutan.
//
// Status: pending -> completed | failed | expired | cancelled (final).
//
// Cara pakai dari server.js:
//   const marketplaceOrderManager = require('./marketplaceOrderManager')({ getDb: () => db });
//   await marketplaceOrderManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');
const { customAlphabet } = require('nanoid');

const COLLECTION = 'marketplaceOrders';
const genInvoicePart = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);
// Sama seperti order lain di sistem ini — batas waktu bayar 10 menit.
const EXPIRY_MS = 10 * 60 * 1000;

function unwrapFindOneAndUpdate(result) {
  if (result && typeof result === 'object' && 'value' in result) return result.value;
  return result || null;
}

module.exports = function createMarketplaceOrderManager({ getDb }) {

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
    return `MKT${ymd}${genInvoicePart()}`;
  }

  // Satu user cuma boleh punya SATU order pending aktif per produk — mencegah
  // invoice ganda menumpuk untuk produk yang sama (Test 15: cegah order
  // duplikat/bug entitlement).
  async function getActivePendingForUser(discordId, productId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({
      discordId, productId, status: 'pending', expiresAt: { $gt: new Date() }
    }, { sort: { createdAt: -1 } });
  }

  async function listActivePendingProductIdsForUser(discordId) {
    const db = getDb();
    if (!db || !discordId) return new Set();
    const rows = await db.collection(COLLECTION).find({
      discordId, status: 'pending', expiresAt: { $gt: new Date() }
    }).project({ productId: 1 }).toArray();
    return new Set(rows.map(r => r.productId));
  }

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
      productSnapshot, // { name, description, price, imageUrl, imageData, badge } saat order dibuat
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
      productSnapshot: o.productSnapshot
    };
  }

  return {
    EXPIRY_MS,
    ensureIndexes, generateOrderId,
    getActivePendingForUser, listActivePendingProductIdsForUser, createPendingOrder,
    getByOrderId, getById, listByUser, listAll,
    transitionFromPending, sweepExpired,
    publicOrder
  };
};
