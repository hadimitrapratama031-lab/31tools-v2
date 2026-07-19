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

// hubcapmanifest.com — dipakai admin panel buat auto-isi info game (nama/foto/ukuran/link)
// pas nambah Game, cukup dari App ID Steam-nya.
const HUBCAP_BASE_URL = (process.env.HUBCAP_BASE_URL || 'https://hubcapmanifest.com').replace(/\/+$/, '');

// Rotasi API key HubCap — dukung sampai 4 key sekaligus (opsional, isi kalau ada lebih dari 1).
// Kalau salah satu key kena rate limit (429) atau ditolak (401/403), otomatis pindah ke key berikutnya.
let HUBCAP_API_KEYS = [
  process.env.HUBCAP_API_KEY,
  process.env.HUBCAP_API_KEY_2,
  process.env.HUBCAP_API_KEY_3,
  process.env.HUBCAP_API_KEY_4,
].filter(Boolean);
const HUBCAP_API_KEY = HUBCAP_API_KEYS[0] || ''; // dipertahankan untuk kompatibilitas kode lama

// Ryuu Generator (generator.ryuu.lol) — dipakai kalau bypass pakai link Ryuu. Ambil dari
// generator.ryuu.lol/api > "Your Auth Key" (butuh akun Ryuu, gratis/premium tergantung kuota).
const RYUU_API_KEY = process.env.RYUU_API_KEY || '';

let hubcapKeyIndex = 0;
const HUBCAP_COOLDOWN_MS = 60 * 1000; // 1 menit cooldown per key yang kena limit
const hubcapKeyCooldown = {}; // { index: timestampMs kapan boleh dipakai lagi }

function getHubcapApiKey() {
  const total = HUBCAP_API_KEYS.length;
  if (total === 0) return '';
  for (let i = 0; i < total; i++) {
    const idx = (hubcapKeyIndex + i) % total;
    const cooldownUntil = hubcapKeyCooldown[idx] || 0;
    if (Date.now() >= cooldownUntil) { hubcapKeyIndex = idx; return HUBCAP_API_KEYS[idx]; }
  }
  return HUBCAP_API_KEYS[0]; // semua lagi cooldown, tetap coba key pertama sebagai fallback
}
function markHubcapKeyLimited() {
  if (HUBCAP_API_KEYS.length === 0) return;
  hubcapKeyCooldown[hubcapKeyIndex] = Date.now() + HUBCAP_COOLDOWN_MS;
  hubcapKeyIndex = (hubcapKeyIndex + 1) % HUBCAP_API_KEYS.length;
}

