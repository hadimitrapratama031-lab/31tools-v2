// ══════════════════════════════════════════════════════════════════════════
// STEAM ACCOUNT MANAGER — CRUD produk "Steam Account Marketplace" (App +
// Admin Web). Modul ini terpisah dari Games/Bypass (collection Mongo sendiri:
// `steamAccounts`), supaya fitur lain yang sudah jalan tidak disentuh.
//
// MODEL KEPEMILIKAN (PENTING): Steam Account BUKAN produk sekali-jual.
// Satu akun (`steamAccounts`) bisa dimiliki BANYAK user sekaligus — product
// TIDAK PERNAH berubah jadi 'sold' dan TIDAK PERNAH hilang dari listing
// setelah dibeli. Kepemilikan per-user disimpan TERPISAH di collection
// `steamAccountOwnerships` (1 dokumen = 1 user memiliki 1 akun), dengan
// UNIQUE INDEX (steamAccountId, discordId) supaya user yang sama tidak bisa
// dapat ownership dobel walau endpoint alokasi dipanggil berkali-kali
// (webhook duplicate, race condition, dst) — insert kedua akan gagal kena
// duplicate key dan ditangani sebagai "sudah owned" (idempotent), BUKAN error.
//
// Data game per akun TIDAK diduplikasi manual oleh admin — cukup simpan
// snapshot ringan (buat render card/carousel cepat tanpa hit Steam tiap buka
// halaman) + appId sebagai identifier. Detail lengkap (requirements, dst)
// selalu diambil live lewat fetchSteamDetailsForAppId() yang SAMA PERSIS
// dipakai fitur "Auto-Isi"/steam-details Game & Bypass yang sudah ada di
// server.js (cache 15 menit bawaan fungsi itu) — tidak ada integrasi Steam
// API baru/paralel.
//
// Kredensial akun (username/password) dienkripsi at-rest (AES-256-GCM,
// key diturunkan dari JWT_SECRET biar tidak perlu env var baru) dan CUMA
// pernah didekripsi untuk: (1) Admin saat Edit/View, (2) pembeli sah lewat
// tombol "LOGIN AKUN" di App (dipicu manual oleh user, bukan otomatis
// setelah bayar — sesuai keputusan produk). "Pembeli sah" sekarang berarti
// PUNYA baris di steamAccountOwnerships buat akun ini — BUKAN buyer tunggal.
//
// Cara pakai dari server.js:
//   const steamAccountManager = require('./steamAccountManager')({
//     getDb: () => db,
//     fetchSteamDetails: fetchSteamDetailsForAppId // fungsi yang SUDAH ADA
//   });
//   await steamAccountManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');
const crypto = require('crypto');

const COLLECTION = 'steamAccounts';
const OWNERSHIP_COLLECTION = 'steamAccountOwnerships';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// 'sold' SENGAJA tidak ada lagi — akun bersifat UNLIMITED USER / SHARED
// PRODUCT, cuma bisa AVAILABLE (bisa dibeli user baru) atau DISABLED (admin
// matikan penjualan baru, tapi pemilik lama tetap bisa LOGIN AKUN).
const VALID_STATUS = ['available', 'disabled'];

