// npm run repair:marketplace-images            -> laporan saja
// npm run repair:marketplace-images -- --apply -> terapkan perbaikan
// Memperbaiki referensi DB yang rusak TANPA membuat object baru:
//  (1) url di DB ≠ URL canonical dari key -> tulis ulang url canonical
//  (2) produk tanpa main image tapi object main/ masih ada di R2 -> sambungkan
//      kembali (object terbaru). Referensi yang object-nya hilang dilaporkan
//      (tidak bisa diperbaiki otomatis).
const { connect } = require('./marketplaceScriptUtil');
const images = require('./marketplaceImages');
const r2 = require('./r2Storage');
const crypto = require('crypto');

(async () => {
  const APPLY = process.argv.includes('--apply');
  const { client, db } = await connect();
  const col = db.collection('marketplaceProducts');
  try {
    const products = await col.find({}).toArray();
    let urlFixed = 0, relinked = 0, missing = 0;
    const objects = await r2.listKeys(images.KEY_PREFIX + '/');
    for (const p of products) {
      const pid = String(p._id);
      const set = {};
      if (p.image && p.image.key) {
        const canonical = r2.publicUrlForKey(p.image.key);
        if (p.image.url !== canonical) { set['image.url'] = canonical; set.imageUrl = canonical; urlFixed++; console.log(`[url] ${p.name}: main -> ${canonical}`); }
        if (!(await r2.headObject(p.image.key)).exists) { missing++; console.log(`[missing] ${p.name}: object main hilang di R2 (${p.image.key})`); }
      } else if (!p.imageData) {
        const cands = objects.filter(o => o.key.startsWith(`${images.KEY_PREFIX}/${pid}/main/`)).sort((a, b) => b.lastModified - a.lastModified);
        if (cands.length) {
          const o = cands[0];
          const head = await r2.headObject(o.key);
          const ref = { id: crypto.randomUUID(), key: o.key, url: r2.publicUrlForKey(o.key), contentType: head.contentType || null, size: o.size, uploadedAt: o.lastModified };
          set.image = ref; set.imageUrl = ref.url; relinked++;
          console.log(`[relink] ${p.name}: main -> ${o.key}`);
        }
      }
      const adds = Array.isArray(p.additionalImages) ? p.additionalImages : [];
      const fixedAdds = adds.map(a => (a && a.key && a.url !== r2.publicUrlForKey(a.key)) ? { ...a, url: r2.publicUrlForKey(a.key) } : a);
      if (fixedAdds.some((a, i) => a !== adds[i])) { set.additionalImages = fixedAdds; urlFixed++; console.log(`[url] ${p.name}: additional diperbaiki`); }
      if (APPLY && Object.keys(set).length) await col.updateOne({ _id: p._id }, { $set: { ...set, updatedAt: new Date() } });
    }
    console.log(`\n${APPLY ? 'DITERAPKAN' : 'LAPORAN (tambahkan --apply untuk menerapkan)'} — url diperbaiki: ${urlFixed}, di-relink: ${relinked}, object hilang (manual): ${missing}`);
  } catch (e) { console.error('Repair gagal:', e.message); process.exitCode = 1; }
  finally { await client.close(); }
})();
