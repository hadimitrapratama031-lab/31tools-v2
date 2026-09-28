// npm run cleanup:marketplace-r2            -> tampilkan orphan + minta konfirmasi (ketik "HAPUS")
// npm run cleanup:marketplace-r2 -- --yes   -> non-interaktif (untuk CI/produksi terkontrol)
// DESTRUCTIVE: hanya menghapus object di marketplace/products/ yang TIDAK
// direferensikan produk manapun (termasuk soft-deleted). Aman dijalankan ulang.
const readline = require('readline');
const { connect } = require('./marketplaceScriptUtil');
const images = require('./marketplaceImages');
const r2 = require('./r2Storage');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

(async () => {
  const { client, db } = await connect();
  try {
    const products = await db.collection('marketplaceProducts').find({}).toArray();
    const { orphans } = await images.findOrphans(products);
    console.log(`Orphan ditemukan: ${orphans.length}`);
    orphans.forEach(o => console.log('  ' + o.key));
    if (!orphans.length) return;
    if (!process.argv.includes('--yes')) {
      const a = await ask('\nKetik HAPUS untuk menghapus object di atas dari R2: ');
      if (a.trim() !== 'HAPUS') { console.log('Dibatalkan.'); return; }
    }
    let ok = 0, fail = 0;
    for (const o of orphans) (await r2.deleteObjectStrict(o.key)) ? ok++ : fail++;
    console.log(`Terhapus: ${ok}, gagal: ${fail}`);
  } catch (e) { console.error('Cleanup gagal:', e.message); process.exitCode = 1; }
  finally { await client.close(); }
})();
