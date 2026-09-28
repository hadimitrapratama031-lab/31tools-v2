// ══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE R2 STORAGE — image storage untuk App Customization & Setting
// Banner (lihat appCustomizationManager.js / bannerManager.js).
//
// SATU-SATUNYA tempat credential Cloudflare R2 dibaca & dipakai di seluruh
// project. appCustomizationManager.js/bannerManager.js/server.js TIDAK
// PERNAH membaca env var R2_*/CLOUDFLARE_ACCOUNT_ID langsung — semuanya
// lewat fungsi modul ini. Credential TIDAK PERNAH dikirim ke Admin Web,
// APP Electron, atau browser client — cuma dipakai di proses Node backend
// ini untuk request ke Cloudflare.
//
// R2 API kompatibel S3, jadi dipakai @aws-sdk/client-s3 (S3-compatible
// client) — TIDAK ada dependency khusus Cloudflare yang perlu ditambahkan.
//
// Kalau environment variable belum diisi (mis. saat development lokal atau
// sebelum di-setup di production), isConfigured() = false dan
// uploadDataUri()/deleteObject() akan throw/no-op dengan pesan jelas —
// TIDAK membuat server crash saat startup hanya karena R2 belum siap.
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
let S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand;
try {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  // Dependency belum ter-install (`npm install`) — biarkan module tetap bisa
  // di-require (isConfigured() akan selalu false, upload akan throw pesan
  // jelas), supaya bagian lain server tidak ikut gagal start gara-gara ini.
  console.warn('[R2] @aws-sdk/client-s3 belum ter-install. Jalankan `npm install` untuk mengaktifkan Cloudflare R2 storage.');
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
// R2_PUBLIC_URL = base URL publik/CDN (custom domain atau r2.dev), TANPA
// trailing slash — dinormalisasi di bawah supaya `${PUBLIC_URL}/${key}`
// tidak pernah menghasilkan "//" ganda.
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

function isConfigured() {
  return !!(S3Client && ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET_NAME && PUBLIC_URL);
}

let _client = null;
function client() {
  if (_client) return _client;
  if (!isConfigured()) return null;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY }
  });
  return _client;
}

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
// Key object selalu unik (timestamp/uuid), jadi aman di-cache selamanya di CDN/browser.
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function dataUriMime(dataUri) {
  const m = /^data:([^;,]+)/i.exec(dataUri);
  return m ? m[1].toLowerCase() : '';
}
function dataUriToBuffer(dataUri) {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) return null;
  return Buffer.from(dataUri.slice(commaIdx + 1), 'base64');
}

// prefix contoh: 'app-customization/background', 'app-customization/logo',
// 'banners'. Dipanggil HANYA setelah pemanggil (appCustomizationManager.js /
// bannerManager.js) sudah memvalidasi MIME/ukuran data URI sendiri — modul
// ini tidak menduplikasi validasi itu, cuma menaruh buffer yang sudah valid
// ke R2 dan mengembalikan referensinya.
async function uploadDataUri(dataUri, prefix) {
  if (!isConfigured()) {
    throw new Error('Cloudflare R2 belum dikonfigurasi di server (cek environment variable CLOUDFLARE_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL).');
  }
  const mime = dataUriMime(dataUri);
  const buffer = dataUriToBuffer(dataUri);
  if (!buffer) throw new Error('Data gambar tidak valid.');
  const ext = EXT_BY_MIME[mime] || 'bin';
  const key = `${prefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  await client().send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mime || 'application/octet-stream',
    CacheControl: IMMUTABLE_CACHE
  }));
  return { url: `${PUBLIC_URL}/${key}`, key, mimeType: mime, size: buffer.length };
}

// Best-effort — dipanggil SETELAH pemanggil sudah memastikan object lama ini
// benar-benar tidak dipakai lagi (config/banner baru sudah tersimpan di
// MongoDB). Tidak pernah throw supaya kegagalan cleanup R2 (mis. network
// blip) tidak menggagalkan flow Save yang sebenarnya sudah sukses di sisi
// database — cuma di-log sebagai warning.
async function deleteObject(key) {
  if (!key) return;
  if (!isConfigured()) return;
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (e) {
    console.warn('[R2] Gagal hapus object', key, '-', e.message);
  }
}

// ── Tambahan untuk Marketplace Product Images (lihat marketplaceImages.js) ──
// Semua tetap lewat client()/credential di atas — TIDAK ada R2 client kedua.

function getPublicBaseUrl() { return PUBLIC_URL; }
function getBucketName() { return BUCKET_NAME; }

// Canonical public URL dari key. Tidak pernah memakai endpoint S3 API.
function publicUrlForKey(key) {
  if (!key || !PUBLIC_URL) return null;
  return `${PUBLIC_URL}/${String(key).replace(/^\/+/, '')}`;
}

// Kebalikan: kalau URL memang milik R2_PUBLIC_URL kita, kembalikan key-nya.
function keyFromPublicUrl(url) {
  if (!url || !PUBLIC_URL || typeof url !== 'string') return null;
  if (!url.startsWith(PUBLIC_URL + '/')) return null;
  try { return decodeURIComponent(url.slice(PUBLIC_URL.length + 1).split(/[?#]/)[0]) || null; }
  catch (e) { return null; }
}

// Upload buffer biner langsung (bukan data URI). THROW kalau gagal, supaya
// pemanggil bisa membatalkan alur sebelum menyentuh database.
async function uploadBuffer(buffer, key, { contentType, cacheControl } = {}) {
  if (!isConfigured()) throw new Error('Cloudflare R2 belum dikonfigurasi di server.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Data gambar kosong.');
  await client().send(new PutObjectCommand({
    Bucket: BUCKET_NAME, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl || IMMUTABLE_CACHE
  }));
  return { key, url: publicUrlForKey(key), size: buffer.length, contentType };
}

// Cek object benar-benar ada di bucket (via API S3, butuh credential).
async function headObject(key) {
  if (!isConfigured() || !key) return { exists: false, error: 'not-configured' };
  try {
    const r = await client().send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return { exists: true, size: r.ContentLength, contentType: r.ContentType, cacheControl: r.CacheControl };
  } catch (e) {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    if (status === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey') return { exists: false };
    return { exists: false, error: e.message };
  }
}

async function getObjectBuffer(key) {
  if (!isConfigured()) throw new Error('Cloudflare R2 belum dikonfigurasi di server.');
  const r = await client().send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// List semua key di bawah prefix (paging otomatis) — dipakai audit orphan.
async function listKeys(prefix) {
  if (!isConfigured()) throw new Error('Cloudflare R2 belum dikonfigurasi di server.');
  const out = [];
  let token;
  do {
    const r = await client().send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, ContinuationToken: token }));
    for (const o of (r.Contents || [])) out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// Seperti deleteObject tapi mengembalikan true/false (tidak silent) — dipakai
// alur yang perlu tahu hasil cleanup. Tetap tidak throw.
async function deleteObjectStrict(key) {
  if (!key || !isConfigured()) return false;
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return true;
  } catch (e) {
    console.warn('[R2] Gagal hapus object', key, '-', e.message);
    return false;
  }
}

module.exports = {
  isConfigured, uploadDataUri, deleteObject,
  getPublicBaseUrl, getBucketName, publicUrlForKey, keyFromPublicUrl,
  uploadBuffer, headObject, getObjectBuffer, listKeys, deleteObjectStrict, IMMUTABLE_CACHE
};