// ── PROXY STREAM dari HubCap → client ──
// PENTING: server yang men-download dari HubCap (pakai axios + Bearer key), lalu
// meneruskan (pipe) hasilnya langsung ke client — BUKAN client yang fetch langsung
// ke hubcapmanifest.com. Ini krusial karena:
//  1. API key HubCap tidak pernah terekspos ke Electron app / localStorage.
//  2. axios di server jauh lebih reliable menghadapi redirect/header hubcap
//     dibanding raw https.get di proses Electron.
//  3. Dukung rotasi otomatis ke key lain kalau satu key kena rate limit.
// Endpoint yang dipakai WAJIB /api/v1/manifest/{appId} (ZIP berisi .lua + .manifest),
// BUKAN /api/v1/lua/{appId} (cuma file .lua mentah, bakal gagal validasi ZIP di client).
async function streamHubcapManifest(appId, res, filenameHint) {
  if (HUBCAP_API_KEYS.length === 0) {
    return res.status(500).json({ error: 'HUBCAP_API_KEY belum diisi di server (.env). Hubungi admin.' });
  }
  const url = `${HUBCAP_BASE_URL}/api/v1/manifest/${appId}`;
  let hubcapRes = null;
  let lastError = null;

  for (let attempt = 0; attempt < HUBCAP_API_KEYS.length; attempt++) {
    const apiKey = getHubcapApiKey();
    try {
      hubcapRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        responseType: 'stream',
        timeout: 0, // file bisa besar, jangan timeout
        maxRedirects: 10
      });
      break; // sukses
    } catch (e) {
      lastError = e;
      if (e.response) {
        const s = e.response.status;
        if (s === 429 || s === 401 || s === 403) {
          markHubcapKeyLimited();
          if (attempt < HUBCAP_API_KEYS.length - 1) continue; // coba key berikutnya
        }
      }
      break; // error lain, atau sudah habis semua key
    }
  }

  if (!hubcapRes) {
    if (lastError?.response) {
      const s = lastError.response.status;
      if (s === 429) return res.status(429).json({ error: 'Semua API key HubCap sedang rate limited, coba lagi sebentar lagi.' });
      if (s === 401 || s === 403) return res.status(401).json({ error: 'API Key HubCap tidak valid/ditolak. Hubungi admin.' });
      if (s === 404) return res.status(404).json({ error: `Manifest untuk App ID ${appId} tidak ditemukan di HubCap.` });
    }
    return res.status(500).json({ error: 'Gagal terhubung ke HubCap: ' + (lastError?.message || 'unknown error') });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${(filenameHint || 'file').replace(/[^a-z0-9]/gi, '_')}.zip"`);
  if (hubcapRes.headers['content-length']) res.setHeader('Content-Length', hubcapRes.headers['content-length']);
  hubcapRes.data.pipe(res);
}

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

    let payload;
    let tokenExpired = false;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        payload = jwt.decode(token); // decode tanpa verifikasi waktu
        tokenExpired = true;
      } else {
        return res.status(401).json({ error: 'Token tidak valid.' });
      }
    }

    if (!payload?.discordId) return res.status(401).json({ error: 'Token tidak bisa dibaca.' });

    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });

    // Token expired tapi user masih ada → issue token baru via header
    if (tokenExpired) {
      const newToken = jwt.sign({ discordId: user.discordId }, JWT_SECRET, { expiresIn: '90d' });
      res.setHeader('X-New-Token', newToken);
    }

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token tidak valid.' });
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
  const { code, state, error: discordError } = req.query;

  // User menekan "Cancel"/menolak izin di halaman Discord — sebelumnya ini cuma
  // dapat pesan generik "Request tidak lengkap" yang membingungkan, padahal bukan error.
  if (discordError) {
    return res.send(renderInfoPage({
      emoji: '🚫',
      title: 'Login Dibatalkan',
      message: 'Kamu membatalkan proses login di Discord. Kembali ke aplikasi dan coba lagi kalau berubah pikiran.',
      buttonText: 'Coba Login Lagi',
      buttonHref: state ? `${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}` : undefined
    }));
  }

  if (!code || !state) return res.status(400).send('Request tidak lengkap.');

  if (!db) {
    return res.status(503).send(renderInfoPage({
      emoji: '⏳',
      title: 'Server Belum Siap',
      message: 'Database masih terhubung, coba lagi dalam beberapa detik.',
      buttonText: 'Coba Lagi',
      buttonHref: `${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}`
    }));
  }

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

    // 3) WAJIB cek apakah dia anggota server Discord kita (pakai BOT token, bukan token user).
    // PENTING: bedakan "benar-benar BUKAN member" (Discord balikin 404 dengan jelas) dari
    // error lain (bot token salah/kadaluarsa, guild ID salah, bot belum di-invite ke server,
    // Discord API lagi down, dll). Sebelumnya SEMUA jenis error di sini dianggap sama seperti
    // "belum join server", jadi user yang SUDAH jadi member pun bisa salah diarahkan ke
    // halaman "Join Discord Server Dulu" hanya karena verifikasinya gagal karena sebab lain —
    // inilah salah satu penyebab login "kelihatan tidak berfungsi" padahal akunnya valid.
    const guildId = process.env.DISCORD_GUILD_ID;
    let isMember = false;
    let memberCheckFailed = false;
    try {
      await axios.get(`https://discord.com/api/guilds/${guildId}/members/${discordUser.id}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      isMember = true;
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) {
        isMember = false; // benar-benar dikonfirmasi Discord: user ini bukan member
      } else {
        // Bukan 404 (401/403/429/network/dll) — verifikasi TIDAK BISA dipastikan, jangan
        // asumsikan "bukan member". Log detailnya biar gampang ditelusuri dari sisi admin.
        memberCheckFailed = true;
        console.error('[Auth] Gagal verifikasi member Discord:', status, e.response?.data || e.message);
      }
    }

    if (memberCheckFailed) {
      return res.status(502).send(renderInfoPage({
        emoji: '⚠️',
        title: 'Verifikasi Gagal Sementara',
        message: 'Server tidak bisa memastikan status member Discord kamu saat ini (kemungkinan gangguan sementara). Akun kamu TIDAK ditolak — coba login lagi dalam beberapa saat.',
        buttonText: 'Coba Login Lagi',
        buttonHref: `${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}`
      }));
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
    const loginToken = jwt.sign({ discordId: user.discordId }, JWT_SECRET, { expiresIn: '90d' });
    await db.collection('pendingLogins').updateOne(
      { state },
      { $set: { state, token: loginToken, createdAt: new Date() } },
      { upsert: true }
    );

    return res.send(renderInfoPage({
      emoji: '✅',
      title: 'Login Berhasil!',
      message: `Selamat datang, ${user.username}. Kamu bisa kembali ke aplikasi sekarang — halaman ini boleh ditutup. Lain kali buka app, kamu tinggal tekan "Masuk Sekarang" tanpa perlu login Discord ulang.`,
    }));
  } catch (e) {
    console.error('Discord OAuth error:', e.response?.data || e.message);
    return res.status(500).send(renderInfoPage({
      emoji: '⚠️',
      title: 'Gagal Login',
      message: 'Ada masalah pas nyoba login lewat Discord. Coba lagi dari aplikasinya.',
      buttonText: 'Coba Login Lagi',
      buttonHref: state ? `${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}` : undefined
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
    role: u.role,
    createdAt: u.createdAt || null
  };
}

// ── Refresh token — perpanjang sesi tanpa login Discord ulang ──
// Dipanggil app saat dapat 401. Token lama (bahkan yang expired) di-decode,
// discordId diambil, user dicek di DB, lalu token baru 90d di-issue.
app.post('/auth/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const oldToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!oldToken) return res.status(401).json({ error: 'Token tidak ada.' });

    let payload;
    try {
      // Coba verify normal dulu (token belum expired)
      payload = jwt.verify(oldToken, JWT_SECRET);
    } catch(e) {
      // Kalau expired, decode tanpa validasi waktu untuk ambil discordId
      payload = jwt.decode(oldToken);
    }
    if (!payload?.discordId) return res.status(401).json({ error: 'Token tidak bisa dibaca.' });

    if (!db) return res.status(503).json({ error: 'Database belum siap.' });
    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan. Silakan login ulang.' });

    const newToken = jwt.sign({ discordId: user.discordId }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token: newToken, user: publicUser(user) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
      ${(buttonText && buttonHref) ? `<a class="btn" href="${buttonHref}" target="_blank" rel="noopener">${buttonText}</a>` : ''}
      ${secondaryButtonText ? `<div class="secondary">${secondaryText}<br><a class="btn" style="margin-top:8px;" href="${secondaryHref}">${secondaryButtonText}</a></div>` : ''}
    </div>
  </body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════
// APP — GAME
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/games', requireUser, async (req, res) => {
  try {
    // SEBELUMNYA: filter hanya game yang role-nya <= role user, jadi game
    // yang butuh paket lebih tinggi TIDAK KELIHATAN SAMA SEKALI.
    // SEKARANG: semua game tetap ditampilkan (biar user tahu game itu ada &
    // termotivasi upgrade), tapi akses/download tetap dicek & diblokir server
    // di /api/games/:id/download dan /api/games/:id/stream seperti biasa.
    const games = await db.collection('games')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    // PENTING: JANGAN kirim manifestUrl/zipUrl mentah ke client — link asli hanya
    // boleh diketahui server (dipakai proxy di /stream). Kalau field ini bocor ke
    // client, Electron app bisa (sengaja/tidak) langsung shell.openExternal() ke
    // link asli alih-alih lewat proxy stream yang sudah dicek role & di-log.
    res.json(games.map(g => ({
      _id: g._id, name: g.name, description: g.description || '',
      imageUrl: g.imageUrl || '', role: g.role || 'public',
      sizeLabel: g.sizeLabel || '', appId: g.appId || null,
      isOnline: g.isOnline !== false, createdAt: g.createdAt || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// HALAMAN DETAIL — data ASLI dari Steam Store API berdasarkan App ID
// (BUKAN data fiksi/hardcode). Dipakai app client buat nampilin halaman
// detail game/bypass gaya Steam: cover, release date, metacritic, developer,
// publisher, tag, dan System Requirements (Minimum/Recommended).
// ══════════════════════════════════════════════════════════════════════════
const _steamDetailsCache = new Map(); // appId -> { data, expiresAt }
const STEAM_DETAILS_CACHE_MS = 15 * 60 * 1000; // 15 menit, biar gak spam Steam API tiap buka halaman

// Ubah HTML requirements dari Steam ("<ul class='bb_ul'><li><strong>OS:</strong> ...</li>...")
// jadi array {label, value} yang bersih buat dirender di UI.
function parseSteamRequirements(html) {
  if (!html) return [];
  const items = [];
  const liMatches = html.match(/<li>.*?<\/li>/gis) || [];
  for (const li of liMatches) {
    const inner = li.replace(/^<li>|<\/li>$/gi, '');
    const strongMatch = inner.match(/<strong>(.*?)<\/strong>\s*:?\s*(.*)/is);
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (strongMatch) {
      const label = stripTags(strongMatch[1]).replace(/:+\s*$/, ''); // buang ':' bawaan Steam biar gak dobel pas dirender
      const value = stripTags(strongMatch[2]);
      if (label || value) items.push({ label, value });
    } else {
      const value = stripTags(inner);
      if (value) items.push({ label: '', value });
    }
  }
  return items;
}

async function fetchSteamDetailsForAppId(appId) {
  const cached = _steamDetailsCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const steamRes = await axios.get('https://store.steampowered.com/api/appdetails', {
    params: { appids: appId, l: 'english' },
    timeout: 12000
  });
  const entry = steamRes.data?.[appId];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;

  const result = {
    appId,
    name: d.name || null,
    headerImage: d.header_image || null,
    shortDescription: d.short_description || '',
    genres: (d.genres || []).map(g => g.description).filter(Boolean),
    categories: (d.categories || []).map(c => c.description).filter(Boolean),
    releaseDate: d.release_date?.date || null,
    comingSoon: !!d.release_date?.coming_soon,
    metacritic: (typeof d.metacritic?.score === 'number') ? d.metacritic.score : null,
    developers: d.developers || [],
    publishers: d.publishers || [],
    requirementsMin: parseSteamRequirements(d.pc_requirements?.minimum),
    requirementsRec: parseSteamRequirements(d.pc_requirements?.recommended),
    storeUrl: `https://store.steampowered.com/app/${appId}/`
  };

  _steamDetailsCache.set(appId, { data: result, expiresAt: Date.now() + STEAM_DETAILS_CACHE_MS });
  return result;
}

