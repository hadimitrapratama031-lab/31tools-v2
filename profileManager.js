// ══════════════════════════════════════════════════════════════════════════
// PROFILE MANAGER — profil App (Foto Profil App, Display Name, Username, Bio)
// ══════════════════════════════════════════════════════════════════════════
// PENTING — pemisahan dari Discord:
//   Data Discord (avatarUrl, username/global_name, discordUsername, discordId)
//   TETAP disimpan & diisi ulang tiap login lewat alur OAuth yang sudah ada
//   (lihat /auth/discord/callback di server.js) — modul ini SAMA SEKALI TIDAK
//   menyentuh field-field itu, jadi mengubah profil App tidak akan pernah
//   mengubah akun Discord user.
//
//   Profil App disimpan di field terpisah & flat di collection `users`:
//     profilePhotoUrl, profileDisplayName, profileUsername, profileBio,
//     profileUpdatedAt
//   Field ini SELALU kosong/null sampai user pertama kali edit profil —
//   sebelum itu, tampilan tetap fallback ke data Discord (lihat
//   effectiveIdentity()).
//
// STRATEGI "REALTIME DI SEMUA HALAMAN" TANPA UBAH RATUSAN TEMPAT RENDER:
//   Field yang dipakai HAMPIR DI SEMUA TEMPAT (App maupun Admin Web) untuk
//   menampilkan user adalah `username` (dipakai sebagai nama tampilan) dan
//   `avatarUrl` (foto). publicUser() di server.js mengisi KEDUA field itu
//   dengan NILAI EFEKTIF (profil App kalau sudah diisi, fallback ke Discord
//   kalau belum) — jadi begitu user ganti nama/foto, SEMUA tempat yang sudah
//   menampilkan user.username/user.avatarUrl (sidebar App, dashboard admin,
//   daftar user, dst) otomatis ikut berubah, TANPA perlu mengubah nama field
//   di frontend sama sekali. Handle asli Discord (@username) tetap tersedia
//   terpisah lewat field `discordUsername` (tidak berubah).
//   Untuk koleksi riwayat/log yang menyimpan snapshot `username` di waktu
//   kejadian (history, activityLogs, transactions — sengaja begitu untuk
//   keperluan audit), enrichRows() dipakai di endpoint admin terkait supaya
//   tampilan TETAP ikut nama/foto terbaru user tanpa mengubah data snapshot
//   yang tersimpan.
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/; // 3-20 char, huruf kecil/angka/underscore, wajib diawali huruf
const DISPLAY_NAME_MAX = 32;
const DISPLAY_NAME_MIN = 2;
const BIO_MAX = 160;
const PHOTO_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
// Koleksi Mongo TERPISAH buat binary foto profil (bukan ditulis ke disk lokal
// lagi — lihat catatan panjang di savePhoto() kenapa ini yang jadi FIX-nya).
const PHOTOS_COLLECTION = 'profilePhotos';

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'moderator', 'mods', 'mod', 'support', 'system',
  'root', 'null', 'undefined', 'discord', 'official', 'staff', 'owner',
  'api', 'help', 'security', 'billing', 'store', '31store', 'gamedash',
  'you', 'me', 'user', 'anonymous', 'bot', 'server'
]);

