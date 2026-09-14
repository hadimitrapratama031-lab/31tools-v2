// ══════════════════════════════════════════════════════════════════════════
// MIGRATION — pindahkan gambar App Customization (background/logo) & Banner
// yang MASIH tersimpan sebagai data URI base64 di MongoDB ke Cloudflare R2.
//
// AMAN dijalankan berkali-kali (idempotent): dokumen yang url-nya sudah
// bukan "data:..." (sudah URL R2/http biasa, atau memang kosong) dilewati
// begitu saja, tidak disentuh. TIDAK melakukan mass-delete apa pun — cuma
// mengganti isi field `image.url`/`background.image.url`/`branding.logo.url`
// pada dokumen yang memang masih base64, satu per satu, dan hanya setelah
// upload ke R2 masing-masing sukses.
//
// Jalankan manual dari root project:
//   node migrate-images-to-r2.js            -> migrasi sungguhan
//   node migrate-images-to-r2.js --dry-run  -> cuma menghitung/menampilkan
//                                               apa yang AKAN dimigrasi,
//                                               TIDAK mengubah apa pun
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { MongoClient } = require('mongodb');
const r2Storage = require('./r2Storage');

const DRY_RUN = process.argv.includes('--dry-run');

function isDataUri(v) {
  return typeof v === 'string' && v.startsWith('data:');
}

async function migrateAppCustomization(db) {
  const doc = await db.collection('settings').findOne({ _id: 'appCustomization' });
  if (!doc) {
    console.log('[AppCustomization] Tidak ada dokumen config — dilewati.');
    return;
  }

  const set = {};
  const bgUrl = doc.background && doc.background.image && doc.background.image.url;
  if (isDataUri(bgUrl)) {
    console.log('[AppCustomization] Background image base64 ditemukan, mengupload ke R2...');
    if (!DRY_RUN) {
      const uploaded = await r2Storage.uploadDataUri(bgUrl, 'app-customization/background');
      set['background.image.url'] = uploaded.url;
      set['background.image.key'] = uploaded.key;
      set['background.image.mimeType'] = uploaded.mimeType;
      set['background.image.fileSize'] = uploaded.size;
      console.log('[AppCustomization] Background image ->', uploaded.url);
    } else {
      console.log('[AppCustomization] (dry-run) akan diupload ke prefix app-customization/background');
    }
  } else {
    console.log('[AppCustomization] Background image sudah bukan base64 (atau kosong) — dilewati.');
  }

  const logoUrl = doc.branding && doc.branding.logo && doc.branding.logo.url;
  if (isDataUri(logoUrl)) {
    console.log('[AppCustomization] Logo base64 ditemukan, mengupload ke R2...');
    if (!DRY_RUN) {
      const uploaded = await r2Storage.uploadDataUri(logoUrl, 'app-customization/logo');
      set['branding.logo.url'] = uploaded.url;
      set['branding.logo.key'] = uploaded.key;
      set['branding.logo.mimeType'] = uploaded.mimeType;
      set['branding.logo.fileSize'] = uploaded.size;
      console.log('[AppCustomization] Logo ->', uploaded.url);
    } else {
      console.log('[AppCustomization] (dry-run) akan diupload ke prefix app-customization/logo');
    }
  } else {
    console.log('[AppCustomization] Logo sudah bukan base64 (atau kosong) — dilewati.');
  }

  if (!DRY_RUN && Object.keys(set).length) {
    await db.collection('settings').updateOne({ _id: 'appCustomization' }, { $set: set });
    console.log('[AppCustomization] Dokumen config diupdate.');
  }
}

async function migrateBanners(db) {
  const banners = await db.collection('banners').find({}).toArray();
  console.log(`[Banners] ${banners.length} banner ditemukan.`);
  for (const banner of banners) {
    const url = banner.image && banner.image.url;
    if (!isDataUri(url)) {
      console.log(`[Banners] ${banner._id} — bukan base64, dilewati.`);
      continue;
    }
    console.log(`[Banners] ${banner._id} — base64 ditemukan, mengupload ke R2...`);
    if (DRY_RUN) {
      console.log(`[Banners] ${banner._id} — (dry-run) akan diupload ke prefix banners`);
      continue;
    }
    const uploaded = await r2Storage.uploadDataUri(url, 'banners');
    await db.collection('banners').updateOne(
      { _id: banner._id },
      { $set: {
        'image.url': uploaded.url,
        'image.key': uploaded.key,
        'image.mimeType': uploaded.mimeType,
        'image.fileSize': uploaded.size
      } }
    );
    console.log(`[Banners] ${banner._id} -> ${uploaded.url}`);
  }
}

async function main() {
  if (!r2Storage.isConfigured()) {
    console.error('Cloudflare R2 belum dikonfigurasi (cek .env: CLOUDFLARE_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL). Migrasi dibatalkan.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI belum diisi di .env. Migrasi dibatalkan.');
    process.exit(1);
  }

  console.log(DRY_RUN ? '=== DRY RUN (tidak ada perubahan yang disimpan) ===' : '=== MIGRASI SUNGGUHAN ===');

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();

  try {
    await migrateAppCustomization(db);
    await migrateBanners(db);
    console.log('Selesai.');
  } catch (e) {
    console.error('Migrasi berhenti karena error:', e.message);
    console.error('Data yang SUDAH berhasil dimigrasi sebelum error ini TETAP tersimpan seperti apa adanya (tidak di-rollback) — jalankan ulang script ini, dokumen yang sudah bukan base64 akan otomatis dilewati.');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
