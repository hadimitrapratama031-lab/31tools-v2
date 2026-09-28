// ══════════════════════════════════════════════════════════════════════════
// MARKETPLACE PRODUCT IMAGES — semua logika gambar produk Marketplace.
//
// File gambar HANYA hidup di Cloudflare R2 (lewat r2Storage.js — client &
// credential R2 yang SUDAH ADA, tidak ada client kedua). MongoDB cuma
// menyimpan referensi/metadata:
//   image:            { id, key, url, contentType, size, uploadedAt }   (1 main)
//   additionalImages: [ { id, key, url, contentType, size, uploadedAt } ] (maks 5)
//   imageUrl:         string — kompatibilitas App versi lama (= image.url)
//   imageData:        LEGACY base64/Buffer — hanya dibaca oleh migration,
//                     dan dihapus setelah migrasi sukses.
//
// URL yang dikonsumsi Marketplace/App SELALU URL publik (R2_PUBLIC_URL →
// custom domain Cloudflare), BUKAN endpoint S3 (…r2.cloudflarestorage.com)
// dan BUKAN presigned URL.
// ══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const r2 = require('./r2Storage');

const KEY_PREFIX = 'marketplace/products';
const MAX_ADDITIONAL_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Deteksi tipe SEBENARNYA dari magic bytes (bukan percaya header client).
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let mime = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mime = 'image/png';
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg';
  else if (buf.slice(0, 4).toString('ascii') === 'GIF8') mime = 'image/gif';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
  return mime ? { mime, ext: EXT_BY_MIME[mime] } : null;
}

// data URI / base64 / Buffer / BSON Binary -> Buffer (dipakai migration).
function legacyToBuffer(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string') {
    if (raw.startsWith('data:')) {
      const i = raw.indexOf(',');
      return i === -1 ? null : Buffer.from(raw.slice(i + 1), 'base64');
    }
    // base64 mentah tanpa prefix "data:"
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 64) return Buffer.from(raw, 'base64');
    return null;
  }
  if (raw && raw.buffer) {
    try { return Buffer.isBuffer(raw.buffer) ? raw.buffer : Buffer.from(raw.buffer); } catch (e) { return null; }
  }
  return null;
}

function newKey(productId, kind /* 'main' | 'additional' */, ext) {
  return `${KEY_PREFIX}/${productId}/${kind}/${crypto.randomUUID()}.${ext}`;
}

function productKeyPrefix(productId) { return `${KEY_PREFIX}/${productId}/`; }

// ── Validasi URL publik ─────────────────────────────────────────────────
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)|\.local$|\.internal$|\.railway\.internal$/i;

// Hasil: { ok, reason }. Tidak melakukan request network.
function validatePublicImageUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'URL kosong' };
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: 'URL tidak valid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Bukan HTTPS' };
  if (PRIVATE_HOST_RE.test(u.hostname)) return { ok: false, reason: 'Hostname lokal/internal' };
  if (/\.r2\.cloudflarestorage\.com$/i.test(u.hostname)) return { ok: false, reason: 'URL S3 API R2 (private), bukan URL publik' };
  if (/[?&]X-Amz-(Algorithm|Credential|Expires|Signature)=/i.test(u.search)) return { ok: false, reason: 'Presigned URL (sementara)' };
  return { ok: true, reason: null, isR2Dev: /\.r2\.dev$/i.test(u.hostname) };
}

// Request nyata ke URL publik — TANPA header auth/cookie. Butuh 2xx + image/*.
async function verifyPublicUrl(url, { timeoutMs = 8000 } = {}) {
  const v = validatePublicImageUrl(url);
  if (!v.ok) return { ok: false, status: null, reason: v.reason };
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = method === 'GET' ? { Range: 'bytes=0-0' } : {};
      const res = await fetch(url, { method, headers, redirect: 'manual', signal: ctrl.signal });
      try { if (method === 'GET') await res.arrayBuffer(); } catch (e) { /* abaikan */ }
      return res;
    } finally { clearTimeout(t); }
  };
  try {
    let res = await attempt('HEAD');
    if (res.status === 405 || res.status === 403 || res.status >= 500) res = await attempt('GET');
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, reason: `Redirect ke ${res.headers.get('location') || '?'}` };
    if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return { ok: false, status: res.status, contentType: ct, reason: `Content-Type bukan image/* (${ct || 'kosong'})` };
    return { ok: true, status: res.status, contentType: ct, reason: null };
  } catch (e) {
    return { ok: false, status: null, reason: e.name === 'AbortError' ? 'Timeout' : `Network: ${e.message}` };
  }
}

