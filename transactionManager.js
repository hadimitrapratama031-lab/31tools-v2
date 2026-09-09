// ══════════════════════════════════════════════════════════════════════════
// TRANSACTION MANAGER — riwayat transaksi Upgrade Paket (Gold/Platinum) lewat
// KlikQRIS. Modul ini CUMA ngurus data & transisi status transaksi yang aman
// dari race condition (atomic, idempotent terhadap webhook duplikat/manual
// refresh yang barengan) — efek ke akun user (ubah role/activeUntil, sinkron
// Discord, notifikasi) tetap dilakukan server.js supaya reuse helper yang
// sudah ada, PERSIS pola yang sama dengan voucherManager.js di project ini.
//
// Status: pending -> completed | failed | expired | cancelled (final, sekali jadi
// final tidak akan berubah lagi — dijaga lewat filter `status:'pending'` di setiap
// findOneAndUpdate transisi, jadi webhook dobel/refresh barengan aman, cuma yang
// PERTAMA kali berhasil transisi yang efeknya dieksekusi server.js).
//
// Cara pakai dari server.js:
//   const transactionManager = require('./transactionManager')({ getDb: () => db });
//   await transactionManager.ensureIndexes();
//   const tx = await transactionManager.createPendingTransaction({...});
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');
const { customAlphabet } = require('nanoid');

const COLLECTION = 'transactions';
const genInvoicePart = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);
// Batas waktu pembayaran per transaksi — sesuai requirement "Waktu 10 menit".
// Ini yang jadi SUMBER KEBENARAN expiry di sisi kita (independen dari expired_at
// yang dibalikin KlikQRIS), supaya konsisten walau KlikQRIS suatu saat ubah durasinya.
const EXPIRY_MS = 10 * 60 * 1000;

function unwrapFindOneAndUpdate(result) {
  if (result && typeof result === 'object' && 'value' in result) return result.value;
  return result || null;
}