module.exports = function createSteamAccountManager({ getDb, fetchSteamDetails }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(COLLECTION).createIndex({ order: 1, createdAt: 1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ status: 1 }).catch(() => {});
    // Unique constraint (userId + steamAccountId) — inti dari model UNLIMITED
    // USER OWNERSHIP: satu user tidak mungkin dapat 2 baris ownership utk
    // akun yang sama, walau alokasi dipicu berkali-kali (idempotent).
    await db.collection(OWNERSHIP_COLLECTION).createIndex({ steamAccountId: 1, discordId: 1 }, { unique: true }).catch(() => {});
    await db.collection(OWNERSHIP_COLLECTION).createIndex({ discordId: 1, createdAt: -1 }).catch(() => {});
    await db.collection(OWNERSHIP_COLLECTION).createIndex({ steamAccountId: 1 }).catch(() => {});
  }

  // ── Enkripsi kredensial — pola sama (AES-256-GCM) dipakai di mana pun
  // project ini butuh simpan rahasia sensitif per-baris data. ──
  function getEncKey() {
    const secret = process.env.STEAM_CRED_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET/STEAM_CRED_SECRET belum diset di .env — wajib ada untuk enkripsi kredensial Steam.');
    return crypto.createHash('sha256').update(String(secret)).digest();
  }

  function encryptText(plain) {
    if (!plain) return null;
    const key = getEncKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), data: enc.toString('base64'), tag: authTag.toString('base64') };
  }

  function decryptText(payload) {
    if (!payload || !payload.data) return null;
    try {
      const key = getEncKey();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
      return dec.toString('utf8');
    } catch (e) {
      return null; // rahasia korup/kunci beda — jangan bikin request 500, biar caller yang handle
    }
  }

  function validateImageFields({ imageData, imageUrl }) {
    const out = { imageData: null, imageUrl: null };
    if (imageData) {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(imageData).trim());
      if (!m) throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG, GIF, atau WEBP.');
      const approxBytes = Math.ceil((m[2].length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) throw new Error(`Ukuran gambar maksimal ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB.`);
      out.imageData = imageData;
    } else if (imageUrl) {
      const url = String(imageUrl).trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('URL gambar harus diawali http:// atau https://');
      out.imageUrl = url;
    }
    return out;
  }

  function normalizeStatus(status) {
    const s = String(status || 'available').toLowerCase();
    return VALID_STATUS.includes(s) ? s : 'available';
  }

  // ── Cari data Steam (nama, cover, deskripsi singkat, genre, kategori) dari
  // App ID — dipakai admin pas "Search" sebelum Add Game. TIDAK menyimpan apa
  // pun, cuma preview. ──
  async function searchGameByAppId(appId) {
    const id = String(appId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('Steam App ID harus berupa angka.');
    const details = await fetchSteamDetails(id);
    if (!details) throw new Error(`Game dengan App ID ${id} tidak ditemukan di Steam.`);
    return details;
  }

  function gameSnapshotFromDetails(details) {
    return {
      appId: String(details.appId),
      name: details.name || `App ${details.appId}`,
      headerImage: details.headerImage || null,
      shortDescription: details.shortDescription || '',
      genres: (details.genres || []).slice(0, 4),
      categories: (details.categories || []).slice(0, 4),
      developers: details.developers || [],
      publishers: details.publishers || [],
      releaseDate: details.releaseDate || null,
      // Harga dalam sen USD — cuma dipakai untuk sorting "termahal duluan"
      // di fitur Tambah Banyak Sekaligus. null = Steam tidak kasih info harga.
      price: (typeof details.price === 'number') ? details.price : null,
      priceFormatted: details.priceFormatted || (details.isFree ? 'Free' : null),
      isFree: !!details.isFree,
      addedAt: new Date()
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // OWNERSHIP — kepemilikan per-user, terpisah total dari data produk.
  // ══════════════════════════════════════════════════════════════════════

  // Dipakai buat halaman detail/single-product route: cek kepemilikan 1 user
  // atas 1 akun.
  async function hasOwnership(productId, discordId) {
    const db = getDb();
    if (!db || !discordId) return false;
    const doc = await db.collection(OWNERSHIP_COLLECTION).findOne({ steamAccountId: String(productId), discordId });
    return !!doc;
  }

  // Dipakai buat halaman listing: 1 query buat SEMUA akun yang dimiliki user
  // ini, dikembalikan sebagai Set biar publicProductForUser() tinggal cek
  // .has() tanpa N query per produk.
  async function listOwnedProductIds(discordId) {
    const db = getDb();
    if (!db || !discordId) return new Set();
    const rows = await db.collection(OWNERSHIP_COLLECTION).find({ discordId }).project({ steamAccountId: 1 }).toArray();
    return new Set(rows.map(r => r.steamAccountId));
  }

  async function countOwners(productId) {
    const db = getDb();
    if (!db) return 0;
    return db.collection(OWNERSHIP_COLLECTION).countDocuments({ steamAccountId: String(productId) });
  }

  // PERF FIX: dipakai GET /api/admin/steam-accounts — SEBELUMNYA endpoint itu
  // manggil countOwners() satu-satu per akun lewat Promise.all (N query
  // terpisah ke MongoDB kalau ada N akun). Sekarang 1 aggregation buat
  // SEMUA productIds sekaligus, dikembalikan sebagai Map<productId, count>.
  async function countOwnersBulk(productIds) {
    const db = getDb();
    if (!db || !productIds || !productIds.length) return new Map();
    const ids = productIds.map(String);
    const rows = await db.collection(OWNERSHIP_COLLECTION).aggregate([
      { $match: { steamAccountId: { $in: ids } } },
      { $group: { _id: '$steamAccountId', count: { $sum: 1 } } }
    ]).toArray();
    const map = new Map();
    for (const r of rows) map.set(r._id, r.count);
    return map;
  }

  async function listOwnersForProduct(productId) {
    const db = getDb();
    if (!db) return [];
    return db.collection(OWNERSHIP_COLLECTION).find({ steamAccountId: String(productId) }).sort({ createdAt: -1 }).toArray();
  }

  // ── Alokasi akun ke pembeli — TIDAK PERNAH mengubah status product (product
  // tetap AVAILABLE utk user lain), cuma menambah 1 baris ownership. Dibuat
  // IDEMPOTENT lewat unique index (steamAccountId+discordId): kalau baris
  // sudah ada (mis. webhook dipicu 2x buat user yang sama), insertOne kedua
  // akan lempar E11000 — kita tangkap & anggap "sudah owned", BUKAN error,
  // BUKAN bikin ownership duplikat, BUKAN akses diberikan 2x. Dipanggil
  // SATU-SATUNYA dari alur aktivasi order setelah pembayaran KlikQRIS sukses. ──
  async function grantOwnership(productId, { discordId, username, orderId }) {
    const db = getDb();
    if (!db || !ObjectId.isValid(productId)) return null;
    const product = await getById(productId);
    if (!product) return null;

    const doc = {
      steamAccountId: String(productId),
      discordId, username: username || null,
      orderId,
      purchasedAt: new Date(),
      createdAt: new Date()
    };
    try {
      await db.collection(OWNERSHIP_COLLECTION).insertOne(doc);
      return { product, ownership: doc, alreadyOwned: false };
    } catch (e) {
      if (e && e.code === 11000) {
        // Sudah owned sebelumnya (idempotent) — kembalikan baris yang ada,
        // JANGAN insert lagi, JANGAN anggap gagal.
        const existing = await db.collection(OWNERSHIP_COLLECTION).findOne({ steamAccountId: String(productId), discordId });
        return { product, ownership: existing || doc, alreadyOwned: true };
      }
      throw e;
    }
  }

  // ── Kredensial untuk PEMILIK SAH (App, tombol "LOGIN AKUN") — cuma
  // berhasil kalau user ini PUNYA baris ownership utk akun ini. ──
  async function getCredentialsForOwner(productId, discordId) {
    const product = await getById(productId);
    const owned = await hasOwnership(productId, discordId);
    if (!product || !owned) {
      throw new Error('Kamu tidak memiliki akses ke akun ini.');
    }
    return {
      username: decryptText(product.credentials?.username),
      password: decryptText(product.credentials?.password)
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // PRODUCT CRUD
  // ══════════════════════════════════════════════════════════════════════

  // ── Admin: daftar SEMUA akun (available + disabled) ──
  // PERF FIX: find({}) polos ikut menarik
  // `imageData` (base64, s/d 4MB per akun) buat SETIAP akun di list, itu
  // penyebab utama list Steam Account lambat. `games`/`credentials` SENGAJA
  // TETAP dikirim penuh di sini (tidak di-strip) karena modal Edit (Admin Web)
  // butuh data itu langsung dari cache list ini biar bisa buka instan tanpa
  // request tambahan — ukurannya jauh lebih kecil dibanding gambar base64
  // jadi bukan sumber lambatnya. Gambar aslinya dipindah ke endpoint terpisah
  // GET /api/admin/steam-accounts/:id/image (di-cache browser).
  async function listAdmin() {
    const db = getDb();
    if (!db) return [];
    return db.collection(COLLECTION).aggregate([
      { $sort: { order: 1, createdAt: 1 } },
      { $addFields: { hasImage: { $cond: [{ $and: [{ $ne: ['$imageData', null] }, { $ne: ['$imageData', ''] }] }, true, false] } } },
      { $project: { imageData: 0 } }
    ]).toArray();
  }

  // ── Admin: ambil gambar 1 akun saja — dipakai endpoint
  // GET /api/admin/steam-accounts/:id/image (lihat listAdmin di atas). ──
  async function getImage(id) {
    const db = getDb();
    if (!db || !ObjectId.isValid(id)) return null;
    return db.collection(COLLECTION).findOne(
      { _id: new ObjectId(id) },
      { projection: { imageData: 1, imageUrl: 1 } }
    );
  }

  // ── App: daftar akun AVAILABLE saja (utk user yang belum tentu owner) ──
  async function listPublic() {
    const db = getDb();
    if (!db) return [];
    return db.collection(COLLECTION).find({ status: 'available' }).sort({ order: 1, createdAt: 1 }).toArray();
  }

  // ── App: daftar akun utk 1 user — AVAILABLE (siapa saja) DITAMBAH akun yang
  // sudah di-DISABLE admin TAPI user ini tetap owner-nya (disable cuma
  // menutup pembelian BARU, pemilik lama tetap bisa lihat & LOGIN AKUN). ──
  async function listPublicForUser(discordId) {
    const db = getDb();
    if (!db) return [];
    const ownedIds = discordId ? await listOwnedProductIds(discordId) : new Set();
    const ownedObjectIds = [...ownedIds].filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    const filter = ownedObjectIds.length
      ? { $or: [{ status: 'available' }, { _id: { $in: ownedObjectIds } }] }
      : { status: 'available' };
    const list = await db.collection(COLLECTION).find(filter).sort({ order: 1, createdAt: 1 }).toArray();
    return { list, ownedIds };
  }

  async function getById(id) {
    const db = getDb();
    if (!db || !ObjectId.isValid(id)) return null;
    return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
  }

  async function create(input) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');

    const name = String(input.name || '').trim();
    if (!name) throw new Error('Nama produk wajib diisi.');
    const price = Math.round(Number(input.price));
    if (!Number.isFinite(price) || price <= 0) throw new Error('Harga produk tidak valid.');

    const username = String(input.username || '').trim();
    const password = String(input.password || '').trim();
    if (!username || !password) throw new Error('Username & password akun Steam wajib diisi.');

    const last = await db.collection(COLLECTION).find({}).sort({ order: -1 }).limit(1).toArray();
    const nextOrder = last.length ? (last[0].order || 0) + 1 : 0;

    const doc = {
      name,
      description: String(input.description || ''),
      caraBermain: String(input.caraBermain || ''),
      importantInfo: String(input.importantInfo || ''),
      price,
      ...validateImageFields({ imageData: input.imageData, imageUrl: input.imageUrl }),
      status: normalizeStatus(input.status),
      order: input.order !== undefined && Number.isFinite(Number(input.order)) ? Number(input.order) : nextOrder,
      credentials: {
        username: encryptText(username),
        password: encryptText(password)
      },
      games: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await db.collection(COLLECTION).insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  // PERF FIX: SEBELUMNYA update() SELALU melakukan 3 round-trip DB berurutan
  // (getById buat existing → updateOne → getById lagi buat return value) untuk
  // SETIAP edit, padahal existing cuma benar-benar dibutuhkan kalau username
  // ATAU password ikut diubah (buat merge credentials yang tidak diubah).
  // Sekarang: (1) existing HANYA di-fetch kalau memang perlu merge credentials,
  // (2) updateOne+getById digabung jadi SATU findOneAndUpdate (returnDocument
  // 'after') yang sekalian mengembalikan dokumen ter-update. Hasilnya, kasus
  // paling umum (edit nama/harga/gambar/status TANPA ganti username/password)
  // turun dari 3 round-trip jadi 1 round-trip ke MongoDB — ini penyebab utama
  // "Save lambat" di Admin Web (tiap round-trip menunggu latency network ke
  // MongoDB, bukan cuma waktu proses lokal).
  async function update(id, input) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(id)) throw new Error('ID produk tidak valid.');

    const needsExistingForCreds = input.username !== undefined || input.password !== undefined;
    let existing = null;
    if (needsExistingForCreds) {
      existing = await getById(id);
      if (!existing) throw new Error('Produk tidak ditemukan.');
    }

    const update = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!name) throw new Error('Nama produk wajib diisi.');
      update.name = name;
    }
    if (input.description !== undefined) update.description = String(input.description || '');
    if (input.caraBermain !== undefined) update.caraBermain = String(input.caraBermain || '');
    if (input.importantInfo !== undefined) update.importantInfo = String(input.importantInfo || '');
    if (input.price !== undefined) {
      const price = Math.round(Number(input.price));
      if (!Number.isFinite(price) || price <= 0) throw new Error('Harga produk tidak valid.');
      update.price = price;
    }
    // Product bersifat UNLIMITED USER — status cuma toggle available/disabled,
    // BEBAS diubah admin kapan saja (Enable/Disable), TIDAK ADA lagi status
    // 'sold' yang dikunci sistem.
    if (input.status !== undefined) {
      update.status = normalizeStatus(input.status);
    }
    if (input.order !== undefined && Number.isFinite(Number(input.order))) update.order = Number(input.order);
    if (input.imageData !== undefined || input.imageUrl !== undefined) {
      Object.assign(update, validateImageFields({ imageData: input.imageData, imageUrl: input.imageUrl }));
    }
    if (input.username !== undefined || input.password !== undefined) {
      const creds = { ...existing.credentials };
      if (input.username !== undefined) {
        const u = String(input.username || '').trim();
        if (!u) throw new Error('Username tidak boleh kosong.');
        creds.username = encryptText(u);
      }
      if (input.password !== undefined) {
        const p = String(input.password || '').trim();
        if (!p) throw new Error('Password tidak boleh kosong.');
        creds.password = encryptText(p);
      }
      update.credentials = creds;
    }

    // Driver mongodb v6: findOneAndUpdate mengembalikan dokumennya LANGSUNG
    // (bukan { value: doc } seperti driver v4/v5 lama) selama
    // `includeResultMetadata` tidak diset true.
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: 'after' }
    );
    if (!doc) throw new Error('Produk tidak ditemukan.');
    return doc;
  }

  // Hapus akun — TIDAK BOLEH kalau sudah pernah dimiliki (punya >=1 baris
  // ownership), supaya jejak pembelian/histori pembeli tetap ada. Admin bisa
  // override proteksi ini dengan `force: true` (dipicu dari tombol "Hapus
  // Paksa" di adminweb) — baris ownership TETAP TIDAK DIHAPUS (histori
  // pembelian tetap ada di collection steamAccountOwnerships), hanya produknya
  // saja yang dihapus.
  async function remove(id, { force = false } = {}) {
    const db = getDb();
    if (!db || !ObjectId.isValid(id)) return null;
    const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!doc) return null;
    const owners = await countOwners(id);
    if (owners > 0 && !force) throw new Error('Akun ini sudah pernah dibeli/dimiliki user, tidak bisa dihapus (histori pembelian harus tetap ada). Gunakan Disable untuk menghentikan penjualan baru, atau pakai Hapus Paksa.');
    await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
    return doc;
  }

  async function reorder(orderedIds) {
    const db = getDb();
    if (!db) return;
    await Promise.all(orderedIds.map((id, idx) =>
      db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { order: idx, updatedAt: new Date() } })
    ));
  }

  // ── Tambah 1 game (by App ID) ke akun. Idempotent — App ID yang sama tidak
  // bisa dobel. Boleh dilakukan kapan saja (termasuk akun yang sudah punya
  // owner) — Steam Account bukan produk sekali-jual jadi kontennya tetap
  // bisa dikelola Admin. ──
  async function addGame(productId, appId) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(productId)) throw new Error('ID produk tidak valid.');
    const product = await getById(productId);
    if (!product) throw new Error('Produk tidak ditemukan.');

    const details = await searchGameByAppId(appId);
    const games = Array.isArray(product.games) ? product.games : [];
    if (games.some(g => g.appId === String(details.appId))) {
      throw new Error(`${details.name} (App ID ${details.appId}) sudah ada di akun ini.`);
    }
    games.push(gameSnapshotFromDetails(details));

    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(productId) }, { $set: { games, updatedAt: new Date() } });
    return getById(productId);
  }

  // ── FITUR BARU: Tambah BANYAK game sekaligus dari daftar App ID. Terpisah
  // total dari addGame() di atas (yang TIDAK diubah sama sekali) — dipakai
  // khusus oleh tombol "Tambah Banyak Sekaligus" di adminweb, supaya alur
  // tambah 1-1 yang sudah ada tetap jalan persis seperti sebelumnya.
  //
  // Perilaku:
  //  - Terima array App ID ATAU string App ID dipisah baris baru/koma/spasi
  //    (fleksibel, biar admin bisa paste langsung dari catatan).
  //  - App ID duplikat dalam 1 batch, atau yang sudah ada di akun ini,
  //    di-skip (tidak dianggap error) — dilaporkan di `skipped`.
  //  - App ID yang bukan angka atau tidak ditemukan di Steam masuk `failed`
  //    dengan alasannya, TIDAK menghentikan proses App ID lain di batch yang
  //    sama (best-effort, seperti import CSV).
  //  - Setelah semua diproses, SELURUH daftar game di akun ini diurutkan
  //    ulang: harga PALING MAHAL ditaruh PALING AWAL. Game tanpa info harga
  //    (price null — misal delisted/region-locked di Steam) ditaruh paling
  //    akhir, bukan dianggap termurah/gratis.
  const MAX_BULK_APPIDS = 30; // batas wajar per klik, cegah 1 request nembak Steam API kebanyakan sekaligus

  async function addGamesBulk(productId, appIdsInput) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(productId)) throw new Error('ID produk tidak valid.');
    const product = await getById(productId);
    if (!product) throw new Error('Produk tidak ditemukan.');

    const rawList = Array.isArray(appIdsInput)
      ? appIdsInput
      : String(appIdsInput || '').split(/[\s,]+/);

    // Dedupe input sambil jaga urutan kemunculan pertama, buang yang kosong.
    const seen = new Set();
    const uniqueIds = [];
    for (const raw of rawList) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniqueIds.push(id);
    }
    if (!uniqueIds.length) throw new Error('Tidak ada App ID yang diisi.');
    if (uniqueIds.length > MAX_BULK_APPIDS) {
      throw new Error(`Maksimal ${MAX_BULK_APPIDS} App ID sekali proses (kamu memasukkan ${uniqueIds.length}). Bagi jadi beberapa kali klik ya.`);
    }

    const existingIds = new Set((product.games || []).map(g => g.appId));
    const games = Array.isArray(product.games) ? [...product.games] : [];

    const added = [];
    const skipped = [];
    const failed = [];

    for (const appId of uniqueIds) {
      if (!/^\d+$/.test(appId)) {
        failed.push({ appId, reason: 'App ID harus berupa angka.' });
        continue;
      }
      if (existingIds.has(appId)) {
        skipped.push({ appId, reason: 'Sudah ada di akun ini.' });
        continue;
      }
      try {
        const details = await searchGameByAppId(appId);
        const snap = gameSnapshotFromDetails(details);
        games.push(snap);
        existingIds.add(appId); // cegah App ID sama nyangkut dobel dalam batch ini
        added.push({ appId, name: snap.name, price: snap.price, priceFormatted: snap.priceFormatted });
      } catch (e) {
        failed.push({ appId, reason: e.message || 'Gagal mengambil data dari Steam.' });
      }
    }

    // Urutkan ULANG seluruh game di akun — termahal paling awal. price
    // null (tidak diketahui) diperlakukan sebagai paling murah (-1) supaya
    // jatuh ke posisi paling akhir, BUKAN ke atas seolah-olah termahal.
    games.sort((a, b) => {
      const pa = (typeof a.price === 'number') ? a.price : -1;
      const pb = (typeof b.price === 'number') ? b.price : -1;
      return pb - pa;
    });

    if (added.length) {
      await db.collection(COLLECTION).updateOne({ _id: new ObjectId(productId) }, { $set: { games, updatedAt: new Date() } });
    }

    return {
      product: added.length ? await getById(productId) : product,
      added, skipped, failed
    };
  }

  async function removeGame(productId, appId) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(productId)) throw new Error('ID produk tidak valid.');
    const product = await getById(productId);
    if (!product) throw new Error('Produk tidak ditemukan.');

    const games = (product.games || []).filter(g => g.appId !== String(appId));
    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(productId) }, { $set: { games, updatedAt: new Date() } });
    return getById(productId);
  }

  // ── Kredensial untuk Admin (View/Edit) ──
  function credentialsForAdmin(product) {
    return {
      username: decryptText(product.credentials?.username),
      password: decryptText(product.credentials?.password)
    };
  }

  function publicProduct(p) {
    if (!p) return null;
    return {
      id: String(p._id),
      name: p.name,
      description: p.description,
      caraBermain: p.caraBermain,
      importantInfo: p.importantInfo,
      price: p.price,
      imageData: p.imageData,
      imageUrl: p.imageUrl,
      // hasImage: dari listAdmin() (aggregation) kalau field imageData sudah
      // di-strip; fallback ke !!p.imageData buat dokumen penuh (mis. getById).
      hasImage: p.hasImage !== undefined ? !!p.hasImage : !!p.imageData,
      status: p.status,
      order: p.order,
      gamesCount: (p.games || []).length,
      games: (p.games || []).map(g => ({
        appId: g.appId, name: g.name, headerImage: g.headerImage,
        shortDescription: g.shortDescription, genres: g.genres || [], categories: g.categories || [],
        developers: g.developers || [], publishers: g.publishers || [], releaseDate: g.releaseDate || null,
        price: (typeof g.price === 'number') ? g.price : null, priceFormatted: g.priceFormatted || null
      })),
      // Kredensial & data pembeli lain TIDAK PERNAH ikut di sini — publicProduct
      // dipakai buat listing/detail yang bisa dilihat siapa saja yang login.
      isOwner: false
    };
  }

  // Sama seperti publicProduct, tapi ditambah flag kepemilikan & status order
  // pending — dipakai App biar tahu kapan harus tampilkan "LOGIN AKUN" vs
  // "BELI AKUN" vs "PEMBAYARAN DIPROSES" (poin 11 spec: user yang order-nya
  // masih pending TIDAK dikasih tombol BELI AKUN baru).
  // `ownedIdsOrBool` boleh berupa Set (dari listOwnedProductIds) ATAU boolean
  // (hasil hasOwnership langsung, dipakai di route single-product).
  function publicProductForUser(p, ownedIdsOrBool, pendingIds) {
    const base = publicProduct(p);
    if (!base) return null;
    if (ownedIdsOrBool instanceof Set) {
      base.isOwner = ownedIdsOrBool.has(String(p._id));
    } else {
      base.isOwner = !!ownedIdsOrBool;
    }
    base.hasPendingOrder = pendingIds instanceof Set ? pendingIds.has(String(p._id)) : !!pendingIds;
    return base;
  }

  function adminProduct(p, ownersCount) {
    if (!p) return null;
    return {
      ...publicProduct(p),
      credentials: credentialsForAdmin(p),
      ownersCount: ownersCount || 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
  }

  return {
    VALID_STATUS,
    ensureIndexes, validateImageFields, normalizeStatus,
    searchGameByAppId,
    listAdmin, listPublic, listPublicForUser, getById, getImage,
    create, update, remove, reorder,
    addGame, addGamesBulk, removeGame,
    hasOwnership, listOwnedProductIds, countOwners, countOwnersBulk, listOwnersForProduct,
    grantOwnership, getCredentialsForOwner, credentialsForAdmin,
    publicProduct, publicProductForUser, adminProduct
  };
};