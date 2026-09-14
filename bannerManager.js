// ══════════════════════════════════════════════════════════════════════════
// BANNER MANAGER — Setting Banner Admin Web <-> Banner Dashboard APP.
//
// Banner APP EXISTING (lihat app/index.html #dashBannerRoot & styles.css
// .dash-banner) sebelumnya murni markup statis (1 banner, teks hardcode,
// TIDAK ada database/API/realtime sama sekali). Modul ini TIDAK membuat
// desain banner baru — struktur (Eyebrow -> Judul -> Deskripsi -> [Tombol])
// dan class CSS APP (.dash-banner/.dash-banner-eyebrow/dst) dipertahankan
// APA ADANYA; modul ini cuma menyambungkan isinya ke database supaya bisa
// diatur dari Admin Web dan banyak banner (carousel) sekaligus.
//
// Pola SAMA PERSIS dengan modul lain di project ini:
//   - Image disimpan sebagai data URI base64 langsung di dokumen (pola
//     appCustomizationManager.js) — disajikan ke client lewat endpoint
//     ringan /api/banners/:id/image (lihat server.js) supaya body JSON
//     GET/PUT tidak pernah membawa base64 yang berat (fix "halaman lambat").
//   - Realtime lewat wsBroadcastAll yang SUDAH ADA (native `ws`, BUKAN
//     Socket.IO — lihat komentar connectRealtime() di app/app.js) — cuma
//     kirim SINYAL RINGAN {changed, version}, App fetch ulang lewat REST
//     GET /api/banners (payload besar tidak pernah lewat WS).
//   - Multi-dokumen + urutan tampil (pola sama dengan reorder Kategori di
//     server.js: PUT /api/admin/categories/reorder) — field `order` dipakai
//     buat urutan tab "Banner 1 | Banner 2 | ..." di Admin Web SEKALIGUS
//     urutan carousel di APP.
//
// Koleksi: `banners` — { _id, order, status, image:{url}, eyebrow:{...},
//   title:{...}, description:{...}, position, button:{...}, createdAt,
//   updatedAt }
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');

const COLLECTION = 'banners';

