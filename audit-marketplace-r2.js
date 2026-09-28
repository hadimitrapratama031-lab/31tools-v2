// npm run audit:marketplace-r2 [-- --no-public]
// READ-ONLY. Laporan: konsistensi DB ↔ R2 ↔ URL publik + orphan object R2.
// Tidak menghapus apa pun (cleanup = script terpisah).
const { connect } = require('./marketplaceScriptUtil');
const images = require('./marketplaceImages');
const r2 = require('./r2Storage');

(async () => {
  const { client, db } = await connect();
  try {
    const products = await db.collection('marketplaceProducts').find({}).toArray();
    const checkPublic = !process.argv.includes('--no-public');
    console.log(`Public base: ${r2.getPublicBaseUrl()} -> ${JSON.stringify(images.validatePublicImageUrl(r2.getPublicBaseUrl() + '/'))}`);
    const { summary, problems } = await images.auditProducts(products, { checkPublic });
    console.log('\n== Konsistensi referensi ==');
    console.log(summary);
    for (const p of problems) console.log(`- [${p.status}] ${p.name} (${p.productId}) ${p.kind}${p.key ? ' ' + p.key : ''}: ${p.detail}`);
    const o = await images.findOrphans(products);
    console.log('\n== Orphan R2 (tidak direferensikan produk mana pun) ==');
    console.log(`Objects di R2: ${o.totalObjects}, direferensikan DB: ${o.referenced}, orphan: ${o.orphans.length}`);
    for (const x of o.orphans) console.log(`  orphan: ${x.key} (${x.size} B)`);
    if (o.orphans.length) console.log('\nHapus dengan: npm run cleanup:marketplace-r2  (butuh konfirmasi)');
  } catch (e) { console.error('Audit gagal:', e.message); process.exitCode = 1; }
  finally { await client.close(); }
})();