module.exports = function createTransactionManager({ getDb }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(COLLECTION).createIndex({ orderId: 1 }, { unique: true }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ discordId: 1, createdAt: -1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ status: 1, expiresAt: 1 }).catch(() => {});
  }

  function generateOrderId() {
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
    return `INV${ymd}${genInvoicePart()}`;
  }

  // Cegah user bikin transaksi baru kalau masih ada transaksi PENDING & belum
  // expired buat dia — supaya tidak numpuk transaksi ganda (dan tidak dobel
  // bayar tanpa sadar). User diarahkan lanjutin transaksi lama itu dulu.
  async function getActivePendingForUser(discordId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({
      discordId, status: 'pending', expiresAt: { $gt: new Date() }
    }, { sort: { createdAt: -1 } });
  }

  async function createPendingTransaction({ discordId, username, tier, amount, method, payment, packageSnapshot }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const now = new Date();
    const doc = {
      orderId: payment.order_id,
      discordId, username: username || null,
      tier,
      amount,
      fee: payment.fee ?? null,
      totalPayment: payment.total_payment ?? amount,
      paymentMethod: payment.payment_method || method,
      paymentNumber: payment.payment_number || null,
      project: payment.project || null,
      // ── field khusus KlikQRIS (undefined/null kalau provider lain) ──
      provider: payment.provider || 'klikqris',
      paymentMode: payment.mode || null,
      qrisUrl: payment.qrisUrl || null,
      qrisImage: payment.qrisImage || null,
      signature: payment.signature || null,
      status: 'pending',
      packageSnapshot, // { durationAmount, durationUnit, benefits, price } saat transaksi dibuat
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

  async function listAll({ status, tier, discordId, q, limit = 100, skip = 0 } = {}) {
    const db = getDb();
    if (!db) return { items: [], total: 0 };
    const filter = {};
    if (status) filter.status = status;
    if (tier) filter.tier = tier;
    if (discordId) filter.discordId = discordId;
    if (q) filter.$or = [
      { orderId: { $regex: q, $options: 'i' } },
      { username: { $regex: q, $options: 'i' } }
    ];
    const [items, total] = await Promise.all([
      db.collection(COLLECTION).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(COLLECTION).countDocuments(filter)
    ]);
    return { items, total };
  }

  // Transisi status atomic — hanya berhasil kalau status SAAT INI masih 'pending'.
  // Dipakai buat webhook, refresh manual, dan sweep expiry — semuanya aman
  // dipanggil barengan/berulang, cuma pemanggil PERTAMA yang dapat `ok:true`.
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
    return { ok: !!doc, transaction: doc };
  }

  async function markActivated(orderId, extra) {
    const db = getDb();
    if (!db) return null;
    await db.collection(COLLECTION).updateOne({ orderId }, { $set: { activatedAt: new Date(), ...extra } });
    return getByOrderId(orderId);
  }

  // Sweep berkala (dipanggil dari setInterval di server.js) — transaksi pending
  // yang sudah lewat expiresAt otomatis ditandai 'expired' di DB kita, TERLEPAS
  // dari apakah user masih buka halaman pembayarannya atau tidak.
  async function sweepExpired() {
    const db = getDb();
    if (!db) return [];
    const now = new Date();
    const candidates = await db.collection(COLLECTION).find({ status: 'pending', expiresAt: { $lte: now } }).toArray();
    const expired = [];
    for (const tx of candidates) {
      const result = await transitionFromPending(tx.orderId, { status: 'expired' });
      if (result.ok) expired.push(result.transaction);
    }
    return expired;
  }

  function publicTransaction(tx) {
    if (!tx) return null;
    return {
      id: String(tx._id),
      orderId: tx.orderId,
      tier: tx.tier,
      amount: tx.amount,
      fee: tx.fee,
      totalPayment: tx.totalPayment,
      paymentMethod: tx.paymentMethod,
      paymentNumber: tx.status === 'pending' ? tx.paymentNumber : undefined,
      qrisUrl: tx.status === 'pending' ? (tx.qrisUrl || null) : undefined,
      qrisImage: tx.status === 'pending' ? (tx.qrisImage || null) : undefined,
      // Field yang SUDAH dipakai App (dari integrasi provider sebelumnya) — App
      // langsung render ini sebagai <img src>. qrisImage (data:image/png;base64,...)
      // diprioritaskan karena tidak perlu request lagi ke server KlikQRIS;
      // qrisUrl dipakai sebagai fallback kalau qrisImage kosong. TANPA field ini,
      // App akan salah generate ulang QR dari teks qrisUrl/paymentNumber (invalid!).
      qrDataUrl: tx.status === 'pending' ? (tx.qrisImage || tx.qrisUrl || null) : undefined,
      provider: tx.provider || 'klikqris',
      status: tx.status,
      createdAt: tx.createdAt,
      expiresAt: tx.expiresAt,
      completedAt: tx.completedAt,
      username: tx.username,
      discordId: tx.discordId,
      // ── Ditambahkan untuk halaman "Transaksi" App Demo (murni EXPOSE data yang
      // SUDAH tersimpan di dokumen ini sejak awal — packageSnapshot diisi saat
      // createPendingTransaction, grantedRole/grantedActiveUntil diisi
      // markActivated setelah pembayaran lunas — TIDAK ADA logic/behavior baru,
      // cuma field ini sebelumnya tidak pernah dikirim ke App). Dipakai untuk
      // menampilkan "Paket Gold • 30 Hari" & "Masa Aktif" di detail transaksi
      // tanpa hardcode di frontend.
      packageSnapshot: tx.packageSnapshot || null,
      grantedRole: tx.grantedRole || null,
      grantedActiveUntil: tx.grantedActiveUntil || null,
      activatedAt: tx.activatedAt || null
    };
  }

  return {
    EXPIRY_MS,
    ensureIndexes, generateOrderId,
    getActivePendingForUser, createPendingTransaction,
    getByOrderId, getById, listByUser, listAll,
    transitionFromPending, markActivated, sweepExpired,
    publicTransaction
  };
};