// Font whitelist — SENGAJA identik dengan FONT_WHITELIST di
// appCustomizationManager.js/APP_FONT_STACKS di app/app.js: font-font ini
// SUDAH dipasang lewat Google Fonts <link> di app/index.html, jadi memilih
// font di luar daftar ini akan gagal tampil di APP. Jangan tambah font baru
// di sini tanpa menambah <link> yang sesuai di app/index.html.
const FONT_WHITELIST = [
  { id: 'Inter', label: 'Inter', stack: "'Inter', 'Segoe UI', sans-serif" },
  { id: 'Poppins', label: 'Poppins', stack: "'Poppins', 'Segoe UI', sans-serif" },
  { id: 'Roboto', label: 'Roboto', stack: "'Roboto', 'Segoe UI', sans-serif" },
  { id: 'Montserrat', label: 'Montserrat', stack: "'Montserrat', 'Segoe UI', sans-serif" },
  { id: 'Space Grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', 'Segoe UI', sans-serif" },
  { id: 'Orbitron', label: 'Orbitron', stack: "'Orbitron', 'Segoe UI', sans-serif" },
  { id: 'Rajdhani', label: 'Rajdhani', stack: "'Rajdhani', 'Segoe UI', sans-serif" },
  { id: 'Bebas Neue', label: 'Bebas Neue', stack: "'Bebas Neue', Impact, sans-serif" },
  { id: 'Oswald', label: 'Oswald', stack: "'Oswald', 'Segoe UI', sans-serif" },
  { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', 'Segoe UI', sans-serif" }
];
const FONT_IDS = FONT_WHITELIST.map(f => f.id);
const FONT_WEIGHTS = [400, 500, 600, 700, 800];
const POSITIONS = ['left', 'center', 'right'];

// Daftar halaman/route INTERNAL APP yang benar-benar ada — diambil langsung
// dari data-page pada navbar App Desktop (lihat app/index.html, fungsi
// setNav() di app/app.js). SENGAJA tidak dibaca otomatis dari file APP saat
// runtime (App adalah build Electron terpisah, bukan bagian dari proses
// backend ini) — tapi daftar ini WAJIB tetap sinkron manual dengan
// data-page di app/index.html supaya Admin Web tidak pernah menawarkan
// tujuan tombol yang sebenarnya tidak ada (poin #17: "jangan hardcode
// daftar halaman jika routing APP sudah bisa dibaca" — di sinilah satu-
// satunya tempat daftar ini didefinisikan, backend & Admin Web sama-sama
// mengacu ke sini lewat GET /api/admin/banners, bukan didefinisikan ulang
// di beberapa tempat).
const APP_ROUTES = [
  { id: 'home', label: 'Dashboard' },
  { id: 'mygames', label: 'Games' },
  { id: 'explore', label: 'Bypass' },
  { id: 'belipaket', label: 'Beli Paket' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'requestgame', label: 'Request Game' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'setting', label: 'Settings' },
  { id: 'transaksi', label: 'Transaksi' },
  { id: 'history', label: 'History' }
];
const APP_ROUTE_IDS = APP_ROUTES.map(r => r.id);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — disamakan dengan App Customization background & dengan Final Test poin #4/#14 ("Upload image 5–10 MB") di prompt; SEBELUMNYA 8MB, jadi upload persis 9-10MB (sesuai instruksi test sendiri) selalu ditolak validasi walau body-parser (26mb, lihat server.js) sudah cukup longgar menampungnya.
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// Dipakai HANYA oleh listBannersLight() di bawah — placeholder pengganti
// data URI base64 asli supaya isHeavyDataUri()/toLightPayload() tetap
// mengarahkan client ke endpoint gambar ringan (/api/banners/:id/image),
// TANPA byte base64 sungguhan pernah ditarik dari MongoDB saat listing.
// Bukan gambar sungguhan — tidak pernah didekode di mana pun.
const DATA_URI_SENTINEL = 'data:image/placeholder;base64,';

function oid(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
function clampInt(n, min, max, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
function str(v, maxLen, fallback = '') {
  if (typeof v !== 'string') return fallback;
  return v.slice(0, maxLen);
}

function dataUriMime(dataUri) {
  const m = /^data:([^;,]+)/i.exec(dataUri);
  return m ? m[1].toLowerCase() : '';
}
function dataUriByteSize(dataUri) {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) return Infinity;
  const base64 = dataUri.slice(commaIdx + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
// Validasi KETAT (throw kalau invalid) — dipanggil eksplisit dari
// createBanner/updateBanner HANYA kalau admin benar-benar mengirim gambar
// baru (data URI). URL http(s) biasa dibiarkan lewat apa adanya.
function validateImageUrl(v) {
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s || /^https?:\/\//i.test(s)) return; // kosong (hapus) atau URL biasa -> valid
  if (s.startsWith('data:')) {
    const mime = dataUriMime(s);
    if (!IMAGE_MIME_WHITELIST.includes(mime)) {
      throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.');
    }
    const bytes = dataUriByteSize(s);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error('Ukuran gambar melebihi 10 MB. Gunakan gambar yang lebih kecil/kompres dulu.');
    }
    return;
  }
  throw new Error('Format gambar tidak valid.');
}

function sanitizeTextBlock(input, defaults, limits) {
  const d = defaults;
  const i = input && typeof input === 'object' ? input : {};
  return {
    text: str(i.text, limits.textMax, d.text),
    fontFamily: FONT_IDS.includes(i.fontFamily) ? i.fontFamily : d.fontFamily,
    fontSize: clampInt(i.fontSize, limits.sizeMin, limits.sizeMax, d.fontSize),
    fontWeight: FONT_WEIGHTS.includes(Number(i.fontWeight)) ? Number(i.fontWeight) : d.fontWeight,
    letterSpacing: clampNum(i.letterSpacing, -2, 10, d.letterSpacing)
  };
}

const TEXT_LIMITS = {
  eyebrow: { textMax: 40, sizeMin: 10, sizeMax: 22 },
  title: { textMax: 80, sizeMin: 18, sizeMax: 48 },
  description: { textMax: 240, sizeMin: 12, sizeMax: 20 }
};

const DEFAULT_BANNER_FIELDS = {
  eyebrow: { text: 'SPECIAL OFFER', fontFamily: 'Inter', fontSize: 13, fontWeight: 700, letterSpacing: 1.5 },
  title: { text: 'Judul Banner', fontFamily: 'Inter', fontSize: 30, fontWeight: 800, letterSpacing: 0 },
  description: { text: '', fontFamily: 'Inter', fontSize: 14, fontWeight: 500, letterSpacing: 0, maxWidth: 520 },
  position: 'left',
  button: { enabled: false, label: '', target: '' }
};

module.exports = function createBannerManager({ getDb, wsBroadcastAll }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(COLLECTION).createIndex({ order: 1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ status: 1 }).catch(() => {});
  }

  function sanitizeButton(input, current) {
    const d = current || DEFAULT_BANNER_FIELDS.button;
    const i = input && typeof input === 'object' ? input : {};
    const target = APP_ROUTE_IDS.includes(i.target) ? i.target : (APP_ROUTE_IDS.includes(d.target) ? d.target : '');
    const enabled = (i.enabled !== undefined) ? !!i.enabled : !!d.enabled;
    // Tombol tidak boleh "aktif" tanpa tujuan yang valid (poin #18 — button
    // optional, tapi kalau enabled harus benar-benar punya route nyata).
    return {
      enabled: enabled && !!target,
      label: str(i.label !== undefined ? i.label : d.label, 30, d.label || ''),
      target
    };
  }

  function mergeBanner(doc) {
    const d = doc || {};
    return {
      _id: d._id,
      order: Number.isFinite(d.order) ? d.order : 0,
      status: d.status === 'inactive' ? 'inactive' : 'active',
      image: { url: (d.image && typeof d.image.url === 'string') ? d.image.url : '' },
      eyebrow: sanitizeTextBlock(d.eyebrow, DEFAULT_BANNER_FIELDS.eyebrow, TEXT_LIMITS.eyebrow),
      title: sanitizeTextBlock(d.title, DEFAULT_BANNER_FIELDS.title, TEXT_LIMITS.title),
      description: {
        ...sanitizeTextBlock(d.description, DEFAULT_BANNER_FIELDS.description, TEXT_LIMITS.description),
        maxWidth: clampInt(d.description && d.description.maxWidth, 240, 900, DEFAULT_BANNER_FIELDS.description.maxWidth)
      },
      position: POSITIONS.includes(d.position) ? d.position : DEFAULT_BANNER_FIELDS.position,
      button: sanitizeButton(d.button, DEFAULT_BANNER_FIELDS.button),
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null
    };
  }

  async function listBannersRaw() {
    const db = getDb();
    if (!db) return [];
    const docs = await db.collection(COLLECTION).find({}).sort({ order: 1 }).toArray();
    return docs.map(mergeBanner);
  }

  // ── PERF — AKAR MASALAH SISA "Memuat banner..." lama ─────────────────────
  // GET /api/banners (publik, dipanggil APP tiap buka Dashboard/reconnect) &
  // GET /api/admin/banners (dipanggil Admin Web tiap buka Setting Banner)
  // SEBELUMNYA sama-sama memanggil listBannersRaw() — yaitu menarik dokumen
  // LENGKAP tiap banner dari MongoDB, TERMASUK gambar base64 (sampai 8 MB
  // PER banner), padahal toPublicList()/toAdminList() ujung-ujungnya CUMA
  // memakai path endpoint ringan (/api/banners/:id/image) dan MEMBUANG
  // base64-nya. Jadi setiap kali halaman Setting Banner dibuka atau APP
  // fetch ulang banner (termasuk tiap sinyal WS 'banners:update'), server
  // tetap menarik SEMUA byte gambar dari database ke Node cuma untuk
  // dibuang — inilah sisa penyebab nyata "Memuat banner..." masih lama
  // walau reorder/delete/broadcastUpdate() sudah diperbaiki (lihat
  // listOrderIndex() & broadcastUpdate() di atas, pola PERF yang sama).
  //
  // Perbaikan: aggregation dengan $project yang mendeteksi "apakah image.url
  // ini data URI base64?" LANGSUNG DI DALAM MongoDB (via $substrCP pada 5
  // karakter pertama) — kalau ya, ganti dengan DATA_URI_SENTINEL (string
  // pendek, cuma dipakai supaya toLightPayload()/isHeavyDataUri() tetap
  // mengenalinya sebagai "butuh diarahkan ke endpoint gambar", TANPA byte
  // base64 aslinya pernah keluar dari MongoDB/lewat network sama sekali).
  // URL http(s) biasa (atau kosong) diteruskan apa adanya (sudah ringan).
  // Field lain (eyebrow/title/description/button/dll) kecil, jadi tetap
  // diproyeksikan penuh seperti biasa — tidak ada perilaku yang hilang,
  // cuma byte gambar yang tidak pernah ditarik saat listing.
  async function listBannersLight() {
    const db = getDb();
    if (!db) return [];
    const docs = await db.collection(COLLECTION).aggregate([
      { $sort: { order: 1 } },
      { $project: {
          order: 1, status: 1, eyebrow: 1, title: 1, description: 1, position: 1, button: 1,
          createdAt: 1, updatedAt: 1,
          image: {
            url: {
              $cond: [
                { $eq: [ { $substrCP: [ { $ifNull: ['$image.url', ''] }, 0, 5 ] }, 'data:' ] },
                DATA_URI_SENTINEL,
                { $ifNull: ['$image.url', ''] }
              ]
            }
          }
      } }
    ]).toArray();
    return docs.map(mergeBanner);
  }

  async function getBannerById(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) return null;
    const doc = await db.collection(COLLECTION).findOne({ _id });
    return doc ? mergeBanner(doc) : null;
  }

  // ── PERF — sama pola dengan toAdminPayload() di appCustomizationManager.js:
  // ganti data URI base64 (berat) dengan path endpoint ringan supaya body
  // JSON GET/PUT tidak pernah membawa gambar utuh. `version` dipakai sebagai
  // query cache-buster (?v=) supaya browser langsung ambil gambar baru
  // begitu admin ganti gambar, tanpa nunggu cache 5 menit habis.
  function isHeavyDataUri(v) {
    return typeof v === 'string' && v.startsWith('data:');
  }
  function toLightPayload(banner, imageBase) {
    const version = banner.updatedAt ? new Date(banner.updatedAt).getTime() : 0;
    const out = { ...banner, id: String(banner._id), image: { ...banner.image } };
    if (isHeavyDataUri(out.image.url)) {
      out.image.url = `${imageBase}/${out.id}/image?v=${version}`;
    }
    return out;
  }

  // Payload untuk APP (publik) — hanya banner status 'active', terurut.
  function toPublicList(banners) {
    return banners
      .filter(b => b.status === 'active')
      .map(b => toLightPayload(b, '/api/banners'));
  }

  // Payload untuk Admin Web (semua status, urutan sama seperti tersimpan).
  //
  // FIX 404 (audit "Save lambat + 404"): sebelumnya base URL di sini adalah
  // '/api/admin/banners', jadi tiap banner ber-gambar menghasilkan URL
  // `/api/admin/banners/:id/image?v=...` — endpoint itu TIDAK PERNAH ada di
  // server.js (satu-satunya route gambar banner yang benar-benar terdaftar
  // adalah GET /api/banners/:id/image, PUBLIK, lihat server.js). Akibatnya
  // setiap kali Admin Web merender preview/thumbnail banner (termasuk tepat
  // setelah Save, begitu daftar banner di-render ulang dengan URL versi
  // baru), browser memuat gambar dari URL yang salah -> 404 di console,
  // persis yang dilaporkan. Endpoint gambar memang SENGAJA publik (sama
  // seperti /api/app-customization/background-image) supaya <img>/CSS
  // background-image bisa langsung memuatnya tanpa header Authorization —
  // jadi solusinya cukup pakai base URL publik yang sudah benar-benar ada
  // ini, BUKAN membuat endpoint admin baru yang duplikat.
  function toAdminList(banners) {
    return banners.map(b => toLightPayload(b, '/api/banners'));
  }

  async function getRawImageBuffer(id) {
    const banner = await getBannerById(id);
    if (!banner) return null;
    const raw = String(banner.image.url || '');
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(raw);
    if (!m) {
      if (/^https?:\/\//i.test(raw)) return { redirect: raw };
      return null;
    }
    return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') };
  }

  // ── PERF — dipakai createBanner()/deleteBanner()/reorderBanners() di bawah
  // HANYA untuk urusan `order`/validasi id, TIDAK PERNAH untuk menampilkan
  // apa pun ke client. SENGAJA memakai projection { image: 0 } supaya query
  // ini tidak ikut menarik base64 gambar (bisa sampai 8 MB PER banner) dari
  // MongoDB — sebelumnya ketiga fungsi ini semua memanggil listBannersRaw()
  // (fetch SEMUA field termasuk gambar) padahal cuma butuh _id & order. Ini
  // salah satu penyebab "Save/Tambah/Hapus Banner lambat": makin banyak &
  // makin besar gambar banner yang tersimpan, makin berat operasi CRUD lain
  // yang sebetulnya sama sekali tidak menyentuh gambar.
  async function listOrderIndex() {
    const db = getDb();
    if (!db) return [];
    return db.collection(COLLECTION)
      .find({}, { projection: { image: 0 } })
      .sort({ order: 1 })
      .toArray();
  }

  async function createBanner(input, updatedBy) {
    const db = getDb();
    if (input && input.image && typeof input.image.url === 'string') {
      validateImageUrl(input.image.url);
    }
    const all = await listOrderIndex();
    const nextOrder = all.length ? Math.max(...all.map(b => (Number.isFinite(b.order) ? b.order : 0))) + 1 : 0;
    const now = new Date();
    const doc = mergeBanner({
      order: nextOrder,
      status: 'active',
      image: { url: (input && input.image && input.image.url) || '' },
      eyebrow: input && input.eyebrow,
      title: input && input.title,
      description: input && input.description,
      position: input && input.position,
      button: input && input.button,
      createdAt: now,
      updatedAt: now
    });
    delete doc._id;
    if (!db) return { ...doc, _id: new ObjectId() };
    const result = await db.collection(COLLECTION).insertOne({ ...doc, createdAt: now, updatedAt: now, updatedBy });
    return await getBannerById(result.insertedId);
  }

  // ── PERF — AKAR MASALAH "Save Banner sangat lambat" ──────────────────────
  // SEBELUM audit ini, fungsi ini (1) mengambil dokumen banner LENGKAP
  // (termasuk gambar base64, sampai 8 MB) hanya untuk dibaca field
  // teks/posisi/tombolnya, lalu (2) menulis ULANG SELURUH dokumen — termasuk
  // field `image` yang TIDAK BERUBAH — kembali ke MongoDB lewat $set setiap
  // kali admin Save, walau admin cuma mengetik ulang judul/deskripsi. Jadi
  // tiap Save = 1x baca 8MB + 1x tulis 8MB ke database, padahal gambarnya
  // sama sekali tidak disentuh — inilah yang bikin Save terasa seperti
  // menunggu upload ulang walau tidak ada gambar baru.
  //
  // Perbaikan (TIDAK mengubah skema/struktur database sama sekali):
  //  1. `current` diambil dengan projection { image: 0 } — field gambar
  //     tidak pernah ikut terbaca kalau patch ini tidak menyertakan gambar
  //     baru (dan kalau MENYERTAKAN gambar baru, kita toh tidak butuh
  //     gambar LAMA-nya sama sekali, cukup pakai yang baru).
  //  2. `$set` HANYA berisi field yang benar-benar dikirim di `patch` —
  //     bukan lagi seluruh objek `merged`. Field yang tidak dikirim admin
  //     (termasuk `image` kalau admin tidak upload/hapus gambar sesi ini)
  //     TIDAK PERNAH ditulis ulang ke MongoDB.
  // Hasil akhirnya (`getBannerById(id)` di akhir) tetap mengembalikan data
  // lengkap yang benar, karena gambar lama tidak pernah tersentuh di DB.
  async function updateBanner(id, patch, updatedBy) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) throw new Error('Banner tidak ditemukan.');
    const p = patch || {};

    const currentDoc = await db.collection(COLLECTION).findOne({ _id }, { projection: { image: 0 } });
    if (!currentDoc) throw new Error('Banner tidak ditemukan.');
    const current = mergeBanner(currentDoc);

    if (p.image && typeof p.image.url === 'string') {
      validateImageUrl(p.image.url);
    }

    // `merged` cuma dipakai untuk SANITASI nilai (whitelist font/posisi/
    // limit panjang teks/dst, lihat mergeBanner/sanitizeButton) — bukan
    // untuk ditulis mentah-mentah ke database (lihat pembentukan `set` di
    // bawah, yang cuma mengambil sebagian field dari `merged` sesuai apa
    // yang benar-benar ada di `patch`).
    const merged = mergeBanner({
      ...current,
      image: (p.image && typeof p.image.url === 'string') ? { url: p.image.url } : current.image,
      eyebrow: p.eyebrow ? { ...current.eyebrow, ...p.eyebrow } : current.eyebrow,
      title: p.title ? { ...current.title, ...p.title } : current.title,
      description: p.description ? { ...current.description, ...p.description } : current.description,
      position: p.position !== undefined ? p.position : current.position,
      button: p.button ? { ...current.button, ...p.button } : current.button,
      status: p.status !== undefined ? p.status : current.status
    });

    const now = new Date();
    const set = { updatedAt: now, updatedBy };
    if (p.image && typeof p.image.url === 'string') set.image = merged.image;
    if (p.eyebrow) set.eyebrow = merged.eyebrow;
    if (p.title) set.title = merged.title;
    if (p.description) set.description = merged.description;
    if (p.position !== undefined) set.position = merged.position;
    if (p.button) set.button = merged.button;
    if (p.status !== undefined) set.status = merged.status;

    await db.collection(COLLECTION).updateOne({ _id }, { $set: set });
    return await getBannerById(id);
  }

  async function deleteBanner(id) {
    const db = getDb();
    const _id = oid(id);
    if (!db || !_id) return false;
    const result = await db.collection(COLLECTION).deleteOne({ _id });
    if (result.deletedCount > 0) {
      // Rapikan `order` supaya tidak ada celah (0,1,3,4 -> 0,1,2,3) — filter
      // tab "Banner N" di Admin Web & urutan carousel App selalu berurutan
      // rapi setelah salah satu banner dihapus (poin #2 permintaan).
      // PERF: pakai listOrderIndex() (projection { image: 0 }), BUKAN
      // listBannersRaw() — reindex urutan tidak butuh gambar sama sekali,
      // jadi tidak perlu menarik base64 semua banner lain dari MongoDB.
      const remaining = await listOrderIndex();
      await Promise.all(remaining.map((b, idx) =>
        b.order !== idx
          ? db.collection(COLLECTION).updateOne({ _id: b._id }, { $set: { order: idx } })
          : Promise.resolve()
      ));
    }
    return result.deletedCount > 0;
  }

  // PERF: return value fungsi ini dipakai oleh server.js HANYA sebagai
  // fallback kalau butuh sesuatu untuk dikembalikan (jarang) — pemanggil
  // normal di /api/admin/banners/reorder mengambil daftar terbaru sendiri
  // lewat listBannersLight() setelah ini selesai. Supaya fungsi ini juga
  // tidak diam-diam menarik base64 semua banner, dua-duanya sekarang pakai
  // listBannersLight() (bukan listBannersRaw()) juga.
  async function reorderBanners(orderedIds) {
    const db = getDb();
    if (!db || !Array.isArray(orderedIds) || !orderedIds.length) return await listBannersLight();
    // PERF: validasi id lewat listOrderIndex() (projection { image: 0 }) —
    // drag & drop reorder cuma butuh memastikan id valid, tidak pernah
    // butuh gambar banner lain.
    const all = await listOrderIndex();
    const validIds = new Set(all.map(b => String(b._id)));
    // Cuma proses id yang benar-benar ada — id asing/duplikat diabaikan
    // supaya request yang di-tempering tidak bisa merusak urutan.
    const clean = orderedIds.map(String).filter(id => validIds.has(id));
    await Promise.all(clean.map((id, idx) =>
      db.collection(COLLECTION).updateOne({ _id: oid(id) }, { $set: { order: idx } })
    ));
    return await listBannersLight();
  }

  // Dipanggil setelah create/update/delete/reorder berhasil — broadcast
  // SINYAL RINGAN saja (pola SAMA dengan app-customization:update/
  // marketplace:products:update), App fetch ulang lewat GET /api/banners.
  //
  // FIX (AKAR MASALAH UTAMA "Save Banner sangat lambat"): versi sebelumnya
  // memanggil `listBannersRaw()` di sini — yaitu fetch SEMUA dokumen banner
  // (LENGKAP dengan gambar base64 tiap banner, sampai 8 MB per banner) dari
  // MongoDB — padahal hasilnya (`all.length`) TIDAK PERNAH dipakai oleh
  // siapa pun: semua pemanggil broadcastUpdate() di server.js memanggilnya
  // dengan `await bannerManager.broadcastUpdate();` saja, return value-nya
  // dibuang. Jadi SETIAP kali admin Save/Tambah/Hapus/Reorder satu banner,
  // server diam-diam menarik ULANG SEMUA banner + gambarnya dari database
  // sebelum sempat mengirim sinyal WS — makin banyak/besar banner yang
  // tersimpan, makin lambat SEMUA operasi Save terasa, walau yang diedit
  // cuma 1 banner kecil tanpa gambar sama sekali.
  //
  // Perbaikan: ikuti PERSIS pola broadcastMarketplaceProductsUpdate() di
  // server.js (Marketplace Admin Web yang sekarang sudah cepat, dipakai
  // sebagai referensi) — kirim sinyal WS LANGSUNG tanpa membaca database
  // sama sekali. App yang menerima sinyal ini tetap fetch ulang data
  // lengkap lewat REST GET /api/banners (payload ringan, endpoint yang
  // sudah ada), jadi tidak ada perilaku yang hilang — cuma bagian yang
  // sia-sia (baca ulang semua gambar tiap broadcast) yang dihapus.
  function broadcastUpdate() {
    const version = Date.now();
    if (typeof wsBroadcastAll === 'function') {
      wsBroadcastAll('banners:update', { changed: true, version });
    }
    return { version };
  }

  return {
    ensureIndexes,
    listBannersRaw,
    listBannersLight,
    getBannerById,
    createBanner,
    updateBanner,
    deleteBanner,
    reorderBanners,
    toPublicList,
    toAdminList,
    getRawImageBuffer,
    broadcastUpdate,
    FONT_WHITELIST,
    APP_ROUTES
  };
};
