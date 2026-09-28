// Helper kecil untuk script CLI Marketplace images (audit/repair/cleanup).
require('dotenv').config();
const { MongoClient } = require('mongodb');
const r2 = require('./r2Storage');

async function connect() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI belum diisi.'); process.exit(1); }
  if (!r2.isConfigured()) {
    console.error('Cloudflare R2 belum dikonfigurasi (CLOUDFLARE_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL).');
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const dbName = process.env.MONGODB_URI.split('/').pop()?.split('?')[0] || 'test';
  return { client, db: client.db(dbName || 'test') };
}

module.exports = { connect };