// ── Canonical resolver ──────────────────────────────────────────────────
// SATU-SATUNYA tempat yang menyusun URL gambar produk (sisi server).
// Prioritas: (1) url R2 publik valid → (2) key + R2_PUBLIC_URL →
// (3) legacy imageUrl (sementara, hanya kalau bukan URL terlarang) →
// (4) endpoint legacy sementara untuk imageData yang belum dimigrasi → null.
function resolveImageRef(ref, { legacyFallbackUrl } = {}) {
  if (ref && typeof ref === 'object') {
    const byKey = ref.key ? r2.publicUrlForKey(ref.key) : null;
    if (ref.url && validatePublicImageUrl(ref.url).ok && (!byKey || r2.keyFromPublicUrl(ref.url))) return ref.url;
    if (byKey) return byKey;
  }
  if (legacyFallbackUrl && validatePublicImageUrl(legacyFallbackUrl).ok) return legacyFallbackUrl;
  return null;
}

function legacyEndpointUrl(productId) {
  const base = (process.env.SERVER_URL || '').replace(/\/+$/, '');
  if (!base || !validatePublicImageUrl(base + '/').ok) return null;
  return `${base}/api/marketplace/legacy-image/${productId}`;
}

// Bentuk yang dikirim ke Admin Web / App. TIDAK PERNAH memuat imageData.
function publicImageFields(p) {
  const main = resolveImageRef(p.image, { legacyFallbackUrl: p.imageUrl });
  const hasLegacyData = !!p.imageData;
  const imageUrl = main || (hasLegacyData ? legacyEndpointUrl(String(p._id)) : null);
  const additional = (Array.isArray(p.additionalImages) ? p.additionalImages : [])
    .map(a => ({ id: a.id || null, url: resolveImageRef(a), key: a.key || null }))
    .filter(a => a.url);
  return {
    imageUrl,
    imageKey: p.image && p.image.key ? p.image.key : null,
    imageLegacy: !(p.image && p.image.key),   // true = belum di R2
    additionalImages: additional
  };
}

// Semua key R2 yang dimiliki produk ini (main + additional).
function ownedKeys(p) {
  const keys = [];
  if (p && p.image && p.image.key) keys.push(p.image.key);
  for (const a of (p && p.additionalImages) || []) if (a && a.key) keys.push(a.key);
  return keys;
}