app.get('/api/games/:id/steam-details', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const game = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
    if (!game) return res.status(404).json({ error: 'Game tidak ditemukan.' });
    if (!game.appId) return res.status(404).json({ error: 'App ID Steam belum diisi admin untuk game ini.' });

    const details = await fetchSteamDetailsForAppId(game.appId);
    if (!details) return res.status(404).json({ error: `Detail Steam untuk App ID ${game.appId} tidak ditemukan.` });
    res.json(details);
  } catch (e) {
    res.status(500).json({ error: 'Gagal mengambil detail dari Steam: ' + e.message });
  }
});

app.get('/api/bypasses/:id/steam-details', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });
    const appId = bypass.appId || bypass.steamAppId || null;
    if (!appId) return res.status(404).json({ error: 'App ID Steam belum diisi admin untuk bypass ini.' });

    const details = await fetchSteamDetailsForAppId(appId);
    if (!details) return res.status(404).json({ error: `Detail Steam untuk App ID ${appId} tidak ditemukan.` });
    res.json(details);
  } catch (e) {
    res.status(500).json({ error: 'Gagal mengambil detail dari Steam: ' + e.message });
  }
});

// ── DOWNLOAD (metadata): cek role & kembalikan info untuk mulai proses inject.
// TIDAK lagi mengirim URL HubCap mentah + API key ke client (rawan & kadang gagal
// karena Electron fetch langsung ke HubCap tidak sereliable axios di server).
// File-nya sendiri diambil lewat /api/games/:id/stream (proxy dari server).
app.get('/api/games/:id/download', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const game = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
    if (!game) return res.status(404).json({ error: 'Game tidak ditemukan.' });

    // Cek role user
    const myLevel   = ROLE_LEVEL[req.user.role] ?? 0;
    const gameLevel = ROLE_LEVEL[game.role]     ?? 0;
    if (myLevel < gameLevel) {
      return res.status(403).json({ error: `Game ini membutuhkan paket ${game.role}. Upgrade paket kamu dulu.` });
    }

    const rawUrl = game.manifestUrl || game.zipUrl || null;
    if (!rawUrl) {
      return res.status(404).json({ error: 'File download untuk game ini belum diatur admin. Hubungi admin.' });
    }

    res.json({
      streamPath: `/api/games/${req.params.id}/stream`, // client download lewat sini (proxy server)
      appId:      game.appId || null,
      steamAppId: game.appId || null,
      name:       game.name
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STREAM (proxy): server yang download dari HubCap, lalu diteruskan ke client.
// Auth pakai token JWT yang sama (query ?token=... karena Electron http/https client
// tidak bisa kirim custom header lewat main.js dengan mudah untuk semua kasus redirect,
// jadi paling aman & simpel lewat query string yang HANYA dipakai untuk request ini).
app.get('/api/games/:id/stream', async (req, res) => {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Login diperlukan.' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang.' }); }

    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const game = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
    if (!game) return res.status(404).json({ error: 'Game tidak ditemukan.' });

    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan.' });

    const myLevel   = ROLE_LEVEL[user.role] ?? 0;
    const gameLevel = ROLE_LEVEL[game.role] ?? 0;
    if (myLevel < gameLevel) return res.status(403).json({ error: `Game ini membutuhkan paket ${game.role}.` });

    const rawUrl = game.manifestUrl || game.zipUrl || null;
    if (!rawUrl) return res.status(404).json({ error: 'File download belum diatur admin.' });

    const isHubcap = rawUrl.includes('hubcapmanifest.com') || rawUrl.includes('hubcap');
    if (isHubcap) {
      if (!game.appId) return res.status(400).json({ error: 'App ID game ini belum diisi admin — tidak bisa ambil manifest dari HubCap.' });
      return await streamHubcapManifest(game.appId, res, game.name);
    }

    // URL non-hubcap (misal link GitHub Release) — redirect langsung, tanpa proxy
    return res.redirect(rawUrl);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DOWNLOAD BYPASS ──
// ── DOWNLOAD BYPASS (metadata) ──
// ── BYPASS DOWNLOAD LINK (simple, persis seperti project lama) ──
// Return directUrl langsung — tidak ada proxy, tidak ada stream complexity.
// Client (main.js) download langsung dari URL yang admin set.
app.get('/api/bypasses/:id/download-link', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });

    const myLevel     = ROLE_LEVEL[req.user.role]   ?? 0;
    const bypassLevel = ROLE_LEVEL[bypass.role]     ?? 0;
    if (myLevel < bypassLevel) {
      return res.status(403).json({ error: `Bypass ini membutuhkan paket ${bypass.role}.` });
    }

    const url = bypass.zipUrl || bypass.link || bypass.driveLink || null;
    if (!url) {
      return res.status(404).json({ error: 'Link bypass belum diatur admin. Hubungi admin untuk mengisi link file bypass.' });
    }

    // BUG FIX: Link dari Ryuu Generator (generator.ryuu.lol) WAJIB pakai auth (session,
    // auth_key parameter, atau X-Auth-Key header) — kalau tidak, Ryuu selalu balikin
    // "Login, auth_key, or auth_code required." Sebelumnya URL dikirim mentah ke client
    // TANPA auth apapun, jadi bypass dari Ryuu SELALU gagal. Sekarang di-proxy lewat
    // server sendiri (pakai RYUU_API_KEY dari .env, sama seperti pola HubCap), supaya
    // admin tidak perlu tempel auth key manual di tiap link, dan key-nya tidak pernah
    // terekspos ke client/Electron.
    const isRyuu = /ryuu\.lol/i.test(url);
    if (isRyuu) {
      if (!RYUU_API_KEY) {
        return res.status(400).json({
          error: 'Link bypass ini dari Ryuu Generator, tapi RYUU_API_KEY belum diisi di server (.env). Hubungi admin untuk mengisinya.'
        });
      }
      return res.json({
        streamPath: `/api/bypasses/${req.params.id}/ryuu-stream`,
        name:       bypass.name,
        steamAppId: bypass.steamAppId || bypass.appId || null,
      });
    }

    // Link non-Ryuu (GitHub Release, Google Drive, CDN lain) — tetap seperti sebelumnya,
    // return langsung URL-nya ke client.
    res.json({
      directUrl:  url,
      name:       bypass.name,
      steamAppId: bypass.steamAppId || bypass.appId || null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PROXY DOWNLOAD RYUU GENERATOR — server yang nempelin auth (X-Auth-Key), client cuma
// terima file ZIP jadi. API key Ryuu tidak pernah dikirim ke Electron/localStorage. ──
app.get('/api/bypasses/:id/ryuu-stream', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });

    const myLevel     = ROLE_LEVEL[req.user.role]   ?? 0;
    const bypassLevel = ROLE_LEVEL[bypass.role]     ?? 0;
    if (myLevel < bypassLevel) {
      return res.status(403).json({ error: `Bypass ini membutuhkan paket ${bypass.role}.` });
    }

    const url = bypass.zipUrl || bypass.link || bypass.driveLink || null;
    if (!url || !/ryuu\.lol/i.test(url)) {
      return res.status(400).json({ error: 'Link bypass ini bukan link Ryuu Generator.' });
    }
    if (!RYUU_API_KEY) {
      return res.status(500).json({ error: 'RYUU_API_KEY belum diisi di server (.env). Hubungi admin.' });
    }

    let ryuuRes;
    try {
      ryuuRes = await axios.get(url, {
        headers: { 'X-Auth-Key': RYUU_API_KEY },
        responseType: 'stream',
        timeout: 0, // file manifest/zip bisa besar
        maxRedirects: 10,
        validateStatus: () => true
      });
    } catch (e) {
      console.error('[RYUU STREAM] Gagal terhubung ke Ryuu Generator:', e.message);
      return res.status(502).json({ error: 'Gagal terhubung ke Ryuu Generator: ' + e.message });
    }

    if (ryuuRes.status !== 200) {
      // Baca body error (biasanya JSON kecil kayak {"error":"..."}) supaya pesannya
      // informatif, bukan cuma "HTTP 401" polos.
      let bodyText = '';
      try {
        for await (const chunk of ryuuRes.data) {
          bodyText += chunk.toString('utf8');
          if (bodyText.length > 500) break;
        }
      } catch (e2) {}
      let parsedMsg = null;
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed.error === 'string') parsedMsg = parsed.error;
      } catch (e3) {}

      if (ryuuRes.status === 401 || ryuuRes.status === 403) {
        return res.status(401).json({ error: parsedMsg || 'RYUU_API_KEY tidak valid/ditolak Ryuu Generator (401/403). Hubungi admin untuk update key.' });
      }
      if (ryuuRes.status === 404) {
        return res.status(404).json({ error: parsedMsg || 'Manifest untuk game ini tidak ditemukan di Ryuu Generator.' });
      }
      if (ryuuRes.status === 429) {
        return res.status(429).json({ error: parsedMsg || 'Kuota harian Ryuu Generator habis, coba lagi nanti.' });
      }
      return res.status(502).json({ error: parsedMsg || `Ryuu Generator mengembalikan HTTP ${ryuuRes.status}.` });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${(bypass.name || 'bypass').replace(/[^a-z0-9]/gi, '_')}.zip"`);
    if (ryuuRes.headers['content-length']) res.setHeader('Content-Length', ryuuRes.headers['content-length']);
    ryuuRes.data.pipe(res);
  } catch (e) {
    console.error('[RYUU STREAM] Unexpected error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/api/bypasses/:id/download', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });

    const myLevel     = ROLE_LEVEL[req.user.role]   ?? 0;
    const bypassLevel = ROLE_LEVEL[bypass.role]     ?? 0;
    if (myLevel < bypassLevel) {
      return res.status(403).json({ error: `Bypass ini membutuhkan paket ${bypass.role}.` });
    }

    const url = bypass.zipUrl || bypass.link || null;
    if (!url) {
      return res.status(404).json({ error: 'File bypass belum diatur admin. Hubungi admin.' });
    }

    // Kembalikan appId ke client — dipakai untuk findGameFolderByAppId
    // (cari folder game di steamapps sebagai target extract).
    // Stream tetap dari link manual admin (bukan HubCap).
    res.json({
      streamPath: `/api/bypasses/${req.params.id}/stream`,
      steamAppId: bypass.steamAppId || bypass.appId || null,
      appId:      bypass.appId      || bypass.steamAppId || null,
      name:       bypass.name
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bypasses/:id/stream', async (req, res) => {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Login diperlukan.' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang.' }); }

    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });

    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan.' });

    const myLevel     = ROLE_LEVEL[user.role]   ?? 0;
    const bypassLevel = ROLE_LEVEL[bypass.role] ?? 0;
    if (myLevel < bypassLevel) return res.status(403).json({ error: `Bypass ini membutuhkan paket ${bypass.role}.` });

    const rawUrl = bypass.zipUrl || bypass.link || null;

    // ── ROUTING ──
    // Bypass SELALU pakai link (zipUrl/link) yang admin set secara manual —
    // TIDAK menggunakan HubCap sama sekali. HubCap hanya untuk game (inject Steam).
    // Bypass adalah file patch/crack yang link-nya diset admin, bukan manifest Steam.

    if (!rawUrl) {
      return res.status(404).json({ error: 'Link bypass belum diatur admin. Hubungi admin untuk mengisi link file bypass.' });
    }

    // ── STRATEGI DOWNLOAD BERDASARKAN SUMBER LINK ──
    //
    // File bypass bisa >500MB. Men-proxy file besar lewat Railway sangat berisiko
    // (timeout, memory, bandwidth terbatas). Strategi per sumber:
    //
    //  • GitHub Release (objects.githubusercontent.com / github.com/releases)
    //    → REDIRECT langsung ke URL asli. GitHub sudah handle auth via URL token-nya
    //      sendiri, tidak perlu proxy. Client download langsung, server cuma validasi auth.
    //
    //  • Google Drive
    //    → REDIRECT ke direct download URL (uc?export=download). File besar GDrive
    //      punya virus-scan warning, tapi client (Electron/axios di main.js) bisa follow.
    //
    //  • Link lain (custom CDN, dll)
    //    → REDIRECT juga — lebih aman dan efisien daripada proxy untuk file besar.
    //
    // Auth sudah divalidasi di atas (JWT + role check) sebelum redirect dikirim,
    // jadi URL asli baru bocor setelah user terbukti berhak akses.

    const isGithub = /github\.com|githubusercontent\.com/.test(rawUrl);
    const isGdrive = /drive\.google\.com/.test(rawUrl);
    const isRyuu   = /ryuu\.lol|generator\.ryuu\.lol/.test(rawUrl);

    if (isGithub) {
      // GitHub Release: resolve redirect dulu untuk dapat URL objects.githubusercontent.com
      // yang bisa langsung di-download client tanpa perlu header apapun
      try {
        const headRes = await axios.head(rawUrl, {
          maxRedirects: 10,
          timeout: 10000,
          headers: { 'User-Agent': 'ThreeOneStore/1.0' },
          validateStatus: s => s < 400
        });
        // Ikuti redirect — axios.head() sudah resolve ke final URL
        const finalUrl = headRes.request?.res?.responseUrl || headRes.config?.url || rawUrl;
        console.log('[BYPASS] GitHub redirect →', finalUrl);
        return res.redirect(302, finalUrl);
      } catch (e) {
        // Kalau head gagal, coba redirect langsung ke rawUrl — client akan follow sendiri
        console.warn('[BYPASS] GitHub head gagal, redirect ke rawUrl:', e.message);
        return res.redirect(302, rawUrl);
      }
    }

    if (isGdrive) {
      // Google Drive: convert share link → direct download
      const gdMatch = rawUrl.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([a-zA-Z0-9_\-]+)/);
      const fileId  = gdMatch?.[1];
      if (!fileId) return res.status(400).json({ error: 'Format link Google Drive tidak dikenali.' });
      const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      return res.redirect(302, directUrl);
    }

    if (isRyuu) {
      // Ryuu menerapkan hotlink protection berdasarkan Referer.
      // Proxy di server-side tidak andal karena Ryuu bisa berubah cara proteksinya.
      // Solusi: kembalikan URL asli ke client (main.js), biarkan main.js download
      // langsung dengan header Ryuu yang benar lewat downloadFileWithProgress.
      // main.js sudah punya logika untuk set User-Agent + Referer yang benar.
      return res.json({ directUrl: rawUrl, method: 'direct' });
    }

    // Link lain — redirect langsung, lebih aman daripada proxy untuk file besar
    return res.redirect(302, rawUrl);
  } catch (e) {
    console.error('[BYPASS STREAM] Unexpected error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — BYPASS
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/bypasses', requireUser, async (req, res) => {
  try {
    // Sama seperti /api/games — semua bypass tetap ditampilkan, akses tetap
    // dicek & diblokir server di /api/bypasses/:id/download & /stream.
    const bypasses = await db.collection('bypasses')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    // PENTING: JANGAN kirim zipUrl/link mentah ke client sama sekali — kalau bocor,
    // tombol di app bisa (salah) langsung shell.openExternal() ke link aslinya
    // alih-alih download lewat proxy /api/bypasses/:id/stream yang sudah dicek role.
    // Ini juga PENYEBAB bug "tombol buka link" yang dilaporkan sebelumnya.
    res.json(bypasses.map(b => ({
      _id: b._id, name: b.name, description: b.description || '',
      imageUrl: b.imageUrl || '', role: b.role || 'public',
      sizeLabel: b.sizeLabel || '',
      appId: b.appId || b.steamAppId || null,
      steamAppId: b.steamAppId || b.appId || null,
      gameId: b.gameId || null, // dipakai client buat cocokin tombol "Install Bypass" di halaman detail Game
      isOnline: b.isOnline !== false, createdAt: b.createdAt || null,
    })));
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
    const { itemType, itemId, extractedFiles, steamPath, folderPath } = req.body;
    if (!['game', 'bypass'].includes(itemType)) return res.status(400).json({ error: 'itemType harus game/bypass.' });
    if (!ObjectId.isValid(itemId)) return res.status(400).json({ error: 'itemId tidak valid.' });

    const collectionName = itemType === 'game' ? 'games' : 'bypasses';
    const item = await db.collection(collectionName).findOne({ _id: new ObjectId(itemId) });
    if (!item) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    const insertResult = await db.collection('history').insertOne({
      userId: req.user.discordId,
      username: req.user.username,
      itemType,
      itemId,
      itemName: item.name,
      itemImage: item.imageUrl || null,
      // BUG FIX: dulu field ini (walau sudah dikirim client sejak awal) tidak pernah
      // disimpan, jadi tombol Uninstall di halaman Histori tidak punya cara untuk tahu
      // file apa saja & di folder mana yang harus dihapus di PC user — cuma bisa hapus
      // catatan histori-nya doang, file game/bypass yang sebenarnya tetap ketinggalan.
      extractedFiles: Array.isArray(extractedFiles) ? extractedFiles.filter(f => typeof f === 'string') : [],
      steamPath: itemType === 'game' ? (steamPath || null) : null,
      folderPath: itemType === 'bypass' ? (folderPath || null) : null,
      createdAt: new Date()
    });

    res.json({ success: true, _id: insertResult.insertedId });
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
  const newToken = res.getHeader('X-New-Token');
  const resp = { ...publicUser(req.user) };
  if (newToken) resp.newToken = newToken; // client simpan token baru kalau ada
  res.json(resp);
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

// ── Verifikasi token admin — dipanggil admin.js pas halaman di-refresh, supaya
// tahu pasti token di localStorage MASIH valid sebelum nampilin dashboard.
// Tanpa ini, token yang sudah expired/invalid tetap nampilin shell tapi semua
// datanya gagal load (401 di semua request) — kelihatan kayak "stuck".
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — GAME (CRUD)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  const games = await db.collection('games').find({}).sort({ createdAt: -1 }).toArray();
  res.json(games);
});

app.post('/api/admin/games', requireAdmin, async (req, res) => {
  const { name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline } = req.body;
  if (!name || !ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  const doc = {
    name,
    description: description || '',
    imageUrl: imageUrl || null,
    role,
    appId: appId ? String(appId) : null,
    storeUrl: storeUrl || null,
    manifestUrl: manifestUrl || null,
    sizeBytes: sizeBytes || null,
    sizeLabel: sizeLabel || null,
    // Tipe game: Online (bisa multiplayer online) / Offline (singleplayer murni).
    // Default TRUE (online) kalau admin tidak eksplisit set false, biar konsisten
    // dengan behaviour lama sebelum field ini ada di form (games lama semua online).
    isOnline: isOnline === false ? false : true,
    createdAt: new Date()
  };
  const result = await db.collection('games').insertOne(doc);
  res.json({ ...doc, _id: result.insertedId });
});

app.put('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const { name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (appId !== undefined) update.appId = appId ? String(appId) : null;
  if (storeUrl !== undefined) update.storeUrl = storeUrl || null;
  if (manifestUrl !== undefined) update.manifestUrl = manifestUrl || null;
  if (sizeBytes !== undefined) update.sizeBytes = sizeBytes || null;
  if (sizeLabel !== undefined) update.sizeLabel = sizeLabel || null;
  if (isOnline !== undefined) update.isOnline = isOnline === false ? false : true;
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
  const { name, description, imageUrl, role, link, zipUrl, appId, gameId, isOnline } = req.body;
  if (!name || !ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  const doc = {
    name,
    description: description || '',
    imageUrl: imageUrl || null,
    role,
    link:   link   || null, // legacy field — link manual dari admin
    zipUrl: zipUrl || link || null, // URL ZIP bypass (bisa GitHub dll) — di-proxy server, tidak pernah ke client
    appId:  appId  || null, // Steam App ID — menentukan folder extract tujuan di PC user
    gameId: (gameId && ObjectId.isValid(gameId)) ? gameId : null,
    // Tipe bypass: Online (bypass buat game yang punya mode online multiplayer) / Offline.
    // Default TRUE kalau tidak eksplisit di-set false.
    isOnline: isOnline === false ? false : true,
    createdAt: new Date()
  };
  const result = await db.collection('bypasses').insertOne(doc);
  res.json({ ...doc, _id: result.insertedId });
});

app.put('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const { name, description, imageUrl, role, link, zipUrl, appId, isOnline } = req.body;
  const update = {};
  if (name        !== undefined) update.name        = name;
  if (description !== undefined) update.description = description;
  if (imageUrl    !== undefined) update.imageUrl    = imageUrl;
  if (link        !== undefined) update.link        = link   || null;
  if (zipUrl      !== undefined) update.zipUrl      = zipUrl || link || null;
  if (appId       !== undefined) update.appId       = appId  || null;
  if (isOnline    !== undefined) update.isOnline    = isOnline === false ? false : true;
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
// ADMIN — APP ID LOOKUP (Steam + hubcapmanifest), dipakai pas nambah Game
// ══════════════════════════════════════════════════════════════════════════
// Alurnya:
//  1. Ambil info dasar (nama, foto, link store, deskripsi singkat) dari Steam Store API
//     pakai App ID yang diketik admin — ini publik, gak butuh API key.
//  2. Cek ke hubcapmanifest apakah manifest buat App ID itu TERSEDIA, sekalian ambil
//     ukuran filenya dari header response (Content-Length), TANPA download isinya
//     (pakai HEAD dulu, fallback GET stream yang langsung di-stop begitu header masuk)
//     — supaya gak boros kuota harian API key hubcapmanifest.
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, val = Number(bytes);
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Cek manifest hubcapmanifest tanpa full-download.
// Beberapa server (termasuk hubcapmanifest) balikin HTTP 405 buat HEAD request
// karena route-nya cuma didaftarkan buat GET — jadi HEAD bukan exception yang
// dilempar axios, tapi response biasa dengan status 405. Makanya fallback ke
// GET-stream-lalu-di-stop harus jalan setiap kali HEAD BUKAN 200/404, bukan cuma
// pas HEAD gagal total (network error).
async function checkHubcapManifest(appId) {
  if (!HUBCAP_API_KEY) return { configured: false, hasManifest: null, sizeBytes: null };
  const url = `${HUBCAP_BASE_URL}/api/v1/lua/${encodeURIComponent(appId)}`;
  const headers = { Authorization: `Bearer ${HUBCAP_API_KEY}` };

  // 1) Coba HEAD dulu (paling hemat kuota kalau didukung)
  try {
    const headRes = await axios.head(url, { headers, timeout: 10000, validateStatus: () => true });
    if (headRes.status === 200) {
      const len = headRes.headers['content-length'];
      return { configured: true, hasManifest: true, sizeBytes: len ? Number(len) : null };
    }
    if (headRes.status === 404) return { configured: true, hasManifest: false, sizeBytes: null };
    // 401/403/429/405/dll -> lanjut coba metode GET-stream di bawah, JANGAN langsung nyerah
  } catch (e) {
    // HEAD error jaringan -> lanjut ke fallback GET-stream juga
  }

  // 2) Fallback: GET biasa tapi responseType 'stream' & langsung di-destroy begitu
  //    header/status masuk, jadi gak menarik seluruh isi file (hemat kuota & bandwidth).
  try {
    const getRes = await axios.get(url, { headers, timeout: 10000, responseType: 'stream', validateStatus: () => true });
    const status = getRes.status;
    const len = getRes.headers['content-length'];
    getRes.data.destroy();
    if (status === 200) return { configured: true, hasManifest: true, sizeBytes: len ? Number(len) : null };
    if (status === 404) return { configured: true, hasManifest: false, sizeBytes: null };
    if (status === 401 || status === 403) return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: API key tidak valid/ditolak (401/403).' };
    if (status === 429) return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: kuota harian API key habis (429).' };
    return { configured: true, hasManifest: null, sizeBytes: null, error: `hubcapmanifest: HTTP ${status}` };
  } catch (e2) {
    return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: gagal dihubungi.' };
  }
}

app.get('/api/admin/appid-lookup/:appId', requireAdmin, async (req, res) => {
  const appId = String(req.params.appId).trim();
  if (!/^\d+$/.test(appId)) return res.status(400).json({ error: 'App ID harus berupa angka (App ID Steam).' });

  const result = {
    appId,
    name: null,
    description: null,
    imageUrl: null,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    manifestUrl: null,
    sizeBytes: null,
    sizeLabel: null,
    hasManifest: null,
    hubcapConfigured: !!HUBCAP_API_KEY,
    // Deteksi otomatis tipe game (Online/Offline) dari kategori Steam-nya, biar toggle
    // di form admin bisa langsung ke-set default sesuai game aslinya — admin tetap bisa
    // ubah manual kalau deteksinya kurang pas.
    categories: [],
    isOnlineSuggested: null,
    warnings: []
  };

  // 1) Steam Store API (publik)
  try {
    const steamRes = await axios.get('https://store.steampowered.com/api/appdetails', {
      params: { appids: appId, l: 'english' },
      timeout: 10000
    });
    const entry = steamRes.data?.[appId];
    if (entry?.success && entry.data) {
      const d = entry.data;
      result.name = d.name || null;
      result.imageUrl = d.header_image || null;
      result.description = (d.short_description || '').slice(0, 300) || null;

      // Kategori Steam (mis. "Single-player", "Multi-player", "Online Co-op", "Online PvP", dst)
      // dipakai buat nebak apakah game ini punya mode online multiplayer atau murni offline.
      const catNames = (d.categories || []).map(c => c.description).filter(Boolean);
      result.categories = catNames;
      const ONLINE_HINT = /online|multi-?player|co-?op|pvp|mmo/i;
      const hasOnlineHint = catNames.some(c => ONLINE_HINT.test(c));
      // Kalau kategorinya CUMA "Single-player" tanpa hint online sama sekali → offline.
      result.isOnlineSuggested = catNames.length ? hasOnlineHint : null;
    } else {
      result.warnings.push('App ID tidak ditemukan di Steam Store.');
    }
  } catch (e) {
    result.warnings.push('Gagal mengambil data dari Steam Store.');
  }

  // 2) hubcapmanifest — cek ketersediaan manifest & ukuran file
  try {
    const hc = await checkHubcapManifest(appId);
    result.hubcapConfigured = hc.configured;
    result.hasManifest = hc.hasManifest;
    result.sizeBytes = hc.sizeBytes;
    result.sizeLabel = formatBytes(hc.sizeBytes);
    // Link manifest langsung ditampilkan ke admin kalau memang tersedia di hubcapmanifest,
    // biar bisa dicek/dibuka manual juga.
    // Simpan sebagai /manifest/ (ZIP berisi .lua + .manifest), BUKAN /lua/ (file mentah)
    // karena main.js Electron mengharapkan ZIP saat inject game ke Steam.
    if (hc.hasManifest === true) result.manifestUrl = `${HUBCAP_BASE_URL}/api/v1/manifest/${appId}`;
    if (hc.error) result.warnings.push(hc.error);
    if (hc.configured && hc.hasManifest === false) result.warnings.push('Manifest untuk App ID ini belum tersedia di hubcapmanifest.');
    if (!hc.configured) result.warnings.push('HUBCAP_API_KEY belum diisi di .env — cek ketersediaan manifest & ukuran file dilewati.');
  } catch (e) {
    result.warnings.push('Gagal mengecek hubcapmanifest.');
  }

  res.json(result);
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