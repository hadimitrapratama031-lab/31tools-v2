// ══════════════════════════════════════════════════════════════════════════
// MARKETPLACE MANAGER — Product, Content (Game/Bypass link), dan Access
// (Purchase/Whitelist entitlement) untuk fitur Marketplace.
//
// Marketplace TIDAK memakai hierarki role/paket (public/gold/platinum) sama
// sekali untuk kontennya — akses ke Game/Bypass yang terhubung ke sebuah
// Marketplace Product HANYA ditentukan lewat dua jalur:
//   A. PURCHASE — user membeli Product via KlikQRIS (lihat marketplaceOrderManager.js)
//   B. WHITELIST — admin memberi akses manual per Discord ID
// Keduanya disimpan di SATU collection `marketplaceAccess` dengan field
// `source: 'purchase' | 'whitelist'` — satu user hanya boleh punya SATU
// record akses per produk (unique index discordId+productId), jadi tidak ada
// akses purchase & whitelist berjalan berdampingan/duplikat untuk produk yang
// sama; keduanya cukup diwakili satu record (source terakhir yang berlaku).
//
// Koleksi:
//   marketplaceProducts — { name, price, description, badge, status,
//                            image, additionalImages, imageUrl (kompat),
//                            salesCount, requiredProductId, createdAt, updatedAt }
//                          Gambar: file di Cloudflare R2, DB cuma referensi —
//                          lihat marketplaceImages.js. `imageData` (base64)
//                          LEGACY, dihapus oleh migrate-marketplace-images.js.
//   marketplaceContent  — { productId, contentType: 'game'|'bypass', itemId, createdAt }
//                          (tabel relasi many-to-many Product <-> Game/Bypass)
//   marketplaceAccess   — { discordId, username, productId, productName,
//                            source, grantedBy, createdAt, updatedAt }
//
// GATING ANTAR-PRODUCT (`requiredProductId`): satu Product BOLEH mensyaratkan
// SATU Product lain (Game/Bypass) sudah dimiliki user sebelum bisa dibeli —
// dipakai App buat munculkan modal "Akses Belum Tersedia" SEBELUM order
// dibuat (lihat openMktLockedModal() di app.js). `requiredProductId` diisi
// admin lewat form Edit Product (dropdown pilih Product lain). Field `type`
// ('game'/'bypass') pada requirement TIDAK disimpan manual — diturunkan
// OTOMATIS dari isi `marketplaceContent` milik Product requirement tsb
// (lihat getRequirementInfoMap() di bawah): kalau isinya lebih banyak Game,
// dianggap 'game'; kalau lebih banyak/campuran/kosong, default 'bypass'
// (kasus paling umum di Marketplace ini). Cycle langsung (A<->B saling
// membutuhkan) ditolak saat create/update — cycle lebih panjang (A→B→C→A)
// SENGAJA belum dicek (di luar scope saat ini).
//
// PENTING soal Game/Bypass yang terhubung ke Marketplace: field
// `marketplaceProductIds` (array of productId string) DI-DENORMALISASI
// langsung ke dokumen `games`/`bypasses` setiap kali content ditambah/dihapus
// di sini — supaya endpoint /api/games & /api/bypasses (dan hasCatalogAccess
// di server.js) bisa cek "item ini di-gate Marketplace atau tidak" tanpa
// query JOIN tambahan per item (hindari N+1 query, lihat requirement
// performa). `marketplaceContent` tetap jadi sumber kebenaran utama (dipakai
// listing "Kelola Konten"); field di games/bypasses murni cache turunan.
//
// Cara pakai dari server.js:
//   const marketplaceManager = require('./marketplaceManager')({ getDb: () => db });
//   await marketplaceManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');
const marketplaceImages = require('./marketplaceImages');

const PRODUCTS_COLLECTION = 'marketplaceProducts';
const CONTENT_COLLECTION = 'marketplaceContent';
const ACCESS_COLLECTION = 'marketplaceAccess';

const PRODUCT_STATUSES = ['active', 'inactive'];
const CONTENT_TYPES = ['game', 'bypass'];

