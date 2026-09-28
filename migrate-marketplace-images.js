// ══════════════════════════════════════════════════════════════════════════
// MIGRATION — gambar produk Marketplace (base64/Buffer/URL lama) -> Cloudflare R2
//
//   npm run migrate:marketplace-images -- --dry-run   (baca saja, tidak ubah apa pun)
//   npm run migrate:marketplace-images                (migrasi sungguhan)
//
// IDEMPOTENT: produk yang sudah punya image.key R2 valid DILEWATI. Kalau proses
// berhenti di tengah, jalankan ulang — cuma produk yang belum selesai yang
// diproses. Data lama (imageData) HANYA dihapus setelah: upload OK -> object
// terverifikasi di R2 -> URL publik 2xx image/* -> DB terupdate & terbaca ulang.
// Kalau salah satu gagal: object baru dibersihkan, data lama TIDAK disentuh.
// Secret R2 tidak pernah dicetak.
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const r2 = require('./r2Storage');
const images = require('./marketplaceImages');

const DRY_RUN = process.argv.includes('--dry-run');

// Ambil bytes gambar dari sumber legacy manapun. Return { buffer } atau { error }.
async function loadLegacySource(src) {
  if (!src) return { error: 'kosong' };
  if (typeof src === 'object' && !Buffer.isBuffer(src) && !src.buffer) {
    // entry objek legacy: {imageData|data|url|imageUrl}
    return loadLegacySource(src.imageData || src.data || src.url || src.imageUrl);
  }
  const asBuf = images.legacyToBuffer(src);
  if (asBuf) return { buffer: asBuf };
  if (typeof src === 'string') {
    if (/^https?:\/\//i.test(src)) {
      const v = images.validatePublicImageUrl(src);
      if (!v.ok && /lokal|internal/i.test(v.reason || '')) return { error: `URL lama tidak terjangkau (${v.reason})` };
      try {
        const res = await fetch(src);
        if (!res.ok) return { error: `URL lama HTTP ${res.status}` };
        return { buffer: Buffer.from(await res.arrayBuffer()) };
      } catch (e) { return { error: `URL lama gagal diunduh: ${e.message}` }; }
    }
    // path file lokal relatif project (uploads/..., public/uploads/...)
    const rel = src.replace(/^\/+/, '');
    const abs = path.resolve(__dirname, rel);
    if (abs.startsWith(__dirname + path.sep) && fs.existsSync(abs)) return { buffer: fs.readFileSync(abs) };
    return { error: 'sumber lokal tidak ditemukan' };
  }
  return { error: 'format sumber tidak dikenali' };
}

function legacyMainSource(p) {
  if (p.image && p.image.key) return null; // sudah R2
  return p.imageData || p.imageUrl || null;
}
function legacyAdditional(p) {
  return (Array.isArray(p.additionalImages) ? p.additionalImages : []).filter(a => !(a && typeof a === 'object' && a.key));
}

async function uploadFromSource(productId, kind, src) {
  const loaded = await loadLegacySource(src);
  if (loaded.error) throw new Error(loaded.error);
  const up = await images.uploadProductImage(productId, kind, loaded.buffer, { verifyPublic: true });
  if (!up.publicVerified) {
    await r2.deleteObjectStrict(up.ref.key);
    throw new Error(`URL publik gagal (${up.publicCheck && up.publicCheck.reason})`);
  }
  return up.ref;
}

