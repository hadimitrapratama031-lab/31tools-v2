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
let S3Client, PutObjectCommand, DeleteObjectCommand;
try {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
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

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };

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
    ContentType: mime || 'application/octet-stream'
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

module.exports = { isConfigured, uploadDataUri, deleteObject };