function oid(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

module.exports = function createMarketplaceManager({ getDb }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(PRODUCTS_COLLECTION).createIndex({ status: 1 }).catch(() => {});
    await db.collection(PRODUCTS_COLLECTION).createIndex({ createdAt: -1 }).catch(() => {});
    await db.collection(CONTENT_COLLECTION).createIndex({ productId: 1, contentType: 1, itemId: 1 }, { unique: true }).catch(() => {});
    await db.collection(CONTENT_COLLECTION).createIndex({ contentType: 1, itemId: 1 }).catch(() => {});
    // Unique index INI yang mencegah duplikasi akses (Test 14: "coba duplicate
    // whitelist harus ditolak dengan aman") — satu user+produk cuma satu record,
    // grantAccess() di bawah pakai upsert jadi "duplicate" otomatis jadi update
    // biasa, bukan error/duplikat baris baru.
    await db.collection(ACCESS_COLLECTION).createIndex({ discordId: 1, productId: 1 }, { unique: true }).catch(() => {});
    await db.collection(ACCESS_COLLECTION).createIndex({ productId: 1 }).catch(() => {});
    await db.collection(ACCESS_COLLECTION).createIndex({ discordId: 1 }).catch(() => {});
  }

  // ────────────────────────────────────────────────────────────────────────
  // PRODUCT
  // ────────────────────────────────────────────────────────────────────────

  function publicProduct(p, extra = {}) {
    if (!p) return null;
    return {
      id: String(p._id),
      _id: p._id,
      name: p.name,
      price: p.price,
      description: p.description || '',
      badge: p.badge || null,
      status: p.status || 'active',
      // Canonical image reference (URL publik R2). TIDAK ADA imageData di sini.
      ...marketplaceImages.publicImageFields(p),
      salesCount: p.salesCount || 0,
      requiredProductId: p.requiredProductId ? String(p.requiredProductId) : null,
      createdAt: p.createdAt || null,
      updatedAt: p.updatedAt || null,
      ...extra
    };
  }

  async function listProducts({ status, q, limit = 200, skip = 0 } = {}) {
    const db = getDb();
    if (!db) return { items: [], total: 0 };
    const filter = {};
    // ROOT CAUSE FIX (product lama "tidak bisa dihapus"): produk yang sudah
    // pernah punya order/akses di-soft-delete (status:'deleted', lihat
    // softDeleteProduct di bawah) supaya histori transaksi & whitelist tetap
    // aman. Listing Admin Web default HARUS menyembunyikan status 'deleted'
    // ini — kalau tidak, produk yang barusan "dihapus" akan tetap tampil di
    // grid (persis gejala yang dilaporkan: "product muncul kembali setelah
    // refresh"). Admin tetap bisa audit produk yang sudah dihapus lewat
    // filter status=deleted secara eksplisit (dropdown "Dihapus").
    if (status === 'deleted') {
      filter.status = 'deleted';
    } else if (status && PRODUCT_STATUSES.includes(status)) {
      filter.status = status;
    } else {
      filter.status = { $ne: 'deleted' };
    }
    if (q && q.trim()) filter.name = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [items, total] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(PRODUCTS_COLLECTION).countDocuments(filter)
    ]);
    return { items, total };
  }

  // Produk AKTIF saja — dipakai App (Product On Sale + New Games).
  async function listActiveProducts() {
    const db = getDb();
    if (!db) return [];
    return db.collection(PRODUCTS_COLLECTION).find({ status: 'active' }).sort({ createdAt: -1 }).toArray();
  }

  async function getProductById(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) return null;
    return db.collection(PRODUCTS_COLLECTION).findOne({ _id });
  }

  // Validasi `requiredProductId`: harus Product lain yang masih ada (bukan
  // 'deleted'), bukan diri sendiri, dan tidak membentuk cycle langsung
  // (kalau target requirement-nya sendiri sudah mensyaratkan produk ini —
  // A butuh B DAN B butuh A sekaligus ditolak). Return null kalau input
  // kosong ('' / null / undefined) — berarti admin melepas requirement.
  async function validateRequiredProductId(requiredProductId, selfId) {
    if (requiredProductId === undefined) return undefined; // tidak diubah
    if (!requiredProductId) return null; // dilepas
    const db = getDb();
    const reqId = oid(requiredProductId);
    if (!reqId) throw new Error('Produk requirement tidak valid.');
    if (selfId && String(reqId) === String(selfId)) throw new Error('Produk tidak boleh mensyaratkan dirinya sendiri.');
    const reqProduct = await db.collection(PRODUCTS_COLLECTION).findOne({ _id: reqId, status: { $ne: 'deleted' } });
    if (!reqProduct) throw new Error('Produk requirement tidak ditemukan.');
    if (selfId && reqProduct.requiredProductId && String(reqProduct.requiredProductId) === String(selfId)) {
      throw new Error('Tidak bisa saling membutuhkan (circular requirement) dengan produk tersebut.');
    }
    return String(reqId);
  }

  async function createProduct({ name, price, description, badge, status, requiredProductId }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const n = String(name || '').trim();
    if (!n) throw new Error('Nama produk wajib diisi.');
    const p = Math.round(Number(price));
    if (!Number.isFinite(p) || p <= 0) throw new Error('Harga produk tidak valid.');
    const reqProductId = await validateRequiredProductId(requiredProductId, null);
    const now = new Date();
    const doc = {
      name: n,
      price: p,
      description: String(description || '').trim(),
      badge: badge ? String(badge).trim().slice(0, 24) : null,
      status: PRODUCT_STATUSES.includes(status) ? status : 'active',
      image: null,
      additionalImages: [],
      imageUrl: null,
      salesCount: 0,
      requiredProductId: reqProductId || null,
      createdAt: now,
      updatedAt: now
    };
    const result = await db.collection(PRODUCTS_COLLECTION).insertOne(doc);
    doc._id = result.insertedId;
    return doc;
  }

  async function updateProduct(id, { name, price, description, badge, status, requiredProductId }) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const set = { updatedAt: new Date() };
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new Error('Nama produk wajib diisi.');
      set.name = n;
    }
    if (price !== undefined) {
      const p = Math.round(Number(price));
      if (!Number.isFinite(p) || p <= 0) throw new Error('Harga produk tidak valid.');
      set.price = p;
    }
    if (description !== undefined) set.description = String(description || '').trim();
    if (badge !== undefined) set.badge = badge ? String(badge).trim().slice(0, 24) : null;
    if (status !== undefined) {
      if (!PRODUCT_STATUSES.includes(status)) throw new Error('Status produk tidak valid.');
      set.status = status;
    }
    // Gambar TIDAK diubah lewat updateProduct — pakai setMainImage/
    // addAdditionalImage/... di bawah (upload ke R2 dulu, baru DB).
    if (requiredProductId !== undefined) {
      set.requiredProductId = await validateRequiredProductId(requiredProductId, _id);
    }

    const result = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id }, { $set: set }, { returnDocument: 'after' }
    );
    const doc = (result && typeof result === 'object' && 'value' in result) ? result.value : result;
    if (!doc) throw new Error('Produk tidak ditemukan.');

    // Nama produk snapshot ikut disinkronkan ke record akses yang sudah ada
    // (biar riwayat/Admin Web whitelist tidak menampilkan nama produk basi
    // setelah di-rename) — best effort, tidak fatal kalau gagal.
    if (name !== undefined) {
      await db.collection(ACCESS_COLLECTION).updateMany(
        { productId: String(_id) }, { $set: { productName: doc.name } }
      ).catch(() => {});
    }
    return doc;
  }


  // ────────────────────────────────────────────────────────────────────────
  // PRODUCT IMAGES (R2) — urutan aman: object BARU sudah ada di R2 (di-upload
  // & diverifikasi marketplaceImages.uploadProductImage) → baru update DB →
  // baru pemanggil menghapus object LAMA. Method di sini murni update DB dan
  // mengembalikan referensi lama supaya object lama bisa dibersihkan.
  // ────────────────────────────────────────────────────────────────────────

  function unwrap(result) {
    return (result && typeof result === 'object' && 'value' in result) ? result.value : result;
  }

  // Ganti main image. Mengembalikan { product, previous } — `previous` =
  // referensi main lama (key R2 kalau ada) untuk dihapus SETELAH ini sukses.
  async function setMainImage(id, ref) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const before = await db.collection(PRODUCTS_COLLECTION).findOne({ _id });
    if (!before) throw new Error('Produk tidak ditemukan.');
    const res = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id },
      { $set: { image: ref, imageUrl: ref.url, updatedAt: new Date() }, $unset: { imageData: '' } },
      { returnDocument: 'after' }
    );
    const product = unwrap(res);
    if (!product) throw new Error('Produk tidak ditemukan.');
    return { product, previous: before.image || null };
  }

  async function clearMainImage(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const before = await db.collection(PRODUCTS_COLLECTION).findOne({ _id });
    if (!before) throw new Error('Produk tidak ditemukan.');
    const res = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id },
      { $set: { image: null, imageUrl: null, updatedAt: new Date() }, $unset: { imageData: '' } },
      { returnDocument: 'after' }
    );
    return { product: unwrap(res), previous: before.image || null };
  }

  // Tambah additional image. Batas maks dijaga ATOMIC di query update (bukan
  // percaya frontend, dan aman dari race dua upload bersamaan). Kalau
  // replaceId diberikan, entri itu diganti di tempat (tidak menambah jumlah).
  async function addAdditionalImage(id, ref, { replaceId } = {}) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const max = marketplaceImages.MAX_ADDITIONAL_IMAGES;
    if (replaceId) {
      const res = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
        { _id, 'additionalImages.id': replaceId },
        { $set: { 'additionalImages.$': ref, updatedAt: new Date() } },
        { returnDocument: 'before' }
      );
      const beforeDoc = unwrap(res);
      if (!beforeDoc) throw new Error('Gambar tambahan yang mau diganti tidak ditemukan.');
      const previous = (beforeDoc.additionalImages || []).find(a => a.id === replaceId) || null;
      return { product: await getProductById(id), previous };
    }
    const res = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id, $expr: { $lt: [{ $size: { $ifNull: ['$additionalImages', []] } }, max] } },
      { $push: { additionalImages: ref }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const product = unwrap(res);
    if (!product) {
      const exists = await db.collection(PRODUCTS_COLLECTION).findOne({ _id }, { projection: { _id: 1 } });
      throw new Error(exists ? `Maksimal ${max} gambar tambahan per produk.` : 'Produk tidak ditemukan.');
    }
    return { product, previous: null };
  }

  async function removeAdditionalImage(id, imageId) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const res = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id, 'additionalImages.id': imageId },
      { $pull: { additionalImages: { id: imageId } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'before' }
    );
    const beforeDoc = unwrap(res);
    if (!beforeDoc) throw new Error('Gambar tambahan tidak ditemukan.');
    const previous = (beforeDoc.additionalImages || []).find(a => a.id === imageId) || null;
    return { product: await getProductById(id), previous };
  }

  // Dipakai script migration/health/audit: semua produk (termasuk deleted).
  async function listAllProductsRaw() {
    const db = getDb();
    return db.collection(PRODUCTS_COLLECTION).find({}).toArray();
  }

  // Set field hasil migration/repair secara atomic per produk.
  async function applyImageMigration(id, { image, additionalImages }) {
    const db = getDb();
    const _id = oid(id);
    const set = { updatedAt: new Date() };
    if (image) { set.image = image; set.imageUrl = image.url; }
    if (additionalImages) set.additionalImages = additionalImages;
    await db.collection(PRODUCTS_COLLECTION).updateOne({ _id }, { $set: set });
  }
  async function removeLegacyImageFields(id) {
    const db = getDb();
    await db.collection(PRODUCTS_COLLECTION).updateOne({ _id: oid(id) }, { $unset: { imageData: '' } });
  }

  // Cek dependency sebelum hard-delete (requirement #8: jangan sampai
  // transaksi lama rusak). Dipanggil server.js SEBELUM memutuskan hard-delete
  // vs cuma set status inactive.
  async function getProductDependency(id) {
    const db = getDb();
    const productId = String(id);
    if (!db) return { hasOrders: false, hasAccess: false, contentCount: 0 };
    const [orderCount, accessCount, contentCount] = await Promise.all([
      db.collection('marketplaceOrders').countDocuments({ productId }).catch(() => 0),
      db.collection(ACCESS_COLLECTION).countDocuments({ productId }),
      db.collection(CONTENT_COLLECTION).countDocuments({ productId })
    ]);
    return { hasOrders: orderCount > 0, hasAccess: accessCount > 0, contentCount, orderCount, accessCount };
  }

  // Hard delete — HANYA dipanggil server.js kalau dependency check di atas
  // aman (tidak ada order/akses yang bergantung), atau admin secara eksplisit
  // memaksa (force) — dalam hal ini server.js yang memutuskan kebijakannya,
  // fungsi ini murni eksekusi + bersih-bersih relasi supaya tidak jadi data
  // yatim (orphan) di `marketplaceContent`/`marketplaceAccess`, dan melepas
  // `marketplaceProductIds` dari games/bypasses yang masih menunjuk ke sini.
  //
  // CASCADE Game/Bypass MILIK product ini (§ update "Delete Product ikut hapus
  // Game/Bypass"): sebuah Game/Bypass dianggap "milik" product HANYA kalau
  // field `ownerMarketplaceProductId`-nya persis sama dengan productId ini —
  // field ini cuma diisi sekali, SAAT DIBUAT, lewat tombol "+ Tambah Game/Bypass
  // Baru" di drawer Kelola Konten Product (lihat POST /api/admin/games &
  // POST /api/admin/bypasses). Item yang cuma DIHUBUNGKAN lewat "Hubungkan
  // Existing" TIDAK PERNAH punya field ini terisi ke product ini, jadi tidak
  // ikut terhapus — cuma relasinya yang dilepas seperti sebelumnya. Ini yang
  // mencegah Game/Bypass "global" (dipakai fitur/role lain, atau dibagi ke
  // lebih dari satu Product) ikut kehapus gara-gara kebetulan direferensikan.
  async function deleteProduct(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const productId = String(_id);
    const existing = await db.collection(PRODUCTS_COLLECTION).findOne({ _id });
    const imageKeys = marketplaceImages.ownedKeys(existing);
    const links = await db.collection(CONTENT_COLLECTION).find({ productId }).toArray();

    const deletedGameIds = [];
    const deletedBypassIds = [];
    for (const link of links) {
      const collName = contentCollectionName(link.contentType);
      const itemOid = oid(link.itemId);
      const item = itemOid ? await db.collection(collName).findOne(
        { _id: itemOid }, { projection: { ownerMarketplaceProductId: 1 } }
      ) : null;
      if (item && item.ownerMarketplaceProductId === productId) {
        // Item ini memang dibuat khusus untuk product ini — hapus tuntas
        // (bukan cuma lepas relasi), sesuai requirement cascade delete.
        await db.collection(collName).deleteOne({ _id: itemOid });
        if (link.contentType === 'bypass') deletedBypassIds.push(link.itemId);
        else deletedGameIds.push(link.itemId);
      } else {
        // Item hasil "Hubungkan Existing" (atau owner-nya product lain) —
        // JANGAN dihapus, cukup lepas relasi & cache marketplaceProductIds-nya.
        await pullProductIdFromItem(link.contentType, link.itemId, productId);
      }
    }
    await db.collection(CONTENT_COLLECTION).deleteMany({ productId });
    await db.collection(ACCESS_COLLECTION).deleteMany({ productId });
    await db.collection(PRODUCTS_COLLECTION).deleteOne({ _id });
    // imageKeys dikembalikan supaya pemanggil menghapus object R2 SETELAH
    // dokumen produk benar-benar terhapus (DB dulu, R2 kemudian).
    return { deletedGameIds, deletedBypassIds, imageKeys };
  }

  // ROOT CAUSE FIX: dipanggil server.js untuk SEMUA produk (lama maupun baru)
  // yang punya dependency (order dan/atau akses) saat admin klik Delete —
  // menggantikan alur lama yang diam-diam cuma mengubah status jadi
  // 'inactive' tanpa pernah benar-benar menghilang dari listing Admin Web.
  // Produk TIDAK dihapus dari database (marketplaceOrders/Content/Access
  // tetap utuh, histori transaksi & whitelist aman — requirement #4/#8),
  // hanya ditandai status:'deleted' supaya listProducts() di atas
  // menyembunyikannya dari listing default — perilaku yang dari sudut
  // pandang Admin Web SAMA PERSIS dengan hard delete (requirement #17).
  async function softDeleteProduct(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const result = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id },
      { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const doc = (result && typeof result === 'object' && 'value' in result) ? result.value : result;
    if (!doc) throw new Error('Produk tidak ditemukan.');
    return doc;
  }

  // Pulihkan produk yang sudah di-soft-delete (dikembalikan ke 'inactive' —
  // admin yang aktifkan lagi lewat Edit Product kalau memang mau dijual lagi).
  async function restoreProduct(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Produk tidak ditemukan.');
    const result = await db.collection(PRODUCTS_COLLECTION).findOneAndUpdate(
      { _id },
      { $set: { status: 'inactive', updatedAt: new Date() }, $unset: { deletedAt: '' } },
      { returnDocument: 'after' }
    );
    const doc = (result && typeof result === 'object' && 'value' in result) ? result.value : result;
    if (!doc) throw new Error('Produk tidak ditemukan.');
    return doc;
  }

  async function incrementSalesCount(productId, by = 1) {
    const db = getDb();
    if (!db) return;
    await db.collection(PRODUCTS_COLLECTION).updateOne(
      { _id: oid(productId) }, { $inc: { salesCount: by } }
    ).catch(() => {});
  }

  // ────────────────────────────────────────────────────────────────────────
  // CONTENT (Game/Bypass link) — pakai Game/Bypass EXISTING, tidak membuat
  // sistem katalog baru. Fungsi ini cuma menghubungkan/melepas relasi, dan
  // menjaga `marketplaceProductIds` di dokumen games/bypasses tetap sinkron.
  // ────────────────────────────────────────────────────────────────────────

  function contentCollectionName(contentType) {
    return contentType === 'bypass' ? 'bypasses' : 'games';
  }

  async function pushProductIdToItem(contentType, itemId, productId) {
    const db = getDb();
    const _id = oid(itemId);
    if (!db || !_id) return;
    await db.collection(contentCollectionName(contentType)).updateOne(
      { _id }, { $addToSet: { marketplaceProductIds: String(productId) } }
    );
  }

  async function pullProductIdFromItem(contentType, itemId, productId) {
    const db = getDb();
    const _id = oid(itemId);
    if (!db || !_id) return;
    await db.collection(contentCollectionName(contentType)).updateOne(
      { _id }, { $pull: { marketplaceProductIds: String(productId) } }
    );
  }

  async function listContent(productId) {
    const db = getDb();
    if (!db) return { games: [], bypasses: [] };
    const links = await db.collection(CONTENT_COLLECTION).find({ productId: String(productId) }).toArray();
    const gameIds = links.filter(l => l.contentType === 'game').map(l => oid(l.itemId)).filter(Boolean);
    const bypassIds = links.filter(l => l.contentType === 'bypass').map(l => oid(l.itemId)).filter(Boolean);
    const [games, bypasses] = await Promise.all([
      gameIds.length ? db.collection('games').find({ _id: { $in: gameIds } }).toArray() : [],
      bypassIds.length ? db.collection('bypasses').find({ _id: { $in: bypassIds } }).toArray() : []
    ]);
    return {
      games: games.map(g => ({ _id: g._id, name: g.name, imageUrl: g.imageUrl || null, appId: g.appId || null })),
      bypasses: bypasses.map(b => ({ _id: b._id, name: b.name, imageUrl: b.imageUrl || null, appId: b.appId || b.steamAppId || null }))
    };
  }

  async function addContent(productId, contentType, itemId) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!CONTENT_TYPES.includes(contentType)) throw new Error('Tipe konten tidak valid.');
    const _itemId = oid(itemId);
    if (!_itemId) throw new Error('Item tidak valid.');
    const item = await db.collection(contentCollectionName(contentType)).findOne({ _id: _itemId });
    if (!item) throw new Error(`${contentType === 'bypass' ? 'Bypass' : 'Game'} tidak ditemukan.`);

    const productIdStr = String(productId);
    try {
      await db.collection(CONTENT_COLLECTION).insertOne({
        productId: productIdStr, contentType, itemId: String(_itemId), createdAt: new Date()
      });
    } catch (e) {
      if (e.code === 11000) throw new Error(`${item.name} sudah ada di produk ini.`);
      throw e;
    }
    await pushProductIdToItem(contentType, _itemId, productIdStr);
    return { name: item.name };
  }

  async function removeContent(productId, contentType, itemId) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const productIdStr = String(productId);
    const itemIdStr = String(itemId);
    const result = await db.collection(CONTENT_COLLECTION).deleteOne({ productId: productIdStr, contentType, itemId: itemIdStr });
    // Melepas hubungan Marketplace — Game/Bypass ASLI tidak disentuh sama
    // sekali (tetap ada di collection games/bypasses), cuma link + cache
    // marketplaceProductIds yang dihapus (requirement #29).
    await pullProductIdFromItem(contentType, itemIdStr, productIdStr);
    return result.deletedCount > 0;
  }

  // ────────────────────────────────────────────────────────────────────────
  // REQUIREMENT (gating antar-Product — lihat catatan `requiredProductId` di
  // header file). Batch by design (dipanggil dari GET /api/marketplace/products
  // yang bisa punya banyak produk sekaligus) supaya tidak N+1 query — sama
  // filosofinya dengan getOwnedProductIdSet() di atas.
  // ────────────────────────────────────────────────────────────────────────

  // requiredProductIds: array productId (string) yang mau di-resolve.
  // Return: Map<productId, { productId, productName, type }> — TANPA field
  // `available`, karena itu tergantung user yang login (caller di server.js
  // tinggal cek productId ini ada di ownedProductIds Set milik user, yang
  // memang sudah di-fetch sekali di endpoint listing — tidak perlu query lagi).
  async function getRequirementInfoMap(requiredProductIds) {
    const map = new Map();
    const ids = [...new Set((requiredProductIds || []).filter(Boolean).map(String))];
    const db = getDb();
    if (!db || !ids.length) return map;

    const objIds = ids.map(oid).filter(Boolean);
    const [reqProducts, contentLinks] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).find({ _id: { $in: objIds }, status: { $ne: 'deleted' } }).toArray(),
      db.collection(CONTENT_COLLECTION).find({ productId: { $in: ids } }).project({ productId: 1, contentType: 1 }).toArray()
    ]);

    // Hitung jumlah item Game vs Bypass per productId requirement — dasar
    // penentuan `type` OTOMATIS (bukan field kategori manual di Product).
    const counts = {};
    for (const link of contentLinks) {
      const pid = String(link.productId);
      if (!counts[pid]) counts[pid] = { game: 0, bypass: 0 };
      counts[pid][link.contentType] = (counts[pid][link.contentType] || 0) + 1;
    }

    for (const rp of reqProducts) {
      const pid = String(rp._id);
      const c = counts[pid] || { game: 0, bypass: 0 };
      // Lebih banyak Game -> 'game'. Selain itu (lebih banyak Bypass,
      // campuran/seri, atau kosong sama sekali) -> default 'bypass', kasus
      // paling umum untuk produk requirement di Marketplace ini.
      const type = c.game > c.bypass ? 'game' : 'bypass';
      map.set(pid, { productId: pid, productName: rp.name, type });
    }
    return map;
  }

  // Versi single-product, dipakai endpoint detail (GET /:id) yang cuma perlu
  // resolve satu requirement sekaligus.
  async function getRequirementInfo(requiredProductId) {
    if (!requiredProductId) return null;
    const map = await getRequirementInfoMap([requiredProductId]);
    return map.get(String(requiredProductId)) || null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // ACCESS (Purchase / Whitelist entitlement)
  // ────────────────────────────────────────────────────────────────────────

  function publicAccess(a) {
    if (!a) return null;
    return {
      discordId: a.discordId,
      username: a.username || a.discordId,
      productId: a.productId,
      productName: a.productName || null,
      source: a.source || 'whitelist',
      grantedBy: a.grantedBy || null,
      createdAt: a.createdAt || null,
      updatedAt: a.updatedAt || null
    };
  }

  // Upsert — SATU record per discordId+productId (lihat unique index di
  // ensureIndexes). Dipanggil baik saat pembelian lunas (source:'purchase')
  // maupun saat admin memberi whitelist (source:'whitelist'). Kalau user
  // sudah punya akses 'whitelist' lalu MEMBELI produk yang sama, source
  // otomatis pindah ke 'purchase' (dan sebaliknya kalau admin whitelist user
  // yang sudah pernah beli — source jadi 'whitelist', TAPI akses tidak
  // pernah hilang di antara transisi ini karena upsert, bukan delete+insert).
  async function grantAccess({ discordId, username, productId, productName, grantedBy = 'system', source = 'purchase' }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    const now = new Date();
    await db.collection(ACCESS_COLLECTION).updateOne(
      { discordId: String(discordId), productId: String(productId) },
      {
        $set: {
          username: username || String(discordId), productName: productName || null,
          source, grantedBy, updatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );
    return getAccess(discordId, productId);
  }

  async function getAccess(discordId, productId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(ACCESS_COLLECTION).findOne({ discordId: String(discordId), productId: String(productId) });
  }

  // Hard delete — dipakai tombol "Cabut Whitelist" DAN kalau admin
  // "menghapus" akses purchase (dengan peringatan eksplisit di UI). deleteMany
  // (bukan deleteOne) sengaja dipakai supaya idempotent & tuntas kalau
  // (secara teori) ada lebih dari satu baris nyasar untuk kombinasi yang sama.
  async function revokeAccess(discordId, productId) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    const result = await db.collection(ACCESS_COLLECTION).deleteMany({
      discordId: String(discordId), productId: String(productId)
    });
    return result.deletedCount || 0;
  }

  async function listAccessByProduct(productId) {
    const db = getDb();
    if (!db) return [];
    return db.collection(ACCESS_COLLECTION).find({ productId: String(productId) }).sort({ createdAt: -1 }).toArray();
  }

  async function listAccessByUser(discordId) {
    const db = getDb();
    if (!db) return [];
    return db.collection(ACCESS_COLLECTION).find({ discordId: String(discordId) }).toArray();
  }

  // Dipakai hasCatalogAccess() di server.js — cek apakah user punya akses ke
  // SALAH SATU dari productIds yang di-gate ke sebuah Game/Bypass (satu item
  // bisa saja masuk ke lebih dari satu Product).
  async function hasAnyProductAccess(discordId, productIds) {
    if (!discordId || !Array.isArray(productIds) || !productIds.length) return false;
    const db = getDb();
    if (!db) return false;
    const count = await db.collection(ACCESS_COLLECTION).countDocuments({
      discordId: String(discordId), productId: { $in: productIds.map(String) }
    });
    return count > 0;
  }

  // Set productId yang dipunyai user — dipakai buat resolve badge "Sudah
  // Dibeli"/status di App (banyak produk sekaligus, 1 query, hindari N+1).
  async function getOwnedProductIdSet(discordId) {
    const db = getDb();
    if (!db || !discordId) return new Set();
    const rows = await db.collection(ACCESS_COLLECTION).find({ discordId: String(discordId) }).project({ productId: 1 }).toArray();
    return new Set(rows.map(r => r.productId));
  }

  return {
    PRODUCTS_COLLECTION, CONTENT_COLLECTION, ACCESS_COLLECTION,
    PRODUCT_STATUSES, CONTENT_TYPES,
    ensureIndexes,
    publicProduct, listProducts, listActiveProducts, getProductById,
    createProduct, updateProduct,
    setMainImage, clearMainImage, addAdditionalImage, removeAdditionalImage,
    listAllProductsRaw, applyImageMigration, removeLegacyImageFields,
    getProductDependency, deleteProduct, softDeleteProduct, restoreProduct, incrementSalesCount,
    listContent, addContent, removeContent,
    getRequirementInfoMap, getRequirementInfo,
    publicAccess, grantAccess, getAccess, revokeAccess,
    listAccessByProduct, listAccessByUser, hasAnyProductAccess, getOwnedProductIdSet
  };
};