async function main() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI belum diisi.'); process.exit(1); }
  if (!DRY_RUN && !r2.isConfigured()) {
    console.error('Cloudflare R2 belum dikonfigurasi (CLOUDFLARE_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL). Dibatalkan.');
    process.exit(1);
  }
  const base = r2.getPublicBaseUrl();
  if (!DRY_RUN) {
    const chk = images.validatePublicImageUrl(base + '/');
    if (!chk.ok) { console.error(`R2_PUBLIC_URL tidak valid untuk produksi: ${chk.reason}. Dibatalkan.`); process.exit(1); }
    if (chk.isR2Dev) console.warn('PERINGATAN: R2_PUBLIC_URL memakai r2.dev (non-production, rate-limited). Pakai Custom Domain untuk produksi.');
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const dbName = process.env.MONGODB_URI.split('/').pop()?.split('?')[0] || 'test';
  const db = client.db(dbName || 'test');
  const col = db.collection('marketplaceProducts');
  const ordersCol = db.collection('marketplaceOrders');

  console.log(DRY_RUN ? '=== DRY RUN (tidak ada upload/hapus/update) ===' : '=== MIGRASI SUNGGUHAN ===');
  const products = await col.find({}).toArray();
  const stats = {
    products: products.length, migrated: 0, skipped: 0, failed: 0,
    imgMigrated: 0, imgSkipped: 0, imgFailed: 0, r2Created: 0, r2Failed: 0,
    // dry-run
    needMigration: 0, alreadyR2: 0, legacy: 0, invalid: 0, mainImages: 0, additionalImages: 0, potentialFailures: 0
  };

  console.log('Started\n');
  let n = 0;
  for (const p of products) {
    n++;
    const pid = String(p._id);
    const tag = `Product ${n}/${products.length}`;
    const mainSrc = legacyMainSource(p);
    const addSrcs = legacyAdditional(p);
    const hasImageAtAll = !!(p.image && p.image.key) || !!mainSrc || (p.additionalImages || []).length;

    if (p.image && p.image.key) stats.alreadyR2++;
    if (!mainSrc && !addSrcs.length) {
      stats.skipped++;
      stats.imgSkipped += (p.image && p.image.key ? 1 : 0) + (p.additionalImages || []).length;
      console.log(`${tag}\nSkipped - ${hasImageAtAll ? 'already R2' : 'no image'} (${p.name})\n`);
      continue;
    }

    stats.needMigration++;
    if (mainSrc) { stats.legacy++; stats.mainImages++; }
    stats.additionalImages += addSrcs.length;

    if (DRY_RUN) {
      // Cek sumber dapat dibaca (baca saja, tanpa upload).
      let bad = 0;
      for (const src of [mainSrc, ...addSrcs].filter(Boolean)) {
        const l = await loadLegacySource(src);
        if (l.error) { bad++; stats.invalid++; }
        else if (!images.sniffImage(l.buffer)) { bad++; stats.invalid++; }
      }
      if (bad) stats.potentialFailures++;
      console.log(`${tag}\nWould migrate - main:${mainSrc ? 1 : 0} additional:${addSrcs.length}${bad ? ` (PERHATIAN: ${bad} sumber bermasalah)` : ''} (${p.name})\n`);
      continue;
    }

    const uploadedKeys = [];
    try {
      let newMain = null;
      if (mainSrc) { newMain = await uploadFromSource(pid, 'main', mainSrc); uploadedKeys.push(newMain.key); stats.r2Created++; }
      const keptAdditional = (p.additionalImages || []).filter(a => a && typeof a === 'object' && a.key);
      const newAdditional = [];
      for (const src of addSrcs) {
        const ref = await uploadFromSource(pid, 'additional', src);
        uploadedKeys.push(ref.key); stats.r2Created++;
        newAdditional.push(ref);
      }
      const set = { updatedAt: new Date() };
      if (newMain) { set.image = newMain; set.imageUrl = newMain.url; }
      if (addSrcs.length) set.additionalImages = [...keptAdditional, ...newAdditional];
      await col.updateOne({ _id: p._id }, { $set: set });

      // Verifikasi DB sebelum menghapus data lama.
      const check = await col.findOne({ _id: p._id });
      if (newMain && !(check.image && check.image.key === newMain.key)) throw new Error('Verifikasi DB gagal (main).');
      if (addSrcs.length && (check.additionalImages || []).filter(a => a && a.key).length !== keptAdditional.length + newAdditional.length) throw new Error('Verifikasi DB gagal (additional).');

      // Sukses penuh -> baru hapus data legacy.
      if (newMain) await col.updateOne({ _id: p._id }, { $unset: { imageData: '' } });
      stats.migrated++;
      stats.imgMigrated += (newMain ? 1 : 0) + newAdditional.length;
      console.log(`${tag}\nMigrated - main:${newMain ? 1 : 0} additional:${newAdditional.length} (${p.name})\n`);
    } catch (e) {
      // Rollback object baru; data lama tidak disentuh.
      for (const k of uploadedKeys) { const ok = await r2.deleteObjectStrict(k); if (!ok) stats.r2Failed++; }
      stats.failed++;
      stats.imgFailed += (mainSrc ? 1 : 0) + addSrcs.length;
      console.log(`${tag}\nFailed - ${e.message} (${p.name})\n`);
    }
  }

  // Snapshot order lama yang masih menyimpan base64 -> rujuk URL R2 produk.
  const orderCount = await ordersCol.countDocuments({ 'productSnapshot.imageData': { $exists: true, $ne: null } });
  if (orderCount) {
    console.log(`Order snapshot dengan imageData: ${orderCount}`);
    if (!DRY_RUN) {
      let fixed = 0, unresolved = 0;
      const cursor = ordersCol.find({ 'productSnapshot.imageData': { $exists: true, $ne: null } }, { projection: { productId: 1 } });
      for await (const o of cursor) {
        const prod = ObjectIdSafe(o.productId) ? await col.findOne({ _id: ObjectIdSafe(o.productId) }) : null;
        if (prod && prod.image && prod.image.key) {
          await ordersCol.updateOne({ _id: o._id }, { $set: { 'productSnapshot.imageUrl': prod.image.url, 'productSnapshot.imageKey': prod.image.key }, $unset: { 'productSnapshot.imageData': '' } });
          fixed++;
        } else unresolved++; // produk sudah tidak ada/belum R2 -> imageData dibiarkan, tidak ada data yang hilang
      }
      console.log(`Order snapshot dimigrasi: ${fixed}, dibiarkan (produk tidak tersedia): ${unresolved}`);
    }
  }

  console.log('\n──────── HASIL ────────');
  if (DRY_RUN) {
    console.log(`Total products: ${stats.products}`);
    console.log(`Products needing migration: ${stats.needMigration}`);
    console.log(`Products already on R2: ${stats.alreadyR2}`);
    console.log(`Products with legacy image: ${stats.legacy}`);
    console.log(`Products with invalid image (sumber tak terbaca/bukan gambar): ${stats.invalid}`);
    console.log(`Main images to migrate: ${stats.mainImages}`);
    console.log(`Additional images to migrate: ${stats.additionalImages}`);
    console.log(`Potential failures (products): ${stats.potentialFailures}`);
  } else {
    console.log(`Products:\n  Migrated: ${stats.migrated}\n  Skipped: ${stats.skipped}\n  Failed: ${stats.failed}`);
    console.log(`Images:\n  Migrated: ${stats.imgMigrated}\n  Skipped: ${stats.imgSkipped}\n  Failed: ${stats.imgFailed}`);
    console.log(`R2 objects created: ${stats.r2Created}\nR2 objects failed: ${stats.r2Failed}`);
    if (stats.failed) process.exitCode = 1;
  }
  await client.close();
}

function ObjectIdSafe(id) {
  const { ObjectId } = require('mongodb');
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

main().catch(e => { console.error('Migrasi berhenti karena error:', e.message); process.exit(1); });
