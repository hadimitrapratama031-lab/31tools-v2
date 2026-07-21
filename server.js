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
const http = require('http');
const WebSocket = require('ws');
const sanitizeHtml = require('sanitize-html');

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

// Limit dinaikkan dari default 100kb -> 8mb SUPAYA banner bertipe "Image" bisa upload
// gambar sebagai base64 (data URI) langsung lewat body JSON (lihat ADMIN — BANNER
// CAROUSEL di bawah). Ukuran gambar aslinya sendiri tetap dibatasi lebih ketat
// (BANNER_MAX_IMAGE_BYTES) di handler, ini cuma pagar atas di level parser.
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // admin.html, admin.js, dll

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;
const APP_NAME = process.env.APP_NAME || 'Nova Launcher';

// hubcapmanifest.com — dipakai admin panel buat auto-isi info game (nama/foto/ukuran/link)
// pas nambah Game, cukup dari App ID Steam-nya.
const HUBCAP_BASE_URL = (process.env.HUBCAP_BASE_URL || 'https://hubcapmanifest.com').replace(/\/+$/, '');

// Ryuu Generator (generator.ryuu.lol) — dipakai kalau bypass pakai link Ryuu. Ambil dari
// generator.ryuu.lol/api > "Your Auth Key" (butuh akun Ryuu, gratis/premium tergantung kuota).
const RYUU_API_KEY = process.env.RYUU_API_KEY || '';

// ══════════════════════════════════════════════════════════════════════════
// RYU API (generator.ryuu.lol/api/download/{appId}) — SENGAJA DIPISAH dari
// "Ryuu Generator" bypass di atas (RYUU_API_KEY .env, dipakai buat link bypass
// manual) supaya admin bisa bedakan jelas dari Admin Web. Fitur ini KHUSUS buat
// download GAME (bukan bypass) — alternatif/fallback kalau HubCap kehabisan
// kuota — dan API key-nya dikelola sepenuhnya dari Admin Web > Hubcap API >
// tab "Ryu API" (collection `ryuApiKeys`, bukan .env), lengkap dengan
// Tambah/Edit/Hapus/Aktifkan-Nonaktifkan + auto rotation, sama seperti HubCap.
// ══════════════════════════════════════════════════════════════════════════
const RYU_BASE_URL = (process.env.RYU_BASE_URL || 'https://generator.ryuu.lol').replace(/\/+$/, '');

// ══════════════════════════════════════════════════════════════════════════
// HUBCAP API KEY MANAGER — API Key HubCap sekarang dikelola dari Admin Web
// (halaman "Hubcap API" > API Key Management), disimpan di database, BUKAN
// lagi cuma dari .env. Admin bisa Tambah/Edit/Hapus/Aktifkan/Nonaktifkan key
// kapan saja tanpa restart server — lihat hubcapKeyManager.js untuk detail
// auto rotation & monitoring-nya. `db` & broadcastAdmin/logActivity dirujuk
// lewat closure/hoisting jadi aman dipanggil di sini walau didefinisikan
// belakangan di file ini (function declaration di-hoist penuh oleh JS).
// ══════════════════════════════════════════════════════════════════════════
const hubcapKeyManager = require('./hubcapKeyManager')({
  getDb: () => db,
  HUBCAP_BASE_URL,
  broadcastAdmin: (...args) => broadcastAdmin(...args),
  logActivity: (...args) => logActivity(...args)
});

// Ryu API — lihat ryuKeyManager.js. Sengaja modul terpisah dari hubcapKeyManager
// (provider beda, koleksi DB beda: `ryuApiKeys`), supaya jelas kebedaannya di
// Admin Web maupun di kode.
const ryuKeyManager = require('./ryuKeyManager')({
  getDb: () => db,
  RYU_BASE_URL,
  broadcastAdmin: (...args) => broadcastAdmin(...args),
  logActivity: (...args) => logActivity(...args)
});

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
  const hasKey = await hubcapKeyManager.hasActiveKey();
  if (!hasKey) {
    return res.status(500).json({ error: 'Belum ada API Key HubCap yang aktif. Tambahkan di Admin Web > Hubcap API > API Key Management.' });
  }
  const url = `${HUBCAP_BASE_URL}/api/v1/manifest/${appId}`;
  let hubcapRes = null;
  let lastError = null;
  let usedKey = null;

  // Maksimal percobaan = jumlah key aktif (dilonggarkan sedikit lewat snapshot),
  // supaya auto rotation sempat mencoba semua key sebelum benar-benar menyerah.
  const snapshot = await hubcapKeyManager.getMonitorSnapshot();
  const maxAttempts = Math.max(1, snapshot.activeCount || 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyDoc = await hubcapKeyManager.getActiveKey();
    if (!keyDoc) break;
    usedKey = keyDoc;
    try {
      hubcapRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${keyDoc.key}` },
        responseType: 'stream',
        timeout: 0, // file bisa besar, jangan timeout
        maxRedirects: 10
      });
      await hubcapKeyManager.markSuccess(keyDoc);
      break; // sukses
    } catch (e) {
      lastError = e;
      if (e.response) {
        const s = e.response.status;
        if (s === 429 || s === 401 || s === 403) {
          await hubcapKeyManager.markLimited(keyDoc, `HTTP ${s} saat GET /api/v1/manifest/${appId}`);
          if (attempt < maxAttempts - 1) continue; // coba key berikutnya (auto rotation)
        } else {
          await hubcapKeyManager.markError(keyDoc, `HTTP ${s} saat GET /api/v1/manifest/${appId}`);
        }
      } else {
        await hubcapKeyManager.markError(keyDoc, e.message || 'Gagal terhubung ke HubCap');
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

// ── PROXY STREAM dari Ryu API → client ── Pola SAMA PERSIS seperti streamHubcapManifest
// di atas (server yang download pakai key, client cuma terima ZIP jadi, key tidak pernah
// terekspos ke Electron). Endpoint yang dipakai `/api/download/{appId}` TANPA parameter
// `file_type` — supaya dapat ZIP lengkap berisi .lua + .manifest (main.js Electron perlu
// keduanya buat inject game ke Steam), BUKAN `file_type=lua`/`file_type=manifest` yang
// cuma balikin satu file mentah saja.
async function streamRyuManifest(appId, res, filenameHint) {
  const hasKey = await ryuKeyManager.hasActiveKey();
  if (!hasKey) {
    return res.status(500).json({ error: 'Belum ada API Key Ryu yang aktif. Tambahkan di Admin Web > Hubcap API > tab Ryu API.' });
  }
  const url = `${RYU_BASE_URL}/api/download/${appId}`;
  let ryuRes = null;
  let lastError = null;

  const snapshot = await ryuKeyManager.getMonitorSnapshot();
  const maxAttempts = Math.max(1, snapshot.activeCount || 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyDoc = await ryuKeyManager.getActiveKey();
    if (!keyDoc) break;
    try {
      ryuRes = await axios.get(url, {
        headers: { 'X-Auth-Key': keyDoc.key },
        responseType: 'stream',
        timeout: 0,
        maxRedirects: 10,
        validateStatus: () => true
      });
      if (ryuRes.status === 200) { await ryuKeyManager.markSuccess(keyDoc); break; }
      // Baca sedikit body buat pesan error yang informatif (Ryu balikin JSON kecil kayak {"error":"..."})
      let bodyText = '';
      try {
        for await (const chunk of ryuRes.data) { bodyText += chunk.toString('utf8'); if (bodyText.length > 500) break; }
      } catch (e2) {}
      let parsedMsg = null;
      try { const p = JSON.parse(bodyText); if (p && typeof p.error === 'string') parsedMsg = p.error; } catch (e3) {}
      const s = ryuRes.status;
      lastError = { status: s, message: parsedMsg };
      ryuRes = null;
      if (s === 429 || s === 401 || s === 403) {
        await ryuKeyManager.markLimited(keyDoc, parsedMsg || `HTTP ${s} saat GET /api/download/${appId}`);
        if (attempt < maxAttempts - 1) continue; // auto rotation ke key berikutnya
      } else {
        await ryuKeyManager.markError(keyDoc, parsedMsg || `HTTP ${s} saat GET /api/download/${appId}`);
      }
      break;
    } catch (e) {
      lastError = { status: null, message: e.message };
      await ryuKeyManager.markError(keyDoc, e.message || 'Gagal terhubung ke Ryu API');
      break;
    }
  }

  if (!ryuRes) {
    const s = lastError?.status;
    if (s === 429) return res.status(429).json({ error: lastError.message || 'Semua API key Ryu sedang rate limited, coba lagi sebentar lagi.' });
    if (s === 401 || s === 403) return res.status(401).json({ error: lastError.message || 'API Key Ryu tidak valid/ditolak. Hubungi admin.' });
    if (s === 404) return res.status(404).json({ error: lastError.message || `File untuk App ID ${appId} tidak ditemukan di Ryu API.` });
    return res.status(500).json({ error: 'Gagal terhubung ke Ryu API: ' + (lastError?.message || 'unknown error') });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${(filenameHint || 'file').replace(/[^a-z0-9]/gi, '_')}.zip"`);
  if (ryuRes.headers['content-length']) res.setHeader('Content-Length', ryuRes.headers['content-length']);
  ryuRes.data.pipe(res);
}

// Urutan level role — dipakai buat cek "role X boleh akses item level berapa"
// 'admin' sengaja ditaruh paling atas (level tertinggi) — otomatis bisa akses
// semua game/bypass apapun paketnya, DAN dipakai buat gerbang masuk admin panel
// (lihat requireAdmin di bawah).
const ROLE_LEVEL = { public: 0, gold: 1, platinum: 2, admin: 3 };

if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET belum diisi di .env — token login TIDAK AMAN.');

let db;

// ══════════════════════════════════════════════════════════════════════════
// MASA AKTIF & LIMIT DOWNLOAD — berlaku buat semua role KECUALI admin (unlimited).
//   • public   : tanpa masa aktif (permanen). Limit download 3x/hari utk Game DAN
//                3x/hari utk Bypass — dua counter TERPISAH.
//   • gold     : masa aktif diatur admin (tanggal expired). Limit download 4x/hari
//                utk Game DAN 4x/hari utk Bypass — dua counter terpisah.
//   • platinum : masa aktif diatur admin. Limit download UNLIMITED (Game & Bypass).
//   • admin    : unlimited semua, tidak ada masa aktif sama sekali.
// ══════════════════════════════════════════════════════════════════════════
const DOWNLOAD_LIMITS = {
  public:   { game: 3, bypass: 3 },
  gold:     { game: 4, bypass: 4 },
  platinum: { game: Infinity, bypass: Infinity },
  admin:    { game: Infinity, bypass: Infinity }
};

// Tanggal hari ini di zona WIB (Asia/Jakarta), format YYYY-MM-DD. Dipakai buat reset
// counter limit download tiap ganti hari — sengaja BUKAN tanggal UTC server (Railway
// dkk biasanya UTC), biar "sehari" yang dimaksud sesuai jam Indonesia.
function todayDateStrJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // 'en-CA' -> 'YYYY-MM-DD'
}

// Cek apakah masa aktif user (Gold/Platinum) sudah lewat. Public & Admin tidak
// punya masa aktif sama sekali jadi selalu false.
function isActivePeriodExpired(user) {
  if (user.role !== 'gold' && user.role !== 'platinum') return false;
  if (!user.activeUntil) return false; // belum diset admin = belum ada batas waktu
  return new Date(user.activeUntil).getTime() <= Date.now();
}

// Kalau masa aktif sudah lewat, otomatis turunkan role user ke 'public' (DB + sinkron
// ke Discord + catat log histori — sama seperti "Set Paket" manual admin), lalu
// kembalikan versi user yang sudah ter-update. Dipanggil di setiap request yang butuh
// login supaya efeknya langsung kena di request berikutnya, tanpa perlu aksi admin apapun.
async function applyExpiryIfNeeded(user) {
  if (!isActivePeriodExpired(user)) return user;

  const oldRole = user.role;
  const discordId = user.discordId;
  const username = user.username || discordId;

  await db.collection('users').updateOne(
    { discordId },
    { $set: { role: 'public', roleUpdatedAt: new Date(), activeUntil: null } }
  );

  // Best-effort: sinkron Discord + log. Jangan sampai gagalnya nge-block request user.
  try {
    const discordSync = await roleSync.syncAppRoleToDiscord(discordId, 'public');
    await roleSync.logRoleChange({
      discordId, username, oldRole, newRole: 'public',
      source: 'expired', discordSync,
      note: 'Masa aktif habis, otomatis diturunkan ke Public.'
    });
  } catch (e) {
    console.warn('[Masa Aktif] Gagal sinkron/log saat auto-downgrade:', e.message);
  }

  const updated = await db.collection('users').findOne({ discordId });

  notifyUser(discordId, {
    type: 'period_expired',
    title: 'Masa Aktif Berakhir',
    message: `Masa aktif paket ${oldRole.toUpperCase()} kamu telah berakhir dan otomatis diturunkan ke Public.`,
    fields: [
      field('👤 Username', username, true),
      field('🆔 Discord ID', discordId, true),
      field('📦 Paket Sebelumnya', oldRole.toUpperCase(), true),
      field('📦 Paket Sekarang', 'PUBLIC', true)
    ],
    dm: true, webhook: true
  }).catch(() => {});
  pushAccountUpdate(discordId).catch(() => {});

  // Auto Remove Installed Premium Content — jadwalkan (& coba langsung kirim kalau
  // user online) penghapusan seluruh game/bypass yang diinstal selagi dia Gold/Platinum.
  schedulePremiumCleanup(discordId, username, oldRole, 'expired').catch(() => {});

  return updated || user;
}

// Cek + konsumsi kuota download harian. type = 'game' | 'bypass'.
// - Kalau limit-nya Infinity (platinum & admin) -> langsung ok, TIDAK nulis apapun ke DB.
// - Kalau counter hari ini sudah >= limit -> ok:false + pesan buat ditampilin ke user.
// - Kalau masih ada sisa -> counter ditambah 1 & disimpan ke DB, return ok:true.
async function consumeDownloadQuota(user, type) {
  const limits = DOWNLOAD_LIMITS[user.role] || DOWNLOAD_LIMITS.public;
  const limit = limits[type];
  if (limit === Infinity) return { ok: true, limit: null, used: null, remaining: null };

  const today = todayDateStrJakarta();
  const prevUsage = (user.downloadUsage && user.downloadUsage.date === today)
    ? user.downloadUsage
    : { date: today, game: 0, bypass: 0 };

  const used = prevUsage[type] || 0;
  if (used >= limit) {
    return {
      ok: false, limit, used,
      message: `Limit download harian untuk ${type === 'game' ? 'Game' : 'Bypass'} (${limit}x/hari) sudah tercapai. Coba lagi besok atau upgrade paket kamu.`
    };
  }

  const newUsage = { ...prevUsage, [type]: used + 1 };
  await db.collection('users').updateOne(
    { discordId: user.discordId },
    { $set: { downloadUsage: newUsage } }
  );

  const remaining = limit - newUsage[type];
  const label = type === 'game' ? 'Game' : 'Bypass';
  if (remaining === 0) {
    notifyUser(user.discordId, {
      type: 'quota_empty',
      title: `Limit Download ${label} Habis`,
      message: `Limit download harian kamu untuk ${label} (${limit}x/hari) sudah habis. Reset otomatis besok jam 00:00 WIB.`,
      fields: [
        field('👤 Username', user.username, true),
        field('🆔 Discord ID', user.discordId, true),
        field('📦 Tipe', label, true),
        field('🔢 Limit Harian', `${limit}x/hari`, true),
        field('📉 Sisa Limit', '0x', true)
      ],
      dm: true, webhook: true
    }).catch(() => {});
  } else if (remaining === 1 && limit > 1) {
    notifyUser(user.discordId, {
      type: 'quota_low',
      title: `Limit Download ${label} Hampir Habis`,
      message: `Sisa limit download ${label} kamu tinggal ${remaining}x hari ini.`,
      fields: [
        field('👤 Username', user.username, true),
        field('🆔 Discord ID', user.discordId, true),
        field('📦 Tipe', label, true),
        field('🔢 Limit Harian', `${limit}x/hari`, true),
        field('📉 Sisa Limit', `${remaining}x`, true)
      ],
      dm: true, webhook: true
    }).catch(() => {});
  }
  pushAccountUpdate(user.discordId).catch(() => {});

  return { ok: true, limit, used: newUsage[type], remaining };
}

// Ringkasan masa aktif & limit download user — dipakai di /api/me (app) & Manajemen
// Users (admin panel) biar kelihatan jelas tanpa perlu itung manual di frontend.
function accountStatusSummary(user) {
  const limits = DOWNLOAD_LIMITS[user.role] || DOWNLOAD_LIMITS.public;
  const today = todayDateStrJakarta();
  const usage = (user.downloadUsage && user.downloadUsage.date === today)
    ? user.downloadUsage
    : { date: today, game: 0, bypass: 0 };

  const mk = (type) => {
    const limit = limits[type];
    if (limit === Infinity) return { limit: null, used: 0, remaining: null, unlimited: true };
    const used = usage[type] || 0;
    return { limit, used, remaining: Math.max(0, limit - used), unlimited: false };
  };

  const hasActivePeriod = (user.role === 'gold' || user.role === 'platinum');
  return {
    activeUntil: hasActivePeriod ? (user.activeUntil || null) : null,
    hasActivePeriod,
    hasExpiry: hasActivePeriod && !!user.activeUntil,
    isExpired: isActivePeriodExpired(user),
    download: { game: mk('game'), bypass: mk('bypass') }
  };
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY ROLE — sinkron role App ⇄ Discord + webhook notif (lihat discordRoleSync.js)
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// REALTIME — WebSocket hub
// Tanpa Socket.IO (biar client-side gak perlu bundling apa-apa, browser Chromium
// di Electron sudah punya `WebSocket` bawaan). Auth pakai JWT yang sama dengan
// REST (?token=... di query string pas connect). Satu discordId bisa punya lebih
// dari satu koneksi (multi-device), makanya disimpan sebagai Set per discordId.
// ══════════════════════════════════════════════════════════════════════════
const wsClients = new Map(); // discordId -> Set<WebSocket>

function wsRegister(discordId, ws) {
  if (!wsClients.has(discordId)) wsClients.set(discordId, new Set());
  wsClients.get(discordId).add(ws);
}
function wsUnregister(discordId, ws) {
  const set = wsClients.get(discordId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) wsClients.delete(discordId);
}
// Kirim event realtime ke SEMUA koneksi aktif milik satu user (semua device/instance
// aplikasi yang sedang login). Kalau user lagi offline, ya cuma kesimpen di DB
// (untuk notifikasi) — pas dia buka app lagi otomatis kelihatan dari /api/notifications.
function wsSendToUser(discordId, event, data) {
  const set = wsClients.get(discordId);
  if (!set || set.size === 0) return false;
  const payload = JSON.stringify({ event, data });
  let sent = false;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(payload); sent = true; }
  }
  return sent;
}
// Broadcast ke SEMUA user yang sedang terkoneksi (dipakai buat pengumuman admin).
function wsBroadcastAll(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const set of wsClients.values()) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// REALTIME — Admin Dashboard hub (terpisah dari wsClients di atas, karena admin
// bisa login pakai password bersama yang TIDAK terikat discordId sama sekali).
// Dipakai supaya Dashboard admin (stat card, grafik, activity feed) otomatis
// ter-update tanpa refresh, begitu ada aktivitas baru yang tercatat di
// activityLogs (lihat logActivity di bawah).
// ══════════════════════════════════════════════════════════════════════════
const adminWsClients = new Set();
function wsRegisterAdmin(ws) { adminWsClients.add(ws); }
function wsUnregisterAdmin(ws) { adminWsClients.delete(ws); }
function broadcastAdmin(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const ws of adminWsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOG CATALOG — SATU-SATUNYA sumber kebenaran untuk SEMUA jenis log sistem:
// icon, label (Bahasa Indonesia, dipakai di halaman Logs & Aktivitas Terbaru),
// kategori (buat pengelompokan filter di halaman Logs), dan status default
// (dipakai kalau logActivity() dipanggil tanpa `status` eksplisit).
// Beberapa key ditandai `reserved: true` — jenis log ini BELUM punya fitur
// nyata di aplikasi (contoh: Voucher & Paket belum jadi entity terpisah,
// "Request Game" belum jadi alur user->admin). Sengaja tetap didaftarkan di
// sini supaya halaman Logs sudah siap begitu fitur itu dibangun, TANPA
// berpura-pura log itu sudah ada datanya sekarang (sama seperti pola jujur
// yang sudah dipakai di quickActionRequestGame() pada admin.js).
// ══════════════════════════════════════════════════════════════════════════
const LOG_CATALOG = {
  login:                 { label: 'Login User',                icon: '🔑', category: 'auth',       status: 'success' },
  logout:                { label: 'Logout User',                icon: '🚪', category: 'auth',       status: 'info' },
  admin_login:           { label: 'Login Admin',                 icon: '🛡️', category: 'auth',       status: 'success' },
  admin_logout:          { label: 'Logout Admin',                 icon: '🚪', category: 'auth',       status: 'info' },
  install:               { label: 'Install Game/Bypass Berhasil', icon: '⬇️', category: 'app',        status: 'success' },
  download_failed:       { label: 'Install/Download Gagal',       icon: '⚠️', category: 'app',        status: 'error' },
  download:              { label: 'Download Game',                icon: '📥', category: 'app',        status: 'success' },
  request_game:          { label: 'Request Game',                 icon: '🎯', category: 'app',        status: 'info', reserved: true },
  set_paket:             { label: 'Set Paket User',                icon: '📦', category: 'billing',    status: 'success' },
  purchase:              { label: 'Pembelian Paket',                icon: '💳', category: 'billing',    status: 'success' },
  renewal:                { label: 'Perpanjangan Paket',             icon: '🔄', category: 'billing',    status: 'success' },
  admin_reset_quota:      { label: 'Reset Download/Bypass Limit',     icon: '♻️', category: 'moderation', status: 'success' },
  device_reset:           { label: 'Reset Device',                    icon: '🖥️', category: 'moderation', status: 'success' },
  device_allow_change:    { label: 'Izinkan Ganti Device',             icon: '🔓', category: 'moderation', status: 'success' },
  user_ban:               { label: 'Ban User',                         icon: '⛔', category: 'moderation', status: 'warning' },
  user_unban:             { label: 'Unban User',                        icon: '✅', category: 'moderation', status: 'success' },
  user_suspend:           { label: 'Suspend User',                      icon: '⏸️', category: 'moderation', status: 'warning' },
  user_unsuspend:         { label: 'Unsuspend User',                     icon: '▶️', category: 'moderation', status: 'success' },
  account_status:         { label: 'Perubahan Status Akun',               icon: '🛡️', category: 'moderation', status: 'info' },
  edit_user:               { label: 'Edit Data User',                     icon: '✏️', category: 'moderation', status: 'success' },
  announcement:            { label: 'Pengumuman / Broadcast',              icon: '📢', category: 'comms', status: 'info' },
  discord_dm:              { label: 'Discord DM',                          icon: '✉️', category: 'comms', status: 'info' },
  discord_webhook:         { label: 'Discord Webhook',                     icon: '🔗', category: 'comms', status: 'info' },
  admin_add_game:          { label: 'Tambah Game',                         icon: '➕', category: 'catalog', status: 'success' },
  admin_edit_game:         { label: 'Edit Game',                           icon: '✏️', category: 'catalog', status: 'success' },
  admin_delete_game:       { label: 'Hapus Game',                          icon: '🗑️', category: 'catalog', status: 'warning' },
  admin_add_bypass:        { label: 'Tambah Bypass',                       icon: '➕', category: 'catalog', status: 'success' },
  admin_edit_bypass:       { label: 'Edit Bypass',                         icon: '✏️', category: 'catalog', status: 'success' },
  admin_delete_bypass:     { label: 'Hapus Bypass',                        icon: '🗑️', category: 'catalog', status: 'warning' },
  admin_add_tutorial:      { label: 'Tambah Tutorial',                     icon: '➕', category: 'catalog', status: 'success' },
  admin_edit_tutorial:     { label: 'Edit Tutorial',                       icon: '✏️', category: 'catalog', status: 'success' },
  admin_delete_tutorial:   { label: 'Hapus Tutorial',                      icon: '🗑️', category: 'catalog', status: 'warning' },
  admin_add_voucher:       { label: 'Tambah Voucher',                      icon: '➕', category: 'catalog', status: 'success', reserved: true },
  admin_edit_voucher:      { label: 'Edit Voucher',                        icon: '✏️', category: 'catalog', status: 'success', reserved: true },
  admin_delete_voucher:    { label: 'Hapus Voucher',                       icon: '🗑️', category: 'catalog', status: 'warning', reserved: true },
  admin_add_package:       { label: 'Tambah Paket',                        icon: '➕', category: 'catalog', status: 'success', reserved: true },
  admin_edit_package:      { label: 'Edit Paket',                          icon: '✏️', category: 'catalog', status: 'success', reserved: true },
  admin_delete_package:    { label: 'Hapus Paket',                         icon: '🗑️', category: 'catalog', status: 'warning', reserved: true },
  hubcap_key_add:          { label: 'Tambah API Key HubCap',               icon: '🔑', category: 'hubcap', status: 'success' },
  hubcap_key_edit:         { label: 'Edit API Key HubCap',                 icon: '✏️', category: 'hubcap', status: 'success' },
  hubcap_key_delete:       { label: 'Hapus API Key HubCap',                icon: '🗑️', category: 'hubcap', status: 'warning' },
  hubcap_key_limit:        { label: 'API Key HubCap Mencapai Limit',       icon: '⛔', category: 'hubcap', status: 'warning' },
  hubcap_auto_rotation:    { label: 'Auto Rotation API Key HubCap',        icon: '🔄', category: 'hubcap', status: 'warning' },
  hubcap_all_limited:      { label: 'Semua API Key HubCap Limit',          icon: '🚨', category: 'hubcap', status: 'error' },
  hubcap_api_error:        { label: 'Error API HubCap',                    icon: '⚠️', category: 'hubcap', status: 'error' },
  ryu_key_add:              { label: 'Tambah API Key Ryu',                  icon: '🔑', category: 'ryu',    status: 'success' },
  ryu_key_edit:             { label: 'Edit API Key Ryu',                    icon: '✏️', category: 'ryu',    status: 'success' },
  ryu_key_delete:           { label: 'Hapus API Key Ryu',                   icon: '🗑️', category: 'ryu',    status: 'warning' },
  ryu_key_limit:            { label: 'API Key Ryu Mencapai Limit',          icon: '⛔', category: 'ryu',    status: 'warning' },
  ryu_auto_rotation:        { label: 'Auto Rotation API Key Ryu',           icon: '🔄', category: 'ryu',    status: 'warning' },
  ryu_all_limited:          { label: 'Semua API Key Ryu Limit',             icon: '🚨', category: 'ryu',    status: 'error' },
  ryu_api_error:            { label: 'Error API Ryu',                       icon: '⚠️', category: 'ryu',    status: 'error' },
  settings_change:         { label: 'Perubahan Pengaturan',                icon: '⚙️', category: 'system', status: 'info' },
  premium_expired:         { label: 'Paket Premium Berakhir',              icon: '⏰', category: 'billing', status: 'warning' },
  premium_cleanup_start:   { label: 'Penghapusan Konten Premium Dimulai',  icon: '🧹', category: 'moderation', status: 'info' },
  premium_cleanup_done:    { label: 'Penghapusan Konten Premium Selesai',  icon: '✅', category: 'moderation', status: 'success' },
  premium_cleanup_manual:  { label: 'Hapus Manual Konten Premium (Admin)', icon: '🗑️', category: 'moderation', status: 'success' },
  system_error:            { label: 'Error Sistem',                       icon: '🚨', category: 'system', status: 'error' },
  other:                   { label: 'Aktivitas Lainnya',                  icon: 'ℹ️', category: 'system', status: 'info' }
};
// Kompatibilitas mundur — kode lama masih referensi ACTIVITY_ICON.
const ACTIVITY_ICON = Object.fromEntries(Object.entries(LOG_CATALOG).map(([k, v]) => [k, v.icon]));

// Ambil IP address dari request (support di belakang reverse proxy lewat X-Forwarded-For).
function getReqIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket?.remoteAddress || null;
}
// Ambil nama device/PC dari request kalau tersedia (header custom dari app Electron,
// fallback ke User-Agent buat request dari browser/Admin Web).
function getReqDevice(req) {
  return req.headers['x-device-name'] || req.headers['x-pc-name'] || req.headers['user-agent'] || null;
}

