// ══════════════════════════════════════════════════════════════════════════
// NOVA LAUNCHER — BACKEND
// Project baru dari 0. Struktur sengaja dipisah rapi per bagian (cari header
// "════" di bawah buat lompat ke bagian yang kamu mau).
// ══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
app.use(cors());

// ══════════════════════════════════════════════════════════════════════════
// ── DISCORD INTERACTIONS ENDPOINT (slash command) ──
// PENTING: route ini WAJIB didaftarkan SEBELUM `app.use(express.json())` di bawah,
// dan pakai express.raw() (bukan express.json()) khusus untuk path ini. Alasannya:
// verifikasi signature Ed25519 dari Discord butuh RAW BYTES persis seperti yang
// dikirim Discord — kalau body-nya sudah kepalang di-parse jadi objek JS lalu
// di-stringify ulang, hasilnya BISA beda urutan/spasi dari body asli, dan
// signature-nya jadi tidak pernah valid walau secara isi datanya "sama".
//
// Ini juga yang menjawab error "interactions_endpoint_url could not be verified"
// di Discord Developer Portal — sebelumnya endpoint ini belum ada sama sekali,
// jadi request PING verifikasi dari Discord cuma dapat 404.
// ══════════════════════════════════════════════════════════════════════════
const nacl = require('tweetnacl');
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

app.post('/api/discord/interactions', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  const rawBody = req.body; // Buffer mentah (bukan objek), karena route ini pakai express.raw()

  if (!DISCORD_PUBLIC_KEY) {
    console.error('[Discord Interactions] DISCORD_PUBLIC_KEY belum diset di .env — cek di Developer Portal > General Information > Public Key');
    return res.status(500).send('DISCORD_PUBLIC_KEY belum dikonfigurasi di server');
  }
  if (!signature || !timestamp || !Buffer.isBuffer(rawBody)) {
    return res.status(401).send('invalid request signature');
  }

  let isValid = false;
  try {
    isValid = nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      Buffer.from(signature, 'hex'),
      Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
    );
  } catch (e) {
    isValid = false; // signature/public key format salah -> anggap tidak valid, jangan crash
  }

  if (!isValid) {
    return res.status(401).send('invalid request signature');
  }

  const interaction = JSON.parse(rawBody.toString('utf8'));

  // Type 1 = PING. Ini yang dikirim Discord saat kamu klik "Save Changes" di
  // Developer Portal untuk verifikasi URL-nya — WAJIB dibalas persis { type: 1 }
  // dalam beberapa detik, kalau tidak validasinya gagal terus.
  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  // Type 2 = Application Command (slash command). Belum ada command spesifik yang
  // di-set di sini — cukup ACK dulu biar tidak error di sisi Discord, nanti tinggal
  // tambah pengecekan `interaction.data.name` buat masing-masing command yang kamu mau.
  if (interaction.type === 2) {
    return res.json({
      type: 4,
      data: { content: `⚙️ Command \`/${interaction.data?.name}\` diterima, tapi belum ada aksi yang diprogram untuk command ini.` }
    });
  }

  // Type lain (component/autocomplete/modal) — ACK generik dulu
  res.json({ type: 1 });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // admin.html, admin.js, dll

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;
const APP_NAME = process.env.APP_NAME || 'Nova Launcher';

// Urutan level role — dipakai buat cek "role X boleh akses item level berapa"
const ROLE_LEVEL = { public: 0, gold: 1, platinum: 2 };

if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET belum diisi di .env — token login TIDAK AMAN.');

let db;

// ══════════════════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════════════════
async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI belum diisi di .env');
    return;
  }
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    // Ambil nama DB dari URI kalau ada, fallback ke 'nova'
    const dbName = process.env.MONGODB_URI.split('/').pop()?.split('?')[0] || 'test';
    db = client.db(dbName || 'test');
    console.log(`✅ MongoDB tersambung (db: ${db.databaseName})`);

    await db.collection('users').createIndex({ discordId: 1 }, { unique: true });
    await db.collection('games').createIndex({ role: 1 });
    await db.collection('bypasses').createIndex({ role: 1 });
    await db.collection('history').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('pendingLogins').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
  } catch (e) {
    console.error('❌ Gagal konek MongoDB:', e.message);
    // TIDAK process.exit() — server tetap jalan supaya endpoint /health dan interactions tetap bisa diakses
  }
}