module.exports = function createProfileManager({ getDb, sanitizeHtml, photoRoutePath, serverUrl }) {
  const db = () => getDb();
  // Base URL absolut server ini sendiri (mis. https://xxx.up.railway.app) —
  // dipakai bikin URL foto profil App SELALU absolute. Fallback '' cuma
  // jaga-jaga kalau suatu saat dependency ini lupa di-pass (tetap tidak crash,
  // cuma balik ke perilaku lama/path relatif).
  const baseUrl = String(serverUrl || '').replace(/\/+$/, '');
  const routePath = String(photoRoutePath || '/api/profile/photo').replace(/\/+$/, '');

  // Beberapa user mungkin sudah kepalang punya `profilePhotoUrl` yang tersimpan
  // sebagai path RELATIF (dari sebelum perbaikan ini) — normalisasi jadi absolute
  // di sini (saat DIBACA), bukan cuma di savePhoto() saat DITULIS. Dengan begini
  // foto profil user yang SUDAH KADUNG rusak di App langsung ikut normal lagi
  // begitu server di-deploy ulang, TANPA perlu mereka upload ulang fotonya.
  function toAbsoluteUrl(url) {
    if (!url) return url;
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url; // sudah absolute/data URL, biarkan
    return baseUrl + (url.startsWith('/') ? url : `/${url}`);
  }

  // ── Validasi ──
  function validateUsernameFormat(username) {
    if (typeof username !== 'string') return 'Username tidak valid.';
    const v = username.trim().toLowerCase();
    if (!v) return 'Username tidak boleh kosong.';
    if (!USERNAME_RE.test(v)) {
      return 'Username 3-20 karakter, hanya huruf kecil/angka/underscore, dan wajib diawali huruf.';
    }
    if (RESERVED_USERNAMES.has(v)) return 'Username ini tidak boleh dipakai.';
    return null;
  }

  function validateDisplayName(name) {
    if (typeof name !== 'string') return 'Display Name tidak valid.';
    const v = name.trim();
    if (v.length < DISPLAY_NAME_MIN) return `Display Name minimal ${DISPLAY_NAME_MIN} karakter.`;
    if (v.length > DISPLAY_NAME_MAX) return `Display Name maksimal ${DISPLAY_NAME_MAX} karakter.`;
    return null;
  }

  function validateBio(bio) {
    if (bio === undefined || bio === null) return null;
    if (typeof bio !== 'string') return 'Bio tidak valid.';
    if (bio.length > BIO_MAX) return `Bio maksimal ${BIO_MAX} karakter.`;
    return null;
  }

  function cleanText(str, maxLen) {
    const sanitized = sanitizeHtml(String(str || '').trim(), { allowedTags: [], allowedAttributes: {} });
    return sanitized.slice(0, maxLen);
  }

  // ── Baca profil (App + Discord read-only, digabung buat halaman Edit Profil) ──
  async function getProfile(discordId) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');
    const user = await database.collection('users').findOne({ discordId });
    if (!user) throw new Error('Akun tidak ditemukan.');
    return toProfilePayload(user);
  }

  function toProfilePayload(user) {
    return {
      app: {
        photoUrl: toAbsoluteUrl(user.profilePhotoUrl) || null,
        displayName: user.profileDisplayName || user.username || '',
        username: user.profileUsername || null,
        bio: user.profileBio || ''
      },
      discord: {
        avatarUrl: user.avatarUrl || null,
        username: user.discordUsername || user.username || null,
        discordId: user.discordId
      }
    };
  }

  // Nilai EFEKTIF yang dipakai di HAMPIR SEMUA tampilan (lihat catatan strategi
  // di atas) — fallback ke data Discord kalau field profil App belum diisi.
  function effectiveIdentity(user) {
    return {
      username: (user.profileDisplayName && user.profileDisplayName.trim()) || user.username,
      avatarUrl: toAbsoluteUrl(user.profilePhotoUrl) || user.avatarUrl,
      profileUsername: user.profileUsername || null,
      bio: user.profileBio || ''
    };
  }

  // ── Update Display Name / Username / Bio (tanpa foto — foto lewat savePhoto) ──
  async function updateProfile(discordId, patch) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');

    const set = { profileUpdatedAt: new Date() };

    if (patch.displayName !== undefined) {
      const err = validateDisplayName(patch.displayName);
      if (err) throw new Error(err);
      set.profileDisplayName = cleanText(patch.displayName, DISPLAY_NAME_MAX);
    }

    if (patch.bio !== undefined) {
      const err = validateBio(patch.bio);
      if (err) throw new Error(err);
      set.profileBio = cleanText(patch.bio, BIO_MAX);
    }

    if (patch.username !== undefined) {
      const formatErr = validateUsernameFormat(patch.username);
      if (formatErr) throw new Error(formatErr);
      const normalized = patch.username.trim().toLowerCase();

      const existing = await database.collection('users').findOne({
        profileUsername: normalized,
        discordId: { $ne: discordId }
      });
      if (existing) throw new Error('Username sudah dipakai, coba yang lain.');

      set.profileUsername = normalized;
    }

    if (Object.keys(set).length === 1) throw new Error('Tidak ada perubahan untuk disimpan.');

    await database.collection('users').updateOne({ discordId }, { $set: set });
    const fresh = await database.collection('users').findOne({ discordId });
    if (!fresh) throw new Error('Akun tidak ditemukan.');
    return fresh;
  }

  // ── Upload/ganti foto profil App (base64 data URL) — TIDAK PERNAH menyentuh avatarUrl Discord ──
  //
  // FIX (foto profil hilang/balik jadi avatar default tiap server di-deploy ulang
  // / App di-build ulang): sebelumnya foto disimpan sebagai FILE di disk lokal
  // (fs.writeFileSync ke folder public/uploads/avatars), dan yang tersimpan ke
  // database cuma URL-nya. Folder disk lokal itu TIDAK PERSISTEN — begitu server
  // di-deploy ulang (container baru) atau exe di-build ulang, foldernya balik
  // kosong dari awal padahal dokumen user di database masih nunjuk ke URL lama
  // itu -> hasilnya broken image, App fallback ke avatar gradient default.
  //
  // Perbaikannya: foto disimpan LANGSUNG di MongoDB (koleksi terpisah
  // `profilePhotos`, bukan numpuk di dokumen `users` yang sering dibaca ramai-
  // ramai lewat enrichRows() buat leaderboard/log — biar query-query itu tetap
  // ringan), sama seperti data lain di project ini (role, transaksi, dst) yang
  // memang sudah persisten karena di database, bukan di disk. Field
  // `profilePhotoUrl` di dokumen user tetap berupa URL pendek seperti biasa
  // (route /api/profile/photo/:discordId yang men-stream langsung dari
  // database) — jadi TIDAK ADA perubahan di sisi App/Admin Web sama sekali.
  async function savePhoto(discordId, dataUrl) {
    const database = db();
    if (!database) throw new Error('Database belum siap, coba lagi sebentar.');
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw new Error('Format gambar tidak valid.');
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!match) throw new Error('Format gambar tidak valid.');

    const mime = match[1].toLowerCase();
    const ext = ALLOWED_MIME[mime];
    if (!ext) throw new Error('Format foto harus PNG, JPG, atau WEBP.');

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) throw new Error('File gambar kosong atau rusak.');
    if (buffer.length > PHOTO_MAX_BYTES) throw new Error('Ukuran foto maksimal 3MB.');

    const now = new Date();
    await database.collection(PHOTOS_COLLECTION).updateOne(
      { discordId },
      { $set: { discordId, mime, data: buffer, updatedAt: now } },
      { upsert: true }
    );

    const version = now.getTime();
    const url = `${baseUrl}${routePath}/${encodeURIComponent(discordId)}?v=${version}`;

    await database.collection('users').updateOne(
      { discordId },
      { $set: { profilePhotoUrl: url, profileUpdatedAt: now } }
    );

    const fresh = await database.collection('users').findOne({ discordId });
    if (!fresh) throw new Error('Akun tidak ditemukan.');
    return fresh;
  }

  // Dipakai route GET /api/profile/photo/:discordId di server.js buat stream
  // binary-nya langsung dari MongoDB (dengan Content-Type yang benar).
  async function getPhotoRecord(discordId) {
    const database = db();
    if (!database) return null;
    return database.collection(PHOTOS_COLLECTION).findOne({ discordId });
  }

  // ── Enrich baris (history/logs/transactions/leaderboard dst) dengan identitas
  // TERBARU user, tanpa mengubah data snapshot yang tersimpan di collection asal.
  // idField = nama field discordId di tiap row (default 'discordId', beberapa
  // collection pakai 'userId').
  async function enrichRows(rows, idField = 'discordId') {
    const database = db();
    if (!database || !Array.isArray(rows) || !rows.length) return rows;

    const ids = [...new Set(rows.map(r => r && r[idField]).filter(Boolean))];
    if (!ids.length) return rows;

    const users = await database.collection('users')
      .find({ discordId: { $in: ids } })
      .project({ discordId: 1, username: 1, avatarUrl: 1, profileDisplayName: 1, profilePhotoUrl: 1 })
      .toArray();

    const byId = new Map(users.map(u => [u.discordId, effectiveIdentity(u)]));

    for (const row of rows) {
      const identity = row && byId.get(row[idField]);
      if (!identity) continue;
      row.username = identity.username;
      row.avatarUrl = identity.avatarUrl;
    }
    return rows;
  }

  async function ensureIndexes() {
    const database = db();
    if (!database) return;
    await database.collection(PHOTOS_COLLECTION).createIndex({ discordId: 1 }, { unique: true }).catch(() => {});
  }

  return {
    DISPLAY_NAME_MAX,
    BIO_MAX,
    ensureIndexes,
    getProfile,
    toProfilePayload,
    effectiveIdentity,
    updateProfile,
    savePhoto,
    getPhotoRecord,
    enrichRows,
    validateUsernameFormat,
    validateDisplayName,
    validateBio
  };
};