// Catat satu entri aktivitas ke koleksi `activityLogs` — dipakai buat panel
// "Aktivitas Terbaru" + grafik "Login 7 Hari Terakhir" di Dashboard, DAN
// sekarang jadi sumber data utama halaman Logs (audit trail lengkap).
// Best-effort — kalau gagal simpan (mis. DB belum siap), jangan sampai
// menghambat/gagalkan proses utama yang memanggilnya.
async function logActivity({
  type, username, discordId, role, admin, description, status, ip, device,
  before, after, meta = {}
}) {
  const cat = LOG_CATALOG[type] || LOG_CATALOG.other;
  const doc = {
    type,
    icon: cat.icon,
    label: cat.label,
    category: cat.category,
    status: status || cat.status || 'info',
    username: username || null,
    discordId: discordId || null,
    role: role || null,
    admin: admin || null,
    description: description || '',
    ip: ip || null,
    device: device || null,
    changes: (before !== undefined || after !== undefined) ? { before: before ?? null, after: after ?? null } : null,
    meta,
    createdAt: new Date()
  };
  try {
    if (!db) return doc;
    const result = await db.collection('activityLogs').insertOne(doc);
    doc._id = result.insertedId;
  } catch (e) {
    console.warn('[Activity] Gagal simpan activity log:', e.message);
  }
  // Push realtime ke semua admin yang lagi buka Dashboard ATAU halaman Logs — kedua
  // halaman tinggal prepend item ini ke daftar mereka, TANPA perlu refresh/restart.
  broadcastAdmin('activity', doc);
  return doc;
}