// ══════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════

// Dipakai di route APP (Game/Bypass/Histori) — wajib login via Discord
async function requireUser(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database belum siap, coba lagi sebentar.' });
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Belum login.' });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa.' });
  }
}

// Dipakai di route ADMIN WEB — cukup satu password bersama (dari .env)
function requireAdmin(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET belum diset.' });
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Belum login admin.' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Bukan token admin.' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token admin tidak valid.' });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOGIN — DISCORD OAUTH (wajib member server dulu baru bisa login)
// ══════════════════════════════════════════════════════════════════════════
// Alur singkatnya:
//  1. App buka browser ke /auth/discord?state=<deviceId>
//  2. User login & izinkan lewat Discord
//  3. Discord redirect balik ke /auth/discord/callback
//  4. Server cek: user ini anggota server Discord kita apa belum (pakai bot token)
//     - Belum join  -> tampilkan halaman "join dulu" + link invite
//     - Sudah join  -> simpan/​update user di DB, siapkan token login, tampilkan
//       halaman "berhasil, kembali ke app"
//  5. App terus nanya ke /auth/poll?state=<deviceId> setiap 2 detik sampai
//     token-nya siap, lalu app tersebut menyimpan token itu buat request selanjutnya.

app.get('/auth/discord', (req, res) => {
  const state = req.query.state;
  if (!state) return res.status(400).send('Parameter state wajib ada.');
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Request tidak lengkap.');

  try {
    // 1) Tukar "code" dari Discord jadi access token
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const accessToken = tokenRes.data.access_token;

    // 2) Ambil profil Discord user itu
    const profileRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const discordUser = profileRes.data; // { id, username, avatar, global_name, ... }

    // 3) WAJIB cek apakah dia anggota server Discord kita (pakai BOT token, bukan token user)
    const guildId = process.env.DISCORD_GUILD_ID;
    let isMember = false;
    try {
      await axios.get(`https://discord.com/api/guilds/${guildId}/members/${discordUser.id}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      isMember = true; // kalau request di atas gak error 404, berarti dia member
    } catch (e) {
      isMember = false;
    }

    if (!isMember) {
      return res.send(renderInfoPage({
        emoji: '👋',
        title: 'Join Discord Server Dulu Yuk',
        message: `Kamu belum jadi anggota server Discord kami. Join dulu, abis itu klik tombol di bawah buat login ulang.`,
        buttonText: 'Buka Invite Discord',
        buttonHref: process.env.DISCORD_INVITE_URL,
        secondaryText: 'Sudah join?',
        secondaryButtonText: 'Login Lagi',
        secondaryHref: `${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}`
      }));
    }

    // 4) Simpan / perbarui user di database. Role default 'public' kalau baru pertama kali.
    const now = new Date();
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${Number(discordUser.discriminator || 0) % 5}.png`;

    await db.collection('users').updateOne(
      { discordId: discordUser.id },
      {
        $set: {
          username: discordUser.global_name || discordUser.username,
          avatarUrl,
          lastLoginAt: now
        },
        $setOnInsert: {
          discordId: discordUser.id,
          role: 'public',
          createdAt: now
        }
      },
      { upsert: true }
    );

    const user = await db.collection('users').findOne({ discordId: discordUser.id });

    // 5) Buat token login (JWT), simpan sementara di 'pendingLogins' biar bisa diambil app lewat /auth/poll
    const loginToken = jwt.sign({ discordId: user.discordId }, JWT_SECRET, { expiresIn: '30d' });
    await db.collection('pendingLogins').updateOne(
      { state },
      { $set: { state, token: loginToken, createdAt: new Date() } },
      { upsert: true }
    );

    return res.send(renderInfoPage({
      emoji: '✅',
      title: 'Login Berhasil!',
      message: `Selamat datang, ${user.username}. Kamu bisa kembali ke aplikasi sekarang — halaman ini boleh ditutup.`,
    }));
  } catch (e) {
    console.error('Discord OAuth error:', e.response?.data || e.message);
    return res.status(500).send(renderInfoPage({
      emoji: '⚠️',
      title: 'Gagal Login',
      message: 'Ada masalah pas nyoba login lewat Discord. Coba lagi dari aplikasinya.'
    }));
  }
});

// App polling ke sini buat cek apakah login di browser udah kelar
app.get('/auth/poll', async (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state wajib ada.' });

  const pending = await db.collection('pendingLogins').findOne({ state });
  if (!pending || !pending.token) return res.json({ ready: false });

  // Sekali dipakai langsung dihapus, biar gak bisa dipakai ulang oleh siapapun yang tau state-nya
  await db.collection('pendingLogins').deleteOne({ state });

  const payload = jwt.verify(pending.token, JWT_SECRET);
  const user = await db.collection('users').findOne({ discordId: payload.discordId });

  res.json({
    ready: true,
    token: pending.token,
    user: publicUser(user)
  });
});

function publicUser(u) {
  return {
    discordId: u.discordId,
    username: u.username,
    avatarUrl: u.avatarUrl,
    role: u.role
  };
}

function renderInfoPage({ emoji, title, message, buttonText, buttonHref, secondaryText, secondaryButtonText, secondaryHref }) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${APP_NAME}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif;}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(circle at 30% 20%, #2b1656 0%, #0b0714 55%, #050308 100%);color:#f2f0f8;}
    .card{max-width:420px;padding:44px 36px;text-align:center;border-radius:24px;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(18px);}
    .emoji{font-size:46px;margin-bottom:14px;}
    h1{font-size:22px;margin-bottom:12px;}
    p{color:#c3bfe0;font-size:14px;line-height:1.6;margin-bottom:22px;}
    a.btn{display:inline-block;padding:13px 26px;border-radius:12px;font-weight:600;font-size:14px;
      text-decoration:none;background:linear-gradient(135deg,#7b5cff,#e64bb8);color:#fff;margin:6px;}
    .secondary{margin-top:18px;font-size:12.5px;color:#8f8ab0;}
  </style></head><body>
    <div class="card">
      <div class="emoji">${emoji}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      ${buttonText ? `<a class="btn" href="${buttonHref}" target="_blank" rel="noopener">${buttonText}</a>` : ''}
      ${secondaryButtonText ? `<div class="secondary">${secondaryText}<br><a class="btn" style="margin-top:8px;" href="${secondaryHref}">${secondaryButtonText}</a></div>` : ''}
    </div>
  </body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════
// APP — GAME
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/games', requireUser, async (req, res) => {
  try {
    const myLevel = ROLE_LEVEL[req.user.role] ?? 0;
    const allowedRoles = Object.keys(ROLE_LEVEL).filter(r => ROLE_LEVEL[r] <= myLevel);
    const games = await db.collection('games')
      .find({ role: { $in: allowedRoles } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(games);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — BYPASS
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/bypasses', requireUser, async (req, res) => {
  try {
    const myLevel = ROLE_LEVEL[req.user.role] ?? 0;
    const allowedRoles = Object.keys(ROLE_LEVEL).filter(r => ROLE_LEVEL[r] <= myLevel);
    const bypasses = await db.collection('bypasses')
      .find({ role: { $in: allowedRoles } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(bypasses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — HISTORI
// ══════════════════════════════════════════════════════════════════════════
// Dipanggil pas user pencet "Install"/"Pakai" di kartu Game atau Bypass
app.post('/api/history', requireUser, async (req, res) => {
  try {
    const { itemType, itemId } = req.body;
    if (!['game', 'bypass'].includes(itemType)) return res.status(400).json({ error: 'itemType harus game/bypass.' });
    if (!ObjectId.isValid(itemId)) return res.status(400).json({ error: 'itemId tidak valid.' });

    const collectionName = itemType === 'game' ? 'games' : 'bypasses';
    const item = await db.collection(collectionName).findOne({ _id: new ObjectId(itemId) });
    if (!item) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    await db.collection('history').insertOne({
      userId: req.user.discordId,
      username: req.user.username,
      itemType,
      itemId,
      itemName: item.name,
      itemImage: item.imageUrl || null,
      createdAt: new Date()
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history', requireUser, async (req, res) => {
  try {
    const rows = await db.collection('history')
      .find({ userId: req.user.discordId })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hapus satu entri histori milik user sendiri (dipakai tombol "Uninstall" di halaman Histori).
// Ini cuma menghapus catatan histori-nya, bukan file di komputer user — launcher ini
// memang belum ngatur instalasi lokal, cuma nyatet apa yang pernah di-install/dipakai.
app.delete('/api/history/:id', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const result = await db.collection('history').deleteOne({
      _id: new ObjectId(req.params.id),
      userId: req.user.discordId // wajib punya user ini sendiri, gak bisa hapus punya orang lain
    });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Histori tidak ditemukan.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Info akun sendiri (dipakai app buat nampilin nama/role/avatar terbaru)
app.get('/api/me', requireUser, (req, res) => {
  res.json(publicUser(req.user));
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — LOGIN
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password admin salah.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — GAME (CRUD)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  const games = await db.collection('games').find({}).sort({ createdAt: -1 }).toArray();
  res.json(games);
});

app.post('/api/admin/games', requireAdmin, async (req, res) => {
  const { name, description, imageUrl, role } = req.body;
  if (!name || !ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  const doc = { name, description: description || '', imageUrl: imageUrl || null, role, createdAt: new Date() };
  const result = await db.collection('games').insertOne(doc);
  res.json({ ...doc, _id: result.insertedId });
});

app.put('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const { name, description, imageUrl, role } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (role !== undefined) {
    if (!ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Role tidak valid.' });
    update.role = role;
  }
  await db.collection('games').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
  res.json({ success: true });
});

app.delete('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  await db.collection('games').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — BYPASS (CRUD) — polanya sama persis kayak Game
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/bypasses', requireAdmin, async (req, res) => {
  const rows = await db.collection('bypasses').find({}).sort({ createdAt: -1 }).toArray();
  res.json(rows);
});

app.post('/api/admin/bypasses', requireAdmin, async (req, res) => {
  const { name, description, imageUrl, role } = req.body;
  if (!name || !ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  const doc = { name, description: description || '', imageUrl: imageUrl || null, role, createdAt: new Date() };
  const result = await db.collection('bypasses').insertOne(doc);
  res.json({ ...doc, _id: result.insertedId });
});

app.put('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const { name, description, imageUrl, role } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (role !== undefined) {
    if (!ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Role tidak valid.' });
    update.role = role;
  }
  await db.collection('bypasses').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
  res.json({ success: true });
});

app.delete('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  await db.collection('bypasses').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — HISTORI (lihat punya semua user) & USERS (atur role)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/history', requireAdmin, async (req, res) => {
  const rows = await db.collection('history').find({}).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(rows);
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const rows = await db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
  res.json(rows.map(publicUser));
});

app.put('/api/admin/users/:discordId/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Role tidak valid.' });
  await db.collection('users').updateOne({ discordId: req.params.discordId }, { $set: { role } });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — SEARCH COVER ART (SteamGridDB), opsional dipakai pas nambah Game/Bypass
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/steamgriddb-search', requireAdmin, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Parameter q wajib diisi.' });
    if (!process.env.STEAMGRIDDB_API_KEY) return res.status(400).json({ error: 'STEAMGRIDDB_API_KEY belum diisi di .env.' });

    const headers = { Authorization: `Bearer ${process.env.STEAMGRIDDB_API_KEY}` };
    const searchRes = await axios.get(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(q)}`, { headers });
    const firstMatch = searchRes.data.data?.[0];
    if (!firstMatch) return res.json({ results: [] });

    const gridRes = await axios.get(`https://www.steamgriddb.com/api/v2/grids/game/${firstMatch.id}?dimensions=600x900`, { headers });
    const results = (gridRes.data.data || []).slice(0, 8).map(g => ({ url: g.url, thumb: g.thumb }));
    res.json({ gameName: firstMatch.name, results });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.errors?.[0] || e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC CONFIG — dipanggil app pas start, biar tau nama brand & guild invite
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    appName: APP_NAME,
    discordInviteUrl: process.env.DISCORD_INVITE_URL
  });
});

// ══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK — Railway/render butuh ini untuk cek server hidup
// ══════════════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: db ? 'connected' : 'disconnected', app: APP_NAME });
});

app.get('/', (req, res) => {
  if (req.accepts('html')) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  res.json({ app: APP_NAME, status: 'running' });
});

// ══════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════
// Server SELALU start dulu, DB connect di background.
// Ini penting supaya Railway tidak anggap server crash hanya karena DB lambat konek.
app.listen(PORT, () => {
  console.log(`🚀 ${APP_NAME} backend jalan di port ${PORT}`);
});

connectDB().catch(e => {
  console.error('❌ Gagal konek MongoDB:', e.message);
});