// Upload 1 gambar: validasi → PUT ke R2 → HEAD verify object → (opsional)
// verify URL publik. THROW kalau upload/HEAD gagal (DB belum disentuh).
async function uploadProductImage(productId, kind, buffer, { verifyPublic = true } = {}) {
  if (!r2.isConfigured()) throw new Error('Cloudflare R2 belum dikonfigurasi di server.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('File gambar kosong.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Ukuran gambar maksimal ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
  const sniffed = sniffImage(buffer);
  if (!sniffed || !ALLOWED_MIME.includes(sniffed.mime)) throw new Error('Format gambar tidak didukung (harus JPG, PNG, WEBP, atau GIF).');

  const key = newKey(productId, kind, sniffed.ext);
  await r2.uploadBuffer(buffer, key, { contentType: sniffed.mime });
  const head = await r2.headObject(key);
  if (!head.exists) {
    await r2.deleteObjectStrict(key);
    throw new Error('Upload ke R2 tidak terverifikasi (object tidak ditemukan setelah upload).');
  }
  const url = r2.publicUrlForKey(key);
  const ref = { id: crypto.randomUUID(), key, url, contentType: sniffed.mime, size: buffer.length, uploadedAt: new Date() };
  const publicCheck = verifyPublic ? await verifyPublicUrl(url) : null;
  return { ref, publicCheck, publicVerified: publicCheck ? publicCheck.ok : null };
}


// ── Audit konsistensi DB ↔ R2 ↔ URL publik ─────────────────────────────
// healthy  = DB ref ada + object R2 ada + URL publik 2xx image/*
// missing  = DB ref ada, object R2 TIDAK ada
// broken   = object ada tapi URL publik gagal / content-type salah / url≠key
// invalidUrl = URL terlarang (http, localhost, S3 API, presigned, kosong)
// legacy   = masih imageData/base64 atau URL non-R2 (belum dimigrasi)
async function auditProducts(products, { checkPublic = true, concurrency = 6 } = {}) {
  const summary = { products: products.length, total: 0, healthy: 0, broken: 0, legacy: 0, missing: 0, invalidUrl: 0 };
  const problems = [];
  const tasks = [];
  for (const p of products) {
    const pid = String(p._id);
    if (p.imageData) { summary.total++; summary.legacy++; problems.push({ productId: pid, name: p.name, kind: 'main', status: 'legacy', detail: 'imageData (base64/binary) masih di MongoDB' }); }
    else if (!(p.image && p.image.key) && p.imageUrl) { summary.total++; summary.legacy++; problems.push({ productId: pid, name: p.name, kind: 'main', status: 'legacy', detail: 'imageUrl bukan referensi R2' }); }
    if (p.image && p.image.key) tasks.push({ pid, name: p.name, kind: 'main', ref: p.image });
    for (const a of (p.additionalImages || [])) tasks.push({ pid, name: p.name, kind: 'additional', ref: a });
  }
  const runOne = async (t) => {
    summary.total++;
    const expected = r2.publicUrlForKey(t.ref.key);
    const v = validatePublicImageUrl(t.ref.url || expected);
    if (!v.ok) { summary.invalidUrl++; problems.push({ productId: t.pid, name: t.name, kind: t.kind, key: t.ref.key, status: 'invalidUrl', detail: v.reason }); return; }
    const head = await r2.headObject(t.ref.key);
    if (!head.exists) { summary.missing++; problems.push({ productId: t.pid, name: t.name, kind: t.kind, key: t.ref.key, status: 'missing', detail: head.error || 'Object tidak ada di R2' }); return; }
    if (head.contentType && !/^image\//i.test(head.contentType)) { summary.broken++; problems.push({ productId: t.pid, name: t.name, kind: t.kind, key: t.ref.key, status: 'broken', detail: `Content-Type object salah: ${head.contentType}` }); return; }
    if (t.ref.url !== expected) { summary.broken++; problems.push({ productId: t.pid, name: t.name, kind: t.kind, key: t.ref.key, status: 'broken', detail: 'URL di DB tidak sama dengan URL canonical (bisa di-repair)', repairable: true }); return; }
    if (checkPublic) {
      const pub = await verifyPublicUrl(expected);
      if (!pub.ok) { summary.broken++; problems.push({ productId: t.pid, name: t.name, kind: t.kind, key: t.ref.key, status: 'broken', detail: `URL publik gagal: ${pub.reason}` }); return; }
    }
    summary.healthy++;
  };
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; await runOne(t); }
  }));
  return { summary, problems };
}

// Object R2 di bawah marketplace/products/ yang TIDAK direferensikan produk
// mana pun (termasuk produk soft-deleted). Hanya melaporkan — tidak menghapus.
async function findOrphans(products) {
  const referenced = new Set();
  for (const p of products) for (const k of ownedKeys(p)) referenced.add(k);
  const objects = await r2.listKeys(KEY_PREFIX + '/');
  const orphans = objects.filter(o => !referenced.has(o.key));
  return { totalObjects: objects.length, referenced: referenced.size, orphans };
}

module.exports = {
  KEY_PREFIX, MAX_ADDITIONAL_IMAGES, MAX_IMAGE_BYTES, ALLOWED_MIME,
  sniffImage, legacyToBuffer, newKey, productKeyPrefix,
  validatePublicImageUrl, verifyPublicUrl,
  resolveImageRef, publicImageFields, legacyEndpointUrl, ownedKeys,
  uploadProductImage, auditProducts, findOrphans
};