// Kirim ulang status akun (role, masa aktif, limit download) ke user secara realtime.
// Dipanggil setiap kali ada perubahan di server yang mempengaruhi data itu, supaya
// client TIDAK PERLU refresh/restart/login ulang untuk lihat perubahannya.
async function pushAccountUpdate(discordId) {
  try {
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return;
    wsSendToUser(discordId, 'account:update', publicUser(user));
  } catch (e) {
    console.warn('[Realtime] Gagal push account:update:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// NOTIFIKASI — In-App + Discord DM + Discord Webhook
// ══════════════════════════════════════════════════════════════════════════
// Kirim webhook notifikasi ke channel Discord SESUAI KATEGORINYA (lihat
// webhookManager.js + WEBHOOK_CATEGORY_BY_NOTIF_TYPE di atas). Setiap kategori
// (Download Berhasil, Limit Habis, Pengumuman, dst) punya webhook URL sendiri
// yang diatur dari Admin Web > Webhook Settings — best-effort, tidak pernah
// melempar error ke pemanggil kalau webhook-nya belum diatur/gagal kirim.
const { buildEmbed, field, fmtDurationMs, fmtDateTimeWIB } = require('./notifTemplates');
// Logo aplikasi (opsional, isi di .env) — dipakai sebagai thumbnail fallback
// pada notifikasi yang tidak punya gambar sendiri (mis. paket/pengumuman/error),
// sesuai poin "Jika gambar tidak tersedia, gunakan thumbnail/logo aplikasi sebagai fallback".
const APP_LOGO_URL = process.env.APP_LOGO_URL || null;

async function sendDiscordWebhook(notifType, embed) {
  const category = WEBHOOK_CATEGORY_BY_NOTIF_TYPE[notifType] || 'announcement';
  return webhookManager.sendCategoryWebhook(category, { embed });
}

// Status (warna+emoji 🟢🟡🔴🔵) & label tiap jenis notifikasi in-app. SATU-SATUNYA
// sumber kebenaran dipakai buat bikin embed (lewat notifTemplates.buildEmbed) —
// DM & Webhook jadi selalu konsisten tampilannya untuk jenis notifikasi yang sama.
const NOTIF_META = {
  download_success: { status: 'success', label: 'Download Berhasil' },
  download_failed:  { status: 'error',   label: 'Download Gagal' },
  quota_low:        { status: 'warning', label: 'Limit Download Hampir Habis' },
  quota_empty:      { status: 'error',   label: 'Limit Download Habis' },
  period_low:       { status: 'warning', label: 'Paket Hampir Berakhir' },
  period_expired:   { status: 'error',   label: 'Paket Berakhir' },
  purchase:         { status: 'success', label: 'Pembelian Paket' },
  renewal:          { status: 'info',    label: 'Perpanjangan Paket' },
  announcement:     { status: 'info',    label: 'Pengumuman Admin' },
  login:            { status: 'info',    label: 'Login Akun' },
  system_error:     { status: 'error',   label: 'Error Sistem' }
};

// Fungsi utama pengiriman notifikasi. Selalu simpan ke DB (in-app, muncul di lonceng
// notifikasi walau user lagi offline) + push realtime via WebSocket kalau user online.
// Discord DM & Webhook sifatnya best-effort tambahan, dikontrol per-jenis notifikasi
// lewat opsi { dm, webhook } (default: dm untuk yang penting, webhook selalu untuk visibilitas admin).
//
// `fields`    : array field() tambahan yang RELEVAN untuk jenis notifikasi ini
//               (mis. nama game, ukuran, sisa limit, dll) — lihat notifTemplates.js.
// `thumbnail` : URL gambar kecil (icon paket/logo app/icon warning).
// `image`     : URL gambar besar/cover (dipakai untuk event terkait game).
async function notifyUser(discordId, { type, title, message, fields = [], thumbnail, image, meta = {}, dm = true, webhook = false }) {
  const doc = {
    discordId, type, title, message, meta,
    read: false,
    createdAt: new Date()
  };
  let inserted = null;
  try {
    const result = await db.collection('notifications').insertOne(doc);
    inserted = { ...doc, _id: result.insertedId };
  } catch (e) {
    console.warn('[Notif] Gagal simpan ke DB:', e.message);
    inserted = doc;
  }

  // In-app realtime push
  wsSendToUser(discordId, 'notification', inserted);
  // Kirim juga jumlah unread terbaru biar badge lonceng update tanpa query tambahan
  try {
    const unread = await db.collection('notifications').countDocuments({ discordId, read: false });
    wsSendToUser(discordId, 'notification:unread-count', { unread });
  } catch {}

  const typeMeta = NOTIF_META[type] || { status: 'info', label: title };
  const embed = buildEmbed({
    status: typeMeta.status,
    title,
    description: message,
    fields,
    thumbnail: thumbnail || APP_LOGO_URL || undefined,
    image,
    appName: APP_NAME,
    footerNote: typeMeta.label
  });

  if (dm) {
    sendDiscordDM(discordId, { embeds: [embed] }).catch(() => {});
  }
  if (webhook) {
    sendDiscordWebhook(type, embed).catch(() => {});
  }

  return inserted;
}

// Broadcast pengumuman admin ke SEMUA user (in-app selalu; DM & webhook opsional,
// dikontrol dari form admin biar tidak spam kalau pengumumannya kecil-kecilan saja).
async function notifyAllUsers({ title, message, dm = false, webhook = true }) {
  const users = await db.collection('users').find({}, { projection: { discordId: 1 } }).toArray();
  const results = await Promise.allSettled(
    users.map(u => notifyUser(u.discordId, { type: 'announcement', title, message, dm, webhook: false }))
  );
  if (webhook) {
    const embed = buildEmbed({
      status: 'info',
      title,
      description: message,
      fields: [field('🎯 Target', `Semua User (${users.length})`, true)],
      thumbnail: APP_LOGO_URL || undefined,
      appName: APP_NAME,
      footerNote: NOTIF_META.announcement.label
    });
    await sendDiscordWebhook('announcement', embed).catch(() => {});
  }
  return results.length;
}

const roleSync = require('./discordRoleSync')({ getDb: () => db, ROLE_LEVEL });

// Webhook Discord PER KATEGORI notifikasi (lihat webhookManager.js) — menggantikan
// webhook tunggal DISCORD_NOTIF_WEBHOOK_URL lama. Diatur dari Admin Web > Webhook
// Settings, disimpan di DB, berlaku realtime tanpa restart.
const webhookManager = require('./webhookManager')({ getDb: () => db });

// Device Lock — 1 akun cuma bisa dipakai di 1 perangkat (lihat deviceLock.js).
// Fingerprint dihitung dari kombinasi beberapa komponen hardware, disimpan di
// DB (collection `devices` + audit trail `deviceLogs`), berlaku realtime.
const deviceLock = require('./deviceLock')({ getDb: () => db });

// ══════════════════════════════════════════════════════════════════════════
// AUTO REMOVE INSTALLED PREMIUM CONTENT
// ══════════════════════════════════════════════════════════════════════════
// Begitu masa aktif Gold/Platinum user habis (lihat applyExpiryIfNeeded di atas —
// dicek di SETIAP request lewat requireUser, termasuk polling /api/me/role-check
// tiap 3 detik, jadi efeknya kerasa realtime walau user idle), seluruh game &
// bypass yang diinstal SELAGI dia Gold/Platinum (ditandai `installedViaRole` di
// collection `history`, lihat POST /api/history) dijadwalkan untuk dihapus dari
// PC user — DAN HANYA game/bypass itu; file lain milik user tidak disentuh sama
// sekali (Electron main.js yang benar-benar hapus file HANYA lewat whitelist
// stplug-in/depotcache untuk game, dan hanya file hasil extract tercatat untuk
// bypass — lihat ipcMain.handle('remove-game'/'remove-bypass') di main.js).
//
// Alur:
//   1. Expired terdeteksi -> schedulePremiumCleanup() bikin 1 dokumen job di
//      `premiumCleanups` (status 'pending') + log 'premium_expired'.
//   2. Kalau delay = immediate & user LAGI ONLINE (ada koneksi WS) -> job
//      langsung di-push via WS event 'premium:cleanup' (status jadi 'delivered').
//   3. Kalau user OFFLINE atau delay-nya 1h/24h -> job tetap 'pending'. Setiap
//      kali user connect ulang (WS) ATAU tiap sweep 2 menit (jaga-jaga kalau app
//      dibuka lewat cara lain / WS gagal), job yang scheduledAt-nya sudah lewat
//      otomatis di-deliver. Jadi TETAP jalan walau app sempat ditutup.
//   4. Client (app.js) yang benar-benar mengeksekusi hapus file via IPC (main.js),
//      lalu lapor balik lewat /api/premium-cleanup/:id/start & /:id/complete —
//      di situ log 'premium_cleanup_start'/'premium_cleanup_done' dicatat dengan
//      daftar lengkap game & bypass yang dihapus, dan histori DB-nya dibersihkan.
// User biasa TIDAK PUNYA cara membatalkan job ini dari sisi app — tidak ada
// endpoint/][tombol apapun di client untuk menolak/skip proses ini.
// ══════════════════════════════════════════════════════════════════════════
const AUTO_REMOVE_SETTINGS_ID = 'autoRemovePremium';
const AUTO_REMOVE_DELAY_MS = { immediate: 0, '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

async function getAutoRemoveSettings() {
  const defaults = { enabled: true, delay: 'immediate' };
  try {
    const doc = await db.collection('settings').findOne({ _id: AUTO_REMOVE_SETTINGS_ID });
    if (!doc) return defaults;
    return {
      enabled: typeof doc.enabled === 'boolean' ? doc.enabled : defaults.enabled,
      delay: AUTO_REMOVE_DELAY_MS.hasOwnProperty(doc.delay) ? doc.delay : defaults.delay
    };
  } catch (e) {
    return defaults;
  }
}

// Ambil semua item (game & bypass) yang masih tercatat di histori user & diinstal
// SELAGI dia berperan gold/platinum — inilah yang dianggap "konten premium".
// Dipakai buat pembersihan OTOMATIS (reason 'expired') — sengaja HANYA yang
// premium, karena user public tidak punya "paket" yang bisa berakhir.
async function getPremiumInstalledItems(discordId) {
  return db.collection('history').find({
    userId: discordId,
    installedViaRole: { $in: ['gold', 'platinum'] }
  }).toArray();
}

// Ambil SEMUA item (game & bypass) yang tercatat di histori user, TANPA peduli
// role apa yang dipakai saat install — dipakai KHUSUS buat tombol "Hapus Manual"
// admin (reason 'manual'), supaya fiturnya juga bisa dipakai buat user Public
// (yang mana tidak akan pernah punya installedViaRole gold/platinum sama sekali).
async function getAllInstalledItems(discordId) {
  return db.collection('history').find({ userId: discordId }).toArray();
}

// Bikin & (kalau memungkinkan) langsung kirim job pembersihan konten untuk
// satu user. `reason`: 'expired' (otomatis, dipanggil applyExpiryIfNeeded, HANYA
// konten premium) atau 'manual' (admin pencet tombol "Hapus Manual" di Admin Web,
// SELURUH game & bypass milik user ini — berlaku utk role apapun termasuk Public).
async function schedulePremiumCleanup(discordId, username, expiredRole, reason = 'expired') {
  try {
    const settings = reason === 'manual' ? { enabled: true, delay: 'immediate' } : await getAutoRemoveSettings();

    logActivity({
      type: 'premium_expired',
      username, discordId, role: expiredRole,
      status: 'warning',
      description: reason === 'manual'
        ? `Admin memicu penghapusan manual seluruh game & bypass untuk ${username}.`
        : `Masa aktif paket ${String(expiredRole).toUpperCase()} milik ${username} telah berakhir.`,
      meta: { reason }
    }).catch(() => {});

    if (!settings.enabled && reason !== 'manual') {
      logActivity({
        type: 'premium_expired',
        username, discordId, role: expiredRole,
        status: 'info',
        description: `Auto Remove Installed Premium Content NONAKTIF — konten premium ${username} TIDAK dihapus otomatis.`,
        meta: { reason: 'auto_remove_disabled' }
      }).catch(() => {});
      return null;
    }

    // 'manual' (tombol Hapus Manual admin) -> SEMUA item milik user ini, apapun
    // role-nya (termasuk Public) — bukan cuma yang ditandai gold/platinum.
    // 'expired' (otomatis) -> TETAP hanya yang premium, sesuai spec awal.
    const items = reason === 'manual' ? await getAllInstalledItems(discordId) : await getPremiumInstalledItems(discordId);
    if (!items.length) return null; // tidak ada apapun yang perlu dihapus

    const jobItems = items.map(h => ({
      historyId: String(h._id), itemType: h.itemType, itemId: h.itemId,
      itemName: h.itemName, extractedFiles: h.extractedFiles || [],
      steamPath: h.steamPath || null, folderPath: h.folderPath || null
    }));

    const delayMs = AUTO_REMOVE_DELAY_MS[settings.delay] ?? 0;
    const scheduledAt = new Date(Date.now() + delayMs);

    const jobDoc = {
      discordId, username, role: expiredRole, reason,
      status: 'pending',
      items: jobItems,
      gameCount: jobItems.filter(i => i.itemType === 'game').length,
      bypassCount: jobItems.filter(i => i.itemType === 'bypass').length,
      scheduledAt, createdAt: new Date(),
      deliveredAt: null, completedAt: null, result: null
    };
    const inserted = await db.collection('premiumCleanups').insertOne(jobDoc);
    jobDoc._id = inserted.insertedId;

    // Kasih tahu user SEBELUM penghapusan terjadi — TAPI HANYA untuk pembersihan
    // OTOMATIS (paket Gold/Platinum expired, sesuai spec awal). Kalau admin yang
    // memicu manual (reason 'manual'), proses harus SILENT — TIDAK ADA notifikasi
    // apapun ke user (tidak ada in-app notif, toast, DM, maupun webhook, dan modal
    // Auto Remove di client juga TIDAK ditampilkan — lihat handlePremiumCleanup()
    // di app.js). Ini permintaan eksplisit: hapus manual admin harus tanpa jejak
    // notifikasi ke user, beda dari auto-delete setelah paket habis yang tetap
    // wajib kasih notif sebelum & sesudah.
    if (reason !== 'manual') {
      notifyUser(discordId, {
        type: 'announcement',
        title: 'Paket Premium Berakhir — Konten Akan Dihapus',
        message: `Masa aktif paket ${String(expiredRole).toUpperCase()} kamu sudah berakhir. Seluruh game (${jobDoc.gameCount}) dan bypass (${jobDoc.bypassCount}) premium yang kamu install akan otomatis dihapus dari PC${delayMs > 0 ? ` dalam ${settings.delay === '1h' ? '1 jam' : '24 jam'}` : ' saat ini juga'}.`,
        fields: [
          field('📦 Paket Berakhir', String(expiredRole).toUpperCase(), true),
          field('🎮 Game Terpasang', String(jobDoc.gameCount), true),
          field('🛡️ Bypass Terpasang', String(jobDoc.bypassCount), true)
        ],
        dm: true, webhook: true
      }).catch(() => {});
    }

    await tryDeliverCleanupJob(jobDoc);
    return jobDoc;
  } catch (e) {
    console.warn('[AutoRemove] Gagal menjadwalkan pembersihan:', e.message);
    return null;
  }
}

// Coba kirim job ke client via WS SEKARANG (kalau sudah waktunya & user online).
// Dipanggil: (a) langsung setelah job dibuat kalau delay=immediate, (b) setiap kali
// user connect ulang WS (jaga-jaga job lama nunggak karena user lagi offline),
// dan (c) sweep berkala buat job dengan delay 1h/24h.
async function tryDeliverCleanupJob(jobDoc) {
  if (jobDoc.status !== 'pending') return false;
  if (new Date(jobDoc.scheduledAt).getTime() > Date.now()) return false; // belum waktunya
  const sent = wsSendToUser(jobDoc.discordId, 'premium:cleanup', {
    jobId: String(jobDoc._id),
    role: jobDoc.role,
    reason: jobDoc.reason,
    items: jobDoc.items,
    gameCount: jobDoc.gameCount,
    bypassCount: jobDoc.bypassCount
  });
  if (sent) {
    await db.collection('premiumCleanups').updateOne(
      { _id: jobDoc._id },
      { $set: { status: 'delivered', deliveredAt: new Date() } }
    );
  }
  return sent;
}

// Sweep berkala — jaring pengaman buat job yang sempat gagal terkirim (user offline
// pas dijadwalkan) ATAU job dengan delay 1h/24h yang waktunya baru saja tiba.
async function sweepPendingPremiumCleanups() {
  try {
    if (!db) return;
    const due = await db.collection('premiumCleanups')
      .find({ status: 'pending', scheduledAt: { $lte: new Date() } })
      .limit(200)
      .toArray();
    for (const job of due) {
      await tryDeliverCleanupJob(job).catch(() => {});
    }
  } catch (e) {
    console.warn('[AutoRemove] Sweep gagal:', e.message);
  }
}
setInterval(() => sweepPendingPremiumCleanups().catch(() => {}), 2 * 60 * 1000);

// ── REST: konten yang app.js panggil buat eksekusi & lapor hasil ──

// Dipanggil app.js SEGERA setelah login/startup — jaring pengaman kalau event WS
// 'premium:cleanup' entah kenapa tidak sempat diterima (race condition koneksi,
// dsb). Mengembalikan job yang statusnya 'pending'/'delivered' & sudah waktunya,
// MILIK user yang sedang login SAJA.
app.get('/api/premium-cleanup/pending', requireUser, async (req, res) => {
  try {
    const jobs = await db.collection('premiumCleanups').find({
      discordId: req.user.discordId,
      status: { $in: ['pending', 'delivered'] },
      scheduledAt: { $lte: new Date() }
    }).toArray();
    res.json({ jobs: jobs.map(j => ({
      jobId: String(j._id), role: j.role, reason: j.reason, items: j.items,
      gameCount: j.gameCount, bypassCount: j.bypassCount
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dipanggil app.js TEPAT SEBELUM mulai menghapus file di PC — menandai job
// 'processing' & mencatat log audit "penghapusan dimulai" (terpisah utk game & bypass
// sesuai permintaan, masing-masing dengan daftar nama-nya).
app.post('/api/premium-cleanup/:id/start', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const job = await db.collection('premiumCleanups').findOne({ _id: new ObjectId(req.params.id), discordId: req.user.discordId });
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan.' });
    if (job.status === 'done') return res.json({ success: true, alreadyDone: true });

    await db.collection('premiumCleanups').updateOne({ _id: job._id }, { $set: { status: 'processing', startedAt: new Date() } });

    const games = job.items.filter(i => i.itemType === 'game').map(i => i.itemName);
    const bypasses = job.items.filter(i => i.itemType === 'bypass').map(i => i.itemName);
    const isManualJob = job.reason === 'manual';
    if (games.length) {
      logActivity({
        type: 'premium_cleanup_start', username: req.user.username, discordId: req.user.discordId,
        role: job.role, status: 'info', ip: getReqIp(req), device: getReqDevice(req),
        description: isManualJob
          ? `Penghapusan manual (dipicu admin) ${games.length} game milik ${req.user.username} dimulai.`
          : `Penghapusan ${games.length} game premium milik ${req.user.username} dimulai (paket ${String(job.role).toUpperCase()} berakhir).`,
        meta: { jobId: String(job._id), itemType: 'game', games }
      }).catch(() => {});
    }
    if (bypasses.length) {
      logActivity({
        type: 'premium_cleanup_start', username: req.user.username, discordId: req.user.discordId,
        role: job.role, status: 'info', ip: getReqIp(req), device: getReqDevice(req),
        description: isManualJob
          ? `Penghapusan manual (dipicu admin) ${bypasses.length} bypass milik ${req.user.username} dimulai.`
          : `Penghapusan ${bypasses.length} bypass premium milik ${req.user.username} dimulai (paket ${String(job.role).toUpperCase()} berakhir).`,
        meta: { jobId: String(job._id), itemType: 'bypass', bypasses }
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dipanggil app.js SETELAH selesai mengeksekusi remove-game/remove-bypass untuk
// SEMUA item di job ini. Body: { results: [{ historyId, itemType, itemName, removed, error }] }.
// Histori (`history`) untuk item yang BERHASIL dihapus langsung dibersihkan di sini
// (server-side, satu kali) — client tidak perlu panggil DELETE /api/history per-item.
app.post('/api/premium-cleanup/:id/complete', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const job = await db.collection('premiumCleanups').findOne({ _id: new ObjectId(req.params.id), discordId: req.user.discordId });
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan.' });

    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    const removedIds = results.filter(r => r.removed && ObjectId.isValid(r.historyId)).map(r => new ObjectId(r.historyId));
    if (removedIds.length) {
      await db.collection('history').deleteMany({ _id: { $in: removedIds }, userId: req.user.discordId });
    }

    const removedGames   = results.filter(r => r.removed && r.itemType === 'game').map(r => r.itemName);
    const removedBypass  = results.filter(r => r.removed && r.itemType === 'bypass').map(r => r.itemName);
    const failed         = results.filter(r => !r.removed).map(r => ({ itemName: r.itemName, itemType: r.itemType, error: r.error || 'Gagal' }));
    const allOk  = results.length > 0 && failed.length === 0;
    const status = results.length === 0 ? 'info' : (allOk ? 'success' : (failed.length === results.length ? 'error' : 'warning'));
    const finalStatus = results.length === 0 ? 'done' : (allOk ? 'done' : 'partial');

    await db.collection('premiumCleanups').updateOne(
      { _id: job._id },
      { $set: { status: finalStatus, completedAt: new Date(), result: { removedGames, removedBypass, failed } } }
    );

    logActivity({
      type: 'premium_cleanup_done', username: req.user.username, discordId: req.user.discordId,
      role: job.role, status, ip: getReqIp(req), device: getReqDevice(req),
      description: job.reason === 'manual'
        ? `Penghapusan manual (dipicu admin) untuk ${req.user.username} selesai — ${removedGames.length} game & ${removedBypass.length} bypass terhapus${failed.length ? `, ${failed.length} gagal` : ''}.`
        : `Penghapusan konten premium ${req.user.username} selesai — ${removedGames.length} game & ${removedBypass.length} bypass terhapus${failed.length ? `, ${failed.length} gagal` : ''}.`,
      meta: { jobId: String(job._id), removedGames, removedBypass, failed }
    }).catch(() => {});

    // SILENT untuk manual (dipicu admin) — sesuai permintaan eksplisit, TIDAK ADA
    // notifikasi apapun ke user (in-app/DM/webhook) kalau admin yang menghapus.
    // Auto-delete setelah paket Gold/Platinum expired TETAP kasih notif seperti biasa.
    if (job.reason !== 'manual') {
      notifyUser(req.user.discordId, {
        type: 'announcement',
        title: allOk || results.length === 0 ? 'Konten Premium Berhasil Dihapus' : 'Penghapusan Konten Premium Selesai (Sebagian Gagal)',
        message: `${removedGames.length} game dan ${removedBypass.length} bypass premium sudah dihapus dari PC kamu karena paket ${String(job.role).toUpperCase()} sudah berakhir.${failed.length ? ` ${failed.length} item gagal dihapus otomatis, cek folder Steam/game secara manual kalau perlu.` : ''}`,
        fields: [
          field('🎮 Game Dihapus', String(removedGames.length), true),
          field('🛡️ Bypass Dihapus', String(removedBypass.length), true),
          ...(failed.length ? [field('⚠️ Gagal', String(failed.length), true)] : [])
        ],
        dm: true, webhook: true
      }).catch(() => {});
    }

    pushAccountUpdate(req.user.discordId).catch(() => {});
    res.json({ success: true, removedGames, removedBypass, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin Web: pengaturan Auto Remove (halaman Paket) ──
app.get('/api/admin/settings/auto-remove', requireAdmin, async (req, res) => {
  res.json(await getAutoRemoveSettings());
});

app.put('/api/admin/settings/auto-remove', requireAdmin, async (req, res) => {
  try {
    const { enabled, delay } = req.body;
    if (!AUTO_REMOVE_DELAY_MS.hasOwnProperty(delay)) return res.status(400).json({ error: 'Delay tidak valid.' });
    const next = { enabled: !!enabled, delay };
    await db.collection('settings').updateOne({ _id: AUTO_REMOVE_SETTINGS_ID }, { $set: next }, { upsert: true });
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan Auto Remove Installed Premium Content — ${next.enabled ? 'AKTIF' : 'NONAKTIF'}, waktu hapus: ${next.delay === 'immediate' ? 'Langsung' : next.delay === '1h' ? '1 Jam' : '24 Jam'}.`,
      meta: next
    }).catch(() => {});
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tombol "Hapus Manual" di Admin Web (halaman Paket / Users) — admin memicu langsung,
// TIDAK bergantung ke status expired maupun pengaturan enabled/disabled (admin yang minta
// eksplisit). Job tetap dieksekusi via client (WS kalau online, atau nunggu app dibuka).
app.post('/api/admin/users/:discordId/premium-cleanup', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const job = await schedulePremiumCleanup(discordId, user.username || discordId, user.role, 'manual');
    if (!job) return res.json({ success: true, scheduled: false, message: 'Tidak ada game/bypass yang terpasang untuk user ini.' });

    logActivity({
      type: 'premium_cleanup_manual', username: user.username || discordId, discordId,
      role: user.role, admin: req.admin?.username || 'Admin', status: 'success', ip: getReqIp(req),
      description: `Admin memicu hapus manual konten premium untuk ${user.username || discordId} (${job.gameCount} game, ${job.bypassCount} bypass).`,
      meta: { jobId: String(job._id), gameCount: job.gameCount, bypassCount: job.bypassCount }
    }).catch(() => {});

    res.json({ success: true, scheduled: true, jobId: String(job._id), gameCount: job.gameCount, bypassCount: job.bypassCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pemetaan jenis notifikasi in-app (`type` di notifyUser) -> kategori webhook.
// Dipakai supaya satu fungsi notifyUser tetap bisa dipanggil dari mana saja,
// tapi webhook-nya otomatis nyampur ke channel Discord yang benar sesuai kategori.
const WEBHOOK_CATEGORY_BY_NOTIF_TYPE = {
  download_success: 'download_success',
  download_failed:  'download_failed',
  quota_low:         'quota_low',
  quota_empty:       'quota_empty',
  period_low:        'period_low',
  period_expired:    'period_expired',
  purchase:          'purchase',
  renewal:           'renewal',
  announcement:      'announcement',
  login:             'login',
  system_error:      'system_error'
};

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
    await db.collection('games').createIndex({ category: 1 });
    await db.collection('categories').createIndex({ slug: 1 }, { unique: true });
    await db.collection('bypasses').createIndex({ role: 1 });
    await db.collection('history').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('pendingLogins').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
    await db.collection('roleSyncLogs').createIndex({ createdAt: -1 });
    await db.collection('roleSyncLogs').createIndex({ discordId: 1 });
    await db.collection('notifications').createIndex({ discordId: 1, createdAt: -1 });
    await db.collection('notifications').createIndex({ discordId: 1, read: 1 });
    await db.collection('activityLogs').createIndex({ createdAt: -1 });
    await db.collection('activityLogs').createIndex({ type: 1, createdAt: -1 });
    await db.collection('activityLogs').createIndex({ category: 1, createdAt: -1 });
    await db.collection('activityLogs').createIndex({ status: 1, createdAt: -1 });
    await db.collection('activityLogs').createIndex({ role: 1, createdAt: -1 });
    await db.collection('activityLogs').createIndex({ discordId: 1, createdAt: -1 });
    await db.collection('activityLogs').createIndex({ username: 'text', description: 'text', admin: 'text' });
    // Auto Remove Installed Premium Content — index buat sweep & lookup job cepat,
    // dan buat cari cepat semua histori install "premium" (gold/platinum) milik satu user.
    await db.collection('premiumCleanups').createIndex({ status: 1, scheduledAt: 1 });
    await db.collection('premiumCleanups').createIndex({ discordId: 1, createdAt: -1 });
    await db.collection('history').createIndex({ userId: 1, installedViaRole: 1 });
    await db.collection('deviceLogs').createIndex({ discordId: 1, createdAt: -1 });
    await db.collection('deviceLogs').createIndex({ createdAt: -1 });
    await db.collection('banners').createIndex({ order: 1 });
    await db.collection('banners').createIndex({ isActive: 1 });
    await db.collection('tutorials').createIndex({ status: 1, createdAt: -1 });
    await db.collection('tutorials').createIndex({ category: 1 });
    await db.collection('tutorials').createIndex({ title: 'text', description: 'text' });
    await db.collection('leaderboardHistory').createIndex({ weekStart: -1 });
    await db.collection('hubcapApiKeys').createIndex({ createdAt: 1 });

    // Migrasi satu kali: kalau ada HUBCAP_API_KEY* lama di .env tapi koleksi
    // hubcapApiKeys masih kosong, import jadi entri DB (lihat hubcapKeyManager.js).
    hubcapKeyManager.migrateLegacyEnvKeys().catch(e => console.warn('[HubcapKeyManager] Gagal migrasi:', e.message));

    // Seed 3 banner default (Code Banner) — HANYA jalan kalau koleksi `banners`
    // masih kosong sama sekali (deploy pertama kali / DB baru), supaya banner
    // yang sudah diedit/dihapus admin TIDAK PERNAH ditimpa ulang tiap restart.
    seedDefaultBannersIfEmpty().catch(e => console.warn('[Seed Banner] Gagal:', e.message));

    // Seed kategori default (Action/Sport/Puzzle/Mystery) — HANYA kalau koleksi
    // `categories` masih kosong sama sekali, supaya kategori yang sudah
    // diedit/ditambah/dihapus admin TIDAK PERNAH ditimpa ulang tiap restart.
    seedDefaultCategoriesIfEmpty().catch(e => console.warn('[Seed Kategori] Gagal:', e.message));

    // Cron ringan: cek tiap 5 menit apakah minggu leaderboard sudah berganti,
    // kalau ya snapshot leaderboard minggu sebelumnya ke `leaderboardHistory`.
    checkLeaderboardWeekRollover().catch(() => {});
    setInterval(() => checkLeaderboardWeekRollover().catch(() => {}), 5 * 60 * 1000);
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

    let user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });

    // Akun yang di-suspend/ban oleh admin tidak boleh lanjut pakai app sama sekali —
    // dicek di SETIAP request (bukan cuma pas login), jadi efeknya langsung kerasa
    // real-time walau usernya sedang aktif pakai app saat status diubah.
    if (isUserBlocked(user)) {
      return res.status(403).json({
        error: user.status === 'banned'
          ? `Akun kamu telah di-banned.${user.statusReason ? ' Alasan: ' + user.statusReason : ''}`
          : `Akun kamu sedang di-suspend sementara.${user.statusReason ? ' Alasan: ' + user.statusReason : ''}`,
        accountBlocked: true,
        status: user.status
      });
    }

    // Kalau masa aktif Gold/Platinum-nya sudah lewat, otomatis turunkan ke Public
    // SEBELUM request lanjut diproses, biar limit/akses yang berlaku langsung yang baru.
    user = await applyExpiryIfNeeded(user);

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

// Dipakai di route ADMIN WEB. Ada 2 cara sah buat lolos jadi admin:
//   1) LOGIN PASSWORD LAMA — token JWT { role: 'admin' } dari /api/admin/login
//      (satu password bersama dari .env, tanpa terikat akun Discord manapun).
//   2) LOGIN DISCORD — token JWT biasa { discordId } (sama seperti token app),
//      DIIZINKAN masuk admin panel KALAU DAN HANYA KALAU role user itu di
//      database saat ini adalah 'admin'. Role 'admin' ini sendiri diisi lewat
//      "Set Paket" admin panel ATAU otomatis mengikuti role Discord user kalau
//      role Discord itu sudah di-mapping ke tier 'admin' di halaman Verify Role
//      (persis seperti mapping Gold/Platinum, lihat discordRoleSync.js).
// Konsekuensinya: cabut role Discord "Admin" seseorang (atau ubah paketnya di
// panel jadi bukan admin) = akses admin panel orang itu otomatis ikut hilang
// di request berikutnya, karena role selalu dicek ulang ke DB, bukan disimpan
// permanen di dalam token.
async function requireAdmin(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET belum diset.' });
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Belum login admin.' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Token admin tidak valid.' });
    }

    // 1) Token admin lama (password bersama) — tidak terikat discordId sama sekali.
    if (payload.role === 'admin' && !payload.discordId) {
      req.admin = { via: 'password' };
      return next();
    }

    // 2) Token akun Discord — cek role user itu di DB sekarang juga.
    if (payload.discordId) {
      if (!db) return res.status(503).json({ error: 'Database belum siap, coba lagi sebentar.' });
      const user = await db.collection('users').findOne({ discordId: payload.discordId });
      if (user && user.role === 'admin') {
        req.user = user;
        req.admin = { via: 'discord', discordId: user.discordId, username: user.username, avatarUrl: user.avatarUrl };
        return next();
      }
    }

    return res.status(403).json({ error: 'Akun ini tidak punya akses admin.' });
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
    const isNewAccount = user.createdAt && new Date(user.createdAt).getTime() === now.getTime();

    if (isUserBlocked(user)) {
      return res.send(renderInfoPage({
        emoji: user.status === 'banned' ? '⛔' : '⏸️',
        title: user.status === 'banned' ? 'Akun Kamu Di-banned' : 'Akun Kamu Di-suspend',
        message: user.status === 'banned'
          ? `Akun Discord kamu telah di-banned dari layanan ini dan tidak bisa login.${user.statusReason ? ' Alasan: ' + user.statusReason : ''}`
          : `Akun kamu sedang di-suspend sementara oleh Admin dan tidak bisa login untuk saat ini.${user.statusReason ? ' Alasan: ' + user.statusReason : ''}`
      }));
    }

    // Catat aktivitas login (dipakai Dashboard admin: "Login hari ini", grafik
    // "Login 7 Hari Terakhir", dan Activity Feed) — best-effort, tidak pernah
    // menghambat proses login user kalau gagal simpan.
    logActivity({
      type: 'login',
      username: user.username,
      discordId: user.discordId,
      role: user.role,
      status: 'success',
      ip: getReqIp(req),
      description: `${user.username} login${isNewAccount ? ' (akun baru)' : ''}.`
    }).catch(() => {});

    // Realtime ke admin panel — biar "Login Terakhir" di Manajemen Users langsung
    // ter-update tanpa admin perlu refresh halaman.
    computeUserStats(user.discordId)
      .then(stats => broadcastAdmin('user:update', publicUser(user, stats)))
      .catch(() => broadcastAdmin('user:update', publicUser(user)));

    // Webhook kategori "Login Akun" (opsional, default OFF supaya tidak spam kalau
    // trafik tinggi) — best-effort, tidak pernah menghambat proses login user.
    webhookManager.sendCategoryWebhook('login', {
      embed: buildEmbed({
        status: 'info',
        title: isNewAccount ? 'Akun Baru Login Pertama Kali' : 'Login Akun',
        description: `${user.username} berhasil login lewat Discord OAuth.`,
        fields: [
          field('👤 Username', user.username, true),
          field('🆔 Discord ID', user.discordId, true),
          field('📦 Paket', (user.role || 'public').toUpperCase(), true)
        ],
        thumbnail: avatarUrl,
        appName: APP_NAME,
        footerNote: 'Login Akun'
      })
    }).catch(() => {});

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

// Status akun (BUKAN "accountStatus" yang di atas — itu ringkasan masa aktif/limit).
// 'active' (default) | 'suspended' (sementara, bisa diaktifkan lagi) | 'banned' (permanen).
const ACCOUNT_STATUSES = ['active', 'suspended', 'banned'];
function isUserBlocked(user) {
  return user.status === 'suspended' || user.status === 'banned';
}

function publicUser(u, stats) {
  return {
    discordId: u.discordId,
    username: u.username,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status || 'active',
    statusReason: u.statusReason || null,
    statusUpdatedAt: u.statusUpdatedAt || null,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt || null,
    roleUpdatedAt: u.roleUpdatedAt || null,
    accountStatus: accountStatusSummary(u),
    stats: stats || { downloads: 0, installs: 0, total: 0 }
  };
}

// Total download (Game) & install (Bypass) sepanjang waktu, dihitung dari koleksi
// 'history' — dipakai buat kartu detail user di admin panel. Dipanggil per-user
// (bukan batch) makanya cuma dipakai di endpoint yang butuh 1 user spesifik.
async function computeUserStats(discordId) {
  const [downloads, installs] = await Promise.all([
    db.collection('history').countDocuments({ userId: discordId, itemType: 'game' }),
    db.collection('history').countDocuments({ userId: discordId, itemType: 'bypass' })
  ]);
  return { downloads, installs, total: downloads + installs };
}

// ══════════════════════════════════════════════════════════════════════════
// WEEKLY LEADERBOARD — "Top Installer Mingguan"
// Dihitung langsung dari koleksi `history` (tiap install game/bypass = 1 entri),
// bukan data dummy. Minggu berjalan dari Senin 00:00 WIB (UTC+7) s/d Senin
// berikutnya, otomatis "reset" karena window waktunya ikut geser tiap kali
// dihitung ulang — tidak butuh proses reset manual.
// ══════════════════════════════════════════════════════════════════════════
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function getWeekRangeWIB(d = new Date()) {
  const wib = new Date(d.getTime() + WIB_OFFSET_MS);
  const day = wib.getUTCDay(); // 0=Minggu..6=Sabtu
  const diffToMonday = (day + 6) % 7; // jarak ke Senin terakhir
  wib.setUTCHours(0, 0, 0, 0);
  wib.setUTCDate(wib.getUTCDate() - diffToMonday);
  const weekStart = new Date(wib.getTime() - WIB_OFFSET_MS); // balik ke instant UTC asli
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { weekStart, weekEnd };
}

// Agregasi top installer minggu ini. itemType game & bypass dua-duanya dihitung
// sebagai "install" (sesuai request: total install/download 7 hari terakhir).
async function computeWeeklyLeaderboard(limit = 5, range = null) {
  if (!db) return { weekStart: null, weekEnd: null, entries: [] };
  const { weekStart, weekEnd } = range || getWeekRangeWIB();

  const rows = await db.collection('history').aggregate([
    { $match: { createdAt: { $gte: weekStart, $lt: weekEnd } } },
    { $group: { _id: '$userId', installs: { $sum: 1 } } },
    { $sort: { installs: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: 'discordId', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $project: {
        _id: 0,
        discordId: '$_id',
        installs: 1,
        username: { $ifNull: ['$user.username', 'Unknown'] },
        avatarUrl: '$user.avatarUrl',
        role: { $ifNull: ['$user.role', 'public'] }
    } }
  ]).toArray();

  return { weekStart, weekEnd, entries: rows };
}

// Cron ringan (dipanggil tiap 5 menit dari connectDB): kalau minggu berjalan
// sudah berganti dibanding yang tersimpan di `settings`, snapshot leaderboard
// minggu yang baru saja berakhir ke `leaderboardHistory` (histori mingguan).
async function checkLeaderboardWeekRollover() {
  if (!db) return;
  const { weekStart } = getWeekRangeWIB();
  const settingsDoc = await db.collection('settings').findOne({ _id: 'leaderboardWeek' });
  const storedWeekStart = settingsDoc?.weekStart ? new Date(settingsDoc.weekStart) : null;

  if (!storedWeekStart) {
    await db.collection('settings').updateOne(
      { _id: 'leaderboardWeek' },
      { $set: { weekStart } },
      { upsert: true }
    );
    return;
  }

  if (storedWeekStart.getTime() !== weekStart.getTime()) {
    // Minggu sudah berganti — snapshot leaderboard minggu sebelumnya.
    const prevWeekEnd = weekStart;
    const prevWeekStart = storedWeekStart;
    const snapshot = await computeWeeklyLeaderboard(5, { weekStart: prevWeekStart, weekEnd: prevWeekEnd });
    if (snapshot.entries.length > 0) {
      await db.collection('leaderboardHistory').insertOne({
        weekStart: prevWeekStart,
        weekEnd: prevWeekEnd,
        entries: snapshot.entries,
        createdAt: new Date()
      });
    }
    await db.collection('settings').updateOne(
      { _id: 'leaderboardWeek' },
      { $set: { weekStart } },
      { upsert: true }
    );
  }
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
      category: g.category || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar kategori game (Action/Sport/Puzzle/dst) — dipakai app client buat
// render tombol filter kategori di halaman Dashboard secara dinamis (bukan
// hardcode), jadi kalau admin nambah/hapus kategori langsung kebawa otomatis.
app.get('/api/categories', requireUser, async (req, res) => {
  try {
    const categories = await db.collection('categories').find({}).sort({ order: 1, name: 1 }).toArray();
    res.json(categories.map(c => ({ _id: c._id, name: c.name, slug: c.slug })));
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

    // Cek & konsumsi limit download harian (kategori Game) — public/gold dibatasi,
    // platinum/admin unlimited (lihat DOWNLOAD_LIMITS).
    const quota = await consumeDownloadQuota(req.user, 'game');
    if (!quota.ok) {
      return res.status(429).json({ error: quota.message });
    }

    const rawUrl = game.manifestUrl || game.zipUrl || null;
    if (!rawUrl) {
      return res.status(404).json({ error: 'File download untuk game ini belum diatur admin. Hubungi admin.' });
    }

    res.json({
      streamPath: `/api/games/${req.params.id}/stream`, // client download lewat sini (proxy server)
      appId:      game.appId || null,
      steamAppId: game.appId || null,
      name:       game.name,
      downloadQuota: quota
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

    let user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan.' });
    user = await applyExpiryIfNeeded(user);

    const myLevel   = ROLE_LEVEL[user.role] ?? 0;
    const gameLevel = ROLE_LEVEL[game.role] ?? 0;
    if (myLevel < gameLevel) return res.status(403).json({ error: `Game ini membutuhkan paket ${game.role}.` });

    const rawUrl = game.manifestUrl || game.zipUrl || null;
    if (!rawUrl) return res.status(404).json({ error: 'File download belum diatur admin.' });

    // Provider eksplisit (game baru) diprioritaskan; fallback ke tebak dari isi URL
    // buat game lama yang belum punya field `provider`.
    let isHubcap = game.provider === 'hubcap' || (!game.provider && (rawUrl.includes('hubcapmanifest.com') || rawUrl.includes('hubcap')));
    let isRyu = game.provider === 'ryu' || (!game.provider && !isHubcap && /ryuu?\.lol/i.test(rawUrl) && rawUrl.includes('/api/download/'));

    // Auto-fallback antar provider: kalau provider utama game ini lagi TIDAK punya
    // API key aktif sama sekali (mis. HubCap kehabisan kuota semua key-nya), dan
    // provider yang satunya PUNYA key aktif, otomatis pakai provider itu — asal
    // game-nya punya App ID (kedua provider sama-sama diakses lewat App ID Steam),
    // supaya HubCap habis/Ryu habis tidak langsung bikin download gagal total.
    if (game.appId) {
      if (isHubcap && !(await hubcapKeyManager.hasActiveKey()) && (await ryuKeyManager.hasActiveKey())) {
        isHubcap = false; isRyu = true;
        logActivity({
          type: 'ryu_auto_rotation', status: 'warning',
          description: `Fallback otomatis: game "${game.name}" biasanya lewat HubCap, tapi HubCap tidak ada key aktif — dialihkan ke Ryu API.`,
          meta: { gameId: String(game._id), appId: game.appId }
        }).catch(() => {});
      } else if (isRyu && !(await ryuKeyManager.hasActiveKey()) && (await hubcapKeyManager.hasActiveKey())) {
        isRyu = false; isHubcap = true;
        logActivity({
          type: 'hubcap_auto_rotation', status: 'warning',
          description: `Fallback otomatis: game "${game.name}" biasanya lewat Ryu API, tapi Ryu tidak ada key aktif — dialihkan ke HubCap.`,
          meta: { gameId: String(game._id), appId: game.appId }
        }).catch(() => {});
      }
    }

    if (isHubcap) {
      if (!game.appId) return res.status(400).json({ error: 'App ID game ini belum diisi admin — tidak bisa ambil manifest dari HubCap.' });
      return await streamHubcapManifest(game.appId, res, game.name);
    }
    if (isRyu) {
      if (!game.appId) return res.status(400).json({ error: 'App ID game ini belum diisi admin — tidak bisa ambil file dari Ryu API.' });
      return await streamRyuManifest(game.appId, res, game.name);
    }

    // URL non-hubcap/non-ryu (misal link GitHub Release) — redirect langsung, tanpa proxy
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

    // Cek & konsumsi limit download harian (kategori Bypass) — public/gold dibatasi,
    // platinum/admin unlimited (lihat DOWNLOAD_LIMITS).
    const quota = await consumeDownloadQuota(req.user, 'bypass');
    if (!quota.ok) {
      return res.status(429).json({ error: quota.message });
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
        downloadQuota: quota
      });
    }

    // Link non-Ryuu (GitHub Release, Google Drive, CDN lain) — tetap seperti sebelumnya,
    // return langsung URL-nya ke client.
    res.json({
      directUrl:  url,
      name:       bypass.name,
      steamAppId: bypass.steamAppId || bypass.appId || null,
      downloadQuota: quota
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

    const quota = await consumeDownloadQuota(req.user, 'bypass');
    if (!quota.ok) {
      return res.status(429).json({ error: quota.message });
    }

    // Kembalikan appId ke client — dipakai untuk findGameFolderByAppId
    // (cari folder game di steamapps sebagai target extract).
    // Stream tetap dari link manual admin (bukan HubCap).
    res.json({
      streamPath: `/api/bypasses/${req.params.id}/stream`,
      steamAppId: bypass.steamAppId || bypass.appId || null,
      appId:      bypass.appId      || bypass.steamAppId || null,
      name:       bypass.name,
      downloadQuota: quota
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

    let user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan.' });
    user = await applyExpiryIfNeeded(user);

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
// APP — BANNER CAROUSEL (halaman utama)
// Data 100% dari DB (koleksi `banners`), dikelola dari Admin Web. Endpoint ini
// cuma mengembalikan banner yang isActive=true DAN sedang dalam masa aktifnya
// (startAt/endAt), diurutkan sesuai `order` yang diatur admin.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/banners', requireUser, async (req, res) => {
  try {
    const now = new Date();
    const banners = await db.collection('banners').find({
      isActive: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] }
      ]
    }).sort({ order: 1, createdAt: 1 }).toArray();
    res.json(banners);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — TOP INSTALLER MINGGUAN (leaderboard)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/leaderboard', requireUser, async (req, res) => {
  try {
    const data = await computeWeeklyLeaderboard(5);
    res.json(data);
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
    const { itemType, itemId, extractedFiles, steamPath, folderPath, itemName: fallbackName, itemImage: fallbackImage } = req.body;
    if (!['game', 'bypass'].includes(itemType)) return res.status(400).json({ error: 'itemType harus game/bypass.' });
    if (!ObjectId.isValid(itemId)) return res.status(400).json({ error: 'itemId tidak valid.' });

    const collectionName = itemType === 'game' ? 'games' : 'bypasses';
    const item = await db.collection(collectionName).findOne({ _id: new ObjectId(itemId) });
    // BUG FIX: SEBELUMNYA kalau item ini sudah keburu dihapus/diedit admin di antara waktu user
    // klik install & proses inject/extract-nya selesai di PC user, route ini langsung 404 dan
    // BATAL MENYIMPAN histori sama sekali — padahal instalasinya sendiri sudah SUKSES di PC user.
    // Ini salah satu penyebab utama laporan "histori kadang hilang". Sekarang: kalau item masih
    // ada, tetap pakai data itemnya (paling akurat/terbaru); kalau sudah gak ada, fallback ke
    // nama & gambar yang sudah dikirim client sejak awal proses install, histori tetap tersimpan.
    if (!item && !fallbackName) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    const insertResult = await db.collection('history').insertOne({
      userId: req.user.discordId,
      username: req.user.username,
      itemType,
      itemId,
      itemName: item?.name || fallbackName || 'Item tidak dikenal',
      itemImage: item?.imageUrl || fallbackImage || null,
      // BUG FIX: dulu field ini (walau sudah dikirim client sejak awal) tidak pernah
      // disimpan, jadi tombol Uninstall di halaman Histori tidak punya cara untuk tahu
      // file apa saja & di folder mana yang harus dihapus di PC user — cuma bisa hapus
      // catatan histori-nya doang, file game/bypass yang sebenarnya tetap ketinggalan.
      extractedFiles: Array.isArray(extractedFiles) ? extractedFiles.filter(f => typeof f === 'string') : [],
      steamPath: itemType === 'game' ? (steamPath || null) : null,
      folderPath: itemType === 'bypass' ? (folderPath || null) : null,
      // Role user PAS install ini terjadi — dipakai fitur Auto Remove Installed Premium
      // Content: kalau nanti masa aktif Gold/Platinum user ini habis, HANYA item yang
      // installedViaRole-nya 'gold'/'platinum' yang otomatis dihapus (item yang diinstal
      // waktu masih Public/Admin tidak ikut kehapus).
      installedViaRole: req.user.role,
      createdAt: new Date()
    });

    const itemNameResolved = item?.name || fallbackName || 'Item';
    const itemImageResolved = item?.imageUrl || fallbackImage || null;

    logActivity({
      type: 'install',
      username: req.user.username,
      discordId: req.user.discordId,
      role: req.user.role,
      status: 'success',
      ip: getReqIp(req),
      device: getReqDevice(req),
      description: `${req.user.username} meng-install ${itemType === 'game' ? 'game' : 'bypass'} "${itemNameResolved}".`,
      meta: { itemType, itemId }
    }).catch(() => {});

    // Realtime: setiap install baru langsung mengubah Top Installer Mingguan —
    // broadcast leaderboard terbaru ke semua client yang sedang online, tanpa
    // perlu refresh/restart app.
    computeWeeklyLeaderboard(5)
      .then(lb => wsBroadcastAll('leaderboard:update', lb))
      .catch(() => {});

    notifyUser(req.user.discordId, {
      type: 'download_success',
      title: 'Download Berhasil',
      message: `${itemNameResolved} (${itemType === 'game' ? 'Game' : 'Bypass'}) berhasil di-download & dipasang.`,
      fields: [
        field('👤 Username', req.user.username, true),
        field('🆔 Discord ID', req.user.discordId, true),
        field('🎮 Nama Item', itemNameResolved, true),
        field('📦 Tipe', itemType === 'game' ? 'Game' : 'Bypass', true),
        field('💾 Ukuran File', item?.sizeLabel, true),
        field('🆔 App ID', item?.appId || item?.steamAppId, true),
        field('🧾 ID Riwayat', String(insertResult.insertedId), true)
      ],
      image: itemImageResolved,
      meta: { itemType, itemId },
      dm: false, webhook: true
    }).catch(() => {});

    res.json({ success: true, _id: insertResult.insertedId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dipanggil client (main.js / app.js) sesaat sebelum logout, best-effort supaya
// event Logout User ikut tercatat di audit trail (lihat halaman Logs Admin Web).
app.post('/api/logout', requireUser, async (req, res) => {
  logActivity({
    type: 'logout',
    username: req.user.username,
    discordId: req.user.discordId,
    role: req.user.role,
    status: 'info',
    ip: getReqIp(req),
    device: getReqDevice(req),
    description: `${req.user.username} logout.`
  }).catch(() => {});
  res.json({ success: true });
});

// Dipanggil client (main.js) kalau proses download/extract/inject GAGAL di tengah jalan,
// supaya user tetap dapat notifikasi kegagalan walau tidak ada baris histori yang tercatat.
app.post('/api/downloads/failed', requireUser, async (req, res) => {
  try {
    const { itemType, itemName, itemImage, reason } = req.body;

    logActivity({
      type: 'download_failed',
      username: req.user.username,
      discordId: req.user.discordId,
      role: req.user.role,
      status: 'error',
      ip: getReqIp(req),
      device: getReqDevice(req),
      description: `Download "${itemName || 'item'}" (${itemType === 'game' ? 'Game' : 'Bypass'}) gagal untuk ${req.user.username}.`,
      meta: { itemType, itemName, reason }
    }).catch(() => {});

    notifyUser(req.user.discordId, {
      type: 'download_failed',
      title: 'Download Gagal',
      message: `Download ${itemName || 'item'} (${itemType === 'game' ? 'Game' : 'Bypass'}) gagal.`,
      fields: [
        field('👤 Username', req.user.username, true),
        field('🆔 Discord ID', req.user.discordId, true),
        field('🎮 Nama Item', itemName, true),
        field('📦 Tipe', itemType === 'game' ? 'Game' : (itemType === 'bypass' ? 'Bypass' : undefined), true),
        field('📝 Pesan Tambahan', reason, false)
      ],
      image: itemImage || undefined,
      dm: false, webhook: true
    }).catch(() => {});
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
  const newToken = res.getHeader('X-New-Token');
  const resp = { ...publicUser(req.user) };
  if (newToken) resp.newToken = newToken; // client simpan token baru kalau ada
  res.json(resp);
});

// ── Endpoint polling cepat KHUSUS role check — jauh lebih ringan dari /api/me
// (tidak load semua field user, tidak perlu token refresh). Dipakai client setiap
// 3 detik untuk deteksi perubahan paket secara realtime. Kalau role sama, cukup
// return { changed: false } tanpa data tambahan supaya network overhead minimal.
app.get('/api/me/role-check', requireUser, (req, res) => {
  res.json({
    role:          req.user.role,
    roleUpdatedAt: req.user.roleUpdatedAt || null
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DEVICE LOCK — dipanggil app SEKALI tiap sesi login (baik login Discord baru
// MAUPUN "Masuk Sekarang" pakai token tersimpan), SEBELUM masuk ke dashboard.
// App mengumpulkan info hardware lewat electronAPI.getDeviceInfo() (IPC ke main
// process), lalu kirim ke sini. Server yang menghitung fingerprint & mencocokkan
// dengan perangkat yang sudah terikat ke akun ini (lihat deviceLock.js).
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/device/verify', requireUser, async (req, res) => {
  try {
    const deviceInfo = req.body || {};
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || null;

    const result = await deviceLock.verifyOrRegister(req.user.discordId, req.user.username, deviceInfo, { ip });

    if (!result.allowed) {
      // Notif ke channel admin (opsional, default OFF) — best-effort, tidak pernah
      // menghambat proses tolak-login user.
      webhookManager.sendCategoryWebhook('device_security', {
        embed: buildEmbed({
          status: 'error',
          title: 'Login Ditolak — Perangkat Berbeda',
          description: `**${req.user.username}** mencoba login dari perangkat yang TIDAK terikat ke akunnya.`,
          fields: [
            field('👤 Username', req.user.username, true),
            field('🆔 Discord ID', req.user.discordId, true),
            field('🖥️ Nama PC (percobaan)', deviceInfo.pcName, true),
            field('🌐 IP', ip, true)
          ],
          appName: APP_NAME,
          footerNote: 'Keamanan Perangkat'
        })
      }).catch(() => {});
      return res.status(403).json({ error: result.reason, deviceLocked: true });
    }

    // Perangkat baru terdaftar pertama kali — kabari channel keamanan (opsional).
    if (result.status === 'registered') {
      webhookManager.sendCategoryWebhook('device_security', {
        embed: buildEmbed({
          status: 'success',
          title: 'Perangkat Baru Terdaftar',
          description: `Perangkat utama untuk **${req.user.username}** berhasil didaftarkan.`,
          fields: [
            field('👤 Username', req.user.username, true),
            field('🆔 Discord ID', req.user.discordId, true),
            field('🖥️ Nama PC', deviceInfo.pcName, true)
          ],
          appName: APP_NAME,
          footerNote: 'Keamanan Perangkat'
        })
      }).catch(() => {});
    }

    res.json({ allowed: true, status: result.status });
  } catch (e) {
    // Best-effort: kalau device lock gagal karena error tak terduga, JANGAN sampai
    // memblokir user yang sah masuk app — cukup log & izinkan lanjut.
    console.warn('[DeviceLock] Error saat verifikasi, fail-open:', e.message);
    res.json({ allowed: true, status: 'error_fail_open' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// NOTIFIKASI — endpoint user (in-app)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', requireUser, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = await db.collection('notifications')
      .find({ discordId: req.user.discordId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    const unread = await db.collection('notifications').countDocuments({ discordId: req.user.discordId, read: false });
    res.json({ items: rows, unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/notifications/:id/read', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    await db.collection('notifications').updateOne(
      { _id: new ObjectId(req.params.id), discordId: req.user.discordId },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/notifications/read-all', requireUser, async (req, res) => {
  try {
    await db.collection('notifications').updateMany(
      { discordId: req.user.discordId, read: false },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — LOGIN
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    logActivity({
      type: 'admin_login',
      username: 'Administrator',
      admin: 'Administrator',
      status: 'error',
      ip: getReqIp(req),
      description: `Percobaan login admin (password) gagal.`
    }).catch(() => {});
    return res.status(401).json({ error: 'Password admin salah.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  logActivity({
    type: 'admin_login',
    username: 'Administrator',
    admin: 'Administrator',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin login ke Admin Web (password).`
  }).catch(() => {});
  res.json({ token });
});

// Dipanggil admin.js sesaat sebelum logout — best-effort, catat ke audit trail.
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const name = req.admin?.via === 'discord' ? (req.admin.username || 'Admin') : 'Administrator';
  logActivity({
    type: 'admin_logout',
    username: name,
    admin: name,
    discordId: req.admin?.discordId || null,
    status: 'info',
    ip: getReqIp(req),
    description: `${name} logout dari Admin Web.`
  }).catch(() => {});
  res.json({ success: true });
});

// ── Verifikasi token admin — dipanggil admin.js pas halaman di-refresh, supaya
// tahu pasti token di localStorage MASIH valid sebelum nampilin dashboard.
// Tanpa ini, token yang sudah expired/invalid tetap nampilin shell tapi semua
// datanya gagal load (401 di semua request) — kelihatan kayak "stuck".
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ success: true, admin: req.admin || { via: 'password' } });
});

// Dipanggil admin.js setelah login lewat Discord OAuth (alur sama seperti login app biasa,
// lihat /auth/poll) — cuma buat kasih pesan yang jelas kalau ternyata akun Discord itu BUKAN
// admin, alih-alih baru ketahuan belakangan pas request lain kena 403 generik.
app.get('/api/admin/verify-discord-token', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token tidak ada.' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.discordId) return res.status(400).json({ error: 'Bukan token akun Discord.' });
    if (!db) return res.status(503).json({ error: 'Database belum siap, coba lagi.' });
    const user = await db.collection('users').findOne({ discordId: payload.discordId });
    if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (user.role !== 'admin') {
      return res.status(403).json({
        error: `Akun Discord "${user.username}" ini belum punya role Admin.`,
        role: user.role
      });
    }
    logActivity({
      type: 'admin_login',
      username: user.username,
      discordId: user.discordId,
      role: user.role,
      admin: user.username,
      status: 'success',
      ip: getReqIp(req),
      description: `Admin login ke Admin Web (Discord) sebagai ${user.username}.`
    }).catch(() => {});
    res.json({ success: true, admin: { via: 'discord', discordId: user.discordId, username: user.username, avatarUrl: user.avatarUrl } });
  } catch (e) {
    res.status(401).json({ error: 'Token tidak valid.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — DASHBOARD (statistik realtime)
// ══════════════════════════════════════════════════════════════════════════
// Jakarta (WIB) selalu UTC+7 tanpa DST, jadi batas hari/minggu/bulan bisa
// dihitung langsung tanpa library timezone tambahan.
function jakartaMidnightUTC(daysAgo = 0) {
  const JAK_OFFSET_MS = 7 * 60 * 60 * 1000;
  const jakartaMs = Date.now() + JAK_OFFSET_MS;
  const d = new Date(jakartaMs);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return new Date(d.getTime() - JAK_OFFSET_MS);
}
function jakartaMonthStartUTC() {
  const JAK_OFFSET_MS = 7 * 60 * 60 * 1000;
  const d = new Date(Date.now() + JAK_OFFSET_MS);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - JAK_OFFSET_MS);
}

// Cache singkat (4 detik) — dashboard bisa dibuka di beberapa tab admin
// sekaligus & di-refresh tiap kali ada event WebSocket masuk; cache ini
// mencegah query berat yang sama ditembak berkali-kali dalam rentang waktu
// yang sangat singkat, tanpa membuat datanya jadi basi.
let _dashboardCache = { data: null, at: 0 };
const DASHBOARD_CACHE_MS = 4000;

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database belum siap, coba lagi sebentar.' });

    if (_dashboardCache.data && (Date.now() - _dashboardCache.at) < DASHBOARD_CACHE_MS) {
      return res.json({ ..._dashboardCache.data, admin: await buildAdminInfo(req.admin) });
    }

    const todayStart   = jakartaMidnightUTC(0);
    const weekStart    = jakartaMidnightUTC(6);   // termasuk hari ini = 7 hari
    const prevWeekStart = jakartaMidnightUTC(13);
    const monthStart   = jakartaMonthStartUTC();

    const [
      totalUsers, usersToday, usersWeek,
      roleCountsAgg,
      totalGames, gamesActive,
      totalBypasses, bypassesActive,
      gamesWithBypassIds,
      installsToday, installsWeek, installsMonth, installsTotal,
      loginsToday, loginsWeek, loginsPrevWeek,
      loginTrendAgg,
      recentActivity
    ] = await Promise.all([
      db.collection('users').countDocuments({}),
      db.collection('users').countDocuments({ createdAt: { $gte: todayStart } }),
      db.collection('users').countDocuments({ createdAt: { $gte: weekStart } }),
      db.collection('users').aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
      db.collection('games').countDocuments({}),
      db.collection('games').countDocuments({ isOnline: { $ne: false } }),
      db.collection('bypasses').countDocuments({}),
      db.collection('bypasses').countDocuments({ isOnline: { $ne: false } }),
      db.collection('bypasses').distinct('gameId', { gameId: { $ne: null } }),
      db.collection('history').countDocuments({ createdAt: { $gte: todayStart } }),
      db.collection('history').countDocuments({ createdAt: { $gte: weekStart } }),
      db.collection('history').countDocuments({ createdAt: { $gte: monthStart } }),
      db.collection('history').countDocuments({}),
      db.collection('activityLogs').countDocuments({ type: 'login', createdAt: { $gte: todayStart } }),
      db.collection('activityLogs').countDocuments({ type: 'login', createdAt: { $gte: weekStart } }),
      db.collection('activityLogs').countDocuments({ type: 'login', createdAt: { $gte: prevWeekStart, $lt: weekStart } }),
      db.collection('activityLogs').aggregate([
        { $match: { type: 'login', createdAt: { $gte: weekStart } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Jakarta' } },
            count: { $sum: 1 }
          } },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection('activityLogs').find({}).sort({ createdAt: -1 }).limit(20).toArray()
    ]);

    const roleCounts = { public: 0, gold: 0, platinum: 0, admin: 0 };
    for (const r of roleCountsAgg) { if (r._id && roleCounts.hasOwnProperty(r._id)) roleCounts[r._id] = r.count; }
    const premiumTotal = roleCounts.gold + roleCounts.platinum;
    const pct = (n) => totalUsers > 0 ? Math.round((n / totalUsers) * 1000) / 10 : 0;

    const data = {
      // Total Users
      totalUsers, usersToday, usersWeek,
      loginsToday, loginsWeek, loginsPrevWeek,
      loginTrend: loginTrendAgg,

      // Total Game
      totalGames, gamesActive, gamesInactive: totalGames - gamesActive,
      totalBypasses, bypassesActive, bypassesInactive: totalBypasses - bypassesActive,
      gamesWithBypass: gamesWithBypassIds.length,

      // Gold Aktif
      totalPublic: roleCounts.public, activeGold: roleCounts.gold, activePlatinum: roleCounts.platinum,
      pctPublic: pct(roleCounts.public), pctGold: pct(roleCounts.gold), pctPlatinum: pct(roleCounts.platinum),
      premiumTotal,

      // Total Install
      installsToday, installsWeek, installsMonth, totalInstalls: installsTotal,

      // Activity feed
      recentActivity
    };

    _dashboardCache = { data, at: Date.now() };
    res.json({ ...data, admin: await buildAdminInfo(req.admin) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Info admin yang lagi login, dipakai panel "Selamat Datang" (nama, role, waktu
// login terakhir). Password-based admin tidak terikat akun manapun jadi cuma
// ditampilkan sebagai "Administrator" generik.
async function buildAdminInfo(admin) {
  if (!admin) return { username: 'Administrator', role: 'Super Admin', lastLoginAt: null };
  if (admin.via === 'password') return { username: 'Administrator', role: 'Super Admin', lastLoginAt: null };
  try {
    const user = await db.collection('users').findOne({ discordId: admin.discordId });
    return {
      username: admin.username || 'Admin',
      role: 'Admin',
      lastLoginAt: user?.lastLoginAt || null,
      avatarUrl: admin.avatarUrl || null
    };
  } catch {
    return { username: admin.username || 'Admin', role: 'Admin', lastLoginAt: null };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — GAME (CRUD)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  const games = await db.collection('games').find({}).sort({ createdAt: -1 }).toArray();
  res.json(games);
});

app.post('/api/admin/games', requireAdmin, async (req, res) => {
  const { name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline, category, provider } = req.body;
  if (!name || !ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  // Kategori WAJIB — setiap game minimal harus punya satu kategori supaya
  // filter kategori di Dashboard selalu punya data yang valid buat ditampilkan.
  const categorySlug = String(category || '').trim();
  if (!categorySlug) return res.status(400).json({ error: 'Kategori wajib dipilih.' });
  const categoryDoc = await db.collection('categories').findOne({ slug: categorySlug });
  if (!categoryDoc) return res.status(400).json({ error: 'Kategori tidak valid.' });
  const doc = {
    name,
    description: description || '',
    imageUrl: imageUrl || null,
    role,
    category: categorySlug,
    appId: appId ? String(appId) : null,
    storeUrl: storeUrl || null,
    manifestUrl: manifestUrl || null,
    // Provider file manifest/download untuk game ini: 'hubcap' | 'ryu' | null (link manual).
    // Dipakai /api/games/:id/stream buat menentukan proxy mana yang dipakai — lebih akurat
    // daripada nebak dari isi URL saja (tetap ada fallback substring buat data lama).
    provider: (provider === 'ryu' || provider === 'hubcap') ? provider : null,
    sizeBytes: sizeBytes || null,
    sizeLabel: sizeLabel || null,
    // Tipe game: Online (bisa multiplayer online) / Offline (singleplayer murni).
    // Default TRUE (online) kalau admin tidak eksplisit set false, biar konsisten
    // dengan behaviour lama sebelum field ini ada di form (games lama semua online).
    isOnline: isOnline === false ? false : true,
    createdAt: new Date()
  };
  const result = await db.collection('games').insertOne(doc);

  logActivity({
    type: 'admin_add_game',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin menambahkan game baru "${doc.name}".`,
    meta: { gameId: result.insertedId, name: doc.name }
  }).catch(() => {});

  res.json({ ...doc, _id: result.insertedId });
});

app.put('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const { name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline, category, provider } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (appId !== undefined) update.appId = appId ? String(appId) : null;
  if (storeUrl !== undefined) update.storeUrl = storeUrl || null;
  if (manifestUrl !== undefined) update.manifestUrl = manifestUrl || null;
  if (provider !== undefined) update.provider = (provider === 'ryu' || provider === 'hubcap') ? provider : null;
  if (sizeBytes !== undefined) update.sizeBytes = sizeBytes || null;
  if (sizeLabel !== undefined) update.sizeLabel = sizeLabel || null;
  if (isOnline !== undefined) update.isOnline = isOnline === false ? false : true;
  if (role !== undefined) {
    if (!ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Role tidak valid.' });
    update.role = role;
  }
  if (category !== undefined) {
    // Kategori WAJIB — tolak kalau admin coba kosongkan kategori game yang sudah ada.
    const categorySlug = String(category || '').trim();
    if (!categorySlug) return res.status(400).json({ error: 'Kategori wajib dipilih.' });
    const categoryDoc = await db.collection('categories').findOne({ slug: categorySlug });
    if (!categoryDoc) return res.status(400).json({ error: 'Kategori tidak valid.' });
    update.category = categorySlug;
  }
  await db.collection('games').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });

  logActivity({
    type: 'admin_edit_game',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah data game "${update.name || req.params.id}".`,
    meta: { gameId: req.params.id, update }
  }).catch(() => {});

  res.json({ success: true });
});

app.delete('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const game = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
  await db.collection('games').deleteOne({ _id: new ObjectId(req.params.id) });

  logActivity({
    type: 'admin_delete_game',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'warning',
    ip: getReqIp(req),
    description: `Admin menghapus game "${game?.name || req.params.id}".`,
    meta: { gameId: req.params.id, name: game?.name }
  }).catch(() => {});

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN: KATEGORI GAME — dikelola dari halaman "Kelola Game", dipakai buat
// isi pilihan kategori pas tambah/edit game, dan buat render tombol filter
// kategori (Action/Sport/Puzzle/Mystery/dst) di halaman Dashboard app client.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  const categories = await db.collection('categories').find({}).sort({ order: 1, name: 1 }).toArray();
  res.json(categories);
});

app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi.' });
  const slug = slugify(name);
  if (!slug) return res.status(400).json({ error: 'Nama kategori tidak valid.' });
  const existing = await db.collection('categories').findOne({ slug });
  if (existing) return res.status(400).json({ error: 'Kategori dengan nama tersebut sudah ada.' });

  const count = await db.collection('categories').countDocuments({});
  const doc = { name, slug, order: count, createdAt: new Date() };
  const result = await db.collection('categories').insertOne(doc);

  logActivity({
    type: 'admin_add_category',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin menambahkan kategori baru "${name}".`,
    meta: { categoryId: result.insertedId, name }
  }).catch(() => {});

  res.json({ ...doc, _id: result.insertedId });
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const category = await db.collection('categories').findOne({ _id: new ObjectId(req.params.id) });
  if (!category) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });

  // Jangan izinkan hapus kategori yang masih dipakai game — supaya tidak ada
  // game yang "kehilangan" kategorinya (setiap game wajib minimal 1 kategori).
  const inUse = await db.collection('games').countDocuments({ category: category.slug });
  if (inUse > 0) {
    return res.status(400).json({ error: `Kategori masih dipakai oleh ${inUse} game. Ubah kategori game tersebut dulu sebelum menghapus.` });
  }

  await db.collection('categories').deleteOne({ _id: new ObjectId(req.params.id) });

  logActivity({
    type: 'admin_delete_category',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'warning',
    ip: getReqIp(req),
    description: `Admin menghapus kategori "${category.name}".`,
    meta: { categoryId: req.params.id, name: category.name }
  }).catch(() => {});

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

  logActivity({
    type: 'admin_add_bypass',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin menambahkan bypass baru "${doc.name}".`,
    meta: { bypassId: result.insertedId, name: doc.name }
  }).catch(() => {});

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

  logActivity({
    type: 'admin_edit_bypass',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah data bypass "${update.name || req.params.id}".`,
    meta: { bypassId: req.params.id, update }
  }).catch(() => {});

  res.json({ success: true });
});

app.delete('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
  await db.collection('bypasses').deleteOne({ _id: new ObjectId(req.params.id) });

  logActivity({
    type: 'admin_delete_bypass',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'warning',
    ip: getReqIp(req),
    description: `Admin menghapus bypass "${bypass?.name || req.params.id}".`,
    meta: { bypassId: req.params.id, name: bypass?.name }
  }).catch(() => {});

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — BANNER CAROUSEL (CRUD + reorder + Image/Code banner)
// ══════════════════════════════════════════════════════════════════════════
// Dua tipe banner didukung (field `bannerType`):
//   - 'image' (default, backward-compatible dengan banner lama yang belum
//     punya field ini sama sekali) — gambar (upload base64 ATAU url eksternal),
//     fallback ke gradient+icon kalau tidak ada gambar sama sekali.
//   - 'code'  — HTML+CSS (+JS opsional) custom, dirender App di dalam
//     <iframe sandbox> (lihat app/app.js) supaya TIDAK bisa mengakses window
//     utama app (token login, localStorage, dst) — App yang menentukan
//     sandbox-nya, di sini tugas server cuma SANITASI & VALIDASI sebelum
//     disimpan, supaya apa yang tersimpan di DB sudah bersih dari awal.
const BANNER_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB — cukup buat banner, jaga ukuran dokumen Mongo
const BANNER_MAX_CODE_LEN = 60000; // ~60rb karakter per field (html/css/js) — banner, bukan aplikasi penuh

// Allowlist tag/atribut buat HTML banner. Sengaja TIDAK mengizinkan <script>,
// <iframe>, <object>/<embed>, <base>, <meta>, ataupun atribut event handler
// (onclick dkk) — kalau admin butuh interaktivitas, itu tempatnya di kolom
// JS terpisah (dijalankan di dalam sandbox yang sama, jadi tidak kehilangan
// kemampuan apa-apa, cuma lebih rapi & gampang di-audit).
const BANNER_HTML_SANITIZE_OPTIONS = {
  allowedTags: [
    'div','span','p','a','img','button','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','strong','em','b','i','u','br','small','sup','sub',
    'svg','path','circle','rect','line','polygon','g','defs','linearGradient','stop'
  ],
  allowedAttributes: {
    '*': ['class','id','style','title','viewBox','xmlns','width','height','fill','stroke','stroke-width','d','cx','cy','r','x','y','x1','y1','x2','y2','points','offset','stop-color'],
    a: ['href','target','rel'],
    img: ['src','alt','loading'],
    button: ['type']
  },
  allowedSchemes: ['http', 'https', 'data'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Buang semua inline <style> block di dalam HTML — CSS wajib lewat kolom CSS
  // terpisah, supaya satu-satunya sumber style tetap jelas & mudah divalidasi.
  exclusiveFilter: (frame) => frame.tag === 'style' || frame.tag === 'script'
};

function sanitizeBannerHtml(html) {
  if (!html) return '';
  const trimmed = String(html).slice(0, BANNER_MAX_CODE_LEN);
  return sanitizeHtml(trimmed, BANNER_HTML_SANITIZE_OPTIONS);
}

// CSS & JS banner dijalankan/diterapkan di DALAM <iframe sandbox> milik App
// (lihat buildBannerSandboxDoc di app/app.js), jadi TIDAK PERNAH bisa
// menyentuh halaman utama App sama sekali — itu proteksi utamanya. Di sisi
// server kita cuma batasi panjang & buang pola paling jelas berbahaya
// (@import buat cegah CSS narik resource luar, `expression()` peninggalan
// trik lawas IE) sebagai lapisan tambahan, bukan yang utama.
function sanitizeBannerCss(css) {
  if (!css) return '';
  let out = String(css).slice(0, BANNER_MAX_CODE_LEN);
  out = out.replace(/@import[^;]*;?/gi, '');
  out = out.replace(/expression\s*\(/gi, 'blocked(');
  return out;
}
function sanitizeBannerJs(js) {
  if (!js) return '';
  return String(js).slice(0, BANNER_MAX_CODE_LEN);
}

// ══════════════════════════════════════════════════════════════════════════
// SEED — 3 Banner Default (Code Banner)
// Dipakai sekali di connectDB() KALAU koleksi `banners` masih kosong (baru
// deploy / DB baru). Style-nya nurut tema asli App (lihat app/style.css:
// --accent #7c5cff, --accent-2 #4facfe, background ungu-pink, radius-lg 22px,
// font Poppins buat judul) + pola visual "badge pill → judul 2 baris → deskripsi
// → CTA pill → ikon dekoratif dalam ring + titik-titik" seperti referensi.
// ──────────────────────────────────────────────────────────────────────────
// Builder generik biar HTML/CSS 3 banner konsisten & gampang dirawat — tinggal
// ganti parameter warna/teks/icon per banner, bukan copy-paste seluruh style.
function buildPromoBannerCode({
  badgeIcon, badgeText, badgeColor,
  titleLine1, titleLine2, desc, ctaText,
  accentFrom, accentTo, ringEmoji, ringBadgeEmoji, glow1, glow2
}) {
  const html = `<div class="promo-banner">
  <div class="promo-dots">
    <span class="pd" style="top:14%;right:18%;"></span>
    <span class="pd" style="top:28%;right:9%;"></span>
    <span class="pd" style="top:8%;right:32%;"></span>
    <span class="pd" style="top:42%;right:24%;"></span>
  </div>
  <div class="promo-blob promo-blob-1"></div>
  <div class="promo-blob promo-blob-2"></div>

  <div class="promo-content">
    <span class="promo-badge">${badgeIcon} ${badgeText}</span>
    <h1 class="promo-title">${titleLine1}<br><span class="promo-title-accent">${titleLine2}</span></h1>
    <p class="promo-desc">${desc}</p>
    <button class="promo-cta" type="button">${ctaText}</button>
  </div>

  <div class="promo-ring">
    <span class="promo-ring-icon">${ringEmoji}</span>
    <span class="promo-ring-badge">${ringBadgeEmoji}</span>
  </div>
</div>`;

  const css = `.promo-banner{
  position:relative; width:100%; height:100%;
  display:flex; align-items:center; padding:0 42px;
  overflow:hidden;
  background:
    radial-gradient(circle at 82% 25%, ${glow1} 0%, transparent 55%),
    radial-gradient(circle at 12% 90%, ${glow2} 0%, transparent 50%),
    linear-gradient(135deg, #241a3d 0%, #2b1c4e 45%, #3a2166 100%);
}
.promo-dots{ position:absolute; inset:0; z-index:1; pointer-events:none; }
.pd{ position:absolute; width:4px; height:4px; border-radius:50%; background:rgba(255,255,255,.35); }
.promo-blob{ position:absolute; border-radius:50%; filter:blur(46px); opacity:.5; pointer-events:none; }
.promo-blob-1{ width:230px; height:230px; background:${accentFrom}; top:-80px; right:8%; animation:promoFloat 7s ease-in-out infinite; }
.promo-blob-2{ width:190px; height:190px; background:${accentTo}; bottom:-70px; left:6%; animation:promoFloat 8s ease-in-out infinite reverse; }
@keyframes promoFloat{
  0%,100%{ transform:translateY(0) scale(1); }
  50%{ transform:translateY(-14px) scale(1.07); }
}
.promo-content{ position:relative; z-index:2; max-width:56%; }
.promo-badge{
  display:inline-flex; align-items:center; gap:6px;
  padding:6px 14px; border-radius:999px; margin-bottom:14px;
  background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16);
  font-size:11px; font-weight:800; letter-spacing:.4px; text-transform:uppercase;
  color:${badgeColor};
}
.promo-title{
  margin:0 0 12px; font-size:32px; font-weight:800; line-height:1.18;
  color:#fff; text-shadow:0 4px 20px rgba(0,0,0,.35); letter-spacing:.2px;
}
.promo-title-accent{
  background:linear-gradient(90deg, ${accentFrom}, ${accentTo});
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.promo-desc{
  margin:0 0 20px; font-size:13px; line-height:1.65;
  color:rgba(255,255,255,.68); max-width:380px;
}
.promo-cta{
  border:none; cursor:default; padding:12px 26px; border-radius:12px;
  font-weight:800; font-size:13.5px; color:#1a1030;
  background:linear-gradient(90deg, ${accentFrom}, ${accentTo});
  box-shadow:0 10px 24px -8px ${accentFrom};
}
.promo-ring{
  position:relative; z-index:2; margin-left:auto; flex-shrink:0;
  width:120px; height:120px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  background:radial-gradient(circle, rgba(255,255,255,.09), rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.14);
  animation:promoRingFloat 4.5s ease-in-out infinite;
}
.promo-ring-icon{ font-size:46px; filter:drop-shadow(0 6px 14px rgba(0,0,0,.35)); }
.promo-ring-badge{
  position:absolute; bottom:2px; right:2px; font-size:20px;
  background:#1a1030; border-radius:50%; width:32px; height:32px;
  display:flex; align-items:center; justify-content:center;
  border:2px solid rgba(255,255,255,.15);
}
@keyframes promoRingFloat{
  0%,100%{ transform:translateY(0); }
  50%{ transform:translateY(-10px); }
}
@media (max-width:680px){
  .promo-content{ max-width:100%; }
  .promo-ring{ display:none; }
  .promo-title{ font-size:24px; }
}`;

  return { html, css };
}

// Ubah nama kategori jadi slug (lowercase, tanpa spasi/simbol) — dipakai sebagai
// value unik penyimpanan di `game.category` supaya konsisten walau nama kategori
// diketik beda kapitalisasi/spasi oleh admin.
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function seedDefaultCategoriesIfEmpty() {
  if (!db) return;
  const existing = await db.collection('categories').countDocuments({});
  if (existing > 0) return; // sudah pernah ada isinya — jangan timpa

  const defaults = ['Action', 'Sport', 'Puzzle', 'Mystery'];
  await db.collection('categories').insertMany(
    defaults.map((name, i) => ({ name, slug: slugify(name), order: i, createdAt: new Date() }))
  );
  console.log('✅ Kategori default berhasil dibuat:', defaults.join(', '));
}

async function seedDefaultBannersIfEmpty() {
  if (!db) return;
  const existing = await db.collection('banners').countDocuments({});
  if (existing > 0) return; // sudah pernah ada isinya (termasuk kalau semua sempat dihapus admin) — jangan timpa

  const banner1 = buildPromoBannerCode({
    badgeIcon: '⭐', badgeText: 'Paket Premium', badgeColor: '#ffd76a',
    titleLine1: 'GOLD &', titleLine2: 'PLATINUM',
    desc: 'Akses unlimited, role terverifikasi, dan fitur eksklusif hanya untuk member.',
    ctaText: 'Lihat Paket',
    accentFrom: '#a78bfa', accentTo: '#c084fc',
    ringEmoji: '🛡️', ringBadgeEmoji: '✅',
    glow1: 'rgba(167,139,250,.32)', glow2: 'rgba(192,132,252,.28)'
  });

  const banner2 = buildPromoBannerCode({
    badgeIcon: '🔥', badgeText: 'Update Mingguan', badgeColor: '#7dd3fc',
    titleLine1: 'GAME & BYPASS', titleLine2: 'TERBARU',
    desc: 'Koleksi terus bertambah tiap minggu — cek daftar game terbaru sebelum kehabisan slot download harianmu.',
    ctaText: 'Jelajahi Game',
    accentFrom: '#4facfe', accentTo: '#38f0e0',
    ringEmoji: '🎮', ringBadgeEmoji: '🆕',
    glow1: 'rgba(79,172,254,.30)', glow2: 'rgba(56,240,224,.24)'
  });

  const banner3 = buildPromoBannerCode({
    badgeIcon: '🔔', badgeText: 'Jangan Ketinggalan', badgeColor: '#f5a3d0',
    titleLine1: 'AKTIFKAN', titleLine2: 'NOTIFIKASI',
    desc: 'Dapat kabar realtime soal limit download, masa aktif paket, dan pengumuman penting dari admin.',
    ctaText: 'Cek Notifikasi',
    accentFrom: '#f472b6', accentTo: '#fb923c',
    ringEmoji: '🔔', ringBadgeEmoji: '✨',
    glow1: 'rgba(244,114,182,.30)', glow2: 'rgba(251,146,60,.24)'
  });

  const docsBase = [
    { title: 'Gold & Platinum', description: 'Akses unlimited, role terverifikasi, dan fitur eksklusif hanya untuk member.', b: banner1 },
    { title: 'Game & Bypass Terbaru', description: 'Koleksi terus bertambah tiap minggu.', b: banner2 },
    { title: 'Aktifkan Notifikasi', description: 'Dapat kabar realtime soal akun & paket kamu.', b: banner3 }
  ];

  const now = new Date();
  const docs = docsBase.map((d, i) => ({
    bannerType: 'code',
    title: d.title,
    subtitle: '',
    description: d.description,
    ctaText: 'Selengkapnya',
    ctaLink: '',
    gradientFrom: '#7b5cff',
    gradientTo: '#241a3d',
    icon: '',
    imageUrl: null, imageData: null,
    codeHtml: sanitizeBannerHtml(d.b.html),
    codeCss: sanitizeBannerCss(d.b.css),
    codeJs: '',
    order: i,
    isActive: true,
    startAt: null, endAt: null,
    createdAt: now, updatedAt: now
  }));

  await db.collection('banners').insertMany(docs);
  console.log(`✅ ${docs.length} banner default berhasil di-seed (koleksi 'banners' sebelumnya kosong).`);
}

// Validasi field gambar banner. Menerima SALAH SATU dari:
//   - imageData: data URI base64 hasil upload dari Admin Web (disimpan apa
//     adanya di Mongo — tanpa ketergantungan disk/storage eksternal, jadi
//     aman dipakai di hosting mana pun termasuk yang filesystem-nya ephemeral)
//   - imageUrl: link gambar eksternal biasa
// Keduanya opsional — kalau kosong dua-duanya, banner image otomatis fallback
// ke gradient+icon (banner lama yang belum pernah diisi gambar tetap jalan normal).
function validateBannerImageFields({ imageData, imageUrl }) {
  const out = { imageData: null, imageUrl: null };
  if (imageData) {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(imageData).trim());
    if (!m) throw new Error('Format gambar tidak didukung. Gunakan PNG, JPG, GIF, atau WEBP.');
    const approxBytes = Math.ceil((m[2].length * 3) / 4);
    if (approxBytes > BANNER_MAX_IMAGE_BYTES) throw new Error(`Ukuran gambar maksimal ${(BANNER_MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB.`);
    out.imageData = imageData;
  } else if (imageUrl) {
    const url = String(imageUrl).trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL gambar harus diawali http:// atau https://');
    out.imageUrl = url;
  }
  return out;
}

async function broadcastActiveBanners() {
  try {
    const now = new Date();
    const banners = await db.collection('banners').find({
      isActive: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] }
      ]
    }).sort({ order: 1, createdAt: 1 }).toArray();
    wsBroadcastAll('banners:update', banners);
  } catch (e) { /* noop */ }
}

app.get('/api/admin/banners', requireAdmin, async (req, res) => {
  const banners = await db.collection('banners').find({}).sort({ order: 1, createdAt: 1 }).toArray();
  res.json(banners);
});

app.post('/api/admin/banners', requireAdmin, async (req, res) => {
  try {
    const {
      title, subtitle, description, ctaText, ctaLink, gradientFrom, gradientTo, icon,
      isActive, startAt, endAt, bannerType, imageUrl, imageData, codeHtml, codeCss, codeJs
    } = req.body;
    if (!title) return res.status(400).json({ error: 'Judul banner wajib diisi.' });

    const type = bannerType === 'code' ? 'code' : 'image';
    if (type === 'code' && !codeHtml?.trim()) {
      return res.status(400).json({ error: 'HTML wajib diisi untuk Code Banner.' });
    }

    const lastBanner = await db.collection('banners').find({}).sort({ order: -1 }).limit(1).toArray();
    const nextOrder = lastBanner.length ? (lastBanner[0].order || 0) + 1 : 0;

    const doc = {
      bannerType: type,
      title,
      subtitle: subtitle || '',
      description: description || '',
      ctaText: ctaText || 'Selengkapnya',
      ctaLink: ctaLink || '',
      gradientFrom: gradientFrom || '#7b5cff',
      gradientTo: gradientTo || '#241a3d',
      icon: icon || '',
      imageUrl: null, imageData: null,
      codeHtml: null, codeCss: null, codeJs: null,
      order: nextOrder,
      isActive: isActive === false ? false : true,
      startAt: startAt ? new Date(startAt) : null,
      endAt: endAt ? new Date(endAt) : null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (type === 'image') {
      Object.assign(doc, validateBannerImageFields({ imageData, imageUrl }));
    } else {
      doc.codeHtml = sanitizeBannerHtml(codeHtml);
      doc.codeCss = sanitizeBannerCss(codeCss);
      doc.codeJs = sanitizeBannerJs(codeJs);
    }

    const result = await db.collection('banners').insertOne(doc);

    logActivity({
      type: 'admin_add_banner',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin menambahkan banner ${type === 'code' ? 'Code' : 'Image'} baru "${doc.title}".`,
      meta: { bannerId: result.insertedId, title: doc.title, bannerType: type }
    }).catch(() => {});

    broadcastActiveBanners();
    res.json({ ...doc, _id: result.insertedId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/banners/reorder', requireAdmin, async (req, res) => {
  const { order } = req.body; // array of banner _id, urutan baru
  if (!Array.isArray(order)) return res.status(400).json({ error: '`order` harus array of id.' });
  const invalid = order.find(id => !ObjectId.isValid(id));
  if (invalid) return res.status(400).json({ error: 'Ada ID banner yang tidak valid.' });

  await Promise.all(order.map((id, idx) =>
    db.collection('banners').updateOne({ _id: new ObjectId(id) }, { $set: { order: idx, updatedAt: new Date() } })
  ));

  logActivity({
    type: 'admin_reorder_banner',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah urutan banner.`,
    meta: { order }
  }).catch(() => {});

  broadcastActiveBanners();
  res.json({ success: true });
});

app.put('/api/admin/banners/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const {
      title, subtitle, description, ctaText, ctaLink, gradientFrom, gradientTo, icon,
      isActive, startAt, endAt, bannerType, imageUrl, imageData, codeHtml, codeCss, codeJs
    } = req.body;
    const update = { updatedAt: new Date() };
    if (title !== undefined) update.title = title;
    if (subtitle !== undefined) update.subtitle = subtitle;
    if (description !== undefined) update.description = description;
    if (ctaText !== undefined) update.ctaText = ctaText;
    if (ctaLink !== undefined) update.ctaLink = ctaLink;
    if (gradientFrom !== undefined) update.gradientFrom = gradientFrom;
    if (gradientTo !== undefined) update.gradientTo = gradientTo;
    if (icon !== undefined) update.icon = icon;
    if (isActive !== undefined) update.isActive = isActive === false ? false : true;
    if (startAt !== undefined) update.startAt = startAt ? new Date(startAt) : null;
    if (endAt !== undefined) update.endAt = endAt ? new Date(endAt) : null;

    if (bannerType !== undefined) {
      const type = bannerType === 'code' ? 'code' : 'image';
      update.bannerType = type;
      if (type === 'code') {
        if (codeHtml !== undefined && !codeHtml?.trim()) {
          return res.status(400).json({ error: 'HTML wajib diisi untuk Code Banner.' });
        }
        if (codeHtml !== undefined) update.codeHtml = sanitizeBannerHtml(codeHtml);
        if (codeCss !== undefined) update.codeCss = sanitizeBannerCss(codeCss);
        if (codeJs  !== undefined) update.codeJs  = sanitizeBannerJs(codeJs);
        // Ganti tipe ke code -> bersihkan sisa data gambar tipe lama
        update.imageUrl = null; update.imageData = null;
      } else {
        Object.assign(update, validateBannerImageFields({ imageData, imageUrl }));
        // Ganti tipe ke image -> bersihkan sisa kode tipe lama
        update.codeHtml = null; update.codeCss = null; update.codeJs = null;
      }
    } else {
      // Tipe tidak diubah — tetap perbolehkan update field masing-masing secara parsial
      if (imageUrl !== undefined || imageData !== undefined) {
        Object.assign(update, validateBannerImageFields({ imageData, imageUrl }));
      }
      if (codeHtml !== undefined) update.codeHtml = sanitizeBannerHtml(codeHtml);
      if (codeCss  !== undefined) update.codeCss  = sanitizeBannerCss(codeCss);
      if (codeJs   !== undefined) update.codeJs   = sanitizeBannerJs(codeJs);
    }

    await db.collection('banners').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });

    logActivity({
      type: 'admin_edit_banner',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah banner "${update.title || req.params.id}".`,
      meta: { bannerId: req.params.id, update: { ...update, imageData: update.imageData ? '(base64 disimpan)' : update.imageData } }
    }).catch(() => {});

    broadcastActiveBanners();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/banners/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const banner = await db.collection('banners').findOne({ _id: new ObjectId(req.params.id) });
  await db.collection('banners').deleteOne({ _id: new ObjectId(req.params.id) });

  logActivity({
    type: 'admin_delete_banner',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'warning',
    ip: getReqIp(req),
    description: `Admin menghapus banner "${banner?.title || req.params.id}".`,
    meta: { bannerId: req.params.id, title: banner?.title }
  }).catch(() => {});

  broadcastActiveBanners();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// TUTORIAL — Halaman Tutorial (App) & Kelola Tutorial (Admin Web)
// Sama seperti Banner: thumbnail & gambar disimpan sebagai data URI base64 di
// Mongo (boleh juga link eksternal), jadi tidak butuh disk/storage terpisah —
// aman dipakai di hosting apa pun termasuk yang filesystem-nya ephemeral.
//
// "Isi Tutorial" adalah rich text (HTML) hasil editor Admin Web, disanitasi
// ketat sebelum disimpan (lihat sanitizeTutorialContent) — SENGAJA tidak
// mengizinkan <img>/<iframe>/<script> di dalam isi tutorial, karena gambar &
// video tutorial sudah punya kolom terpisah (imageData/imageUrl & youtubeId)
// supaya ukuran dokumen tetap terkendali & gampang diaudit.
//
// Realtime: setiap Tambah/Edit/Hapus/ubah status Publish-Draft di Admin Web
// langsung di-broadcast lewat WebSocket ('tutorials:update') ke semua device
// App yang online — App tidak perlu update launcher ataupun restart sama sekali.
// ══════════════════════════════════════════════════════════════════════════
const TUTORIAL_MAX_THUMB_BYTES = 2 * 1024 * 1024; // 2MB — cukup buat thumbnail kartu
const TUTORIAL_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB — gambar pendukung di halaman isi tutorial
const TUTORIAL_MAX_CONTENT_LEN = 200000; // ~200rb karakter HTML rich text — jauh lebih dari cukup buat 1 tutorial

const TUTORIAL_CONTENT_SANITIZE_OPTIONS = {
  allowedTags: [
    'p','br','h1','h2','h3','h4','ul','ol','li','strong','em','b','i','u','s',
    'blockquote','a','code','pre','hr','span'
  ],
  allowedAttributes: {
    '*': ['class', 'style'],
    a: ['href', 'target', 'rel']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // <img>/<iframe>/<script> dibuang total dari isi tutorial dengan sengaja — lihat
  // catatan di atas soal kenapa gambar & video tutorial punya kolom sendiri.
  exclusiveFilter: (frame) => ['script', 'iframe', 'img', 'style'].includes(frame.tag)
};

function sanitizeTutorialContent(html) {
  if (!html) return '';
  const trimmed = String(html).slice(0, TUTORIAL_MAX_CONTENT_LEN);
  return sanitizeHtml(trimmed, TUTORIAL_CONTENT_SANITIZE_OPTIONS);
}

// Thumbnail & gambar tutorial: boleh upload base64 (data URI) dari Admin Web ATAU
// link gambar eksternal biasa — pola & validasinya sama persis dengan Banner.
function validateTutorialImage(imageData, imageUrl, maxBytes, label) {
  const out = { data: null, url: null };
  if (imageData) {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(imageData).trim());
    if (!m) throw new Error(`Format ${label} tidak didukung. Gunakan PNG, JPG, GIF, atau WEBP.`);
    const approxBytes = Math.ceil((m[2].length * 3) / 4);
    if (approxBytes > maxBytes) throw new Error(`Ukuran ${label} maksimal ${(maxBytes / 1024 / 1024).toFixed(1)}MB.`);
    out.data = imageData;
  } else if (imageUrl) {
    const url = String(imageUrl).trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`URL ${label} harus diawali http:// atau https://`);
    out.url = url;
  }
  return out;
}

// Terima link YouTube dalam format apa pun (watch?v=, youtu.be/, /shorts/, /embed/)
// dan kembalikan videoId murni (11 karakter) — App merakit sendiri <iframe embed>-nya
// dari videoId ini, jadi tidak pernah percaya string mentah apa pun dari DB.
function extractYoutubeId(url) {
  if (!url) return '';
  const s = String(url).trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

// Terima link TikTok dalam format penuh (tiktok.com/@user/video/ID) langsung dari
// regex tanpa request tambahan. Untuk short-link (vt.tiktok.com/xxx, vm.tiktok.com/xxx)
// TikTok tidak menaruh ID di URL-nya — harus ikuti redirect dulu ke URL penuh baru
// ID-nya kelihatan, makanya fungsi ini async.
async function extractTiktokId(url) {
  if (!url) return '';
  const s = String(url).trim();

  const direct = s.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/i);
  if (direct) return direct[1];

  // short-link → resolve redirect-nya dulu (vt.tiktok.com / vm.tiktok.com / m.tiktok.com)
  if (/tiktok\.com\//i.test(s)) {
    try {
      const resp = await axios.get(s, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const finalUrl = resp.request?.res?.responseUrl || resp.request?.responseURL || '';
      const m = finalUrl.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/i);
      if (m) return m[1];
    } catch (e) { /* gagal resolve short-link, biarkan kosong */ }
  }
  return '';
}

// Deteksi platform dari satu input link (dipakai admin, cukup 1 kolom untuk YouTube/TikTok)
// dan kembalikan { platform, id }. Mengembalikan platform:'' kalau linknya gak dikenali
// atau videoId gagal diekstrak (termasuk short-link TikTok yang gagal di-resolve).
async function resolveVideoInfo(url) {
  if (!url) return { platform: '', id: '' };
  const s = String(url).trim();

  if (/(?:youtube\.com|youtu\.be)/i.test(s)) {
    const id = extractYoutubeId(s);
    return id ? { platform: 'youtube', id } : { platform: '', id: '' };
  }
  if (/tiktok\.com/i.test(s)) {
    const id = await extractTiktokId(s);
    return id ? { platform: 'tiktok', id } : { platform: '', id: '' };
  }
  return { platform: '', id: '' };
}

async function broadcastPublishedTutorials() {
  try {
    const tutorials = await db.collection('tutorials')
      .find({ status: 'published' })
      .sort({ createdAt: -1 })
      .toArray();
    wsBroadcastAll('tutorials:update', tutorials);
  } catch (e) { /* noop */ }
}

// ── APP: daftar tutorial published ──
// Search & filter kategori dikerjakan di sisi client (sama seperti /api/games)
// supaya instan tanpa fetch ulang server tiap kali ganti keyword/kategori.
app.get('/api/tutorials', requireUser, async (req, res) => {
  const tutorials = await db.collection('tutorials')
    .find({ status: 'published' })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(tutorials);
});

// ── ADMIN: Kelola Tutorial ──
app.get('/api/admin/tutorials', requireAdmin, async (req, res) => {
  const tutorials = await db.collection('tutorials').find({}).sort({ createdAt: -1 }).toArray();
  res.json(tutorials);
});

app.post('/api/admin/tutorials', requireAdmin, async (req, res) => {
  try {
    const {
      title, description, content, category, videoUrl, youtubeUrl,
      thumbnailData, thumbnailUrl, imageData, imageUrl, status
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Judul tutorial wajib diisi.' });
    if (!content?.trim()) return res.status(400).json({ error: 'Isi tutorial wajib diisi.' });

    const thumb = validateTutorialImage(thumbnailData, thumbnailUrl, TUTORIAL_MAX_THUMB_BYTES, 'thumbnail');
    const img   = validateTutorialImage(imageData, imageUrl, TUTORIAL_MAX_IMAGE_BYTES, 'gambar');
    // videoUrl = nama field baru (YouTube atau TikTok, 1 kolom); youtubeUrl tetap
    // diterima untuk kompatibilitas kalau ada request lama yang masih kirim field itu.
    const { platform: videoPlatform, id: videoId } = await resolveVideoInfo(videoUrl || youtubeUrl);

    const doc = {
      title: title.trim(),
      description: (description || '').trim(),
      content: sanitizeTutorialContent(content),
      category: (category || 'Umum').trim() || 'Umum',
      videoPlatform, videoId,
      youtubeId: videoPlatform === 'youtube' ? videoId : '', // kompat untuk build app lama
      thumbnailData: thumb.data, thumbnailUrl: thumb.url,
      imageData: img.data, imageUrl: img.url,
      status: status === 'draft' ? 'draft' : 'published',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('tutorials').insertOne(doc);

    logActivity({
      type: 'admin_add_tutorial',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin menambahkan tutorial "${doc.title}".`,
      meta: { tutorialId: result.insertedId, title: doc.title }
    }).catch(() => {});

    broadcastPublishedTutorials();
    res.json({ ...doc, _id: result.insertedId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/tutorials/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const {
      title, description, content, category, videoUrl, youtubeUrl,
      thumbnailData, thumbnailUrl, imageData, imageUrl, status
    } = req.body;

    const update = { updatedAt: new Date() };
    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: 'Judul tutorial wajib diisi.' });
      update.title = title.trim();
    }
    if (description !== undefined) update.description = (description || '').trim();
    if (content !== undefined) {
      if (!content.trim()) return res.status(400).json({ error: 'Isi tutorial wajib diisi.' });
      update.content = sanitizeTutorialContent(content);
    }
    if (category !== undefined) update.category = (category || 'Umum').trim() || 'Umum';
    if (videoUrl !== undefined || youtubeUrl !== undefined) {
      const { platform: videoPlatform, id: videoId } = await resolveVideoInfo(videoUrl !== undefined ? videoUrl : youtubeUrl);
      update.videoPlatform = videoPlatform;
      update.videoId = videoId;
      update.youtubeId = videoPlatform === 'youtube' ? videoId : ''; // kompat untuk build app lama
    }
    if (status !== undefined) update.status = status === 'draft' ? 'draft' : 'published';

    if (thumbnailData !== undefined || thumbnailUrl !== undefined) {
      const thumb = validateTutorialImage(thumbnailData, thumbnailUrl, TUTORIAL_MAX_THUMB_BYTES, 'thumbnail');
      update.thumbnailData = thumb.data; update.thumbnailUrl = thumb.url;
    }
    if (imageData !== undefined || imageUrl !== undefined) {
      const img = validateTutorialImage(imageData, imageUrl, TUTORIAL_MAX_IMAGE_BYTES, 'gambar');
      update.imageData = img.data; update.imageUrl = img.url;
    }

    await db.collection('tutorials').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });

    logActivity({
      type: 'admin_edit_tutorial',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah tutorial "${update.title || req.params.id}".`,
      meta: { tutorialId: req.params.id }
    }).catch(() => {});

    broadcastPublishedTutorials();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Toggle cepat Publish <-> Draft tanpa perlu buka form Edit lengkap.
app.put('/api/admin/tutorials/:id/status', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const status = req.body.status === 'draft' ? 'draft' : 'published';
  await db.collection('tutorials').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status, updatedAt: new Date() } });

  logActivity({
    type: 'admin_edit_tutorial',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah status tutorial menjadi ${status === 'draft' ? 'Draft' : 'Published'}.`,
    meta: { tutorialId: req.params.id, status }
  }).catch(() => {});

  broadcastPublishedTutorials();
  res.json({ success: true });
});

app.delete('/api/admin/tutorials/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const tutorial = await db.collection('tutorials').findOne({ _id: new ObjectId(req.params.id) });
  await db.collection('tutorials').deleteOne({ _id: new ObjectId(req.params.id) });

  logActivity({
    type: 'admin_delete_tutorial',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'warning',
    ip: getReqIp(req),
    description: `Admin menghapus tutorial "${tutorial?.title || req.params.id}".`,
    meta: { tutorialId: req.params.id, title: tutorial?.title }
  }).catch(() => {});

  broadcastPublishedTutorials();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — TOP INSTALLER MINGGUAN (leaderboard) — view only, dihitung realtime
// dari koleksi `history`. `history-list` mengembalikan snapshot minggu-minggu
// sebelumnya (opsional) yang tersimpan di `leaderboardHistory`.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/leaderboard', requireAdmin, async (req, res) => {
  try {
    const data = await computeWeeklyLeaderboard(5);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/leaderboard/history', requireAdmin, async (req, res) => {
  try {
    const rows = await db.collection('leaderboardHistory').find({}).sort({ weekStart: -1 }).limit(12).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — HISTORI (lihat punya semua user) & USERS (atur role)
// ══════════════════════════════════════════════════════════════════════════
// BUG FIX: SEBELUMNYA endpoint ini cuma `.limit(300)` tanpa pagination sama sekali —
// begitu histori sudah lebih dari 300 baris, entri yang lebih lama otomatis TIDAK PERNAH
// kekirim ke admin panel lagi (padahal datanya masih ada utuh di database), makanya
// kelihatan kayak "histori hilang". Sekarang pakai pagination beneran (skip/limit) + total
// count terpisah, jadi SEMUA data tetap bisa dijelajah lewat halaman berikutnya, plus
// dukungan search/filter/sort di level database biar tetap cepat walau datanya banyak.
app.get('/api/admin/history', requireAdmin, async (req, res) => {
  try {
    let { page = '1', perPage = '20', search = '', type = 'all', sort = 'newest', dateFrom = '', dateTo = '' } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    perPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 20));

    const query = {};
    if (type === 'game' || type === 'bypass') query.itemType = type;
    if (search && search.trim()) {
      const q = search.trim();
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ username: re }, { itemName: re }, { userId: re }];
    }
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo)   query.createdAt.$lte = new Date(dateTo);
    }

    const sortDir = sort === 'oldest' ? 1 : -1;
    const total = await db.collection('history').countDocuments(query);
    const rows = await db.collection('history')
      .find(query)
      .sort({ createdAt: sortDir })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .toArray();

    // Statistik global (TIDAK ikut kepengaruh filter/search yang lagi aktif) — dipakai
    // buat kartu ringkasan di atas tabel, biar angkanya tetap representasi keseluruhan data.
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalAll, totalGame, totalBypass, totalToday] = await Promise.all([
      db.collection('history').countDocuments({}),
      db.collection('history').countDocuments({ itemType: 'game' }),
      db.collection('history').countDocuments({ itemType: 'bypass' }),
      db.collection('history').countDocuments({ createdAt: { $gte: todayStart } })
    ]);

    res.json({
      rows, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)),
      stats: { all: totalAll, game: totalGame, bypass: totalBypass, today: totalToday }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — LOGS (Pusat Riwayat Aktivitas / Audit Log)
// ══════════════════════════════════════════════════════════════════════════
// Server-driven sepenuhnya: search/filter (jenis, status, role, tanggal)/sort/
// pagination semuanya dieksekusi di MongoDB lewat index yang sudah disiapkan
// (lihat connectDB) — jadi tetap cepat walau activityLogs sudah berisi
// ratusan ribu sampai jutaan baris. Realtime lewat WebSocket admin (event
// 'activity', lihat logActivity()) — TIDAK butuh endpoint terpisah.
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    let {
      page = '1', perPage = '25', search = '', type = 'all', status = 'all',
      role = 'all', category = 'all', sort = 'newest', dateFrom = '', dateTo = ''
    } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    perPage = Math.min(200, Math.max(1, parseInt(perPage, 10) || 25));

    const query = {};
    if (type && type !== 'all') query.type = type;
    if (status && status !== 'all') query.status = status;
    if (role && role !== 'all') query.role = role;
    if (category && category !== 'all') query.category = category;
    if (search && search.trim()) {
      const q = search.trim();
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ username: re }, { discordId: re }, { admin: re }, { description: re }];
    }
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo)   query.createdAt.$lte = new Date(dateTo);
    }

    const sortDir = sort === 'oldest' ? 1 : -1;
    const [total, rows] = await Promise.all([
      db.collection('activityLogs').countDocuments(query),
      db.collection('activityLogs')
        .find(query)
        .sort({ createdAt: sortDir })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .toArray()
    ]);

    // Statistik ringkasan GLOBAL (tidak ikut kepengaruh filter aktif — representasi
    // keseluruhan data, dipakai buat kartu ringkasan di atas tabel).
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [totalAll, totalToday, byStatusAgg, byTypeAgg] = await Promise.all([
      db.collection('activityLogs').countDocuments({}),
      db.collection('activityLogs').countDocuments({ createdAt: { $gte: todayStart } }),
      db.collection('activityLogs').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
      db.collection('activityLogs').aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]).toArray()
    ]);
    const byStatus = { success: 0, warning: 0, error: 0, info: 0 };
    for (const s of byStatusAgg) { if (s._id && byStatus.hasOwnProperty(s._id)) byStatus[s._id] = s.count; }
    const byType = {};
    for (const t of byTypeAgg) { if (t._id) byType[t._id] = t.count; }

    res.json({
      rows, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)),
      stats: { all: totalAll, today: totalToday, ...byStatus },
      byType,
      catalog: LOG_CATALOG
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detail satu log (dipakai modal "Detail Log") — data yang ditampilkan di tabel
// sebenarnya sudah lengkap (activityLogs menyimpan seluruh field sekaligus),
// endpoint ini disiapkan supaya detail tetap bisa diambil fresh dari DB (mis.
// via link langsung /logs/:id) tanpa bergantung ke cache di browser.
app.get('/api/admin/logs/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const doc = await db.collection('activityLogs').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Log tidak ditemukan.' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { search = '' } = req.query;
  const query = {};
  if (search && search.trim()) {
    const q = search.trim();
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ username: re }, { discordId: re }, { role: re }];
  }
  const rows = await db.collection('users').find(query).sort({ createdAt: -1 }).toArray();

  // Total download (Game) & install (Bypass) per user, dihitung SEKALIGUS lewat satu
  // aggregation (bukan query per-user) biar tetap cepat walau jumlah user banyak.
  const statsAgg = await db.collection('history').aggregate([
    { $group: { _id: { userId: '$userId', itemType: '$itemType' }, count: { $sum: 1 } } }
  ]).toArray();
  const statsMap = {};
  for (const s of statsAgg) {
    const uid = s._id.userId;
    if (!statsMap[uid]) statsMap[uid] = { downloads: 0, installs: 0, total: 0 };
    if (s._id.itemType === 'game') statsMap[uid].downloads += s.count;
    else if (s._id.itemType === 'bypass') statsMap[uid].installs += s.count;
    statsMap[uid].total += s.count;
  }

  res.json(rows.map(u => publicUser(u, statsMap[u.discordId])));
});

// "Set paket" — ganti role user dari admin panel. Ini juga sekaligus:
//   1) push role barunya ke Discord (add role tier yang sesuai, cabut role tier lain)
//   2) catat log histori perubahan role
//   3) kirim notif webhook ke channel Discord
// Kalau sync ke Discord gagal (misal role belum di-mapping, atau usernya sudah bukan
// member Discord), role di APP TETAP berhasil diubah — cuma sync Discord-nya yang
// dilaporkan gagal di response, biar admin tau tapi gak nge-block operasi utamanya.

// ──────────────────────────────────────────────────────────────────────────
// DISCORD DM HELPER — kirim DM embed/teks ke user langsung via Bot Token
// ──────────────────────────────────────────────────────────────────────────
async function sendDiscordDM(userId, contentOrPayload) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  if (!BOT_TOKEN) {
    console.warn('[DM] DISCORD_BOT_TOKEN tidak diset, DM tidak terkirim ke', userId);
    return { success: false, reason: 'no_bot_token' };
  }
  if (!userId) return { success: false, reason: 'no_user_id' };
  try {
    const dmRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: userId },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const channelId = dmRes.data.id;
    const payload = typeof contentOrPayload === 'string'
      ? { content: contentOrPayload }
      : contentOrPayload;
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      payload,
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[DM] ✅ Terkirim ke userId=${userId}`);
    return { success: true };
  } catch(e) {
    const status = e.response?.status;
    const errMsg = e.response?.data?.message || e.message;
    const errCode = e.response?.data?.code;
    // 50007 = DM dimatiin user, 10013 = unknown user — bukan error fatal
    console.warn(`[DM] ❌ Gagal ke userId=${userId} | HTTP ${status} | code=${errCode} | ${errMsg}`);
    return { success: false, status, errCode, errMsg };
  }
}

// Masa aktif sekarang bisa diatur admin dalam Menit / Jam / Hari (bukan cuma hari).
// activeAmount = angka, activeUnit = 'minutes' | 'hours' | 'days'. Tetap terima
// activeDays (lama) untuk kompatibilitas mundur kalau ada request dari versi admin panel lama.
const ACTIVE_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
function computeActiveUntil(body) {
  const unit = ACTIVE_UNIT_MS.hasOwnProperty(body.activeUnit) ? body.activeUnit : 'days';
  const amountRaw = (body.activeAmount !== undefined && body.activeAmount !== null && body.activeAmount !== '')
    ? body.activeAmount
    : body.activeDays; // fallback lama
  if (amountRaw === undefined || amountRaw === null || amountRaw === '') return { ok: true, activeUntil: undefined }; // tidak diubah
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `Masa aktif (${unit === 'minutes' ? 'menit' : unit === 'hours' ? 'jam' : 'hari'}) harus berupa angka lebih dari 0.` };
  }
  return { ok: true, activeUntil: new Date(Date.now() + amount * ACTIVE_UNIT_MS[unit]), unit, amount };
}

app.put('/api/admin/users/:discordId/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!ROLE_LEVEL.hasOwnProperty(role)) return res.status(400).json({ error: 'Role tidak valid.' });

  const user = await db.collection('users').findOne({ discordId: req.params.discordId });
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

  const oldRole  = user.role;
  const discordId = req.params.discordId;
  const username  = user.username || discordId;

  // Masa aktif (activeUntil) cuma relevan buat Gold & Platinum — Public & Admin selalu
  // unlimited waktu jadi field-nya dikosongkan lagi kalau paketnya diubah ke salah satunya.
  const update = { role, roleUpdatedAt: new Date() };
  if (role === 'gold' || role === 'platinum') {
    const period = computeActiveUntil(req.body);
    if (!period.ok) return res.status(400).json({ error: period.error });
    if (period.activeUntil !== undefined) {
      update.activeUntil = period.activeUntil;
    } else if (oldRole !== role) {
      // Baru pindah ke Gold/Platinum tapi masa aktifnya belum diisi -> kosongkan dulu,
      // admin bisa atur belakangan lewat "Atur Masa Aktif" tanpa perlu ganti paket lagi.
      update.activeUntil = null;
    }
    // Kalau role-nya SAMA & masa aktif tidak dikirim -> activeUntil yang ada dibiarkan apa adanya.
  } else {
    update.activeUntil = null;
  }

  await db.collection('users').updateOne(
    { discordId },
    { $set: update }
  );

  let discordSync = null;
  let dmResult    = null;

  if (oldRole !== role) {
    // 1. Sinkron role ke Discord (add tier baru, cabut tier lama)
    discordSync = await roleSync.syncAppRoleToDiscord(discordId, role);

    // 2. Kirim DM embed ke user
    const ROLE_COLOR = { public: 0x8f8ab0, gold: 0xffd76a, platinum: 0xa78bfa, admin: 0x4ade80 };
    const ROLE_ICON  = { public: '🌐', gold: '🥇', platinum: '💎', admin: '👑' };
    const ROLE_DESC  = {
      public:   'Akses Public — limit harian berlaku.',
      gold:     'Akses Gold — limit harian lebih besar.',
      platinum: 'Akses Platinum — download UNLIMITED!',
      admin:    'Akses Admin — kelola panel admin & akses semua fitur.'
    };
    const newActiveUntil = update.activeUntil !== undefined ? update.activeUntil : (user.activeUntil || null);
    const purchaseFields = [
      field('👤 Username', username, true),
      field('🆔 Discord ID', discordId, true),
      field('📦 Paket Sebelumnya', `${ROLE_ICON[oldRole] || '❓'} ${oldRole.toUpperCase()}`, true),
      field('📦 Paket Baru', `${ROLE_ICON[role] || '🌐'} ${role.toUpperCase()}`, true),
      field('ℹ️ Info Paket', ROLE_DESC[role] || role, false),
      field('⏳ Masa Aktif Sampai', newActiveUntil ? fmtDateTimeWIB(newActiveUntil) : (role === 'gold' || role === 'platinum' ? 'Belum diatur admin' : null), true)
    ];

    dmResult = await sendDiscordDM(discordId, {
      embeds: [buildEmbed({
        status: 'success',
        title: 'Paket Kamu Diperbarui!',
        description: `Halo **${username}**, paket kamu telah diubah oleh Admin.`,
        fields: purchaseFields,
        thumbnail: APP_LOGO_URL || undefined,
        appName: APP_NAME,
        footerNote: 'Notifikasi Paket'
      })]
    });

    // Catat aktivitas "Pembelian Paket" — dipakai Dashboard admin (stat Gold/Platinum
    // realtime & Activity Feed). Cuma dicatat kalau rolenya beneran berubah.
    logActivity({
      type: 'set_paket',
      username,
      discordId,
      role,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      before: oldRole,
      after: role,
      description: `Admin mengubah paket ${username} dari ${oldRole.toUpperCase()} ke ${role.toUpperCase()}.`,
      meta: { oldRole, newRole: role }
    }).catch(() => {});

    // 3. Log + webhook detail ke channel Discord (via roleSync — log audit Verify Role)
    await roleSync.logRoleChange({
      discordId, username, oldRole, newRole: role,
      source: 'admin',
      discordSync,
      dmResult
    });

    // 3b. Webhook kategori "Pembelian Paket" — channel Discord terpisah, khusus buat
    // notif tiap kali admin mengaktifkan/mengubah paket seorang user (best-effort).
    webhookManager.sendCategoryWebhook('purchase', {
      embed: buildEmbed({
        status: 'success',
        title: 'Paket Diperbarui',
        description: `Admin mengaktifkan/mengubah paket seorang user.`,
        fields: purchaseFields,
        thumbnail: APP_LOGO_URL || undefined,
        appName: APP_NAME,
        footerNote: 'Pembelian Paket'
      })
    }).catch(() => {});

    // 4. Realtime ke client — user tidak perlu reload, role langsung terupdate
    // Cara: tandai di DB field realtimePush, diambil pollingnya refreshCurrentUserRole (tiap 15 detik)
    // Tidak perlu socket — /api/me sudah di-hit tiap 15 detik dari client
  }

  pushAccountUpdate(discordId).catch(() => {});
  db.collection('users').findOne({ discordId })
    .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
    .catch(() => {});

  res.json({
    success: true,
    discordSync,
    dmSent: dmResult?.success ?? null,
    roleAssigned: discordSync?.added ?? null,
    roleRemoved: discordSync?.removed ?? [],
    activeUntil: update.activeUntil !== undefined ? update.activeUntil : (user.activeUntil || null)
  });
});

// "Atur Masa Aktif" — ubah/perpanjang masa aktif Gold/Platinum TANPA ganti paket.
// Berguna buat perpanjang langganan user yang paketnya sudah benar tapi mau
// ditambah/reset masa aktifnya (mis. user baru bayar lagi). Sekarang mendukung
// satuan Menit/Jam/Hari (activeAmount + activeUnit), bukan cuma hari.
app.put('/api/admin/users/:discordId/active-period', requireAdmin, async (req, res) => {
  try {
    const { clear } = req.body;
    const discordId = req.params.discordId;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
    if (user.role !== 'gold' && user.role !== 'platinum') {
      return res.status(400).json({ error: 'Masa aktif cuma berlaku untuk paket Gold & Platinum.' });
    }

    let activeUntil = null;
    if (!clear) {
      const period = computeActiveUntil(req.body);
      if (!period.ok) return res.status(400).json({ error: period.error });
      if (period.activeUntil === undefined) return res.status(400).json({ error: 'Isi jumlah masa aktif dulu.' });
      activeUntil = period.activeUntil;
    }

    await db.collection('users').updateOne({ discordId }, { $set: { activeUntil } });

    const renewalFields = [
      field('👤 Username', user.username || discordId, true),
      field('🆔 Discord ID', discordId, true),
      field('📦 Paket', user.role.toUpperCase(), true),
      field('⏳ Masa Aktif Sampai', activeUntil ? fmtDateTimeWIB(activeUntil) : 'Direset (belum diatur ulang)', true)
    ];

    notifyUser(discordId, {
      type: 'renewal',
      title: clear ? 'Masa Aktif Direset' : 'Masa Aktif Diperpanjang',
      message: clear
        ? 'Masa aktif paket kamu telah direset oleh Admin.'
        : `Masa aktif paket kamu telah diperpanjang oleh Admin, aktif sampai ${fmtDateTimeWIB(activeUntil)}.`,
      fields: renewalFields,
      dm: true, webhook: false
    }).catch(() => {});

    logActivity({
      type: 'renewal',
      username: user.username || discordId,
      discordId,
      role: user.role,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      before: user.activeUntil || null,
      after: activeUntil,
      description: clear
        ? `Admin mereset masa aktif paket ${user.username || discordId}.`
        : `Admin memperpanjang masa aktif paket ${user.username || discordId} sampai ${fmtDateTimeWIB(activeUntil)}.`,
      meta: { role: user.role, activeUntil }
    }).catch(() => {});

    // Webhook kategori "Perpanjangan Paket" — channel Discord terpisah, khusus buat
    // notif tiap kali admin memperpanjang/mereset masa aktif paket user (best-effort).
    webhookManager.sendCategoryWebhook('renewal', {
      embed: buildEmbed({
        status: 'info',
        title: clear ? 'Masa Aktif Direset' : 'Masa Aktif Diperpanjang',
        description: clear ? 'Admin mereset masa aktif paket user.' : 'Admin memperpanjang masa aktif paket user.',
        fields: renewalFields,
        thumbnail: APP_LOGO_URL || undefined,
        appName: APP_NAME,
        footerNote: 'Perpanjangan Paket'
      })
    }).catch(() => {});

    pushAccountUpdate(discordId).catch(() => {});
    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});

    res.json({ success: true, activeUntil });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Reset Limit Download" — reset counter download harian user hari ini ke 0 (Game &
// Bypass). Berguna kalau user komplain limitnya kepakai gara-gara error/bug pas download.
app.put('/api/admin/users/:discordId/reset-quota', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    await db.collection('users').updateOne(
      { discordId },
      { $set: { downloadUsage: { date: todayDateStrJakarta(), game: 0, bypass: 0 } } }
    );
    pushAccountUpdate(discordId).catch(() => {});

    logActivity({
      type: 'admin_reset_quota',
      username: user.username || discordId,
      discordId,
      role: user.role,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mereset limit download harian ${user.username || discordId}.`,
      meta: { discordId }
    }).catch(() => {});

    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Atur Limit Download/Bypass" — versi lebih presisi dari reset-quota di atas: admin
// bisa TAMBAH (kasih balik sisa download hari ini), KURANGI (potong sisa download hari
// ini), atau RESET (balik ke 0 dipakai) counter Game/Bypass secara terpisah. Cuma
// berlaku untuk role yang limitnya terbatas (Public/Gold) — Platinum & Admin unlimited
// jadi tidak ada apa-apa yang perlu diatur.
app.put('/api/admin/users/:discordId/quota', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const { type, action, amount } = req.body;
    if (!['game', 'bypass'].includes(type)) return res.status(400).json({ error: 'Tipe limit harus "game" atau "bypass".' });
    if (!['add', 'subtract', 'reset'].includes(action)) return res.status(400).json({ error: 'Aksi harus "add", "subtract", atau "reset".' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const limits = DOWNLOAD_LIMITS[user.role] || DOWNLOAD_LIMITS.public;
    const limit = limits[type];
    if (limit === Infinity) return res.status(400).json({ error: `Paket ${user.role.toUpperCase()} unlimited untuk ${type === 'game' ? 'Game' : 'Bypass'}, tidak ada limit yang bisa diatur.` });

    const today = todayDateStrJakarta();
    const prevUsage = (user.downloadUsage && user.downloadUsage.date === today)
      ? user.downloadUsage
      : { date: today, game: 0, bypass: 0 };
    const usedNow = prevUsage[type] || 0;

    let usedNext = usedNow;
    if (action === 'reset') {
      usedNext = 0;
    } else {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Jumlah harus berupa angka lebih dari 0.' });
      // "add" limit = kasih balik jatah (mengurangi counter terpakai), "subtract" = potong jatah (menambah counter terpakai)
      usedNext = action === 'add' ? Math.max(0, usedNow - amt) : Math.min(limit, usedNow + amt);
    }

    const newUsage = { ...prevUsage, [type]: usedNext };
    await db.collection('users').updateOne({ discordId }, { $set: { downloadUsage: newUsage } });
    pushAccountUpdate(discordId).catch(() => {});

    const label = type === 'game' ? 'Game' : 'Bypass';
    const actionLabel = action === 'reset' ? 'mereset' : action === 'add' ? 'menambah' : 'mengurangi';
    logActivity({
      type: 'admin_reset_quota',
      username: user.username || discordId,
      discordId,
      role: user.role,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      before: usedNow,
      after: usedNext,
      description: `Admin ${actionLabel} limit download ${label} ${user.username || discordId} (sisa sekarang: ${Math.max(0, limit - usedNext)}/${limit}).`,
      meta: { discordId, type, action, amount: amount || null }
    }).catch(() => {});

    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});

    res.json({ success: true, type, used: usedNext, limit, remaining: Math.max(0, limit - usedNext) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Suspend / Ban / Aktifkan Kembali" — ubah status akses akun user. 'suspended' &
// 'banned' langsung memblokir user dari SEMUA endpoint app (lihat requireUser) dan
// otomatis memutus koneksi realtime yang sedang aktif punya user itu, jadi efeknya
// langsung kerasa walau usernya lagi online.
app.put('/api/admin/users/:discordId/status', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const { status, reason } = req.body;
    if (!ACCOUNT_STATUSES.includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const oldStatus = user.status || 'active';
    await db.collection('users').updateOne(
      { discordId },
      { $set: { status, statusReason: reason || null, statusUpdatedAt: new Date() } }
    );

    const STATUS_LABEL = { active: 'Aktif', suspended: 'Suspend', banned: 'Banned' };
    const STATUS_ICON  = { active: '✅', suspended: '⏸️', banned: '⛔' };

    // Jenis log lebih spesifik sesuai kombinasi status lama -> baru, biar bisa
    // difilter terpisah di halaman Logs (Ban / Unban / Suspend / Unsuspend).
    let logType = 'account_status';
    if (status === 'banned') logType = 'user_ban';
    else if (status === 'suspended') logType = 'user_suspend';
    else if (status === 'active' && oldStatus === 'banned') logType = 'user_unban';
    else if (status === 'active' && oldStatus === 'suspended') logType = 'user_unsuspend';

    logActivity({
      type: logType,
      username: user.username || discordId,
      discordId,
      role: user.role,
      admin: req.admin?.username || 'Admin',
      ip: getReqIp(req),
      before: oldStatus,
      after: status,
      description: `Admin mengubah status akun ${user.username || discordId} dari ${STATUS_LABEL[oldStatus]} ke ${STATUS_LABEL[status]}.${reason ? ` Alasan: ${reason}` : ''}`,
      meta: { discordId, oldStatus, newStatus: status, reason: reason || null }
    }).catch(() => {});

    if (status !== 'active') {
      notifyUser(discordId, {
        type: 'announcement',
        title: `Akun Kamu Di-${STATUS_LABEL[status]}`,
        message: status === 'banned'
          ? `Akun kamu telah di-banned oleh Admin dan tidak bisa lagi mengakses layanan.${reason ? ` Alasan: ${reason}` : ''}`
          : `Akun kamu di-suspend sementara oleh Admin.${reason ? ` Alasan: ${reason}` : ''}`,
        fields: [
          field('👤 Username', user.username || discordId, true),
          field('🆔 Discord ID', discordId, true),
          field(`${STATUS_ICON[status]} Status`, STATUS_LABEL[status], true),
          ...(reason ? [field('📝 Alasan', reason, false)] : [])
        ],
        dm: true, webhook: true
      }).catch(() => {});
      // Putuskan koneksi realtime yang sedang aktif biar app langsung logout/blokir.
      wsSendToUser(discordId, 'account:blocked', { status, reason: reason || null });
    } else if (oldStatus !== 'active') {
      notifyUser(discordId, {
        type: 'announcement',
        title: 'Akun Kamu Diaktifkan Kembali',
        message: 'Akun kamu telah diaktifkan kembali oleh Admin. Selamat datang kembali!',
        fields: [
          field('👤 Username', user.username || discordId, true),
          field('🆔 Discord ID', discordId, true)
        ],
        dm: true, webhook: true
      }).catch(() => {});
    }

    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});

    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — DEVICE MANAGEMENT (Device Lock: 1 akun = 1 perangkat)
// ══════════════════════════════════════════════════════════════════════════

// Detail perangkat yang terikat ke satu user (dipakai section "Device Management"
// di modal Kelola User). Return status 'unbound' kalau belum pernah login sama sekali.
app.get('/api/admin/users/:discordId/device', requireAdmin, async (req, res) => {
  try {
    const device = await deviceLock.getDevice(req.params.discordId);
    if (!device) return res.json({ status: 'unbound', device: null });
    res.json({
      status: device.pendingChange ? 'pending_change' : 'bound',
      device: {
        fingerprint: device.fingerprint,
        info: device.info,
        registeredAt: device.registeredAt,
        lastLoginAt: device.lastLoginAt,
        lastActiveAt: device.lastActiveAt,
        pendingChange: !!device.pendingChange
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Riwayat aktivitas perangkat (registrasi, login sukses, ditolak, reset, dll).
app.get('/api/admin/users/:discordId/device/logs', requireAdmin, async (req, res) => {
  try {
    const logs = await deviceLock.getLogs(req.params.discordId, Number(req.query.limit) || 50);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset Device — langsung lepas ikatan SEKARANG. Login berikutnya dari perangkat
// manapun otomatis didaftarkan sebagai perangkat baru.
app.post('/api/admin/users/:discordId/device/reset', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    await deviceLock.resetDevice(discordId, { adminNote: req.body?.note, username: user.username });

    logActivity({
      type: 'device_reset',
      username: user.username || discordId,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      role: user.role,
      discordId,
      description: `Admin mereset perangkat (Device Lock) milik ${user.username || discordId}.`,
      meta: { discordId, action: 'device_reset' }
    }).catch(() => {});

    notifyUser(discordId, {
      type: 'announcement',
      title: 'Perangkat Kamu Direset',
      message: 'Perangkat yang terikat ke akun kamu telah direset oleh Admin. Login berikutnya dari perangkat manapun akan otomatis didaftarkan sebagai perangkat baru.',
      fields: [field('👤 Username', user.username || discordId, true), field('🆔 Discord ID', discordId, true)],
      dm: true, webhook: false
    }).catch(() => {});

    webhookManager.sendCategoryWebhook('device_security', {
      embed: buildEmbed({
        status: 'warning',
        title: 'Device Direset oleh Admin',
        description: `Admin mereset ikatan perangkat untuk **${user.username || discordId}**.`,
        fields: [
          field('👤 Username', user.username || discordId, true),
          field('🆔 Discord ID', discordId, true),
          ...(req.body?.note ? [field('📝 Catatan Admin', req.body.note, false)] : [])
        ],
        appName: APP_NAME,
        footerNote: 'Keamanan Perangkat'
      })
    }).catch(() => {});

    // Kalau app-nya lagi kebuka aktif sekarang, langsung tendang keluar realtime
    // (tanpa perlu restart app) — user tinggal login ulang, akan didaftar ulang.
    wsSendToUser(discordId, 'device:reset', { reason: 'admin_reset' });

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Ganti Device — TIDAK langsung menendang sesi yang sedang aktif. Login berikutnya
// (dari perangkat apa pun) akan didaftar ulang sebagai perangkat utama baru, sekali pakai.
app.post('/api/admin/users/:discordId/device/allow-change', requireAdmin, async (req, res) => {
  try {
    const discordId = req.params.discordId;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    await deviceLock.allowDeviceChange(discordId, { adminNote: req.body?.note, username: user.username });

    logActivity({
      type: 'device_allow_change',
      username: user.username || discordId,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      role: user.role,
      discordId,
      description: `Admin mengizinkan pergantian perangkat (Device Lock) untuk ${user.username || discordId}.`,
      meta: { discordId, action: 'device_change_allowed' }
    }).catch(() => {});

    notifyUser(discordId, {
      type: 'announcement',
      title: 'Pergantian Perangkat Diizinkan',
      message: 'Admin mengizinkan kamu login dari perangkat baru. Login berikutnya akan otomatis didaftarkan sebagai perangkat utama kamu yang baru.',
      fields: [field('👤 Username', user.username || discordId, true), field('🆔 Discord ID', discordId, true)],
      dm: true, webhook: false
    }).catch(() => {});

    webhookManager.sendCategoryWebhook('device_security', {
      embed: buildEmbed({
        status: 'info',
        title: 'Pergantian Device Diizinkan Admin',
        description: `Admin mengizinkan **${user.username || discordId}** login dari perangkat baru (berlaku sekali, login berikutnya).`,
        fields: [
          field('👤 Username', user.username || discordId, true),
          field('🆔 Discord ID', discordId, true),
          ...(req.body?.note ? [field('📝 Catatan Admin', req.body.note, false)] : [])
        ],
        appName: APP_NAME,
        footerNote: 'Keamanan Perangkat'
      })
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════
// ADMIN — PENGUMUMAN / NOTIFIKASI
// ══════════════════════════════════════════════════════════════════════════
// Kirim pengumuman ke SATU user (target=discordId) atau SEMUA user (target='all').
app.post('/api/admin/notifications/send', requireAdmin, async (req, res) => {
  try {
    const { target, title, message, dm, webhook } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Judul & pesan wajib diisi.' });

    if (!target || target === 'all') {
      const count = await notifyAllUsers({ title, message, dm: !!dm, webhook: webhook !== false });
      logActivity({
        type: 'announcement',
        username: req.admin?.username || 'Admin',
        admin: req.admin?.username || 'Admin',
        status: 'success',
        ip: getReqIp(req),
        description: `Admin mengirim broadcast "${title}" ke ${count} user.`,
        meta: { target: 'all', title, sentTo: count }
      }).catch(() => {});
      return res.json({ success: true, sentTo: count });
    }

    const user = await db.collection('users').findOne({ discordId: target });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
    await notifyUser(target, {
      type: 'announcement', title, message,
      fields: [
        field('👤 Username', user.username || target, true),
        field('🆔 Discord ID', target, true)
      ],
      dm: !!dm, webhook: !!webhook
    });
    logActivity({
      type: 'announcement',
      username: user.username || target,
      discordId: target,
      role: user.role,
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengirim pesan "${title}" ke ${user.username || target}.`,
      meta: { target, title }
    }).catch(() => {});
    if (dm) {
      logActivity({
        type: 'discord_dm',
        username: user.username || target,
        discordId: target,
        role: user.role,
        admin: req.admin?.username || 'Admin',
        status: 'success',
        ip: getReqIp(req),
        description: `Admin mengirim Discord DM "${title}" ke ${user.username || target}.`,
        meta: { target, title }
      }).catch(() => {});
    }
    res.json({ success: true, sentTo: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  try {
    const rows = await db.collection('notifications').find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — WEBHOOK SETTINGS (webhook Discord per kategori notifikasi)
// ══════════════════════════════════════════════════════════════════════════

// Daftar semua kategori + status konfigurasinya (url terset/tidak, aktif/tidak,
// status terakhir Valid/Invalid). Dipakai buat render halaman Webhook Settings.
app.get('/api/admin/webhooks', requireAdmin, async (req, res) => {
  try {
    const rows = await webhookManager.getAll();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simpan/ubah URL & status aktif satu kategori webhook. Berlaku langsung
// (realtime) — notifikasi berikutnya utk kategori ini otomatis pakai URL baru,
// tanpa perlu restart server.
app.put('/api/admin/webhooks/:category', requireAdmin, async (req, res) => {
  try {
    const { url, enabled } = req.body;
    const updated = await webhookManager.upsert(req.params.category, { url, enabled });
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah pengaturan Webhook kategori "${updated.label || req.params.category}".`,
      meta: { category: req.params.category, enabled: updated.enabled, hasUrl: !!updated.url }
    }).catch(() => {});
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Kirim pesan uji coba ke satu kategori webhook. Body opsional { url } dipakai
// kalau admin mau test URL yang baru diketik SEBELUM disimpan.
app.post('/api/admin/webhooks/:category/test', requireAdmin, async (req, res) => {
  try {
    const result = await webhookManager.testWebhook(req.params.category, req.body?.url);
    logActivity({
      type: 'discord_webhook',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: result.sent ? 'success' : 'error',
      ip: getReqIp(req),
      description: `Admin mengirim test webhook kategori "${req.params.category}".${result.sent ? '' : ' Gagal: ' + (result.error || '')}`,
      meta: { category: req.params.category, sent: result.sent }
    }).catch(() => {});
    if (!result.sent) return res.status(400).json({ error: result.error || 'Gagal mengirim test webhook. Cek lagi URL-nya.' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — HUBCAP API (Dokumentasi + API Key Management + Monitoring)
// ══════════════════════════════════════════════════════════════════════════
// Dokumentasi endpoint publik hubcapmanifest.com yang dipakai server ini —
// SATU-SATUNYA sumber kebenaran buat halaman "Dokumentasi API" (tampilan ala
// Swagger) di Admin Web. Contoh request/response di sini murni referensi,
// TIDAK memanggil hubcapmanifest.com — pemanggilan sungguhan (Try it) lewat
// endpoint /live/* di bawah, supaya API Key HubCap tidak pernah dikirim ke
// browser admin.
const HUBCAP_API_DOCS = [
  {
    method: 'GET',
    path: '/api/v1/health',
    summary: 'Cek kesehatan sistem HubCap',
    description: 'Mengecek status API HubCap (Redis, database, dan manifest storage). Mengembalikan "healthy" atau "degraded". Endpoint publik, tidak butuh API Key.',
    auth: false,
    curl: `curl ${HUBCAP_BASE_URL}/api/v1/health`,
    exampleResponse: {
      status: 'healthy',
      timestamp: '2026-04-09T12:00:00Z',
      api_version: 'v1',
      components: {
        redis: { status: 'healthy' },
        database: { status: 'healthy' },
        manifest_storage: { status: 'healthy', path: '/opt/solus/data/manifests', exists: true }
      }
    },
    liveEndpoint: '/api/admin/hubcap/live/health'
  },
  {
    method: 'GET',
    path: '/api/v1/user/stats',
    summary: 'Statistik penggunaan API Key',
    description: 'Mengambil statistik penggunaan API, limit harian, dan info akun untuk API Key yang dipakai. Butuh header Authorization Bearer.',
    auth: true,
    curl: `curl -H "Authorization: Bearer YOUR_API_KEY" ${HUBCAP_BASE_URL}/api/v1/user/stats`,
    exampleResponse: {
      user_id: '790269110008676464',
      username: 'example_user',
      api_key_usage_count: 15,
      api_key_expires_at: '2026-05-09T12:00:00Z',
      daily_usage: 42,
      daily_limit: 250,
      role_daily_limit: 50,
      custom_api_limit: 250,
      using_custom_api_limit: true,
      auto_update_enabled: null,
      can_make_requests: true,
      timestamp: '2026-04-09T12:00:00Z'
    },
    liveEndpoint: '/api/admin/hubcap/live/stats'
  }
];

app.get('/api/admin/hubcap/docs', requireAdmin, (req, res) => {
  res.json({ baseUrl: HUBCAP_BASE_URL, endpoints: HUBCAP_API_DOCS });
});

// "Try it" — proxy asli ke hubcapmanifest.com, TAPI API Key tidak pernah dikirim
// ke browser. /live/health tidak butuh key sama sekali (endpoint publik).
app.get('/api/admin/hubcap/live/health', requireAdmin, async (req, res) => {
  try {
    const r = await axios.get(`${HUBCAP_BASE_URL}/api/v1/health`, { timeout: 10000, validateStatus: () => true });
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi hubcapmanifest.com: ' + e.message });
  }
});

// /live/stats pakai API Key yang SEDANG aktif di rotasi (kalau ada), biar admin
// bisa lihat contoh response asli tanpa harus tempel key manual di UI.
app.get('/api/admin/hubcap/live/stats', requireAdmin, async (req, res) => {
  try {
    const keyDoc = await hubcapKeyManager.getActiveKey();
    if (!keyDoc) return res.status(400).json({ error: 'Belum ada API Key HubCap yang aktif untuk dicoba.' });
    const r = await axios.get(`${HUBCAP_BASE_URL}/api/v1/user/stats`, {
      headers: { Authorization: `Bearer ${keyDoc.key}` }, timeout: 10000, validateStatus: () => true
    });
    if (r.status === 200) await hubcapKeyManager.markSuccess(keyDoc);
    else if (r.status === 429 || r.status === 401 || r.status === 403) await hubcapKeyManager.markLimited(keyDoc, `HTTP ${r.status} (Try it /user/stats)`);
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi hubcapmanifest.com: ' + e.message });
  }
});

// ── API Key Management (CRUD) + Monitoring ──
// GET dipakai buat 2 hal sekaligus (daftar API Key & data Monitoring), karena
// keduanya sama-sama butuh snapshot yang sama persis (status realtime tiap key).
app.get('/api/admin/hubcap/keys', requireAdmin, async (req, res) => {
  try {
    const snapshot = await hubcapKeyManager.getMonitorSnapshot(req.query.force === '1' || req.query.force === 'true');
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/hubcap/monitor', requireAdmin, async (req, res) => {
  try {
    const snapshot = await hubcapKeyManager.getMonitorSnapshot(req.query.force === '1' || req.query.force === 'true');
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/hubcap/keys', requireAdmin, async (req, res) => {
  try {
    const { name, key } = req.body || {};
    const snapshot = await hubcapKeyManager.addKey({ name, key });
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/hubcap/keys/:id', requireAdmin, async (req, res) => {
  try {
    const { name, key, active } = req.body || {};
    const snapshot = await hubcapKeyManager.updateKey(req.params.id, { name, key, active });
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/hubcap/keys/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body || {};
    const snapshot = await hubcapKeyManager.toggleKey(req.params.id, active);
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/hubcap/keys/:id', requireAdmin, async (req, res) => {
  try {
    const snapshot = await hubcapKeyManager.deleteKey(req.params.id);
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Ryu API Key Management (CRUD) — pola identik dengan HubCap di atas, tapi
// koleksi & provider terpisah (lihat ryuKeyManager.js). Tidak ada endpoint
// stats/monitor live karena Ryu API tidak menyediakan endpoint usage publik.
app.get('/api/admin/ryu/keys', requireAdmin, async (req, res) => {
  try {
    const snapshot = await ryuKeyManager.getMonitorSnapshot();
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/ryu/keys', requireAdmin, async (req, res) => {
  try {
    const { name, key } = req.body || {};
    const snapshot = await ryuKeyManager.addKey({ name, key });
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/ryu/keys/:id', requireAdmin, async (req, res) => {
  try {
    const { name, key, active } = req.body || {};
    const snapshot = await ryuKeyManager.updateKey(req.params.id, { name, key, active });
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/ryu/keys/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body || {};
    const snapshot = await ryuKeyManager.toggleKey(req.params.id, active);
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/ryu/keys/:id', requireAdmin, async (req, res) => {
  try {
    const snapshot = await ryuKeyManager.deleteKey(req.params.id);
    res.json(snapshot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — VERIFY ROLE (sinkron role App ⇄ Discord, webhook, resync, log)
// ══════════════════════════════════════════════════════════════════════════

// Ambil setting saat ini (role mapping, webhook url, dll) + status koneksi bot gateway
app.get('/api/admin/role-sync/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await roleSync.getSettings();
    res.json({ ...settings, gateway: roleSync.getGatewayStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simpan mapping role Discord (gold/platinum → role ID) & webhook URL
app.put('/api/admin/role-sync/settings', requireAdmin, async (req, res) => {
  try {
    const { discordRoleMap, webhookUrl, autoSyncFromDiscord, resetRoleOnLeave } = req.body;
    const updated = await roleSync.updateSettings({ discordRoleMap, webhookUrl, autoSyncFromDiscord, resetRoleOnLeave });
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah pengaturan Verify Role (mapping role Discord / webhook).`,
      meta: { discordRoleMap, autoSyncFromDiscord, resetRoleOnLeave }
    }).catch(() => {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar role yang ada di server Discord (buat dropdown pilih "role mana = Gold/Platinum")
app.get('/api/admin/role-sync/discord-roles', requireAdmin, async (req, res) => {
  try {
    const roles = await roleSync.getGuildRoles();
    // Buang @everyone & role yang dikelola bot lain (managed) — gak relevan buat dipilih manual
    const filtered = (roles || [])
      .filter(r => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.color }));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kirim pesan test ke webhook yang lagi disetel
app.post('/api/admin/role-sync/test-webhook', requireAdmin, async (req, res) => {
  try {
    const result = await roleSync.sendTestWebhook();
    if (!result.sent) return res.status(400).json({ error: 'Gagal kirim webhook. Cek lagi URL webhook-nya.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full resync 2 arah — app_to_discord (dorong semua role app ke Discord) atau
// discord_to_app (tarik role Discord aktual jadi role app). Dipakai sekali pas
// awal setup fitur ini, atau kalau dicurigai ada yang "kesenggol" manual & out-of-sync.
app.post('/api/admin/role-sync/resync', requireAdmin, async (req, res) => {
  try {
    const { direction } = req.body;
    if (!['app_to_discord', 'discord_to_app'].includes(direction)) {
      return res.status(400).json({ error: 'direction harus app_to_discord atau discord_to_app.' });
    }
    const summary = await roleSync.fullResync(direction);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Log histori perubahan role (dari admin, dari Discord, atau karena keluar server)
app.get('/api/admin/role-sync/logs', requireAdmin, async (req, res) => {
  try {
    const rows = await db.collection('roleSyncLogs').find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const keyDoc = await hubcapKeyManager.getActiveKey();
  if (!keyDoc) return { configured: false, hasManifest: null, sizeBytes: null };
  const url = `${HUBCAP_BASE_URL}/api/v1/lua/${encodeURIComponent(appId)}`;
  const headers = { Authorization: `Bearer ${keyDoc.key}` };

  // 1) Coba HEAD dulu (paling hemat kuota kalau didukung)
  try {
    const headRes = await axios.head(url, { headers, timeout: 10000, validateStatus: () => true });
    if (headRes.status === 200) {
      await hubcapKeyManager.markSuccess(keyDoc);
      const len = headRes.headers['content-length'];
      return { configured: true, hasManifest: true, sizeBytes: len ? Number(len) : null };
    }
    if (headRes.status === 404) { await hubcapKeyManager.markSuccess(keyDoc); return { configured: true, hasManifest: false, sizeBytes: null }; }
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
    if (status === 200) { await hubcapKeyManager.markSuccess(keyDoc); return { configured: true, hasManifest: true, sizeBytes: len ? Number(len) : null }; }
    if (status === 404) { await hubcapKeyManager.markSuccess(keyDoc); return { configured: true, hasManifest: false, sizeBytes: null }; }
    if (status === 401 || status === 403) {
      await hubcapKeyManager.markLimited(keyDoc, `HTTP ${status} saat cek manifest App ID ${appId}`);
      return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: API key tidak valid/ditolak (401/403).' };
    }
    if (status === 429) {
      await hubcapKeyManager.markLimited(keyDoc, `HTTP 429 saat cek manifest App ID ${appId}`);
      return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: kuota harian API key habis (429).' };
    }
    await hubcapKeyManager.markError(keyDoc, `HTTP ${status} saat cek manifest App ID ${appId}`);
    return { configured: true, hasManifest: null, sizeBytes: null, error: `hubcapmanifest: HTTP ${status}` };
  } catch (e2) {
    await hubcapKeyManager.markError(keyDoc, e2.message || 'Gagal dihubungi');
    return { configured: true, hasManifest: null, sizeBytes: null, error: 'hubcapmanifest: gagal dihubungi.' };
  }
}

// Cek ketersediaan file di Ryu API tanpa full-download — sama seperti checkHubcapManifest,
// GET-stream lalu langsung di-destroy begitu header/status masuk (hemat kuota).
async function checkRyuManifest(appId) {
  const keyDoc = await ryuKeyManager.getActiveKey();
  if (!keyDoc) return { configured: false, hasManifest: null, sizeBytes: null };
  const url = `${RYU_BASE_URL}/api/download/${appId}`;
  try {
    const getRes = await axios.get(url, {
      headers: { 'X-Auth-Key': keyDoc.key },
      timeout: 10000, responseType: 'stream', validateStatus: () => true
    });
    const status = getRes.status;
    const len = getRes.headers['content-length'];
    getRes.data.destroy();
    if (status === 200) { await ryuKeyManager.markSuccess(keyDoc); return { configured: true, hasManifest: true, sizeBytes: len ? Number(len) : null }; }
    if (status === 404) { await ryuKeyManager.markSuccess(keyDoc); return { configured: true, hasManifest: false, sizeBytes: null }; }
    if (status === 401 || status === 403) {
      await ryuKeyManager.markLimited(keyDoc, `HTTP ${status} saat cek App ID ${appId}`);
      return { configured: true, hasManifest: null, sizeBytes: null, error: 'Ryu API: API key tidak valid/ditolak (401/403).' };
    }
    if (status === 429) {
      await ryuKeyManager.markLimited(keyDoc, `HTTP 429 saat cek App ID ${appId}`);
      return { configured: true, hasManifest: null, sizeBytes: null, error: 'Ryu API: kuota harian API key habis (429).' };
    }
    await ryuKeyManager.markError(keyDoc, `HTTP ${status} saat cek App ID ${appId}`);
    return { configured: true, hasManifest: null, sizeBytes: null, error: `Ryu API: HTTP ${status}` };
  } catch (e2) {
    await ryuKeyManager.markError(keyDoc, e2.message || 'Gagal dihubungi');
    return { configured: true, hasManifest: null, sizeBytes: null, error: 'Ryu API: gagal dihubungi.' };
  }
}

app.get('/api/admin/appid-lookup/:appId', requireAdmin, async (req, res) => {
  const appId = String(req.params.appId).trim();
  if (!/^\d+$/.test(appId)) return res.status(400).json({ error: 'App ID harus berupa angka (App ID Steam).' });

  // Provider file/manifest yang mau dicek — 'hubcap' (default, backward compatible)
  // atau 'ryu' (Ryu API, fallback kalau HubCap kehabisan kuota). Nama & foto TETAP
  // dari Steam Store API terlepas dari provider yang dipilih (tidak ada bedanya).
  const provider = req.query.provider === 'ryu' ? 'ryu' : 'hubcap';

  const result = {
    appId,
    provider,
    name: null,
    description: null,
    imageUrl: null,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    manifestUrl: null,
    sizeBytes: null,
    sizeLabel: null,
    hasManifest: null,
    hubcapConfigured: false, // diisi ulang di bawah setelah cek key aktif
    // Deteksi otomatis tipe game (Online/Offline) dari kategori Steam-nya, biar toggle
    // di form admin bisa langsung ke-set default sesuai game aslinya — admin tetap bisa
    // ubah manual kalau deteksinya kurang pas.
    categories: [],
    isOnlineSuggested: null,
    warnings: []
  };

  // 1) Steam Store API (publik) — SAMA untuk kedua provider
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

  // 2) Cek ketersediaan manifest/file & ukurannya di provider yang dipilih
  if (provider === 'ryu') {
    try {
      const rc = await checkRyuManifest(appId);
      result.hubcapConfigured = rc.configured; // nama field dipertahankan (dipakai UI lama) — artinya "provider siap dipakai"
      result.hasManifest = rc.hasManifest;
      result.sizeBytes = rc.sizeBytes;
      result.sizeLabel = formatBytes(rc.sizeBytes);
      if (rc.hasManifest === true) result.manifestUrl = `${RYU_BASE_URL}/api/download/${appId}`;
      if (rc.error) result.warnings.push(rc.error);
      if (rc.configured && rc.hasManifest === false) result.warnings.push('File untuk App ID ini belum tersedia di Ryu API.');
      if (!rc.configured) result.warnings.push('Belum ada API Key Ryu yang aktif (Admin Web > Hubcap API > tab Ryu API) — cek ketersediaan file dilewati.');
    } catch (e) {
      result.warnings.push('Gagal mengecek Ryu API.');
    }
  } else {
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
      if (!hc.configured) result.warnings.push('Belum ada API Key HubCap yang aktif (Admin Web > Hubcap API) — cek ketersediaan manifest & ukuran file dilewati.');
    } catch (e) {
      result.warnings.push('Gagal mengecek hubcapmanifest.');
    }
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
// ══════════════════════════════════════════════════════════════════════════
// REALTIME — periodic scan buat notifikasi "masa aktif hampir habis".
// Jalan tiap 15 menit, cek user Gold/Platinum yang activeUntil-nya kurang dari 24 jam
// lagi dan belum dikasih tau hari ini (ditandai lewat field periodWarnedAt supaya tidak spam).
// ══════════════════════════════════════════════════════════════════════════
async function scanExpiringPeriods() {
  if (!db) return;
  try {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const users = await db.collection('users').find({
      role: { $in: ['gold', 'platinum'] },
      activeUntil: { $ne: null, $lte: soon, $gt: new Date() }
    }).toArray();

    for (const u of users) {
      const alreadyWarnedToday = u.periodWarnedAt &&
        (new Date(u.periodWarnedAt).toDateString() === new Date().toDateString());
      if (alreadyWarnedToday) continue;

      const msLeft = new Date(u.activeUntil).getTime() - Date.now();
      const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));
      await notifyUser(u.discordId, {
        type: 'period_low',
        title: 'Masa Aktif Hampir Habis',
        message: `Masa aktif paket ${u.role.toUpperCase()} kamu tersisa sekitar ${hoursLeft} jam lagi. Perpanjang sekarang biar tidak terputus.`,
        fields: [
          field('👤 Username', u.username, true),
          field('🆔 Discord ID', u.discordId, true),
          field('📦 Paket', u.role.toUpperCase(), true),
          field('⏳ Sisa Masa Aktif', fmtDurationMs(msLeft) || `${hoursLeft} jam`, true),
          field('📅 Berakhir Pada', fmtDateTimeWIB(u.activeUntil), true)
        ],
        dm: true, webhook: true
      });
      await db.collection('users').updateOne({ discordId: u.discordId }, { $set: { periodWarnedAt: new Date() } });
    }
  } catch (e) {
    console.warn('[Realtime] Gagal scan masa aktif hampir habis:', e.message);
  }
}
setInterval(scanExpiringPeriods, 15 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════
// START — http server manual (bukan app.listen langsung) supaya bisa nempelin
// WebSocket server (realtime) di path yang sama tanpa port terpisah.
// ══════════════════════════════════════════════════════════════════════════
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const isAdminConn = url.searchParams.get('admin') === '1';
    if (!token || !JWT_SECRET) { ws.close(4001, 'no token'); return; }
    const payload = jwt.verify(token, JWT_SECRET);

    // ── Koneksi Dashboard Admin ── token admin lama (password bersama, tanpa
    // discordId) ATAU token akun Discord yang role-nya 'admin' di DB.
    if (isAdminConn) {
      (async () => {
        try {
          if (payload.role === 'admin' && !payload.discordId) {
            // token password admin — valid langsung, tidak terikat akun manapun
          } else if (payload.discordId) {
            if (!db) { ws.close(4001, 'db not ready'); return; }
            const user = await db.collection('users').findOne({ discordId: payload.discordId });
            if (!user || user.role !== 'admin') { ws.close(4003, 'not admin'); return; }
          } else {
            ws.close(4001, 'invalid token'); return;
          }

          wsRegisterAdmin(ws);
          ws.send(JSON.stringify({ event: 'connected', data: { ok: true } }));
          ws.on('close', () => wsUnregisterAdmin(ws));
          ws.on('error', () => wsUnregisterAdmin(ws));
          ws.isAlive = true;
          ws.on('pong', () => { ws.isAlive = true; });
        } catch (e) {
          ws.close(4001, 'auth failed');
        }
      })();
      return;
    }

    const discordId = payload.discordId;
    if (!discordId) { ws.close(4001, 'invalid token'); return; }

    wsRegister(discordId, ws);
    ws.send(JSON.stringify({ event: 'connected', data: { ok: true } }));

    // Auto Remove Installed Premium Content — kalau ada job yang nunggak (misal
    // waktu expired app-nya lagi ditutup, atau delay 1h/24h sudah lewat), langsung
    // coba kirim sekarang juga selagi user baru saja online.
    (async () => {
      try {
        if (!db) return;
        const due = await db.collection('premiumCleanups').find({
          discordId, status: 'pending', scheduledAt: { $lte: new Date() }
        }).toArray();
        for (const job of due) await tryDeliverCleanupJob(job).catch(() => {});
      } catch (e) {}
    })();

    ws.on('close', () => wsUnregister(discordId, ws));
    ws.on('error', () => wsUnregister(discordId, ws));
    // heartbeat sederhana biar koneksi mati (mis. laptop sleep) ke-detect & dibersihin
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  } catch (e) {
    ws.close(4001, 'auth failed');
  }
});

// Ping semua koneksi tiap 30 detik; kalau ga jawab 1x ronde berikutnya -> putus.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK — kategori "Error Sistem" (opsional, default OFF). Best-effort,
// sengaja TIDAK process.exit()/crash walau ada error tak tertangani — biar
// sejalan dengan filosofi keseluruhan file ini (kegagalan satu bagian tidak
// boleh menghentikan proses utama). Admin bisa aktifkan lewat Webhook Settings
// kalau mau dapat notif Discord tiap kali ada error semacam ini.
// ══════════════════════════════════════════════════════════════════════════
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
  logActivity({
    type: 'system_error',
    description: `Unhandled Promise Rejection: ${String(reason?.message || reason).slice(0, 200)}`
  }).catch(() => {});
  webhookManager.sendCategoryWebhook('system_error', {
    embed: buildEmbed({
      status: 'error',
      title: 'Unhandled Promise Rejection',
      description: 'Ada promise yang gagal tapi tidak tertangani di server. Proses utama tetap berjalan normal.',
      fields: [field('📝 Pesan Tambahan', '```' + String(reason?.stack || reason).slice(0, 950) + '```', false)],
      thumbnail: APP_LOGO_URL || undefined,
      appName: APP_NAME,
      footerNote: 'Error Sistem'
    })
  }).catch(() => {});
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  logActivity({
    type: 'system_error',
    description: `Uncaught Exception: ${String(err?.message || err).slice(0, 200)}`
  }).catch(() => {});
  webhookManager.sendCategoryWebhook('system_error', {
    embed: buildEmbed({
      status: 'error',
      title: 'Uncaught Exception',
      description: 'Ada error tak tertangani di server. Proses utama tetap berjalan normal (tidak crash).',
      fields: [field('📝 Pesan Tambahan', '```' + String(err?.stack || err).slice(0, 950) + '```', false)],
      thumbnail: APP_LOGO_URL || undefined,
      appName: APP_NAME,
      footerNote: 'Error Sistem'
    })
  }).catch(() => {});
});

// Server SELALU start dulu, DB connect di background.
// Ini penting supaya Railway tidak anggap server crash hanya karena DB lambat konek.
httpServer.listen(PORT, () => {
  console.log(`🚀 ${APP_NAME} backend jalan di port ${PORT} (HTTP + WebSocket realtime di /ws)`);
});

connectDB().catch(e => {
  console.error('❌ Gagal konek MongoDB:', e.message);
});

// Gateway Discord buat fitur Verify Role (Discord→App). Independen dari DB —
// tetap dicoba connect walau MongoDB lagi lambat/gagal, biar gak saling nge-block.
roleSync.startGateway();