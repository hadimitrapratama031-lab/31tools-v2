// ══════════════════════════════════════════════════════════════════════════
// 31 TOOLS — BACKEND
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
const compression = require('compression');

const app = express();
app.use(cors());
// GZIP semua response JSON/HTML/JS (fix "halaman App Customization lambat"
// — GET/PUT config-nya bisa berisi background image (maks 10MB) + logo
// (maks 5MB) sebagai base64 dalam SATU body, jadi ukurannya bisa ~20MB kalau
// keduanya terisi; base64 (teks) terkompresi cukup baik lewat gzip, jadi
// waktu transfer turun signifikan). Berlaku global untuk semua endpoint,
// tidak mengganggu apapun — compression cuma menyusutkan body response
// sebelum dikirim, transparan buat client (browser/axios otomatis decode).
app.use(compression());

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

  // Type 2 = Application Command (slash command) — /setpaket, /cekpaket,
  // /createvoucher (lihat discordSlashCommands.js). ACK deferred+ephemeral
  // dulu (proses aslinya nulis DB + sync Role Discord bisa >3 detik), lalu
  // slashCommands.handleHttpInteraction() yang mengisi jawaban aslinya lewat
  // PATCH .../messages/@original — pola sama persis dengan Auto Order/Ticket
  // di bawah. WAJIB dicek DULU sebelum fallback generik di bawahnya. Pakai
  // `slashCommands?.` (bukan `slashCommands.`) karena modul ini baru
  // di-instansiasi belakangan di file ini — sama seperti pola
  // `discordAutoOrderManager?.` di bawah.
  if (interaction.type === 2 && slashCommands?.isSlashCommandName(interaction.data?.name)) {
    res.json({ type: 5, data: { flags: 64 } });
    slashCommands.handleHttpInteraction(interaction).catch(e => console.error('[SlashCommands] HTTP interaction gagal:', e));
    return;
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

  // Type 3 = Message Component (klik tombol / pilih select menu) — dipakai
  // fitur Auto Order Paket Gold & Platinum (custom_id berawalan "dao_").
  // Discord WAJIB dapat ACK dalam waktu singkat (<3 detik), sedangkan proses
  // sebenarnya (bikin channel Discord + transaksi KlikQRIS) bisa lebih lama
  // dari itu — makanya di sini kita ACK dulu dengan "deferred" (type 5,
  // ephemeral lewat flags:64), lalu discordAutoOrderManager yang mengisi
  // jawaban aslinya belakangan lewat PATCH .../messages/@original (lihat
  // editOriginalResponse() di discordAutoOrderManager.js). Interaction LAIN
  // yang bukan Auto Order tetap jatuh ke ACK generik seperti sebelumnya,
  // TIDAK ada perubahan perilaku untuk fitur yang sudah ada.
  if (interaction.type === 3 && discordAutoOrderManager?.isCustomIdHandled(interaction.data?.custom_id)) {
    res.json({ type: 5, data: { flags: 64 } });
    discordAutoOrderManager.handleInteraction(interaction).catch(e => console.error('[Discord Auto Order] interaction gagal:', e));
    return;
  }

  // Type 3 = Message Component — MODULE BARU: Discord Ticket Management System.
  // Semua tombol ticket (Open Ticket dari Panel, Close Ticket, Rating DM) pakai
  // custom_id berawalan "tkt_". Pola sama seperti Auto Order di atas: ACK
  // deferred (type 5) dulu karena proses aslinya (bikin channel, fetch history
  // buat transcript, dll) bisa lebih dari 3 detik, lalu ticketSystemManager
  // mengisi jawaban aslinya lewat PATCH .../messages/@original.
  if (interaction.type === 3 && ticketSystemManager?.isHandledCustomId(interaction.data?.custom_id)) {
    const ticketCustomId = interaction.data?.custom_id || '';
    // Tombol Rating (bintang di DM) TIDAK boleh di-ACK "deferred" seperti tombol
    // tkt_ lain — Modal Discord ("Feedback (opsional)") WAJIB dibalas LANGSUNG
    // (synchronous, type 9) pada interaction klik tombolnya, jadi dicabang di
    // sini SEBELUM masuk ke alur deferred+handleInteraction di bawah. Tombol
    // tkt_ lainnya (Open/Close Ticket, dll) TIDAK terpengaruh sama sekali.
    if (ticketCustomId.startsWith('tkt_rate_')) {
      return res.json(ticketSystemManager.buildRatingModal(ticketCustomId));
    }
    // Klik "Close Ticket" (custom_id "tkt_close_...") TIDAK LANGSUNG menutup
    // Ticket — dibalas langsung (synchronous, sama pola dengan Modal Rating di
    // atas) dengan pesan konfirmasi berisi tombol "Ya"/"Tidak". Ticket baru
    // benar-benar diproses tutup kalau Staff klik "Ya" (custom_id
    // "tkt_closeyes_...", custom_id BEDA dari "tkt_close_" jadi otomatis jatuh
    // ke alur deferred generik di bawah dan ditangani ticketSystemManager.handleInteraction).
    if (ticketCustomId.startsWith('tkt_close_')) {
      return res.json(ticketSystemManager.buildCloseConfirmMessage(ticketCustomId));
    }
    // Sama seperti "Close Ticket" di atas: klik "Delete Channel" (muncul di
    // pesan "🔒 Ticket Ditutup" untuk Ticket yang sudah Closed) dibalas
    // langsung dengan konfirmasi "Ya"/"Tidak" dulu — channel baru benar-benar
    // dihapus kalau Staff klik "Ya" (custom_id "tkt_delyes_...").
    if (ticketCustomId.startsWith('tkt_delchannel_')) {
      return res.json(ticketSystemManager.buildDeleteConfirmMessage(ticketCustomId));
    }
    res.json({ type: 5, data: { flags: 64 } });
    ticketSystemManager.handleInteraction(interaction).catch(e => console.error('[Ticket System] interaction gagal:', e));
    return;
  }

  // Type 5 = MODAL_SUBMIT — dipakai form Feedback Rating ("tkt_ratemodal_...")
  // yang muncul lewat buildRatingModal() di atas. Pola ACK sama seperti Message
  // Component: deferred (type 5) dulu, baru diisi lewat PATCH .../messages/@original
  // oleh ticketSystemManager.handleInteraction (lihat editOriginal() di sana).
  if (interaction.type === 5 && ticketSystemManager?.isHandledCustomId(interaction.data?.custom_id)) {
    res.json({ type: 5, data: { flags: 64 } });
    ticketSystemManager.handleInteraction(interaction).catch(e => console.error('[Ticket System] interaction gagal:', e));
    return;
  }

  // Type lain (component/autocomplete/modal) — ACK generik dulu
  res.json({ type: 1 });
});

// Limit dinaikkan dari default 100kb -> 8mb SUPAYA banner bertipe "Image" bisa upload
// gambar sebagai base64 (data URI) langsung lewat body JSON (lihat ADMIN — BANNER
// CAROUSEL di bawah). Ukuran gambar aslinya sendiri tetap dibatasi lebih ketat
// (BANNER_MAX_IMAGE_BYTES) di handler, ini cuma pagar atas di level parser.
// HARDENING (App Customization image upload): background image (maks 10MB
// asli, MAX_IMAGE_BYTES di appCustomizationManager.js) + logo (maks 5MB
// asli, LOGO_MAX_BYTES — dinaikkan dari 1MB atas permintaan) dikirim sebagai
// base64 data URI dalam SATU body PUT /api/admin/app-customization, dan
// base64 membengkak ±33% dari ukuran file asli (10MB -> ~13.3MB, 5MB ->
// ~6.7MB). Kalau KEDUANYA diganti bersamaan (worst case) plus overhead JSON,
// total body bisa sampai ~20MB — mepet/lewat limit lama (20mb). Dinaikkan
// ke 26mb untuk kasih headroom aman kalau background & logo di-upload
// sekaligus. TIDAK mengubah endpoint/behaviour lain (limit ini global, sudah
// dipakai endpoint lain juga sebelum perubahan ini).
app.use(express.json({ limit: '26mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // admin.html, admin.js, dll

const PORT = process.env.PORT || 3000;
// Dibersihkan dari trailing slash — env var SERVER_URL di Railway kadang
// kepencet/ke-copy-paste dengan "/" nyangkut di akhir, yang bikin semua link
// gabungan (`${SERVER_URL}/auth/discord`, webhook URL, dst) jadi dobel slash
// ("...railway.app//auth/discord"). Distrip di sini sekali supaya tidak perlu
// dijaga manual di tiap tempat pemakaian.
const SERVER_URL = (process.env.SERVER_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const JWT_SECRET = process.env.JWT_SECRET;
const APP_NAME = process.env.APP_NAME || '31 Tools';

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
// PESAN GENERIK buat SEMUA hal yang bisa dilihat USER (notifikasi in-app, DM
// Discord, webhook, popup error) — nama provider internal (HubCap, Ryu/Ryuu)
// TIDAK BOLEH pernah muncul di sini. Nama itu cuma boleh muncul di Admin Web
// (halaman Hubcap API/Ryu API, dan Logs — keduanya admin-only, tidak pernah
// diakses/dilihat user biasa). Detail teknis provider mana yang dipakai/gagal
// tetap lengkap dicatat lewat logActivity()/hubcapKeyManager/ryuKeyManager
// seperti biasa, cuma TIDAK ikut dikirim ke user lewat res.json/notifyUser/webhook.
// ══════════════════════════════════════════════════════════════════════════
const GENERIC_DOWNLOAD_ERROR_MSG = 'Download Server sedang mengalami gangguan. Coba lagi dalam beberapa saat.';
const GENERIC_BUSY_ERROR_MSG = 'Download Server sedang sibuk, coba lagi sebentar lagi.';

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

// Voucher Paket Gold/Platinum — lihat voucherManager.js. Modul ini cuma ngurus
// data voucher + logika klaim yang aman dari race condition; efek ke akun user
// (ubah role/masa aktif/notifikasi) tetap di server.js (lihat POST /api/voucher/claim).
const voucherManager = require('./voucherManager')({ getDb: () => db });

// Upgrade Paket (Gold/Platinum) via KlikQRIS — lihat packageManager.js (harga/masa
// aktif/benefit/limit paket, diatur Admin Web), klikqrisManager.js (client API
// KlikQRIS), dan transactionManager.js (riwayat & status transaksi). Rute-rute
// pakai ini ada di bagian "UPGRADE PAKET (KLIKQRIS)" di bawah.
const packageManager = require('./packageManager')({ getDb: () => db });

// Gold Trial — paket Gold gratis 1x/akun khusus member Discord baru, lihat
// goldTrialManager.js buat settings/validasi/klaim (pola sama seperti voucher).
const goldTrialManager = require('./goldTrialManager')({ getDb: () => db });
const klikqrisManager = require('./klikqrisManager')({ getDb: () => db });
const transactionManager = require('./transactionManager')({ getDb: () => db });

// Auto Order Paket Gold & Platinum via Discord Bot — lihat discordAutoOrderManager.js.
// Modul ini DIBUAT (require) di sini supaya bisa dipakai duluan oleh middleware
// /api/discord/interactions di atas, tapi baru benar-benar di-INSTANSIASI (dipanggil
// sebagai function) di bawah, SETELAH activateCompletedTransaction/refreshTransactionFromKlikqris/
// cancelPendingTransaction dideklarasikan — karena modul ini butuh memanggil balik
// fungsi-fungsi itu (lihat komentar "INSTANSIASI discordAutoOrderManager" di bawah).
const createDiscordAutoOrderManager = require('./discordAutoOrderManager');
let discordAutoOrderManager = null; // diisi di bawah, setelah dependency-nya siap
// Steam Account Marketplace (collection Mongo: `steamAccounts` &
// `steamAccountOrders`). Data game per akun diambil lewat
// fetchSteamDetailsForAppId (function declaration, di-hoist — didefinisikan
// di bawah, dipakai sistem Auto-Isi Game/Bypass yang sudah ada) — TIDAK ada
// integrasi Steam API baru/paralel.
const steamAccountManager = require('./steamAccountManager')({ getDb: () => db, fetchSteamDetails: (appId) => fetchSteamDetailsForAppId(appId) });
const steamAccountOrderManager = require('./steamAccountOrderManager')({ getDb: () => db });

// Marketplace (Product bundel Game/Bypass, dibeli via KlikQRIS atau di-
// whitelist manual oleh admin) — lihat marketplaceManager.js (produk, relasi
// konten, entitlement) & marketplaceOrderManager.js (order/pembayaran).
// Marketplace TIDAK memakai hierarki role/paket sama sekali untuk kontennya —
// lihat hasCatalogAccess() di bawah.
const marketplaceManager = require('./marketplaceManager')({ getDb: () => db });
const marketplaceOrderManager = require('./marketplaceOrderManager')({ getDb: () => db });

// Website Settings (Landing Page Netlify) — lihat websiteSettingsManager.js.
// Dipakai halaman "Website Settings" Admin Web + rute publik /api/public/* di
// bawah, TIDAK menyentuh sistem App/Admin Web lain yang sudah berjalan.
const websiteSettingsManager = require('./websiteSettingsManager')({ getDb: () => db });

// Welcome Popup (popup selamat datang otomatis untuk user baru) — lihat welcomePopupManager.js
const welcomePopupManager = require('./welcomePopupManager')({ getDb: () => db });
// Profil App (Foto Profil App, Display Name, Username, Bio) — TERPISAH dari
// data Discord (avatarUrl/username Discord tetap hanya identitas akun, lihat
// catatan lengkap di profileManager.js).
const profileManager = require('./profileManager')({
  getDb: () => db,
  sanitizeHtml,
  // FIX: foto profil dulunya ditulis ke disk lokal (public/uploads/avatars) —
  // hilang tiap server di-deploy ulang / exe di-build ulang karena disk itu
  // tidak persisten. Sekarang disimpan di MongoDB (koleksi profilePhotos) dan
  // di-stream lewat route GET /api/profile/photo/:discordId di bawah, jadi
  // ikut persisten sama seperti data lain (role, transaksi, dst). Lihat
  // catatan lengkap di profileManager.js (savePhoto()).
  photoRoutePath: '/api/profile/photo',
  // WAJIB absolute (bukan cuma path relatif) — Admin Web di-serve DARI server
  // yang sama jadi path relatif otomatis "nyambung", tapi App loadnya dari
  // file lokal (bukan dari origin server ini), jadi path relatif seperti
  // "/uploads/avatars/xxx.png" gagal dimuat sama sekali di App (itu penyebab
  // foto profil tampil rusak di App padahal normal di Admin Web).
  serverUrl: SERVER_URL
});
// MODULE BARU — Discord Ticket Management System (Panel, Embed Editor, Bot
// Channel Config, Transcript, Logs, Rating). getDb/broadcastAdmin di-pass
// sebagai getter/reference karena keduanya baru "hidup" nanti setelah baris
// ini dieksekusi (db diisi async, broadcastAdmin didefinisikan di bawah) —
// aman karena hanya dipanggil belakangan lewat closure saat request masuk.
const ticketSystemManager = require('./ticketSystemManager')({
  getDb: () => db,
  broadcastAdmin: (...args) => broadcastAdmin(...args)
});

// MODULE BARU — Live Chat Support (User App <-> Admin Web). Realtime lewat hub
// WebSocket yang sudah ada (wsClients/adminWsClients, wsSendToUser/broadcastAdmin/
// wsBroadcastAll di bawah) — semuanya dirujuk lewat getter/closure karena baru
// benar-benar "hidup" belakangan di file ini, sama persis dengan pola
// ticketSystemManager di atas.
const liveChatManager = require('./liveChatManager')({
  getDb: () => db,
  wsSendToUser: (...args) => wsSendToUser(...args),
  broadcastAdmin: (...args) => broadcastAdmin(...args),
  wsBroadcastAll: (...args) => wsBroadcastAll(...args),
  isUserOnline: (discordId) => wsClients.has(discordId),
  isAdminOnline: () => adminWsClients.size > 0,
  logActivity: (...args) => logActivity(...args),
  // Notifikasi DM ke Admin (Discord Bot) tiap ada pesan BARU dari User —
  // lihat notifyAdminsLiveChatMessage() di bawah. Di-pass sebagai getter/closure
  // sama seperti dependency lain di atas karena fungsinya baru "hidup" belakangan.
  // `message` (objek pesan lengkap) diteruskan apa adanya dari liveChatManager.
  notifyAdminsNewMessage: (message) => notifyAdminsLiveChatMessage(message)
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
    // Tidak ada key HubCap aktif sama sekali — sebelum menyerah, tetap coba Ryu
    // dulu (jaring pengaman tambahan; kasus ini normalnya sudah ditangani lewat
    // pre-flight check di caller /api/games/:id/stream, tapi tetap dijaga di sini
    // juga kalau-kalau fungsi ini suatu saat dipanggil dari jalur lain).
    console.log(`[Download Fallback] Hubcap Failed (App ID ${appId}): Tidak ada API Key HubCap yang aktif`);
    if (await ryuKeyManager.hasActiveKey()) {
      console.log(`[Download Fallback] Switching to Ryu API (App ID ${appId})`);
      logActivity({
        type: 'download_provider_fallback', status: 'warning',
        description: `Auto-fallback: HubCap tidak punya API Key aktif untuk App ID ${appId} — otomatis dialihkan ke Ryu API.`,
        meta: { appId, reason: 'Tidak ada API Key HubCap yang aktif' }
      }).catch(() => {});
      return await streamRyuManifest(appId, res, filenameHint);
    }
    // User-facing — JANGAN sebut nama provider (lihat GENERIC_DOWNLOAD_ERROR_MSG di bawah).
    return res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
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
        timeout: 20000, // HANYA berlaku sampai HEADER RESPONS diterima (perilaku axios untuk
                         // responseType:'stream' — begitu header datang, promise langsung selesai
                         // dan pipe data selanjutnya TIDAK lagi terikat timeout ini). Jadi ini aman:
                         // download file besar tetap tidak kena batas waktu ("file bisa besar,
                         // jangan timeout" tetap terjaga), yang dibatasi cuma "HubCap harus mulai
                         // merespons dalam 20 detik" — kalau tidak, dianggap gagal & fallback ke Ryu.
        maxRedirects: 10
      });
      await hubcapKeyManager.markSuccess(keyDoc);
      console.log(`[Download Fallback] Hubcap Download Success (App ID ${appId})`);
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
    // ══════════════════════════════════════════════════════════════════════
    // AUTOMATIC API FALLBACK (HubCap → Ryu) — HubCap gagal dengan alasan
    // APAPUN yang bikin download tidak bisa dilanjutkan (limit/kuota habis,
    // rate limit, HTTP 429/401/403, HTTP 5xx, timeout, tidak merespons, App ID
    // tidak ketemu di HubCap, atau error lain) → SEBELUM menyerah dan
    // menampilkan error ke user, otomatis coba Ryu API dulu, transparan
    // sepenuhnya (user tetap lihat proses download berjalan normal, tidak ada
    // pilihan/pemberitahuan provider apapun). Ini masih tahap SEBELUM ada byte
    // apapun dikirim ke client (belum ada res.setHeader/pipe di titik ini),
    // jadi 100% aman untuk "ganti provider" tanpa mengganggu/membatalkan
    // proses download yang user lihat.
    // ══════════════════════════════════════════════════════════════════════
    const failReason = lastError?.response
      ? `HTTP ${lastError.response.status}`
      : (lastError?.code === 'ECONNABORTED' ? 'Timeout / tidak merespons' : (lastError?.message || 'Tidak ada API Key HubCap yang aktif'));
    console.log(`[Download Fallback] Hubcap Failed (App ID ${appId}): ${failReason}`);

    const ryuAvailable = await ryuKeyManager.hasActiveKey();
    if (ryuAvailable) {
      console.log(`[Download Fallback] Switching to Ryu API (App ID ${appId})`);
      logActivity({
        type: 'download_provider_fallback', status: 'warning',
        description: `Auto-fallback: HubCap gagal untuk App ID ${appId} (${failReason}) — otomatis dialihkan ke Ryu API, proses download user tidak terganggu/dibatalkan.`,
        meta: { appId, reason: failReason }
      }).catch(() => {});
      return await streamRyuManifest(appId, res, filenameHint);
    }
    console.log(`[Download Fallback] Ryu API tidak tersedia (tidak ada key aktif) — App ID ${appId} gagal total, tampilkan error ke user.`);

    // Semua pesan di bawah ini USER-FACING (dikirim balik ke app) — WAJIB generik,
    // detail teknis provider-nya tetap lengkap di Admin Web > Logs (via markLimited/markError
    // di atas), bukan di response ini.
    if (lastError?.response) {
      const s = lastError.response.status;
      if (s === 429) return res.status(429).json({ error: GENERIC_BUSY_ERROR_MSG });
      if (s === 401 || s === 403) return res.status(401).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
      if (s === 404) return res.status(404).json({ error: `Game dengan App ID ${appId} belum tersedia di server.` });
    }
    return res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
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
    return res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
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
      if (ryuRes.status === 200) { await ryuKeyManager.markSuccess(keyDoc); console.log(`[Download Fallback] Ryu Download Success (App ID ${appId})`); break; }
      // Baca sedikit body buat pesan error yang informatif (Ryu balikin JSON kecil kayak {"error":"..."})
      // — pesan mentahnya CUMA dipakai buat log internal (markLimited/markError), TIDAK pernah
      // diteruskan langsung ke user (lihat blok `if (!ryuRes)` di bawah yang sudah generik).
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
    console.log(`[Download Fallback] Ryu Download Failed (App ID ${appId}): ${lastError?.status ? `HTTP ${lastError.status}` : (lastError?.message || 'Tidak diketahui')}`);
    // User-facing — generik semua, gak peduli status code-nya apa.
    const s = lastError?.status;
    if (s === 429) return res.status(429).json({ error: GENERIC_BUSY_ERROR_MSG });
    if (s === 401 || s === 403) return res.status(401).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
    if (s === 404) return res.status(404).json({ error: `Game dengan App ID ${appId} belum tersedia di server.` });
    return res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
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

// CATALOG_ROLES = daftar status akses yang admin boleh pilih untuk Game/Bypass
// (dipakai buat validasi input Admin Web) — beda dari ROLE_LEVEL yang khusus
// buat hierarki paket akun.
const CATALOG_ROLES = ['public', 'gold', 'platinum'];

// Cek apakah `user` boleh akses `item` (Game/Bypass).
//
// DUA JALUR AKSES YANG SALING EKSKLUSIF PER ITEM:
//   1) Item TERHUBUNG ke satu/lebih Marketplace Product (field
//      `marketplaceProductIds` diisi otomatis oleh marketplaceManager saat
//      admin "Tambah Game/Bypass" di halaman Kelola Konten Product) —
//      role/paket (public/gold/platinum) TIDAK BERLAKU SAMA SEKALI untuk item
//      ini. Akses HANYA dari PEMBELIAN atau WHITELIST produk terkait.
//   2) Item BUKAN konten Marketplace — pakai hierarki ROLE_LEVEL seperti biasa.
// Admin selalu bisa akses apapun.
// CATATAN: fungsi ini ASYNC (butuh query DB untuk jalur Marketplace) — semua
// pemanggil di server.js WAJIB `await`.
async function hasCatalogAccess(user, item) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (Array.isArray(item.marketplaceProductIds) && item.marketplaceProductIds.length) {
    return marketplaceManager.hasAnyProductAccess(user.discordId, item.marketplaceProductIds);
  }
  const myLevel   = ROLE_LEVEL[user.role] ?? 0;
  const itemLevel = ROLE_LEVEL[item.role] ?? 0;
  return myLevel >= itemLevel;
}

// Bentuk body 403 yang tepat tergantung jenis gerbang item ini — Marketplace
// (butuh beli/whitelist Product tertentu, App mengarahkan ke halaman Product)
// vs role/paket biasa (App mengarahkan ke Upgrade Paket). Dipakai di semua
// endpoint download/stream Game & Bypass supaya pesannya konsisten dan App
// tahu cara paling tepat mengarahkan user (requirement #14).
function catalogAccessDeniedPayload(item) {
  if (Array.isArray(item.marketplaceProductIds) && item.marketplaceProductIds.length) {
    return {
      error: 'Tidak ada akses — Silakan beli product terlebih dahulu.',
      reason: 'marketplace_required',
      marketplaceProductIds: item.marketplaceProductIds
    };
  }
  return { error: `Item ini membutuhkan paket ${item.role}. Upgrade paket kamu dulu.`, reason: 'package_required' };
}

// Versi SYNC dari hasCatalogAccess() di atas, dipakai endpoint LISTING
// (/api/games, /api/bypasses) yang me-render banyak item sekaligus. Alih-alih
// query DB per item (N+1 query kalau dipakai dalam .map()), pemanggil
// mengambil SATU set productId yang dipunyai user sekali di awal
// (marketplaceManager.getOwnedProductIdSet) lalu dipakai lintas semua item.
function hasCatalogAccessSync(user, item, ownedProductIds) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (Array.isArray(item.marketplaceProductIds) && item.marketplaceProductIds.length) {
    return item.marketplaceProductIds.some(pid => ownedProductIds.has(String(pid)));
  }
  const myLevel   = ROLE_LEVEL[user.role] ?? 0;
  const itemLevel = ROLE_LEVEL[item.role] ?? 0;
  return myLevel >= itemLevel;
}

// Item Game/Bypass ini konten Product Marketplace atau bukan — pakai relasi yang
// SAMA PERSIS dipakai hasCatalogAccess/hasCatalogAccessSync di atas untuk gerbang
// akses (field `marketplaceProductIds`), supaya tidak ada 2 sumber kebenaran.
// Dipakai buat requirement: download Game/Bypass yang merupakan konten Product
// Marketplace TIDAK dihitung ke kuota/limit download harian, sedangkan Game/Bypass
// biasa (bukan konten Product manapun) tetap pakai kuota harian seperti biasa.
function isMarketplaceCatalogItem(item) {
  return !!(item && Array.isArray(item.marketplaceProductIds) && item.marketplaceProductIds.length);
}

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
// Nilai di bawah cuma DEFAULT AWAL (sebelum pengaturan paket pernah disimpan
// dari Admin Web / sebelum koneksi DB siap). Begitu DB konek, nilainya langsung
// ditimpa (dan terus di-refresh realtime tiap Admin ganti limit lewat halaman
// "Upgrade Paket") oleh refreshDownloadLimits() di bawah — lihat packageManager.js.
// Sengaja tetap `const` (isi objeknya yang dimutasi via Object.assign), supaya
// SEMUA tempat yang sudah baca `DOWNLOAD_LIMITS[user.role]` otomatis dapat nilai
// terbaru tanpa perlu diubah satu-satu jadi async.
const DOWNLOAD_LIMITS = {
  public:   { game: 3, bypass: 3 },
  gold:     { game: 4, bypass: 4 },
  platinum: { game: Infinity, bypass: Infinity },
  admin:    { game: Infinity, bypass: Infinity }
};

// Dipanggil sekali pas server start & tiap kali Admin simpan perubahan di halaman
// "Upgrade Paket" (PUT /api/admin/packages/:tier) — best-effort, kalau gagal
// (mis. DB belum siap) limit lama (default di atas) tetap dipakai sementara.
async function refreshDownloadLimits() {
  try {
    const limits = await packageManager.getDownloadLimits();
    Object.assign(DOWNLOAD_LIMITS.public, limits.public);
    Object.assign(DOWNLOAD_LIMITS.gold, limits.gold);
    Object.assign(DOWNLOAD_LIMITS.platinum, limits.platinum);
    Object.assign(DOWNLOAD_LIMITS.admin, limits.admin);
  } catch (e) {
    console.warn('[Upgrade Paket] Gagal refresh DOWNLOAD_LIMITS:', e.message);
  }
}

// Tanggal hari ini di zona WIB (Asia/Jakarta), format YYYY-MM-DD. Dipakai buat reset
// counter limit download tiap ganti hari — sengaja BUKAN tanggal UTC server (Railway
// dkk biasanya UTC), biar "sehari" yang dimaksud sesuai jam Indonesia.
function todayDateStrJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // 'en-CA' -> 'YYYY-MM-DD'
}

// Limit download efektif buat user ini — SAMA seperti DOWNLOAD_LIMITS[user.role]
// untuk semua kasus normal, KECUALI kalau user lagi Gold Trial aktif (isGoldTrial
// + trialLimits tersimpan di user doc pas klaim, lihat POST /api/gold-trial/claim)
// -> pakai limit Trial (diatur admin lewat halaman Gold Trial Settings, BISA beda
// dari limit paket Gold biasa). Sengaja HANYA override di sini (bukan ubah isi
// DOWNLOAD_LIMITS.gold) supaya user Gold biasa (bukan trial) TIDAK ikut terpengaruh.
function effectiveDownloadLimits(user) {
  if (user.isGoldTrial && user.trialLimits) {
    const toLimit = (v) => (v === null || v === undefined ? Infinity : v);
    return { game: toLimit(user.trialLimits.game), bypass: toLimit(user.trialLimits.bypass) };
  }
  return DOWNLOAD_LIMITS[user.role] || DOWNLOAD_LIMITS.public;
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

  // PENTING (fix race condition "upgrade jadi Public"): fungsi ini dipanggil di
  // SETIAP request berautentikasi (lihat pemanggilnya), jadi bisa saja jalan
  // BARENGAN dengan activateCompletedTransaction() saat user lagi upgrade paket
  // (mis. dari Gold/Gold Trial yang activeUntil-nya sudah/hampir lewat -> beli
  // Platinum). Kalau kita cuma updateOne({discordId}, {$set:{role:'public'}})
  // tanpa syarat, ada celah: request ini baca user versi LAMA (role gold,
  // activeUntil lewat) sebelum transaksi upgrade selesai commit, lalu update
  // "downgrade ke public" ini baru nge-commit SETELAH upgrade selesai menulis
  // role:'platinum' -> hasilnya nimpa balik jadi 'public' walau upgrade sukses.
  //
  // Perbaikannya: jadikan atomic & bersyarat (findOneAndUpdate dengan filter
  // role & activeUntil PERSIS seperti yang barusan kita baca) — pola yang sama
  // seperti transitionFromPending() di transactionManager.js. Kalau di antara
  // baca & tulis ini ternyata role/activeUntil user SUDAH berubah (mis. baru
  // saja diupgrade), filter-nya tidak match, update ini jadi no-op, dan status
  // upgrade yang baru TIDAK tertimpa.
  const result = await db.collection('users').findOneAndUpdate(
    { discordId, role: user.role, activeUntil: user.activeUntil },
    { $set: { role: 'public', roleUpdatedAt: new Date(), activeUntil: null, isGoldTrial: false, trialLimits: null } },
    { returnDocument: 'after' }
  );
  const updatedDoc = result && typeof result === 'object' && 'value' in result ? result.value : result;
  if (!updatedDoc) {
    // Tidak match -> user sudah diubah proses lain (mis. upgrade) sejak dibaca.
    // Jangan lanjutkan efek downgrade (Discord sync/notif/log) sama sekali,
    // cukup kembalikan data user yang PALING BARU dari DB.
    const latest = await db.collection('users').findOne({ discordId });
    console.log(`[Masa Aktif] Auto-downgrade ${discordId} dibatalkan (race terdeteksi) — role sudah berubah jadi '${latest?.role}' sejak dibaca (waktu baca: role='${oldRole}', activeUntil=${user.activeUntil}). Kemungkinan upgrade paket sedang berlangsung.`);
    return latest;
  }

  // Best-effort: sinkron Discord + log. Jangan sampai gagalnya nge-block request user.
  try {
    const discordSync = await roleSync.syncAppRoleToDiscord(discordId, 'public');
    await roleSync.logRoleChange({
      discordId, username, oldRole, newRole: 'public',
      source: 'expired', discordSync,
      note: 'Masa aktif habis, otomatis diturunkan ke Gratis.',
      // notifyUser(type:'period_expired', webhook:true) di bawah SUDAH mengirim
      // webhook kategori "Paket Berakhir" yang lengkap (badge/footer konsisten) —
      // skip webhook legacy di sini supaya event ini tidak jadi 2 pesan Discord.
      skipWebhook: true
    });
  } catch (e) {
    console.warn('[Masa Aktif] Gagal sinkron/log saat auto-downgrade:', e.message);
  }

  const updated = await db.collection('users').findOne({ discordId });

  notifyUser(discordId, {
    type: 'period_expired',
    title: 'Masa Aktif Berakhir',
    message: `Masa aktif paket ${roleLabelUpper(oldRole)} kamu telah berakhir dan otomatis diturunkan ke Gratis.`,
    dm: true, webhook: true,
    packageCard: {
      event: 'expired',
      description: `Paket ${roleLabelUpper(oldRole)} sudah berakhir dan otomatis diturunkan ke Gratis.`,
      username,
      role: oldRole,
      activeLabel: 'Berakhir',
      activeUntil: user.activeUntil || new Date(),
      status: '🔴 EXPIRED'
    }
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
  const limits = effectiveDownloadLimits(user);
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

// ══════════════════════════════════════════════════════════════════════════
// DOWNLOAD ATTEMPT TRACKING — sistem baru supaya limit download harian HANYA
// berkurang setelah download+instalasi BENAR-BENAR sukses, bukan saat user
// baru klik/mulai download. Lihat juga /api/downloads/failed & POST /api/history.
//
// Alur:
//  1. User klik download -> endpoint /api/games|bypasses/:id/download* memanggil
//     peekDownloadQuota() (CUMA BACA, tidak mengurangi apapun) untuk pastikan
//     kuota masih ada, lalu createDownloadAttempt() bikin 1 dokumen status
//     'started' (log: Download Started) dan attemptId-nya dikirim ke client.
//  2. Kalau download/extract/install GAGAL atau user cancel di App -> client
//     panggil POST /api/downloads/failed dengan attemptId -> status diubah
//     'failed'/'cancelled', log Download Failed/Install Failed, KUOTA TIDAK
//     DISENTUH SAMA SEKALI (karena memang belum pernah dikurangi).
//  3. Kalau BENAR-BENAR sukses (App sudah selesai extract+copy+inject) -> client
//     panggil POST /api/history dengan attemptId -> BARU di titik inilah kuota
//     dikurangi (via consumeAttemptQuota, idempotent lewat flag quotaConsumed
//     supaya walau request-nya kekirim dobel/retry, limit CUMA berkurang 1x).
// ══════════════════════════════════════════════════════════════════════════

// Cek kuota TANPA mengurangi apapun — dipakai saat user baru MULAI proses download,
// supaya kita bisa langsung tolak kalau memang sudah habis, tanpa "membakar" limit
// untuk percobaan yang belum tentu berhasil.
function peekDownloadQuota(user, type) {
  const limits = effectiveDownloadLimits(user);
  const limit = limits[type];
  if (limit === Infinity) return { ok: true, limit: null, used: null, remaining: null };

  const today = todayDateStrJakarta();
  const usage = (user.downloadUsage && user.downloadUsage.date === today)
    ? user.downloadUsage
    : { date: today, game: 0, bypass: 0 };

  const used = usage[type] || 0;
  if (used >= limit) {
    return {
      ok: false, limit, used,
      message: `Limit download harian untuk ${type === 'game' ? 'Game' : 'Bypass'} (${limit}x/hari) sudah tercapai. Coba lagi besok atau upgrade paket kamu.`
    };
  }
  return { ok: true, limit, used, remaining: limit - used };
}

// Bikin 1 dokumen percobaan download baru (status 'started') + log "Download Started".
// TIDAK menyentuh kuota. Dipanggil di awal SETIAP proses download (game/bypass).
// `isMarketplaceItem` (di-snapshot dari isMarketplaceCatalogItem(item) SAAT attempt
// dibuat) menentukan apakah consumeAttemptQuota() nanti (dipanggil dari POST
// /api/history setelah install sukses) BOLEH mengurangi kuota harian atau tidak —
// item konten Product Marketplace TIDAK PERNAH mengurangi kuota sama sekali.
async function createDownloadAttempt(user, itemType, itemId, itemName, itemImage, isMarketplaceItem = false) {
  const doc = {
    discordId: user.discordId,
    username: user.username,
    itemType, // 'game' | 'bypass'
    itemId: String(itemId),
    itemName: itemName || null,
    itemImage: itemImage || null,
    status: 'started', // started -> installed | failed | cancelled
    quotaConsumed: false,
    isMarketplaceItem: !!isMarketplaceItem,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const result = await db.collection('downloadAttempts').insertOne(doc);

  logActivity({
    type: 'download_started',
    username: user.username,
    discordId: user.discordId,
    role: user.role,
    status: 'info',
    description: `${user.username} memulai download ${itemType === 'game' ? 'game' : 'bypass'} "${itemName || 'item'}".`,
    meta: { itemType, itemId: String(itemId), attemptId: String(result.insertedId) }
  }).catch(() => {});

  return { _id: result.insertedId, ...doc };
}

// Dipanggil HANYA dari POST /api/history (yaitu SETELAH App melaporkan install-nya
// sukses) — di titik inilah kuota BARU boleh berkurang. Idempotent: pakai
// findOneAndUpdate dengan filter quotaConsumed:false supaya walau dipanggil
// berkali-kali (retry jaringan, dsb) untuk attemptId yang sama, limit CUMA
// berkurang SATU KALI.
async function consumeAttemptQuota(user, attemptId, itemType, item) {
  if (!attemptId || !ObjectId.isValid(attemptId)) {
    // Tidak ada attemptId (mis. client versi lama) — fallback ke perilaku lama
    // (langsung konsumsi saat ini), lebih baik daripada tidak mengurangi sama sekali.
    // Tetap hormati pengecualian Marketplace kalau data item-nya kebetulan tersedia
    // di pemanggil (lihat POST /api/history), supaya konten Product Marketplace
    // tetap tidak kena potong kuota walau lewat jalur fallback ini.
    if (isMarketplaceCatalogItem(item)) {
      return { consumed: false, quota: { ok: true, limit: null, used: null, remaining: null, marketplace: true }, attempt: null };
    }
    const quota = await consumeDownloadQuota(user, itemType);
    return { consumed: quota.ok, quota, attempt: null };
  }

  const claim = await db.collection('downloadAttempts').findOneAndUpdate(
    { _id: new ObjectId(attemptId), discordId: user.discordId, quotaConsumed: false },
    { $set: { quotaConsumed: true, status: 'installed', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );

  const attempt = claim && claim.value ? claim.value : claim; // driver version compat
  if (!attempt) {
    // Sudah pernah dikonsumsi sebelumnya (retry) ATAU attemptId tidak valid/bukan
    // milik user ini -> JANGAN kurangi kuota lagi (mencegah pengurangan dobel).
    return { consumed: false, quota: null, attempt: null, alreadyConsumed: true };
  }

  // Item konten Product Marketplace (di-snapshot saat attempt dibuat, lihat
  // createDownloadAttempt) -> TIDAK PERNAH mengurangi/menambah kuota download
  // harian sama sekali, walau download+install-nya sukses. Akses sudah tervalidasi
  // lewat purchase/whitelist Product (hasCatalogAccess), bukan lewat kuota harian.
  if (attempt.isMarketplaceItem) {
    return {
      consumed: false,
      quota: { ok: true, limit: null, used: null, remaining: null, marketplace: true },
      attempt
    };
  }

  const quota = await consumeDownloadQuota(user, itemType);
  return { consumed: quota.ok, quota, attempt };
}

// Dipanggil dari POST /api/downloads/failed — menandai attempt sebagai gagal/batal.
// TIDAK PERNAH menyentuh kuota (memang belum pernah dikurangi di titik ini).
async function markDownloadAttemptFailed(user, attemptId, status) {
  if (!attemptId || !ObjectId.isValid(attemptId)) return null;
  const result = await db.collection('downloadAttempts').findOneAndUpdate(
    { _id: new ObjectId(attemptId), discordId: user.discordId },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return result && result.value ? result.value : result;
}

// Ringkasan masa aktif & limit download user — dipakai di /api/me (app) & Manajemen
// Users (admin panel) biar kelihatan jelas tanpa perlu itung manual di frontend.
function accountStatusSummary(user) {
  const limits = effectiveDownloadLimits(user);
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
    // Dipakai App buat bedain badge "Gold Trial" dari Gold biasa di renderPackageCard()
    // (tidak ada lagi banner/halaman terpisah, jadi ini satu-satunya indikator sisa
    // trial di UI selain popup sekali-login) — true kalau BENERAN masih dalam masa trial.
    isGoldTrial: !!(user.isGoldTrial && hasActivePeriod && user.activeUntil && new Date(user.activeUntil) > new Date()),
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
//
// FIX (Live Chat realtime): ws.send() sekarang dibungkus try/catch — koneksi yang
// "setengah mati" (client belum sempat terdeteksi putus oleh heartbeat ping/pong 30
// detik, misal laptop baru bangun dari sleep) sebelumnya bisa membuat send() melempar
// error yang TIDAK tertangkap, sampai ikut menggagalkan request admin (mis. balasan
// Live Chat gagal terkirim). Socket yang gagal kirim langsung dibuang dari Set supaya
// tidak dicoba lagi.
function wsSendToUser(discordId, event, data) {
  const set = wsClients.get(discordId);
  if (!set || set.size === 0) return false;
  const payload = JSON.stringify({ event, data });
  let sent = false;
  for (const ws of Array.from(set)) {
    if (ws.readyState !== WebSocket.OPEN) { set.delete(ws); continue; }
    try { ws.send(payload); sent = true; }
    catch (e) { set.delete(ws); }
  }
  if (set.size === 0) wsClients.delete(discordId);
  return sent;
}
// Broadcast ke SEMUA user yang sedang terkoneksi (dipakai buat pengumuman admin).
function wsBroadcastAll(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const set of wsClients.values()) {
    for (const ws of Array.from(set)) {
      if (ws.readyState !== WebSocket.OPEN) { set.delete(ws); continue; }
      try { ws.send(payload); } catch (e) { set.delete(ws); }
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
  for (const ws of Array.from(adminWsClients)) {
    if (ws.readyState !== WebSocket.OPEN) { adminWsClients.delete(ws); continue; }
    try { ws.send(payload); } catch (e) { adminWsClients.delete(ws); }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOG CATALOG — SATU-SATUNYA sumber kebenaran untuk SEMUA jenis log sistem:
// icon, label (Bahasa Indonesia, dipakai di halaman Logs & Aktivitas Terbaru),
// kategori (buat pengelompokan filter di halaman Logs), dan status default
// (dipakai kalau logActivity() dipanggil tanpa `status` eksplisit).
// Beberapa key ditandai `reserved: true` — jenis log ini BELUM punya fitur
// nyata di aplikasi (contoh: Voucher & Paket lama belum jadi entity terpisah
// waktu awal ditulis). "Request Game" SUDAH jadi fitur nyata (lihat bagian
// REQUEST GAME di bawah file ini) jadi sudah tidak reserved lagi.
// ══════════════════════════════════════════════════════════════════════════
const LOG_CATALOG = {
  login:                 { label: 'Login User',                icon: '🔑', category: 'auth',       status: 'success' },
  logout:                { label: 'Logout User',                icon: '🚪', category: 'auth',       status: 'info' },
  admin_login:           { label: 'Login Admin',                 icon: '🛡️', category: 'auth',       status: 'success' },
  admin_logout:          { label: 'Logout Admin',                 icon: '🚪', category: 'auth',       status: 'info' },
  install:               { label: 'Install Game/Bypass Berhasil', icon: '⬇️', category: 'app',        status: 'success' },
  download_failed:       { label: 'Install/Download Gagal',       icon: '⚠️', category: 'app',        status: 'error' },
  download:              { label: 'Download Game',                icon: '📥', category: 'app',        status: 'success' },
  active_tools_use:      { label: 'Penggunaan Active Tools',       icon: '🔧', category: 'app',        status: 'success' },
  cloud_fix_use:         { label: 'Penggunaan Cloud FIX',          icon: '☁️', category: 'app',        status: 'success' },
  request_game:          { label: 'Request Game',                 icon: '🎯', category: 'app',        status: 'info' },
  request_game_approved: { label: 'Approve Request Game',         icon: '✅', category: 'catalog',    status: 'success' },
  request_game_rejected: { label: 'Reject Request Game',          icon: '❌', category: 'catalog',    status: 'warning' },
  set_paket:             { label: 'Set Paket User',                icon: '📦', category: 'billing',    status: 'success' },
  purchase:              { label: 'Pembelian Paket',                icon: '💳', category: 'billing',    status: 'success' },
  renewal:                { label: 'Perpanjangan Paket',             icon: '🔄', category: 'billing',    status: 'success' },
  transaction_completed:  { label: 'Transaksi Selesai (KlikQRIS)',    icon: '💳', category: 'billing',    status: 'success' },
  transaction_failed:     { label: 'Pembayaran Gagal (KlikQRIS)',     icon: '❌', category: 'billing',    status: 'error' },
  daily_quota_reset:      { label: 'Reset Limit Harian Otomatis',    icon: '♻️', category: 'system',     status: 'success' },
  livechat_purge:         { label: 'Auto Delete Live Chat',           icon: '💬', category: 'system',     status: 'success' },
  voucher_create:          { label: 'Buat Voucher',                     icon: '🎟️', category: 'billing',    status: 'success' },
  voucher_edit:            { label: 'Edit Voucher',                     icon: '✏️', category: 'billing',    status: 'success' },
  voucher_delete:          { label: 'Hapus Voucher',                    icon: '🗑️', category: 'billing',    status: 'warning' },
  voucher_toggle:          { label: 'Aktif/Nonaktifkan Voucher',        icon: '🔁', category: 'billing',    status: 'success' },
  voucher_claim_success:   { label: 'Claim Voucher Berhasil',           icon: '🎟️', category: 'billing',    status: 'success' },
  voucher_claim_failed:    { label: 'Claim Voucher Gagal',              icon: '⚠️', category: 'billing',    status: 'warning' },
  admin_reset_quota:      { label: 'Reset Download/Bypass Limit',     icon: '♻️', category: 'moderation', status: 'success' },
  device_reset:           { label: 'Reset Device',                    icon: '🖥️', category: 'moderation', status: 'success' },
  device_allow_change:    { label: 'Izinkan Ganti Device',             icon: '🔓', category: 'moderation', status: 'success' },
  device_registered:      { label: 'Perangkat Baru Terdaftar',         icon: '🖥️', category: 'auth',       status: 'success' },
  device_login_rejected:  { label: 'Login Ditolak (Device Lock)',      icon: '🚫', category: 'auth',       status: 'warning' },
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
  admin_auto_fill_games_info:      { label: 'Auto-Isi Deskripsi/Kategori Game',   icon: '🔧', category: 'catalog', status: 'success' },
  admin_auto_fill_games_image:     { label: 'Auto-Isi Gambar Game',               icon: '🖼️', category: 'catalog', status: 'success' },
  admin_auto_fill_bypasses_info:   { label: 'Auto-Isi Deskripsi Bypass',          icon: '🔧', category: 'catalog', status: 'success' },
  admin_auto_fill_bypasses_image:  { label: 'Auto-Isi Gambar Bypass',             icon: '🖼️', category: 'catalog', status: 'success' },
  admin_auto_fill_games_info_start:     { label: 'Auto-Isi Deskripsi/Kategori Game Dimulai', icon: '▶️', category: 'catalog', status: 'success' },
  admin_auto_fill_games_image_start:    { label: 'Auto-Isi Gambar Game Dimulai',             icon: '▶️', category: 'catalog', status: 'success' },
  admin_auto_fill_bypasses_info_start:  { label: 'Auto-Isi Deskripsi Bypass Dimulai',        icon: '▶️', category: 'catalog', status: 'success' },
  admin_auto_fill_bypasses_image_start: { label: 'Auto-Isi Gambar Bypass Dimulai',           icon: '▶️', category: 'catalog', status: 'success' },
  admin_add_category:      { label: 'Tambah Kategori',                     icon: '➕', category: 'catalog', status: 'success' },
  admin_edit_category:     { label: 'Edit Kategori',                       icon: '✏️', category: 'catalog', status: 'success' },
  admin_delete_category:   { label: 'Hapus Kategori',                      icon: '🗑️', category: 'catalog', status: 'warning' },
  admin_reorder_category:  { label: 'Ubah Urutan Kategori',                icon: '↕️', category: 'catalog', status: 'success' },
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
  download_provider_fallback: { label: 'Auto-Fallback HubCap → Ryu',        icon: '🔀', category: 'ryu',    status: 'warning' },
  settings_change:         { label: 'Perubahan Pengaturan',                icon: '⚙️', category: 'system', status: 'info' },
  profile_update:          { label: 'Update Profil App',                   icon: '🪪', category: 'account', status: 'success' },
  slash_command:           { label: 'Slash Command Discord',               icon: '⌨️', category: 'admin',   status: 'info' },
  gold_trial_settings_update: { label: 'Ubah Pengaturan Gold Trial',       icon: '🎁', category: 'system', status: 'info' },
  gold_trial_claim_failed:    { label: 'Klaim Gold Trial Gagal',           icon: '🎁', category: 'app',    status: 'warning' },
  gold_trial_claim_success:   { label: 'Klaim Gold Trial Berhasil',        icon: '🎁', category: 'app',    status: 'success' },
  gold_trial_test_notify:     { label: 'Test Notifikasi Gold Trial (Admin)', icon: '🔔', category: 'system', status: 'info' },
  gold_trial_notify_sent:     { label: 'Kirim Notifikasi Gold Trial (Admin)', icon: '🔔', category: 'system', status: 'info' },
  gold_trial_force_claim:     { label: 'Force Claim Gold Trial (Admin)',   icon: '🎁', category: 'system', status: 'warning' },
  premium_expired:         { label: 'Paket Premium Berakhir',              icon: '⏰', category: 'billing', status: 'warning' },
  premium_cleanup_start:   { label: 'Penghapusan Konten Premium Dimulai',  icon: '🧹', category: 'moderation', status: 'info' },
  premium_cleanup_done:    { label: 'Penghapusan Konten Premium Selesai',  icon: '✅', category: 'moderation', status: 'success' },
  premium_cleanup_manual:  { label: 'Hapus Manual Konten Premium (Admin)', icon: '🗑️', category: 'moderation', status: 'success' },
  system_error:            { label: 'Error Sistem',                       icon: '🚨', category: 'system', status: 'error' },
  // Marketplace (Product bundel Game/Bypass — lihat marketplaceManager.js &
  // marketplaceOrderManager.js) — dicatat ke sistem Logs existing, TIDAK bikin
  // koleksi log terpisah (requirement #24).
  marketplace_product_created:   { label: 'Tambah Produk Marketplace',        icon: '➕', category: 'catalog', status: 'success' },
  marketplace_product_updated:   { label: 'Edit Produk Marketplace',          icon: '✏️', category: 'catalog', status: 'success' },
  marketplace_product_disabled:  { label: 'Nonaktifkan Produk Marketplace',   icon: '⏸️', category: 'catalog', status: 'warning' },
  marketplace_product_deleted:   { label: 'Hapus Produk Marketplace',         icon: '🗑️', category: 'catalog', status: 'warning' },
  marketplace_content_added:     { label: 'Tambah Konten Produk Marketplace', icon: '➕', category: 'catalog', status: 'success' },
  marketplace_content_removed:   { label: 'Hapus Konten Produk Marketplace',  icon: '➖', category: 'catalog', status: 'warning' },
  marketplace_whitelist_added:   { label: 'Tambah Whitelist Marketplace',     icon: '✅', category: 'moderation', status: 'success' },
  marketplace_whitelist_removed: { label: 'Cabut Whitelist Marketplace',      icon: '🚫', category: 'moderation', status: 'warning' },
  marketplace_purchase_access_revoked: { label: 'Cabut Akses Pembelian Marketplace', icon: '🚫', category: 'moderation', status: 'warning' },
  marketplace_order_created:     { label: 'Buat Pesanan Marketplace',         icon: '🧾', category: 'billing', status: 'info' },
  marketplace_payment_success:   { label: 'Pembayaran Marketplace Berhasil',  icon: '💳', category: 'billing', status: 'success' },
  marketplace_access_granted:    { label: 'Akses Marketplace Diberikan',      icon: '🔓', category: 'billing', status: 'success' },
  marketplace_order_cancelled:   { label: 'Pesanan Marketplace Dibatalkan',   icon: '❌', category: 'billing', status: 'info' },
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
// (Download Berhasil, Limit Habis, Pengumuman, dst) punya channel Discord sendiri
// yang diatur dari Admin Web > Notifications Channel Setting — best-effort, tidak pernah
// melempar error ke pemanggil kalau channel-nya belum diatur/gagal kirim.
const { buildEmbed, buildDM, toDmEmbed, field, fmtDurationMs, fmtDateTimeWIB, discordTimestamp, buildPackageEmbed, packageRoleLabel } = require('./notifTemplates');
const notifDedup = require('./notifDedup');
// Package Notification → Embed Builder (lihat packageEmbedManager.js) — mesin
// template Discord Embed yang bisa diedit visual dari Admin Web, dipakai di
// bawah oleh notifyUser() (packageCard branch) & routes /api/admin/package-embeds/*.
const packageEmbedManager = require('./packageEmbedManager')({ getDb: () => db });
// Logo aplikasi (opsional, isi di .env) — dipakai sebagai thumbnail fallback
// pada notifikasi yang tidak punya gambar sendiri (mis. paket/pengumuman/error),
// sesuai poin "Jika gambar tidak tersedia, gunakan thumbnail/logo aplikasi sebagai fallback".
const APP_LOGO_URL = process.env.APP_LOGO_URL || null;

// Resolusi kategori webhook — dasar dari WEBHOOK_CATEGORY_BY_NOTIF_TYPE, dengan
// satu pengecualian dinamis: notifikasi Download (Berhasil/Gagal) dipecah ke
// webhook "Bypass" TERPISAH dari "Game" kalau itemType-nya bypass (`meta.itemType`),
// sesuai permintaan Bypass Webhook & Game Webhook harus punya channel sendiri.
function resolveWebhookCategory(notifType, meta) {
  if ((notifType === 'download_success' || notifType === 'download_failed') && meta?.itemType === 'bypass') {
    return notifType === 'download_success' ? 'bypass_download_success' : 'bypass_download_failed';
  }
  return WEBHOOK_CATEGORY_BY_NOTIF_TYPE[notifType] || 'announcement';
}

async function sendDiscordWebhook(notifType, embed, eventId, meta, plainEmbed, components) {
  const category = resolveWebhookCategory(notifType, meta);
  return webhookManager.sendCategoryWebhook(category, { embed, eventId, plainEmbed, components });
}

// Status (warna+emoji 🟢🟡🔴🔵) & label tiap jenis notifikasi in-app. SATU-SATUNYA
// sumber kebenaran dipakai buat bikin embed (lewat notifTemplates.buildEmbed) —
// DM & Webhook jadi selalu konsisten tampilannya untuk jenis notifikasi yang sama.
const NOTIF_META = {
  download_success:     { status: 'success', label: 'Download Berhasil',       badge: 'game' },
  download_failed:      { status: 'error',   label: 'Download Gagal',           badge: 'game' },
  quota_low:            { status: 'warning', label: 'Limit Download Hampir Habis', badge: 'user' },
  quota_empty:          { status: 'error',   label: 'Limit Download Habis',    badge: 'user' },
  period_low:           { status: 'warning', label: 'Paket Hampir Berakhir',    badge: 'paket' },
  period_expired:       { status: 'error',   label: 'Paket Berakhir',           badge: 'paket' },
  purchase:             { status: 'success', label: 'Pembelian Paket',          badge: 'paket' },
  // Siklus pembayaran (KlikQRIS) pakai badge 'payment' TERSENDIRI — beda dari
  // 'purchase'/'renewal' (badge 'paket') yang isinya soal role/masa aktif,
  // konsisten dengan kategori webhook 'payment' yang baru (lihat di atas).
  purchase_success:     { status: 'success', label: 'Pembayaran Berhasil',      badge: 'payment' },
  renewal:              { status: 'info',    label: 'Perpanjangan Paket',       badge: 'paket' },
  announcement:         { status: 'info',    label: 'Pengumuman Admin',         badge: 'admin' },
  login:                { status: 'success', label: 'Login Akun',               badge: 'user' },
  logout:               { status: 'info',    label: 'Logout Akun',              badge: 'user' },
  system_error:         { status: 'error',   label: 'Error Sistem',            badge: 'system' },
  voucher_claim:        { status: 'success', label: 'Voucher Berhasil Diklaim', badge: 'voucher' },
  gold_trial_claim:     { status: 'success', label: 'Gold Trial Aktif',         badge: 'paket' },
  gold_trial_offer:     { status: 'info',    label: 'Gold Trial Tersedia',      badge: 'paket' },
  welcome_popup_test:   { status: 'info',    label: 'Welcome Popup (TEST)',     badge: 'admin' },
  transaction_expired:  { status: 'warning', label: 'Pembayaran Kedaluwarsa',   badge: 'payment' },
  transaction_cancelled:{ status: 'warning', label: 'Transaksi Dibatalkan',     badge: 'payment' },
  // "Pembayaran Gagal" — sebelumnya status 'failed' yang dilaporkan KlikQRIS sama
  // sekali tidak memicu notifikasi apapun (beda dari Berhasil/Kedaluwarsa/Dibatalkan
  // yang sudah lengkap). Disamakan di sini, badge & footer konsisten lewat jalur
  // notifyUser yang sama (lihat refreshTransactionFromKlikqris).
  transaction_failed:   { status: 'error',   label: 'Pembayaran Gagal',         badge: 'payment' },
  // Auto Remove Premium Content (paket expired) — badge SEBELUMNYA selalu ikut
  // default type 'announcement' (badge 'admin'), padahal isinya soal game/bypass
  // yang dihapus, bukan pengumuman admin. Badge sekarang dihitung dinamis per
  // kejadian (lihat premiumCleanupBadge()) lewat parameter `badge` override di
  // notifyUser — badge di sini cuma fallback kalau override tidak diisi.
  premium_cleanup:      { status: 'info',    label: 'Auto Remove Premium Content', badge: 'game' },
  // Request Game — badge 'request_game' TERSENDIRI (bukan 'game') supaya beda
  // dari Download Berhasil/Gagal & Game Baru, sesuai daftar badge kategori yang
  // diminta (Game, Bypass, ..., Request Game, ...).
  game_request_created:  { status: 'info',    label: 'Request Game Baru',        badge: 'request_game' },
  game_request_approved: { status: 'success', label: 'Request Game Disetujui',   badge: 'request_game' },
  game_request_rejected: { status: 'error',   label: 'Request Game Ditolak',     badge: 'request_game' },
  game_request_available:{ status: 'success', label: 'Game Sudah Tersedia',      badge: 'request_game' }
};

// Badge dinamis untuk notifikasi Auto Remove Premium Content — 'game' kalau cuma
// game yang kena, 'bypass' kalau cuma bypass, 'game_bypass' kalau dua-duanya
// (lihat BADGE.game_bypass di notifTemplates.js).
function premiumCleanupBadge(gameCount, bypassCount) {
  const hasGame = Number(gameCount) > 0;
  const hasBypass = Number(bypassCount) > 0;
  if (hasGame && hasBypass) return 'game_bypass';
  if (hasBypass) return 'bypass';
  return 'game';
}

// Fungsi utama pengiriman notifikasi. Selalu simpan ke DB (in-app, muncul di lonceng
// notifikasi walau user lagi offline) + push realtime via WebSocket kalau user online.
// Discord DM & Webhook sifatnya best-effort tambahan, dikontrol per-jenis notifikasi
// lewat opsi { dm, webhook } (default: dm untuk yang penting, webhook selalu untuk visibilitas admin).
//
// `fields`    : array field() tambahan yang RELEVAN untuk jenis notifikasi ini
//               (mis. nama game, ukuran, sisa limit, dll) — lihat notifTemplates.js.
// `thumbnail` : URL gambar kecil (icon paket/logo app/icon warning).
// `image`     : URL gambar besar/cover (dipakai untuk event terkait game).
async function notifyUser(discordId, { type, title, message, fields = [], thumbnail, image, meta = {}, dm = true, webhook = false, eventId, badge, webhookEmbed, packageCard }) {
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
  // Event ID dipakai buat anti-spam (deduplication). SEBELUMNYA fallback-nya
  // pakai `inserted._id` — tapi `_id` itu SELALU baru/unik tiap kali insertOne
  // dipanggil (walau isinya identik/event yang sama benar-benar terulang),
  // jadi dedup berdasarkan eventId itu TIDAK PERNAH bisa mendeteksi duplikat
  // sama sekali (bug: notifikasi yang benar-benar dobel tetap lolos dua-duanya).
  // Diganti jadi hash dari isi pesan (type+discordId+title+message) yang STABIL
  // — event yang benar-benar sama (dipanggil ulang dalam window cooldown, mis.
  // race condition/retry) sekarang konsisten menghasilkan eventId yang SAMA
  // dan ke-dedup dengan benar, sementara event BEDA (title/message beda)
  // tetap menghasilkan eventId beda dan tidak pernah ke-block.
  const resolvedEventId = eventId || `auto:${type}:${discordId}:${notifDedup.simpleHash(`${title}|${message}`)}`;

  // ── PACKAGE CARD — semua notifikasi seputar PAKET (aktivasi, pembelian,
  // upgrade, perpanjangan, reset, hampir berakhir, berakhir, voucher, gold
  // trial) memakai satu embed "card" khusus (buildPackageEmbed), dipakai
  // SAMA PERSIS untuk Webhook & DM (tanpa dibungkus toDmEmbed, supaya value
  // field tampil teks biasa bukan inline-code) — konsisten & sesuai referensi
  // desain, dan otomatis pakai avatar Discord user yang bersangkutan sebagai
  // thumbnail (bukan logo aplikasi), kalau tersedia.
  let embed;
  let packageComponents;
  if (packageCard) {
    let avatarUrl = packageCard.avatarUrl;
    if (avatarUrl === undefined) {
      try {
        const u = await db.collection('users').findOne({ discordId }, { projection: { avatarUrl: 1 } });
        avatarUrl = u?.avatarUrl || null;
      } catch { avatarUrl = null; }
    }
    // Package Embed Builder — pakai template TERBARU dari database (Admin Web
    // > Notification Package > Embed Builder) kalau event-nya dikenal &
    // admin sudah pernah menyimpan/reset; fallback ke buildPackageEmbed()
    // (hardcoded, seperti sebelumnya) kalau event belum masuk daftar builder
    // atau terjadi error, supaya notifikasi TIDAK PERNAH gagal terkirim.
    if (packageCard.event && packageEmbedManager.isValidEvent(packageCard.event)) {
      try {
        const rendered = await packageEmbedManager.renderPackageEmbed(
          packageCard.event,
          { ...packageCard, discordId },
          { avatarUrl: avatarUrl || APP_LOGO_URL || undefined, appName: APP_NAME }
        );
        embed = rendered.embed;
        packageComponents = rendered.components;
      } catch (e) {
        console.warn('[PackageEmbed] Gagal render dari template, pakai default:', e.message);
      }
    }
    if (!embed) {
      embed = buildPackageEmbed({
        ...packageCard,
        description: packageCard.description ?? message,
        avatarUrl,
        appName: APP_NAME,
        fallbackThumbnail: APP_LOGO_URL || undefined
      });
    }
  } else {
    embed = buildEmbed({
      status: typeMeta.status,
      badge: badge || typeMeta.badge,
      title,
      description: message,
      fields,
      thumbnail: thumbnail || APP_LOGO_URL || undefined,
      image,
      appName: APP_NAME,
      footerNote: typeMeta.label
    });
  }

  // Pengiriman DM & Webhook — fire-and-forget (non-blocking, tidak pernah
  // menghambat pemanggil notifyUser). Logging Success/Failed/Error sudah
  // dicatat terpusat di DALAM sendDiscordDM() & webhookManager.sendCategoryWebhook()
  // (satu tempat, berlaku untuk SEMUA cara pemanggilan, bukan cuma lewat sini).
  if (dm) {
    // DM pakai gaya "card" (value field dibungkus badge/tag) — KECUALI untuk
    // packageCard, yang sudah dalam bentuk final compact card (lihat komentar
    // di atas). Webhook (channel admin) sekarang JUGA memakai gaya yang sama —
    // pembungkusannya dilakukan terpusat di webhookManager.sendCategoryWebhook(),
    // bukan di sini, supaya berlaku konsisten untuk semua jalur pengiriman
    // webhook di server.js.
    sendDiscordDM(discordId, {
      embeds: [packageCard ? embed : toDmEmbed(embed)],
      ...(packageComponents && packageComponents.length ? { components: packageComponents } : {})
    }, { eventId: resolvedEventId, eventLabel: type }).catch(() => {});
  }
  if (webhook) {
    // webhookEmbed (opsional) — embed CUSTOM khusus buat channel Discord (mis.
    // buildDownloadEmbed untuk Download Berhasil/Gagal), berbeda dari embed
    // generik di atas yang tetap dipakai buat DM. Kalau diisi, otomatis
    // dikirim POLOS (tanpa dibungkus inline-code) — lihat plainEmbed di
    // discordNotifyManager.js. packageCard juga selalu dikirim POLOS (plainEmbed)
    // karena sudah final.
    sendDiscordWebhook(type, webhookEmbed || embed, resolvedEventId, meta, !!(webhookEmbed || packageCard), packageComponents).catch(() => {});
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

// Notifikasi Discord PER KATEGORI, dikirim lewat DISCORD BOT ke channel yang
// dipilih admin (lihat discordNotifyManager.js) — menggantikan webhook URL
// manual yang lama sepenuhnya (termasuk webhook lama punya roleSync, lihat di
// bawah). Diatur dari Admin Web > Notifications Channel Setting, disimpan di
// DB, berlaku realtime tanpa restart. Nama variabel `webhookManager` & method
// `sendCategoryWebhook` SENGAJA dipertahankan supaya seluruh pemanggil di
// file ini (20+ titik) tidak perlu diubah. Dibuat SEBELUM roleSync karena
// roleSync butuh instance ini untuk kirim notifikasi role_change lewat Bot
// juga (bukan webhook URL terpisah lagi).
const webhookManager = require('./discordNotifyManager')({ getDb: () => db });

const roleSync = require('./discordRoleSync')({
  getDb: () => db, ROLE_LEVEL,
  pushAccountUpdate,
  broadcastAdmin,
  logActivity,
  webhookManager
});

// ══════════════════════════════════════════════════════════════════════════
// SLASH COMMAND DISCORD — /setpaket, /cekpaket, /createvoucher (Owner/Admin
// only, lihat discordSlashCommands.js). Gateway TERPISAH dari roleSync di
// atas, tapi logic-nya REUSE applyRoleChange/voucherManager/roleSync yang
// sama persis dengan Admin Web — dependency di-inject di sini, bukan
// duplikasi. `applyRoleChange`, `computeUserStats`, `publicUser`, dan
// `voucherPublic` didefinisikan lebih bawah di file ini sebagai function
// declaration (di-hoist), jadi aman direferensikan di sini.
// ══════════════════════════════════════════════════════════════════════════
const slashCommands = require('./discordSlashCommands')({
  getDb: () => db, ROLE_LEVEL, roleSync, voucherManager,
  applyRoleChange: (...args) => applyRoleChange(...args),
  computeUserStats: (...args) => computeUserStats(...args),
  publicUser: (...args) => publicUser(...args),
  voucherPublic: (...args) => voucherPublic(...args),
  logActivity, broadcastAdmin,
  APP_NAME, APP_LOGO_URL
});
// APP UPDATE MANAGER — Auto Update & Force Update via GitHub Releases (lihat appUpdateManager.js)
const appUpdateManager = require('./appUpdateManager')({ getDb: () => db, wsBroadcastAll });
// APP CUSTOMIZATION MANAGER — Background & Branding App Desktop, realtime lewat
// wsBroadcastAll yang SUDAH ADA (lihat appCustomizationManager.js)
const appCustomizationManager = require('./appCustomizationManager')({ getDb: () => db, wsBroadcastAll });
// DASHBOARD BANNER MANAGER — SATU kartu banner Dashboard (`.dash-banner` di
// app/index.html), realtime lewat wsBroadcastAll yang SUDAH ADA (lihat
// dashboardBannerManager.js). BUKAN sistem carousel `banners` yang sudah ada
// di project ini (koleksi `banners`/endpoint /api/banners — dibiarkan idle,
// tidak disentuh sama sekali oleh fitur ini).
const dashboardBannerManager = require('./dashboardBannerManager')({ getDb: () => db, wsBroadcastAll });
// CATALOG EMBED ACCENT COLOR — ekstraksi warna dominan/accent dari banner
// Game/Bypass (Steam API, lewat pickCatalogBanner() di bawah) untuk embed
// Add Game/Add Bypass/Game Update/Bypass Update (lihat catalogEmbedColor.js
// & buildCatalogEmbed() di bawah).
const catalogEmbedColor = require('./catalogEmbedColor');

// ══════════════════════════════════════════════════════════════════════════
// EMBED KATALOG (Game/Bypass Baru & Update) — mengikuti STRUKTUR PERSIS dari
// 4 template JSON referensi admin (Add Game / Add Bypass / Game Update /
// Bypass Update — dibuat lewat embed builder, disimpan sebagai acuan desain):
// layout author+icon, description bergaya "card pengumuman", footer, image
// full-width, timestamp live, dan warna accent. Dipakai di 4 tempat: Add
// Game, Edit Game (= "Game Update"), Add Bypass, Edit Bypass (= "Bypass
// Update") — satu sumber kebenaran biar keempatnya selalu identik
// strukturnya (tidak ada desain nyeleneh sendiri-sendiri per tempat), dan
// SATU-SATUNYA embed yang dipakai untuk keempat event ini (tidak ada embed
// lama/lain yang nyangkut di flow ini).
//
// Yang tetap DINAMIS dari data asli (tidak pernah hardcode/dikarang):
//   - name        : nama Game/Bypass ASLI dari dokumen database, disisipkan
//                   ke baris "• {name}" di description (posisi & gaya teks
//                   persis mengikuti template, cuma nilainya dinamis).
//   - banner      : dipilih oleh pickCatalogBanner() di bawah — TETAP pakai
//                   sistem pengambilan image yang SUDAH ADA (heroImageUrl/
//                   imageUrl, hasil Steam Store API) — TIDAK membuat sistem
//                   image baru & TIDAK pernah pakai image statis dari JSON
//                   template manapun. Kalau kosong, embed tetap terkirim
//                   tanpa gambar (tidak error, bukan diganti gambar lain).
//   - color       : dihitung dari warna dominan/accent banner di atas (lihat
//                   catalogEmbedColor.js) — fallback ke warna default "31
//                   Tools" (persis warna di 4 template JSON) kalau bannernya
//                   kosong atau ekstraksi warna gagal.
//   - author/footer icon : LOGO branding App Customization (Admin Web > App
//                   Customization > Branding Logo) yang SUDAH ADA di
//                   appCustomizationManager — dibaca ulang tiap kirim notif
//                   (bukan snapshot lama), fallback ke APP_LOGO_URL (.env)
//   - author/footer icon : URL logo TETAP (fixed), sesuai permintaan
//                   terbaru — TIDAK LAGI diambil dari App Customization,
//                   cuma satu link ini dipakai untuk semua embed Add/Update
//                   Game/Bypass (lihat CATALOG_BRAND_ICON_URL di bawah).
//   - url/author.url : link download App, diambil LIVE dari
//                   appUpdateManager.getConfig() (sistem App Update yang
//                   sudah ada, BUKAN link statis "discord.com" bawaan
//                   template) — kalau belum diatur admin, field ini dilewati
//                   saja (bukan error, bukan link mati).
//   - timestamp   : selalu waktu pengiriman notif saat ini (bukan nilai beku
//                   dari file JSON referensi).
//
//   kind  : 'game' | 'bypass'
//   isNew : true (Add) | false (Update/Edit)

// Logo Author/Footer embed katalog (Add Game/Add Bypass/Game Update/Bypass
// Update) — URL TETAP sesuai permintaan, BUKAN lagi dari App Customization
// (sebelumnya diambil dari branding.logo App Customization lewat
// getCatalogBrandIconUrl(), sekarang diganti satu link ini permanen).
const CATALOG_BRAND_ICON_URL = 'https://i.ibb.co.com/zhZJYQGP/logo31-opsi2.png';

async function buildCatalogEmbed({ kind, isNew, name, appId, publisher, banner, downloadUrl }) {
  const nounLabel = kind === 'bypass' ? 'Bypass' : 'Game';
  const eventKey = isNew ? 'add' : 'update';
  const copy = CATALOG_EMBED_COPY[kind]?.[eventKey] || CATALOG_EMBED_COPY.game.add;

  const color = await catalogEmbedColor.getCatalogAccentColor(banner);
  const authorIcon = CATALOG_BRAND_ICON_URL;

  const link = cleanCatalogUrl(downloadUrl);
  const description =
    `**${copy.heading}**\n\n` +
    `${copy.intro.replace(/\{app\}/g, APP_NAME)}\n\n` +
    `${copy.listLabel}\n• ${name}\n\n` +
    `${copy.outro.replace(/\{app\}/g, APP_NAME)}`;

  const embed = {
    color,
    timestamp: new Date().toISOString(),
    author: { name: `${APP_NAME} • ${copy.authorSuffix}` },
    footer: { text: APP_NAME },
    description
  };
  if (link) {
    embed.url = link;
    embed.author.url = link;
  }
  if (authorIcon) {
    embed.author.icon_url = authorIcon;
    embed.footer.icon_url = authorIcon;
  }
  if (banner) embed.image = { url: banner };
  return embed;
}

// Copy description PERSIS mengikuti 4 template JSON referensi (Add Game/Add
// Bypass/Game Update/Bypass Update) — satu-satunya bagian yang berubah per
// event adalah baris "• {name}" (lihat buildCatalogEmbed di atas). `{app}`
// diganti APP_NAME (dinamis, default "31 Tools") supaya kalau admin ganti
// APP_NAME di .env, teksnya ikut berubah — bukan berarti brand text ini
// dikarang, cuma dibuat konsisten dengan APP_NAME yang sudah dipakai di
// seluruh notifikasi lain.
const CATALOG_EMBED_COPY = {
  game: {
    add: {
      authorSuffix: 'Game Update',
      heading: '🔥NEW GAME TERBARU TELAH HADIR🔥',
      intro: 'Update terbaru telah tersedia di {app}.\nGame baru telah ditambahkan dan siap dimainkan.',
      listLabel: 'Game Baru:',
      outro: 'Cek detailnya dan temukan game terbaru\nmelalui {app}.'
    },
    update: {
      authorSuffix: 'Game Update',
      heading: '🔥GAME UPDATE TERBARU TELAH HADIR🔥',
      intro: 'Update terbaru telah tersedia di {app}.\nGame ini kini mendapatkan update terbaru.',
      listLabel: 'Game Update:',
      outro: 'Cek detail dan download update terbaru\nmelalui {app}.'
    }
  },
  bypass: {
    add: {
      authorSuffix: 'Bypass Update',
      heading: '🔥BYPASS TERBARU TELAH HADIR🔥',
      intro: 'Update terbaru telah tersedia di {app}.\nBypass baru telah ditambahkan dan siap digunakan.',
      listLabel: 'Bypass Baru:',
      outro: 'Cek detailnya dan gunakan bypass terbaru\nmelalui {app}.'
    },
    update: {
      authorSuffix: 'Bypass Update',
      heading: '🔥BYPASS UPDATE TERBARU TELAH HADIR🔥',
      intro: 'Update terbaru telah tersedia di {app}.\nBypass ini kini telah mendapatkan update terbaru.',
      listLabel: 'Bypass Update:',
      outro: 'Cek detail dan gunakan versi terbaru\nmelalui {app}.'
    }
  }
};

// Guard kecil khusus buildCatalogEmbed — Discord menolak field url/author.url/
// icon_url kalau bukan http(s), jadi apapun yang bukan http(s) dilewati sama
// sekali (bukan dikirim mentah ke Discord).
function cleanCatalogUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

// Pilih gambar landscape TERBAIK buat banner notif Discord dari data game/
// bypass — heroImageUrl (library_hero, wide 1920x620) diprioritaskan karena
// paling pas buat banner lebar; imageUrl (header.jpg, 460x215) jadi fallback
// TERAKHIR. libraryImageUrl (library_600x900, POTRAIT) SENGAJA DILEWATI di
// sini — kalau dipaksa jadi banner lebar hasilnya gepeng/terpotong aneh.
// capsuleImageUrl (231x87) JUGA SENGAJA TIDAK dipakai — rasio & ukurannya
// beda jauh dari hero/header, hasilnya kepotong/beda ukuran dibanding notif
// lain kalau dipasang sebagai banner lebar.
//
// LIVE FALLBACK (fix "banner Game kelihatan beda/jelek dibanding Bypass"):
// Sebelumnya kalau `doc.heroImageUrl` belum tersimpan di database (mis. item
// lama yang ditambahkan sebelum fitur ini ada, atau admin belum pernah klik
// App ID Lookup / "Auto-Isi Gambar"), fungsi ini langsung jatuh ke
// `imageUrl` (header.jpg kecil, 460x215) yang kalau di-stretch jadi banner
// lebar di Discord hasilnya pecah/gepeng — beda kualitas dari item yang
// heroImageUrl-nya sudah kebetulan tersimpan, padahal SUMBER GAMBARNYA SAMA-
// SAMA STEAM. SEKARANG: kalau heroImageUrl belum ada TAPI App ID-nya ada,
// dicoba dulu live-check ke Steam CDN — pola URL & teknik HEAD-check PERSIS
// SAMA dengan yang sudah dipakai lookupAppIdInfo() di atas (BUKAN sistem
// image baru, cuma dipanggil ulang di titik lain: saat kirim notifikasi,
// bukan cuma saat admin klik lookup manual) — supaya Game & Bypass konsisten
// dapat banner lebar dari Steam tanpa admin harus Auto-Isi ulang satu-satu.
// Di-cache 6 jam per App ID biar tidak nge-hit Steam CDN berkali-kali untuk
// App ID yang sama. Kalau live-check juga gagal/App ID tidak ada -> tetap
// fallback ke imageUrl seperti sebelumnya (tidak pernah error, tidak pernah
// bikin embed gagal terkirim).
const CATALOG_HERO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam
const catalogHeroUrlCache = new Map(); // appId -> { url: string|null, expiresAt }

async function resolveLiveHeroImageUrl(appId) {
  if (!appId) return null;
  const cached = catalogHeroUrlCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const heroUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_hero.jpg`;
  let resolved = null;
  try {
    // Timeout diturunkan dari 8000 -> 3500ms (fix "notifikasi Add/Update
    // Game/Bypass delay"): ini live HEAD-check ke Steam CDN yang jalan
    // SEBELUM notif Discord dikirim (lihat pickCatalogBanner dipanggil di
    // titik pengiriman notif game_new/game_edit/bypass_new/bypass_edit) —
    // kalau lambat/timeout, notifnya ikut telat terkirim. 3.5 detik cukup
    // untuk HEAD request biasa, dan hasilnya di-cache 6 jam (lihat
    // CATALOG_HERO_CACHE_TTL_MS) jadi App ID yang sama tidak akan kena
    // delay ini berulang-ulang.
    const res = await axios.head(heroUrl, { timeout: 3500, validateStatus: () => true });
    if (res.status === 200) resolved = heroUrl;
  } catch (e) { /* best-effort — banner tetap fallback ke imageUrl kalau ini gagal */ }

  // Prune ringan biar cache tidak tumbuh tanpa batas kalau App ID-nya banyak sekali.
  if (catalogHeroUrlCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of catalogHeroUrlCache) if (v.expiresAt < now) catalogHeroUrlCache.delete(k);
  }
  catalogHeroUrlCache.set(appId, { url: resolved, expiresAt: Date.now() + CATALOG_HERO_CACHE_TTL_MS });
  return resolved;
}

async function pickCatalogBanner(doc) {
  if (doc.heroImageUrl) return doc.heroImageUrl;
  // `steamAppId` — field legacy yang masih dipakai di sejumlah dokumen Bypass
  // lama (lihat pola `b.appId || b.steamAppId` yang sudah dipakai di banyak
  // tempat lain di file ini), diikutkan supaya live-check ini juga jalan
  // untuk data lama yang App ID-nya masih tersimpan di field lama itu.
  const appId = doc.appId || doc.steamAppId || null;
  if (appId) {
    const liveHero = await resolveLiveHeroImageUrl(String(appId));
    if (liveHero) return liveHero;
  }
  return doc.imageUrl || null;
}

// ══════════════════════════════════════════════════════════════════════════
// EMBED DOWNLOAD GAME/BYPASS (channel Discord) — desain compact TERSENDIRI,
// sama gaya "polos tanpa inline-code" dengan buildCatalogEmbed, TAPI khusus
// buat notif Download/Install (BUKAN Add/Update katalog). Dipakai lewat
// notifyUser({ webhookEmbed: buildDownloadEmbed(...) }) — jadi DM ke user
// tetap pakai gaya lama (card badge), yang berubah cuma tampilan di CHANNEL
// Discord admin.
//   kind        : 'game' | 'bypass' — menentukan warna strip embed (Game =
//                 hijau, Bypass = ungu) — SELALU sama warnanya apapun hasil
//                 prosesnya (biar konsisten per jenis), bedanya status
//                 ditandai lewat ikon + field "Status", BUKAN ganti warna.
//   status      : 'success' | 'failed' | 'cancelled' — SUMBER KEBENARAN
//                 TUNGGAL status notif, harus persis sinkron dengan status
//                 sebenarnya dari proses download/install di App (jangan
//                 pernah anggap cancelled = failed atau sebaliknya).
//   itemName/appId/publisher : data ASLI dari dokumen game/bypass — kalau
//                 tidak tersedia (mis. saat gagal & client cuma kirim nama),
//                 field-nya otomatis disembunyikan, tidak pernah dikarang.
//   username    : Discord username user yang melakukan download.
//   reason      : pesan/alasan dari client (App) — HANYA ditampilkan sebagai
//                 field "Pesan Tambahan" kalau status='failed' DAN reason-nya
//                 memang ada (untuk 'cancelled', field "Status" sendiri sudah
//                 cukup jelas "Dibatalkan oleh User", tidak perlu diulang).
const DOWNLOAD_STATUS_META = {
  success:   { icon: '⬇️', headline: 'Downloaded!',        desc: 'has been successfully downloaded.', statusText: 'Berhasil' },
  failed:    { icon: '🔴', headline: 'Download Failed!',    desc: 'failed to download.',                statusText: 'Gagal' },
  cancelled: { icon: '🟡', headline: 'Download Cancelled!', desc: 'download was cancelled by the user.', statusText: 'Dibatalkan oleh User' }
};
function buildDownloadEmbed({ kind, status, itemName, appId, publisher, banner, username, reason }) {
  const nounLabel = kind === 'bypass' ? 'Bypass' : 'Game';
  const meta = DOWNLOAD_STATUS_META[status] || DOWNLOAD_STATUS_META.failed;

  const fields = [
    field(`${nounLabel} Name`, itemName, true),
    field('App ID', appId, true),
    field('Publisher', publisher, true),
    field('Username', username, true),
    field('Status', meta.statusText, true),
    (status === 'failed' && reason) ? field('Pesan Tambahan', reason, false) : null
  ].filter(Boolean);

  const embed = {
    title: `${meta.icon} ${nounLabel} ${meta.headline}`,
    description: `${nounLabel} ${meta.desc}`,
    color: kind === 'bypass' ? 0x7c5cff : 0x3ddc97, // Game = hijau, Bypass = ungu
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'ThreeOneStore' }
  };
  if (banner) embed.image = { url: banner };
  return embed;
}

// MAINTENANCE MODE MANAGER — kunci seluruh App saat maintenance (lihat maintenanceManager.js)
const maintenanceManager = require('./maintenanceManager')({ getDb: () => db, wsClients, wsSendToUser });

// ACTIVE TOOLS MANAGER — fitur "Active Tools" halaman Settings (lihat activeToolsManager.js)
const activeToolsManager = require('./activeToolsManager')({ getDb: () => db, wsBroadcastAll });

// CLOUD FIX MANAGER — fitur "Cloud FIX" halaman Settings (lihat cloudFixManager.js).
// Struktur identik dengan activeToolsManager di atas, sengaja dipisah modulnya
// (bukan digabung) supaya TIDAK menyentuh/berisiko merusak logic Active Tools
// yang sudah ada — App-nya cuma buka link eksternal, bukan download/extract.
const cloudFixManager = require('./cloudFixManager')({ getDb: () => db, wsBroadcastAll });

// Device Lock — 1 akun cuma bisa dipakai di 1 perangkat (lihat deviceLock.js).
// Fingerprint dihitung dari kombinasi beberapa komponen hardware, disimpan di
// DB (collection `devices` + audit trail `deviceLogs`), berlaku realtime.
const deviceLock = require('./deviceLock')({ getDb: () => db });

// Automatic Watermark Detection (download Game & Bypass) — lihat watermarkManager.js.
// Menumpang di sistem device-fingerprint yang sama dgn Device Lock (deviceLock.computeComponents)
// supaya "Device ID" konsisten satu sumber kebenaran di seluruh sistem.
const watermarkManager = require('./watermarkManager')({
  getDb: () => db, deviceLock, logActivity, broadcastAdmin, webhookManager, buildEmbed, field, APP_NAME
});

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
//
// Hanya item yang tercatat terinstal SELAGI user berperan gold/platinum yang
// dianggap "konten premium" dan jadi kandidat pembersihan otomatis.
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
        type: 'premium_cleanup',
        badge: premiumCleanupBadge(jobDoc.gameCount, jobDoc.bypassCount),
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


// Sweep transaksi Upgrade Paket yang PENDING tapi sudah lewat 10 menit (lihat
// transactionManager.EXPIRY_MS) — jaga-jaga kalau user menutup app/halaman
// pembayaran sebelum sempat expired secara alami (jadi statusnya tidak
// nyangkut 'pending' selamanya). Realtime ke app user + Admin Web, dan best-effort
// batalkan juga transaksinya di sisi KlikQRIS (no-op, lihat klikqrisManager.cancelTransaction).
setInterval(() => sweepExpiredTransactions().catch(e => console.warn('[Upgrade Paket] Sweep expiry gagal:', e.message)), 60 * 1000);
async function sweepExpiredTransactions() {
  if (!db) return;
  const expired = await transactionManager.sweepExpired();
  for (const tx of expired) {
    klikqrisManager.cancelTransaction({ orderId: tx.orderId }).catch(() => {});
    wsSendToUser(tx.discordId, 'transaction:update', transactionManager.publicTransaction(tx));
    broadcastAdmin('transaction:update', transactionManager.publicTransaction(tx));
    notifyUser(tx.discordId, {
      type: 'transaction_expired',
      title: 'Pembayaran Kedaluwarsa',
      message: `Waktu pembayaran untuk transaksi ${tx.orderId} (paket ${tx.tier.toUpperCase()}) telah habis. Silakan buat transaksi baru kalau masih ingin upgrade.`,
      fields: [
        field('🧾 Invoice', tx.orderId, true),
        field('📦 Paket', tx.tier.toUpperCase(), true),
        field('💰 Nominal', `Rp${Number(tx.amount).toLocaleString('id-ID')}`, true)
      ],
      // webhook:true — sebelumnya false, jadi admin sama sekali tidak lihat transaksi
      // yang kedaluwarsa di channel Discord manapun (beda dgn Berhasil yang selalu
      // ada). Disamakan supaya visibilitas admin konsisten utk semua status pembayaran.
      dm: true, webhook: true
    }).catch(() => {});

    // Auto Order (Discord Bot) — no-op kalau bukan order dari Discord Bot.
    discordAutoOrderManager?.onOrderClosed(tx, 'expired').catch(() => {});
  }
}

// Sweep user Gold/Platinum yang masa aktifnya (activeUntil) sudah lewat —
// SEBELUM ini, auto-downgrade+Discord Role Sync (applyExpiryIfNeeded, lihat
// definisinya di atas) HANYA dipanggil lazy di request berautentikasi
// (login/refresh/buka app), jadi kalau user lagi offline pas paketnya habis,
// dia "nyangkut" gold/platinum (di app MAUPUN role Discord-nya) sampai dia
// buka app lagi. Sweep ini bikin downgrade + Discord Role Sync jalan REALTIME
// (tanpa nunggu aktivitas user sama sekali) — reuse TOTAL applyExpiryIfNeeded()
// yang sudah ada (DB atomic update, sync Discord, notif, log, auto-remove
// konten premium), TIDAK ada logic duplikat. Interval singkat (30 detik)
// karena ini satu-satunya jalur expired-by-time yang TIDAK punya event
// pemicu asli (bukan polling menggantikan event yang sebenarnya ada).
setInterval(() => sweepExpiredUserPeriods().catch(e => console.warn('[Masa Aktif] Sweep expiry gagal:', e.message)), 30 * 1000);
async function sweepExpiredUserPeriods() {
  if (!db) return;
  const expiredUsers = await db.collection('users').find({
    role: { $in: ['gold', 'platinum'] },
    activeUntil: { $ne: null, $lte: new Date() }
  }).toArray();
  for (const user of expiredUsers) {
    await applyExpiryIfNeeded(user).catch(e =>
      console.warn(`[Masa Aktif] Gagal auto-downgrade ${user.discordId} saat sweep:`, e.message)
    );
  }
}

// Sweep order Steam Account yang PENDING & sudah lewat 10 menit — collection
// terpisah (steamAccountOrders). Tidak perlu "un-allocate" apapun di sini karena order
// yang masih 'pending' belum pernah memanggil grantOwnership sama sekali.
setInterval(() => sweepExpiredSteamAccountOrders().catch(e => console.warn('[SteamAccounts] Sweep expiry gagal:', e.message)), 60 * 1000);
async function sweepExpiredSteamAccountOrders() {
  if (!db) return;
  const expired = await steamAccountOrderManager.sweepExpired();
  for (const order of expired) {
    klikqrisManager.cancelTransaction({ orderId: order.orderId }).catch(() => {});
    wsSendToUser(order.discordId, 'steamAccounts:order:update', steamAccountOrderManager.publicOrder(order));
    broadcastAdmin('steamAccounts:order:update', steamAccountOrderManager.publicOrder(order));
    notifyUser(order.discordId, {
      type: 'steam_account_order_expired',
      title: 'Pembayaran Akun Steam Kedaluwarsa',
      message: `Waktu pembayaran untuk pesanan ${order.orderId} (${order.productName}) telah habis. Silakan beli lagi kalau masih berminat.`,
      fields: [
        field('🧾 Invoice', order.orderId, true),
        field('📦 Akun', order.productName, true),
        field('💰 Nominal', `Rp${Number(order.amount).toLocaleString('id-ID')}`, true)
      ],
      dm: true, webhook: true
    }).catch(() => {});
  }
}

// Sweep order Marketplace yang PENDING & sudah lewat 10 menit — collection
// terpisah (marketplaceOrders). Sama seperti Steam Account: order 'pending'
// belum pernah memanggil grantAccess() sama sekali, jadi tidak ada apapun
// yang perlu "dicabut" di sini, cuma status order-nya yang ditandai expired.
setInterval(() => sweepExpiredMarketplaceOrders().catch(e => console.warn('[Marketplace] Sweep expiry gagal:', e.message)), 60 * 1000);
async function sweepExpiredMarketplaceOrders() {
  if (!db) return;
  const expired = await marketplaceOrderManager.sweepExpired();
  for (const order of expired) {
    klikqrisManager.cancelTransaction({ orderId: order.orderId }).catch(() => {});
    wsSendToUser(order.discordId, 'marketplace:order:update', marketplaceOrderManager.publicOrder(order));
    broadcastAdmin('marketplace:order:update', marketplaceOrderManager.publicOrder(order));
    notifyUser(order.discordId, {
      type: 'marketplace_order_expired',
      title: 'Pembayaran Marketplace Kedaluwarsa',
      message: `Waktu pembayaran untuk pesanan ${order.orderId} (${order.productName}) telah habis. Silakan beli lagi kalau masih berminat.`,
      fields: [
        field('🧾 Invoice', order.orderId, true),
        field('📦 Produk', order.productName, true),
        field('💰 Nominal', `Rp${Number(order.amount).toLocaleString('id-ID')}`, true)
      ],
      dm: true, webhook: true
    }).catch(() => {});
  }
}

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
    const cleanupReasonLabel = isManualJob
      ? (n, kind) => `Penghapusan manual (dipicu admin) ${n} ${kind} milik ${req.user.username} dimulai.`
      : (n, kind) => `Penghapusan ${n} ${kind} premium milik ${req.user.username} dimulai (paket ${String(job.role).toUpperCase()} berakhir).`;
    if (games.length) {
      logActivity({
        type: 'premium_cleanup_start', username: req.user.username, discordId: req.user.discordId,
        role: job.role, status: 'info', ip: getReqIp(req), device: getReqDevice(req),
        description: cleanupReasonLabel(games.length, 'game'),
        meta: { jobId: String(job._id), itemType: 'game', games }
      }).catch(() => {});
    }
    if (bypasses.length) {
      logActivity({
        type: 'premium_cleanup_start', username: req.user.username, discordId: req.user.discordId,
        role: job.role, status: 'info', ip: getReqIp(req), device: getReqDevice(req),
        description: cleanupReasonLabel(bypasses.length, 'bypass'),
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
        type: 'premium_cleanup',
        badge: premiumCleanupBadge(removedGames.length, removedBypass.length),
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

// ══════════════════════════════════════════════════════════════════════════
// APP UPDATE (Auto Update & Force Update via GitHub Releases)
// ══════════════════════════════════════════════════════════════════════════
// PUBLIK — sengaja TANPA requireUser/requireAdmin, karena App harus bisa cek
// update SEBELUM user login (termasuk kalau token sudah kedaluwarsa/invalid).
app.get('/api/app-update', async (req, res) => {
  try {
    const cfg = await appUpdateManager.getConfig();
    res.json(appUpdateManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/app-update', requireAdmin, async (req, res) => {
  try {
    const cfg = await appUpdateManager.getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/app-update', requireAdmin, async (req, res) => {
  try {
    const prev = await appUpdateManager.getConfig();
    const next = await appUpdateManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan App Update — versi terbaru: ${next.latestVersion}, Auto Update: ${next.autoUpdateEnabled ? 'AKTIF' : 'NONAKTIF'}, Force Update: ${next.forceUpdateEnabled ? 'AKTIF' : 'NONAKTIF'}.`,
      meta: { latestVersion: next.latestVersion, autoUpdateEnabled: next.autoUpdateEnabled, forceUpdateEnabled: next.forceUpdateEnabled }
    }).catch(() => {});

    // Webhook opsional (kategori "Update Aplikasi") — cuma dikirim kalau versi
    // terbaru BENAR-BENAR berubah, biar admin toggle Auto/Force Update kecil-kecilan
    // tidak bikin channel Discord spam versi yang sama berulang-ulang.
    if (prev.latestVersion !== next.latestVersion) {
      webhookManager.sendCategoryWebhook('app_update', {
        eventId: `app_update:${next.latestVersion}`,
        embed: buildEmbed({
          status: 'update',
          badge: 'update',
          title: 'Update Aplikasi Baru Dirilis',
          description: next.changelog || `Versi ${next.latestVersion} sudah tersedia.`,
          admin: req.admin?.username || 'Admin',
          fields: [
            field('🔢 Versi Sebelumnya', prev.latestVersion, true),
            field('🔢 Versi Terbaru', next.latestVersion, true),
            field('⚙️ Auto Update', next.autoUpdateEnabled ? 'Aktif' : 'Nonaktif', true),
            field('🚨 Force Update', next.forceUpdateEnabled ? 'Aktif' : 'Nonaktif', true)
          ],
          appName: APP_NAME,
          footerNote: 'Update Aplikasi'
        })
      }).catch(() => {});
    }

    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// MAINTENANCE MODE
// ══════════════════════════════════════════════════════════════════════════
// PUBLIK — sengaja TANPA requireUser (bukan requireAdmin juga), karena App
// harus bisa cek status maintenance SEBELUM user sempat login sama sekali.
// Kalau App punya token tersimpan (user pernah login sebelumnya di sesi lalu),
// token itu BOLEH ikut dikirim lewat header Authorization (opsional) supaya
// server bisa tahu apakah user ini termasuk whitelist / role admin (otomatis
// bypass) — kalau token tidak ada/tidak valid, tetap dijawab normal sebagai
// user anonim (bypass: false), TIDAK di-anggap error.
app.get('/api/maintenance-status', async (req, res) => {
  try {
    const cfg = await maintenanceManager.getConfig();
    let discordId = null, role = null;
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token && JWT_SECRET) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        discordId = payload.discordId || null;
        if (discordId && db) {
          const u = await db.collection('users').findOne({ discordId }, { projection: { role: 1 } });
          role = u?.role || null;
        }
      } catch (e) { /* token invalid/kedaluwarsa -> tetap dianggap anonim, jangan error */ }
    }
    const bypass = maintenanceManager.computeBypass(cfg, discordId, role);
    res.json(maintenanceManager.toPublicPayload(cfg, bypass));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const cfg = await maintenanceManager.getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const prev = await maintenanceManager.getConfig();
    const next = await maintenanceManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');

    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin ${next.enabled ? 'MENGAKTIFKAN' : 'MENONAKTIFKAN'} Maintenance Mode${next.enabled ? ` — "${next.title}"` : ''}.`,
      meta: { enabled: next.enabled, title: next.title, whitelistCount: (next.whitelist || []).length }
    }).catch(() => {});

    // Realtime — App yang sedang online & login langsung dapat status
    // terbaru (personalized per user, lihat broadcastToClients di
    // maintenanceManager.js) TANPA perlu restart app.
    maintenanceManager.broadcastToClients().catch(() => {});

    // Webhook opsional (kategori "Aktivitas Admin") — cuma dikirim kalau status
    // ON/OFF-nya benar-benar berubah, biar tidak spam kalau admin cuma edit teks kecil.
    if (prev.enabled !== next.enabled) {
      webhookManager.sendCategoryWebhook('admin_activity', {
        eventId: `maintenance:${next.enabled}:${next.updatedAt}`,
        embed: buildEmbed({
          status: next.enabled ? 'warning' : 'success',
          badge: 'admin',
          title: next.enabled ? 'Maintenance Mode Diaktifkan' : 'Maintenance Mode Dinonaktifkan',
          description: next.enabled ? (next.description || next.title) : 'App kembali normal, semua user sudah bisa memakai App seperti biasa.',
          admin: req.admin?.username || 'Admin',
          appName: APP_NAME,
          footerNote: 'Maintenance Mode'
        })
      }).catch(() => {});
    }

    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════
// PUBLIK — sengaja TANPA requireUser/requireAdmin, sama seperti /api/app-update,
// karena App perlu tahu link ZIP & status fitur ini begitu dibuka/user buka
// halaman Settings, tanpa tergantung status login.
app.get('/api/active-tools', async (req, res) => {
  try {
    const cfg = await activeToolsManager.getConfig();
    res.json(activeToolsManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/active-tools', requireAdmin, async (req, res) => {
  try {
    const cfg = await activeToolsManager.getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/active-tools', requireAdmin, async (req, res) => {
  try {
    const next = await activeToolsManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan Active Tools — versi: ${next.version || '-'}, status: ${next.enabled ? 'AKTIF' : 'NONAKTIF'}.`,
      meta: { version: next.version, enabled: next.enabled }
    }).catch(() => {});
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CLOUD FIX — sama persis strukturnya dengan Active Tools di atas, hanya beda
// link/endpoint dan App-nya cuma buka link eksternal (bukan download/extract).
// Diatur di halaman Admin Web yang SAMA dengan Active Tools (lihat pageActivetools).
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/cloud-fix', async (req, res) => {
  try {
    const cfg = await cloudFixManager.getConfig();
    res.json(cloudFixManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/cloud-fix', requireAdmin, async (req, res) => {
  try {
    const cfg = await cloudFixManager.getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/cloud-fix', requireAdmin, async (req, res) => {
  try {
    const next = await cloudFixManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan Cloud FIX — status: ${next.enabled ? 'AKTIF' : 'NONAKTIF'}.`,
      meta: { enabled: next.enabled }
    }).catch(() => {});
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// LOG PENGGUNAAN ACTIVE TOOLS & CLOUD FIX
// ══════════════════════════════════════════════════════════════════════════
// Proses install/extract KEDUA fitur ini terjadi 100% di App (IPC main process,
// lihat 'active-tools-install' & 'cloud-fix-install' di main.js) — server tidak
// pernah terlibat sama sekali di prosesnya. Supaya tiap pemakaian tetap tercatat
// di Logs → Riwayat Aktivitas Sistem (dan realtime ke Admin Web seperti log
// lainnya), App melapor ke endpoint tipis ini SETELAH proses selesai (berhasil
// ATAU gagal — lihat runActiveToolsInstall()/runCloudFixInstall() di app.js).
// Endpoint ini SENGAJA cuma membungkus logActivity() yang SUDAH ADA — bukan
// sistem log baru — jadi otomatis muncul di halaman Logs & Dashboard yang sama,
// dengan realtime push yang sama (broadcastAdmin('activity', ...) di dalam
// logActivity()), TANPA perlu refresh halaman Admin Web.
//
// Best-effort dari sisi App: kalau request ini gagal (mis. lagi offline sebentar),
// itu TIDAK PERNAH membatalkan/mengganggu proses install Active Tools/Cloud FIX
// yang sudah selesai — App memanggilnya di blok `finally`, sesudah UI beres,
// dan errornya di-swallow (lihat logToolUsage() di app.js).
const TOOL_USAGE_LOG_TYPES = {
  active_tools: { type: 'active_tools_use', label: 'Active Tools' },
  cloud_fix:    { type: 'cloud_fix_use',    label: 'Cloud FIX' }
};
app.post('/api/tools/log-use', requireUser, async (req, res) => {
  try {
    const { feature, status, message } = req.body || {};
    const cfg = TOOL_USAGE_LOG_TYPES[feature];
    if (!cfg) return res.status(400).json({ error: 'Fitur tidak dikenal.' });

    // Status dari App cuma 2 kemungkinan yang relevan buat kita catat: berhasil
    // atau gagal. Default ke 'success' kalau App tidak mengirim status (jaga-jaga).
    const isFailed = status === 'failed' || status === 'error';

    await logActivity({
      type: cfg.type,
      username: req.user.username,
      discordId: req.user.discordId,
      role: req.user.role,
      status: isFailed ? 'error' : 'success',
      ip: getReqIp(req),
      device: getReqDevice(req),
      description: `${req.user.username} ${isFailed ? 'gagal menjalankan' : 'berhasil menggunakan'} ${cfg.label}` + (message ? ` — ${message}` : '.'),
      meta: { feature, message: message || null }
    });

    res.json({ ok: true });
  } catch (e) {
    // Best-effort di kedua sisi: kalaupun ada error tak terduga di sini, jangan
    // sampai App menganggap ini kegagalan fatal — cukup balikin 500 biasa,
    // App sudah didesain untuk cuma log-warning lokal dan lanjut jalan.
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
  download_success:      'download_success',
  download_failed:       'download_failed',
  quota_low:             'quota_low',
  quota_empty:           'quota_empty',
  period_low:            'period_low',
  period_expired:        'period_expired',
  purchase:              'purchase',
  renewal:               'renewal',
  announcement:          'announcement',
  login:                 'login',
  logout:                'login', // channel yang sama dengan Login, sesuai kategori "auth"
  system_error:          'system_error',
  voucher_claim:         'voucher',
  // Siklus PEMBAYARAN via payment gateway (KlikQRIS) — dipisah dari 'purchase'
  // (Admin manual set/upgrade paket) ke kategori 'payment' TERSENDIRI, sesuai
  // permintaan "Payment Webhook" harus punya channel sendiri dari "Package Webhook".
  purchase_success:      'payment',
  transaction_expired:   'payment',
  transaction_cancelled: 'payment',
  transaction_failed:    'payment',
  game_request_created:   'game_request',
  game_request_approved:  'game_request',
  game_request_rejected:  'game_request',
  game_request_available: 'game_request',
  // Auto Remove Premium Content — SEBELUMNYA tidak dipetakan sama sekali, jadi
  // ikut fallback default 'announcement' (nyasar ke channel Pengumuman Admin,
  // padahal isinya soal game/bypass yang dihapus). Konten ini SELALU dipicu
  // oleh paket Gold/Platinum yang berakhir, jadi dipetakan ke channel yang
  // sama dengan "Paket Berakhir" (period_expired) — bukan fallback umum.
  premium_cleanup:        'period_expired',
  // Gold Trial Claim — SEBELUMNYA tidak dipetakan sama sekali (walau sudah
  // ada kategori 'gold_trial' di discordNotifyManager.js dan komentar di
  // endpoint klaim sudah MENGASUMSIKAN mapping ini ada), jadi ikut fallback
  // default 'announcement' (nyasar ke channel Pengumuman Admin, padahal ini
  // soal status paket). Dipetakan ke kategori 'gold_trial' (configKey
  // package_lifecycle, satu channel dengan Paket/Voucher/Payment lainnya).
  gold_trial_claim:       'gold_trial',
  // Steam Account (pembelian & status order akun Steam) — SEBELUMNYA tidak
  // dipetakan SAMA SEKALI (4 jenis notifikasi ini ikut fallback default
  // 'announcement', nyasar ke channel Pengumuman Admin). Dibuatkan
  // kategori/channel baru sendiri: 'steam_account_purchase'.
  steam_account_purchase_success:  'steam_account_purchase',
  steam_account_order_expired:     'steam_account_purchase',
  steam_account_order_cancelled:   'steam_account_purchase',
  steam_account_allocation_failed: 'steam_account_purchase',
  // Marketplace (Product bundel Game/Bypass) — channel sendiri, lihat catatan
  // kategori 'marketplace_purchase' di discordNotifyManager.js.
  marketplace_purchase_success:    'marketplace_purchase',
  marketplace_order_expired:       'marketplace_purchase',
  marketplace_order_cancelled:     'marketplace_purchase'
};

// ══════════════════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// MIGRASI BUYER→PUBLIC (satu kali, idempotent) — dipanggil dari connectDB().
// Fitur role/paket BUYER sudah dihapus total dari sistem. Kalau ada dokumen
// Game/Bypass lama yang masih tersimpan dengan role: 'buyer' (dibuat sebelum
// fitur ini dihapus), turunkan otomatis jadi role: 'public' — bukan dihapus,
// supaya konten yang sudah ada tetap bisa diakses semua user, cuma statusnya
// yang berubah dari "khusus BUYER" jadi "publik".
// ══════════════════════════════════════════════════════════════════════════
async function migrateLegacyBuyerRoleToPublic() {
  if (!db) return;
  const [gamesRes, bypassesRes] = await Promise.all([
    db.collection('games').updateMany({ role: 'buyer' }, { $set: { role: 'public' } }),
    db.collection('bypasses').updateMany({ role: 'buyer' }, { $set: { role: 'public' } })
  ]);
  const migratedGames = gamesRes.modifiedCount || 0;
  const migratedBypasses = bypassesRes.modifiedCount || 0;
  if (migratedGames > 0 || migratedBypasses > 0) {
    console.log(`[Migrasi BUYER→Public] Game: ${migratedGames}, Bypass: ${migratedBypasses} diturunkan ke role 'public'.`);
  }
}

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI belum diisi di .env');
    return;
  }
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    // Ambil nama DB dari URI kalau ada, fallback ke 'test'
    const dbName = process.env.MONGODB_URI.split('/').pop()?.split('?')[0] || 'test';
    db = client.db(dbName || 'test');
    console.log(`✅ MongoDB tersambung (db: ${db.databaseName})`);

    await db.collection('users').createIndex({ discordId: 1 }, { unique: true });
    // Username profil App (BUKAN username Discord) — unique, sparse karena
    // banyak user lama belum pernah set username App sama sekali.
    await db.collection('users').createIndex({ profileUsername: 1 }, { unique: true, sparse: true });
    // PERF FIX (Admin Web > Users): sebelumnya GET /api/admin/users select SEMUA
    // user tanpa pagination lalu sort/filter dilakukan di sisi backend tanpa index
    // sama sekali — makin banyak user makin lambat. Sekarang dipakai buat server-side
    // pagination + filter role/status + sort createdAt (lihat endpoint di bawah).
    await db.collection('users').createIndex({ role: 1, createdAt: -1 });
    await db.collection('users').createIndex({ status: 1, createdAt: -1 });
    await db.collection('users').createIndex({ createdAt: -1 });
    await db.collection('users').createIndex({ username: 'text' });
    await db.collection('games').createIndex({ role: 1 });
    await db.collection('games').createIndex({ category: 1 });
    await db.collection('games').createIndex({ categories: 1 });
    // Dipakai buat sort default (createdAt) di admin Daftar Game — server-side
    // pagination tetap cepat walau datanya sudah ribuan.
    await db.collection('games').createIndex({ createdAt: -1 });
    await db.collection('categories').createIndex({ slug: 1 }, { unique: true });
    await db.collection('bypasses').createIndex({ role: 1 });
    // Sama seperti games — buat admin Daftar Bypass (server-side pagination).
    await db.collection('bypasses').createIndex({ createdAt: -1 });
    await db.collection('history').createIndex({ userId: 1, createdAt: -1 });
    // Dedup guard: 1 downloadAttemptId cuma boleh menghasilkan 1 baris histori (lihat
    // pengecekan idempotensi di POST /api/history). partialFilterExpression supaya index
    // unique ini TIDAK berlaku untuk histori lama yang belum punya downloadAttemptId (null).
    await db.collection('history').createIndex(
      { downloadAttemptId: 1 },
      { unique: true, partialFilterExpression: { downloadAttemptId: { $type: 'string' } } }
    );
    await db.collection('downloadAttempts').createIndex({ discordId: 1, createdAt: -1 });
    await db.collection('downloadAttempts').createIndex({ status: 1, createdAt: -1 });
    // Attempt yang "nyangkut" di status 'started' (user tutup app di tengah proses, dsb)
    // otomatis dibersihkan setelah 3 hari — TIDAK memengaruhi kuota (memang tidak pernah
    // dikurangi untuk attempt yang belum sukses).
    await db.collection('downloadAttempts').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 259200, partialFilterExpression: { status: 'started' } }
    );
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
    await db.collection('gameRequests').createIndex({ discordId: 1, appId: 1, requestedAt: -1 });
    await db.collection('gameRequests').createIndex({ status: 1, requestedAt: -1 });
    await db.collection('gameRequests').createIndex({ discordId: 1, requestedAt: -1 });
    // Voucher Paket Gold/Platinum — kode unik + cegah 1 user klaim voucher sama 2x.
    await voucherManager.ensureIndexes();
    await goldTrialManager.ensureIndexes();

    // Foto profil App — index unik discordId untuk koleksi profilePhotos (lihat
    // profileManager.js — foto disimpan di MongoDB, bukan disk lokal, supaya
    // persisten lintas deploy/build).
    await profileManager.ensureIndexes();

    // Upgrade Paket (KlikQRIS) — index buat transaksi (orderId unik, lookup per user,
    // sweep expiry), lalu muat harga/limit paket dari DB ke DOWNLOAD_LIMITS di memori.
    await transactionManager.ensureIndexes();
    await refreshDownloadLimits();

    // Auto Order Paket Gold & Platinum via Discord Bot — lihat discordAutoOrderManager.js.
    await discordAutoOrderManager?.ensureIndexes();

    // Automatic Watermark Detection — lihat watermarkManager.js.
    await watermarkManager.ensureIndexes();

    await steamAccountManager.ensureIndexes();
    await steamAccountOrderManager.ensureIndexes();

    await marketplaceManager.ensureIndexes();
    await marketplaceOrderManager.ensureIndexes();

    // Migrasi satu kali: role BUYER sudah dihapus total dari sistem (bukan lagi
    // status akses yang valid). Game/Bypass lama yang MASIH tersimpan dengan
    // role: 'buyer' (peninggalan sebelum fitur ini dihapus) otomatis diturunkan
    // jadi role: 'public' supaya tidak ada item yang "nyangkut" tidak bisa
    // diakses siapapun. Idempotent — aman dijalankan ulang tiap start (kalau
    // sudah tidak ada dokumen role:'buyer', updateMany ini tidak melakukan apa-apa).
    migrateLegacyBuyerRoleToPublic().catch(e => console.warn('[Migrasi BUYER→Public] Gagal:', e.message));

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

    // Live Chat Support — index TTL 24 jam + index lookup per percakapan (lihat
    // liveChatManager.js).
    await liveChatManager.ensureIndexes();

    // Cron ringan: cek tiap 5 menit apakah minggu leaderboard sudah berganti,
    // kalau ya snapshot leaderboard minggu sebelumnya ke `leaderboardHistory`.
    checkLeaderboardWeekRollover().catch(() => {});
    setInterval(() => checkLeaderboardWeekRollover().catch(() => {}), 5 * 60 * 1000);

    // Cron ringan: cek tiap 5 menit apakah tanggal (WIB) sudah berganti, kalau ya
    // jalankan reset limit download harian SEMUA user secara proaktif (bukan cuma
    // lazy-check per-request seperti sebelumnya) + kirim 1 webhook ringkasan.
    checkDailyQuotaResetRollover().catch(() => {});
    setInterval(() => checkDailyQuotaResetRollover().catch(() => {}), 5 * 60 * 1000);

    // Cron ringan: cek tiap 5 menit, hapus pesan Live Chat Support yang
    // UMURNYA sudah > 24 jam dari createdAt masing-masing (murni berdasar
    // umur pesan, BUKAN berdasar pergantian tanggal/hari — lihat catatan
    // EXPIRY PESAN di liveChatManager.js). Pelengkap TTL index Mongo supaya
    // data lama tidak menumpuk di database.
    liveChatManager.cleanupExpiredMessages().catch(() => {});
    setInterval(() => liveChatManager.cleanupExpiredMessages().catch(() => {}), 5 * 60 * 1000);

    // Cron ringan: retry OTOMATIS role Discord (Gold/Platinum/Public) yang
    // sempat gagal di-ADD/REMOVE (rate limit, Discord API error sesaat, dll —
    // lihat reconcilePendingRoleSyncs() di discordRoleSync.js). Sebelumnya
    // kegagalan seperti ini cuma bisa diperbaiki lewat "Full Resync" manual
    // di Admin Web — sekarang otomatis dicoba ulang tiap 5 menit sampai
    // benar-benar sesuai database, tanpa aksi admin apapun (poin 8 & 19 audit
    // "Role Reconciliation").
    setInterval(() => roleSync.reconcilePendingRoleSyncs().catch(e => console.warn('[RoleSync Reconcile] Gagal:', e.message)), 5 * 60 * 1000);
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
    // Untuk request yang dibuka lewat tab baru (window.open), browser TIDAK mengirim
    // header Authorization sama sekali — jadi fallback ke query string ?token=
    // (dipakai khusus link seperti "Lihat/Download Transcript").
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || null);
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

// MODULE BARU — Discord Ticket Management System. Semua endpoint di-mount di
// bawah /api/admin/ticket-system/* dan WAJIB requireAdmin (sudah dihandle di
// dalam ticketRoutes.js per-route, konsisten dengan pola fitur admin lain).
const ticketRoutes = require('./ticketRoutes')({ ticketManager: ticketSystemManager, requireAdmin });
app.use('/api/admin/ticket-system', ticketRoutes);

// MODULE BARU — Live Chat Support. userRouter (App Desktop, requireUser) di-mount
// di /api/livechat, adminRouter (Admin Web, requireAdmin) di /api/admin/livechat.
const liveChatRoutesFactory = require('./liveChatRoutes')({
  liveChatManager, requireUser, requireAdmin,
  broadcastAdmin: (...args) => broadcastAdmin(...args),
  wsSendToUser: (...args) => wsSendToUser(...args)
});
app.use('/api/livechat', liveChatRoutesFactory.userRouter);
app.use('/api/admin/livechat', liveChatRoutesFactory.adminRouter);

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
    let discordJoinedAt = null; // tanggal join Discord SEBENARNYA (dari Discord, bukan tanggal akun App dibuat) — dipakai Gold Trial buat validasi "member baru".
    try {
      const memberRes = await axios.get(`https://discord.com/api/guilds/${guildId}/members/${discordUser.id}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
      });
      isMember = true;
      if (memberRes.data?.joined_at) discordJoinedAt = new Date(memberRes.data.joined_at);
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
          // Handle Discord asli (@username) — dipisah dari `username` di atas (yang
          // sebenarnya display name/global_name) supaya keduanya bisa ditampilkan
          // terpisah, mis. di card "Steam & Discord Detection" halaman Setting.
          discordUsername: discordUser.username,
          discordDiscriminator: discordUser.discriminator && discordUser.discriminator !== '0' ? discordUser.discriminator : null,
          avatarUrl,
          lastLoginAt: now,
          // Tanggal join Discord server (bukan tanggal akun App dibuat) — dipakai
          // Gold Trial buat cek "member baru". $set (bukan $setOnInsert) karena kalau
          // Discord API sempat gagal balikin joined_at di login pertama, login
          // berikutnya akan tetap coba isi ulang; kalau sudah pernah terisi valid,
          // nilainya tetap konsisten (Discord selalu balikin joined_at yang sama).
          ...(discordJoinedAt ? { discordJoinedAt } : {})
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
    // eventId TIDAK menyertakan timestamp presisi milidetik (beda dari sebelumnya)
    // — kalau endpoint /auth callback ini sempat ke-trigger dobel (retry jaringan/
    // redirect ganda dari OAuth provider) dalam window singkat, sekarang benar-benar
    // ke-dedup jadi SATU webhook, bukan 2 webhook terpisah untuk 1 login yang sama.
    webhookManager.sendCategoryWebhook('login', {
      eventId: `login:${user.discordId}`,
      embed: buildEmbed({
        status: 'success',
        badge: 'user',
        title: 'Login Akun',
        description: `${user.username} berhasil login lewat Discord OAuth.`,
        username: user.username,
        role: user.role || 'public',
        userId: user.discordId,
        thumbnail: avatarUrl,
        appName: APP_NAME,
        footerNote: 'Login Akun'
      })
    }).catch(() => {});

    // Webhook kategori "Login Akun" tersendiri untuk REGISTER — dikirim HANYA
    // sekali saat akun benar-benar baru dibuat (bukan tiap login biasa), sesuai
    // event "Register" yang diminta terpisah dari "Login".
    if (isNewAccount) {
      webhookManager.sendCategoryWebhook('login', {
        eventId: `register:${user.discordId}`,
        embed: buildEmbed({
          status: 'success',
          badge: 'user',
          title: 'Akun Baru Terdaftar',
          description: `${user.username} mendaftar & login pertama kali lewat Discord OAuth.`,
          username: user.username,
          role: user.role || 'public',
          userId: user.discordId,
          thumbnail: avatarUrl,
          appName: APP_NAME,
          footerNote: 'Register'
        })
      }).catch(() => {});
    }

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

// ── Display-name paket: "public" (internal) ditampilkan sebagai "Gratis" ──
// Value role di database/API/access-control TETAP 'public' di mana-mana
// (role, activeUntil, hierarki hasCatalogAccess, dst — TIDAK diubah sama
// sekali). SATU-SATUNYA yang berubah adalah teks yang dibaca user/admin:
// notifikasi (DM/webhook), Discord embed package card, activity log Admin
// Web, dan pesan error API. Sebelumnya banyak tempat langsung menulis
// `${role.toUpperCase()}` yang otomatis jadi teks "PUBLIC" kalau role-nya
// 'public' — semua titik itu sekarang lewat fungsi ini supaya konsisten satu
// sumber, dan supaya ke depannya cukup ubah di SATU tempat ini saja.
const ROLE_DISPLAY_LABEL = { public: 'Gratis', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };
function roleLabel(role) {
  return ROLE_DISPLAY_LABEL[role] || (role || 'Gratis');
}
// Versi UPPERCASE — dipakai persis di tempat yang SEBELUMNYA memanggil
// `role.toUpperCase()` buat teks notifikasi/embed (mis. "paket GOLD kamu...").
function roleLabelUpper(role) {
  return roleLabel(role).toUpperCase();
}

function publicUser(u, stats) {
  // `username`/`avatarUrl` di bawah SENGAJA memakai nilai EFEKTIF (profil App
  // kalau user sudah pernah edit, fallback ke Discord kalau belum) — supaya
  // SEMUA tampilan yang sudah ada (sidebar App, kartu user Admin Web, dst)
  // otomatis ikut berubah begitu profil App diedit, tanpa perlu mengubah nama
  // field di frontend. Lihat penjelasan lengkap di profileManager.js.
  const identity = profileManager.effectiveIdentity(u);
  return {
    discordId: u.discordId,
    username: identity.username,
    // `username` di atas historisnya dipakai sebagai DISPLAY NAME (global_name Discord
    // kalau ada, atau Display Name App kalau sudah diisi). `discordUsername` ini handle
    // Discord asli (@handle) — dipisah biar card "Steam & Discord Detection" bisa
    // nampilin keduanya, dan TIDAK PERNAH ikut berubah oleh Edit Profil App.
    discordUsername: u.discordUsername || null,
    displayName: identity.username,
    avatarUrl: identity.avatarUrl,
    // Profil App mentah + identitas Discord read-only, dipakai halaman Edit Profil.
    profile: profileManager.toProfilePayload(u),
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
        // Nilai efektif: profil App kalau sudah diisi user, fallback ke Discord —
        // sama seperti publicUser() di atas (lihat profileManager.js).
        username: { $ifNull: ['$user.profileDisplayName', { $ifNull: ['$user.username', 'Unknown'] }] },
        // Pastikan absolute URL (bukan path relatif "/uploads/avatars/...") — ini
        // pipeline Mongo mentah, jadi tidak lewat profileManager.toAbsoluteUrl()
        // (JS). Foto profil lama yang sempat tersimpan sebagai path relatif
        // (sebelum diperbaiki) di-normalisasi di sini juga, supaya avatar di
        // Leaderboard App tidak ikut tampil rusak seperti bug yang dilaporkan.
        avatarUrl: {
          $let: {
            vars: { raw: { $ifNull: ['$user.profilePhotoUrl', '$user.avatarUrl'] } },
            in: {
              $cond: [
                { $or: [
                  { $eq: ['$$raw', null] },
                  { $regexMatch: { input: '$$raw', regex: /^(https?:\/\/|data:)/i } }
                ] },
                '$$raw',
                { $concat: [SERVER_URL, { $cond: [{ $regexMatch: { input: '$$raw', regex: /^\// } }, '$$raw', { $concat: ['/', '$$raw'] }] }] }
              ]
            }
          }
        },
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

// Cron ringan (dipanggil tiap 5 menit dari connectDB): kalau tanggal (WIB)
// sudah berganti dibanding yang tersimpan di `settings`, reset limit download
// harian (Game & Bypass) SEMUA user yang counter-nya masih nyangkut di tanggal
// lama — SEKALI jalan per hari, proaktif untuk semua user sekaligus (beda dari
// lazy-check lama yang cuma reset punya SATU user pas dia sendiri request).
// Kirim SATU webhook ringkasan (bukan DM per user, sesuai permintaan) berisi
// jumlah user yang direset.
async function checkDailyQuotaResetRollover() {
  if (!db) return;
  try {
    const today = todayDateStrJakarta();
    const settingsDoc = await db.collection('settings').findOne({ _id: 'dailyQuotaReset' });
    if (settingsDoc?.lastRunDate === today) return; // sudah pernah jalan hari ini, skip

    const staleFilter = { 'downloadUsage.date': { $exists: true, $ne: today } };
    const resetCount = await db.collection('users').countDocuments(staleFilter);
    if (resetCount > 0) {
      await db.collection('users').updateMany(staleFilter, { $set: { downloadUsage: { date: today, game: 0, bypass: 0 } } });
    }

    await db.collection('settings').updateOne(
      { _id: 'dailyQuotaReset' },
      { $set: { lastRunDate: today, lastRunAt: new Date(), resetCount } },
      { upsert: true }
    );

    logActivity({
      type: 'daily_quota_reset',
      status: 'success',
      description: `Reset limit download harian otomatis (00:00 WIB) — ${resetCount} user direset.`,
      meta: { resetCount, date: today }
    }).catch(() => {});

    // SATU webhook ringkasan (bukan DM per user) — sesuai permintaan.
    webhookManager.sendCategoryWebhook('role_change', {
      eventId: `daily_quota_reset:${today}`,
      embed: buildEmbed({
        status: 'info',
        badge: 'user',
        title: 'Reset Limit Harian Otomatis',
        description: `Limit download harian (Game & Bypass) untuk semua user telah direset otomatis pada pergantian hari (00:00 WIB).`,
        fields: [
          field('📅 Tanggal', today, true),
          field('👥 Total User Direset', String(resetCount), true)
        ],
        appName: APP_NAME,
        footerNote: 'Reset Limit Harian'
      })
    }).catch(() => {});
  } catch (e) {
    console.warn('[Daily Quota Reset] Gagal:', e.message);
  }
}
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
// Broadcast realtime daftar Games/Bypass terbaru ke SEMUA user App yang online
// (WebSocket) setiap kali admin nambah/edit/hapus — dipanggil di endpoint admin
// games & bypasses di bawah. Payload sama persis dengan GET /api/games dan
// /api/bypasses supaya client tinggal replace allGames/allBypasses langsung
// tanpa perlu fetch ulang (itulah yang bikin update kelihatan instan/realtime).
// Broadcast realtime daftar KATEGORI ke semua user App yang online tiap kali
// admin tambah/edit/hapus/reorder/toggle Active-Inactive kategori (lihat endpoint
// /api/admin/categories/*) — App langsung update Dashboard & filter kategori
// TANPA perlu fetch ulang atau restart. Hanya kategori berstatus Active yang
// dikirim (kategori Inactive tidak boleh muncul di App sama sekali).
async function broadcastCategoriesUpdate() {
  try {
    const categories = await db.collection('categories')
      .find({ isActive: { $ne: false } }) // field lama tanpa isActive dianggap Active (backward compat)
      .sort({ order: 1, name: 1 })
      .toArray();
    wsBroadcastAll('categories:update', categories.map(c => ({ _id: c._id, name: c.name, slug: c.slug })));
  } catch (e) { /* noop */ }
}

async function broadcastGamesUpdate() {
  try {
    const games = await db.collection('games').find({}).sort({ createdAt: -1 }).toArray();
    wsBroadcastAll('games:update', games.map(g => ({
      _id: g._id, name: g.name, description: g.description || '',
      imageUrl: g.imageUrl || '', role: g.role || 'public',
      sizeLabel: g.sizeLabel || '', appId: g.appId || null,
      isOnline: g.isOnline !== false, createdAt: g.createdAt || null,
      category: g.category || null,
      // Maks 4 kategori/genre paling relevan (dari genre Steam) buat ditampilkan
      // sebagai tag di kartu game Dashboard App. Fallback ke `category` tunggal
      // kalau data lama belum punya array `categories` (belum pernah di-Auto-Isi ulang).
      categories: (Array.isArray(g.categories) && g.categories.length ? g.categories : (g.category ? [g.category] : [])).slice(0, 4),
      genres: (Array.isArray(g.genres) && g.genres.length ? g.genres : (g.genre ? String(g.genre).split(',').map(s => s.trim()).filter(Boolean) : [])).slice(0, 4),
    })));
  } catch (e) { /* noop */ }
}
async function broadcastBypassesUpdate() {
  try {
    const bypasses = await db.collection('bypasses').find({}).sort({ createdAt: -1 }).toArray();
    wsBroadcastAll('bypasses:update', bypasses.map(b => ({
      _id: b._id, name: b.name, description: b.description || '',
      imageUrl: b.imageUrl || '', role: b.role || 'public',
      sizeLabel: b.sizeLabel || '',
      appId: b.appId || b.steamAppId || null,
      steamAppId: b.steamAppId || b.appId || null,
      gameId: b.gameId || null,
      isOnline: b.isOnline !== false, createdAt: b.createdAt || null,
    })));
  } catch (e) { /* noop */ }
}

app.get('/api/games', requireUser, async (req, res) => {
  try {
    // SEBELUMNYA: filter hanya game yang role-nya <= role user, jadi game
    // yang butuh paket lebih tinggi TIDAK KELIHATAN SAMA SEKALI.
    // SEKARANG: semua game tetap ditampilkan (biar user tahu game itu ada &
    // termotivasi upgrade), tapi akses/download tetap dicek & diblokir server
    // di /api/games/:id/download dan /api/games/:id/stream seperti biasa.
    // PERF FIX: sebelumnya `.find({})` tanpa projection -> MongoDB mengirim
    // SELURUH field tiap dokumen game (termasuk manifestUrl/zipUrl yang toh
    // dibuang lagi di res.json() di bawah) dari DB ke server, baru difilter di
    // JS. Untuk katalog besar ini bikin query lebih lambat & pemakaian memory
    // server lebih tinggi dari yang perlu. Sekarang projection dibatasi cuma
    // ke field yang benar-benar dipakai response — response contract endpoint
    // ini SAMA PERSIS seperti sebelumnya, cuma cara ambilnya lebih hemat.
    const games = await db.collection('games')
      .find({}, { projection: {
        name: 1, description: 1, imageUrl: 1, role: 1, sizeLabel: 1, appId: 1,
        isOnline: 1, createdAt: 1, category: 1, categories: 1, genres: 1, genre: 1,
        marketplaceProductIds: 1,
      } })
      .sort({ createdAt: -1 })
      .toArray();
    // Diambil SEKALI di sini (bukan per-item) — dipakai hasCatalogAccessSync()
    // buat game yang di-gate Marketplace. Lihat catatan di fungsi itu.
    const ownedProductIds = await marketplaceManager.getOwnedProductIdSet(req.user.discordId);
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
      // Maks 4 kategori/genre paling relevan (dari genre Steam) buat ditampilkan
      // sebagai tag di kartu game Dashboard App. Fallback ke `category` tunggal
      // kalau data lama belum punya array `categories` (belum pernah di-Auto-Isi ulang).
      categories: (Array.isArray(g.categories) && g.categories.length ? g.categories : (g.category ? [g.category] : [])).slice(0, 4),
      genres: (Array.isArray(g.genres) && g.genres.length ? g.genres : (g.genre ? String(g.genre).split(',').map(s => s.trim()).filter(Boolean) : [])).slice(0, 4),
      // Game yang terhubung ke Marketplace Product (>=1 productId) — App
      // pakai ini buat tahu harus tampilkan "Tidak Ada Akses -> Lihat Product"
      // alih-alih pesan upgrade paket biasa.
      marketplaceProductIds: Array.isArray(g.marketplaceProductIds) ? g.marketplaceProductIds : [],
      // hasAccess: role/paket biasa UNTUK game normal, ATAU purchase/whitelist
      // Marketplace kalau game ini konten Marketplace (role diabaikan total).
      hasAccess: hasCatalogAccessSync(req.user, g, ownedProductIds),
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
    // Hanya kategori Active yang boleh muncul di App (Dashboard & halaman Game) —
    // kategori Inactive TIDAK dikirim sama sekali. Field lama tanpa `isActive`
    // (data sebelum fitur ini ada) dianggap Active supaya tidak tiba-tiba hilang.
    const categories = await db.collection('categories')
      .find({ isActive: { $ne: false } })
      .sort({ order: 1, name: 1 })
      .toArray();
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
    params: { appids: appId, l: 'english', cc: 'us' },
    timeout: 12000
  });
  const entry = steamRes.data?.[appId];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;

  // Harga dalam sen USD (price_overview.final) — dipakai KHUSUS untuk fitur
  // "Tambah Banyak Sekaligus" di Steam Account (urutkan game termahal di
  // paling awal). null kalau Steam tidak kasih info harga (misal game region-
  // locked/delisted) — ditangani sebagai "tidak diketahui" di sorting, BUKAN
  // dianggap gratis, supaya tidak salah taruh di posisi termahal atau paling
  // bawah secara keliru.
  const price = d.price_overview ? d.price_overview.final : (d.is_free ? 0 : null);
  const priceFormatted = d.price_overview ? d.price_overview.final_formatted : (d.is_free ? 'Free' : null);

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
    isFree: !!d.is_free,
    price,
    priceFormatted,
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

    // Cek akses user — role/paket ATAU entitlement Marketplace (lihat hasCatalogAccess).
    if (!(await hasCatalogAccess(req.user, game))) {
      return res.status(403).json(catalogAccessDeniedPayload(game));
    }

    // Game ini konten Product Marketplace (relasi marketplaceProductIds yang sama
    // dipakai hasCatalogAccess di atas) -> download-nya TIDAK PERNAH dihitung ke
    // kuota harian sama sekali, walau statusnya public/gold. Akses tetap sudah
    // divalidasi lewat purchase/whitelist Product (hasCatalogAccess di atas).
    const isMarketplaceItem = isMarketplaceCatalogItem(game);

    // Cek kuota download harian (kategori Game) TANPA mengurangi apapun dulu —
    // limit baru benar-benar dikurangi setelah download+install SUKSES (lihat
    // POST /api/history & consumeAttemptQuota). public/gold dibatasi,
    // platinum/admin unlimited (lihat DOWNLOAD_LIMITS). Dilewati sama sekali
    // untuk konten Product Marketplace (lihat isMarketplaceItem di atas).
    let quota;
    if (isMarketplaceItem) {
      quota = { ok: true, limit: null, used: null, remaining: null, marketplace: true };
    } else {
      quota = peekDownloadQuota(req.user, 'game');
      if (!quota.ok) {
        return res.status(429).json({ error: quota.message });
      }
    }

    const rawUrl = game.manifestUrl || game.zipUrl || null;
    if (!rawUrl) {
      return res.status(404).json({ error: 'File download untuk game ini belum diatur admin. Hubungi admin.' });
    }

    const attempt = await createDownloadAttempt(req.user, 'game', game._id, game.name, game.imageUrl || null, isMarketplaceItem);

    res.json({
      streamPath: `/api/games/${req.params.id}/stream`, // client download lewat sini (proxy server)
      appId:      game.appId || null,
      steamAppId: game.appId || null,
      name:       game.name,
      downloadAttemptId: String(attempt._id),
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

    if (!(await hasCatalogAccess(user, game))) {
      return res.status(403).json(catalogAccessDeniedPayload(game));
    }

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
      if (!game.appId) return res.status(400).json({ error: 'Game ini belum bisa diunduh — App ID belum diatur admin.' });
      return await streamHubcapManifest(game.appId, res, game.name);
    }
    if (isRyu) {
      if (!game.appId) return res.status(400).json({ error: 'Game ini belum bisa diunduh — App ID belum diatur admin.' });
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

    if (!(await hasCatalogAccess(req.user, bypass))) {
      return res.status(403).json(catalogAccessDeniedPayload(bypass));
    }

    const url = bypass.zipUrl || bypass.link || bypass.driveLink || null;
    if (!url) {
      return res.status(404).json({ error: 'Link bypass belum diatur admin. Hubungi admin untuk mengisi link file bypass.' });
    }

    // Bypass ini konten Product Marketplace (relasi marketplaceProductIds yang sama
    // dipakai hasCatalogAccess di atas) -> download-nya TIDAK PERNAH dihitung ke
    // kuota harian sama sekali. Akses tetap sudah divalidasi lewat purchase/whitelist
    // Product (hasCatalogAccess di atas).
    const isMarketplaceItem = isMarketplaceCatalogItem(bypass);

    // Cek kuota download harian (kategori Bypass) TANPA mengurangi apapun dulu —
    // limit baru benar-benar dikurangi setelah download+install SUKSES (lihat
    // POST /api/history & consumeAttemptQuota). public/gold dibatasi,
    // platinum/admin unlimited (lihat DOWNLOAD_LIMITS). Dilewati sama sekali
    // untuk konten Product Marketplace (lihat isMarketplaceItem di atas).
    let quota;
    if (isMarketplaceItem) {
      quota = { ok: true, limit: null, used: null, remaining: null, marketplace: true };
    } else {
      quota = peekDownloadQuota(req.user, 'bypass');
      if (!quota.ok) {
        return res.status(429).json({ error: quota.message });
      }
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
        // User-facing — generik, jangan sebut nama provider.
        return res.status(400).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
      }
      const attempt = await createDownloadAttempt(req.user, 'bypass', bypass._id, bypass.name, bypass.imageUrl || null, isMarketplaceItem);
      return res.json({
        streamPath: `/api/bypasses/${req.params.id}/ryuu-stream`,
        name:       bypass.name,
        steamAppId: bypass.steamAppId || bypass.appId || null,
        downloadAttemptId: String(attempt._id),
        downloadQuota: quota
      });
    }

    // Link non-Ryuu (GitHub Release, Google Drive, CDN lain) — tetap seperti sebelumnya,
    // return langsung URL-nya ke client.
    const attempt = await createDownloadAttempt(req.user, 'bypass', bypass._id, bypass.name, bypass.imageUrl || null, isMarketplaceItem);
    res.json({
      directUrl:  url,
      name:       bypass.name,
      steamAppId: bypass.steamAppId || bypass.appId || null,
      downloadAttemptId: String(attempt._id),
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

    if (!(await hasCatalogAccess(req.user, bypass))) {
      return res.status(403).json(catalogAccessDeniedPayload(bypass));
    }

    const url = bypass.zipUrl || bypass.link || bypass.driveLink || null;
    if (!url || !/ryuu\.lol/i.test(url)) {
      return res.status(400).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
    }
    if (!RYUU_API_KEY) {
      return res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
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
      // Detail teknisnya (nama provider, pesan asli) CUMA ke console/log server —
      // response ke user WAJIB generik (lihat GENERIC_DOWNLOAD_ERROR_MSG di atas).
      console.error('[BYPASS STREAM] Gagal terhubung ke provider:', e.message);
      logActivity({ type: 'ryu_api_error', status: 'error', description: `Gagal proxy download bypass "${bypass.name}" lewat Ryuu Generator: ${e.message}`, meta: { bypassId: String(bypass._id) } }).catch(() => {});
      return res.status(502).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
    }

    if (ryuuRes.status !== 200) {
      // Baca body error (biasanya JSON kecil kayak {"error":"..."}) — dipakai CUMA
      // buat log internal admin (informatif), TIDAK PERNAH diteruskan ke user.
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

      logActivity({
        type: 'ryu_api_error', status: 'error',
        description: `Proxy download bypass "${bypass.name}" lewat Ryuu Generator gagal (HTTP ${ryuuRes.status}): ${parsedMsg || '(tanpa pesan)'}`,
        meta: { bypassId: String(bypass._id), httpStatus: ryuuRes.status }
      }).catch(() => {});

      // Semua respons ke USER generik — status code tetap relevan (429 vs error biasa),
      // tapi teksnya tidak pernah menyebut provider atau pesan mentah dari upstream.
      if (ryuuRes.status === 401 || ryuuRes.status === 403) return res.status(401).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
      if (ryuuRes.status === 404) return res.status(404).json({ error: 'Bypass ini belum tersedia di server.' });
      if (ryuuRes.status === 429) return res.status(429).json({ error: GENERIC_BUSY_ERROR_MSG });
      return res.status(502).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${(bypass.name || 'bypass').replace(/[^a-z0-9]/gi, '_')}.zip"`);
    if (ryuuRes.headers['content-length']) res.setHeader('Content-Length', ryuuRes.headers['content-length']);
    ryuuRes.data.pipe(res);
  } catch (e) {
    console.error('[BYPASS STREAM] Unexpected error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: GENERIC_DOWNLOAD_ERROR_MSG });
  }
});

app.get('/api/bypasses/:id/download', requireUser, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });

    if (!(await hasCatalogAccess(req.user, bypass))) {
      return res.status(403).json(catalogAccessDeniedPayload(bypass));
    }

    const url = bypass.zipUrl || bypass.link || null;
    if (!url) {
      return res.status(404).json({ error: 'File bypass belum diatur admin. Hubungi admin.' });
    }

    // Bypass ini konten Product Marketplace -> tidak dihitung ke kuota harian sama
    // sekali (lihat penjelasan lengkap di /api/bypasses/:id/download-link di atas).
    const isMarketplaceItem = isMarketplaceCatalogItem(bypass);

    let quota;
    if (isMarketplaceItem) {
      quota = { ok: true, limit: null, used: null, remaining: null, marketplace: true };
    } else {
      quota = peekDownloadQuota(req.user, 'bypass');
      if (!quota.ok) {
        return res.status(429).json({ error: quota.message });
      }
    }

    const attempt = await createDownloadAttempt(req.user, 'bypass', bypass._id, bypass.name, bypass.imageUrl || null, isMarketplaceItem);

    // Kembalikan appId ke client — dipakai untuk findGameFolderByAppId
    // (cari folder game di steamapps sebagai target extract).
    // Stream tetap dari link manual admin (bukan HubCap).
    res.json({
      streamPath: `/api/bypasses/${req.params.id}/stream`,
      steamAppId: bypass.steamAppId || bypass.appId || null,
      appId:      bypass.appId      || bypass.steamAppId || null,
      name:       bypass.name,
      downloadAttemptId: String(attempt._id),
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

    if (!(await hasCatalogAccess(user, bypass))) {
      return res.status(403).json(catalogAccessDeniedPayload(bypass));
    }

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
    // PERF FIX: sama seperti /api/games — projection dibatasi ke field yang
    // benar-benar dipakai, response contract tidak berubah sama sekali.
    const bypasses = await db.collection('bypasses')
      .find({}, { projection: {
        name: 1, description: 1, imageUrl: 1, role: 1, sizeLabel: 1,
        appId: 1, steamAppId: 1, gameId: 1, isOnline: 1, createdAt: 1,
        marketplaceProductIds: 1,
      } })
      .sort({ createdAt: -1 })
      .toArray();
    const ownedProductIds = await marketplaceManager.getOwnedProductIdSet(req.user.discordId);
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
      marketplaceProductIds: Array.isArray(b.marketplaceProductIds) ? b.marketplaceProductIds : [],
      hasAccess: hasCatalogAccessSync(req.user, b, ownedProductIds),
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
    const { itemType, itemId, extractedFiles, steamPath, folderPath, itemName: fallbackName, itemImage: fallbackImage, downloadAttemptId } = req.body;
    if (!['game', 'bypass'].includes(itemType)) return res.status(400).json({ error: 'itemType harus game/bypass.' });
    if (!ObjectId.isValid(itemId)) return res.status(400).json({ error: 'itemId tidak valid.' });

    // Idempotensi: kalau attemptId ini SUDAH PERNAH tercatat jadi histori sebelumnya
    // (mis. request-nya kekirim dobel karena retry jaringan di App), jangan insert
    // histori baru lagi ATAU kurangi kuota lagi — langsung balikin histori yang lama.
    if (downloadAttemptId && ObjectId.isValid(downloadAttemptId)) {
      const existing = await db.collection('history').findOne({ downloadAttemptId: String(downloadAttemptId) });
      if (existing) {
        return res.json({ success: true, _id: existing._id, alreadyRecorded: true });
      }
    }

    const collectionName = itemType === 'game' ? 'games' : 'bypasses';
    const item = await db.collection(collectionName).findOne({ _id: new ObjectId(itemId) });
    // BUG FIX: SEBELUMNYA kalau item ini sudah keburu dihapus/diedit admin di antara waktu user
    // klik install & proses inject/extract-nya selesai di PC user, route ini langsung 404 dan
    // BATAL MENYIMPAN histori sama sekali — padahal instalasinya sendiri sudah SUKSES di PC user.
    // Ini salah satu penyebab utama laporan "histori kadang hilang". Sekarang: kalau item masih
    // ada, tetap pakai data itemnya (paling akurat/terbaru); kalau sudah gak ada, fallback ke
    // nama & gambar yang sudah dikirim client sejak awal proses install, histori tetap tersimpan.
    if (!item && !fallbackName) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    // ── LIMIT DOWNLOAD BARU BOLEH DIKURANGI DI SINI — yaitu SETELAH App melaporkan
    // download+install-nya BENAR-BENAR sukses (route ini cuma dipanggil client kalau
    // sukses, lihat handleInstall() di app.js). consumeAttemptQuota() idempotent lewat
    // attemptId, jadi walau dipanggil berkali-kali untuk attempt yang sama, kuota
    // CUMA berkurang SATU KALI. ──
    const quotaResult = await consumeAttemptQuota(req.user, downloadAttemptId, itemType, item);
    if (quotaResult.alreadyConsumed) {
      console.warn(`[Histori] attemptId ${downloadAttemptId} sudah pernah dikonsumsi kuotanya sebelumnya (kemungkinan retry) — dilanjutkan tanpa mengurangi kuota lagi.`);
    }

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
      // Dipakai buat cegah histori/kuota dobel kalau request /api/history ini dikirim
      // ulang (lihat pengecekan idempotensi di atas).
      downloadAttemptId: downloadAttemptId ? String(downloadAttemptId) : null,
      // Alasan install ini DIIZINKAN — dipakai fitur Auto Remove Installed Premium
      // Content: kalau nanti masa aktif Gold/Platinum user ini habis, HANYA item
      // yang installedViaRole-nya 'gold'/'platinum' yang otomatis dihapus (item
      // yang diinstal waktu masih Public/Admin tidak ikut kehapus).
      installedViaRole: req.user.role,
      createdAt: new Date()
    });

    logActivity({
      type: 'download_success',
      username: req.user.username,
      discordId: req.user.discordId,
      role: req.user.role,
      status: 'success',
      description: `Download ${itemType === 'game' ? 'game' : 'bypass'} "${item?.name || fallbackName || 'item'}" oleh ${req.user.username} selesai diunduh.`,
      meta: { itemType, itemId, attemptId: downloadAttemptId || null }
    }).catch(() => {});

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
      meta: { itemType, itemId, attemptId: downloadAttemptId || null }
    }).catch(() => {});

    // Realtime: setiap install baru langsung mengubah Top Installer Mingguan —
    // broadcast leaderboard terbaru ke semua client yang sedang online, tanpa
    // perlu refresh/restart app.
    computeWeeklyLeaderboard(5)
      .then(lb => wsBroadcastAll('leaderboard:update', lb))
      .catch(() => {});

    const downloadNotifBanner = item ? await pickCatalogBanner(item) : (itemImageResolved || undefined);
    notifyUser(req.user.discordId, {
      type: 'download_success',
      title: 'Download Berhasil',
      message: `${itemNameResolved} (${itemType === 'game' ? 'Game' : 'Bypass'}) berhasil di-download & dipasang.`,
      // Badge dinamis Game/Bypass sesuai itemType — supaya embed & routing webhook
      // (lihat resolveWebhookCategory) sama-sama mencerminkan jenis item yang sebenarnya,
      // bukan selalu 'game'.
      badge: itemType === 'bypass' ? 'bypass' : 'game',
      fields: [
        field('👤 Username', req.user.username, true),
        field('🆔 Discord ID', req.user.discordId, true),
        // Digabung jadi satu field "Tipe • Nama" (mis. "Bypass • MECCHA CHAMELEON")
        // sesuai format contoh DM yang diminta, bukan dua field terpisah.
        field('🎮 Item', `${itemType === 'game' ? 'Game' : 'Bypass'} • ${itemNameResolved}`, true),
        field('💾 Ukuran File', item?.sizeLabel, true),
        field('🆔 App ID', item?.appId || item?.steamAppId, true),
        field('🧾 ID Riwayat', String(insertResult.insertedId), true)
      ],
      image: itemImageResolved,
      meta: { itemType, itemId },
      // Embed CHANNEL (Admin Discord) khusus — desain compact baru (lihat
      // buildDownloadEmbed): hijau untuk Game, ungu untuk Bypass, field polos
      // tanpa inline-code. DM ke user TETAP pakai gaya "card" di atas (fields).
      webhookEmbed: buildDownloadEmbed({
        kind: itemType === 'bypass' ? 'bypass' : 'game',
        status: 'success',
        itemName: itemNameResolved,
        appId: item?.appId || item?.steamAppId,
        publisher: item?.publisher,
        banner: downloadNotifBanner,
        username: req.user.username
      }),
      // DM diaktifkan lagi — sebelumnya cuma webhook (dm:false) jadi user TIDAK
      // PERNAH menerima DM "card" berbadge untuk instalasi Game/Bypass, padahal
      // ini persis contoh format DM yang diminta. Dedup + eventId tetap berlaku
      // seperti biasa jadi tidak ada resiko notifikasi dobel.
      dm: true, webhook: true
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
  // Webhook opsional (kategori "Login Akun", channel yang sama dengan Login) —
  // hanya terkirim kalau admin sudah aktifkan kategori ini di Webhook Settings.
  webhookManager.sendCategoryWebhook('login', {
    embed: buildEmbed({
      status: 'info',
      badge: 'user',
      title: 'User Logout',
      description: `${req.user.username} logout dari aplikasi.`,
      username: req.user.username,
      role: req.user.role,
      userId: req.user.discordId,
      appName: APP_NAME,
      footerNote: 'Logout Akun'
    })
  }).catch(() => {});
  res.json({ success: true });
});

// Dipanggil client (main.js/app.js) kalau proses download/extract/inject GAGAL
// di tengah jalan ATAU user membatalkan sebelum sukses — supaya user tetap dapat
// notifikasi kegagalan, dan attempt-nya ditandai gagal/batal di server.
//
// PENTING: endpoint ini TIDAK PERNAH menyentuh/mengurangi kuota download sama
// sekali — kuota memang belum pernah dikurangi di titik manapun sebelum install
// benar-benar sukses (lihat catatan di consumeAttemptQuota & POST /api/history).
// Jadi apapun alasannya (gagal mulai, API/server error, link tidak valid, file
// tidak ditemukan, koneksi putus, timeout, dibatalkan user, gagal instalasi),
// limit harian user tetap utuh.
app.post('/api/downloads/failed', requireUser, async (req, res) => {
  try {
    const { itemType, itemName, itemImage, reason, downloadAttemptId, stage, rollback } = req.body;
    // stage: 'download' (gagal saat unduh/URL/koneksi) | 'install' (unduh sukses tapi
    //        extract/copy/inject gagal) | 'cancelled' (user batalkan). Default 'download'
    //        supaya tetap kompatibel dengan client versi lama yang belum kirim field ini.
    const normalizedStage = ['download', 'install', 'cancelled'].includes(stage) ? stage : 'download';

    // Tandai attempt (kalau ada) sebagai gagal/batal — TIDAK menyentuh kuota.
    if (downloadAttemptId) {
      markDownloadAttemptFailed(req.user, downloadAttemptId, normalizedStage === 'cancelled' ? 'cancelled' : 'failed').catch(() => {});
    }

    const stageLabel = normalizedStage === 'install' ? 'Instalasi' : (normalizedStage === 'cancelled' ? 'Dibatalkan' : 'Download');
    const logType = normalizedStage === 'install' ? 'install_failed' : (normalizedStage === 'cancelled' ? 'download_cancelled' : 'download_failed');

    logActivity({
      type: logType,
      username: req.user.username,
      discordId: req.user.discordId,
      role: req.user.role,
      status: normalizedStage === 'cancelled' ? 'warning' : 'error',
      ip: getReqIp(req),
      device: getReqDevice(req),
      description: normalizedStage === 'cancelled'
        ? `${req.user.username} membatalkan download "${itemName || 'item'}" (${itemType === 'game' ? 'Game' : 'Bypass'}) — kuota tidak dikurangi.`
        : `${stageLabel} "${itemName || 'item'}" (${itemType === 'game' ? 'Game' : 'Bypass'}) gagal untuk ${req.user.username} — kuota tidak dikurangi.`,
      meta: { itemType, itemName, reason, attemptId: downloadAttemptId || null, stage: normalizedStage }
    }).catch(() => {});

    // Rollback report (dikirim App setelah selesai membersihkan file yang sempat
    // ter-download/ter-extract sebagian) — cuma di-log kalau memang ada percobaan
    // rollback (mis. tidak ada apa-apa yang perlu dibersihkan kalau baru gagal di
    // tahap URL/koneksi sebelum file apapun ditulis).
    if (rollback && typeof rollback === 'object' && rollback.attempted) {
      const rollbackOk = rollback.success !== false && (!Array.isArray(rollback.errors) || rollback.errors.length === 0);
      logActivity({
        type: rollbackOk ? 'rollback_success' : 'rollback_failed',
        username: req.user.username,
        discordId: req.user.discordId,
        role: req.user.role,
        status: rollbackOk ? 'success' : 'error',
        description: rollbackOk
          ? `Rollback file untuk "${itemName || 'item'}" berhasil — ${rollback.removed || 0} file dihapus, ${rollback.restored || 0} file dikembalikan ke versi semula.`
          : `Rollback file untuk "${itemName || 'item'}" TIDAK SEPENUHNYA berhasil — kemungkinan ada sisa file di komputer user. Detail: ${(rollback.errors || []).slice(0, 3).join('; ') || 'tidak diketahui'}.`,
        meta: { itemType, itemName, attemptId: downloadAttemptId || null, rollback }
      }).catch(() => {});
    }

    notifyUser(req.user.discordId, {
      type: 'download_failed',
      title: normalizedStage === 'cancelled' ? 'Download Dibatalkan' : 'Download Gagal',
      message: `${stageLabel} ${itemName || 'item'} (${itemType === 'game' ? 'Game' : 'Bypass'}) ${normalizedStage === 'cancelled' ? 'dibatalkan.' : 'gagal.'} Limit download harian kamu tidak berkurang.`,
      // Badge dinamis Game/Bypass sesuai itemType (lihat catatan di download_success di atas).
      badge: itemType === 'bypass' ? 'bypass' : 'game',
      fields: [
        field('👤 Username', req.user.username, true),
        field('🆔 Discord ID', req.user.discordId, true),
        field('🎮 Item', itemName ? `${itemType === 'game' ? 'Game' : 'Bypass'} • ${itemName}` : undefined, true),
        field('📝 Pesan Tambahan', reason, false)
      ],
      image: itemImage || undefined,
      meta: { itemType },
      // Embed CHANNEL khusus (lihat catatan di download_success di atas) — App
      // ID/Publisher otomatis kosong di sini karena App (client) memang tidak
      // mengirim itemId saat gagal, jadi tidak ada data asli buat ditampilkan
      // (bukan dikarang). Pesan Tambahan cuma tampil kalau `reason` memang ada.
      webhookEmbed: buildDownloadEmbed({
        kind: itemType === 'bypass' ? 'bypass' : 'game',
        status: normalizedStage === 'cancelled' ? 'cancelled' : 'failed',
        itemName: itemName || undefined,
        banner: itemImage || undefined,
        username: req.user.username,
        reason: reason || undefined
      }),
      // DM diaktifkan lagi — sama seperti download_success (lihat catatan di atas).
      dm: true, webhook: true
    }).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — CLAIM VOUCHER (lihat voucherManager.js buat validasi & logika klaim
// yang aman dari race condition). Berhasil klaim -> role user berubah ke
// Gold/Platinum, masa aktif bertambah, limit paket ikut update otomatis
// (limit dihitung dari role, lihat accountStatusSummary), realtime ke app user
// (WS account:update) & Admin Web (WS user:update), semua tercatat di Logs.
// ══════════════════════════════════════════════════════════════════════════
const VOUCHER_FAIL_MESSAGE = {
  invalid_code:    'Kode voucher tidak ditemukan/tidak valid.',
  inactive:        'Voucher ini sedang dinonaktifkan oleh Admin.',
  expired:         'Voucher ini sudah kedaluwarsa (masa berlaku habis).',
  quota_full:      'Kuota voucher ini sudah habis.',
  already_claimed: 'Kamu sudah pernah memakai voucher ini sebelumnya.'
};

app.post('/api/voucher/claim', requireUser, async (req, res) => {
  const discordId = req.user.discordId;
  const username = req.user.username || discordId;
  const rawCode = String(req.body?.code || '');
  const normCode = voucherManager.normalizeCode(rawCode);

  const logFail = (reason, voucherSnapshot) => {
    logActivity({
      type: 'voucher_claim_failed',
      username, discordId, status: 'warning',
      ip: getReqIp(req),
      description: `Claim voucher "${normCode || rawCode}" oleh ${username} GAGAL: ${VOUCHER_FAIL_MESSAGE[reason] || reason}.`,
      meta: { code: normCode || rawCode, reason, voucherId: voucherSnapshot ? String(voucherSnapshot._id) : null }
    }).catch(() => {});
  };

  try {
    if (!normCode) {
      return res.status(400).json({ error: 'Kode voucher wajib diisi.' });
    }

    const result = await voucherManager.claimVoucher({ code: normCode, discordId, username });

    if (!result.ok) {
      logFail(result.reason, result.voucher);
      return res.status(400).json({ error: VOUCHER_FAIL_MESSAGE[result.reason] || 'Voucher tidak bisa diklaim.', reason: result.reason });
    }

    const voucher = result.voucher;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) {
      // Skenario nyaris mustahil (JWT valid tapi user hilang dari DB) — tapi kalau
      // sampai kejadian, jangan biarkan slot/kuota voucher sudah kepakai sia-sia.
      await db.collection('vouchers').updateOne({ _id: voucher._id }, { $inc: { usedCount: -1 } }).catch(() => {});
      await db.collection('voucherRedemptions').deleteOne({ voucherId: voucher._id, discordId }).catch(() => {});
      return res.status(404).json({ error: 'User tidak ditemukan.' });
    }

    const oldRole = user.role;
    const durationMs = voucher.durationAmount * voucherManager.DURATION_UNIT_MS[voucher.durationUnit];
    // Kalau user SAAT INI sudah di role yang SAMA dengan voucher & masih aktif ->
    // masa aktifnya DITAMBAH (extend) dari activeUntil yang ada, bukan direset dari
    // sekarang — biar user tidak dirugikan kalau masih ada sisa waktu berjalan.
    // Kalau role beda / belum ada masa aktif aktif -> dihitung dari sekarang.
    const now = new Date();
    const hasActiveSameRole = oldRole === voucher.role && user.activeUntil && new Date(user.activeUntil) > now;
    const baseTime = hasActiveSameRole ? new Date(user.activeUntil) : now;
    const activeUntil = new Date(baseTime.getTime() + durationMs);

    await db.collection('users').updateOne(
      { discordId },
      { $set: { role: voucher.role, activeUntil, roleUpdatedAt: now, isGoldTrial: false, trialLimits: null } }
    );

    // Sinkron ke Discord + DM cuma kalau rolenya beneran berubah (sama seperti alur
    // Admin set-role) — kalau user platinum klaim voucher platinum lagi, rolenya
    // tidak berubah jadi tidak perlu sinkron ulang role Discord, cukup extend waktu.
    let discordSync = null;
    if (oldRole !== voucher.role) {
      discordSync = await roleSync.syncAppRoleToDiscord(discordId, voucher.role).catch(() => null);
    }

    const durationLabel = `${voucher.durationAmount} ${voucherManager.DURATION_UNIT_LABEL[voucher.durationUnit]}`;

    notifyUser(discordId, {
      type: 'voucher_claim',
      title: 'Voucher Berhasil Diklaim!',
      message: `Voucher "${voucher.code}" berhasil diklaim — paket ${roleLabelUpper(voucher.role)} kamu ${hasActiveSameRole ? 'diperpanjang' : 'aktif'} ${durationLabel}, sampai ${fmtDateTimeWIB(activeUntil)}.`,
      dm: true, webhook: true,
      packageCard: {
        event: 'voucher',
        description: `Voucher "${voucher.code}" berhasil diklaim — paket ${hasActiveSameRole ? 'diperpanjang' : 'aktif'}.`,
        username,
        role: voucher.role,
        duration: durationLabel,
        activeUntil,
        status: '🟢 AKTIF',
        extraFields: [field('🎟️ Kode Voucher', voucher.code, false)]
      }
    }).catch(() => {});

    logActivity({
      type: 'voucher_claim_success',
      username, discordId, role: voucher.role, status: 'success',
      ip: getReqIp(req),
      before: oldRole,
      after: voucher.role,
      description: `${username} berhasil claim voucher "${voucher.code}" -> paket ${roleLabelUpper(voucher.role)} (${durationLabel}), aktif sampai ${fmtDateTimeWIB(activeUntil)}.`,
      meta: { code: voucher.code, voucherId: String(voucher._id), role: voucher.role, durationAmount: voucher.durationAmount, durationUnit: voucher.durationUnit, activeUntil }
    }).catch(() => {});

    // Webhook sudah dikirim lewat notifyUser(type:'voucher_claim', webhook:true) di atas
    // (category 'voucher' -> configKey 'package_lifecycle'). Panggilan sendCategoryWebhook
    // 'purchase' yang sebelumnya ada di sini dihapus karena keduanya menuju configKey yang
    // SAMA (package_lifecycle) sehingga menyebabkan notifikasi duplikat di satu channel Discord.

    // Realtime — role/masa aktif user langsung update di app TANPA reload/restart,
    // dan Admin Web (kalau lagi buka halaman Users/Voucher) ikut ter-update juga.
    pushAccountUpdate(discordId).catch(() => {});
    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});
    voucherManager.listVouchers()
      .then(list => broadcastAdmin('voucher:update', list.map(voucherPublic)))
      .catch(() => {});

    res.json({
      success: true,
      role: voucher.role,
      activeUntil,
      durationLabel,
      extended: hasActiveSameRole
    });
  } catch (e) {
    console.error('[Voucher] Gagal klaim:', e);
    logFail('server_error');
    res.status(500).json({ error: 'Terjadi kesalahan di server, coba lagi sebentar.' });
  }
});

// ── APP — VOUCHER TERSEDIA (buat Redeem Voucher popup) ──────────────────────
// Bukan sistem/model baru: cuma "read view" dari voucherManager existing
// (listVouchers + hasClaimed), difilter jadi voucher yang BENERAN boleh
// ditampilkan ke user ini sekarang (aktif, belum expired, kuota belum habis,
// belum pernah diklaim user ini). Database/voucherManager tetap satu-satunya
// source of truth — endpoint ini TIDAK menyimpan/menghitung apa pun sendiri.
app.get('/api/voucher/available', requireUser, async (req, res) => {
  try {
    const discordId = req.user.discordId;
    const now = new Date();
    const all = await voucherManager.listVouchers();
    const eligible = [];
    for (const v of all) {
      if (v.active === false) continue;
      if (v.expiresAt && new Date(v.expiresAt) <= now) continue;
      if (v.usedCount >= v.quota) continue;
      const claimed = await voucherManager.hasClaimed(v._id, discordId);
      if (claimed) continue;
      eligible.push({
        code: v.code,
        role: v.role,
        durationLabel: `${v.durationAmount} ${voucherManager.DURATION_UNIT_LABEL[v.durationUnit]}`
      });
    }
    res.json({ vouchers: eligible });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP — GOLD TRIAL (lihat goldTrialManager.js buat validasi & logika klaim).
// Cuma untuk user yang BENAR-BENAR baru join Discord Server SETELAH fitur ini
// pertama kali diaktifkan admin, dan belum pernah claim/punya Gold sebelumnya.
// Berhasil klaim -> role user jadi 'gold' + activeUntil sesuai durasi trial,
// TAPI limit downloadnya ambil dari pengaturan Trial (bisa beda dari limit
// paket Gold biasa, lihat effectiveDownloadLimits()). Auto-downgrade ke Public
// saat trial habis REUSE mekanisme applyExpiryIfNeeded() yang sudah ada —
// TIDAK ADA cron/job baru sama sekali.
// ══════════════════════════════════════════════════════════════════════════
const GOLD_TRIAL_FAIL_MESSAGE = {
  inactive:               'Gold Trial sedang tidak tersedia saat ini.',
  already_claimed:        'Kamu sudah pernah klaim Gold Trial sebelumnya (hanya bisa 1x per akun).',
  device_already_claimed: 'Perangkat ini sudah pernah menggunakan Gold Trial. Gold Trial hanya dapat diklaim satu kali untuk setiap perangkat.',
  device_not_verified:    'Perangkat kamu belum terverifikasi. Silakan restart aplikasi dan login ulang, lalu coba klaim Gold Trial lagi.',
  not_new_member:         'Gold Trial cuma untuk member baru Discord Server yang join setelah fitur ini aktif — akun kamu tidak memenuhi syarat ini.',
  had_gold_before:        'Kamu pernah punya paket Gold/Platinum sebelumnya, jadi tidak bisa klaim Gold Trial.',
  admin_account:          'Akun Admin tidak menggunakan sistem paket Gold/Platinum, jadi tidak bisa klaim Gold Trial.'
};

// Ambil Device ID (fingerprint) yang SUDAH terdaftar/diverifikasi lewat sistem
// Device Lock yang sudah ada (lihat deviceLock.js) untuk akun ini — DIPAKAI ULANG
// sebagai dasar validasi "1 perangkat = 1x klaim Gold Trial", TIDAK membuat sistem
// identitas perangkat baru. Device ini didaftarkan otomatis saat login (POST
// /api/device/verify, dipanggil App sebelum masuk dashboard), jadi sudah tersedia
// duluan sebelum user sempat menekan tombol Klaim Gold Trial.
async function getGoldTrialDeviceId(discordId) {
  try {
    const device = await deviceLock.getDevice(discordId);
    return device?.fingerprint || null;
  } catch (e) {
    return null;
  }
}

// Ringkasan status Gold Trial buat user ini — dipanggil App tiap buka
// dashboard/menu Gold Trial buat nentuin tampil/tidaknya banner "Gold Trial
// Gratis Tersedia" + progress kalau trial-nya lagi berjalan.
//
// ── ROOT CAUSE FIX (audit "Notifikasi Gold Trial tidak masuk"): SEBELUMNYA
// jalur OTOMATIS (Flow A — user eligible normal, BUKAN Admin TEST/Kirim
// Notifikasi) TIDAK PERNAH lewat notifyUser()/Notification Manager sama
// sekali — App cuma nge-render modal dari field `eligible`/`offer` response
// ini secara lokal (lihat applyGoldTrialAutoOffer() di app.js). Efeknya:
//   1. Tidak ada record apa pun di collection `notifications` untuk event ini
//      (padahal Flow B/Admin & Flow C/Force Claim SELALU ada) — audit trail
//      Gold Trial buat user eligible normal jadi TIDAK LENGKAP/hilang.
//   2. Kalau App sedang kebuka DIAM di halaman lain (bukan abis login/
//      reconnect, mis. baru saja menjadi eligible karena Admin BARU aktifkan
//      Gold Trial SELAGI App user tetap online), tidak ada dorongan apa pun
//      dari backend — user baru "ketemu" tawarannya kalau kebetulan reload/
//      pindah halaman/reconnect yang manggil loadGoldTrialOffer() lagi.
// Fix: begitu eligible TERKONFIRMASI oleh getEligibility() (sumber
// kebenaran yang SAMA dipakai claim/force-claim/admin lookup) DAN user ini
// belum pernah dapat notifikasi otomatis ini (`goldTrialAutoOfferNotifiedAt`
// belum ada), kirim SEKALI lewat notifyUser() EXISTING (persis pola Admin
// TEST — dm:false/webhook:false, tipe 'gold_trial_offer' yang sudah
// terdaftar di NOTIF_META) -> otomatis lewat WS 'notification' EXISTING ->
// ditangani APP oleh handleGoldTrialPushNotification() yang SUDAH ADA (lihat
// app.js) -> modal tawaran tampil. TIDAK ADA notification/Socket/listener
// baru. Fire-and-forget (tidak menghambat response GET ini) + ditandai SEKALI
// per akun (bukan tiap request, requirement: "hindari duplicate notification")
// — modal tawaran itu sendiri TETAP tampil tiap App dibuka selama eligible
// (perilaku lama, dari field `eligible`/`offer` response ini, tidak diubah),
// yang berubah cuma: sekarang ada JEJAK notifikasi resmi yang terkirim
// (SEKALI) lewat Notification Manager, bukan cuma render lokal.
// Urutan Welcome Popup: endpoint ini SELALU dipanggil App SETELAH Welcome
// Popup selesai (checkWelcomePopup(onDone) -> onDone -> loadGoldTrialOffer()
// -> GET sini, lihat app.js), jadi push ini otomatis juga baru terjadi
// SETELAH Welcome Popup, tanpa perlu logic ordering tambahan di sini.
app.get('/api/gold-trial', requireUser, async (req, res) => {
  try {
    const user = req.user;
    const deviceId = await getGoldTrialDeviceId(user.discordId);
    const eligibility = await goldTrialManager.getEligibility({ discordId: user.discordId, discordJoinedAt: user.discordJoinedAt, deviceId });
    const settings = eligibility.settings;
    const durationLabel = `${settings.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[settings.durationUnit]}`;

    if (eligibility.eligible && !user.goldTrialAutoOfferNotifiedAt) {
      const offerMessage = settings.offerMessage;
      db.collection('users').updateOne(
        { discordId: user.discordId, goldTrialAutoOfferNotifiedAt: { $exists: false } },
        { $set: { goldTrialAutoOfferNotifiedAt: new Date() } }
      ).then(result => {
        // updatedCount 0 -> kemungkinan sudah ditandai barengan (dua tab/reconnect
        // hampir bersamaan) atau race lain: SKIP kirim, cegah duplicate notification.
        if (!result.modifiedCount) return;
        notifyUser(user.discordId, {
          type: 'gold_trial_offer',
          title: 'Gold Trial Tersedia',
          message: offerMessage,
          meta: { durationLabel, gameLimit: settings.gameLimit, bypassLimit: settings.bypassLimit, source: 'auto' },
          dm: false, webhook: false
        }).catch(e => console.warn('[Gold Trial][AUTO] Gagal kirim notifikasi otomatis:', e.message));
      }).catch(e => console.warn('[Gold Trial][AUTO] Gagal menandai notified:', e.message));
    }

    const activeTrial = (user.isGoldTrial && user.role === 'gold' && user.activeUntil && new Date(user.activeUntil) > new Date())
      ? {
          activeUntil: user.activeUntil,
          gameLimit: user.trialLimits?.game ?? null,
          bypassLimit: user.trialLimits?.bypass ?? null
        }
      : null;

    res.json({
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      message: eligibility.reason ? (GOLD_TRIAL_FAIL_MESSAGE[eligibility.reason] || null) : null,
      offer: settings.active ? {
        durationAmount: settings.durationAmount,
        durationUnit: settings.durationUnit,
        durationLabel,
        gameLimit: settings.gameLimit,
        bypassLimit: settings.bypassLimit,
        offerMessage: settings.offerMessage
      } : null,
      activeTrial
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat status Gold Trial.' });
  }
});

app.post('/api/gold-trial/claim', requireUser, async (req, res) => {
  const discordId = req.user.discordId;
  const username = req.user.username || discordId;

  try {
    const deviceId = await getGoldTrialDeviceId(discordId);
    const result = await goldTrialManager.claimTrial({ discordId, username, discordJoinedAt: req.user.discordJoinedAt, deviceId });

    if (!result.ok) {
      logActivity({
        type: 'gold_trial_claim_failed',
        username, discordId, status: 'warning',
        ip: getReqIp(req),
        description: `Klaim Gold Trial oleh ${username} GAGAL: ${GOLD_TRIAL_FAIL_MESSAGE[result.reason] || result.reason}.`,
        meta: { reason: result.reason }
      }).catch(() => {});
      return res.status(400).json({ error: GOLD_TRIAL_FAIL_MESSAGE[result.reason] || 'Gold Trial tidak bisa diklaim.', reason: result.reason });
    }

    const { claim, settings } = result;
    const user = await db.collection('users').findOne({ discordId });
    if (!user) {
      // Skenario nyaris mustahil (JWT valid tapi user hilang dari DB) — jangan biarkan
      // slot klaim (unique index discordId) sudah kepakai sia-sia buat akun yang hilang.
      await db.collection('goldTrialClaims').deleteOne({ discordId }).catch(() => {});
      return res.status(404).json({ error: 'User tidak ditemukan.' });
    }

    const oldRole = user.role;
    const durationLabel = `${claim.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[claim.durationUnit]}`;

    await db.collection('users').updateOne(
      { discordId },
      {
        $set: {
          role: 'gold',
          activeUntil: claim.expiresAt,
          roleUpdatedAt: new Date(),
          isGoldTrial: true,
          trialLimits: { game: claim.gameLimit, bypass: claim.bypassLimit },
          everHadGold: true
        }
      }
    );

    const discordSync = oldRole !== 'gold' ? await roleSync.syncAppRoleToDiscord(discordId, 'gold').catch(() => null) : null;

    notifyUser(discordId, {
      type: 'gold_trial_claim',
      title: 'Gold Trial Berhasil Diaktifkan!',
      message: settings.successMessage,
      dm: true, webhook: true,
      packageCard: {
        event: 'gold_trial',
        description: settings.successMessage,
        username,
        role: 'gold_trial',
        duration: durationLabel,
        activeUntil: claim.expiresAt,
        status: '🟢 AKTIF',
        extraFields: [
          field('🎮 Limit Game/hari', claim.gameLimit === null ? 'Unlimited' : `${claim.gameLimit}x`, false),
          field('🛠️ Limit Bypass/hari', claim.bypassLimit === null ? 'Unlimited' : `${claim.bypassLimit}x`, false)
        ]
      }
    }).catch(() => {});

    logActivity({
      type: 'gold_trial_claim_success',
      username, discordId, role: 'gold', status: 'success',
      ip: getReqIp(req),
      before: oldRole,
      after: 'gold',
      description: `${username} berhasil klaim Gold Trial (${durationLabel}), aktif sampai ${fmtDateTimeWIB(claim.expiresAt)}.`,
      meta: { durationAmount: claim.durationAmount, durationUnit: claim.durationUnit, activeUntil: claim.expiresAt, gameLimit: claim.gameLimit, bypassLimit: claim.bypassLimit }
    }).catch(() => {});

    // Webhook sudah dikirim lewat notifyUser(type:'gold_trial_claim', webhook:true) di atas
    // (category 'gold_trial' -> configKey 'package_lifecycle'). Panggilan sendCategoryWebhook
    // 'gold_trial' yang sebelumnya ada di sini dihapus karena keduanya menuju configKey yang
    // SAMA (package_lifecycle) sehingga menyebabkan notifikasi duplikat di satu channel Discord.

    pushAccountUpdate(discordId).catch(() => {});
    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});
    goldTrialManager.listClaims({ limit: 200 })
      .then(list => broadcastAdmin('goldTrial:claims', list))
      .catch(() => {});
    // Riwayat Transaksi (App) langsung ke-update realtime tanpa perlu buka ulang
    // halamannya — reuse event 'transaction:update' yang sudah ada (handler-nya di
    // app.js cuma refresh list kalau halaman Riwayat Transaksi sedang dibuka, jadi
    // aman dipakai buat kind 'gold_trial' juga tanpa nambah event baru).
    const goldTrialTxItem = publicGoldTrialClaim(claim);
    wsSendToUser(discordId, 'transaction:update', goldTrialTxItem);
    broadcastAdmin('transaction:update', goldTrialTxItem);

    res.json({
      success: true,
      role: 'gold',
      activeUntil: claim.expiresAt,
      durationLabel,
      gameLimit: claim.gameLimit,
      bypassLimit: claim.bypassLimit,
      message: settings.successMessage
    });
  } catch (e) {
    console.error('[Gold Trial] Gagal klaim:', e);
    res.status(500).json({ error: 'Terjadi kesalahan di server, coba lagi sebentar.' });
  }
});
// KlikQRIS (QRIS). Alur: App minta daftar paket -> App bikin transaksi
// (POST /purchase) -> QRIS ditampilkan di App ->
// status dipantau realtime (WS `transaction:update`) sampai lunas/expired ->
// begitu lunas, role/masa aktif user diubah PERSIS seperti alur voucher
// (lihat POST /api/voucher/claim di atas) supaya semua efek ikutan (limit
// download, sinkron Discord, auto-hapus konten premium saat nanti masa aktif
// habis, dst) otomatis konsisten — TIDAK ADA logika baru yang terpisah.
// ══════════════════════════════════════════════════════════════════════════

// Daftar 3 paket (Public/Gold/Platinum) + status paket aktif user saat ini —
// dipakai halaman "Upgrade Paket" & tabel perbandingan benefit di App.
app.get('/api/packages', requireUser, async (req, res) => {
  try {
    const packages = await packageManager.getPackagesPublic();
    const gatewayCfg = await klikqrisManager.getSettings();
    const user = req.user;
    res.json({
      packages,
      paymentMethods: gatewayCfg.enabled ? klikqrisManager.PAYMENT_METHODS : [],
      gatewayEnabled: gatewayCfg.enabled,
      current: {
        role: user.role,
        activeUntil: user.activeUntil || null,
        status: accountStatusSummary(user)
      }
    });
  } catch (e) {
    console.error('[Upgrade Paket] Gagal ambil daftar paket:', e);
    res.status(500).json({ error: 'Gagal memuat daftar paket.' });
  }
});

const PURCHASE_TIER_LABEL = { gold: 'Gold', platinum: 'Platinum' };

// Mulai transaksi pembelian/upgrade/perpanjangan paket Gold atau Platinum.
app.post('/api/packages/purchase', requireUser, async (req, res) => {
  const discordId = req.user.discordId;
  const username = req.user.username || discordId;
  const tier = String(req.body?.tier || '').toLowerCase();
  const method = String(req.body?.method || '');

  try {
    if (!['gold', 'platinum'].includes(tier)) {
      return res.status(400).json({ error: 'Paket tidak valid (harus gold atau platinum).' });
    }
    if (!klikqrisManager.isValidMethod(method)) {
      return res.status(400).json({ error: 'Metode pembayaran tidak valid.' });
    }

    const packages = await packageManager.getPackages();
    const pkg = packages[tier];
    if (!pkg.active) {
      return res.status(400).json({ error: `Paket ${PURCHASE_TIER_LABEL[tier]} sedang tidak tersedia (dinonaktifkan Admin).` });
    }

    // Satu user cuma boleh punya SATU transaksi pending aktif di satu waktu —
    // kalau ada, arahkan lanjutkan transaksi lama itu (idempotent, tidak bikin
    // invoice dobel yang bisa bikin bingung/bayar dua kali tanpa sadar).
    const gatewayCfg = await klikqrisManager.getSettings();
    const existingPending = await transactionManager.getActivePendingForUser(discordId);
    if (existingPending) {
      // PENTING — transaksi lama HANYA boleh di-resume kalau DUA-DUANYA cocok:
      //   1) provider === 'klikqris' (transaksi peninggalan provider LAMA
      //      sebelum migrasi — mis. Pakasir — field qrisImage/qrisUrl-nya
      //      TIDAK ADA sama sekali, cuma paymentNumber/VA lama yang masih
      //      terisi. Kalau ini di-resume, App jatuh ke fallback
      //      api.qrserver.com yang GENERATE ULANG QR dari teks paymentNumber
      //      itu — hasilnya QR BUKAN dari KlikQRIS sama sekali & pasti
      //      invalid saat discan.)
      //   2) paymentMode SAMA dengan mode gateway yang aktif SEKARANG (kalau
      //      Admin baru ganti Sandbox<->Production sementara transaksi lama
      //      masih pending, resume bakal nampilin QRIS dari environment yang
      //      salah — sama-sama invalid dipakai bayar sungguhan).
      // Kalau salah satu tidak cocok, transaksi lama ditandai 'expired'
      // (riwayat tetap ada, bukan dihapus) lalu transaksi BARU dibuat fresh
      // di provider+mode yang benar-benar aktif sekarang.
      const isResumable = existingPending.provider === 'klikqris'
        && (existingPending.paymentMode || 'sandbox') === gatewayCfg.mode;
      if (isResumable) {
        return res.json({
          success: true,
          resumed: true,
          transaction: transactionManager.publicTransaction(existingPending)
        });
      }
      await transactionManager.transitionFromPending(existingPending.orderId, {
        status: 'expired',
        extra: { cancelledBy: 'system', staleReason: 'gateway_mode_switched' }
      });
      broadcastAdmin('transaction:update', transactionManager.publicTransaction({ ...existingPending, status: 'expired' }));
    }

    const orderId = transactionManager.generateOrderId();
    const keterangan = klikqrisManager.keteranganUpgradePaket(tier);
    const payment = await klikqrisManager.createTransaction({ orderId, amount: pkg.price, keterangan });

    const tx = await transactionManager.createPendingTransaction({
      discordId, username, tier, amount: pkg.price, method, payment,
      packageSnapshot: {
        price: pkg.price, durationAmount: pkg.durationAmount, durationUnit: pkg.durationUnit, benefits: pkg.benefits
      }
    });

    logActivity({
      type: 'transaction_created',
      username, discordId, role: tier, status: 'info',
      ip: getReqIp(req),
      description: `${username} membuat transaksi ${orderId} untuk upgrade paket ${PURCHASE_TIER_LABEL[tier]} (Rp${pkg.price.toLocaleString('id-ID')}, metode ${payment.payment_method}).`,
      meta: { orderId, tier, amount: pkg.price, method: payment.payment_method }
    }).catch(() => {});

    broadcastAdmin('transaction:update', transactionManager.publicTransaction(tx));

    res.json({ success: true, resumed: false, transaction: transactionManager.publicTransaction(tx) });
  } catch (e) {
    console.error('[Upgrade Paket] Gagal membuat transaksi:', e.message);
    res.status(400).json({ error: e.message || 'Gagal membuat transaksi, coba lagi sebentar.' });
  }
});

// Cek status transaksi — dipanggil App sebagai fallback polling (selain realtime
// WS `transaction:update`), dan JUGA jadi jalur aktivasi kalau webhook KlikQRIS
// telat/gagal terkirim: kalau status lokal masih 'pending', kita cek ulang
// langsung ke KlikQRIS (qris/status) sebelum balas ke App.
app.get('/api/packages/purchase/:orderId', requireUser, async (req, res) => {
  try {
    const tx = await transactionManager.getByOrderId(req.params.orderId);
    if (!tx || tx.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    }

    if (tx.status === 'pending') {
      await refreshTransactionFromKlikqris(tx).catch(e => console.warn('[Upgrade Paket] Gagal cek status ke KlikQRIS:', e.message));
    }

    const fresh = await transactionManager.getByOrderId(req.params.orderId);
    res.json({ transaction: transactionManager.publicTransaction(fresh) });
  } catch (e) {
    console.error('[Upgrade Paket] Gagal ambil status transaksi:', e);
    res.status(500).json({ error: 'Gagal memuat status transaksi.' });
  }
});

// Batalkan transaksi milik sendiri (cuma bisa selagi masih 'pending').
app.post('/api/packages/purchase/:orderId/cancel', requireUser, async (req, res) => {
  try {
    const tx = await transactionManager.getByOrderId(req.params.orderId);
    if (!tx || tx.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    }
    if (tx.status !== 'pending') {
      return res.status(400).json({ error: `Transaksi ini sudah ${tx.status}, tidak bisa dibatalkan.` });
    }
    const cancelled = await cancelPendingTransaction(tx, { by: 'user' });
    if (!cancelled) {
      return res.status(409).json({ error: 'Transaksi baru saja berubah status (mungkin sudah lunas), coba refresh.' });
    }
    res.json({ success: true, transaction: transactionManager.publicTransaction(cancelled) });
  } catch (e) {
    console.error('[Upgrade Paket] Gagal membatalkan transaksi:', e.message);
    res.status(500).json({ error: 'Gagal membatalkan transaksi.' });
  }
});

// Riwayat Transaksi (App) — SATU halaman gabungan untuk SEMUA jenis transaksi
// milik user yang sedang login: upgrade paket (transactionManager), pembelian
// Steam Account (steamAccountOrderManager), DAN klaim Gold Trial (kalau
// pernah, lihat goldTrialManager.js — maksimal 1 item seumur akun karena unique
// index {discordId}). Digabung & diurutkan di sini (bukan di client) supaya
// realtime & konsisten di semua platform yang manggil endpoint ini. Tiap item
// ditandai `kind` ('package'|'steam_account'|'gold_trial') supaya client tahu
// cara menampilkan & endpoint detail mana yang relevan.
function publicGoldTrialClaim(c) {
  const isActive = new Date(c.expiresAt) > new Date();
  return {
    id: String(c._id),
    orderId: `GOLDTRIAL-${c.discordId}`,
    kind: 'gold_trial',
    packageName: 'Gold Trial',
    tier: 'gold',
    durationAmount: c.durationAmount,
    durationUnit: c.durationUnit,
    durationLabel: `${c.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[c.durationUnit]}`,
    gameLimit: c.gameLimit,
    bypassLimit: c.bypassLimit,
    claimedAt: c.claimedAt,
    createdAt: c.claimedAt, // dipakai buat urutkan gabungan bareng transaksi lain
    expiresAt: c.expiresAt,
    status: isActive ? 'active' : 'expired',
    amount: 0,
    totalPayment: 0
  };
}

app.get('/api/transactions', requireUser, async (req, res) => {
  try {
    const [pkgItems, staItems, mktItems, goldTrialClaim] = await Promise.all([
      transactionManager.listByUser(req.user.discordId),
      steamAccountOrderManager.listByUser(req.user.discordId),
      // FIX: order Marketplace (beli Product via KlikQRIS) sebelumnya TIDAK
      // PERNAH diikutkan ke riwayat gabungan ini — akibatnya transaksi
      // Marketplace tidak pernah muncul di halaman Transaksi APP walau order
      // & entitlement-nya sendiri sudah benar tersimpan di database (lihat
      // marketplaceOrderManager.js). Ditambahkan di sini pakai pola SAMA
      // persis dengan Steam Account di atas.
      marketplaceOrderManager.listByUser(req.user.discordId),
      goldTrialManager.getClaimByDiscordId(req.user.discordId)
    ]);
    const merged = [
      ...pkgItems.map(t => ({ ...transactionManager.publicTransaction(t), kind: 'package' })),
      ...staItems.map(o => ({ ...steamAccountOrderManager.publicOrder(o), kind: 'steam_account' })),
      ...mktItems.map(o => ({ ...marketplaceOrderManager.publicOrder(o), kind: 'marketplace' })),
      ...(goldTrialClaim ? [publicGoldTrialClaim(goldTrialClaim)] : [])
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ transactions: merged });
  } catch (e) {
    console.error('[Riwayat Transaksi] Gagal ambil riwayat transaksi gabungan:', e);
    res.status(500).json({ error: 'Gagal memuat riwayat transaksi.' });
  }
});

app.get('/api/transactions/:orderId', requireUser, async (req, res) => {
  try {
    // Gold Trial tidak punya "orderId" pembayaran beneran (gratis, bukan lewat
    // KlikQRIS) — detailnya sudah lengkap di item /api/transactions itu sendiri
    // (lihat publicGoldTrialClaim), jadi endpoint detail cuma perlu tangani
    // orderId sintetis `GOLDTRIAL-<discordId>` ini biar tombol "Lihat Detail"
    // di Riwayat Transaksi tidak error 404 kalau ada yang mengklik nomornya.
    if (req.params.orderId.startsWith('GOLDTRIAL-')) {
      const claim = await goldTrialManager.getClaimByDiscordId(req.user.discordId);
      if (!claim) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
      return res.json({ transaction: publicGoldTrialClaim(claim) });
    }

    let tx = await transactionManager.getByOrderId(req.params.orderId);
    let kind = 'package';
    if (!tx) {
      tx = await steamAccountOrderManager.getByOrderId(req.params.orderId);
      kind = 'steam_account';
    }
    if (!tx) {
      // FIX: order Marketplace (prefix MKT...) sebelumnya tidak pernah dicek
      // di sini — tombol "Lihat Detail" di Riwayat Transaksi APP untuk order
      // Marketplace akan 404 walau order-nya valid milik user ini.
      tx = await marketplaceOrderManager.getByOrderId(req.params.orderId);
      kind = 'marketplace';
    }
    if (!tx || tx.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    }
    const pub = kind === 'package' ? transactionManager.publicTransaction(tx)
      : kind === 'steam_account' ? steamAccountOrderManager.publicOrder(tx)
      : marketplaceOrderManager.publicOrder(tx);
    res.json({ transaction: { ...pub, kind } });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat detail transaksi.' });
  }
});


// ── Aktivasi paket setelah pembayaran dikonfirmasi LUNAS — dipanggil dari webhook
// KlikQRIS DAN dari refreshTransactionFromKlikqris() (fallback polling). Ditulis
// SEKALI di sini biar kedua jalur itu tidak bisa "kelewat" salah satu efeknya.
// `transitionFromPending` di transactionManager memastikan blok ini CUMA
// pernah tereksekusi SEKALI per transaksi walau dipicu berkali-kali/barengan
// (webhook dobel + polling barengan) — aman dari transaksi ganda/duplikat.
async function activateCompletedTransaction(orderId, { paymentMethod, completedAt } = {}) {
  const result = await transactionManager.transitionFromPending(orderId, {
    status: 'completed', paymentMethod, completedAt: completedAt || new Date()
  });
  if (!result.ok) return null; // sudah diproses sebelumnya (atau bukan/gak lagi pending) — no-op
  const tx = result.transaction;

  const { discordId, username, tier } = tx;
  const user = await db.collection('users').findOne({ discordId });
  if (!user) {
    console.warn(`[Upgrade Paket] User ${discordId} tidak ditemukan saat aktivasi transaksi ${orderId}.`);
    return tx;
  }

  const oldRole = user.role;
  const now = new Date();
  const durationMs = tx.packageSnapshot.durationAmount * packageManager.DURATION_UNIT_MS[tx.packageSnapshot.durationUnit];
  // Sama seperti klaim voucher: kalau role SEKARANG sama dgn paket yang dibeli
  // & masih aktif -> masa aktif DIPERPANJANG (extend) dari activeUntil yang ada,
  // bukan direset dari sekarang. Kalau beda role/sudah expired -> dihitung dari sekarang.
  const hasActiveSameRole = oldRole === tier && user.activeUntil && new Date(user.activeUntil) > now;
  const baseTime = hasActiveSameRole ? new Date(user.activeUntil) : now;
  const activeUntil = new Date(baseTime.getTime() + durationMs);

  await db.collection('users').updateOne(
    { discordId },
    { $set: { role: tier, activeUntil, roleUpdatedAt: now, isGoldTrial: false, trialLimits: null } }
  );
  console.log(`[Upgrade Paket] ${discordId} (${username || ''}) role diupdate: '${oldRole}' -> '${tier}', activeUntil=${activeUntil.toISOString()} (invoice ${orderId}).`);

  let discordSync = null;
  if (oldRole !== tier) {
    discordSync = await roleSync.syncAppRoleToDiscord(discordId, tier).catch(() => null);
    await roleSync.logRoleChange({
      discordId, username, oldRole, newRole: tier,
      source: 'purchase', discordSync,
      note: `Pembayaran lunas via KlikQRIS (invoice ${orderId}).`,
      // notifyUser(type:'purchase_success', webhook:true) di bawah SUDAH mengirim
      // webhook kategori "Pembelian Paket" yang lengkap — skip webhook legacy di
      // sini supaya SATU transaksi tidak jadi 2 pesan Discord terpisah.
      skipWebhook: true
    }).catch(() => {});
  }

  await transactionManager.markActivated(orderId, { grantedRole: tier, grantedActiveUntil: activeUntil });

  const durationLabel = `${tx.packageSnapshot.durationAmount} ${packageManager.DURATION_UNIT_LABEL[tx.packageSnapshot.durationUnit]}`;

  // Notif in-app + Discord DM (in-app notification + realtime WS ke App).
  notifyUser(discordId, {
    type: 'purchase_success',
    title: 'Pembayaran Berhasil!',
    message: `Pembayaran untuk paket ${tier.toUpperCase()} berhasil — paket kamu ${hasActiveSameRole ? 'diperpanjang' : 'aktif'} ${durationLabel}, sampai ${fmtDateTimeWIB(activeUntil)}.`,
    dm: true, webhook: true,
    packageCard: {
      event: 'purchase',
      description: `Pembayaran untuk paket ${packageRoleLabel(tier)} berhasil — paket kamu ${hasActiveSameRole ? 'diperpanjang' : 'aktif'}.`,
      username,
      role: tier,
      duration: durationLabel,
      activeUntil,
      price: `Rp${Number(tx.amount).toLocaleString('id-ID')}`,
      orderId,
      status: '🟢 AKTIF',
      extraFields: [field('💳 Metode', String(tx.paymentMethod || '').toUpperCase(), false)]
    }
  }).catch(() => {});

  logActivity({
    type: 'transaction_completed',
    username, discordId, role: tier, status: 'success',
    ip: null,
    before: oldRole, after: tier,
    description: `${username} berhasil upgrade ke paket ${tier.toUpperCase()} via KlikQRIS (invoice ${orderId}, Rp${Number(tx.amount).toLocaleString('id-ID')}), aktif sampai ${fmtDateTimeWIB(activeUntil)}.`,
    meta: { orderId, tier, amount: tx.amount, activeUntil }
  }).catch(() => {});

  // CATATAN: sebelumnya di sini ada pengiriman webhook kedua secara manual ke
  // kategori 'purchase' (embed terpisah, TANPA badge, footer "Upgrade Paket ·
  // KlikQRIS" yang beda dari sistem badge terpusat) — akibatnya "Pembayaran
  // Berhasil" mengirim 2 pesan webhook terpisah ke channel yang sama tiap kali
  // transaksi lunas, dan salah satunya tidak konsisten (tidak ada badge).
  // notifyUser(..., webhook: true) di atas SUDAH mengirim webhook kategori
  // 'purchase' dengan badge 'paket' & footer "Pembayaran Berhasil" yang benar
  // (lewat NOTIF_META + buildEmbed), jadi blok manual di sini dihapus supaya
  // cuma ada SATU webhook per event, konsisten dengan sistem badge/footer baru.

  // Realtime: role/masa aktif user (menu Upgrade Paket & seluruh app), status
  // transaksi (modal pembayaran yang lagi kebuka), dan Admin Web (Manajemen
  // Users + halaman Transaksi) — semuanya update TANPA reload/restart app.
  pushAccountUpdate(discordId).catch(() => {});
  const freshTx = await transactionManager.getByOrderId(orderId);
  wsSendToUser(discordId, 'transaction:update', transactionManager.publicTransaction(freshTx));
  broadcastAdmin('transaction:update', transactionManager.publicTransaction(freshTx));
  db.collection('users').findOne({ discordId })
    .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
    .catch(() => {});

  // Auto Order (Discord Bot) — no-op kalau transaksi ini bukan berasal dari
  // Discord Bot (lihat komentar di discordAutoOrderManager.onOrderActivated).
  discordAutoOrderManager?.onOrderActivated(freshTx).catch(() => {});

  return freshTx;
}

// Konfirmasi ulang status transaksi LANGSUNG ke KlikQRIS (GET /qris/status) —
// dipakai baik dari webhook (validasi WAJIB, dua lapis: signature + status API,
// lihat catatan keamanan di klikqrisManager.js) maupun dari polling
// GET /api/packages/purchase/:orderId. KlikQRIS cuma punya 3 status
// (SUCCESS/PENDING/EXPIRED) — beda dari model status lama yang juga punya failed/cancelled,
// jadi cabang itu sudah tidak relevan lagi untuk provider ini.
async function refreshTransactionFromKlikqris(tx) {
  // PENTING: selalu pakai tx.paymentMode (mode SAAT transaksi ini dibuat),
  // BUKAN mode global yang sedang aktif sekarang di Admin. Kalau Admin ganti
  // Sandbox<->Production sementara transaksi ini masih pending, cek status
  // yang ikut mode "sekarang" akan nembak endpoint yang salah (order_id
  // sandbox tidak pernah ada di endpoint production, dan sebaliknya) —
  // transaksi jadi "nyangkut" pending selamanya walau sudah dibayar.
  const detail = await klikqrisManager.getTransactionDetail({ orderId: tx.orderId, mode: tx.paymentMode });
  if (!detail) return null;
  // Wajib cocok persis — order_id & amount balikan KlikQRIS HARUS sama dengan
  // punya kita sebelum status apapun dipercaya (anti tampering/salah kirim).
  if (detail.order_id !== tx.orderId || Number(detail.amount) !== Number(tx.amount)) {
    console.warn(`[Upgrade Paket] Mismatch status KlikQRIS utk ${tx.orderId} — diabaikan.`);
    return null;
  }
  if (detail.status === 'SUCCESS') {
    return activateCompletedTransaction(tx.orderId, { paymentMethod: detail.payment_method, completedAt: detail.completed_at });
  }
  if (detail.status === 'EXPIRED') {
    const result = await transactionManager.transitionFromPending(tx.orderId, { status: 'expired' });
    if (result.ok) {
      const updatedTx = result.transaction;
      wsSendToUser(tx.discordId, 'transaction:update', transactionManager.publicTransaction(updatedTx));
      broadcastAdmin('transaction:update', transactionManager.publicTransaction(updatedTx));
      // Auto Order (Discord Bot) — no-op kalau bukan order dari Discord Bot.
      discordAutoOrderManager?.onOrderClosed(updatedTx, 'expired').catch(() => {});
    }
    return result.transaction;
  }
  return null; // masih PENDING di sisi KlikQRIS juga — tidak ada perubahan
}

// ── Batalkan transaksi PENDING — dipanggil dari rute user (batal beli sendiri)
// maupun rute Admin (batalkan transaksi user). Sama seperti transisi lain, aman
// dari race condition (cuma transaksi yang MASIH 'pending' yang bisa dibatalkan,
// dan cuma berhasil SEKALI walau dipanggil berkali-kali/barengan dgn webhook).
async function cancelPendingTransaction(tx, { by, cancelledByAdmin } = {}) {
  const result = await transactionManager.transitionFromPending(tx.orderId, {
    status: 'cancelled',
    extra: { cancelledBy: by || 'user' }
  });
  if (!result.ok) return null; // sudah bukan pending lagi (keburu lunas/expired/dibatalkan sebelumnya)
  const cancelled = result.transaction;

  klikqrisManager.cancelTransaction({ orderId: cancelled.orderId }).catch(() => {});

  const publicTx = transactionManager.publicTransaction(cancelled);
  wsSendToUser(cancelled.discordId, 'transaction:update', publicTx);
  broadcastAdmin('transaction:update', publicTx);

  logActivity({
    type: 'transaction_cancelled',
    username: cancelled.username, discordId: cancelled.discordId, role: cancelled.tier, status: 'info',
    ip: null,
    admin: cancelledByAdmin || undefined,
    description: cancelledByAdmin
      ? `Admin (${cancelledByAdmin}) membatalkan transaksi ${cancelled.orderId} milik ${cancelled.username}.`
      : `${cancelled.username} membatalkan transaksi ${cancelled.orderId} miliknya sendiri.`,
    meta: { orderId: cancelled.orderId, tier: cancelled.tier, amount: cancelled.amount }
  }).catch(() => {});

  if (cancelledByAdmin) {
    notifyUser(cancelled.discordId, {
      type: 'transaction_cancelled',
      title: 'Transaksi Dibatalkan',
      message: `Transaksi ${cancelled.orderId} (paket ${cancelled.tier.toUpperCase()}) dibatalkan oleh Admin. Kalau ini keliru, silakan hubungi Admin atau buat transaksi baru.`,
      fields: [
        field('🧾 Invoice', cancelled.orderId, true),
        field('📦 Paket', cancelled.tier.toUpperCase(), true)
      ],
      // webhook:true — disamakan dgn status pembayaran lain (Berhasil/Gagal/
      // Kedaluwarsa) supaya admin selalu punya jejak channel Discord utk SEMUA
      // perubahan status transaksi, bukan cuma yang berhasil.
      dm: true, webhook: true
    }).catch(() => {});
  }

  // Auto Order (Discord Bot) — no-op kalau bukan order dari Discord Bot.
  discordAutoOrderManager?.onOrderClosed(cancelled, 'cancelled').catch(() => {});

  return cancelled;
}


// ══════════════════════════════════════════════════════════════════════════
// INSTANSIASI discordAutoOrderManager — dilakukan DI SINI (bukan di atas dekat
// require-nya) supaya bisa langsung mengoper referensi fungsi
// activateCompletedTransaction/refreshTransactionFromKlikqris/cancelPendingTransaction
// yang baru saja dideklarasikan di atas. Fitur Auto Order 100% memakai ULANG
// pipeline transaksi Upgrade Paket yang sudah ada (transactionManager +
// klikqrisManager + fungsi-fungsi ini) — TIDAK ADA alur pembayaran baru yang
// terpisah, jadi semua efek yang sudah teruji (role, masa aktif, limit
// download, notif) otomatis konsisten baik order dari App maupun dari
// Discord Bot. Lihat discordAutoOrderManager.js untuk detailnya.
// ══════════════════════════════════════════════════════════════════════════
discordAutoOrderManager = createDiscordAutoOrderManager({
  getDb: () => db,
  packageManager, klikqrisManager, transactionManager, roleSync,
  notifyUser, logActivity, broadcastAdmin, wsSendToUser, field, fmtDateTimeWIB, getReqIp,
  refreshTransactionFromKlikqris: (tx) => refreshTransactionFromKlikqris(tx),
  cancelPendingTransaction: (tx, opts) => cancelPendingTransaction(tx, opts),
  APP_NAME, SERVER_URL
});

// ── Webhook KlikQRIS — didaftarkan sebagai Webhook URL di dashboard KlikQRIS
// (https://klikqris.com/settings), format: {SERVER_URL}/api/webhook/klikqris.
// (Endpoint lama /api/webhook/pakasir SUDAH DIHAPUS — lihat rute ini.)
// TIDAK pakai requireUser (KlikQRIS yang connect, bukan user login) — makanya
// validasi berlapis-lapis SEBELUM paket/produk diaktifkan:
//   1) signature body webhook HARUS cocok dengan signature yang kita terima
//      saat create transaction (anti fake-webhook — lihat klikqrisManager.js).
//   2) amount HARUS cocok dengan nominal transaksi kita.
//   3) status TETAP dikonfirmasi ulang ke Check Status API (bukan asal
//      percaya body webhook) sebelum benar-benar aktivasi.
// Kalau signature TIDAK valid: request ditolak, TIDAK ada produk/role yang
// diberikan, dan security event dicatat — sesuai requirement keamanan wajib.
app.post('/api/webhook/klikqris', async (req, res) => {
  try {
    const { order_id, amount, signature } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id wajib ada.' });

    const tx = await transactionManager.getByOrderId(order_id);
    if (tx) {
      if (!klikqrisManager.verifyWebhookSignature(tx.signature, signature)) {
        console.warn(`[KlikQRIS Webhook] Signature tidak valid utk ${order_id} — request ditolak.`);
        logActivity({
          type: 'system_error', username: tx.username, discordId: tx.discordId, status: 'error', ip: getReqIp(req),
          description: `[SECURITY] Webhook KlikQRIS ditolak — signature tidak cocok untuk transaksi ${order_id}.`,
          meta: { orderId: order_id }
        }).catch(() => {});
        return res.status(400).json({ ok: false, error: 'invalid_signature' });
      }
      if (Number(amount) !== Number(tx.amount)) {
        console.warn(`[KlikQRIS Webhook] Nominal tidak cocok utk ${order_id}: dapat ${amount}, seharusnya ${tx.amount}.`);
        return res.status(200).json({ ok: true, ignored: true });
      }
      if (tx.status !== 'pending') {
        return res.status(200).json({ ok: true, alreadyProcessed: true }); // idempotent
      }
      // Body webhook cuma jadi TRIGGER — status yang benar-benar dipercaya & dipakai
      // tetap hasil konfirmasi ulang ke KlikQRIS (sesuai anjuran resmi di dokumentasi).
      await refreshTransactionFromKlikqris(tx);
      return res.status(200).json({ ok: true });
    }

    // Bukan order_id Upgrade Paket — coba cek Steam Account (order_id prefix
    // STM...). Sama tiga lapis validasi (signature, amount, konfirmasi ulang
    // status ke KlikQRIS) sebelum akun benar-benar dialokasikan.
    const steamOrder = await steamAccountOrderManager.getByOrderId(order_id);
    if (steamOrder) {
      if (!klikqrisManager.verifyWebhookSignature(steamOrder.signature, signature)) {
        console.warn(`[KlikQRIS Webhook] Signature tidak valid utk order Steam Account ${order_id} — request ditolak.`);
        logActivity({
          type: 'system_error', username: steamOrder.username, discordId: steamOrder.discordId, status: 'error', ip: getReqIp(req),
          description: `[SECURITY] Webhook KlikQRIS ditolak — signature tidak cocok untuk order Steam Account ${order_id}.`,
          meta: { orderId: order_id }
        }).catch(() => {});
        return res.status(400).json({ ok: false, error: 'invalid_signature' });
      }
      if (Number(amount) !== Number(steamOrder.amount)) {
        console.warn(`[KlikQRIS Webhook] Nominal tidak cocok utk order Steam Account ${order_id}: dapat ${amount}, seharusnya ${steamOrder.amount}.`);
        return res.status(200).json({ ok: true, ignored: true });
      }
      if (steamOrder.status !== 'pending') {
        return res.status(200).json({ ok: true, alreadyProcessed: true }); // idempotent
      }
      await refreshSteamAccountOrderFromKlikqris(steamOrder);
      return res.status(200).json({ ok: true });
    }

    // Bukan order_id Upgrade Paket maupun Steam Account — coba cek Marketplace
    // (order_id prefix MKT...). Sama tiga lapis validasi (signature, amount,
    // konfirmasi ulang status ke KlikQRIS) sebelum entitlement benar-benar
    // diaktifkan — lihat activateCompletedMarketplaceOrder di bawah.
    const marketplaceOrder = await marketplaceOrderManager.getByOrderId(order_id);
    if (!marketplaceOrder) {
      // Bukan order kita sama sekali — balas 200 biar KlikQRIS tidak retry
      // terus, tapi TIDAK melakukan apapun.
      return res.status(200).json({ ok: true, ignored: true });
    }
    if (!klikqrisManager.verifyWebhookSignature(marketplaceOrder.signature, signature)) {
      console.warn(`[KlikQRIS Webhook] Signature tidak valid utk order Marketplace ${order_id} — request ditolak.`);
      logActivity({
        type: 'system_error', username: marketplaceOrder.username, discordId: marketplaceOrder.discordId, status: 'error', ip: getReqIp(req),
        description: `[SECURITY] Webhook KlikQRIS ditolak — signature tidak cocok untuk order Marketplace ${order_id}.`,
        meta: { orderId: order_id }
      }).catch(() => {});
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }
    if (Number(amount) !== Number(marketplaceOrder.amount)) {
      console.warn(`[KlikQRIS Webhook] Nominal tidak cocok utk order Marketplace ${order_id}: dapat ${amount}, seharusnya ${marketplaceOrder.amount}.`);
      return res.status(200).json({ ok: true, ignored: true });
    }
    if (marketplaceOrder.status !== 'pending') {
      return res.status(200).json({ ok: true, alreadyProcessed: true }); // idempotent
    }
    await refreshMarketplaceOrderFromKlikqris(marketplaceOrder);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[KlikQRIS Webhook] Error:', e.message);
    // Tetap balas 200 supaya KlikQRIS tidak spam-retry kalau errornya di sisi kita
    // (transaksi tetap bisa "disembuhkan" lewat polling GET /purchase/:orderId).
    res.status(200).json({ ok: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// STEAM ACCOUNT MARKETPLACE (App + Admin Web) — KlikQRIS + WS realtime,
// TAPI collection & model
// kepemilikannya beda total: Steam Account adalah UNLIMITED USER / SHARED
// PRODUCT — akun TIDAK PERNAH berubah status jadi SOLD dan TIDAK PERNAH
// hilang dari listing setelah dibeli. Yang berubah cuma kepemilikan PER-USER
// (steamAccountOwnerships), dan pembelian TIDAK membuka ticket Discord —
// selesai 100% lewat App (lihat activateCompletedSteamAccountOrder di bawah).
// ══════════════════════════════════════════════════════════════════════════

// Broadcast global (tanpa konteks user) dipakai kalau tidak tahu siapa saja
// yang lagi buka halaman — payloadnya SENGAJA cuma sinyal "ada perubahan",
// BUKAN daftar produk dengan isOwner/hasPendingOrder terisi. Field itu
// personal per-user (siapa owner akun X berbeda-beda per client), jadi kalau
// dikirim blanket lewat broadcast, App user lain yang KEBETULAN owner akun
// yang sama bisa salah ke-reset jadi "BELI AKUN" lagi. App yang terima sinyal
// ini WAJIB fetch ulang lewat GET /api/steam-accounts (personalized) —
// lihat applyStaProductsUpdate() di app.js.
async function broadcastSteamAccountsUpdate() {
  wsBroadcastAll('steamAccounts:products:update', { changed: true, at: Date.now() });
}

// ── App: daftar akun — AVAILABLE (siapa saja) + akun yang di-disable admin
// tapi user ini tetap owner-nya (product TIDAK PERNAH hilang dari user yang
// sudah memilikinya). ──
app.get('/api/steam-accounts', requireUser, async (req, res) => {
  try {
    const { list, ownedIds } = await steamAccountManager.listPublicForUser(req.user.discordId);
    const pendingIds = await steamAccountOrderManager.listActivePendingProductIdsForUser(req.user.discordId);
    const gatewayCfg = await klikqrisManager.getSettings();
    res.json({
      products: list.map(p => steamAccountManager.publicProductForUser(p, ownedIds, pendingIds)),
      paymentMethods: gatewayCfg.enabled ? klikqrisManager.PAYMENT_METHODS : [],
      gatewayEnabled: gatewayCfg.enabled
    });
  } catch (e) {
    console.error('[SteamAccounts] Gagal ambil daftar akun:', e);
    res.status(500).json({ error: 'Gagal memuat daftar akun Steam.' });
  }
});

// ── Riwayat pembelian akun Steam milik user — HARUS didaftar SEBELUM
// /:id di bawah (alasan sama seperti search-game di Admin: "orders" satu
// segmen bakal ketangkep :id kalau didaftar belakangan). ──
app.get('/api/steam-accounts/orders', requireUser, async (req, res) => {
  try {
    const items = await steamAccountOrderManager.listByUser(req.user.discordId);
    res.json({ orders: items.map(steamAccountOrderManager.publicOrder) });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat riwayat pembelian.' });
  }
});

app.get('/api/steam-accounts/orders/:orderId', requireUser, async (req, res) => {
  try {
    const order = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    if (!order || order.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    res.json({ order: steamAccountOrderManager.publicOrder(order) });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat detail pesanan.' });
  }
});

// ── App: detail satu akun (halaman detail produk) — akun yang sudah
// di-DISABLE admin tetap bisa dibuka OLEH PEMILIKNYA (biar tetap lihat
// Games/Cara Bermain & tombol LOGIN AKUN), tapi 404 buat orang lain yang
// belum punya akses. ──
app.get('/api/steam-accounts/:id', requireUser, async (req, res) => {
  try {
    const product = await steamAccountManager.getById(req.params.id);
    const isOwner = product ? await steamAccountManager.hasOwnership(req.params.id, req.user.discordId) : false;
    if (!product || (product.status !== 'available' && !isOwner)) {
      return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    }
    const pendingOrder = await steamAccountOrderManager.getActivePendingForUser(req.user.discordId, req.params.id);
    const gatewayCfg = await klikqrisManager.getSettings();
    res.json({
      product: steamAccountManager.publicProductForUser(product, isOwner, !!pendingOrder),
      paymentMethods: gatewayCfg.enabled ? klikqrisManager.PAYMENT_METHODS : []
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat detail akun.' });
  }
});

// ── Detail lengkap 1 game (requirements dll) — dipakai App buat render
// carousel Detail Product (fetch semua game sekaligus paralel pas halaman
// dibuka, biar geser carousel instan tanpa loading). Reuse penuh
// fetchSteamDetailsForAppId, sama seperti searchGameByAppId Admin. ──
app.get('/api/steam-accounts/:id/games/:appId', requireUser, async (req, res) => {
  try {
    const product = await steamAccountManager.getById(req.params.id);
    const isOwner = product ? await steamAccountManager.hasOwnership(req.params.id, req.user.discordId) : false;
    if (!product || (product.status !== 'available' && !isOwner)) {
      return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    }
    if (!(product.games || []).some(g => g.appId === String(req.params.appId))) {
      return res.status(404).json({ error: 'Game tidak ditemukan di akun ini.' });
    }
    const details = await steamAccountManager.searchGameByAppId(req.params.appId);
    res.json({ game: details });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Lock in-memory sederhana: 1 user cuma boleh punya 1 proses "ambil
// kredensial utk LOGIN AKUN" berjalan di satu waktu, walau dia klik tombol
// LOGIN AKUN berkali-kali dengan cepat (double click, dst) — App/Electron
// sendiri JUGA mengunci proses steam.exe-nya (lihat main.js), ini lapisan
// tambahan di sisi server supaya kredensial tidak dikirim berkali-kali utk
// request yang tumpang tindih. ──
const _steamLoginInFlight = new Set();

// ── Tombol "LOGIN AKUN" — kredensial CUMA dikirim ke pemilik sah, dipicu
// manual tiap kali user klik (bukan otomatis setelah bayar). App (Electron)
// yang menerima ini bertugas jalankan Steam pakai kredensialnya. ──
app.get('/api/steam-accounts/:id/credentials', requireUser, async (req, res) => {
  const lockKey = `${req.user.discordId}:${req.params.id}`;
  if (_steamLoginInFlight.has(lockKey)) {
    return res.status(409).json({ error: 'Proses login akun ini masih berjalan, tunggu sebentar.' });
  }
  _steamLoginInFlight.add(lockKey);
  try {
    const creds = await steamAccountManager.getCredentialsForOwner(req.params.id, req.user.discordId);
    if (!creds.username || !creds.password) {
      return res.status(500).json({ error: 'Kredensial akun gagal dibaca, hubungi Admin.' });
    }
    logActivity({
      type: 'steam_account_login_requested',
      username: req.user.username || req.user.discordId, discordId: req.user.discordId, status: 'info',
      ip: getReqIp(req),
      description: `${req.user.username || req.user.discordId} meminta kredensial akun Steam #${req.params.id} (tombol LOGIN AKUN).`,
      meta: { productId: req.params.id, event: 'STEAM_LOGIN' }
    }).catch(() => {});
    res.json(creds);
  } catch (e) {
    res.status(403).json({ error: e.message || 'Tidak bisa mengambil kredensial akun ini.' });
  } finally {
    // Kredensial cuma "sekali kirim", jadi lock dilepas segera setelah respons
    // terkirim — bukan menunggu Steam selesai restart/login (itu domain
    // Electron main process, dikunci terpisah di sana).
    setTimeout(() => _steamLoginInFlight.delete(lockKey), 3000);
  }
});

// ── Cek order pending milik user ini utk 1 produk — dipakai tombol
// "PEMBAYARAN DIPROSES" biar langsung buka layar pembayaran yang sudah ada,
// tanpa membuat invoice baru ataupun menampilkan modal pilih metode lagi. ──
app.get('/api/steam-accounts/purchase/pending', requireUser, async (req, res) => {
  try {
    const productId = String(req.query.productId || '');
    if (!productId) return res.status(400).json({ error: 'productId wajib diisi.' });
    const order = await steamAccountOrderManager.getActivePendingForUser(req.user.discordId, productId);
    res.json({ order: order ? steamAccountOrderManager.publicOrder(order) : null });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat status pembayaran.' });
  }
});

app.post('/api/steam-accounts/purchase', requireUser, async (req, res) => {
  const discordId = req.user.discordId;
  const username = req.user.username || discordId;
  const productId = String(req.body?.productId || '');
  const method = String(req.body?.method || '');

  try {
    if (!productId) return res.status(400).json({ error: 'Akun tidak valid.' });
    if (!klikqrisManager.isValidMethod(method)) {
      return res.status(400).json({ error: 'Metode pembayaran tidak valid.' });
    }

    const product = await steamAccountManager.getById(productId);
    if (!product || product.status !== 'available') {
      return res.status(400).json({ error: 'Akun ini sudah tidak tersedia.' });
    }
    if (!product.games || !product.games.length) {
      return res.status(400).json({ error: 'Akun ini belum punya game, hubungi Admin.' });
    }

    // Steam Account bersifat UNLIMITED USER — TAPI satu user tetap tidak
    // perlu (dan tidak boleh) membeli akun yang SAMA dua kali. Kalau sudah
    // owner, arahkan ke LOGIN AKUN, bukan bikin order baru.
    const alreadyOwned = await steamAccountManager.hasOwnership(productId, discordId);
    if (alreadyOwned) {
      return res.status(400).json({ error: 'Kamu sudah memiliki akun ini — gunakan tombol LOGIN AKUN.', alreadyOwned: true });
    }

    const gatewayCfg = await klikqrisManager.getSettings();

    const existingPending = await steamAccountOrderManager.getActivePendingForUser(discordId, productId);
    if (existingPending) {
      const isResumable = existingPending.provider === 'klikqris'
        && (existingPending.paymentMode || 'sandbox') === gatewayCfg.mode;
      if (isResumable) {
        return res.json({ success: true, resumed: true, order: steamAccountOrderManager.publicOrder(existingPending) });
      }
      await steamAccountOrderManager.transitionFromPending(existingPending.orderId, {
        status: 'expired', extra: { cancelledBy: 'system', staleReason: 'gateway_mode_switched' }
      });
      broadcastAdmin('steamAccounts:order:update', steamAccountOrderManager.publicOrder({ ...existingPending, status: 'expired' }));
    }

    // CATATAN: akun ini bisa dibeli BANYAK user sekaligus (UNLIMITED USER /
    // SHARED PRODUCT) — jadi TIDAK ADA pengecekan "user lain sedang bayar
    // akun ini" di sini lagi. Satu-satunya batasan adalah 1 user tidak boleh
    // dobel-owned (sudah dicek `alreadyOwned` di atas), dan grantOwnership()
    // di aktivasi tetap atomic/idempotent lewat unique index sebagai
    // pengaman akhir kalau ada race condition antar-request user yang sama.
    const orderId = steamAccountOrderManager.generateOrderId();
    const keterangan = klikqrisManager.keteranganProdukDigital(product.name);
    const payment = await klikqrisManager.createTransaction({ orderId, amount: product.price, keterangan });

    const order = await steamAccountOrderManager.createPendingOrder({
      discordId, username, productId, productName: product.name, amount: product.price, method, payment,
      productSnapshot: {
        name: product.name, description: product.description,
        price: product.price, imageData: product.imageData, imageUrl: product.imageUrl,
        gamesCount: product.games.length
      }
    });

    logActivity({
      type: 'steam_account_order_created',
      username, discordId, status: 'info',
      ip: getReqIp(req),
      description: `[PAYMENT_CREATED] ${username} membuat pesanan ${orderId} untuk akun Steam "${product.name}" (Rp${product.price.toLocaleString('id-ID')}, metode ${payment.payment_method}).`,
      meta: { orderId, productId, productName: product.name, amount: product.price, method: payment.payment_method, event: 'PAYMENT_CREATED' }
    }).catch(() => {});

    broadcastAdmin('steamAccounts:order:update', steamAccountOrderManager.publicOrder(order));

    res.json({ success: true, resumed: false, order: steamAccountOrderManager.publicOrder(order) });
  } catch (e) {
    console.error('[SteamAccounts] Gagal membuat order:', e.message);
    res.status(400).json({ error: e.message || 'Gagal membuat pesanan, coba lagi sebentar.' });
  }
});

app.get('/api/steam-accounts/purchase/:orderId', requireUser, async (req, res) => {
  try {
    const order = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    if (!order || order.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    if (order.status === 'pending') {
      await refreshSteamAccountOrderFromKlikqris(order).catch(e => console.warn('[SteamAccounts] Gagal cek status ke KlikQRIS:', e.message));
    }
    const fresh = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    res.json({ order: steamAccountOrderManager.publicOrder(fresh) });
  } catch (e) {
    console.error('[SteamAccounts] Gagal ambil status order:', e);
    res.status(500).json({ error: 'Gagal memuat status pesanan.' });
  }
});

app.post('/api/steam-accounts/purchase/:orderId/cancel', requireUser, async (req, res) => {
  try {
    const order = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    if (!order || order.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Pesanan ini sudah ${order.status}, tidak bisa dibatalkan.` });
    }
    const cancelled = await cancelPendingSteamAccountOrder(order, { by: 'user' });
    if (!cancelled) {
      return res.status(409).json({ error: 'Pesanan baru saja berubah status (mungkin sudah lunas), coba refresh.' });
    }
    res.json({ success: true, order: steamAccountOrderManager.publicOrder(cancelled) });
  } catch (e) {
    console.error('[SteamAccounts] Gagal membatalkan order:', e.message);
    res.status(500).json({ error: 'Gagal membatalkan pesanan.' });
  }
});

// ── Aktivasi order setelah pembayaran KlikQRIS dikonfirmasi LUNAS.
// TIDAK membuka ticket Discord — pembelian Steam Account selesai 100% lewat
// App. `transitionFromPending` (findOneAndUpdate status:'pending' -> 'completed')
// memastikan blok ini cuma pernah jalan SEKALI per order walau dipicu
// berkali-kali (webhook dobel, polling barengan, dst) — dan grantOwnership()
// di bawahnya JUGA idempotent lewat unique index (steamAccountId+discordId),
// jadi 2 lapis pengaman: order tidak dobel diproses, DAN ownership tidak
// pernah dobel dibuat / akses tidak pernah diberikan 2x. ──
// ══════════════════════════════════════════════════════════════════════════
// DM KREDENSIAL STEAM ACCOUNT — TERPISAH dari notifyUser() generik (notif
// "Pembayaran Berhasil" biasa) karena formatnya khusus: username/password
// akun Steam dibungkus code-block, instruksi tombol LOGIN AKUN, warning
// keamanan, dan footer brand berbeda ("ThreeOne Store • Steam Account").
// Flow: Pembayaran lunas -> ownership di-grant -> DM kredensial dikirim
// (HASILNYA di-AWAIT, bukan fire-and-forget) -> Socket.IO push status
// pengiriman ke App ('steamAccounts:credentialsDm') — sukses ATAU alasan
// gagalnya secara spesifik, App TIDAK PERNAH menebak/generik.
// ══════════════════════════════════════════════════════════════════════════
function humanizeDmFailure(result) {
  if (!result) return 'Terjadi kesalahan tidak diketahui saat mengirim DM.';
  if (result.reason === 'no_bot_token') return 'Bot Discord belum dikonfigurasi di server (hubungi Admin).';
  if (result.reason === 'no_user_id') return 'Discord ID kamu tidak valid.';
  if (result.reason === 'duplicate_suppressed') return 'DM sudah pernah terkirim sebelumnya untuk pesanan ini.';
  if (result.errCode === 50007) return 'DM kamu tertutup untuk bot/member server ini. Buka Discord -> Setelan Privasi -> izinkan pesan langsung dari anggota server, lalu minta Admin kirim ulang.';
  if (result.errCode === 10013 || result.status === 404) return 'Akun Discord kamu tidak ditemukan oleh bot (mungkin sudah keluar dari server).';
  if (result.status === 403) return 'Bot tidak diizinkan mengirim DM ke akun kamu.';
  return `Gagal mengirim DM${result.status ? ` (HTTP ${result.status})` : ''}${result.errMsg ? `: ${result.errMsg}` : '.'}`;
}

async function sendSteamAccountCredentialsDM(order) {
  const { discordId, orderId, productId, productName, username: buyerUsername } = order;

  let creds;
  try {
    creds = await steamAccountManager.getCredentialsForOwner(productId, discordId);
  } catch (e) {
    console.error(`[SteamAccounts][DM] Gagal ambil kredensial utk DM order ${orderId}:`, e.message);
    wsSendToUser(discordId, 'steamAccounts:credentialsDm', {
      orderId, productId, success: false,
      message: 'Kredensial akun tidak ditemukan. Buka App -> Steam Accounts -> akun ini -> LOGIN AKUN untuk mencoba lagi, atau hubungi Admin.'
    });
    return;
  }
  if (!creds?.username || !creds?.password) {
    wsSendToUser(discordId, 'steamAccounts:credentialsDm', {
      orderId, productId, success: false,
      message: 'Kredensial akun belum lengkap di sistem. Hubungi Admin untuk bantuan.'
    });
    return;
  }

  const embed = {
    title: '🎮 STEAM ACCOUNT PURCHASE',
    description: [
      'Pembelian Steam Account kamu berhasil!',
      '',
      '👤 **Username**',
      `\`${creds.username}\``,
      '',
      '🔑 **Password**',
      `\`${creds.password}\``,
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      '🟢 **Status:** Pembayaran Berhasil',
      '📦 **Product:** Steam Account Sharing',
      '',
      'Silakan gunakan tombol **LOGIN AKUN** di aplikasi untuk melakukan auto login ke Steam.',
      '',
      '⚠️ Jangan membagikan username dan password akun ini kepada orang lain.',
      '',
      '⚠️ Jika mengalami kendala tidak bisa login, silakan restart perangkat PC/Laptop Anda.'
    ].join('\n'),
    color: 0x2ecc71,
    footer: { text: 'ThreeOne Store • Steam Account' },
    timestamp: new Date().toISOString()
  };

  // eventId per-order (bukan per-panggilan) — kalau webhook KlikQRIS retry
  // dan activateCompletedSteamAccountOrder somehow terpanggil lagi (dijaga
  // idempotent oleh transitionFromPending, tapi ini lapis kedua), DM
  // kredensial yang SAMA tidak akan dobel terkirim.
  const result = await sendDiscordDM(discordId, { embeds: [embed] }, {
    eventId: `steam_account_credentials:${orderId}`,
    eventLabel: 'steam_account_credentials_dm'
  });

  if (result.success) {
    console.log(`[SteamAccounts][DM] Kredensial berhasil dikirim ke ${discordId} (order ${orderId}).`);
    wsSendToUser(discordId, 'steamAccounts:credentialsDm', { orderId, productId, success: true });
  } else {
    const message = humanizeDmFailure(result);
    console.warn(`[SteamAccounts][DM] Gagal kirim kredensial ke ${discordId} (order ${orderId}): ${message}`);
    wsSendToUser(discordId, 'steamAccounts:credentialsDm', { orderId, productId, success: false, message });
    // Best-effort — catat ke Activity Log biar Admin tahu ada user yang perlu
    // dibantu kirim ulang kredensial manual.
    logActivity({
      type: 'steam_account_dm_failed',
      username: buyerUsername, discordId, status: 'error', ip: null,
      description: `[STEAM_ACCOUNT_DM_FAILED] Gagal kirim kredensial DM ke ${buyerUsername} untuk order ${orderId} ("${productName}"): ${message}`,
      meta: { orderId, productId, reason: result.reason || result.errCode || result.status }
    }).catch(() => {});
  }
}

async function activateCompletedSteamAccountOrder(orderId, { paymentMethod, completedAt } = {}) {
  const result = await steamAccountOrderManager.transitionFromPending(orderId, {
    status: 'completed', paymentMethod, completedAt: completedAt || new Date()
  });
  if (!result.ok) return null; // sudah diproses sebelumnya — no-op
  const order = result.order;
  const { discordId, username, productName } = order;

  const amountLabel = `Rp${Number(order.amount).toLocaleString('id-ID')}`;

  logActivity({
    type: 'steam_account_payment_success',
    username, discordId, status: 'success', ip: null,
    description: `[PAYMENT_SUCCESS] Pembayaran ${orderId} untuk akun Steam "${productName}" berhasil (${amountLabel}).`,
    meta: { orderId, productId: order.productId, productName, amount: order.amount, event: 'PAYMENT_SUCCESS' }
  }).catch(() => {});

  // Alokasi akun — TIDAK PERNAH gagal karena "sudah terjual" (akun unlimited
  // user), cuma bisa null kalau produknya sendiri sudah dihapus dari DB.
  const allocated = await steamAccountManager.grantOwnership(order.productId, { discordId, username, orderId }).catch(() => null);
  if (!allocated) {
    console.error(`[SteamAccounts] KRITIS: order ${orderId} lunas tapi produk ${order.productId} tidak ditemukan — butuh penanganan manual Admin.`);
    notifyUser(discordId, {
      type: 'steam_account_allocation_failed',
      title: 'Akun Tidak Ditemukan',
      message: `Pembayaran untuk "${productName}" berhasil, tapi produk aslinya tidak ditemukan di sistem. Admin akan segera menghubungimu.`,
      fields: [field('🧾 Invoice', orderId, true), field('📦 Produk', productName, true), field('💰 Nominal', amountLabel, true)],
      dm: true, webhook: true
    }).catch(() => {});
    broadcastAdmin('steamAccounts:allocation:failed', { orderId, productId: order.productId, discordId, username });
    return order;
  }

  logActivity({
    type: 'steam_account_access_granted',
    username, discordId, status: 'success', ip: null,
    description: `[STEAM_ACCOUNT_ACCESS_GRANTED] ${username} mendapatkan akses akun Steam "${productName}" (invoice ${orderId}).`,
    meta: { orderId, productId: order.productId, productName, event: 'STEAM_ACCOUNT_ACCESS_GRANTED' }
  }).catch(() => {});

  const gamesLabel = (allocated.product.games || []).map(g => g.name).join(', ') || '-';
  notifyUser(discordId, {
    type: 'steam_account_purchase_success',
    title: 'Pembayaran Berhasil!',
    message: `Pembayaran untuk akun "${productName}" berhasil. Buka App -> Steam Accounts -> akun ini -> LOGIN AKUN kapan saja kamu mau main.`,
    fields: [
      field('👤 Pembeli', username, true),
      field('🧾 Invoice', orderId, true),
      field('📦 Akun', productName, true),
      field('🎮 Games', gamesLabel, false),
      field('💰 Nominal', amountLabel, true),
      field('💳 Metode', String(order.paymentMethod || '').toUpperCase(), true)
    ],
    meta: { orderId, productId: order.productId },
    // DM MATIKAN di sini (dm:false) — kredensial dikirim lewat DM TERPISAH,
    // format khusus (lihat sendSteamAccountCredentialsDM di bawah), supaya
    // user tidak dapat 2 DM buat 1 pembelian. Notifikasi in-app (lonceng)
    // & webhook admin tetap jalan seperti biasa.
    dm: false, webhook: true
  }).catch(() => {});

  // Kirim DM KREDENSIAL (username/password akun Steam) — HASILNYA di-AWAIT
  // (bukan fire-and-forget) supaya App bisa langsung dikasih tahu real-time
  // lewat Socket.IO apakah DM-nya benar-benar terkirim atau tidak (dan kalau
  // gagal, alasan spesifiknya — bukan pesan generik).
  sendSteamAccountCredentialsDM(order).catch(e => {
    console.error(`[SteamAccounts][DM] Error tak terduga saat kirim kredensial order ${orderId}:`, e.message);
    wsSendToUser(discordId, 'steamAccounts:credentialsDm', {
      orderId, productId: order.productId, success: false,
      message: 'Terjadi kesalahan sistem saat mengirim DM. Buka App -> Steam Accounts -> akun ini -> LOGIN AKUN untuk tetap masuk, atau hubungi Admin.'
    });
  });

  logActivity({
    type: 'steam_account_order_completed',
    username, discordId, status: 'success',
    ip: null,
    description: `${username} berhasil membeli akun Steam "${productName}" via KlikQRIS (invoice ${orderId}, ${amountLabel}).`,
    meta: { orderId, productId: order.productId, amount: order.amount }
  }).catch(() => {});

  const freshOrder = await steamAccountOrderManager.getByOrderId(orderId);
  wsSendToUser(discordId, 'steamAccounts:order:update', steamAccountOrderManager.publicOrder(freshOrder));
  broadcastAdmin('steamAccounts:order:update', steamAccountOrderManager.publicOrder(freshOrder));

  // Ownership user ini berubah -> tombol BELI AKUN jadi LOGIN AKUN secara
  // realtime buat DIA. Akun tetap AVAILABLE buat user lain (tidak hilang
  // dari listing siapa pun), jadi broadcast global cukup buat refresh
  // nav badge/listing publik; App user ini sendiri sudah dapat state
  // terbaru lewat wsSendToUser di atas.
  broadcastSteamAccountsUpdate().catch(() => {});

  return freshOrder;
}

async function refreshSteamAccountOrderFromKlikqris(order) {
  const detail = await klikqrisManager.getTransactionDetail({ orderId: order.orderId, mode: order.paymentMode });
  if (!detail) return null;
  if (detail.order_id !== order.orderId || Number(detail.amount) !== Number(order.amount)) {
    console.warn(`[SteamAccounts] Mismatch status KlikQRIS utk ${order.orderId} — diabaikan.`);
    return null;
  }
  if (detail.status === 'SUCCESS') {
    return activateCompletedSteamAccountOrder(order.orderId, { paymentMethod: detail.payment_method, completedAt: detail.completed_at });
  }
  if (detail.status === 'EXPIRED') {
    const result = await steamAccountOrderManager.transitionFromPending(order.orderId, { status: 'expired' });
    if (result.ok) {
      const updatedOrder = result.order;
      wsSendToUser(order.discordId, 'steamAccounts:order:update', steamAccountOrderManager.publicOrder(updatedOrder));
      broadcastAdmin('steamAccounts:order:update', steamAccountOrderManager.publicOrder(updatedOrder));
    }
    return result.order;
  }
  return null;
}

async function cancelPendingSteamAccountOrder(order, { by, cancelledByAdmin } = {}) {
  const result = await steamAccountOrderManager.transitionFromPending(order.orderId, {
    status: 'cancelled', extra: { cancelledBy: by || 'user' }
  });
  if (!result.ok) return null;
  const cancelled = result.order;

  klikqrisManager.cancelTransaction({ orderId: cancelled.orderId }).catch(() => {});

  const publicOrder = steamAccountOrderManager.publicOrder(cancelled);
  wsSendToUser(cancelled.discordId, 'steamAccounts:order:update', publicOrder);
  broadcastAdmin('steamAccounts:order:update', publicOrder);

  logActivity({
    type: 'steam_account_order_cancelled',
    username: cancelled.username, discordId: cancelled.discordId, status: 'info',
    ip: null,
    admin: cancelledByAdmin || undefined,
    description: cancelledByAdmin
      ? `Admin (${cancelledByAdmin}) membatalkan pesanan ${cancelled.orderId} milik ${cancelled.username}.`
      : `${cancelled.username} membatalkan pesanan ${cancelled.orderId} miliknya sendiri.`,
    meta: { orderId: cancelled.orderId, productId: cancelled.productId, amount: cancelled.amount }
  }).catch(() => {});

  if (cancelledByAdmin) {
    notifyUser(cancelled.discordId, {
      type: 'steam_account_order_cancelled',
      title: 'Pesanan Dibatalkan',
      message: `Pesanan ${cancelled.orderId} (akun "${cancelled.productName}") dibatalkan oleh Admin. Kalau ini keliru, silakan hubungi Admin atau buat pesanan baru.`,
      fields: [field('🧾 Invoice', cancelled.orderId, true), field('📦 Akun', cancelled.productName, true)],
      dm: true, webhook: true
    }).catch(() => {});
  }

  return cancelled;
}

// ══════════════════════════════════════════════════════════════════════════
// MARKETPLACE (App + Admin Web) — Product bundel Game/Bypass, dibeli via
// KlikQRIS ATAU di-whitelist manual oleh admin. Pola SENGAJA dibuat semirip
// mungkin dengan blok STEAM ACCOUNT di atas (create order -> KlikQRIS ->
// webhook -> activateCompleted...), TAPI beda total soal apa yang didapat
// user setelah lunas: Steam Account kasih KREDENSIAL akun, Marketplace kasih
// ENTITLEMENT (hak akses) ke Game/Bypass yang sudah ada di katalog —
// TIDAK ADA download/install baru yang dibuat di sini (lihat #12 & #20:
// download/install tetap lewat endpoint Game/Bypass existing, yang sudah
// mengecek hasCatalogAccess()/hasCatalogAccessSync() di atas).
// ══════════════════════════════════════════════════════════════════════════

// Broadcast GLOBAL (signal-only, TANPA data personal) tiap kali daftar/isi
// Product Marketplace berubah (Add/Edit/Delete Product, atau status
// Aktif/Nonaktif) — App yang menerima sinyal ini WAJIB fetch ulang
// GET /api/marketplace/products (personalized: isOwner/hasPendingOrder beda
// per user), PERSIS pola broadcastSteamAccountsUpdate() di atas. Sengaja
// TIDAK kirim daftar produk langsung di payload broadcast supaya tidak ada
// data owner/akses user lain yang bocor/ke-reset salah ke client lain.
async function broadcastMarketplaceProductsUpdate() {
  wsBroadcastAll('marketplace:products:update', { changed: true, at: Date.now() });
}

// Dipanggil setiap kali ENTITLEMENT satu user ke satu Product berubah (lunas
// beli, di-whitelist, atau whitelist dicabut) — signal PERSONAL ke user itu
// saja. App yang menerima ini WAJIB fetch ulang /api/games, /api/bypasses,
// DAN /api/marketplace/products (ketiganya punya field personalized —
// hasAccess/isOwner — yang bisa berubah gara-gara satu perubahan akses ini).
// Ini yang membuat requirement #15/#18 (tombol Install/Tidak Ada Akses
// berubah REALTIME tanpa restart App) benar-benar terjadi.
function pushMarketplaceAccessUpdate(discordId, { productId, access, source } = {}) {
  wsSendToUser(discordId, 'marketplace:access:update', { productId, access, source, at: Date.now() });
  broadcastAdmin('marketplace:access:update', { discordId, productId, access, source });
}

// ── Aktivasi order lunas: kasih entitlement (grantAccess source:'purchase'),
// kirim notifikasi + Log, broadcast Socket.IO. Idempotent lewat
// transitionFromPending (WHERE status:'pending') — kalau webhook KlikQRIS
// retry/dobel, panggilan kedua otomatis no-op (Test 15: cegah entitlement
// duplikat/bug). ──
async function activateCompletedMarketplaceOrder(orderId, { paymentMethod, completedAt } = {}) {
  const result = await marketplaceOrderManager.transitionFromPending(orderId, {
    status: 'completed', paymentMethod, completedAt: completedAt || new Date()
  });
  if (!result.ok) return null; // sudah diproses sebelumnya — no-op
  const order = result.order;
  const { discordId, username, productId, productName } = order;
  const amountLabel = `Rp${Number(order.amount).toLocaleString('id-ID')}`;

  logActivity({
    type: 'marketplace_payment_success',
    username, discordId, status: 'success', ip: null,
    description: `[PAYMENT_SUCCESS] Pembayaran ${orderId} untuk produk Marketplace "${productName}" berhasil (${amountLabel}).`,
    meta: { orderId, productId, productName, amount: order.amount, event: 'PAYMENT_SUCCESS' }
  }).catch(() => {});

  // Kasih entitlement — upsert, jadi kalau user ini KEBETULAN sudah punya
  // akses 'whitelist' ke produk yang sama, source otomatis pindah jadi
  // 'purchase' TANPA akses sempat hilang di antara transisi (lihat catatan
  // grantAccess() di marketplaceManager.js).
  const access = await marketplaceManager.grantAccess({
    discordId, username, productId, productName, grantedBy: 'system', source: 'purchase'
  }).catch(e => {
    console.error(`[Marketplace] KRITIS: order ${orderId} lunas tapi gagal grant access:`, e.message);
    return null;
  });

  if (!access) {
    console.error(`[Marketplace] KRITIS: order ${orderId} lunas tapi produk ${productId} tidak ditemukan/gagal — butuh penanganan manual Admin.`);
    notifyUser(discordId, {
      type: 'marketplace_allocation_failed',
      title: 'Akses Tidak Bisa Diberikan',
      message: `Pembayaran untuk "${productName}" berhasil, tapi terjadi kendala saat memberikan akses. Admin akan segera menghubungimu.`,
      fields: [field('🧾 Invoice', orderId, true), field('📦 Produk', productName, true), field('💰 Nominal', amountLabel, true)],
      dm: true, webhook: true
    }).catch(() => {});
    broadcastAdmin('marketplace:allocation:failed', { orderId, productId, discordId, username });
    return order;
  }

  await marketplaceManager.incrementSalesCount(productId).catch(() => {});

  logActivity({
    type: 'marketplace_access_granted',
    username, discordId, status: 'success', ip: null,
    description: `[MARKETPLACE_ACCESS_GRANTED] ${username} mendapatkan akses produk Marketplace "${productName}" (invoice ${orderId}, sumber: purchase).`,
    meta: { orderId, productId, productName, source: 'purchase', event: 'MARKETPLACE_ACCESS_GRANTED' }
  }).catch(() => {});

  // Ringkasan isi produk (Game/Bypass) buat ditampilkan di notifikasi —
  // reuse listContent(), TIDAK query katalog terpisah.
  const content = await marketplaceManager.listContent(productId).catch(() => ({ games: [], bypasses: [] }));
  const contentLines = [
    ...content.games.map(g => `🎮 ${g.name}`),
    ...content.bypasses.map(b => `🛠️ ${b.name}`)
  ];
  const contentLabel = contentLines.length ? contentLines.join('\n') : '-';

  notifyUser(discordId, {
    type: 'marketplace_purchase_success',
    title: 'Pembayaran Berhasil!',
    message: `Pembayaran untuk produk "${productName}" berhasil. Buka App -> Product ini -> Game/Bypass yang termasuk sudah bisa langsung diinstall/download.`,
    fields: [
      field('👤 Pembeli', username, true),
      field('🧾 Invoice', orderId, true),
      field('📦 Produk', productName, true),
      field('🎁 Isi Produk', contentLabel, false),
      field('💰 Nominal', amountLabel, true),
      field('💳 Metode', String(order.paymentMethod || '').toUpperCase(), true)
    ],
    meta: { orderId, productId },
    dm: true, webhook: true
  }).catch(() => {});

  logActivity({
    type: 'marketplace_order_created', // dipertahankan sengaja: dipakai juga sebagai penanda "order selesai" di description-nya sendiri
    username, discordId, status: 'success',
    ip: null,
    description: `${username} berhasil membeli produk Marketplace "${productName}" via KlikQRIS (invoice ${orderId}, ${amountLabel}).`,
    meta: { orderId, productId, amount: order.amount }
  }).catch(() => {});

  const freshOrder = await marketplaceOrderManager.getByOrderId(orderId);
  wsSendToUser(discordId, 'marketplace:order:update', marketplaceOrderManager.publicOrder(freshOrder));
  broadcastAdmin('marketplace:order:update', marketplaceOrderManager.publicOrder(freshOrder));

  // Entitlement user ini berubah -> Game/Bypass terkait langsung berubah dari
  // "Tidak Ada Akses" jadi Install/Download REALTIME (requirement #15),
  // TANPA restart App.
  pushMarketplaceAccessUpdate(discordId, { productId, access: true, source: 'purchase' });
  broadcastMarketplaceProductsUpdate().catch(() => {});

  return freshOrder;
}

async function refreshMarketplaceOrderFromKlikqris(order) {
  const detail = await klikqrisManager.getTransactionDetail({ orderId: order.orderId, mode: order.paymentMode });
  if (!detail) return null;
  if (detail.order_id !== order.orderId || Number(detail.amount) !== Number(order.amount)) {
    console.warn(`[Marketplace] Mismatch status KlikQRIS utk ${order.orderId} — diabaikan.`);
    return null;
  }
  if (detail.status === 'SUCCESS') {
    return activateCompletedMarketplaceOrder(order.orderId, { paymentMethod: detail.payment_method, completedAt: detail.completed_at });
  }
  if (detail.status === 'EXPIRED') {
    const result = await marketplaceOrderManager.transitionFromPending(order.orderId, { status: 'expired' });
    if (result.ok) {
      const updatedOrder = result.order;
      wsSendToUser(order.discordId, 'marketplace:order:update', marketplaceOrderManager.publicOrder(updatedOrder));
      broadcastAdmin('marketplace:order:update', marketplaceOrderManager.publicOrder(updatedOrder));
    }
    return result.order;
  }
  return null;
}

async function cancelPendingMarketplaceOrder(order, { by, cancelledByAdmin } = {}) {
  const result = await marketplaceOrderManager.transitionFromPending(order.orderId, {
    status: 'cancelled', extra: { cancelledBy: by || 'user' }
  });
  if (!result.ok) return null;
  const cancelled = result.order;

  klikqrisManager.cancelTransaction({ orderId: cancelled.orderId }).catch(() => {});

  logActivity({
    type: 'marketplace_order_cancelled',
    username: cancelled.username, discordId: cancelled.discordId, status: 'info',
    ip: null,
    admin: cancelledByAdmin || undefined,
    description: cancelledByAdmin
      ? `Admin (${cancelledByAdmin}) membatalkan pesanan Marketplace ${cancelled.orderId} milik ${cancelled.username}.`
      : `${cancelled.username} membatalkan pesanan Marketplace ${cancelled.orderId} miliknya sendiri.`,
    meta: { orderId: cancelled.orderId, productId: cancelled.productId, amount: cancelled.amount }
  }).catch(() => {});

  const publicOrder = marketplaceOrderManager.publicOrder(cancelled);
  wsSendToUser(cancelled.discordId, 'marketplace:order:update', publicOrder);
  broadcastAdmin('marketplace:order:update', publicOrder);

  if (cancelledByAdmin) {
    notifyUser(cancelled.discordId, {
      type: 'marketplace_order_cancelled',
      title: 'Pesanan Dibatalkan',
      message: `Pesanan ${cancelled.orderId} (produk "${cancelled.productName}") dibatalkan oleh Admin. Kalau ini keliru, silakan hubungi Admin atau buat pesanan baru.`,
      fields: [field('🧾 Invoice', cancelled.orderId, true), field('📦 Produk', cancelled.productName, true)],
      dm: true, webhook: true
    }).catch(() => {});
  }

  return cancelled;
}

// ══════════════════════════════════════════════════════════════════════════
// APP: MARKETPLACE — listing produk, detail, alur beli via KlikQRIS
// ══════════════════════════════════════════════════════════════════════════

// ── Daftar produk AKTIF (dipakai section "Product On Sale" & "New Games") —
// personalized: isOwner (sudah beli/whitelist) & hasPendingOrder (lagi nunggu
// bayar) dihitung SEKALI per user, bukan per produk (hindari N+1). ──
app.get('/api/marketplace/products', requireUser, async (req, res) => {
  try {
    const [products, ownedProductIds, pendingProductIds, gatewayCfg] = await Promise.all([
      marketplaceManager.listActiveProducts(),
      marketplaceManager.getOwnedProductIdSet(req.user.discordId),
      marketplaceOrderManager.listActivePendingProductIdsForUser(req.user.discordId),
      klikqrisManager.getSettings()
    ]);
    // Gating antar-Product (requiredProductId) — resolve nama+type SEKALI
    // untuk semua requiredProductId yang muncul di batch ini (hindari N+1),
    // `available`-nya cukup dicek dari ownedProductIds Set yang sudah ada.
    const requiredIds = products.map(p => p.requiredProductId).filter(Boolean);
    const reqInfoMap = await marketplaceManager.getRequirementInfoMap(requiredIds);
    res.json({
      products: products.map(p => {
        const reqInfo = p.requiredProductId ? reqInfoMap.get(String(p.requiredProductId)) : null;
        return marketplaceManager.publicProduct(p, {
          isOwner: ownedProductIds.has(String(p._id)),
          hasPendingOrder: pendingProductIds.has(String(p._id)),
          requirement: reqInfo ? { ...reqInfo, available: ownedProductIds.has(reqInfo.productId) } : null
        });
      }),
      paymentMethods: gatewayCfg.enabled ? klikqrisManager.PAYMENT_METHODS : [],
      gatewayEnabled: gatewayCfg.enabled
    });
  } catch (e) {
    console.error('[Marketplace] Gagal ambil daftar produk:', e);
    res.status(500).json({ error: 'Gagal memuat daftar produk.' });
  }
});

// ── Riwayat pembelian Marketplace milik user — HARUS didaftar SEBELUM /:id
// di bawah (pola sama seperti "orders" di Steam Account/route lain: kalau
// tidak, Express salah tangkap "orders" sebagai :id). ──
app.get('/api/marketplace/orders', requireUser, async (req, res) => {
  try {
    const items = await marketplaceOrderManager.listByUser(req.user.discordId);
    res.json({ orders: items.map(marketplaceOrderManager.publicOrder) });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat riwayat pesanan.' });
  }
});

// ── Detail produk + isi konten (Game/Bypass) + status kepemilikan user ini.
// Dipakai halaman Detail Product di App (requirement #3). ──
app.get('/api/marketplace/products/:id', requireUser, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const [content, access, pendingOrder, reqInfo] = await Promise.all([
      marketplaceManager.listContent(req.params.id),
      marketplaceManager.getAccess(req.user.discordId, req.params.id),
      marketplaceOrderManager.getActivePendingForUser(req.user.discordId, req.params.id),
      product.requiredProductId ? marketplaceManager.getRequirementInfo(product.requiredProductId) : null
    ]);
    const reqAccess = (reqInfo && product.requiredProductId)
      ? await marketplaceManager.getAccess(req.user.discordId, product.requiredProductId)
      : null;
    res.json({
      product: marketplaceManager.publicProduct(product, {
        isOwner: !!access,
        accessSource: access?.source || null,
        hasPendingOrder: !!pendingOrder,
        requirement: reqInfo ? { ...reqInfo, available: !!reqAccess } : null
      }),
      content, // { games: [...], bypasses: [...] } — kosongkan kategori di UI kalau array-nya kosong (requirement #3)
      pendingOrder: pendingOrder ? marketplaceOrderManager.publicOrder(pendingOrder) : null
    });
  } catch (e) {
    console.error('[Marketplace] Gagal ambil detail produk:', e);
    res.status(500).json({ error: 'Gagal memuat detail produk.' });
  }
});

// ── Cek order pending milik user ini utk 1 produk — dipakai tombol
// "PEMBAYARAN DIPROSES" biar langsung buka layar bayar yang sudah ada. ──
app.get('/api/marketplace/purchase/pending', requireUser, async (req, res) => {
  try {
    const productId = String(req.query.productId || '');
    if (!productId) return res.status(400).json({ error: 'productId wajib diisi.' });
    const order = await marketplaceOrderManager.getActivePendingForUser(req.user.discordId, productId);
    res.json({ order: order ? marketplaceOrderManager.publicOrder(order) : null });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat status pembayaran.' });
  }
});

app.post('/api/marketplace/purchase', requireUser, async (req, res) => {
  const discordId = req.user.discordId;
  const username = req.user.username || discordId;
  const productId = String(req.body?.productId || '');
  const method = String(req.body?.method || '');

  try {
    if (!productId) return res.status(400).json({ error: 'Produk tidak valid.' });
    if (!klikqrisManager.isValidMethod(method)) {
      return res.status(400).json({ error: 'Metode pembayaran tidak valid.' });
    }

    const product = await marketplaceManager.getProductById(productId);
    if (!product || product.status !== 'active') {
      return res.status(400).json({ error: 'Produk ini sudah tidak tersedia.' });
    }

    // Gating antar-Product (requiredProductId) — dicek ULANG di server,
    // bukan cuma dicegat mktLockedModal di frontend, supaya tidak bisa
    // di-bypass dengan hit endpoint ini langsung.
    if (product.requiredProductId) {
      const requiredAccess = await marketplaceManager.getAccess(discordId, product.requiredProductId);
      if (!requiredAccess) {
        return res.status(400).json({
          error: 'Produk ini membutuhkan produk lain yang belum kamu miliki.',
          requirementNotMet: true,
          requiredProductId: product.requiredProductId
        });
      }
    }

    // Sudah punya akses (purchase ATAU whitelist) -> tidak perlu/tidak boleh
    // beli lagi (requirement #28: jangan duplikasi entitlement).
    const existingAccess = await marketplaceManager.getAccess(discordId, productId);
    if (existingAccess) {
      return res.status(400).json({ error: 'Kamu sudah memiliki akses ke produk ini.', alreadyOwned: true });
    }

    const gatewayCfg = await klikqrisManager.getSettings();

    // Satu user cuma boleh punya SATU order pending aktif per produk
    // (requirement #15/Test 15: cegah invoice ganda/entitlement duplikat).
    const existingPending = await marketplaceOrderManager.getActivePendingForUser(discordId, productId);
    if (existingPending) {
      const isResumable = existingPending.provider === 'klikqris'
        && (existingPending.paymentMode || 'sandbox') === gatewayCfg.mode;
      if (isResumable) {
        return res.json({ success: true, resumed: true, order: marketplaceOrderManager.publicOrder(existingPending) });
      }
      await marketplaceOrderManager.transitionFromPending(existingPending.orderId, {
        status: 'expired', extra: { cancelledBy: 'system', staleReason: 'gateway_mode_switched' }
      });
      broadcastAdmin('marketplace:order:update', marketplaceOrderManager.publicOrder({ ...existingPending, status: 'expired' }));
    }

    const orderId = marketplaceOrderManager.generateOrderId();
    const keterangan = klikqrisManager.keteranganProdukDigital(product.name);
    const payment = await klikqrisManager.createTransaction({ orderId, amount: product.price, keterangan });

    const order = await marketplaceOrderManager.createPendingOrder({
      discordId, username, productId, productName: product.name, amount: product.price, method, payment,
      productSnapshot: {
        name: product.name, description: product.description, price: product.price,
        imageUrl: product.imageUrl, imageData: product.imageData, badge: product.badge
      }
    });

    logActivity({
      type: 'marketplace_order_created',
      username, discordId, status: 'info',
      ip: getReqIp(req),
      description: `[PAYMENT_CREATED] ${username} membuat pesanan ${orderId} untuk produk Marketplace "${product.name}" (Rp${product.price.toLocaleString('id-ID')}, metode ${payment.payment_method}).`,
      meta: { orderId, productId, productName: product.name, amount: product.price, method: payment.payment_method, event: 'PAYMENT_CREATED' }
    }).catch(() => {});

    broadcastAdmin('marketplace:order:update', marketplaceOrderManager.publicOrder(order));

    res.json({ success: true, resumed: false, order: marketplaceOrderManager.publicOrder(order) });
  } catch (e) {
    console.error('[Marketplace] Gagal membuat order:', e.message);
    res.status(400).json({ error: e.message || 'Gagal membuat pesanan, coba lagi sebentar.' });
  }
});

app.get('/api/marketplace/purchase/:orderId', requireUser, async (req, res) => {
  try {
    const order = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    if (!order || order.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    if (order.status === 'pending') {
      await refreshMarketplaceOrderFromKlikqris(order).catch(e => console.warn('[Marketplace] Gagal cek status ke KlikQRIS:', e.message));
    }
    const fresh = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    res.json({ order: marketplaceOrderManager.publicOrder(fresh) });
  } catch (e) {
    console.error('[Marketplace] Gagal ambil status order:', e);
    res.status(500).json({ error: 'Gagal memuat status pesanan.' });
  }
});

app.post('/api/marketplace/purchase/:orderId/cancel', requireUser, async (req, res) => {
  try {
    const order = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    if (!order || order.discordId !== req.user.discordId) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Pesanan ini sudah ${order.status}, tidak bisa dibatalkan.` });
    }
    const cancelled = await cancelPendingMarketplaceOrder(order, { by: 'user' });
    if (!cancelled) {
      return res.status(409).json({ error: 'Pesanan baru saja berubah status (mungkin sudah lunas), coba refresh.' });
    }
    res.json({ success: true, order: marketplaceOrderManager.publicOrder(cancelled) });
  } catch (e) {
    console.error('[Marketplace] Gagal membatalkan order:', e);
    res.status(500).json({ error: 'Gagal membatalkan pesanan.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FIX GAMBAR TIDAK MUNCUL (Steam Account & katalog lain) — ROOT CAUSE:
// endpoint GET .../:id/image sebelumnya cuma menerima imageData yang PERSIS
// match regex `^data:image\/(png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=]+)$`.
// Data LAMA (sebelum aturan upload sekarang ada, atau hasil input manual
// admin) bisa gagal match karena beberapa alasan umum:
//   1) base64 mengandung newline/whitespace (hasil copy-paste atau encoder
//      lama yang wrap tiap 76 karakter) — karakter itu TIDAK ada di
//      character class regex lama, jadi match gagal total → 404.
//   2) mime type-nya di luar whitelist lama (mis. "image/jpg" beda huruf
//      besar/kecil, atau "image/svg+xml") padahal datanya valid.
//   3) imageData tersimpan sebagai RAW base64 tanpa prefix "data:image/...;
//      base64," sama sekali (format lama sebelum skema data-URI dipakai).
// Fungsi di bawah ini menangani ketiganya SEBAGAI compatibility layer —
// TIDAK mengubah cara data baru disimpan (validateImageFields di
// steamAccountManager.js tetap ketat saat upload),
// cuma bikin proses BACA/SERVE gambar lebih toleran ke variasi data lama,
// tanpa migrasi/menyentuh data di database sama sekali.
// ══════════════════════════════════════════════════════════════════════════
function decodeImageDataForServing(raw) {
  if (!raw) return null;

  // Kasus 4 (BARU): data sangat lama yang tersimpan sebagai Buffer/Binary
  // Mongo langsung (bukan string base64 sama sekali) — hasImage di listAdmin
  // tetap menganggap field ini "ada isinya" (bukan null/''), tapi kalau tidak
  // ditangani di sini, cek `typeof raw !== 'string'` di bawah langsung
  // menganggapnya kosong → 404 padahal datanya sebenarnya ada. Node Buffer
  // dan BSON Binary (driver mongodb) sama-sama punya `.buffer`/bisa diakses
  // sebagai array byte — tangkap dua-duanya lalu sniff mime dari magic bytes,
  // sama seperti raw base64 lama di Kasus 3.
  if (Buffer.isBuffer(raw)) {
    const mime = sniffImageMime(raw);
    return mime ? { buffer: raw, mime } : null;
  }
  if (raw && typeof raw === 'object' && raw.buffer) {
    try {
      const buf = Buffer.isBuffer(raw.buffer) ? raw.buffer : Buffer.from(raw.buffer);
      const mime = sniffImageMime(buf);
      return mime ? { buffer: buf, mime } : null;
    } catch (e) {
      return null;
    }
  }

  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // Kasus 1 & 2: format data-URI, tapi lebih toleran dari regex lama —
  // mime type apa saja (bukan whitelist tertutup) + whitespace/newline di
  // dalam payload base64 dibuang dulu sebelum decode.
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (m) {
    let mime = m[1].toLowerCase();
    if (mime === 'jpg') mime = 'jpeg';
    const base64 = m[2].replace(/\s+/g, '');
    if (!base64) return null;
    try {
      const buf = Buffer.from(base64, 'base64');
      if (!buf.length) return null;
      return { buffer: buf, mime: sniffImageMime(buf) || mime };
    } catch (e) {
      return null;
    }
  }

  // Kasus 3: raw base64 tanpa prefix "data:image/...;base64," sama sekali
  // (data sangat lama). Kalau isinya memang base64 yang valid dan cukup
  // panjang buat sebuah gambar, decode lalu tebak tipe gambarnya dari magic
  // bytes (sniffImageMime) — bukan asal tebak dari nama field.
  const stripped = trimmed.replace(/\s+/g, '');
  if (stripped.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    try {
      const buf = Buffer.from(stripped, 'base64');
      const mime = sniffImageMime(buf);
      if (mime) return { buffer: buf, mime };
    } catch (e) {
      // bukan base64 valid — bukan gambar, lanjut return null di bawah
    }
  }

  return null;
}

// Deteksi tipe gambar dari magic bytes (signature) di awal file — dipakai
// buat data lama yang tidak (atau salah) menyimpan mime type-nya sendiri.
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN: STEAM ACCOUNT — CRUD akun (Admin Web -> Steam Accounts)
// ══════════════════════════════════════════════════════════════════════════

app.get('/api/admin/steam-accounts', requireAdmin, async (req, res) => {
  try {
    const list = await steamAccountManager.listAdmin();
    // PERF FIX: sebelumnya 1 query countOwners() PER akun via Promise.all
    // (N query ke MongoDB kalau ada N akun). Sekarang 1 aggregation buat
    // semua akun sekaligus (lihat countOwnersBulk di steamAccountManager.js).
    const ownersMap = await steamAccountManager.countOwnersBulk(list.map(p => p._id));
    const products = list.map(p => steamAccountManager.adminProduct(p, ownersMap.get(String(p._id)) || 0));
    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Search preview by App ID — dipakai form "Add Game" sebelum di-Add,
// reuse fetchSteamDetailsForAppId (SAMA fungsi dipakai Auto-Isi Game/Bypass).
// HARUS didaftar SEBELUM /:id di bawah — kalau tidak, Express bakal salah
// tangkap "search-game" sebagai :id (route parameterized menang duluan kalau
// didaftar lebih dulu). ──
app.get('/api/admin/steam-accounts/search-game', requireAdmin, async (req, res) => {
  try {
    const details = await steamAccountManager.searchGameByAppId(req.query.appId);
    res.json({ game: details });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// PERF FIX: endpoint gambar terpisah — dipakai <img> di tabel/list & preview
// modal Edit Admin Web supaya list utama (/api/admin/steam-accounts) tidak
// perlu bawa base64 sama sekali (lihat steamAccountManager.listAdmin).
// HARUS didaftar SEBELUM search-game & /:id di bawah — pola sama seperti
// route lain di file ini (komentar-komentar di atas soal urutan Express).
app.get('/api/admin/steam-accounts/:id/image', requireAdmin, async (req, res) => {
  try {
    const doc = await steamAccountManager.getImage(req.params.id);
    if (!doc) return res.status(404).end();
    if (doc.imageData) {
      // Compatibility layer buat data lama (lihat decodeImageDataForServing
      // di atas) — bukan cuma regex ketat yang gagal diam-diam kalau format
      // sedikit beda.
      const decoded = decodeImageDataForServing(doc.imageData);
      if (!decoded) return res.status(404).end();
      res.set('Content-Type', `image/${decoded.mime}`);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.end(decoded.buffer);
    }
    if (doc.imageUrl) return res.redirect(doc.imageUrl);
    return res.status(404).end();
  } catch (e) {
    res.status(500).end();
  }
});

app.get('/api/admin/steam-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const product = await steamAccountManager.getById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    const ownersCount = await steamAccountManager.countOwners(req.params.id);
    res.json({ product: steamAccountManager.adminProduct(product, ownersCount) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/steam-accounts', requireAdmin, async (req, res) => {
  try {
    const product = await steamAccountManager.create(req.body || {});
    logActivity({
      type: 'admin_add_steam_account',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin menambahkan akun Steam baru "${product.name}".`,
      meta: { productId: product._id, name: product.name }
    }).catch(() => {});
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ product: steamAccountManager.adminProduct(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── /reorder HARUS didaftar SEBELUM /:id di bawah (pola bug sama seperti
// search-game & orders). ──
app.put('/api/admin/steam-accounts/reorder', requireAdmin, async (req, res) => {
  try {
    await steamAccountManager.reorder(Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : []);
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/steam-accounts/:id', requireAdmin, async (req, res) => {
  try {
    // PERF FIX: countOwners(id) TIDAK butuh hasil update() — cuma butuh id
    // yang sudah ada dari req.params. Sebelumnya dijalankan berurutan SETELAH
    // update() selesai (nunggu 2x round-trip DB total secara sequential).
    // Sekarang jalan paralel bareng update() lewat Promise.all.
    const [product, ownersCount] = await Promise.all([
      steamAccountManager.update(req.params.id, req.body || {}),
      steamAccountManager.countOwners(req.params.id)
    ]);
    logActivity({
      type: 'admin_edit_steam_account',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin mengedit akun Steam "${product.name}".`,
      meta: { productId: product._id }
    }).catch(() => {});
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ product: steamAccountManager.adminProduct(product, ownersCount) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/steam-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const doc = await steamAccountManager.remove(req.params.id, { force });
    if (!doc) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    logActivity({
      type: 'admin_delete_steam_account',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin menghapus akun Steam "${doc.name}"${force ? ' (Hapus Paksa, sudah punya owner)' : ''}.`,
      meta: { productId: doc._id, forced: force }
    }).catch(() => {});
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/steam-accounts/:id/games', requireAdmin, async (req, res) => {
  try {
    const product = await steamAccountManager.addGame(req.params.id, req.body?.appId);
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ product: steamAccountManager.adminProduct(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── FITUR BARU: Tambah banyak game sekaligus dari banyak App ID (dipisah
// path & body dari endpoint single /games di atas — endpoint lama TIDAK
// disentuh sama sekali, tetap jalan seperti biasa buat alur tambah 1-1).
// Body: { appIds: "2947440\n990080\n2101960" } ATAU array ["2947440", ...].
// Setelah semua App ID diproses, seluruh daftar game di akun ini diurutkan
// ULANG — yang harganya PALING MAHAL ditaruh paling awal (game tanpa info
// harga dari Steam ditaruh paling akhir). ──
app.post('/api/admin/steam-accounts/:id/games/bulk', requireAdmin, async (req, res) => {
  try {
    const result = await steamAccountManager.addGamesBulk(req.params.id, req.body?.appIds);
    if (result.added.length) {
      logActivity({
        type: 'admin_bulk_add_steam_account_games',
        username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
        ip: getReqIp(req),
        description: `Admin menambahkan ${result.added.length} game sekaligus ke akun Steam "${result.product.name}" (App ID: ${result.added.map(a => a.appId).join(', ')}).`,
        meta: { productId: req.params.id, added: result.added, skipped: result.skipped, failed: result.failed }
      }).catch(() => {});
    }
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({
      product: steamAccountManager.adminProduct(result.product),
      added: result.added,
      skipped: result.skipped,
      failed: result.failed
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/steam-accounts/:id/games/:appId', requireAdmin, async (req, res) => {
  try {
    const product = await steamAccountManager.removeGame(req.params.id, req.params.appId);
    broadcastSteamAccountsUpdate().catch(() => {});
    res.json({ product: steamAccountManager.adminProduct(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/steam-accounts/orders/list', requireAdmin, async (req, res) => {
  try {
    const { status, discordId, q, limit, skip } = req.query;
    const result = await steamAccountOrderManager.listAll({
      status: status || undefined, discordId: discordId || undefined, q: q || undefined,
      limit: limit ? Number(limit) : 100, skip: skip ? Number(skip) : 0, lite: true
    });
    res.json({ orders: result.items.map(steamAccountOrderManager.publicOrder), total: result.total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/steam-accounts/orders/:orderId/refresh', requireAdmin, async (req, res) => {
  try {
    const order = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    if (order.status !== 'pending') return res.json({ order: steamAccountOrderManager.publicOrder(order) });
    await refreshSteamAccountOrderFromKlikqris(order);
    const fresh = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    res.json({ order: steamAccountOrderManager.publicOrder(fresh) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/steam-accounts/orders/:orderId/cancel', requireAdmin, async (req, res) => {
  try {
    const order = await steamAccountOrderManager.getByOrderId(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Pesanan ini sudah ${order.status}.` });
    const cancelled = await cancelPendingSteamAccountOrder(order, { by: 'admin', cancelledByAdmin: req.admin?.username || 'Admin' });
    if (!cancelled) return res.status(409).json({ error: 'Pesanan baru saja berubah status, coba refresh.' });
    res.json({ success: true, order: steamAccountOrderManager.publicOrder(cancelled) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════
// ADMIN: MARKETPLACE — CRUD Product, Kelola Konten (Game/Bypass link),
// Whitelist, dan Transaksi. Semua handler DI SINI, TIDAK ada logic bisnis
// baru — semuanya delegasi ke marketplaceManager.js/marketplaceOrderManager.js
// dan fungsi lifecycle (activateCompletedMarketplaceOrder dkk) yang sudah
// didefinisikan di section MARKETPLACE (App) di atas.
// ══════════════════════════════════════════════════════════════════════════

// Bentuk ringkas 1 produk buat LIST admin — imageData DIBUANG (dipakai
// <img> lazy-load lewat /:id/image, pola sama seperti Steam Account) supaya
// payload list tidak membengkak kalau produknya banyak (requirement #33).
function adminProductLite(p, extra = {}) {
  const full = marketplaceManager.publicProduct(p, extra);
  const { imageData, ...lite } = full;
  return { ...lite, hasImage: !!p.imageData || !!p.imageUrl };
}

app.get('/api/admin/marketplace/stats', requireAdmin, async (req, res) => {
  try {
    // Produk yang sudah di-soft-delete (status:'deleted') dikeluarkan dari
    // semua statistik di sini — sama seperti listProducts(), biar konsisten
    // dengan "produk yang sudah dihapus tidak lagi dihitung sebagai produk
    // Marketplace yang ada".
    const [totalProducts, activeProducts, totalOrders, salesAgg, newestProducts, bestSellers] = await Promise.all([
      db.collection(marketplaceManager.PRODUCTS_COLLECTION).countDocuments({ status: { $ne: 'deleted' } }),
      db.collection(marketplaceManager.PRODUCTS_COLLECTION).countDocuments({ status: 'active' }),
      db.collection('marketplaceOrders').countDocuments({}),
      db.collection('marketplaceOrders').aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]).toArray(),
      db.collection(marketplaceManager.PRODUCTS_COLLECTION).find({ status: { $ne: 'deleted' } }).sort({ createdAt: -1 }).limit(5).toArray(),
      db.collection(marketplaceManager.PRODUCTS_COLLECTION).find({ status: { $ne: 'deleted' }, salesCount: { $gt: 0 } }).sort({ salesCount: -1 }).limit(5).toArray()
    ]);
    res.json({
      totalProducts, activeProducts, totalOrders,
      totalSales: salesAgg[0]?.total || 0,
      totalCompletedOrders: salesAgg[0]?.count || 0,
      newestProducts: newestProducts.map(p => adminProductLite(p)),
      bestSellers: bestSellers.map(p => adminProductLite(p))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/marketplace/products', requireAdmin, async (req, res) => {
  try {
    const { status, q, limit, skip } = req.query;
    const { items, total } = await marketplaceManager.listProducts({
      status: status || undefined, q: q || undefined,
      limit: limit ? Number(limit) : 200, skip: skip ? Number(skip) : 0
    });
    const ids = items.map(p => String(p._id));
    // Hitung jumlah content & akses SEKALIGUS pakai aggregation (bukan per
    // produk) — hindari N+1 query kalau produknya banyak (requirement #33).
    const [contentAgg, accessAgg, orderAgg] = await Promise.all([
      ids.length ? db.collection(marketplaceManager.CONTENT_COLLECTION).aggregate([
        { $match: { productId: { $in: ids } } },
        { $group: { _id: '$productId', count: { $sum: 1 } } }
      ]).toArray() : [],
      ids.length ? db.collection(marketplaceManager.ACCESS_COLLECTION).aggregate([
        { $match: { productId: { $in: ids } } },
        { $group: { _id: '$productId', count: { $sum: 1 } } }
      ]).toArray() : [],
      // Dipakai frontend buat kasih tahu admin SEBELUM klik Delete kalau
      // produk ini bakal soft-delete (bukan hard delete) karena sudah pernah
      // ada order (termasuk yang gagal/kedaluwarsa — lihat getProductDependency).
      ids.length ? db.collection('marketplaceOrders').aggregate([
        { $match: { productId: { $in: ids } } },
        { $group: { _id: '$productId', count: { $sum: 1 } } }
      ]).toArray() : []
    ]);
    const contentCountMap = new Map(contentAgg.map(r => [r._id, r.count]));
    const accessCountMap = new Map(accessAgg.map(r => [r._id, r.count]));
    const orderCountMap = new Map(orderAgg.map(r => [r._id, r.count]));
    res.json({
      products: items.map(p => adminProductLite(p, {
        contentCount: contentCountMap.get(String(p._id)) || 0,
        accessCount: accessCountMap.get(String(p._id)) || 0,
        orderCount: orderCountMap.get(String(p._id)) || 0
      })),
      total
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PERF FIX: endpoint gambar terpisah, dipakai <img> di tabel list & preview
// modal Edit — pola & fungsi decode SAMA PERSIS dengan Steam Account
// (decodeImageDataForServing didefinisikan di bawah file ini). HARUS
// didaftar SEBELUM /:id di bawah — pola Express yang sama seperti tempat
// lain di file ini (route statis menang duluan kalau didaftar lebih dulu).
app.get('/api/admin/marketplace/products/:id/image', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).end();
    if (product.imageData) {
      const decoded = decodeImageDataForServing(product.imageData);
      if (!decoded) return res.status(404).end();
      res.set('Content-Type', `image/${decoded.mime}`);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.end(decoded.buffer);
    }
    if (product.imageUrl) return res.redirect(product.imageUrl);
    return res.status(404).end();
  } catch (e) {
    res.status(500).end();
  }
});

app.get('/api/admin/marketplace/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const [content, accessList, dependency] = await Promise.all([
      marketplaceManager.listContent(req.params.id),
      marketplaceManager.listAccessByProduct(req.params.id),
      marketplaceManager.getProductDependency(req.params.id)
    ]);
    res.json({
      product: marketplaceManager.publicProduct(product),
      content,
      access: accessList.map(marketplaceManager.publicAccess),
      dependency
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/marketplace/products', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.createProduct(req.body || {});
    logActivity({
      type: 'marketplace_product_created',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin menambahkan produk Marketplace baru "${product.name}" (Rp${product.price.toLocaleString('id-ID')}).`,
      meta: { productId: product._id, name: product.name, price: product.price }
    }).catch(() => {});
    broadcastMarketplaceProductsUpdate().catch(() => {});
    res.json({ product: adminProductLite(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/marketplace/products/:id', requireAdmin, async (req, res) => {
  try {
    const before = await marketplaceManager.getProductById(req.params.id);
    const product = await marketplaceManager.updateProduct(req.params.id, req.body || {});
    const statusChangedToInactive = before && before.status === 'active' && product.status === 'inactive';
    logActivity({
      type: statusChangedToInactive ? 'marketplace_product_disabled' : 'marketplace_product_updated',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: statusChangedToInactive
        ? `Admin menonaktifkan produk Marketplace "${product.name}".`
        : `Admin mengedit produk Marketplace "${product.name}".`,
      meta: { productId: product._id },
      before: before ? { name: before.name, price: before.price, status: before.status } : undefined,
      after: { name: product.name, price: product.price, status: product.status }
    }).catch(() => {});
    // Realtime: nama/harga/gambar/deskripsi/badge/status berubah -> App yang
    // lagi buka Product On Sale/New Games/Detail Product HARUS ikut berubah
    // TANPA restart (requirement #7).
    broadcastMarketplaceProductsUpdate().catch(() => {});
    res.json({ product: adminProductLite(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ROOT CAUSE (product lama "permanen tidak bisa dihapus"): route ini dulu
// mengembalikan 409 kalau produk sudah punya order/akses, dan FRONTEND-nya
// (public/admin.js) cuma menawarkan "nonaktifkan" tanpa pernah memakai jalur
// force-delete yang sudah ada di sini — padahal listing Admin Web
// (marketplaceManager.listProducts) menampilkan status active MAUPUN
// inactive sekaligus, jadi produk "inactive" itu tetap muncul di grid dan
// terlihat seperti "delete tidak ngefek / muncul lagi setelah refresh".
// Produk lama dari versi code sebelumnya kena ini karena sudah keburu
// py punya order/akses/whitelist dari pemakaian sebelumnya; produk baru yang
// belum pernah dipakai lolos tanpa dependency sehingga hard-delete langsung
// jalan — makanya perilakunya kelihatan beda padahal code-path-nya sama.
//
// Fix: DELETE sekarang selalu benar-benar menghilangkan produk dari Admin
// Web & App dalam SATU aksi, untuk produk lama maupun baru:
//   - Tidak ada order/akses         -> hard delete (perilaku lama, tetap).
//   - Ada order/akses, TANPA force  -> soft-delete (status:'deleted'),
//                                       disembunyikan dari listing default
//                                       (requirement #4/#8/#17), histori
//                                       transaksi & whitelist tetap utuh.
//   - force=true (tombol "Hapus Permanen" di listing status=deleted)
//                                   -> hard delete beneran (dipakai admin
//                                       untuk pembersihan data permanen).
app.delete('/api/admin/marketplace/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const dependency = await marketplaceManager.getProductDependency(req.params.id);
    const force = req.query.force === 'true' || req.body?.force === true;
    const hasDependency = dependency.hasOrders || dependency.hasAccess;

    // CATATAN: instance MongoDB di project ini standalone (bukan replica set,
    // tidak ada session/transaction dipakai di manapun di codebase ini —
    // lihat marketplaceManager.js), jadi cascade di bawah TIDAK dibungkus
    // transaction. Urutan operasi di deleteProduct() sengaja menghapus
    // Product PALING TERAKHIR — kalau cascade Game/Bypass gagal di tengah
    // jalan, exception dilempar SEBELUM Product sempat terhapus, jadi tidak
    // pernah ada state "Product hilang tapi Game/Bypass nyangkut tanpa
    // relasi" (requirement anti-orphan). Admin tinggal retry Delete kalau ini
    // terjadi (mis. DB hiccup sesaat).
    let softDeleted = false;
    let deletedContent = { deletedGameIds: [], deletedBypassIds: [] };
    if (hasDependency && !force) {
      await marketplaceManager.softDeleteProduct(req.params.id);
      softDeleted = true;
    } else {
      deletedContent = await marketplaceManager.deleteProduct(req.params.id);
    }

    logActivity({
      type: 'marketplace_product_deleted',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'warning',
      ip: getReqIp(req),
      description: `Admin menghapus produk Marketplace "${product.name}"${softDeleted ? ' (soft-delete — sudah punya transaksi/akses, histori tetap aman)' : force ? ' (Hapus Paksa Permanen)' : ''}${(deletedContent.deletedGameIds.length || deletedContent.deletedBypassIds.length) ? ` — ikut menghapus ${deletedContent.deletedGameIds.length} Game & ${deletedContent.deletedBypassIds.length} Bypass yang memang dibuat khusus untuk produk ini` : ''}.`,
      meta: { productId: req.params.id, name: product.name, forced: force, softDeleted, dependency, deletedContent }
    }).catch(() => {});
    broadcastMarketplaceProductsUpdate().catch(() => {});
    // Realtime: Game/Bypass yang ikut kehapus harus langsung hilang dari
    // Admin Web & App tanpa refresh manual (requirement realtime + performa —
    // reuse broadcast existing, tidak bikin event Socket.IO baru).
    if (deletedContent.deletedGameIds.length) broadcastGamesUpdate().catch(() => {});
    if (deletedContent.deletedBypassIds.length) broadcastBypassesUpdate().catch(() => {});
    res.json({ success: true, softDeleted, deletedContent });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Pulihkan produk yang sudah di-soft-delete (dari listing filter
// status=deleted) — dikembalikan ke status 'inactive', bukan dihapus.
app.post('/api/admin/marketplace/products/:id/restore', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.restoreProduct(req.params.id);
    logActivity({
      type: 'marketplace_product_updated',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin memulihkan produk Marketplace "${product.name}" dari status dihapus.`,
      meta: { productId: req.params.id, name: product.name }
    }).catch(() => {});
    broadcastMarketplaceProductsUpdate().catch(() => {});
    res.json({ product: adminProductLite(product) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── KELOLA KONTEN — Add/Remove Game & Bypass. Picker daftar Game/Bypass
// existing pakai endpoint YANG SUDAH ADA (/api/admin/games, /api/admin/bypasses),
// TIDAK dibuatkan endpoint search baru (requirement #9/#10/#11). ──
app.get('/api/admin/marketplace/products/:id/content', requireAdmin, async (req, res) => {
  try {
    const content = await marketplaceManager.listContent(req.params.id);
    res.json(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/marketplace/products/:id/content', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const { contentType, itemId } = req.body || {};
    const { name } = await marketplaceManager.addContent(req.params.id, contentType, itemId);
    logActivity({
      type: 'marketplace_content_added',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin menambahkan ${contentType === 'bypass' ? 'Bypass' : 'Game'} "${name}" ke produk Marketplace "${product.name}".`,
      meta: { productId: req.params.id, productName: product.name, contentType, itemId }
    }).catch(() => {});
    // Realtime: item ini sekarang di-gate Marketplace -> App yang lagi lihat
    // Game/Bypass ini harus langsung berubah jadi "Tidak Ada Akses" kalau
    // belum entitled (requirement #14), tanpa restart.
    if (contentType === 'bypass') broadcastBypassesUpdate().catch(() => {});
    else broadcastGamesUpdate().catch(() => {});
    broadcastMarketplaceProductsUpdate().catch(() => {});
    const content = await marketplaceManager.listContent(req.params.id);
    res.json({ success: true, content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/marketplace/products/:id/content/:contentType/:itemId', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const { contentType, itemId } = req.params;
    const removed = await marketplaceManager.removeContent(req.params.id, contentType, itemId);
    if (!removed) return res.status(404).json({ error: 'Konten tidak ditemukan di produk ini.' });
    logActivity({
      type: 'marketplace_content_removed',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'warning',
      ip: getReqIp(req),
      description: `Admin menghapus hubungan ${contentType === 'bypass' ? 'Bypass' : 'Game'} dari produk Marketplace "${product.name}" (${contentType === 'bypass' ? 'Bypass' : 'Game'} asli TIDAK dihapus).`,
      meta: { productId: req.params.id, productName: product.name, contentType, itemId }
    }).catch(() => {});
    if (contentType === 'bypass') broadcastBypassesUpdate().catch(() => {});
    else broadcastGamesUpdate().catch(() => {});
    broadcastMarketplaceProductsUpdate().catch(() => {});
    const content = await marketplaceManager.listContent(req.params.id);
    res.json({ success: true, content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── WHITELIST — product-specific (requirement #17). Search user by Discord
// ID pakai pola SAMA seperti /api/admin/users/lookup (match exact discordId
// ATAU username), TAPI diletakkan di namespace Marketplace sendiri supaya
// responsnya sudah termasuk status akses ke produk ini. ──
app.get('/api/admin/marketplace/products/:id/whitelist', requireAdmin, async (req, res) => {
  try {
    const accessList = await marketplaceManager.listAccessByProduct(req.params.id);
    res.json({ access: accessList.map(marketplaceManager.publicAccess) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/marketplace/products/:id/whitelist/lookup', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.discordId || req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Discord ID wajib diisi.' });
    const re = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const user = await db.collection('users').findOne({ $or: [{ discordId: q }, { username: re }] });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan. Pastikan Discord ID benar dan user pernah login ke App minimal 1x.' });
    const identity = profileManager.effectiveIdentity(user);
    const access = await marketplaceManager.getAccess(user.discordId, req.params.id);
    res.json({
      discordId: user.discordId,
      username: identity.username,
      status: user.status || 'active',
      access: marketplaceManager.publicAccess(access)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/marketplace/products/:id/whitelist', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const discordId = String(req.body?.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const existing = await marketplaceManager.getAccess(discordId, req.params.id);
    if (existing) return res.status(400).json({ error: 'User ini sudah punya akses ke produk ini.', existing: marketplaceManager.publicAccess(existing) });

    const identity = profileManager.effectiveIdentity(user);
    await marketplaceManager.grantAccess({
      discordId, username: identity.username, productId: req.params.id, productName: product.name,
      grantedBy: req.admin?.username || 'Admin', source: 'whitelist'
    });

    logActivity({
      type: 'marketplace_whitelist_added',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
      ip: getReqIp(req),
      description: `Admin memberikan whitelist produk Marketplace "${product.name}" ke ${identity.username} (${discordId}).`,
      meta: { productId: req.params.id, productName: product.name, discordId, username: identity.username }
    }).catch(() => {});

    pushMarketplaceAccessUpdate(discordId, { productId: req.params.id, access: true, source: 'whitelist' });
    notifyUser(discordId, {
      type: 'marketplace_whitelist_granted',
      title: 'Akses Marketplace Diberikan',
      message: `Kamu diberikan akses ke produk "${product.name}" oleh Admin. Buka App -> Product ini -> Game/Bypass yang termasuk sudah bisa langsung diinstall/download.`,
      fields: [field('📦 Produk', product.name, true)],
      meta: { productId: req.params.id },
      dm: true, webhook: false
    }).catch(() => {});

    const accessList = await marketplaceManager.listAccessByProduct(req.params.id);
    res.json({ success: true, access: accessList.map(marketplaceManager.publicAccess) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/marketplace/products/:id/whitelist/:discordId', requireAdmin, async (req, res) => {
  try {
    const product = await marketplaceManager.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const { discordId } = req.params;

    const existing = await marketplaceManager.getAccess(discordId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'User ini tidak punya akses ke produk ini.' });
    const revokedSource = existing.source || 'whitelist';

    // FIX (requirement Cabut Akses): tombol ini SEBELUMNYA cuma mengizinkan
    // pencabutan akses bersumber 'whitelist' — akses hasil PURCHASE tetap
    // nyangkut & tetap kasih akses Install/Download walau admin sudah klik
    // Cabut. Sekarang KEDUA sumber ('purchase' MAUPUN 'whitelist') bisa
    // dicabut lewat endpoint yang sama, karena satu-satunya sumber
    // kebenaran akses (marketplaceAccess) memang cuma satu record per
    // user+produk (lihat marketplaceManager.js) — menghapusnya di sini
    // otomatis mencabut Install/Download-nya juga, TANPA menyentuh histori
    // order (marketplaceOrders tetap 'completed', jadi ini BUKAN
    // refund/pembatalan transaksi, cuma pencabutan entitlement).
    //
    // Ini BUKAN permanent ban: kalau user membeli produk yang sama lagi
    // setelah ini, alur /api/marketplace/purchase (getAccess() -> null,
    // lihat di atas) akan mengizinkan order baru dan activateCompletedMarketplaceOrder
    // akan grantAccess() lagi seperti biasa — purchase LAMA yang dicabut ini
    // tetap dianggap sudah dicabut (tidak otomatis kembali).
    await marketplaceManager.revokeAccess(discordId, req.params.id);

    logActivity({
      type: revokedSource === 'purchase' ? 'marketplace_purchase_access_revoked' : 'marketplace_whitelist_removed',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'warning',
      ip: getReqIp(req),
      description: revokedSource === 'purchase'
        ? `Admin mencabut akses produk Marketplace "${product.name}" (sumber: PEMBELIAN) dari ${existing.username || discordId}.`
        : `Admin mencabut whitelist produk Marketplace "${product.name}" dari ${existing.username || discordId}.`,
      meta: { productId: req.params.id, productName: product.name, discordId, revokedSource }
    }).catch(() => {});

    // Requirement #18 — INI YANG PALING KRITIS: tombol Install/Download harus
    // langsung hilang REALTIME, dan backend download endpoint (hasCatalogAccess
    // di atas, query LIVE ke collection ini, TIDAK ada cache) otomatis menolak
    // akses di request berikutnya — tanpa perubahan apapun lagi di sini.
    pushMarketplaceAccessUpdate(discordId, { productId: req.params.id, access: false, source: revokedSource });
    notifyUser(discordId, {
      type: 'marketplace_whitelist_revoked',
      title: 'Akses Marketplace Dicabut',
      message: `Akses kamu ke produk "${product.name}" telah dicabut oleh Admin. Kamu bisa mendapatkan akses kembali dengan membeli produk ini lagi.`,
      fields: [field('📦 Produk', product.name, true)],
      meta: { productId: req.params.id },
      dm: true, webhook: false
    }).catch(() => {});

    const accessList = await marketplaceManager.listAccessByProduct(req.params.id);
    res.json({ success: true, access: accessList.map(marketplaceManager.publicAccess) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── TRANSAKSI — list & aksi order Marketplace. Bentuk & pola respons SAMA
// PERSIS dengan /api/admin/steam-accounts/orders/* supaya halaman Transaksi
// Admin Web bisa reuse komponen tabel yang sama (requirement #23). ──
app.get('/api/admin/marketplace/orders', requireAdmin, async (req, res) => {
  try {
    const { status, discordId, q, limit, skip } = req.query;
    const result = await marketplaceOrderManager.listAll({
      status: status || undefined, discordId: discordId || undefined, q: q || undefined,
      limit: limit ? Number(limit) : 100, skip: skip ? Number(skip) : 0, lite: true
    });
    res.json({ orders: result.items.map(marketplaceOrderManager.publicOrder), total: result.total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/marketplace/orders/:orderId/refresh', requireAdmin, async (req, res) => {
  try {
    const order = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    if (order.status !== 'pending') return res.json({ order: marketplaceOrderManager.publicOrder(order) });
    await refreshMarketplaceOrderFromKlikqris(order);
    const fresh = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    res.json({ order: marketplaceOrderManager.publicOrder(fresh) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/marketplace/orders/:orderId/cancel', requireAdmin, async (req, res) => {
  try {
    const order = await marketplaceOrderManager.getByOrderId(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Pesanan ini sudah ${order.status}.` });
    const cancelled = await cancelPendingMarketplaceOrder(order, { by: 'admin', cancelledByAdmin: req.admin?.username || 'Admin' });
    if (!cancelled) return res.status(409).json({ error: 'Pesanan baru saja berubah status, coba refresh.' });
    res.json({ success: true, order: marketplaceOrderManager.publicOrder(cancelled) });
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
// NOTIF LOGIN — Quick Login App.
// ══════════════════════════════════════════════════════════════════════════
// ROOT CAUSE (kenapa Quick Login sebelumnya tidak mengirim NOTIF LOGIN):
// Quick Login ("Masuk Sekarang", lihat nvBtnQuickLogin di app.js) HANYA
// memanggil GET /api/me buat verifikasi token tersimpan — endpoint itu murni
// "ambil data user", tidak pernah dianggap sebagai EVENT login (tidak
// logActivity, tidak kirim webhook kategori 'login'). Webhook 'login' SELAMA
// INI cuma terpasang di callback OAuth Discord (/auth), jadi Quick Login yang
// tidak lewat /auth otomatis tidak pernah memicu notif — padahal bagi user itu
// tetap "berhasil login di App".
//
// FIX: endpoint kecil ini dipanggil App SETIAP kali Quick Login berhasil
// (setelah verifyDeviceLock() lolos, sebelum enterApp()) — pakai sistem
// notification login YANG SUDAH ADA (webhookManager.sendCategoryWebhook +
// logActivity), bukan sistem baru. Sengaja TIDAK bergantung ke isLoggedIn/
// firstLogin/state login sebelumnya — dipanggil murni berdasarkan EVENT
// "Quick Login berhasil", jadi Login → Logout → Quick Login tetap dapat
// notif baru, berkali-kali, sebanyak apapun user logout lalu Quick Login lagi.
//
// Anti-duplicate TETAP pakai notifDedup (lewat sendCategoryWebhook) dengan
// eventId yang SAMA persis dengan login OAuth biasa (`login:<discordId>`) —
// cooldown-nya cuma 8 detik, jadi:
//   - Quick Login dobel-klik / retry jaringan dalam <8 detik → tetap 1 notif.
//   - Quick Login SETELAH logout (jeda pasti >8 detik karena ada aksi user
//     logout + buka app lagi di antaranya) → dianggap event baru → notif baru.
// Tidak menyentuh setting channel/toggle Discord notification kategori
// 'login' yang sudah ada — kirim lewat helper yang sama persis.
app.post('/api/quick-login-notify', requireUser, async (req, res) => {
  try {
    const user = req.user;

    logActivity({
      type: 'login',
      username: user.username,
      discordId: user.discordId,
      role: user.role,
      status: 'success',
      ip: getReqIp(req),
      description: `${user.username} login (Quick Login).`
    }).catch(() => {});

    webhookManager.sendCategoryWebhook('login', {
      eventId: `login:${user.discordId}`,
      embed: buildEmbed({
        status: 'success',
        badge: 'user',
        title: 'Login Akun',
        description: `${user.username} berhasil login lewat Quick Login.`,
        username: user.username,
        role: user.role || 'public',
        userId: user.discordId,
        thumbnail: user.avatarUrl,
        appName: APP_NAME,
        footerNote: 'Login Akun'
      })
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) {
    // Best-effort — kegagalan notif TIDAK BOLEH menghambat/menggagalkan Quick Login.
    res.json({ success: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// EDIT PROFIL (App) — Foto Profil App, Display Name, Username, Bio.
// Data Discord (avatarUrl/username/discordId) TETAP hanya informasi, tidak
// pernah diubah dari sini (lihat profileManager.js untuk penjelasan lengkap).
// Setelah tersimpan, perubahan langsung didorong realtime:
//   - ke SEMUA device App user ini lewat WS 'account:update' (pola yang sama
//     seperti perubahan role/masa aktif, lihat handleAccountUpdate() di app.js)
//   - ke Admin Web lewat WS 'user:update' (pola yang sama seperti Set Role dkk,
//     lihat mergeUserUpdate() di admin.js) — jadi Dashboard, Daftar User, Detail
//     User di Admin Web ikut berubah tanpa refresh, karena semuanya sudah
//     merender dari field username/avatarUrl yang sama.
// ══════════════════════════════════════════════════════════════════════════
async function broadcastProfileChanged(freshUser) {
  await pushAccountUpdate(freshUser.discordId); // -> semua device App user ini
  try {
    const stats = await computeUserStats(freshUser.discordId);
    broadcastAdmin('user:update', publicUser(freshUser, stats)); // -> Admin Web
  } catch (e) {
    broadcastAdmin('user:update', publicUser(freshUser));
  }
}

app.get('/api/profile', requireUser, async (req, res) => {
  try {
    res.json(await profileManager.getProfile(req.user.discordId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/profile', requireUser, async (req, res) => {
  try {
    const { displayName, username, bio } = req.body || {};
    const patch = {};
    if (displayName !== undefined) patch.displayName = displayName;
    if (username !== undefined) patch.username = username;
    if (bio !== undefined) patch.bio = bio;

    const fresh = await profileManager.updateProfile(req.user.discordId, patch);

    logActivity({
      type: 'profile_update', username: fresh.username, discordId: fresh.discordId,
      description: 'Memperbarui profil (Display Name/Username/Bio).', status: 'success'
    }).catch(() => {});

    await broadcastProfileChanged(fresh);
    res.json(profileManager.toProfilePayload(fresh));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/profile/photo', requireUser, async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Gambar tidak ditemukan.' });

    const fresh = await profileManager.savePhoto(req.user.discordId, imageBase64);

    logActivity({
      type: 'profile_update', username: fresh.username, discordId: fresh.discordId,
      description: 'Mengganti foto profil App.', status: 'success'
    }).catch(() => {});

    await broadcastProfileChanged(fresh);
    res.json(profileManager.toProfilePayload(fresh));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stream foto profil App langsung dari MongoDB (bukan dari disk lokal — lihat
// catatan panjang di profileManager.js/savePhoto() soal kenapa ini yang jadi
// fix "foto profil hilang tiap deploy ulang / build ulang"). Publik & tanpa
// auth (dipakai sebagai <img src>/avatar di App & Admin Web, sama seperti file
// static /uploads/avatars yang lama juga publik), sengaja TIDAK pakai requireUser
// supaya avatar tetap tampil di tempat-tempat yang menampilkan user lain
// (leaderboard, daftar user Admin Web, dll), bukan cuma punya diri sendiri.
app.get('/api/profile/photo/:discordId', async (req, res) => {
  try {
    const photo = await profileManager.getPhotoRecord(req.params.discordId);
    if (!photo || !photo.data) return res.status(404).end();
    res.setHeader('Content-Type', photo.mime || 'image/png');
    // Cache lama boleh — URL selalu ikut query `?v=<timestamp>` yang berubah
    // tiap kali foto diganti (lihat savePhoto()), jadi cache-busting otomatis.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Driver Mongo bisa balikin field binary sebagai Buffer langsung ATAU
    // sebagai BSON Binary (punya `.buffer`) tergantung versi — Buffer.isBuffer
    // dicek dulu supaya TIDAK salah ambil `.buffer` dari instance Buffer itu
    // sendiri (itu bisa balikin underlying ArrayBuffer yang di-pool Node buat
    // buffer kecil, ukurannya beda dari buffer aslinya -> data foto bisa korup).
    const raw = photo.data;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer || raw);
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// WELCOME POPUP — popup selamat datang otomatis, tampil SEKALI per akun
// (lihat welcomePopupManager.js untuk penjelasan lengkap alur "1x per akun"
// & "paksa tampil kembali").
// ══════════════════════════════════════════════════════════════════════════

// Dipanggil App SEKALI tiap kali berhasil masuk (lihat enterApp() di app.js,
// pola yang sama seperti GET /api/gold-trial). Server yang menentukan
// tampil/tidaknya (bukan App), supaya tidak bisa diakalin lewat localStorage.
app.get('/api/welcome-popup', requireUser, async (req, res) => {
  try {
    const cfg = await welcomePopupManager.getConfig();
    const show = welcomePopupManager.shouldShow(cfg, req.user);
    res.json({ show, popup: show ? welcomePopupManager.toPublicPayload(cfg) : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ditekan user lewat tombol "Mulai Sekarang" ATAU "Jangan Tampilkan Lagi" —
// dua-duanya sama-sama menandai popup versi ini sudah dilihat, supaya tidak
// muncul lagi buat akun ini (sampai admin "paksa tampil kembali").
app.post('/api/welcome-popup/seen', requireUser, async (req, res) => {
  try {
    const cfg = await welcomePopupManager.getConfig();
    await db.collection('users').updateOne(
      { discordId: req.user.discordId },
      { $set: { welcomePopupSeenVersion: cfg.version, welcomePopupSeenAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/welcome-popup', requireAdmin, async (req, res) => {
  try {
    res.json(await welcomePopupManager.getConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/welcome-popup', requireAdmin, async (req, res) => {
  try {
    const next = await welcomePopupManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');
    // REALTIME (requirement #2/#3) — sinyal RINGAN ke semua App yang online,
    // pola SAMA PERSIS dengan 'app-customization:update' (lihat blok App
    // Customization di bawah): WS cuma bawa {changed, version}, BUKAN payload
    // penuh (bannerUrl bisa saja besar/berubah kapan saja), App yang menerima
    // sinyal ini tinggal fetch ulang GET /api/welcome-popup (existing, sudah
    // server-side gated oleh shouldShow()) — TIDAK ada WebSocket/event baru,
    // reuse wsBroadcastAll existing.
    wsBroadcastAll('welcome-popup:update', { changed: true, version: next.version });
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// "Paksa tampil kembali ke seluruh user" (opsional, dipakai admin kalau mau
// semua user — termasuk yang sudah pernah menutup popup — lihat versi baru
// popup ini lagi). Lihat welcomePopupManager.forceReshow().
app.post('/api/admin/welcome-popup/force-reshow', requireAdmin, async (req, res) => {
  try {
    const next = await welcomePopupManager.forceReshow(req.admin?.username || 'Admin');
    // Sama seperti PUT di atas — sinyal ringan lewat wsBroadcastAll existing,
    // App yang online langsung fetch ulang GET /api/welcome-popup tanpa perlu
    // restart/refresh/logout-login.
    wsBroadcastAll('welcome-popup:update', { changed: true, version: next.version });
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── TEST — kirim Welcome Popup (pakai konfigurasi yang SEDANG TERSIMPAN di
// DB, bukan draft form yang belum di-Save) ke SATU Discord User ID tertentu,
// untuk keperluan pengujian. Pola & jaminan SAMA PERSIS dengan Gold Trial
// TEST (POST /api/admin/gold-trial/test di atas, lihat komentarnya) —
// reuse notifyUser() existing (Socket.IO/`ws` existing, event 'notification'
// existing), TIDAK menyentuh welcomePopupManager sama sekali (TIDAK mengubah
// config/version/enabled global, TIDAK mengubah welcomePopupSeenVersion user
// manapun) — jadi status "Jangan Tampilkan Lagi" popup NORMAL akun ini tidak
// pernah ikut berubah oleh TEST ini, dan TEST tetap bisa dikirim berkali-kali
// ke akun manapun terlepas dari status dismiss-nya.
app.get('/api/admin/welcome-popup/lookup', requireAdmin, async (req, res) => {
  try {
    const discordId = String(req.query.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'not_found' });

    res.json({
      user: {
        discordId: user.discordId,
        username: user.username || user.discordId,
        avatarUrl: user.avatarUrl || null,
        role: user.role || 'public'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/welcome-popup/test', requireAdmin, async (req, res) => {
  try {
    const discordId = String(req.body?.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const cfg = await welcomePopupManager.getConfig();
    const popup = welcomePopupManager.toPublicPayload(cfg);

    // dm:false/webhook:false — TEST ini murni sinyal in-app realtime (App
    // yang sedang online langsung menerima lewat WS event 'notification'),
    // TIDAK mengirim DM/webhook Discord seperti notifikasi lain, sama pola
    // dengan Gold Trial TEST di atas.
    await notifyUser(discordId, {
      type: 'welcome_popup_test',
      title: popup.title,
      message: popup.description,
      meta: { ...popup, test: true },
      dm: false, webhook: false
    });

    logActivity({
      type: 'welcome_popup_test',
      admin: req.admin?.username || 'Admin',
      username: user.username, discordId,
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengirim TEST Welcome Popup ke ${user.username || discordId} (tidak mengubah config/status dismiss).`
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) {
    console.error('[Welcome Popup][TEST] Gagal:', e);
    res.status(500).json({ error: 'Terjadi kesalahan di server, coba lagi sebentar.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APP CUSTOMIZATION — Background & Branding App Desktop (lihat
// appCustomizationManager.js). Endpoint publik TIDAK butuh login (branding
// harus tampil bahkan di layar Login), endpoint admin butuh requireAdmin.
// Realtime ke App yang sedang online dikirim lewat wsBroadcastAll yang
// SUDAH ADA (event 'app-customization:update') — TIDAK ada WebSocket baru.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/app-customization', async (req, res) => {
  try {
    const cfg = await appCustomizationManager.getConfig();
    // "no-cache" BUKAN berarti tidak boleh di-cache sama sekali — artinya
    // browser WAJIB validasi ulang ke server tiap kali (lewat ETag, yang
    // sudah otomatis dihitung Express dari body response), tapi kalau
    // isinya belum berubah sejak terakhir diambil, server balas 304 kosong
    // (tanpa perlu kirim ulang background image/logo base64 yang berat) —
    // fix "halaman App Customization lambat" untuk kunjungan berulang
    // (admin bolak-balik tab) tanpa risiko menampilkan branding basi.
    res.set('Cache-Control', 'no-cache');
    res.json(appCustomizationManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/app-customization', requireAdmin, async (req, res) => {
  try {
    const cfg = await appCustomizationManager.getConfig();
    // fonts: daftar whitelist Font Style (lihat FONT_WHITELIST di
    // appCustomizationManager.js) — dikirim bareng config supaya Admin Web
    // TIDAK perlu duplikat daftar font-nya sendiri secara terpisah.
    res.set('Cache-Control', 'no-cache'); // sama alasannya dengan endpoint publik di atas
    res.json({ ...cfg, fonts: appCustomizationManager.FONT_WHITELIST });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/app-customization', requireAdmin, async (req, res) => {
  try {
    const next = await appCustomizationManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');

    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah App Customization (background: ${next.background.mode}, logo: ${next.branding.logo.enabled ? 'aktif' : 'nonaktif'}, teks: "${next.branding.text.value}").`,
      meta: { backgroundMode: next.background.mode, logoEnabled: next.branding.logo.enabled, brandText: next.branding.text.value }
    }).catch(() => {});

    // Realtime — App yang sedang online langsung menerima background/branding
    // terbaru TANPA restart/refresh (lihat appCustomizationManager.broadcastUpdate).
    const publicPayload = await appCustomizationManager.broadcastUpdate();

    res.json({ config: next, applied: publicPayload });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── LOGO BRANDING — endpoint PUBLIK yang "mengubah" logo App Customization
// jadi URL http(s) biasa yang bisa diakses siapa saja (termasuk Discord).
// Kenapa perlu: logo di Admin Web (App Customization > Branding Logo) HANYA
// bisa diisi lewat upload file (lihat aczLogoFile di admin.js), yang selalu
// tersimpan sebagai data URI base64 (`data:image/...;base64,...`) di
// database — BUKAN URL. Discord Embed (author.icon_url/footer.icon_url,
// dipakai buildCatalogEmbed di bawah untuk notif Add/Update Game/Bypass)
// HANYA menerima URL http(s) biasa, menolak data URI sama sekali. Endpoint
// ini TIDAK membuat sistem storage/upload baru — cuma men-decode data URI
// yang SUDAH tersimpan di dokumen App Customization (sumber data TETAP
// SATU-SATUNYA: appCustomizationManager) dan menyajikannya sebagai file
// gambar biasa, supaya logo branding yang sama bisa dipakai Discord tanpa
// admin perlu hosting logo di tempat lain.
// Publik (tanpa requireAdmin) — sama seperti GET /api/app-customization,
// karena Discord (dan App sebelum login) perlu mengaksesnya tanpa auth.
// Dibaca ULANG dari DB tiap request (tidak ada cache lama) supaya begitu
// admin ganti logo, request berikutnya ke endpoint ini langsung dapat logo
// terbaru — konsisten dengan prinsip realtime App Customization yang sudah
// ada (broadcastUpdate memberi sinyal, client fetch ulang config lengkap).
app.get('/api/app-customization/logo', async (req, res) => {
  try {
    const cfg = await appCustomizationManager.getConfig();
    const logo = cfg?.branding?.logo;
    if (!logo?.enabled || !logo?.url) return res.status(404).end();

    const raw = String(logo.url);
    const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(raw);
    if (!dataUriMatch) {
      // Bukan hasil upload (data URI) — berarti sudah URL http(s) biasa
      // (mis. diisi langsung lewat API oleh admin), tinggal diteruskan.
      if (/^https?:\/\//i.test(raw)) return res.redirect(302, raw);
      return res.status(404).end();
    }

    const mime = dataUriMatch[1].toLowerCase();
    const buffer = Buffer.from(dataUriMatch[2], 'base64');
    res.set('Content-Type', mime);
    // Cache pendek (5 menit): cukup supaya klien tidak fetch ulang terus-
    // menerus, tapi tetap singkat supaya logo baru yang diganti admin cepat
    // kepakai. (Catatan: endpoint ini sudah TIDAK dipakai lagi untuk
    // Author/Footer notifikasi Add/Update Game/Bypass — lihat
    // CATALOG_BRAND_ICON_URL di buildCatalogEmbed, sekarang pakai URL logo
    // tetap sesuai permintaan. Endpoint ini dibiarkan aktif sebagai akses
    // publik biasa ke logo App Customization, tidak mengganggu apapun.)
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buffer);
  } catch (e) {
    console.warn('[AppCustomization] Gagal menyajikan logo publik:', e.message);
    res.status(500).end();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD HERO BANNER — MULTI BANNER DINAMIS di halaman Dashboard APP
// (elemen `.dash-banner` carousel, lihat dashboardBannerManager.js), diatur
// penuh dari Admin Web ("Setting Banner") dan berubah REALTIME ke semua App
// yang sedang online, TANPA restart/reload.
//
// PENTING: ini KASUS BERBEDA dari sistem banner carousel multi-slide yang
// sudah ada (koleksi `banners`, endpoint /api/banners & /api/admin/banners
// di bawah file ini) — sistem carousel lama itu TIDAK diubah/dihapus sama
// sekali, dibiarkan idle di codebase, tidak dipakai Dashboard lagi setelah
// fitur ini aktif.
//
// Endpoint publik (APP) butuh login (requireUser, sama pola dengan
// /api/banners/​/api/app-customization) — banner ini cuma tampil di
// Dashboard setelah user login, dan HANYA mengembalikan banner yang
// `active` (poin permintaan: APP ambil SEMUA banner aktif). Endpoint admin
// di-guard requireAdmin, sama seperti endpoint admin lain di project ini.
// Realtime lewat wsBroadcastAll yang SUDAH ADA (event
// 'dashboard-banner:update') — TIDAK ada WebSocket baru sama sekali.
//
// Model save TETAP satu PUT = seluruh array banner (tambah/edit/hapus/ubah
// urutan/ubah status SEMUA jadi draft di Admin Web, dikirim sekali lewat
// body { banners: [...] }) — pola SAMA PERSIS dengan endpoint versi
// single-banner sebelumnya, cuma bentuk payload-nya sekarang array. Lihat
// dashboardBannerManager.updateConfig() untuk validasi per-item.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard-banner', requireUser, async (req, res) => {
  try {
    const cfg = await dashboardBannerManager.getConfig();
    res.json(dashboardBannerManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/dashboard-banner', requireAdmin, async (req, res) => {
  try {
    const cfg = await dashboardBannerManager.getConfig();
    // pageOptions: whitelist tujuan Halaman APP yang valid (lihat
    // PAGE_WHITELIST di dashboardBannerManager.js) — dikirim bareng config
    // supaya dropdown "Tujuan Tombol" di Admin Web SELALU sinkron dengan
    // halaman/nav yang benar-benar ada di APP (jangan hardcode string bebas
    // yang bisa typo). maxBanners dikirim juga supaya Admin Web bisa
    // menonaktifkan tombol "+ Tambah Banner" begitu batas tercapai, tanpa
    // hardcode angka terpisah di frontend.
    res.json({ ...cfg, pageOptions: dashboardBannerManager.PAGE_WHITELIST, maxBanners: dashboardBannerManager.MAX_BANNERS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/dashboard-banner', requireAdmin, async (req, res) => {
  try {
    const next = await dashboardBannerManager.updateConfig(req.body || {}, req.admin?.username || 'Admin');

    const titles = next.banners.map(b => `"${b.title}"${b.active ? '' : ' (nonaktif)'}`).join(', ') || '(kosong)';
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah Setting Banner Dashboard (${next.banners.length} banner: ${titles}).`,
      meta: { bannerCount: next.banners.length, banners: next.banners.map(b => ({ id: b.id, title: b.title, active: b.active, order: b.order })) }
    }).catch(() => {});

    // Realtime — App yang sedang online langsung menerima banner terbaru
    // TANPA restart/refresh (lihat dashboardBannerManager.broadcastUpdate).
    const publicPayload = await dashboardBannerManager.broadcastUpdate();

    res.json({ config: next, applied: publicPayload });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Endpoint polling cepat KHUSUS role check — jauh lebih ringan dari /api/me
// (tidak load semua field user, tidak perlu token refresh). Dipakai client setiap
// 3 detik untuk deteksi perubahan paket secara realtime. Kalau role sama, cukup
// return { changed: false } tanpa data tambahan supaya network overhead minimal.
app.get('/api/me/role-check', requireUser, (req, res) => {
  res.json({
    role:              req.user.role,
    roleUpdatedAt:     req.user.roleUpdatedAt || null
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
      // Catat ke Logs + realtime Dashboard/Logs Admin Web (logActivity otomatis
      // broadcastAdmin('activity', ...) — admin langsung lihat tanpa refresh),
      // SELAIN webhook Discord (opsional, default OFF) yang sudah ada di bawah.
      logActivity({
        type: 'device_login_rejected',
        username: req.user.username,
        discordId: req.user.discordId,
        role: req.user.role,
        status: 'warning',
        ip,
        description: `${req.user.username} mencoba login dari perangkat yang tidak terikat ke akunnya. ${result.reason || ''}`.trim(),
        meta: { pcName: deviceInfo.pcName || null, action: 'device_login_rejected' }
      }).catch(() => {});

      // Notif ke channel admin (opsional, default OFF) — best-effort, tidak pernah
      // menghambat proses tolak-login user.
      webhookManager.sendCategoryWebhook('device_security', {
        embed: buildEmbed({
          status: 'security',
          badge: 'security',
          title: 'Login Ditolak — Perangkat Berbeda',
          description: `**${req.user.username}** mencoba login dari perangkat yang TIDAK terikat ke akunnya.`,
          username: req.user.username,
          userId: req.user.discordId,
          fields: [
            field('🖥️ Nama PC (percobaan)', deviceInfo.pcName, true),
            field('🌐 IP', ip, true)
          ],
          appName: APP_NAME,
          footerNote: 'Keamanan Perangkat'
        })
      }).catch(() => {});
      return res.status(403).json({ error: result.reason, deviceLocked: true });
    }

    // Perangkat baru terdaftar pertama kali — kabari channel keamanan (opsional) +
    // catat ke Logs/Dashboard Admin Web secara realtime.
    if (result.status === 'registered') {
      logActivity({
        type: 'device_registered',
        username: req.user.username,
        discordId: req.user.discordId,
        role: req.user.role,
        status: 'success',
        ip,
        description: `Perangkat utama untuk ${req.user.username} berhasil didaftarkan (Device Lock).`,
        meta: { pcName: deviceInfo.pcName || null, action: 'device_registered' }
      }).catch(() => {});

      webhookManager.sendCategoryWebhook('device_security', {
        embed: buildEmbed({
          status: 'success',
          badge: 'security',
          title: 'Perangkat Baru Terdaftar',
          description: `Perangkat utama untuk **${req.user.username}** berhasil didaftarkan.`,
          username: req.user.username,
          userId: req.user.discordId,
          fields: [
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
// AUTOMATIC WATERMARK DETECTION — lihat watermarkManager.js. TIDAK mengubah
// endpoint download Game/Bypass yang sudah ada (/api/games/:id/download,
// /api/bypasses/:id/download-link); App memanggil endpoint INI SECARA
// TERPISAH tepat sebelum inject/install, lalu menuliskan `blob` yang
// dikembalikan ke file di folder Game (.lua/manifest)/folder Bypass.
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/watermark/issue', requireUser, async (req, res) => {
  try {
    const { productType, productId, deviceInfo } = req.body || {};
    const ip = getReqIp(req);
    const { downloadId, blob } = await watermarkManager.issueWatermark({
      user: req.user, productType, productId, deviceInfo: deviceInfo || {}, ip
    });
    res.json({ downloadId, blob });
  } catch (e) {
    // Best-effort: kalau watermark gagal dibuat, JANGAN sampai memblokir proses
    // download/inject yang sebenarnya (fitur ini murni tambahan/observability).
    console.warn('[Watermark] Gagal membuat watermark:', e.message);
    res.status(200).json({ downloadId: null, blob: null, error: e.message });
  }
});

// Dipanggil App tiap kali dijalankan (background, lihat app/app.js) — mengirim
// SEMUA blob watermark yang ditemukan launcher di folder Game/Bypass lokal
// (dari main.js `scan-watermarks`) sekaligus dalam satu batch.
app.post('/api/watermark/scan', requireUser, async (req, res) => {
  try {
    const { deviceInfo, items } = req.body || {};
    const result = await watermarkManager.processScanBatch({ user: req.user, deviceInfo: deviceInfo || {}, items: items || [] });
    res.json({ success: true, ...result });
  } catch (e) {
    console.warn('[Watermark] Gagal memproses scan:', e.message);
    res.status(200).json({ success: false, scanned: 0, alerts: 0 });
  }
});

// ── ADMIN — daftar & statistik alert "Watermark Terdeteksi di Perangkat Lain".
// Realtime lewat broadcastAdmin('watermark:alert', ...) di watermarkManager.js. ──
app.get('/api/admin/watermark-alerts', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const { items, total } = await watermarkManager.listAlerts({ limit, skip, discordId: req.query.discordId || undefined });
    res.json({ alerts: items, total });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat daftar watermark alert.' });
  }
});

app.get('/api/admin/watermark-alerts/stats', requireAdmin, async (req, res) => {
  try {
    res.json(await watermarkManager.getStats());
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat statistik watermark.' });
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
    await profileManager.enrichRows(recentActivity, 'discordId'); // tampilkan nama/foto profil App terbaru

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
// Server-side pagination: cuma `perPage` dokumen yang diambil dari MongoDB per
// request (bukan seluruh koleksi games) — tetap cepat walau datanya sampai
// ribuan. `counts` selalu dihitung dari SELURUH data games (tanpa filter apa
// pun), dipakai admin.js buat angka di stat pill & filter chip role — supaya
// angkanya tidak ikut berubah waktu admin lagi search/filter.
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  try {
    let { page = '1', perPage = '50', search = '', role = 'all', category = 'all' } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    perPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 50));

    const query = {};
    if (role !== 'all' && CATALOG_ROLES.includes(role)) query.role = role;
    if (category && category !== 'all') query.category = category;
    if (search && search.trim()) {
      query.name = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [rows, total, totalAll, totalPublic, totalGold, totalPlatinum, totalAdmin] = await Promise.all([
      db.collection('games').find(query).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).toArray(),
      db.collection('games').countDocuments(query),
      db.collection('games').countDocuments({}),
      db.collection('games').countDocuments({ role: 'public' }),
      db.collection('games').countDocuments({ role: 'gold' }),
      db.collection('games').countDocuments({ role: 'platinum' }),
      db.collection('games').countDocuments({ role: 'admin' }),
    ]);

    res.json({
      rows, total, page, perPage,
      counts: { total: totalAll, public: totalPublic, gold: totalGold, platinum: totalPlatinum, admin: totalAdmin }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ambil SATU game (dokumen lengkap) untuk form Edit — dibutuhkan khusus oleh
// drawer Marketplace Product > Kelola Konten, karena listContent() di
// marketplaceManager cuma mengembalikan field ringkas (_id/name/imageUrl/appId),
// sedangkan form Edit Game butuh semua field. Endpoint GET list
// (/api/admin/games) sebenarnya sudah balikin dokumen lengkap per-row, tapi
// tidak ada cara ambil satu by id secara langsung — daripada bikin round-trip
// listing yang lebih berat/kurang presisi (search by name bisa ambigu),
// endpoint kecil ini dipakai. Tidak menduplikasi logic apapun (query 1 baris).
app.get('/api/admin/games/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const game = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
    if (!game) return res.status(404).json({ error: 'Game tidak ditemukan.' });
    res.json(game);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/games', requireAdmin, async (req, res) => {
  const {
    name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline, category, provider,
    fullDescription, developer, publisher, releaseDate, genre, genres, categories, capsuleImageUrl, libraryImageUrl, heroImageUrl,
    // Diisi kalau form ini dibuka lewat tombol "Approve" di halaman Request Game
    // (lihat openItemModal() di admin.js) — SATU-SATUNYA jalur pembuatan game
    // tetap endpoint ini (tidak ada logic ganda), cuma ditambah linking+notif
    // ke request asalnya setelah game-nya berhasil dibuat.
    requestId,
    // Diisi kalau form ini dibuka dari Marketplace → Product → Kelola Konten
    // (lihat openItemModalForProduct() di admin.js). SATU-SATUNYA jalur
    // pembuatan game TETAP endpoint ini (tidak ada sistem Add Game baru) —
    // cuma ditambah linking ke Product dalam REQUEST YANG SAMA (atomic),
    // supaya tidak ada celah waktu di mana game ini "polos" (belum ke-gate
    // Marketplace, marketplaceProductIds masih kosong) dan bisa keakses lewat
    // role public sesaat sebelum link-nya kebentuk — root cause dari bug
    // "Marketplace Game malah dapat diakses karena package/role" kalau
    // linking dilakukan lewat request API terpisah setelah create.
    marketplaceProductId
  } = req.body;
  if (!name || !CATALOG_ROLES.includes(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  // Kategori WAJIB — setiap game minimal harus punya satu kategori supaya
  // filter kategori di Dashboard selalu punya data yang valid buat ditampilkan.
  const categorySlug = String(category || '').trim();
  if (!categorySlug) return res.status(400).json({ error: 'Kategori wajib dipilih.' });
  const categoryDoc = await db.collection('categories').findOne({ slug: categorySlug });
  if (!categoryDoc) return res.status(400).json({ error: 'Kategori tidak valid.' });

  // Validasi Product-nya ADA & belum dihapus SEBELUM insert game — jangan
  // sampai game sudah terbuat tapi ternyata productId-nya invalid (requirement
  // "Game dibuat tetapi tidak masuk ke Product" harus dicegah dari awal, bukan
  // ditambal setelah kejadian).
  let mktProduct = null;
  if (marketplaceProductId) {
    mktProduct = await marketplaceManager.getProductById(marketplaceProductId);
    if (!mktProduct) return res.status(400).json({ error: 'Marketplace Product tidak ditemukan.' });
  }

  // Kalau lewat Approve Request Game — validasi request-nya DULU sebelum bikin
  // game (jaga-jaga race condition: 2 admin approve request yang sama nyaris
  // bersamaan, atau request keburu di-reject/di-approve dari tab lain).
  let linkedRequest = null;
  if (requestId) {
    if (!ObjectId.isValid(requestId)) return res.status(400).json({ error: 'Request ID tidak valid.' });
    linkedRequest = await db.collection('gameRequests').findOne({ _id: new ObjectId(requestId) });
    if (!linkedRequest) return res.status(404).json({ error: 'Request Game tidak ditemukan.' });
    if (linkedRequest.status !== 'pending') {
      return res.status(400).json({ error: `Request ini sudah di-${linkedRequest.status === 'approved' ? 'approve' : 'reject'} sebelumnya (kemungkinan oleh admin lain).` });
    }
  }
  const doc = {
    name,
    description: description || '',
    // Data tambahan dari Steam Store API (Auto-Isi Deskripsi/Kategori & Search) — semua
    // opsional, tidak wajib diisi manual.
    fullDescription: fullDescription || null,
    developer: developer || null,
    publisher: publisher || null,
    releaseDate: releaseDate || null,
    genre: genre || null,
    // Maks 4 genre/kategori paling utama (dari genre asli Steam / hasil Auto-Isi)
    // buat ditampilkan sebagai tag di Dashboard App — opsional, kalau tidak dikirim
    // fallback ke array berisi 1 kategori utama saja.
    genres: Array.isArray(genres) ? genres.slice(0, 4) : [],
    categories: Array.isArray(categories) && categories.length ? categories.slice(0, 4) : [categorySlug],
    imageUrl: imageUrl || null,
    capsuleImageUrl: capsuleImageUrl || null,
    libraryImageUrl: libraryImageUrl || null,
    heroImageUrl: heroImageUrl || null,
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
    // Kalau dibuat dari Marketplace Product — langsung diisi SEKARANG (bukan
    // via update terpisah setelahnya), supaya sejak baris pertama game ini
    // ada di database, akses SUDAH digate oleh Product (lihat hasCatalogAccess:
    // marketplaceProductIds non-kosong -> role/paket diabaikan total).
    marketplaceProductIds: marketplaceProductId ? [String(marketplaceProductId)] : [],
    // Ownership permanen (beda dari marketplaceProductIds yang bisa berubah
    // kalau item ini nanti dihubungkan ke Product lain juga) — dipakai
    // marketplaceManager.deleteProduct() untuk memutuskan Game ini boleh
    // ikut terhapus saat Product-nya dihapus, atau tidak. HANYA diisi saat
    // create lewat drawer Kelola Konten Product ("+ Tambah Game Baru") —
    // Game yang dibuat normal (bukan dari Marketplace) selalu null di sini.
    ownerMarketplaceProductId: marketplaceProductId ? String(marketplaceProductId) : null,
    createdAt: new Date()
  };
  const result = await db.collection('games').insertOne(doc);

  // Catat relasi many-to-many di marketplaceContent (sumber kebenaran untuk
  // listing "Kelola Konten") — reuse TOTAL marketplaceManager.addContent()
  // yang sudah ada, cuma field marketplaceProductIds di atas sudah didahulukan
  // supaya tidak ada celah waktu tanpa proteksi (addContent akan set field
  // yang sama lagi via $addToSet — idempotent, bukan duplikat).
  if (marketplaceProductId) {
    try {
      await marketplaceManager.addContent(marketplaceProductId, 'game', result.insertedId);
      logActivity({
        type: 'marketplace_content_added',
        username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
        ip: getReqIp(req),
        description: `Admin menambahkan Game baru "${doc.name}" langsung ke produk Marketplace "${mktProduct.name}".`,
        meta: { productId: String(marketplaceProductId), productName: mktProduct.name, contentType: 'game', itemId: String(result.insertedId) }
      }).catch(() => {});
    } catch (e) {
      // Game-nya SUDAH terbuat & SUDAH ter-gate lewat marketplaceProductIds di
      // atas (aman dari sisi akses) — kalau cuma pencatatan relasi
      // marketplaceContent yang gagal (mis. DB hiccup), jangan gagalkan
      // seluruh request; admin masih bisa lihat game ini lewat halaman Game
      // biasa dan link manual lewat "Hubungkan Existing" kalau perlu.
      console.error('[Marketplace] Gagal mencatat relasi marketplaceContent untuk game baru:', e.message);
    }
  }

  logActivity({
    type: 'admin_add_game',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin menambahkan game baru "${doc.name}".`,
    meta: { gameId: result.insertedId, name: doc.name }
  }).catch(() => {});

  // Notifikasi Discord (kategori "Game Baru") — desain compact baru (lihat
  // buildCatalogEmbed), banner otomatis dari data game, link download selalu
  // diambil LIVE dari Admin Web > App Update (bukan hardcode). Best-effort,
  // fire-and-forget — tidak pernah membuat proses tambah game gagal.
  (async () => {
    try {
      // appCfg (baca settings) & banner (bisa live-check ke Steam CDN) tidak
      // saling bergantung -> dijalankan paralel (fix delay), bukan berurutan.
      const [appCfg, banner] = await Promise.all([appUpdateManager.getConfig(), pickCatalogBanner(doc)]);
      await webhookManager.sendCategoryWebhook('game_new', {
        eventId: String(result.insertedId),
        embed: await buildCatalogEmbed({
          kind: 'game', isNew: true,
          name: doc.name, appId: doc.appId, publisher: doc.publisher,
          banner,
          downloadUrl: appCfg.downloadUrl || appCfg.releaseUrl || null
        }),
        plainEmbed: true
      });
    } catch (e) {
      // Fix "beberapa notifikasi tidak masuk tanpa jejak": sebelumnya error di
      // sini (mis. DB hiccup saat baca App Update config) ditelan diam-diam
      // tanpa log sama sekali, jadi tidak ada cara tahu kenapa notif Game
      // Baru tidak terkirim. Tetap best-effort (tidak melempar ulang / tidak
      // menggagalkan proses tambah game), cuma sekarang tercatat di log.
      console.error(`[Notif] Gagal kirim notifikasi Game Baru "${doc.name}":`, e.message);
    }
  })();

  // Kalau ini approval dari Request Game — tandai request-nya 'approved',
  // simpan link ke game yang baru dibuat, notif user, broadcast realtime.
  // Best-effort (jangan sampai gagalnya bagian ini bikin pembuatan game gagal).
  if (linkedRequest) {
    try {
      const decideUpdate = {
        status: 'approved', decidedAt: new Date(), decidedBy: req.admin?.username || 'Admin',
        createdGameId: result.insertedId
      };
      await db.collection('gameRequests').updateOne({ _id: linkedRequest._id }, { $set: decideUpdate });
      const updatedRequest = { ...linkedRequest, ...decideUpdate };

      logActivity({
        type: 'request_game_approved',
        username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
        ip: getReqIp(req),
        description: `Admin meng-approve Request Game "${doc.name}" dari ${linkedRequest.username} — game ditambahkan ke katalog.`,
        meta: { requestId: String(linkedRequest._id), gameId: result.insertedId, appId: doc.appId }
      }).catch(() => {});

      notifyUser(linkedRequest.discordId, {
        type: 'game_request_approved',
        title: 'Request Game Disetujui!',
        message: `Request kamu untuk **${doc.name}** disetujui dan sekarang sudah tersedia di aplikasi — langsung cek halaman Games!`,
        fields: [
          field('🎮 Nama Game', doc.name, true),
          field('🆔 App ID', doc.appId, true),
          field('📦 Role Minimum', String(doc.role || '').toUpperCase(), true)
        ],
        thumbnail: doc.capsuleImageUrl || doc.imageUrl || undefined,
        dm: true, webhook: true
      }).catch(() => {});

      broadcastAdmin('gameRequest:decided', publicGameRequest(updatedRequest));
      wsSendToUser(linkedRequest.discordId, 'gameRequest:update', publicGameRequest(updatedRequest));
    } catch (e) {
      console.warn('[Request Game] Gagal link approval ke request:', e.message);
    }
  }

  res.json({ ...doc, _id: result.insertedId });
  broadcastGamesUpdate();
  // Realtime ke Admin Web (daftar konten Product di drawer Kelola Konten) &
  // APP (badge/status Product bisa berubah) — TANPA refresh manual, sama
  // seperti requirement realtime untuk Add/Edit/Delete Product.
  if (marketplaceProductId) broadcastMarketplaceProductsUpdate().catch(() => {});
});

app.put('/api/admin/games/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const {
    name, description, imageUrl, role, appId, storeUrl, manifestUrl, sizeBytes, sizeLabel, isOnline, category, provider,
    fullDescription, developer, publisher, releaseDate, genre, genres, categories, capsuleImageUrl, libraryImageUrl, heroImageUrl
  } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (fullDescription !== undefined) update.fullDescription = fullDescription || null;
  if (developer !== undefined) update.developer = developer || null;
  if (publisher !== undefined) update.publisher = publisher || null;
  if (releaseDate !== undefined) update.releaseDate = releaseDate || null;
  if (genre !== undefined) update.genre = genre || null;
  if (genres !== undefined) update.genres = Array.isArray(genres) ? genres.slice(0, 4) : [];
  if (categories !== undefined) update.categories = Array.isArray(categories) ? categories.slice(0, 4) : [];
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (capsuleImageUrl !== undefined) update.capsuleImageUrl = capsuleImageUrl || null;
  if (libraryImageUrl !== undefined) update.libraryImageUrl = libraryImageUrl || null;
  if (heroImageUrl !== undefined) update.heroImageUrl = heroImageUrl || null;
  if (appId !== undefined) update.appId = appId ? String(appId) : null;
  if (storeUrl !== undefined) update.storeUrl = storeUrl || null;
  if (manifestUrl !== undefined) update.manifestUrl = manifestUrl || null;
  if (provider !== undefined) update.provider = (provider === 'ryu' || provider === 'hubcap') ? provider : null;
  if (sizeBytes !== undefined) update.sizeBytes = sizeBytes || null;
  if (sizeLabel !== undefined) update.sizeLabel = sizeLabel || null;
  if (isOnline !== undefined) update.isOnline = isOnline === false ? false : true;
  if (role !== undefined) {
    if (!CATALOG_ROLES.includes(role)) return res.status(400).json({ error: 'Role tidak valid.' });
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

  // Notifikasi Discord (kategori "Update Game", opsional/default nonaktif) —
  // desain SAMA persis dengan Game Baru (lihat buildCatalogEmbed), cuma
  // header & warna beda dikit biar kebedakan dari Add. Ambil dokumen FINAL
  // (setelah update) supaya data yang dikirim selalu akurat, bukan cuma
  // field yang diubah di request ini. Best-effort, tidak pernah mem-block
  // response ke admin.
  (async () => {
    try {
      const finalDoc = await db.collection('games').findOne({ _id: new ObjectId(req.params.id) });
      if (!finalDoc) return;
      // appCfg & banner tidak saling bergantung -> paralel (fix delay).
      const [appCfg, banner] = await Promise.all([appUpdateManager.getConfig(), pickCatalogBanner(finalDoc)]);
      await webhookManager.sendCategoryWebhook('game_edit', {
        eventId: `${req.params.id}:${Date.now()}`,
        embed: await buildCatalogEmbed({
          kind: 'game', isNew: false,
          name: finalDoc.name, appId: finalDoc.appId, publisher: finalDoc.publisher,
          banner,
          downloadUrl: appCfg.downloadUrl || appCfg.releaseUrl || null
        }),
        plainEmbed: true
      });
    } catch (e) {
      // Sebelumnya ditelan diam-diam tanpa log (lihat catatan sama di notif
      // Game Baru di atas) — sekarang tercatat, tetap best-effort.
      console.error(`[Notif] Gagal kirim notifikasi Update Game "${req.params.id}":`, e.message);
    }
  })();

  res.json({ success: true });
  broadcastGamesUpdate();
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
  broadcastGamesUpdate();
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
  const doc = { name, slug, order: count, isActive: true, createdAt: new Date() };
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

  broadcastCategoriesUpdate();
  res.json({ ...doc, _id: result.insertedId });
});

// Ubah nama kategori dan/atau status Active/Inactive. Nama diubah -> slug ikut
// dihitung ulang (dicek dulu belum dipakai kategori lain, biar tetap unik).
app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const category = await db.collection('categories').findOne({ _id: new ObjectId(req.params.id) });
  if (!category) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });

  const { name, isActive } = req.body;
  const update = {};

  if (name !== undefined) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return res.status(400).json({ error: 'Nama kategori wajib diisi.' });
    const newSlug = slugify(trimmedName);
    if (!newSlug) return res.status(400).json({ error: 'Nama kategori tidak valid.' });
    if (newSlug !== category.slug) {
      const clash = await db.collection('categories').findOne({ slug: newSlug, _id: { $ne: category._id } });
      if (clash) return res.status(400).json({ error: 'Kategori dengan nama tersebut sudah ada.' });
    }
    update.name = trimmedName;
    update.slug = newSlug;
  }
  if (isActive !== undefined) update.isActive = isActive === false ? false : true;

  if (Object.keys(update).length) {
    await db.collection('categories').updateOne({ _id: category._id }, { $set: update });
    // Kalau slug berubah, semua game yang pakai kategori ini ikut dimigrasikan
    // supaya tidak ada game yang "kehilangan" kategorinya gara-gara rename.
    if (update.slug && update.slug !== category.slug) {
      await db.collection('games').updateMany({ category: category.slug }, { $set: { category: update.slug } });
      await db.collection('games').updateMany({ categories: category.slug }, { $set: { 'categories.$[el]': update.slug } }, { arrayFilters: [{ el: category.slug }] });
    }
  }

  logActivity({
    type: 'admin_edit_category',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah kategori "${category.name}"${update.name ? ` menjadi "${update.name}"` : ''}${isActive !== undefined ? (isActive ? ' (Aktifkan)' : ' (Nonaktifkan)') : ''}.`,
    meta: { categoryId: req.params.id, update }
  }).catch(() => {});

  broadcastCategoriesUpdate();
  if (update.slug) { broadcastGamesUpdate(); }
  res.json({ success: true, ...update });
});

// Ubah urutan tampil kategori di App (drag & drop / tombol naik-turun di Admin Web).
app.put('/api/admin/categories/reorder', requireAdmin, async (req, res) => {
  const { order } = req.body; // array of category _id, urutan baru
  if (!Array.isArray(order)) return res.status(400).json({ error: '`order` harus array of id.' });
  const invalid = order.find(id => !ObjectId.isValid(id));
  if (invalid) return res.status(400).json({ error: 'Ada ID kategori yang tidak valid.' });

  await Promise.all(order.map((id, idx) =>
    db.collection('categories').updateOne({ _id: new ObjectId(id) }, { $set: { order: idx } })
  ));

  logActivity({
    type: 'admin_reorder_category',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin mengubah urutan kategori.`,
    meta: { order }
  }).catch(() => {});

  broadcastCategoriesUpdate();
  res.json({ success: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const category = await db.collection('categories').findOne({ _id: new ObjectId(req.params.id) });
  if (!category) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });

  // Jangan izinkan hapus kategori yang masih dipakai game (baik field `category`
  // tunggal lama maupun array `categories` baru) — supaya tidak ada game yang
  // "kehilangan" kategorinya begitu saja.
  const inUse = await db.collection('games').countDocuments({
    $or: [{ category: category.slug }, { categories: category.slug }]
  });
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

  broadcastCategoriesUpdate();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — BYPASS (CRUD) — polanya sama persis kayak Game
// ══════════════════════════════════════════════════════════════════════════
// Server-side pagination — sama persis pola-nya dengan /api/admin/games di
// atas (bypasses tidak punya field kategori, jadi tidak ada filter category).
app.get('/api/admin/bypasses', requireAdmin, async (req, res) => {
  try {
    let { page = '1', perPage = '50', search = '', role = 'all' } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    perPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 50));

    const query = {};
    if (role !== 'all' && CATALOG_ROLES.includes(role)) query.role = role;
    if (search && search.trim()) {
      query.name = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [rows, total, totalAll, totalPublic, totalGold, totalPlatinum, totalAdmin] = await Promise.all([
      db.collection('bypasses').find(query).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).toArray(),
      db.collection('bypasses').countDocuments(query),
      db.collection('bypasses').countDocuments({}),
      db.collection('bypasses').countDocuments({ role: 'public' }),
      db.collection('bypasses').countDocuments({ role: 'gold' }),
      db.collection('bypasses').countDocuments({ role: 'platinum' }),
      db.collection('bypasses').countDocuments({ role: 'admin' }),
    ]);

    res.json({
      rows, total, page, perPage,
      counts: { total: totalAll, public: totalPublic, gold: totalGold, platinum: totalPlatinum, admin: totalAdmin }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sama seperti GET /api/admin/games/:id di atas, tapi untuk Bypass — dipakai
// tombol Edit pada drawer Marketplace Product > Kelola Konten.
app.get('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const bypass = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
    if (!bypass) return res.status(404).json({ error: 'Bypass tidak ditemukan.' });
    res.json(bypass);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/bypasses', requireAdmin, async (req, res) => {
  const {
    name, description, imageUrl, role, link, zipUrl, appId, gameId, isOnline,
    fullDescription, developer, publisher, releaseDate, genre, capsuleImageUrl, libraryImageUrl, heroImageUrl,
    // Sama persis konsepnya dengan POST /api/admin/games — lihat komentar di
    // sana untuk penjelasan lengkap kenapa linking dilakukan atomic di sini.
    marketplaceProductId
  } = req.body;
  if (!name || !CATALOG_ROLES.includes(role)) return res.status(400).json({ error: 'Nama & role wajib diisi dengan benar.' });
  let mktProduct = null;
  if (marketplaceProductId) {
    mktProduct = await marketplaceManager.getProductById(marketplaceProductId);
    if (!mktProduct) return res.status(400).json({ error: 'Marketplace Product tidak ditemukan.' });
  }
  const doc = {
    name,
    description: description || '',
    // Data tambahan dari Steam Store API (Auto-Isi Deskripsi/Kategori & Search) — opsional.
    fullDescription: fullDescription || null,
    developer: developer || null,
    publisher: publisher || null,
    releaseDate: releaseDate || null,
    genre: genre || null,
    imageUrl: imageUrl || null,
    capsuleImageUrl: capsuleImageUrl || null,
    libraryImageUrl: libraryImageUrl || null,
    heroImageUrl: heroImageUrl || null,
    role,
    link:   link   || null, // legacy field — link manual dari admin
    zipUrl: zipUrl || link || null, // URL ZIP bypass (bisa GitHub dll) — di-proxy server, tidak pernah ke client
    appId:  appId  || null, // Steam App ID — menentukan folder extract tujuan di PC user
    gameId: (gameId && ObjectId.isValid(gameId)) ? gameId : null,
    // Tipe bypass: Online (bypass buat game yang punya mode online multiplayer) / Offline.
    // Default TRUE kalau tidak eksplisit di-set false.
    isOnline: isOnline === false ? false : true,
    marketplaceProductIds: marketplaceProductId ? [String(marketplaceProductId)] : [],
    // Sama seperti games — lihat komentar ownerMarketplaceProductId di
    // POST /api/admin/games untuk penjelasan lengkap.
    ownerMarketplaceProductId: marketplaceProductId ? String(marketplaceProductId) : null,
    createdAt: new Date()
  };
  const result = await db.collection('bypasses').insertOne(doc);

  if (marketplaceProductId) {
    try {
      await marketplaceManager.addContent(marketplaceProductId, 'bypass', result.insertedId);
      logActivity({
        type: 'marketplace_content_added',
        username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'success',
        ip: getReqIp(req),
        description: `Admin menambahkan Bypass baru "${doc.name}" langsung ke produk Marketplace "${mktProduct.name}".`,
        meta: { productId: String(marketplaceProductId), productName: mktProduct.name, contentType: 'bypass', itemId: String(result.insertedId) }
      }).catch(() => {});
    } catch (e) {
      console.error('[Marketplace] Gagal mencatat relasi marketplaceContent untuk bypass baru:', e.message);
    }
  }

  logActivity({
    type: 'admin_add_bypass',
    username: req.admin?.username || 'Admin',
    admin: req.admin?.username || 'Admin',
    status: 'success',
    ip: getReqIp(req),
    description: `Admin menambahkan bypass baru "${doc.name}".`,
    meta: { bypassId: result.insertedId, name: doc.name }
  }).catch(() => {});

  // Notifikasi Discord (kategori "Bypass Baru") — desain compact baru (lihat
  // buildCatalogEmbed), sama persis strukturnya dengan Game Baru. Best-effort,
  // fire-and-forget — tidak pernah membuat proses tambah bypass gagal.
  (async () => {
    try {
      const [appCfg, banner] = await Promise.all([appUpdateManager.getConfig(), pickCatalogBanner(doc)]);
      await webhookManager.sendCategoryWebhook('bypass_new', {
        eventId: String(result.insertedId),
        embed: await buildCatalogEmbed({
          kind: 'bypass', isNew: true,
          name: doc.name, appId: doc.appId, publisher: doc.publisher,
          banner,
          downloadUrl: appCfg.downloadUrl || appCfg.releaseUrl || null
        }),
        plainEmbed: true
      });
    } catch (e) {
      console.error(`[Notif] Gagal kirim notifikasi Bypass Baru "${doc.name}":`, e.message);
    }
  })();

  res.json({ ...doc, _id: result.insertedId });
  broadcastBypassesUpdate();
  if (marketplaceProductId) broadcastMarketplaceProductsUpdate().catch(() => {});
});

app.put('/api/admin/bypasses/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
  const {
    name, description, imageUrl, role, link, zipUrl, appId, isOnline,
    fullDescription, developer, publisher, releaseDate, genre, capsuleImageUrl, libraryImageUrl, heroImageUrl
  } = req.body;
  const update = {};
  if (name        !== undefined) update.name        = name;
  if (description !== undefined) update.description = description;
  if (fullDescription !== undefined) update.fullDescription = fullDescription || null;
  if (developer   !== undefined) update.developer   = developer || null;
  if (publisher   !== undefined) update.publisher   = publisher || null;
  if (releaseDate !== undefined) update.releaseDate = releaseDate || null;
  if (genre       !== undefined) update.genre       = genre || null;
  if (imageUrl    !== undefined) update.imageUrl    = imageUrl;
  if (capsuleImageUrl !== undefined) update.capsuleImageUrl = capsuleImageUrl || null;
  if (libraryImageUrl !== undefined) update.libraryImageUrl = libraryImageUrl || null;
  if (heroImageUrl    !== undefined) update.heroImageUrl    = heroImageUrl || null;
  if (link        !== undefined) update.link        = link   || null;
  if (zipUrl      !== undefined) update.zipUrl      = zipUrl || link || null;
  if (appId       !== undefined) update.appId       = appId  || null;
  if (isOnline    !== undefined) update.isOnline    = isOnline === false ? false : true;
  if (role !== undefined) {
    if (!CATALOG_ROLES.includes(role)) return res.status(400).json({ error: 'Role tidak valid.' });
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

  // Notifikasi Discord (kategori "Update Bypass", opsional/default nonaktif) —
  // desain SAMA persis dengan Bypass Baru (lihat buildCatalogEmbed). Ambil
  // dokumen FINAL setelah update supaya data yang dikirim selalu akurat.
  // Best-effort, tidak pernah mem-block response ke admin.
  (async () => {
    try {
      const finalDoc = await db.collection('bypasses').findOne({ _id: new ObjectId(req.params.id) });
      if (!finalDoc) return;
      const [appCfg, banner] = await Promise.all([appUpdateManager.getConfig(), pickCatalogBanner(finalDoc)]);
      await webhookManager.sendCategoryWebhook('bypass_edit', {
        eventId: `${req.params.id}:${Date.now()}`,
        embed: await buildCatalogEmbed({
          kind: 'bypass', isNew: false,
          name: finalDoc.name, appId: finalDoc.appId, publisher: finalDoc.publisher,
          banner,
          downloadUrl: appCfg.downloadUrl || appCfg.releaseUrl || null
        }),
        plainEmbed: true
      });
    } catch (e) {
      console.error(`[Notif] Gagal kirim notifikasi Update Bypass "${req.params.id}":`, e.message);
    }
  })();

  res.json({ success: true });
  broadcastBypassesUpdate();
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
  broadcastBypassesUpdate();
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

// ══════════════════════════════════════════════════════════════════════════
// AUTO-KATEGORI DARI GENRE STEAM — dipakai fitur "Auto-Isi Deskripsi/Kategori".
// Untuk tiap genre yang dibalikin Steam Store API (mis. "Action", "RPG",
// "Sports"): kalau kategori dengan nama yang sama (case-insensitive) SUDAH ADA
// di koleksi `categories`, langsung dipakai ulang. Kalau BELUM ADA sama sekali,
// kategori baru OTOMATIS DIBUAT (bukan cuma disarankan) supaya genre Steam yang
// belum terdaftar langsung tersedia tanpa admin perlu bikin manual dulu.
// Dedup case-insensitive dijamin lewat `slugify()` (selalu lowercase) + unique
// index di `categories.slug` (lihat connectDB) — jadi genre yang beda kapitalisasi
// tapi slug-nya sama TIDAK PERNAH bikin kategori dobel.
// ══════════════════════════════════════════════════════════════════════════
async function resolveCategorySlugsForGenres(genreNames) {
  const slugs = [];
  if (!db || !Array.isArray(genreNames) || !genreNames.length) return slugs;
  try {
    // Diambil sekali di awal, lalu di-push manual tiap kali ada kategori baru
    // dibuat dalam loop ini — supaya genre berikutnya di appId yang sama bisa
    // langsung nemu match tanpa round-trip DB tambahan.
    const adminCategories = await db.collection('categories').find({}).toArray();

    for (const genreRaw of genreNames) {
      const g = String(genreRaw || '').trim();
      if (!g) continue;
      const gLower = g.toLowerCase();

      // 1) Exact match (case-insensitive) — paling akurat, diprioritaskan.
      let match = adminCategories.find(cat => (cat.name || '').toLowerCase() === gLower);
      // 2) Fallback: substring dua arah (mis. genre "Action" cocok kategori
      //    admin "Action-Adventure" atau sebaliknya) — best-effort seperti sebelumnya.
      if (!match) {
        match = adminCategories.find(cat => {
          const c = (cat.name || '').toLowerCase();
          return c && (gLower.includes(c) || c.includes(gLower));
        });
      }

      if (match) {
        if (!slugs.includes(match.slug)) slugs.push(match.slug);
        continue;
      }

      // Tidak ada kategori admin yang cocok sama sekali -> buat baru otomatis.
      const slug = slugify(g);
      if (!slug || slugs.includes(slug)) continue;

      try {
        const count = await db.collection('categories').countDocuments({});
        const doc = { name: g, slug, order: count, isActive: true, createdAt: new Date(), source: 'steam-auto' };
        await db.collection('categories').insertOne(doc);
        adminCategories.push(doc); // biar genre lain di loop yang sama langsung ketemu match exact
        slugs.push(slug);
        console.log(`✅ Kategori baru otomatis dibuat dari genre Steam: "${g}" (slug: ${slug})`);
        broadcastCategoriesUpdate().catch(() => {}); // kategori baru langsung nongol realtime di App (kalau Active)
      } catch (e) {
        if (e?.code === 11000) {
          // Duplicate key -> kategori dengan slug sama barusan dibuat proses lain
          // (race condition, mis. auto-fill massal + tambah game manual bareng).
          // Bukan error fatal, tinggal pakai yang sudah ada.
          const existing = await db.collection('categories').findOne({ slug });
          if (existing && !slugs.includes(existing.slug)) slugs.push(existing.slug);
        } else {
          console.warn('[Auto-Kategori] Gagal membuat kategori baru dari genre Steam:', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[Auto-Kategori] Gagal mencocokkan/membuat kategori dari genre Steam:', e.message);
  }
  return slugs;
}

async function seedDefaultCategoriesIfEmpty() {
  if (!db) return;
  const existing = await db.collection('categories').countDocuments({});
  if (existing > 0) return; // sudah pernah ada isinya — jangan timpa

  const defaults = ['Action', 'Sport', 'Puzzle', 'Mystery'];
  await db.collection('categories').insertMany(
    defaults.map((name, i) => ({ name, slug: slugify(name), order: i, isActive: true, createdAt: new Date() }))
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
    await profileManager.enrichRows(rows, 'userId'); // tampilkan nama/foto profil App terbaru

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
    await profileManager.enrichRows(rows, 'discordId'); // tampilkan nama/foto profil App terbaru

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

// PERF FIX: endpoint ini SEBELUMNYA `.find(query).toArray()` tanpa pagination
// sama sekali — setiap kali halaman Users dibuka, backend mengirim SELURUH
// koleksi `users` ke browser (persis anti-pattern "kirim 10.000 baris lalu
// pagination di frontend"), lalu ikut menjalankan agregasi `history` di atas
// SEMUA histori juga tanpa cache. Sekarang: pagination/search/filter role &
// status dijalankan di MongoDB (skip/limit + index role/status/createdAt di
// atas), jadi payload & waktu respons tidak lagi tumbuh linear sama jumlah
// user. `counts`/`statusCounts` tetap dihitung dari SELURUH data (tidak
// kepengaruh filter aktif) via aggregation ringan, dipakai buat stat pill &
// filter chip di frontend — behavior tampilan sama persis seperti sebelumnya.
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    let { page = '1', perPage = '24', search = '', role = 'all', status = 'all' } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    perPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 24));

    const andConds = [];
    if (role !== 'all') andConds.push({ role });
    if (status !== 'all') {
      andConds.push(status === 'active'
        ? { $or: [{ status: 'active' }, { status: { $exists: false } }, { status: null }] }
        : { status });
    }
    if (search && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      andConds.push({ $or: [{ username: re }, { discordId: re }, { role: re }] });
    }
    const query = andConds.length ? { $and: andConds } : {};

    const [rows, total, roleAgg, statusAgg] = await Promise.all([
      db.collection('users').find(query).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).toArray(),
      db.collection('users').countDocuments(query),
      db.collection('users').aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
      db.collection('users').aggregate([{ $group: { _id: { $ifNull: ['$status', 'active'] }, count: { $sum: 1 } } }]).toArray(),
    ]);

    // Total download (Game) & install (Bypass) HANYA untuk user di halaman ini
    // (bukan seluruh koleksi history) — sebelumnya aggregate history dijalankan
    // penuh di setiap request Users padahal cuma dipakai buat <= perPage user.
    const pageDiscordIds = rows.map(u => u.discordId).filter(Boolean);
    const statsAgg = pageDiscordIds.length ? await db.collection('history').aggregate([
      { $match: { userId: { $in: pageDiscordIds } } },
      { $group: { _id: { userId: '$userId', itemType: '$itemType' }, count: { $sum: 1 } } }
    ]).toArray() : [];
    const statsMap = {};
    for (const s of statsAgg) {
      const uid = s._id.userId;
      if (!statsMap[uid]) statsMap[uid] = { downloads: 0, installs: 0, total: 0 };
      if (s._id.itemType === 'game') statsMap[uid].downloads += s.count;
      else if (s._id.itemType === 'bypass') statsMap[uid].installs += s.count;
      statsMap[uid].total += s.count;
    }

    const counts = { total: 0, public: 0, gold: 0, platinum: 0, admin: 0 };
    for (const r of roleAgg) { counts.total += r.count; if (r._id != null) counts[r._id] = (counts[r._id] || 0) + r.count; }
    const statusCounts = { all: counts.total, active: 0, suspended: 0, banned: 0 };
    for (const s of statusAgg) { if (s._id && statusCounts.hasOwnProperty(s._id)) statusCounts[s._id] = s.count; }

    res.json({
      rows: rows.map(u => publicUser(u, statsMap[u.discordId])),
      total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)),
      counts, statusCounts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cari SATU user by Discord ID / username — dipakai modal "Set Paket via Discord
// ID" (sebelumnya modal ini fetch SELURUH koleksi users cuma buat cari 1 baris).
app.get('/api/admin/users/lookup', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query kosong.' });
    const re = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const user = await db.collection('users').findOne({ $or: [{ discordId: q }, { username: re }] });
    if (!user) return res.status(404).json({ error: 'not_found' });
    const stats = await db.collection('history').aggregate([
      { $match: { userId: user.discordId } },
      { $group: { _id: '$itemType', count: { $sum: 1 } } }
    ]).toArray();
    const s = { downloads: 0, installs: 0, total: 0 };
    for (const row of stats) { if (row._id === 'game') s.downloads += row.count; else if (row._id === 'bypass') s.installs += row.count; s.total += row.count; }
    res.json(publicUser(user, s));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
async function sendDiscordDM(userId, contentOrPayload, options = {}) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const eventLabel = options.eventLabel || options.eventId || '-';
  const logDM = (status, extra = {}) => {
    console.log(`[Notif][DM] event=${eventLabel} eventId=${options.eventId || '-'} userId=${userId} status=${status} at=${new Date().toISOString()}${extra.reason ? ` reason=${extra.reason}` : ''}${extra.error ? ` error="${extra.error}"` : ''}`);
  };
  if (!BOT_TOKEN) {
    console.warn('[DM] DISCORD_BOT_TOKEN tidak diset, DM tidak terkirim ke', userId);
    logDM('FAILED', { reason: 'no_bot_token' });
    return { success: false, reason: 'no_bot_token' };
  }
  if (!userId) return { success: false, reason: 'no_user_id' };

  // ── ANTI-SPAM ── satu event = satu DM. Dedup berdasarkan Event ID (kalau
  // pemanggil kasih lewat options.eventId) + hash konten pesan, dengan
  // cooldown singkat per user — supaya user tidak dapat DM berulang untuk
  // event yang sama / datanya belum berubah.
  //
  // PENTING: yang di-hash HANYA bagian STABIL dari embed (title/description/
  // fields) — BUKAN seluruh `contentOrPayload` mentah. Embed selalu punya
  // `timestamp` presisi milidetik (lihat notifTemplates.buildEmbed) yang
  // beda setiap kali dipanggil, jadi kalau ikut di-hash, hash-nya PASTI selalu
  // beda walau event & isinya sama persis — dedup jadi tidak pernah berhasil
  // mendeteksi duplikat sama sekali (bug sebelumnya: DM dobel tidak pernah
  // ketangkep). Dengan hanya title/description/fields yang stabil, event yang
  // BENAR-BENAR sama (isi identik) baru akan di-dedup, sementara event BEDA
  // (isi/fields beda walau waktunya berdekatan) tetap lolos terkirim.
  const dedupContent = typeof contentOrPayload === 'string'
    ? contentOrPayload
    : {
        embeds: (contentOrPayload.embeds || []).map(e => ({ title: e.title, description: e.description, fields: e.fields })),
        content: contentOrPayload.content || undefined
      };
  const dedupCheck = notifDedup.shouldSend({
    key: `dm:${userId}`,
    eventId: options.eventId,
    content: dedupContent
  });
  if (!dedupCheck.send) {
    logDM('SKIPPED', { reason: 'duplicate_suppressed' });
    return { success: false, reason: 'duplicate_suppressed', count: dedupCheck.count };
  }

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
    logDM('SUCCESS');
    return { success: true };
  } catch(e) {
    const status = e.response?.status;
    const errMsg = e.response?.data?.message || e.message;
    const errCode = e.response?.data?.code;
    // 50007 = DM dimatiin user, 10013 = unknown user — bukan error fatal
    console.warn(`[DM] ❌ Gagal ke userId=${userId} | HTTP ${status} | code=${errCode} | ${errMsg}`);
    logDM('FAILED', { error: `HTTP ${status} code=${errCode} ${errMsg}` });
    return { success: false, status, errCode, errMsg };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// LIVE CHAT — Notifikasi DM ke Admin lewat Discord Bot tiap ada PESAN BARU
// dari User (App Desktop) → Admin (BUKAN untuk pesan Admin → User, dipanggil
// hanya dari liveChatManager.sendUserMessage). Sengaja pakai sendDiscordDM()
// yang SUDAH ADA (reuse penuh, TIDAK bikin fungsi kirim DM baru) — jadi
// anti-spam-nya ikut mekanisme dedup yang sudah ada (notifDedup, key
// `dm:{discordId admin}`), TANPA sistem dedup baru.
//
// Embed berisi isi pesan, nama user, waktu, dan User ID (sesuai requirement)
// — beda dari sebelumnya yang cuma teks generik tanpa detail.
//
// ANTI SPAM / DUPLICATE: eventId di-set = `_id` pesan ini (unik per pesan,
// dari MongoDB) sehingga:
//   - 1 pesan baru (eventId beda, isi beda) SELALU tetap terkirim sebagai DM
//     baru ke tiap admin (tidak ikut ke-dedup dengan pesan lain).
//   - Kalau fungsi ini KEBETULAN terpanggil lebih dari sekali untuk pesan
//     yang SAMA PERSIS (mis. akibat Socket.IO reconnect, refresh, listener
//     dobel, atau request yang terpanggil dua kali) — eventId & isi kontennya
//     identik, jadi notifDedup (di dalam sendDiscordDM) otomatis menahan
//     percobaan kirim ulang itu (cooldown ~8 detik) → tetap 1 DM per pesan.
//
// Target DM = SEMUA akun admin (role: 'admin' di DB) yang akunnya terhubung
// ke Discord (punya discordId). Best-effort per admin (satu admin gagal
// dikirimi DM tidak menggagalkan pengiriman ke admin lain), dan TIDAK PERNAH
// melempar error ke pemanggil (dipanggil "fire and forget" dari
// liveChatManager saat user kirim pesan).
//
// `message` = objek pesan publik dari liveChatManager (punya _id, discordId,
// senderName, text, imageData, createdAt) — SELALU pakai senderName/discordId
// yang sudah tersedia di sistem (fallback aman, tidak pernah "undefined").
// ──────────────────────────────────────────────────────────────────────────
function buildLiveChatDmEmbed(message) {
  const when = message?.createdAt ? new Date(message.createdAt) : new Date();
  const rawText = String(message?.text || '').trim();
  // Discord field value maks 1024 karakter — potong aman dengan elipsis kalau
  // kepanjangan (chat sendiri sudah dibatasi 2000 char di liveChatManager).
  const pesanValue = rawText
    ? (rawText.length > 1000 ? `${rawText.slice(0, 1000)}…` : rawText)
    : (message?.imageData ? '📷 [Gambar]' : '-');
  // Nama user yang ditampilkan SELALU dari data yang sudah tersedia di sistem
  // (username Discord asli via publicMessage.senderName) — fallback ke
  // Discord ID kalau kebetulan tidak ada, TIDAK PERNAH menampilkan "undefined".
  const userLabel = message?.senderName || message?.discordId || 'User';

  const fields = [
    field('👤 User', userLabel, true),
    field('🆔 User ID', message?.discordId, true),
    field('💬 Pesan', pesanValue, false),
    field('🕒 Waktu', fmtDateTimeWIB(when), true),
    field('⏱️ Discord Timestamp', discordTimestamp(when, 'R'), true)
  ].filter(Boolean);

  return {
    title: '💬 Pesan Live Chat Baru',
    color: 0x5865F2, // Discord blurple — netral, khusus notifikasi chat masuk
    fields,
    timestamp: when.toISOString(), // jam kecil di pojok embed (Discord timestamp asli)
    footer: { text: '31 Tools • Live Chat' }
  };
}

async function notifyAdminsLiveChatMessage(message) {
  try {
    if (!db) return;
    const admins = await db.collection('users')
      .find({ role: 'admin', discordId: { $exists: true, $ne: null } }, { projection: { discordId: 1 } })
      .toArray();
    if (!admins.length) return;

    const embed = buildLiveChatDmEmbed(message);
    const eventId = message?._id ? String(message._id) : undefined;
    await Promise.all(admins.map(a => sendDiscordDM(a.discordId, { embeds: [embed] }, {
      eventLabel: 'livechat_new_message',
      eventId // eventId unik per pesan — lihat catatan ANTI SPAM di atas.
    }).catch(() => {})));
  } catch (e) {
    console.warn('[LiveChat] Gagal kirim DM notifikasi ke admin:', e.message);
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

// ══════════════════════════════════════════════════════════════════════════
// applyRoleChange() — logic INTI ganti paket user, DIEKSTRAK dari endpoint
// PUT /api/admin/users/:discordId/role di bawah supaya bisa dipakai ULANG
// tanpa duplikasi oleh /setpaket (Slash Command Discord, lihat
// discordSlashCommands.js) — SATU jalur logic yang sama persis, jadi hasil
// dari Admin Web maupun Discord SELALU identik (DB, Role Discord, DM,
// webhook, Activity Log, realtime App & Admin Web).
// ══════════════════════════════════════════════════════════════════════════
async function applyRoleChange({ discordId, role, activeUnit, activeAmount, adminName, ip, source = 'admin' }) {
  if (!ROLE_LEVEL.hasOwnProperty(role)) { const e = new Error('Role tidak valid.'); e.status = 400; throw e; }

  const user = await db.collection('users').findOne({ discordId });
  if (!user) { const e = new Error('User tidak ditemukan.'); e.status = 404; throw e; }

  const oldRole = user.role;
  const username = user.username || discordId;

  const update = { role, roleUpdatedAt: new Date(), isGoldTrial: false, trialLimits: null };
  if (role === 'gold' || role === 'platinum') {
    const period = computeActiveUntil({ activeUnit, activeAmount });
    if (!period.ok) { const e = new Error(period.error); e.status = 400; throw e; }
    if (period.activeUntil !== undefined) {
      update.activeUntil = period.activeUntil;
    } else if (oldRole !== role) {
      update.activeUntil = null;
    }
  } else {
    update.activeUntil = null;
  }

  await db.collection('users').updateOne({ discordId }, { $set: update });

  let discordSync = null;
  let dmResult = null;

  if (oldRole !== role) {
    discordSync = await roleSync.syncAppRoleToDiscord(discordId, role);

    const newActiveUntil = update.activeUntil !== undefined ? update.activeUntil : (user.activeUntil || null);
    // Jenis event package card: aktivasi baru dari Public, upgrade antar paket
    // berbayar, atau diperbarui/diturunkan ke Public — sesuai contoh referensi
    // "PAKET DIAKTIFKAN" vs "PAKET DI-UPGRADE".
    const packageEvent = oldRole === 'public' && role !== 'public'
      ? 'activated'
      : (role === 'public' ? 'updated' : 'upgrade');
    const durationLabel = (activeAmount && activeUnit)
      ? `${activeAmount} ${activeUnit === 'minutes' ? 'Menit' : activeUnit === 'hours' ? 'Jam' : 'Hari'}`
      : undefined;

    dmResult = await sendDiscordDM(discordId, {
      embeds: [buildPackageEmbed({
        event: packageEvent,
        description: `Halo **${username}**, paket kamu telah diubah oleh Admin.`,
        username,
        avatarUrl: user.avatarUrl || null,
        role,
        previousRole: packageEvent === 'updated' || packageEvent === 'upgrade' ? oldRole : undefined,
        duration: durationLabel,
        activeUntil: newActiveUntil,
        status: role === 'public' ? '⚪ GRATIS' : '🟢 AKTIF',
        admin: adminName || 'Admin',
        appName: APP_NAME,
        fallbackThumbnail: APP_LOGO_URL || undefined
      })]
    });

    logActivity({
      type: 'set_paket',
      username,
      discordId,
      role,
      admin: adminName || 'Admin',
      status: 'success',
      ip: ip || null,
      before: oldRole,
      after: role,
      description: `${source === 'discord_slash' ? 'Owner/Admin (lewat /setpaket Discord)' : 'Admin'} mengubah paket ${username} dari ${roleLabelUpper(oldRole)} ke ${roleLabelUpper(role)}.`,
      meta: { oldRole, newRole: role, source }
    }).catch(() => {});

    await roleSync.logRoleChange({
      discordId, username, oldRole, newRole: role,
      source, discordSync, dmResult, skipWebhook: true
    });

    // ── SATU webhook per event paket (poin 13/14 di audit) ──
    // SEBELUMNYA di sini ada 2 pengiriman webhook terpisah untuk event yang
    // SAMA PERSIS: kategori 'purchase' (channel Paket) DAN kategori
    // 'role_change' (channel User) — keduanya eventId-nya identik
    // (`role_change:{discordId}:{oldRole}:{role}`), tapi dedup di
    // notifDedup.shouldSend() dikunci per KATEGORI+CHANNEL (`notify:{category}:
    // {channelId}`), jadi eventId yang sama sekalipun TIDAK saling meng-dedup
    // dua kategori yang berbeda. Kalau admin mengaktifkan channel "Perubahan
    // Role/Limit User" (role_change) SEKALIGUS "Pembelian Paket" (purchase),
    // SATU perubahan paket menghasilkan 2 pesan Discord terpisah (ditambah 1
    // DM ke user di atas = user/admin ngerasa "notifnya dobel/lebih dari
    // sekali") — ini akar masalah #1 di laporan audit.
    //
    // Perbaikan: kategori 'purchase' (channel Paket, package_lifecycle) adalah
    // notifikasi resmi & LENGKAP untuk SEMUA perubahan role/paket (dipakai juga
    // oleh voucher, gold trial, pembayaran KlikQRIS, dst — satu bahasa card yang
    // sama). Kategori 'role_change' TETAP ADA & tetap dipakai apa adanya untuk
    // event non-paket (reset limit, perubahan limit presisi — lihat handler
    // reset-quota & quota di bawah), tapi TIDAK LAGI dikirim rangkap untuk
    // perubahan role/paket supaya 1 package event = 1 notifikasi channel
    // (ditambah 1 DM personal ke user, yang memang jalur terpisah/wajar).
    webhookManager.sendCategoryWebhook('purchase', {
      eventId: `role_change:${discordId}:${oldRole}:${role}`,
      embed: buildPackageEmbed({
        event: packageEvent,
        description: `${source === 'discord_slash' ? 'Owner/Admin (lewat /setpaket Discord)' : 'Admin'} mengaktifkan/mengubah paket seorang user.`,
        username,
        avatarUrl: user.avatarUrl || null,
        role,
        previousRole: packageEvent === 'updated' || packageEvent === 'upgrade' ? oldRole : undefined,
        duration: durationLabel,
        activeUntil: newActiveUntil,
        status: role === 'public' ? '⚪ GRATIS' : '🟢 AKTIF',
        admin: adminName || 'Admin',
        appName: APP_NAME,
        fallbackThumbnail: APP_LOGO_URL || undefined
      }),
      plainEmbed: true
    }).catch(() => {});
  }

  pushAccountUpdate(discordId).catch(() => {});
  db.collection('users').findOne({ discordId })
    .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
    .catch(() => {});

  return {
    success: true,
    oldRole, newRole: role,
    discordSync,
    dmSent: dmResult?.success ?? null,
    roleAssigned: discordSync?.added ?? null,
    roleRemoved: discordSync?.removed ?? [],
    activeUntil: update.activeUntil !== undefined ? update.activeUntil : (user.activeUntil || null)
  };
}

app.put('/api/admin/users/:discordId/role', requireAdmin, async (req, res) => {
  try {
    const result = await applyRoleChange({
      discordId: req.params.discordId,
      role: req.body.role,
      activeUnit: req.body.activeUnit,
      activeAmount: req.body.activeAmount !== undefined ? req.body.activeAmount : req.body.activeDays,
      adminName: req.admin?.username,
      ip: getReqIp(req),
      source: 'admin'
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Gagal mengubah role.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// ADMIN — UPGRADE PAKET (harga/masa aktif/benefit/limit/badge Gold & Platinum)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/packages', requireAdmin, async (req, res) => {
  try {
    const packages = await packageManager.getPackages();
    res.json({ packages });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat pengaturan paket.' });
  }
});

app.put('/api/admin/packages/:tier', requireAdmin, async (req, res) => {
  try {
    const tier = req.params.tier;
    const packages = await packageManager.updateTier(tier, req.body || {});
    await refreshDownloadLimits(); // langsung berlaku ke perhitungan limit download saat ini juga

    logActivity({
      type: 'package_settings_updated',
      admin: req.admin?.username || (req.admin?.via === 'discord' ? req.admin.username : 'Admin'),
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan paket ${tier.toUpperCase()}.`,
      meta: { tier, changes: req.body }
    }).catch(() => {});

    // Realtime: Admin Web (halaman lain yang lagi kebuka) + App (menu Upgrade
    // Paket) langsung dapat harga/benefit/limit terbaru tanpa reload.
    const publicPackages = await packageManager.getPackagesPublic();
    broadcastAdmin('packages:update', packages);
    wsBroadcastAll('packages:update', publicPackages);

    res.json({ success: true, packages });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gagal menyimpan pengaturan paket.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — KLIKQRIS SETTINGS (API Key + Merchant ID per mode Sandbox/Production,
// aktif/nonaktif gateway). Menggantikan "Pakasir Settings" secara penuh.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/klikqris-settings', requireAdmin, async (req, res) => {
  try {
    const cfg = await klikqrisManager.getSettings();
    res.json({ settings: { ...klikqrisManager.maskSettings(cfg), webhookUrl: `${SERVER_URL}/api/webhook/klikqris` } });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat pengaturan KlikQRIS.' });
  }
});

app.put('/api/admin/klikqris-settings', requireAdmin, async (req, res) => {
  try {
    const { enabled, mode, sandboxApiKey, sandboxMerchantId, productionApiKey, productionMerchantId } = req.body || {};
    const cfg = await klikqrisManager.updateSettings({
      enabled, mode, sandboxApiKey, sandboxMerchantId, productionApiKey, productionMerchantId
    });

    logActivity({
      type: 'klikqris_settings_updated',
      admin: req.admin?.username || 'Admin', status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan KlikQRIS (gateway ${cfg.enabled ? 'diaktifkan' : 'dinonaktifkan'}, mode aktif ${cfg.mode.toUpperCase()}).`,
      meta: {
        enabled: cfg.enabled, mode: cfg.mode,
        sandboxApiKeyChanged: !!sandboxApiKey, productionApiKeyChanged: !!productionApiKey
      }
    }).catch(() => {});

    res.json({ success: true, settings: { ...klikqrisManager.maskSettings(cfg), webhookUrl: `${SERVER_URL}/api/webhook/klikqris` } });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gagal menyimpan pengaturan KlikQRIS.' });
  }
});

// Tombol "Test Connection" di halaman KlikQRIS Settings — panggil API status
// dengan order_id dummy buat mastiin API Key/Merchant ID mode aktif valid,
// TANPA bikin transaksi beneran.
app.get('/api/admin/klikqris-settings/status', requireAdmin, async (req, res) => {
  try {
    const result = await klikqrisManager.testConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || 'Gagal cek koneksi.' });
  }
});

// Tombol "Test Create Transaction" — bikin transaksi QRIS Rp1.000 SUNGGUHAN
// (di mode yang sedang aktif, Sandbox atau Production) buat verifikasi
// end-to-end create-transaction, TANPA masuk ke tabel transactions lokal
// (murni test koneksi API, bukan order beneran).
app.post('/api/admin/klikqris-settings/test-transaction', requireAdmin, async (req, res) => {
  try {
    const result = await klikqrisManager.testCreateTransaction();
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || 'Gagal membuat transaksi uji coba.' });
  }
});

// Tombol "Test Webhook" — kirim POST dummy ke endpoint webhook KITA SENDIRI
// (bukan ke KlikQRIS) supaya Admin bisa pastikan endpoint /api/webhook/klikqris
// bisa dijangkau dari luar (mis. lewat domain publik) sebelum mendaftarkannya
// di dashboard KlikQRIS. Dikirim dengan order_id palsu yang sengaja tidak
// dikenal supaya server membalas `{ ok: true, ignored: true }` tanpa efek apapun.
app.post('/api/admin/klikqris-settings/test-webhook', requireAdmin, async (req, res) => {
  try {
    const testUrl = `${SERVER_URL}/api/webhook/klikqris`;
    const resp = await axios.post(testUrl, {
      order_id: '__admin_test_webhook__', status: 'PAID', amount: 1000, total_amount: 1000, signature: 'test'
    }, { timeout: 10000, validateStatus: () => true });
    res.json({ ok: resp.status === 200, status: resp.status, url: testUrl, response: resp.data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || 'Gagal menghubungi endpoint webhook sendiri.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — DISCORD AUTO ORDER (form embed Gold/Platinum yang dikirim Bot,
// channel tujuan, publish/update menu). Lihat discordAutoOrderManager.js.
// Semua perubahan langsung berlaku (dibaca dari DB tiap dipakai, TANPA
// cache/restart) — sama seperti pengaturan KlikQRIS/Paket lain di atas.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/discord-autoorder/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await discordAutoOrderManager.getSettings();
    const roleMap = await discordAutoOrderManager.getRoleMappingInfo();
    res.json({ settings, roleMap, botConfigured: discordAutoOrderManager.isBotConfigured() });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat pengaturan Auto Order.' });
  }
});

app.get('/api/admin/discord-autoorder/channels', requireAdmin, async (req, res) => {
  try {
    res.json({ channels: await discordAutoOrderManager.getGuildTextChannels() });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Gagal memuat daftar channel Discord.' });
  }
});

app.put('/api/admin/discord-autoorder/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await discordAutoOrderManager.updateSettings(req.body || {});

    logActivity({
      type: 'discord_autoorder_settings_updated',
      admin: req.admin?.username || 'Admin', status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan Auto Order Discord Bot (${settings.enabled ? 'diaktifkan' : 'dinonaktifkan'}).`,
      meta: { enabled: settings.enabled, channelId: settings.channelId }
    }).catch(() => {});

    // "Perubahan langsung diterapkan tanpa restart bot" — begitu Admin
    // menyimpan, pesan menu gabungan (Gold & Platinum di 1 pesan) di
    // Discord langsung ikut diperbarui.
    let publish = null;
    if (settings.enabled && settings.channelId) {
      publish = await discordAutoOrderManager.publishMenu()
        .then(message => ({ ok: true, messageId: message.id }))
        .catch(e => ({ ok: false, error: e.message }));
    }

    res.json({ success: true, settings, publish });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gagal menyimpan pengaturan Auto Order.' });
  }
});

// Tombol "Publish/Update Menu" manual — dipakai kalau Admin cuma mau
// paksa kirim ulang pesan menu (mis. pesan lama kehapus manual di Discord)
// tanpa harus mengubah pengaturan apapun dulu.
app.post('/api/admin/discord-autoorder/publish', requireAdmin, async (req, res) => {
  try {
    const message = await discordAutoOrderManager.publishMenu();
    res.json({ success: true, result: { ok: true, messageId: message.id } });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gagal publish menu Auto Order.' });
  }
});

// Riwayat order yang masuk lewat Discord Bot (channel invoice-nya, dsb) —
// detail transaksi (harga/status/metode) tetap diambil dari /api/admin/transactions
// yang sudah ada (join di sisi client pakai orderId), supaya tidak duplikasi data.
app.get('/api/admin/discord-autoorder/orders', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const { items, total } = await discordAutoOrderManager.listOrders({ limit, skip });
    res.json({ orders: items, total });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat riwayat order Auto Order.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — TRANSAKSI (SEMUA transaksi KlikQRIS dari semua user — bukan cuma
// Upgrade Paket). Halaman "Transaksi" Admin Web dulu cuma baca dari
// transactionManager (collection `transactions`, khusus Upgrade Paket),
// padahal Marketplace Product (marketplaceOrderManager, collection
// `marketplaceOrders`) dan Steam Account (steamAccountOrderManager, collection
// `steamAccountOrders`) SAMA-SAMA lewat KlikQRIS dan sudah tersimpan lengkap
// di DB masing-masing sejak awal — cuma belum ikut ditampilkan di SATU riwayat
// yang sama. Endpoint ini menggabungkan KETIGANYA (bukan bikin sistem
// transaksi baru) jadi satu daftar terurut, tetap lewat listAll() masing-masing
// manager yang sudah ada (jadi status/paymentMethod/dst selalu ikut data asli
// yang sama dipakai webhook KlikQRIS — tidak ada duplikasi/rekonsiliasi data).
//
// Strategi merge top-K yang efisien (BUKAN ambil semua isi 3 collection lalu
// sort semuanya): karena masing-masing sumber sudah terurut DESC by createdAt,
// baris ke-N teratas gabungan PASTI ada di antara N baris teratas tiap sumber
// -> cukup ambil top (skip+limit) dari tiap sumber, gabung, sort ulang, baru
// potong sesuai skip/limit. Query ke DB tetap kecil & terbatas walau total
// data di 3 collection itu besar (skala sama seperti listAll biasa).
async function listUnifiedAdminTransactions({ status, type, q, limit, skip }) {
  const fetchN = skip + limit; // top-N yang perlu diambil dari TIAP sumber biar hasil gabungan akurat
  const sources = [];

  if (!type || type === 'package') {
    sources.push(
      transactionManager.listAll({ status, q, limit: fetchN, skip: 0 }).then(({ items, total }) => ({
        total,
        items: items.map(t => ({
          ...transactionManager.publicTransaction(t),
          paymentNumber: t.paymentNumber || null,
          kind: 'package',
          // productLabel sengaja tidak diisi di sini — Admin Web sudah punya
          // roleTagHtml(tier) buat render badge Paket dari field `tier` yang
          // sudah ikut dikirim lewat publicTransaction() di atas.
          productLabel: null,
          _sortAt: new Date(t.createdAt).getTime()
        }))
      }))
    );
  }
  if (!type || type === 'marketplace') {
    sources.push(
      marketplaceOrderManager.listAll({ status, q, limit: fetchN, skip: 0, lite: true }).then(({ items, total }) => ({
        total,
        items: items.map(o => ({
          ...marketplaceOrderManager.publicOrder(o),
          kind: 'marketplace',
          productLabel: o.productName || '—',
          _sortAt: new Date(o.createdAt).getTime()
        }))
      }))
    );
  }
  if (!type || type === 'steam_account') {
    sources.push(
      steamAccountOrderManager.listAll({ status, q, limit: fetchN, skip: 0, lite: true }).then(({ items, total }) => ({
        total,
        items: items.map(o => ({
          ...steamAccountOrderManager.publicOrder(o),
          kind: 'steam_account',
          productLabel: o.productName || '—',
          _sortAt: new Date(o.createdAt).getTime()
        }))
      }))
    );
  }

  const results = await Promise.all(sources);
  const total = results.reduce((sum, r) => sum + r.total, 0);
  const merged = results.flatMap(r => r.items)
    .sort((a, b) => b._sortAt - a._sortAt)
    .slice(skip, skip + limit)
    .map(({ _sortAt, ...rest }) => rest);

  return { items: merged, total };
}

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const { status, type, q } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const { items, total } = await listUnifiedAdminTransactions({ status, type, q, limit, skip });
    await profileManager.enrichRows(items, 'discordId'); // tampilkan nama/foto profil App terbaru
    res.json({ transactions: items, total });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat daftar transaksi.' });
  }
});

app.get('/api/admin/transactions/:id', requireAdmin, async (req, res) => {
  try {
    const tx = await transactionManager.getById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    res.json({ transaction: { ...transactionManager.publicTransaction(tx), paymentNumber: tx.paymentNumber || null } });
  } catch (e) {
    res.status(500).json({ error: 'Gagal memuat detail transaksi.' });
  }
});

// Tombol "Refresh Status" di halaman Transaksi Admin Web — paksa cek ulang
// status transaksi tsb langsung ke KlikQRIS (dipakai kalau webhook telat/gagal).
app.post('/api/admin/transactions/:id/refresh', requireAdmin, async (req, res) => {
  try {
    const tx = await transactionManager.getById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    if (tx.status !== 'pending') {
      return res.json({ success: true, changed: false, transaction: transactionManager.publicTransaction(tx) });
    }
    await refreshTransactionFromKlikqris(tx);
    const fresh = await transactionManager.getByOrderId(tx.orderId);
    res.json({ success: true, changed: fresh.status !== 'pending', transaction: transactionManager.publicTransaction(fresh) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Gagal refresh status transaksi.' });
  }
});

// Batalkan transaksi (Admin) — dipakai kalau ada transaksi mencurigakan/keliru;
// cuma bisa selagi transaksinya masih 'pending'.
app.post('/api/admin/transactions/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const tx = await transactionManager.getById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    if (tx.status !== 'pending') {
      return res.status(400).json({ error: `Transaksi ini sudah ${tx.status}, tidak bisa dibatalkan.` });
    }
    const cancelled = await cancelPendingTransaction(tx, { by: 'admin', cancelledByAdmin: req.admin?.username || 'Admin' });
    if (!cancelled) {
      return res.status(409).json({ error: 'Transaksi baru saja berubah status (mungkin sudah lunas), coba refresh.' });
    }
    res.json({ success: true, transaction: transactionManager.publicTransaction(cancelled) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Gagal membatalkan transaksi.' });
  }
});

// ADMIN — VOUCHER PAKET GOLD/PLATINUM (lihat voucherManager.js buat CRUD/logika
// klaim yang atomic). Halaman "Kelola Voucher" di Admin Web.
// ══════════════════════════════════════════════════════════════════════════
function voucherPublic(v) {
  const now = new Date();
  const isExpired = !!(v.expiresAt && new Date(v.expiresAt) <= now);
  const isFull = v.usedCount >= v.quota;
  return {
    id: String(v._id),
    code: v.code,
    role: v.role,
    durationAmount: v.durationAmount,
    durationUnit: v.durationUnit,
    quota: v.quota,
    usedCount: v.usedCount,
    description: v.description || null,
    remaining: Math.max(0, v.quota - v.usedCount),
    expiresAt: v.expiresAt,
    active: v.active !== false,
    isExpired,
    isFull,
    // Status ringkas buat badge di tabel Admin Web — satu sumber kebenaran biar
    // konsisten dgn alasan gagal klaim yang dilihat user ("kenapa nonaktif").
    status: v.active === false ? 'inactive' : isExpired ? 'expired' : isFull ? 'full' : 'active',
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    updatedAt: v.updatedAt
  };
}

app.get('/api/admin/vouchers', requireAdmin, async (req, res) => {
  try {
    const vouchers = await voucherManager.listVouchers();
    res.json({ vouchers: vouchers.map(voucherPublic) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/vouchers', requireAdmin, async (req, res) => {
  try {
    const { code, role, durationAmount, durationUnit, quota, expiresAt } = req.body || {};
    const voucher = await voucherManager.createVoucher({
      code, role, durationAmount, durationUnit, quota, expiresAt,
      createdBy: req.admin?.username || 'Admin'
    });

    logActivity({
      type: 'voucher_create',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin membuat voucher "${voucher.code}" (${roleLabelUpper(voucher.role)}, ${voucher.durationAmount} ${voucherManager.DURATION_UNIT_LABEL[voucher.durationUnit]}, kuota ${voucher.quota}).`,
      meta: { voucherId: String(voucher._id), code: voucher.code, role: voucher.role, quota: voucher.quota }
    }).catch(() => {});

    res.json({ success: true, voucher: voucherPublic(voucher) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/vouchers/:id', requireAdmin, async (req, res) => {
  try {
    const { code, role, durationAmount, durationUnit, quota, expiresAt, active } = req.body || {};
    const voucher = await voucherManager.updateVoucher(req.params.id, { code, role, durationAmount, durationUnit, quota, expiresAt, active });

    logActivity({
      type: 'voucher_edit',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah voucher "${voucher.code}".`,
      meta: { voucherId: String(voucher._id), code: voucher.code }
    }).catch(() => {});

    res.json({ success: true, voucher: voucherPublic(voucher) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/vouchers/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body || {};
    const voucher = await voucherManager.updateVoucher(req.params.id, { active: !!active });

    logActivity({
      type: 'voucher_toggle',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin ${voucher.active ? 'mengaktifkan' : 'menonaktifkan'} voucher "${voucher.code}".`,
      meta: { voucherId: String(voucher._id), code: voucher.code, active: voucher.active }
    }).catch(() => {});

    res.json({ success: true, voucher: voucherPublic(voucher) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/vouchers/:id', requireAdmin, async (req, res) => {
  try {
    const voucher = await voucherManager.deleteVoucher(req.params.id);

    logActivity({
      type: 'voucher_delete',
      admin: req.admin?.username || 'Admin',
      status: 'warning',
      ip: getReqIp(req),
      description: `Admin menghapus voucher "${voucher.code}".`,
      meta: { voucherId: String(voucher._id), code: voucher.code }
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — GOLD TRIAL SETTINGS (lihat goldTrialManager.js buat logika lengkap).
// Halaman "Gold Trial Settings" di Admin Web.
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/gold-trial/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await goldTrialManager.getSettings();
    const activeCount = await goldTrialManager.countActive();
    res.json({ settings, activeCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/gold-trial/settings', requireAdmin, async (req, res) => {
  try {
    const { active, durationAmount, durationUnit, gameLimit, bypassLimit, successMessage, offerMessage } = req.body || {};
    const before = await goldTrialManager.getSettings();
    const settings = await goldTrialManager.updateSettings({ active, durationAmount, durationUnit, gameLimit, bypassLimit, successMessage, offerMessage });

    logActivity({
      type: 'gold_trial_settings_update',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin ${settings.active ? 'mengaktifkan' : 'menonaktifkan'} Gold Trial (${settings.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[settings.durationUnit]}, limit Game ${settings.gameLimit === null ? 'Unlimited' : settings.gameLimit + 'x'}, limit Bypass ${settings.bypassLimit === null ? 'Unlimited' : settings.bypassLimit + 'x'}).`,
      meta: { before, after: settings }
    }).catch(() => {});

    broadcastAdmin('goldTrial:settings', settings);
    res.json({ success: true, settings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Riwayat klaim (User ID/Discord ID, waktu klaim, waktu berakhir, limit, status).
app.get('/api/admin/gold-trial/claims', requireAdmin, async (req, res) => {
  try {
    const claims = await goldTrialManager.listClaims({ limit: 500 });
    res.json({
      claims: claims.map(c => ({
        discordId: c.discordId,
        username: c.username,
        claimedAt: c.claimedAt,
        expiresAt: c.expiresAt,
        gameLimit: c.gameLimit,
        bypassLimit: c.bypassLimit,
        status: c.status
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// TEST — FLOW B (ADMIN FORCE NOTIFICATION), BUKAN klaim. Mengirim notifikasi
// Gold Trial PERSIS seperti yang akan dilihat user (title/deskripsi/durasi
// dinamis dari settings existing, template & tampilan SAMA dengan notifikasi
// normal/force-send) ke SATU akun yang ditunjuk admin (discordId), buat
// keperluan test UI/notification/Socket.IO/animation/tombol/layout/realtime
// delivery TANPA menyentuh status klaim/device/role apa pun. Sengaja TIDAK
// memanggil goldTrialManager.claimTrial()/getEligibility() sama sekali (lihat
// requirement #7 & #12: "TEST tidak boleh bypass claim restriction" DAN "TEST
// notification tidak boleh otomatis mengaktifkan Gold Trial") — jadi TEST bisa
// dikirim kapan pun, ke akun manapun, terlepas dari status eligibility/klaim/
// device-nya. Kalau user yang menerima notifikasi test ini lalu betulan klik
// CLAIM di App, request itu tetap lewat POST /api/gold-trial/claim yang sudah
// ada -> validasi normal (eligibility asli) tetap berlaku sepenuhnya.
app.post('/api/admin/gold-trial/test', requireAdmin, async (req, res) => {
  try {
    const discordId = String(req.body?.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const settings = await goldTrialManager.getSettings();
    const durationLabel = `${settings.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[settings.durationUnit]}`;

    await notifyUser(discordId, {
      type: 'gold_trial_offer',
      title: 'Gold Trial Tersedia',
      message: settings.offerMessage,
      meta: { durationLabel, gameLimit: settings.gameLimit, bypassLimit: settings.bypassLimit, forced: true, source: 'test' },
      dm: false, webhook: false
    });

    logActivity({
      type: 'gold_trial_test_notify',
      admin: req.admin?.username || 'Admin',
      username: user.username, discordId,
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengirim TEST notifikasi Gold Trial ke ${user.username || discordId} (tidak mengaktifkan trial).`
    }).catch(() => {});

    res.json({ success: true, durationLabel, offerMessage: settings.offerMessage });
  } catch (e) {
    console.error('[Gold Trial][TEST] Gagal:', e);
    res.status(500).json({ error: 'Terjadi kesalahan di server, coba lagi sebentar.' });
  }
});

// FORCE CLAIM — FLOW C, satu-satunya jalur yang BOLEH bypass restriction klaim
// normal (device sudah pernah klaim / akun sudah pernah klaim / tidak eligible
// member baru), dan HANYA bisa dipanggil dari sini (di belakang requireAdmin —
// permission admin existing, TIDAK bisa dipicu dari App/user biasa/manipulasi
// frontend). Reuse penuh goldTrialManager.forceClaim() (lihat goldTrialManager.js)
// + efek ikutan yang SAMA PERSIS dengan klaim normal/TEST (update user, sync
// role Discord existing, notifyUser existing, Socket.IO existing) — TIDAK ADA
// entitlement/notification/Socket.IO baru. Tercatat ke Admin History/Logs
// existing (logActivity) dengan admin, target user, target device, timestamp,
// dan hasil success/failure, sesuai requirement #15.
app.post('/api/admin/gold-trial/force-claim', requireAdmin, async (req, res) => {
  const discordId = String(req.body?.discordId || '').trim();
  const adminUsername = req.admin?.username || 'Admin';
  try {
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });

    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const deviceId = await getGoldTrialDeviceId(discordId);
    const { durationAmount, durationUnit, gameLimit, bypassLimit } = req.body || {};

    let result;
    try {
      result = await goldTrialManager.forceClaim({
        discordId, username: user.username || discordId, deviceId,
        durationAmount, durationUnit, gameLimit, bypassLimit, adminUsername
      });
    } catch (validationErr) {
      logActivity({
        type: 'gold_trial_force_claim', admin: adminUsername, username: user.username, discordId,
        status: 'warning', ip: getReqIp(req), device: deviceId,
        description: `Admin ${adminUsername} GAGAL force claim Gold Trial untuk ${user.username || discordId}: ${validationErr.message}`,
        meta: { reason: 'invalid_input', error: validationErr.message }
      }).catch(() => {});
      return res.status(400).json({ error: validationErr.message });
    }

    const { claim, settings } = result;
    const oldRole = user.role;
    await db.collection('users').updateOne(
      { discordId },
      { $set: {
          role: 'gold', activeUntil: claim.expiresAt, roleUpdatedAt: new Date(),
          isGoldTrial: true, trialLimits: { game: claim.gameLimit, bypass: claim.bypassLimit },
          everHadGold: true
        } }
    );
    if (oldRole !== 'gold') await roleSync.syncAppRoleToDiscord(discordId, 'gold').catch(() => null);

    const durationLabel = `${claim.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[claim.durationUnit]}`;

    logActivity({
      type: 'gold_trial_force_claim',
      admin: adminUsername, username: user.username, discordId,
      status: 'success', ip: getReqIp(req), device: deviceId,
      before: oldRole, after: 'gold',
      description: `Admin ${adminUsername} FORCE CLAIM Gold Trial untuk ${user.username || discordId} (${durationLabel}), aktif sampai ${fmtDateTimeWIB(claim.expiresAt)}.${result.deviceConflict ? ' (Device sudah tercatat di akun lain — deviceId tidak ditimpa.)' : ''}`,
      meta: { durationAmount: claim.durationAmount, durationUnit: claim.durationUnit, activeUntil: claim.expiresAt, gameLimit: claim.gameLimit, bypassLimit: claim.bypassLimit, deviceConflict: !!result.deviceConflict }
    }).catch(() => {});

    notifyUser(discordId, {
      type: 'gold_trial_claim',
      title: 'Gold Trial Berhasil Diaktifkan!',
      message: settings.successMessage,
      dm: true, webhook: true,
      packageCard: {
        event: 'gold_trial', description: settings.successMessage, username: user.username || discordId,
        role: 'gold_trial', duration: durationLabel, activeUntil: claim.expiresAt, status: '🟢 AKTIF',
        extraFields: [
          field('🎮 Limit Game/hari', claim.gameLimit === null ? 'Unlimited' : `${claim.gameLimit}x`, false),
          field('🛠️ Limit Bypass/hari', claim.bypassLimit === null ? 'Unlimited' : `${claim.bypassLimit}x`, false)
        ]
      }
    }).catch(() => {});

    pushAccountUpdate(discordId).catch(() => {});
    db.collection('users').findOne({ discordId })
      .then(fresh => computeUserStats(discordId).then(stats => broadcastAdmin('user:update', publicUser(fresh, stats))))
      .catch(() => {});
    goldTrialManager.listClaims({ limit: 200 }).then(list => broadcastAdmin('goldTrial:claims', list)).catch(() => {});
    const txItem = publicGoldTrialClaim(claim);
    wsSendToUser(discordId, 'transaction:update', txItem);
    broadcastAdmin('transaction:update', txItem);

    res.json({ success: true, activeUntil: claim.expiresAt, durationLabel, gameLimit: claim.gameLimit, bypassLimit: claim.bypassLimit, deviceConflict: !!result.deviceConflict });
  } catch (e) {
    console.error('[Gold Trial][FORCE CLAIM] Gagal:', e);
    logActivity({
      type: 'gold_trial_force_claim', admin: adminUsername, discordId,
      status: 'error', ip: getReqIp(req),
      description: `Admin ${adminUsername} GAGAL force claim Gold Trial untuk ${discordId}: kesalahan server.`,
      meta: { error: e.message }
    }).catch(() => {});
    res.status(500).json({ error: 'Terjadi kesalahan di server, coba lagi sebentar.' });
  }
});

// Cari SATU user berdasarkan Discord ID (BUKAN username) + status Gold Trial
// miliknya — dipakai fitur "Kirim Notifikasi Gold Trial" di Admin Web supaya
// admin bisa pastikan target sebelum kirim. Reuse penuh goldTrialManager
// (sumber kebenaran yang SAMA dengan App/claim) — TIDAK ADA logic eligibility
// baru di sini.
app.get('/api/admin/gold-trial/lookup', requireAdmin, async (req, res) => {
  try {
    const discordId = String(req.query.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'not_found' });

    const deviceId = await getGoldTrialDeviceId(discordId);
    const eligibility = await goldTrialManager.getEligibility({ discordId, discordJoinedAt: user.discordJoinedAt, deviceId });
    const existingClaim = await goldTrialManager.getClaimByDiscordId(discordId);

    res.json({
      user: {
        discordId: user.discordId,
        username: user.username || user.discordId,
        avatarUrl: user.avatarUrl || null,
        role: user.role || 'public'
      },
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      claim: existingClaim ? {
        claimedAt: existingClaim.claimedAt,
        expiresAt: existingClaim.expiresAt,
        status: new Date(existingClaim.expiresAt) > new Date() ? 'active' : 'expired'
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kirim notifikasi Gold Trial PERSONAL ke SATU user (berdasarkan Discord ID) —
// FLOW B (ADMIN FORCE NOTIFICATION): murni memberi tahu/mengarahkan, TIDAK
// mengaktifkan trial apa pun (klaim tetap wajib lewat tombol Claim di App yang
// akan divalidasi normal oleh POST /api/gold-trial/claim). SENGAJA TIDAK
// dibatasi oleh settings.active/eligibility (lihat requirement #6 & #12) —
// admin harus tetap bisa mengirim walau Gold Trial sedang nonaktif, akun/device
// sudah pernah klaim, sudah expired, atau user tidak eligible untuk klaim
// normal. Reuse notifyUser() existing (in-app realtime + DM + persistence
// koleksi "notifications") — TIDAK ADA notification system baru, dan TIDAK
// PERNAH broadcast ke user lain selain yang eksplisit dipilih admin.
app.post('/api/admin/gold-trial/notify', requireAdmin, async (req, res) => {
  try {
    const discordId = String(req.body?.discordId || '').trim();
    if (!discordId) return res.status(400).json({ error: 'Discord ID wajib diisi.' });
    const user = await db.collection('users').findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const settings = await goldTrialManager.getSettings();
    const durationLabel = `${settings.durationAmount} ${goldTrialManager.DURATION_UNIT_LABEL[settings.durationUnit]}`;

    await notifyUser(discordId, {
      type: 'gold_trial_offer',
      title: 'Gold Trial Tersedia',
      message: settings.offerMessage,
      meta: { durationLabel, gameLimit: settings.gameLimit, bypassLimit: settings.bypassLimit, forced: true, source: 'admin_send' },
      dm: true, webhook: false
    });

    logActivity({
      type: 'gold_trial_notify_sent',
      admin: req.admin?.username || 'Admin',
      username: user.username, discordId, status: 'success',
      ip: getReqIp(req),
      description: `Admin mengirim (FORCE SEND) notifikasi Gold Trial ke ${user.username || discordId}.`
    }).catch(() => {});

    res.json({ success: true, durationLabel });
  } catch (e) {
    res.status(500).json({ error: 'Gagal mengirim notifikasi: ' + e.message });
  }
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

    notifyUser(discordId, {
      type: 'renewal',
      title: clear ? 'Masa Aktif Direset' : 'Masa Aktif Diperpanjang',
      message: clear
        ? 'Masa aktif paket kamu telah direset oleh Admin.'
        : `Masa aktif paket kamu telah diperpanjang oleh Admin, aktif sampai ${fmtDateTimeWIB(activeUntil)}.`,
      dm: true, webhook: false,
      packageCard: {
        event: clear ? 'reset' : 'renewed',
        description: clear ? 'Masa aktif paket kamu telah direset oleh Admin.' : 'Masa aktif paket kamu telah diperpanjang oleh Admin.',
        username: user.username || discordId,
        role: user.role,
        activeUntil: activeUntil || null,
        status: activeUntil ? '🟢 AKTIF' : '⚪ BELUM DIATUR'
      }
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
    // Pakai package card yang sama (avatar user, warna per-paket) supaya konsisten
    // dengan DM di atas — dikirim POLOS (plainEmbed: true, param ke-4) karena
    // embed-nya sudah final.
    webhookManager.sendCategoryWebhook('renewal', {
      embed: buildPackageEmbed({
        event: clear ? 'reset' : 'renewed',
        description: clear ? 'Admin mereset masa aktif paket user.' : 'Admin memperpanjang masa aktif paket user.',
        username: user.username || discordId,
        avatarUrl: user.avatarUrl || null,
        role: user.role,
        activeUntil: activeUntil || null,
        status: activeUntil ? '🟢 AKTIF' : '⚪ BELUM DIATUR',
        appName: APP_NAME,
        fallbackThumbnail: APP_LOGO_URL || undefined
      }),
      plainEmbed: true
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

    const beforeUsage = (user.downloadUsage && user.downloadUsage.date === todayDateStrJakarta())
      ? user.downloadUsage
      : { game: 0, bypass: 0 };

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
      before: { game: beforeUsage.game || 0, bypass: beforeUsage.bypass || 0 },
      after: { game: 0, bypass: 0 },
      description: `Admin mereset limit download harian ${user.username || discordId}.`,
      meta: { discordId }
    }).catch(() => {});

    // DM + Webhook kategori "Perubahan Role/Limit User" — sebelumnya reset limit
    // sama sekali tidak dinotifikasi ke user maupun channel Discord admin, cuma
    // tercatat di Logs. Disamakan dgn event Set Paket (role_change) yg sudah ada,
    // sertakan admin yg melakukan & before/after limit-nya.
    const resetQuotaFields = [
      field('👤 Username', user.username || discordId, true),
      field('🆔 Discord ID', discordId, true),
      field('🎮 Game Terpakai Sebelum', String(beforeUsage.game || 0), true),
      field('🛡️ Bypass Terpakai Sebelum', String(beforeUsage.bypass || 0), true)
    ];
    sendDiscordDM(discordId, {
      embeds: [buildDM({
        status: 'success',
        badge: 'user',
        title: 'Limit Download Kamu Direset',
        description: `Admin mereset limit download harian kamu (Game & Bypass) kembali ke 0 terpakai.`,
        admin: req.admin?.username || 'Admin',
        fields: resetQuotaFields,
        appName: APP_NAME,
        footerNote: 'Perubahan Limit'
      })]
    }, { eventId: `reset_quota:${discordId}` }).catch(() => {});

    webhookManager.sendCategoryWebhook('role_change', {
      eventId: `reset_quota:${discordId}`,
      embed: buildEmbed({
        status: 'success',
        badge: 'user',
        title: 'Limit Download User Direset',
        description: `Admin mereset limit download harian (Game & Bypass) milik **${user.username || discordId}** ke 0.`,
        admin: req.admin?.username || 'Admin',
        fields: resetQuotaFields,
        appName: APP_NAME,
        footerNote: 'Perubahan Limit'
      })
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

    const limits = effectiveDownloadLimits(user);
    const limit = limits[type];
    if (limit === Infinity) return res.status(400).json({ error: `Paket ${roleLabelUpper(user.role)} unlimited untuk ${type === 'game' ? 'Game' : 'Bypass'}, tidak ada limit yang bisa diatur.` });

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

    // DM + Webhook kategori "Perubahan Role/Limit User" — sebelumnya perubahan
    // limit presisi (add/subtract/reset per tipe) sama sekali tidak dinotifikasi
    // ke user maupun channel Discord admin. Sertakan admin yg melakukan & before/
    // after limit-nya (sesuai permintaan).
    const quotaChangeFields = [
      field('👤 Username', user.username || discordId, true),
      field('📂 Tipe Limit', label, true),
      field('🔧 Aksi', action === 'reset' ? 'Reset' : action === 'add' ? 'Ditambah' : 'Dikurangi', true),
      field('📊 Terpakai Sebelum', `${usedNow}/${limit}`, true),
      field('📊 Terpakai Sesudah', `${usedNext}/${limit}`, true),
      field('✅ Sisa Sekarang', `${Math.max(0, limit - usedNext)}/${limit}`, true)
    ];
    sendDiscordDM(discordId, {
      embeds: [buildDM({
        status: 'info',
        badge: 'user',
        title: `Limit ${label} Kamu Diubah Admin`,
        description: `Admin ${actionLabel} limit download ${label} kamu.`,
        admin: req.admin?.username || 'Admin',
        fields: quotaChangeFields,
        appName: APP_NAME,
        footerNote: 'Perubahan Limit'
      })]
    }, { eventId: `quota_change:${discordId}:${type}:${action}:${amount || 0}` }).catch(() => {});

    webhookManager.sendCategoryWebhook('role_change', {
      eventId: `quota_change:${discordId}:${type}:${action}:${amount || 0}`,
      embed: buildEmbed({
        status: 'info',
        badge: 'user',
        title: 'Limit Download User Diubah',
        description: `Admin ${actionLabel} limit download ${label} milik **${user.username || discordId}**.`,
        admin: req.admin?.username || 'Admin',
        fields: quotaChangeFields,
        appName: APP_NAME,
        footerNote: 'Perubahan Limit'
      })
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

    // Webhook opsional (kategori "Aktivitas Admin") — visibilitas admin lain atas
    // aksi moderasi (ban/unban/suspend/unsuspend), terpisah dari DM ke user.
    webhookManager.sendCategoryWebhook('admin_activity', {
      eventId: `account_status:${discordId}:${oldStatus}:${status}`,
      embed: buildEmbed({
        status: status === 'active' ? 'success' : 'warning',
        badge: 'admin',
        title: `Aksi Moderasi: ${LOG_CATALOG[logType]?.label || 'Perubahan Status Akun'}`,
        description: `Admin mengubah status akun **${user.username || discordId}** dari ${STATUS_LABEL[oldStatus]} menjadi ${STATUS_LABEL[status]}.${reason ? ` Alasan: ${reason}` : ''}`,
        username: user.username || discordId,
        role: user.role,
        userId: discordId,
        admin: req.admin?.username || 'Admin',
        appName: APP_NAME,
        footerNote: 'Aktivitas Admin'
      })
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
      eventId: `device_reset:${discordId}`,
      embed: buildEmbed({
        status: 'security',
        badge: 'security',
        title: 'Device Direset oleh Admin',
        description: `Admin mereset ikatan perangkat untuk **${user.username || discordId}**.`,
        username: user.username || discordId,
        userId: discordId,
        admin: req.admin?.username || 'Admin',
        fields: [
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
      eventId: `device_allow_change:${discordId}`,
      embed: buildEmbed({
        status: 'security',
        badge: 'security',
        title: 'Pergantian Device Diizinkan Admin',
        description: `Admin mengizinkan **${user.username || discordId}** login dari perangkat baru (berlaku sekali, login berikutnya).`,
        username: user.username || discordId,
        userId: discordId,
        admin: req.admin?.username || 'Admin',
        fields: [
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
// ADMIN — DISCORD NOTIFICATION CHANNEL SETTING (menggantikan Webhook Setting
// lama sepenuhnya — admin memilih channel Discord dari server yang sudah
// terhubung dengan Bot, bukan lagi menempel URL webhook manual)
// ══════════════════════════════════════════════════════════════════════════

// Status koneksi Discord Bot (dipakai buat badge "🟢 Connected" di header
// halaman Admin Web).
app.get('/api/admin/discord/bot-status', requireAdmin, async (req, res) => {
  try {
    res.json(await webhookManager.getBotStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar channel teks server Discord yang terhubung, diambil LANGSUNG dari
// Discord (bukan disimpan/ditempel manual) — dipakai isi dropdown pemilih
// channel per kategori notifikasi.
app.get('/api/admin/discord/channels', requireAdmin, async (req, res) => {
  try {
    const result = await webhookManager.listGuildChannels();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar semua kategori notifikasi + status konfigurasinya (channel terpilih
// atau tidak, aktif/tidak, status terakhir Valid/Invalid). Dipakai buat
// render halaman Discord Notification Channel Setting.
app.get('/api/admin/notification-channels', requireAdmin, async (req, res) => {
  try {
    const rows = await webhookManager.getAll();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simpan/ubah channel Discord & status aktif satu kategori notifikasi.
// Berlaku langsung (realtime) — notifikasi berikutnya utk kategori ini
// otomatis terkirim ke channel baru, tanpa perlu restart server/bot.
app.put('/api/admin/notification-channels/:category', requireAdmin, async (req, res) => {
  try {
    const { discordChannelId, enabled } = req.body;
    const updated = await webhookManager.upsert(req.params.category, { discordChannelId, enabled });
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah channel notifikasi kategori "${updated.label || req.params.category}".`,
      meta: { category: req.params.category, enabled: updated.enabled, discordChannelId: updated.discordChannelId }
    }).catch(() => {});
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Kirim pesan uji coba ke satu kategori notifikasi. Body opsional
// { discordChannelId } dipakai kalau admin mau test channel yang baru
// dipilih SEBELUM disimpan.
app.post('/api/admin/notification-channels/:category/test', requireAdmin, async (req, res) => {
  try {
    const result = await webhookManager.testWebhook(req.params.category, req.body?.discordChannelId);
    logActivity({
      type: 'discord_webhook',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: result.sent ? 'success' : 'error',
      ip: getReqIp(req),
      description: `Admin mengirim test notification kategori "${req.params.category}".${result.sent ? '' : ' Gagal: ' + (result.error || '')}`,
      meta: { category: req.params.category, sent: result.sent }
    }).catch(() => {});
    if (!result.sent) return res.status(400).json({ error: result.error || 'Gagal mengirim test notification. Bot mungkin tidak punya permission ke channel ini.' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — PACKAGE NOTIFICATION EMBED BUILDER
// (Admin Web > Notification Package > Embed Builder — lihat packageEmbedManager.js)
// ══════════════════════════════════════════════════════════════════════════

// Daftar semua kategori notifikasi paket + status kustomisasinya + daftar
// dynamic variable yang tersedia — dipakai buat isi sidebar kategori & palet
// variable di Embed Builder.
app.get('/api/admin/package-embeds', requireAdmin, async (req, res) => {
  try {
    const events = await packageEmbedManager.listAll();
    res.json({ events, variables: packageEmbedManager.VARIABLES, limits: packageEmbedManager.LIMITS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ambil template AKTIF (dari DB kalau sudah pernah disimpan, else default)
// untuk satu event paket.
app.get('/api/admin/package-embeds/:event', requireAdmin, async (req, res) => {
  try {
    if (!packageEmbedManager.isValidEvent(req.params.event)) return res.status(404).json({ error: 'Event paket tidak dikenal.' });
    const template = await packageEmbedManager.getTemplate(req.params.event);
    res.json({ event: req.params.event, template });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Simpan template — divalidasi dulu terhadap batas Discord (poin 13) sebelum
// disimpan ke database (poin 10, tidak pernah hardcode di source code).
app.put('/api/admin/package-embeds/:event', requireAdmin, async (req, res) => {
  try {
    const saved = await packageEmbedManager.saveTemplate(req.params.event, req.body?.template, req.admin?.username);
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin menyimpan Package Embed Template untuk event "${packageEmbedManager.EVENT_MAP[req.params.event]?.label || req.params.event}".`,
      meta: { event: req.params.event }
    }).catch(() => {});
    res.json({ event: req.params.event, template: saved });
  } catch (e) {
    res.status(400).json({ error: e.message, validation: e.validation || undefined });
  }
});

// Reset ke default (poin 11) — selalu minta confirmation di sisi Admin Web
// SEBELUM memanggil endpoint ini.
app.post('/api/admin/package-embeds/:event/reset', requireAdmin, async (req, res) => {
  try {
    const template = await packageEmbedManager.resetTemplate(req.params.event);
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mereset Package Embed Template "${packageEmbedManager.EVENT_MAP[req.params.event]?.label || req.params.event}" ke default.`,
      meta: { event: req.params.event }
    }).catch(() => {});
    res.json({ event: req.params.event, template });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Kirim contoh notification (data dummy, BUKAN data user production — poin 12)
// ke channel yang sudah diatur di Notification Channel Setting untuk paket
// (configKey 'package_lifecycle') — channel TIDAK ditentukan di sini (poin 19).
app.post('/api/admin/package-embeds/:event/test', requireAdmin, async (req, res) => {
  try {
    if (!packageEmbedManager.isValidEvent(req.params.event)) return res.status(404).json({ error: 'Event paket tidak dikenal.' });
    // Boleh kirim template draft (belum disimpan) supaya admin bisa preview
    // hasil beneran di Discord sebelum Save — kalau tidak dikirim, pakai
    // template aktif dari database.
    const template = req.body?.template || await packageEmbedManager.getTemplate(req.params.event);
    const validation = packageEmbedManager.validateTemplate(template);
    if (!validation.ok) return res.status(400).json({ error: validation.errors[0], validation: validation.errors });

    const dummyCard = {
      username: 'Demo User', discordId: '000000000000000000',
      role: req.params.event === 'gold_trial' ? 'gold_trial' : (req.params.event === 'expired' ? 'public' : 'gold'),
      previousRole: 'public',
      duration: '30 Hari',
      activeUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      price: 'Rp50.000', orderId: 'TEST-12345',
      status: req.params.event === 'expired' ? '🔴 EXPIRED' : '🟢 AKTIF',
      admin: req.admin?.username || 'Admin'
    };
    const { embed, components } = packageEmbedManager.renderTemplate(template, dummyCard, { appName: APP_NAME });
    const result = await webhookManager.sendCategoryWebhook('purchase', {
      embed, plainEmbed: true, components, channelId: req.body?.channelId || undefined
    });
    logActivity({
      type: 'discord_webhook',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: result.sent ? 'success' : 'error',
      ip: getReqIp(req),
      description: `Admin mengirim test Package Embed "${packageEmbedManager.EVENT_MAP[req.params.event]?.label || req.params.event}".${result.sent ? '' : ' Gagal: ' + (result.error || result.reason || '')}`,
      meta: { event: req.params.event, sent: result.sent }
    }).catch(() => {});
    if (!result.sent) return res.status(400).json({ error: result.error || 'Gagal mengirim test — pastikan channel notifikasi Paket sudah diatur di Notification Channel Setting.' });
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

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — LIBRARY GAME (HubCap) — halaman BARU & TERPISAH TOTAL dari fitur
// Request Game milik App (/api/requests/browse). Sengaja ditulis dengan alur
// sendiri, tidak berbagi cache/state/logic apapun dengan endpoint itu:
//
//   - TIDAK ada enrich Steam appdetails sama sekali (nol panggilan Steam dari
//     server) — jadi TIDAK ada filter "game utama"/genre juga, karena filter
//     itu butuh data Steam yang sengaja tidak diambil di sini. Halaman ini
//     memang didesain buat nampilin APA ADANYA seluruh katalog HubCap secepat
//     mungkin, bukan katalog yang sudah disaring seperti di App.
//   - `page`+`limit` diteruskan LANGSUNG jadi `offset`+`limit` punya HubCap,
//     dan Total Data/Total Halaman dihitung dari `total_count` yang HubCap
//     sendiri kembalikan — TIDAK ada scan/akumulasi multi-batch seperti di
//     Request Game. Hasilnya: PERSIS 1x panggilan ke HubCap per halaman.
//   - Cover game diisi dari pola URL CDN publik Steam (`header.jpg`) yang
//     di-load LANGSUNG oleh browser Admin Web — server tidak nge-fetch
//     gambar apapun, jadi tidak menambah beban/latency sama sekali.
//   - Tetap pakai hubcapKeyManager.getKeyForFreeEndpoint() (bukan
//     getActiveKey()) karena /api/v1/library terdokumentasi resmi "Free -
//     No usage count": key yang sedang cooldown gara-gara kuota DOWNLOAD
//     habis harus tetap bisa dipakai buat browsing gratis ini, dan 429 di
//     sini cuma rate-limit sesaat (bukan kuota harian) — ini util key-
//     rotation yang sudah ada, dipakai apa adanya, BUKAN duplikasi fitur.
//
// Cache halaman super pendek (45 detik) sekadar meredam klik Previous/Next
// yang sangat cepat berulang ke halaman yang sama — bukan cache besar
// bergaya "full list" seperti Request Game.
// ══════════════════════════════════════════════════════════════════════════
const libraryGamePageCache = new Map(); // "search|page|limit" -> { data, fetchedAt }
const LIBRARY_GAME_CACHE_MS = 45 * 1000;

// HubCap kadang MEMANG menyertakan URL gambar sendiri di objek game-nya, tapi
// nama field-nya TIDAK BISA DIPASTIKAN (beda-beda tergantung versi/konfigurasi
// API mereka, dan tidak ada dokumentasi resmi yang kami pegang untuk field ini).
// PENTING (bug fix): sebelumnya fungsi ini cuma menebak SEDERET nama field yang
// SUDAH DITENTUKAN DI MUKA (`image`, `cover_url`, dst) — kalau nama field
// HubCap yang SEBENARNYA tidak ada di daftar itu, gambar tidak akan pernah
// ketemu walau datanya jelas-jelas ADA. Sekarang diganti jadi DETEKSI DINAMIS:
// scan SEMUA key di objek game (termasuk 1 level object bersarang seperti
// `images: {...}` / `media: {...}`), dan ambil value manapun yang (a) nama
// key-nya mengandung kata terkait gambar (image/cover/thumb/banner/icon/art/
// photo/poster/logo/picture/capsule/library/screenshot), DAN (b) isinya
// memang terlihat seperti URL gambar. Ini jauh lebih tahan terhadap variasi
// penamaan field APAPUN yang dipakai HubCap, tanpa perlu tahu persis skema
// API mereka lebih dulu.
const HUBCAP_IMAGE_KEY_HINT = /image|cover|thumb|banner|icon|art|photo|poster|logo|picture|capsule|library|screenshot/i;
function looksLikeImageUrl(v) {
  if (typeof v !== 'string' || v.length < 5) return false;
  if (/^https?:\/\//i.test(v)) {
    return /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(v) || /\/(image|cover|thumb|banner|icon|capsule|library)/i.test(v);
  }
  // Kemungkinan path RELATIF (tanpa domain) — mis. "/covers/12345.jpg" —
  // dianggap kandidat kalau memang berakhiran ekstensi gambar; nanti
  // di-lengkapi jadi URL absolut di normalizeHubcapImageUrl().
  return /^\/[^\s]+\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(v);
}
function normalizeHubcapImageUrl(v) {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/')) return `${HUBCAP_BASE_URL}${v}`;
  return v;
}
function pickHubcapImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 1) Cek langsung di field level teratas.
  for (const [k, v] of Object.entries(raw)) {
    if (HUBCAP_IMAGE_KEY_HINT.test(k) && looksLikeImageUrl(v)) return normalizeHubcapImageUrl(v);
  }
  // 2) Cek 1 level object bersarang (mis. `images: { header: '...' }`,
  //    `media: { cover: '...' }`, dst) — nama container-nya sendiri TIDAK
  //    harus cocok hint di atas, cukup salah satu key DI DALAMNYA yang cocok.
  for (const v of Object.values(raw)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (HUBCAP_IMAGE_KEY_HINT.test(k2) && looksLikeImageUrl(v2)) return normalizeHubcapImageUrl(v2);
      }
    }
  }
  return null;
}

// Diagnostik SEKALI SAJA per proses server (bukan tiap request — supaya tidak
// membanjiri log) — kalau pickHubcapImage() gagal menemukan gambar sama
// sekali untuk 1 item, cetak SELURUH key mentah item itu ke console (bukan
// isinya, cukup nama field-nya) supaya kalau ternyata nama field gambar
// HubCap masih tidak ke-tangkap oleh HUBCAP_IMAGE_KEY_HINT, bisa langsung
// ketahuan dari log server (mis. Railway logs) field APA yang sebenarnya
// tersedia, tanpa perlu akses manual ke API HubCap.
let _hubcapImageDiagLogged = false;
function logHubcapRawItemSampleOnce(raw, foundImage) {
  if (_hubcapImageDiagLogged || foundImage || !raw || typeof raw !== 'object') return;
  _hubcapImageDiagLogged = true;
  try {
    console.log('[HubCap Image Diagnostic] Tidak ketemu field gambar untuk 1 item contoh. Daftar field yang tersedia di item ini:', Object.keys(raw));
    console.log('[HubCap Image Diagnostic] Isi lengkap item contoh (buat cek manual nama field gambar yang benar):', JSON.stringify(raw).slice(0, 2000));
  } catch (e) { /* noop */ }
}

// Kandidat gambar Steam CDN (URL DITEBAK dari App ID, TANPA panggil Steam API
// sama sekali) — disusun dari yang PALING SERING tersedia ke yang paling
// jarang.
//
// PENTING (bug fix, dikonfirmasi user dari link asli HubCap): domain/path
// CDN gambar Steam yang BENAR & AKTIF SEKARANG adalah
// `shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appId}/...`
// — BUKAN `cdn.cloudflare.steamstatic.com/steam/apps/{appId}/...` atau
// `cdn.akamai.steamstatic.com/steam/apps/{appId}/...` seperti yang dipakai
// sebelumnya (pola lama itu kemungkinan besar sudah tidak konsisten aktif
// untuk banyak App ID, makanya banyak gambar 404/kosong). Domain BARU ini
// sekarang jadi kandidat PALING PERTAMA; domain lama tetap disertakan di
// urutan bawah sebagai cadangan (masih aktif untuk sebagian App ID).
function buildSteamCdnImageCandidates(appId) {
  return [
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg`,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
    `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`
  ];
}

// ══════════════════════════════════════════════════════════════════════════
// FIX (permintaan user): gambar dari HubCap sendiri (pickHubcapImage) ATAU
// tebakan pola CDN Steam (buildSteamCdnImageCandidates) SERING kosong/patah —
// banyak App ID yang gambarnya "gada" padahal Steam sebenarnya PUNYA gambar
// resminya. Solusinya: pakai Steam Store API (fetchSteamAppSummary, SUDAH ADA
// & sudah di-cache berlapis — memori 30 menit + DB 24 jam) sebagai SUMBER
// UTAMA gambar, bukan cuma tebakan. Supaya tetap CEPAT (tidak mengulang
// masalah "page 4+ lambat" yang pernah diperbaiki sebelumnya):
//   - Dipanggil BERSAMAAN per batch kecil (concurrency), bukan satu-satu.
//   - fetchSteamAppSummary() sendiri sudah cache 2 lapis, jadi kunjungan
//     ULANG ke halaman/App ID yang sama nyaris instan (tidak panggil Steam lagi).
//   - Hasil akhir per HALAMAN tetap di-cache 45 detik (libraryGamePageCache /
//     requestGameBrowseCache, sudah ada) — jadi biaya enrich ini cuma
//     ditanggung SEKALI per kombinasi search+page, bukan tiap request.
//   - Kalau Steam gagal/App ID itu memang tidak ada di Steam, tetap fallback
//     ke gambar HubCap lalu tebakan CDN seperti sebelumnya — TIDAK ADA game
//     yang jadi tanpa gambar sama sekali dibanding sebelum perbaikan ini.
const IMAGE_ENRICH_CONCURRENCY = 8;
async function enrichItemsWithSteamImages(items) {
  for (let i = 0; i < items.length; i += IMAGE_ENRICH_CONCURRENCY) {
    const chunk = items.slice(i, i + IMAGE_ENRICH_CONCURRENCY);
    await Promise.all(chunk.map(async (item) => {
      try {
        const summary = await fetchSteamAppSummary(item.appId);
        if (!summary) return; // App ID tidak ada di Steam / gagal fetch -> biarkan fallback yang sudah ada di item.images
        const steamImages = [summary.headerImage, summary.capsuleImageUrl, summary.libraryImageUrl].filter(Boolean);
        if (!steamImages.length) return;
        // Gambar Steam yang SUDAH TERVERIFIKASI ditaruh PALING DEPAN (dicoba
        // duluan di frontend), fallback lama (HubCap/tebakan CDN) tetap
        // disertakan setelahnya buat jaga-jaga.
        item.images = [...steamImages, ...(item.images || [])];
        item.headerImage = item.images[0];
      } catch (e) { /* best-effort — 1 App ID gagal tidak boleh gagalkan seluruh halaman */ }
    }));
  }
  return items;
}


app.get('/api/admin/library-game', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const search = String(req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const cacheKey = `${search.toLowerCase()}|${page}|${limit}`;
    const cached = libraryGamePageCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < LIBRARY_GAME_CACHE_MS) {
      return res.json(cached.data);
    }

    if (!(await hubcapKeyManager.hasActiveKey())) {
      return res.status(503).json({ error: 'Belum ada API Key HubCap yang dikonfigurasi. Tambahkan lewat halaman HubCap API.' });
    }

    let body = null;
    let lastErr = null;
    const MAX_ATTEMPTS = 3; // endpoint gratis -> aman dicoba ulang cepat pakai key lain kalau kena rate-limit sesaat
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const keyDoc = await hubcapKeyManager.getKeyForFreeEndpoint();
      if (!keyDoc) break;
      const hcRes = await axios.get(`${HUBCAP_BASE_URL}/api/v1/library`, {
        headers: { Authorization: `Bearer ${keyDoc.key}` },
        params: { limit, offset, search: search || undefined, sort_by: 'updated' },
        timeout: 15000,
        validateStatus: () => true
      });
      if (hcRes.status === 200) { body = hcRes.data; lastErr = null; break; }
      if (hcRes.status === 429) {
        hubcapKeyManager.markFreeEndpointRateLimited(keyDoc);
        lastErr = new Error('HubCap API sedang sibuk, coba lagi sebentar lagi.');
        continue;
      }
      if (hcRes.status === 401 || hcRes.status === 403) {
        await hubcapKeyManager.markError(keyDoc, `HTTP ${hcRes.status} saat GET /api/v1/library (Admin Library Game)`).catch(() => {});
        lastErr = new Error('API Key HubCap ditolak.');
        continue;
      }
      lastErr = new Error(`Gagal mengambil data dari HubCap (HTTP ${hcRes.status}).`);
      break;
    }
    if (!body) return res.status(502).json({ error: (lastErr && lastErr.message) || 'Gagal terhubung ke HubCap.' });

    const rawItems = body.games || body.results || body.data || (Array.isArray(body) ? body : []);
    const totalData = extractHubcapTotal(body) ?? rawItems.length;
    const totalPages = Math.max(1, Math.ceil(totalData / limit));

    // HubCap kadang MEMANG menyertakan URL gambar sendiri di objek game-nya
    // (nama field bisa beda-beda tergantung versi API) — itu yang harus dicoba
    // PALING PERTAMA (lihat pickHubcapImage di atas). Kalau tidak ada, baru
    // pakai pola CDN publik Steam sebagai cadangan, dan sediakan BEBERAPA
    // varian ukuran/CDN sekaligus (bukan cuma 1) supaya kalau salah satu
    // path/ukuran tidak tersedia untuk App ID tertentu, browser Admin bisa
    // otomatis coba varian berikutnya sebelum benar-benar dianggap "tidak ada
    // gambar". Semua ini TETAP tanpa satupun panggilan Steam API dari server.
    const items = rawItems.map(raw => {
      const appId = String(raw.game_id ?? raw.appid ?? raw.app_id ?? raw.id ?? '').trim();
      if (!appId) return null;
      const hubcapImage = pickHubcapImage(raw);
      logHubcapRawItemSampleOnce(raw, hubcapImage);
      const images = [hubcapImage, ...buildSteamCdnImageCandidates(appId)].filter(Boolean);
      return {
        appId,
        name: raw.game_name || raw.name || `App ${appId}`,
        sizeLabel: raw.size || raw.size_label || null,
        updatedAt: raw.updated || raw.updated_at || raw.modified || null,
        // `images`: daftar kandidat URL gambar, dicoba berurutan di frontend
        // (lihat admin.js) sampai salah satu berhasil dimuat.
        images,
        headerImage: images[0] || null // tetap disediakan buat kompatibilitas/kebutuhan lain
      };
    }).filter(Boolean);

    // Ganti/lengkapi kandidat gambar tebakan di atas dengan gambar ASLI dari
    // Steam Store API (lebih akurat, jarang patah) — lihat enrichItemsWithSteamImages().
    await enrichItemsWithSteamImages(items);

    const responseData = {
      items,
      pagination: { currentPage: page, totalPages, totalData, hasPrevious: page > 1, hasNext: page < totalPages, limit }
    };
    libraryGamePageCache.set(cacheKey, { data: responseData, fetchedAt: Date.now() });
    res.json(responseData);
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// Status koneksi bot Slash Command (/setpaket, /cekpaket, /createvoucher) —
// dipakai Admin Web buat nampilin apakah bot-nya online & command-nya
// sudah kedaftar, tanpa perlu buka Discord Developer Portal.
app.get('/api/admin/slash-commands/status', requireAdmin, (req, res) => {
  res.json(slashCommands.getStatus());
});

// Simpan mapping role Discord (gold/platinum → role ID). Notifikasi role_change
// dikirim lewat Discord Bot (discordNotifyManager) — channel-nya diatur di
// halaman Notifications Channel Setting, bukan di sini lagi.
app.put('/api/admin/role-sync/settings', requireAdmin, async (req, res) => {
  try {
    const { discordRoleMap, autoSyncFromDiscord, resetRoleOnLeave } = req.body;
    const updated = await roleSync.updateSettings({ discordRoleMap, autoSyncFromDiscord, resetRoleOnLeave });
    logActivity({
      type: 'settings_change',
      username: req.admin?.username || 'Admin',
      admin: req.admin?.username || 'Admin',
      status: 'success',
      ip: getReqIp(req),
      description: `Admin mengubah pengaturan Verify Role (mapping role Discord).`,
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

// `opts.verify` — opt-in EKSPLISIT (default: false/tidak ada) buat benar-benar
// mengecek ketersediaan file & ukurannya ke HubCap/Ryu (1 request = 1 potongan
// kuota harian API key). Default-nya SELALU false di mana-mana sekarang —
// baik "Search" satu-satu di form Tambah Game maupun Auto-Isi massal — karena
// endpoint cek-ketersediaan itu sama persis dengan endpoint download asli, jadi
// tetap kepotong dari kuota provider walau cuma buat preview. `manifestUrl`
// tetap otomatis terisi (diprediksi dari pola URL resmi tiap provider) tanpa
// perlu verifikasi live; ketersediaan sungguhan baru tervalidasi otomatis pas
// file itu benar-benar didownload user pertama kali. Admin yang mau memastikan
// dulu sebelum publish bisa klik tombol "🔍 Verifikasi Ketersediaan" (opt-in,
// 1 request per klik) di form Tambah Game.
async function lookupAppIdInfo(appId, provider, opts = {}) {
  const result = {
    appId,
    provider,
    name: null,
    description: null,
    fullDescription: null,
    imageUrl: null,
    capsuleImageUrl: null,
    libraryImageUrl: null,
    heroImageUrl: null,
    developer: null,
    publisher: null,
    releaseDate: null,
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
    // Genre Steam (Action/RPG/Sport/dst) + tebakan kategori admin yang paling cocok
    // (dicocokkan ke koleksi `categories` yang sudah ada) — dipakai fitur "Auto-Isi
    // Deskripsi/Kategori" di halaman Kelola Game supaya kategori yang kosong/salah
    // bisa ditebak otomatis, admin tetap bisa override manual.
    genres: [],
    suggestedCategorySlug: null,
    // Slug kategori hasil pencocokan/otomatis-dibuat dari SEMUA genre Steam
    // (urut sesuai relevansi genre di Steam, genre utama duluan), sudah dedup
    // case-insensitive. Dipakai simpan `game.categories` (array, maks 4 —
    // dipotong di pemanggil) supaya App bisa nampilkan multi-kategori/genre.
    categorySlugs: [],
    warnings: []

  };

  // 1) Steam Store API (publik, GRATIS, tanpa key) — SUMBER UTAMA nama/deskripsi/
  // kategori/genre/developer/publisher/tanggal rilis/gambar untuk KEDUA provider
  // (HubCap/Ryu sama sekali tidak dipakai untuk data-data ini, cuma dipakai buat
  // cek ketersediaan file manifest kalau opts.verify eksplisit di-set — lihat bawah).
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
      // Deskripsi lengkap (HTML dari Steam) — tag HTML dibuang biar rapi ditampilkan
      // sebagai teks biasa di form admin, tanpa membatasi panjangnya seperti short_description.
      if (d.about_the_game) {
        result.fullDescription = d.about_the_game.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
      }
      result.developer = Array.isArray(d.developers) && d.developers.length ? d.developers.join(', ') : null;
      result.publisher = Array.isArray(d.publishers) && d.publishers.length ? d.publishers.join(', ') : null;
      result.releaseDate = d.release_date?.date || null;

      // Capsule image — Steam appdetails kadang menyertakannya langsung (capsule_imagev5),
      // kalau tidak ada, fallback ke pola URL resmi CDN Steam yang hampir selalu tersedia.
      result.capsuleImageUrl = d.capsule_imagev5 || d.capsule_image || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg`;

      // Kategori Steam (mis. "Single-player", "Multi-player", "Online Co-op", "Online PvP", dst)
      // dipakai buat nebak apakah game ini punya mode online multiplayer atau murni offline.
      const catNames = (d.categories || []).map(c => c.description).filter(Boolean);
      result.categories = catNames;
      const ONLINE_HINT = /online|multi-?player|co-?op|pvp|mmo/i;
      const hasOnlineHint = catNames.some(c => ONLINE_HINT.test(c));
      // Kalau kategorinya CUMA "Single-player" tanpa hint online sama sekali → offline.
      result.isOnlineSuggested = catNames.length ? hasOnlineHint : null;

      // Genre Steam (beda dari "categories" di atas — genre itu genre GAMEPLAY seperti
      // Action/RPG/Sports/Puzzle, ini yang paling relevan buat ditebak jadi kategori
      // admin di Dashboard, bukan mode single/multiplayer-nya).
      const genreNames = (d.genres || []).map(g => g.description).filter(Boolean);
      result.genres = genreNames;
      if (genreNames.length) {
        // Cocokkan SEMUA genre Steam ke kategori admin (case-insensitive) —
        // kategori yang belum ada OTOMATIS DIBUAT, kategori yang sudah ada
        // langsung dipakai ulang (tidak pernah dobel). Lihat resolveCategorySlugsForGenres().
        result.categorySlugs = await resolveCategorySlugsForGenres(genreNames);
        result.suggestedCategorySlug = result.categorySlugs[0] || null;
      }
    } else {
      result.warnings.push('App ID tidak ditemukan di Steam Store.');
    }
  } catch (e) {
    result.warnings.push('Gagal mengambil data dari Steam Store.');
  }

  // 1b) Library (portrait 600x900) & Hero/Banner — TIDAK dikembalikan appdetails,
  // cuma tersedia lewat pola URL CDN resmi Steam (cdn.cloudflare.steamstatic.com,
  // BUKAN HubCap/Ryu). Tidak semua game punya asset ini (terutama game lama), jadi
  // dicek dulu pakai HEAD request murni ke CDN Steam sebelum dipakai — kalau 404,
  // dibiarkan null (gambar lama di database TETAP dipertahankan, tidak ditimpa).
  try {
    const libraryUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
    const heroUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_hero.jpg`;
    const [libRes, heroRes] = await Promise.all([
      axios.head(libraryUrl, { timeout: 8000, validateStatus: () => true }).catch(() => ({ status: 0 })),
      axios.head(heroUrl, { timeout: 8000, validateStatus: () => true }).catch(() => ({ status: 0 }))
    ]);
    if (libRes.status === 200) result.libraryImageUrl = libraryUrl;
    if (heroRes.status === 200) result.heroImageUrl = heroUrl;
  } catch (e) { /* best-effort — gambar library/hero opsional, lewati kalau gagal dicek */ }

  // 2) Ketersediaan file & ukurannya di provider yang dipilih (HubCap/Ryu).
  //
  //    PENTING — BUG FIX: endpoint yang dipakai buat "ngecek" ketersediaan file
  //    (checkHubcapManifest/checkRyuManifest) itu SAMA PERSIS dengan endpoint
  //    DOWNLOAD asli (cuma stream-nya langsung di-destroy di sisi kita begitu
  //    header/status masuk) — tapi provider-nya (hubcapmanifest/Ryu) TETAP
  //    menghitungnya sebagai request ke endpoint download, jadi tetap memotong
  //    kuota harian API key walau file-nya tidak benar-benar diunduh penuh.
  //    Sebelum fix ini, "Search" satu-satu di form Tambah Game MASIH memanggil
  //    live check ini tiap kali admin klik Search (beda dari Auto-Isi massal
  //    yang sudah lebih dulu di-skip) — jadi tiap kali cari App ID buat isi
  //    nama/deskripsi/kategori, 1 kuota API key ikut kepotong sia-sia, padahal
  //    fitur itu semestinya cuma butuh Steam Store API (gratis, tanpa key).
  //
  //    Sekarang: live check TIDAK PERNAH dipanggil otomatis lagi — baik pas
  //    Search satu-satu maupun Auto-Isi massal. `manifestUrl` tetap otomatis
  //    terisi (diprediksi langsung dari pola URL resmi tiap provider), supaya
  //    field Link Manifest di form Tambah Game tetap ke-auto-fill dan game bisa
  //    langsung disimpan & didownload user seperti biasa — ketersediaan
  //    sebenarnya baru betul-betul divalidasi pas SUNGGUHAN didownload pertama
  //    kali oleh user (lihat streamHubcapManifest/streamRyuManifest), itu baru
  //    pemakaian kuota yang wajar & memang perlu.
  //
  //    Kalau admin memang mau memastikan dulu sebelum publish (opsional, PAKAI
  //    kuota API key secukupnya — 1 request per klik), sediakan opt-in lewat
  //    `opts.verify: true` (dipicu tombol "🔍 Verifikasi Ketersediaan" di UI).
  result.manifestUrl = provider === 'ryu'
    ? `${RYU_BASE_URL}/api/download/${appId}`
    : `${HUBCAP_BASE_URL}/api/v1/manifest/${appId}`;

  if (opts.verify) {
    try {
      if (provider === 'ryu') {
        const rc = await checkRyuManifest(appId);
        result.hubcapConfigured = rc.configured;
        result.hasManifest = rc.hasManifest;
        result.sizeBytes = rc.sizeBytes;
        result.sizeLabel = formatBytes(rc.sizeBytes);
        if (rc.error) result.warnings.push(rc.error);
        if (rc.configured && rc.hasManifest === false) result.warnings.push('File untuk App ID ini belum tersedia di Ryu API.');
        if (!rc.configured) result.warnings.push('Belum ada API Key Ryu yang aktif (Admin Web > Hubcap API > tab Ryu API).');
      } else {
        const hc = await checkHubcapManifest(appId);
        result.hubcapConfigured = hc.configured;
        result.hasManifest = hc.hasManifest;
        result.sizeBytes = hc.sizeBytes;
        result.sizeLabel = formatBytes(hc.sizeBytes);
        if (hc.error) result.warnings.push(hc.error);
        if (hc.configured && hc.hasManifest === false) result.warnings.push('Manifest untuk App ID ini belum tersedia di hubcapmanifest.');
        if (!hc.configured) result.warnings.push('Belum ada API Key HubCap yang aktif (Admin Web > Hubcap API).');
      }
    } catch (e) {
      result.warnings.push(provider === 'ryu' ? 'Gagal mengecek Ryu API.' : 'Gagal mengecek hubcapmanifest.');
    }
  } else {
    result.hubcapConfigured = null; // n/a — sengaja tidak dicek, lihat catatan di atas
    result.hasManifest = null;
  }

  return result;
}

app.get('/api/admin/appid-lookup/:appId', requireAdmin, async (req, res) => {
  const appId = String(req.params.appId).trim();
  if (!/^\d+$/.test(appId)) return res.status(400).json({ error: 'App ID harus berupa angka (App ID Steam).' });

  // Provider file/manifest yang mau dicek — 'hubcap' (default, backward compatible)
  // atau 'ryu' (Ryu API, fallback kalau HubCap kehabisan kuota). Nama & foto TETAP
  // dari Steam Store API terlepas dari provider yang dipilih (tidak ada bedanya).
  const provider = req.query.provider === 'ryu' ? 'ryu' : 'hubcap';
  // verify=1 — opt-in EKSPLISIT dari tombol "🔍 Verifikasi Ketersediaan" di form
  // Tambah Game. TANPA parameter ini (kondisi normal tiap kali Search), TIDAK ADA
  // request ke HubCap/Ryu API sama sekali — lihat catatan lengkap di lookupAppIdInfo().
  const verify = req.query.verify === '1';
  const result = await lookupAppIdInfo(appId, provider, { verify });
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — AUTO-ISI MASSAL (Deskripsi/Kategori & Gambar) buat Games & Bypass
// yang sudah ada di database. Dipakai tombol "🔧 Auto-Isi Deskripsi/Kategori"
// dan "🖼️ Auto-Isi/Ganti Gambar" di halaman Kelola Game & Kelola Bypass —
// jalan ke SEMUA item yang punya App ID Steam, pakai pipeline lookup yang
// sama seperti pas nambah 1 game manual (Steam Store API buat nama/deskripsi/
// gambar/genre + HubCap/Ryu buat cek manifest tersedia/tidak).
// Sengaja diproses SATU-SATU (bukan Promise.all) + jeda kecil antar item biar
// tidak menghajar rate-limit Steam Store API maupun kuota API key HubCap/Ryu.
// ══════════════════════════════════════════════════════════════════════════
const AUTO_FILL_DELAY_MS = 250; // jeda antar item — sengaja diproses satu-satu (bukan Promise.all) biar Steam Store API / kuota HubCap-Ryu tidak overload/rate-limit
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Lock server-side (BUKAN cuma flag di client) — mencegah dua proses Auto-Isi
// yang sama jalan bersamaan (mis. admin double-klik, atau dua tab admin
// kebuka bareng), yang bisa bikin request dobel ke Steam/HubCap sekaligus.
const _autoFillActiveJobs = new Set();

// ── Runner generik dipakai ke-4 kombinasi (games/bypasses × info/images).
// Realtime: tiap 1 item selesai diproses, langsung broadcast progress ke semua
// admin yang lagi buka Dashboard/Kelola Game/Bypass lewat WebSocket
// ('autofill:progress') — TANPA nunggu seluruh batch selesai. Response HTTP
// akhir tetap dikirim di akhir (buat admin yang WS-nya sempat putus).
async function runAutoFillJob({ jobId, kind, targetCollection, getAppId, getProvider, adminUsername, ip }) {
  const query = targetCollection === 'bypasses'
    ? { $or: [{ appId: { $nin: ['', null] } }, { steamAppId: { $nin: ['', null] } }] }
    : { appId: { $ne: null, $exists: true, $nin: ['', null] } };
  const items = await db.collection(targetCollection).find(query).toArray();
  const total = items.length;
  const targetLabel = targetCollection === 'games' ? 'Game' : 'Bypass';
  const kindLabel = kind === 'info' ? 'Deskripsi/Kategori' : 'Gambar';

  logActivity({
    type: `admin_auto_fill_${targetCollection}_${kind}_start`,
    admin: adminUsername || 'Admin', status: 'success', ip,
    description: `Admin memulai Auto-Isi ${kindLabel} untuk ${total} ${targetLabel.toLowerCase()}.`,
    meta: { jobId, total }
  }).catch(() => {});

  broadcastAdmin('autofill:progress', { jobId, kind, target: targetCollection, phase: 'start', processed: 0, total, success: 0, failed: 0, notFound: 0, skipped: 0 });

  let success = 0, failed = 0, notFound = 0, skipped = 0;
  const results = [];
  const startedAt = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const appId = getAppId(item);
    let entry;
    // Retry otomatis (maks 2x percobaan ULANG, jadi total 3x) khusus untuk error
    // jaringan/API sesaat (timeout, ECONNRESET, 5xx) — bukan untuk "App ID tidak
    // ditemukan" (itu bukan error, App ID-nya memang tidak valid, percuma diulang).
    const MAX_ATTEMPTS = 3;
    let info = null, lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // opts.verify sengaja TIDAK di-set (default false) — Auto-Isi (info maupun
        // gambar) sama sekali tidak butuh data manifest/ukuran file, jadi request ke
        // HubCap/Ryu API (yang makan kuota key) tidak pernah dipanggil di sini. Cuma
        // Steam Store API (gratis) yang dipanggil.
        info = await lookupAppIdInfo(String(appId), getProvider(item));
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt); // backoff kecil sebelum retry
      }
    }

    try {
      if (lastError) throw lastError; // 3x percobaan tetap gagal semua -> masuk hitungan "failed"

      if (!info.name) {
        // Steam appdetails balik success:false — App ID ini genuinely gak ada/invalid,
        // beda dari "gagal proses" (error jaringan/API down).
        notFound++;
        entry = { id: String(item._id), name: item.name, status: 'not_found', reason: info.warnings[0] || 'App ID tidak ditemukan di Steam Store.' };
      } else if (kind === 'info') {
        const update = {}; const fields = [];
        // Nama HANYA diganti kalau field-nya masih kosong ATAU nama dari Steam jelas
        // lebih lengkap (lebih panjang & beda) dari yang tersimpan — supaya nama yang
        // sudah sengaja disesuaikan admin tidak tertimpa begitu saja.
        if (info.name && (!item.name || (info.name !== item.name && info.name.length > (item.name || '').length))) {
          update.name = info.name; fields.push('name');
        }
        if (info.description && info.description !== item.description) { update.description = info.description; fields.push('description'); }
        if (info.fullDescription && info.fullDescription !== item.fullDescription) { update.fullDescription = info.fullDescription; fields.push('fullDescription'); }
        if (info.developer && info.developer !== item.developer) { update.developer = info.developer; fields.push('developer'); }
        if (info.publisher && info.publisher !== item.publisher) { update.publisher = info.publisher; fields.push('publisher'); }
        if (info.releaseDate && info.releaseDate !== item.releaseDate) { update.releaseDate = info.releaseDate; fields.push('releaseDate'); }
        if (info.genres?.length) {
          const genreLabel = info.genres.join(', ');
          if (genreLabel !== item.genre) { update.genre = genreLabel; fields.push('genre'); }
          // Maks 4 genre paling utama (urutan asli dari Steam = urutan relevansi)
          // buat ditampilkan sebagai tag/chip genre di Dashboard App.
          const topGenres = info.genres.slice(0, 4);
          if (JSON.stringify(topGenres) !== JSON.stringify(item.genres || [])) {
            update.genres = topGenres; fields.push('genres');
          }
        }
        if (info.categorySlugs?.length) {
          // Maks 4 kategori paling relevan (urutan sama seperti genre Steam-nya).
          const topCategorySlugs = info.categorySlugs.slice(0, 4);
          if (JSON.stringify(topCategorySlugs) !== JSON.stringify(item.categories || [])) {
            update.categories = topCategorySlugs; fields.push('categories');
          }
          // Field `category` (tunggal, kategori paling utama) TETAP dipertahankan
          // buat backward-compat sama filter/kode lama yang masih pakai 1 kategori.
          if (topCategorySlugs[0] && topCategorySlugs[0] !== item.category) {
            update.category = topCategorySlugs[0]; fields.push('category');
          }
        } else if (info.suggestedCategorySlug && info.suggestedCategorySlug !== item.category) {
          update.category = info.suggestedCategorySlug; fields.push('category');
        }
        if (Object.keys(update).length) {
          await db.collection(targetCollection).updateOne({ _id: item._id }, { $set: update });
          success++;
          entry = { id: String(item._id), name: item.name, status: 'success', fields };
        } else {
          skipped++;
          entry = { id: String(item._id), name: item.name, status: 'skipped', reason: 'Sudah sesuai / tidak ada saran baru.' };
        }
      } else { // kind === 'image' — gambar lama TIDAK PERNAH dihapus/ditimpa null kalau yang baru tidak ketemu/sama
        const update = {}; const fields = [];
        if (info.imageUrl && info.imageUrl !== item.imageUrl) { update.imageUrl = info.imageUrl; fields.push('cover'); }
        if (info.capsuleImageUrl && info.capsuleImageUrl !== item.capsuleImageUrl) { update.capsuleImageUrl = info.capsuleImageUrl; fields.push('capsule'); }
        if (info.libraryImageUrl && info.libraryImageUrl !== item.libraryImageUrl) { update.libraryImageUrl = info.libraryImageUrl; fields.push('library'); }
        if (info.heroImageUrl && info.heroImageUrl !== item.heroImageUrl) { update.heroImageUrl = info.heroImageUrl; fields.push('hero'); }

        if (!info.imageUrl && !item.imageUrl) {
          notFound++;
          entry = { id: String(item._id), name: item.name, status: 'not_found', reason: 'Gambar tidak ditemukan di Steam.' };
        } else if (Object.keys(update).length) {
          await db.collection(targetCollection).updateOne({ _id: item._id }, { $set: update });
          success++;
          entry = { id: String(item._id), name: item.name, status: 'success', fields };
        } else {
          skipped++;
          entry = { id: String(item._id), name: item.name, status: 'skipped', reason: 'Gambar sudah sama, tidak perlu diperbarui.' };
        }
      }
    } catch (e) {
      failed++;
      entry = { id: String(item._id), name: item.name, status: 'failed', reason: e.message };
    }

    results.push(entry);
    const elapsedMs = Date.now() - startedAt;
    const avgMsPerItem = (i + 1) > 0 ? elapsedMs / (i + 1) : 0;
    const etaMs = Math.max(0, Math.round(avgMsPerItem * (total - (i + 1))));
    broadcastAdmin('autofill:progress', {
      jobId, kind, target: targetCollection, phase: 'progress',
      processed: i + 1, total, success, failed, notFound, skipped, etaMs,
      currentItem: { name: item.name, status: entry.status, reason: entry.reason || null }
    });
    if (i < items.length - 1) await sleep(AUTO_FILL_DELAY_MS);
  }

  logActivity({
    type: `admin_auto_fill_${targetCollection}_${kind}`,
    admin: adminUsername || 'Admin', status: failed > 0 ? 'warning' : 'success', ip,
    description: `Auto-Isi ${kindLabel} ${targetLabel} selesai: ${success} berhasil, ${failed} gagal, ${notFound} tidak ditemukan, ${skipped} dilewati (dari ${total}).`,
    meta: { jobId, total, success, failed, notFound, skipped }
  }).catch(() => {});

  if (failed > 0) {
    // Log terpisah khusus error API, biar gampang ditemukan di halaman Logs
    // tanpa harus buka detail tiap item satu-satu.
    logActivity({
      type: 'system_error',
      admin: adminUsername || 'Admin', status: 'warning', ip,
      description: `${failed} item gagal diproses saat Auto-Isi ${kindLabel} ${targetLabel} (error API/jaringan). Lihat detail di ringkasan proses.`,
      meta: { jobId, failedItems: results.filter(r => r.status === 'failed').slice(0, 20) }
    }).catch(() => {});
  }

  broadcastAdmin('autofill:progress', { jobId, kind, target: targetCollection, phase: 'done', processed: total, total, success, failed, notFound, skipped });

  if (success > 0) {
    if (targetCollection === 'games') broadcastGamesUpdate();
    else broadcastBypassesUpdate();
  }

  return { total, success, failed, notFound, skipped, results };
}

function autoFillRoute(targetCollection, kind, getAppId, getProvider) {
  return async (req, res) => {
    const jobKey = `${targetCollection}:${kind}`;
    if (_autoFillActiveJobs.has(jobKey)) {
      return res.status(409).json({ error: `Auto-Isi ${kind === 'info' ? 'Deskripsi/Kategori' : 'Gambar'} untuk ${targetCollection === 'games' ? 'Game' : 'Bypass'} masih berjalan, tunggu sampai selesai.` });
    }
    _autoFillActiveJobs.add(jobKey);
    const jobId = (req.body && req.body.jobId) || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const summary = await runAutoFillJob({
        jobId, kind, targetCollection, getAppId, getProvider,
        adminUsername: req.admin?.username, ip: getReqIp(req)
      });
      res.json({ jobId, ...summary });
    } catch (e) {
      broadcastAdmin('autofill:progress', { jobId, kind, target: targetCollection, phase: 'error', error: e.message });
      res.status(500).json({ error: e.message });
    } finally {
      _autoFillActiveJobs.delete(jobKey);
    }
  };
}

app.post('/api/admin/games/auto-fill-info', requireAdmin,
  autoFillRoute('games', 'info', g => g.appId, g => g.provider === 'ryu' ? 'ryu' : 'hubcap'));
app.post('/api/admin/games/auto-fill-images', requireAdmin,
  autoFillRoute('games', 'image', g => g.appId, g => g.provider === 'ryu' ? 'ryu' : 'hubcap'));
app.post('/api/admin/bypasses/auto-fill-info', requireAdmin,
  autoFillRoute('bypasses', 'info', b => b.appId || b.steamAppId, () => 'hubcap'));
app.post('/api/admin/bypasses/auto-fill-images', requireAdmin,
  autoFillRoute('bypasses', 'image', b => b.appId || b.steamAppId, () => 'hubcap'));

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
// PUBLIC API — Landing Page (Netlify). Semua rute di bawah SENGAJA tanpa
// requireUser/requireAdmin (website belum tentu ada sesi login), dan HANYA
// mengembalikan field yang aman untuk publik (tidak ada manifestUrl/zipUrl,
// token, atau data internal lain). Sumber data selalu dari DB/Admin Web,
// TIDAK ada yang di-hardcode di sisi website.
// ══════════════════════════════════════════════════════════════════════════

// Statistik realtime untuk Hero Section (Total Game, Total User, Total Download).
// Mode 'manual' (diatur di Website Settings) dipakai kalau admin ingin override
// angka yang ditampilkan; default 'auto' menghitung langsung dari DB.
app.get('/api/public/stats', async (req, res) => {
  try {
    const [gamesCount, usersCount, downloadsCount] = await Promise.all([
      db.collection('games').countDocuments({}),
      db.collection('users').countDocuments({}),
      db.collection('history').countDocuments({})
    ]);
    const stats = await websiteSettingsManager.getPublicStats({ gamesCount, usersCount, downloadsCount });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar game untuk halaman "Games" — realtime dari collection `games`, dengan
// search (nama), filter genre/kategori, dan pagination di sisi server supaya
// ringan buat website (tidak perlu load semua game sekaligus).
app.get('/api/public/games', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(48, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const search = String(req.query.search || '').trim();
    const genre = String(req.query.genre || '').trim();

    const query = {};
    if (search) query.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (genre) query.$or = [{ category: genre }, { categories: genre }, { genres: genre }];

    const [total, rows] = await Promise.all([
      db.collection('games').countDocuments(query),
      db.collection('games')
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray()
    ]);

    res.json({
      games: rows.map(g => ({
        id: g._id,
        name: g.name,
        description: g.description || '',
        cover: g.capsuleImageUrl || g.imageUrl || g.libraryImageUrl || '',
        genres: (Array.isArray(g.genres) && g.genres.length ? g.genres : (g.genre ? String(g.genre).split(',').map(s => s.trim()).filter(Boolean) : [])).slice(0, 4),
        category: g.category || null,
        status: g.isOnline !== false ? 'online' : 'offline',
        developer: g.developer || null,
        publisher: g.publisher || null
      })),
      page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar genre/kategori aktif — dipakai buat dropdown filter di halaman Games.
app.get('/api/public/genres', async (req, res) => {
  try {
    const categories = await db.collection('categories')
      .find({ isActive: { $ne: false } })
      .sort({ order: 1, name: 1 })
      .toArray();
    res.json(categories.map(c => ({ slug: c.slug, name: c.name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar paket (Public/Gold/Platinum) — pakai fungsi publik yang sama dengan
// App (packageManager.getPackagesPublic), jadi harga & benefit SELALU sinkron
// dengan halaman "Upgrade Paket" di Admin Web.
app.get('/api/public/packages', async (req, res) => {
  try {
    const packages = await packageManager.getPackagesPublic();
    res.json({ packages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FAQ — dikelola dari halaman Website Settings di Admin Web.
app.get('/api/public/faq', async (req, res) => {
  try {
    const cfg = await websiteSettingsManager.getSettings();
    res.json({ faq: websiteSettingsManager.toPublicFaq(cfg) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pengaturan umum website (Hero, Banner, Logo, Discord, System Requirements,
// Versi Website). Info Download EXE (versi/changelog/ukuran file/link) dari
// /api/app-update (endpoint publik yang sudah ada) — satu sumber data yang
// sama dengan App, tidak diduplikasi di sini.
app.get('/api/public/website-settings', async (req, res) => {
  try {
    const cfg = await websiteSettingsManager.getSettings();
    res.json(websiteSettingsManager.toPublicPayload(cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin Web: halaman "Website Settings" ──
app.get('/api/admin/website-settings', requireAdmin, async (req, res) => {
  try {
    res.json(await websiteSettingsManager.getSettings());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/website-settings', requireAdmin, async (req, res) => {
  try {
    const next = await websiteSettingsManager.updateSettings(req.body || {}, req.admin?.username || 'Admin');
    logActivity({
      type: 'settings_change', username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin',
      status: 'success', ip: getReqIp(req),
      description: `Admin mengubah pengaturan Website (Landing Page) — Hero Title: "${next.heroTitle}".`,
      meta: { statsMode: next.statsMode }
    }).catch(() => {});
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
        message: `Masa aktif paket ${roleLabelUpper(u.role)} kamu tersisa sekitar ${hoursLeft} jam lagi. Perpanjang sekarang biar tidak terputus.`,
        dm: true, webhook: true,
        packageCard: {
          event: 'expiring',
          description: `Masa aktif paket kamu tersisa sekitar ${fmtDurationMs(msLeft) || `${hoursLeft} jam`} lagi. Perpanjang sekarang biar tidak terputus.`,
          username: u.username,
          role: u.role,
          duration: fmtDurationMs(msLeft) || `${hoursLeft} jam`,
          activeLabel: 'Berakhir Pada',
          activeUntil: u.activeUntil,
          status: '🟡 HAMPIR BERAKHIR'
        }
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
          // Live Chat Support — begitu Admin pertama online, semua User yang lagi
          // buka Floating Chat Widget langsung lihat status "🟢 Online" tanpa refresh.
          if (adminWsClients.size === 1) wsBroadcastAll('livechat:adminStatus', { online: true });
          ws.on('close', () => {
            wsUnregisterAdmin(ws);
            if (adminWsClients.size === 0) wsBroadcastAll('livechat:adminStatus', { online: false });
          });
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
    // Live Chat Support — kirim status Admin saat ini begitu User connect, biar
    // header Floating Chat Widget langsung benar sejak awal (tidak perlu nunggu
    // Admin connect/disconnect buat tahu statusnya).
    ws.send(JSON.stringify({ event: 'livechat:adminStatus', data: { online: adminWsClients.size > 0 } }));

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
// REQUEST GAME — App user (Gold/Platinum) bisa request game dari katalog
// HubCap Library yang belum ada di aplikasi. Admin approve (isi form Add Game
// yang sudah keisi otomatis) atau reject (boleh kasih alasan). Semua realtime
// lewat WebSocket (wsSendToUser ke user yang bersangkutan, broadcastAdmin ke
// Admin Web yang lagi buka halaman Request Game).
//
// Sumber data:
//   - HubCap Library API (/api/v1/library) — daftar App ID yang FILE-nya
//     tersedia buat di-download/inject (ini yang menentukan game APA SAJA
//     yang boleh direquest — HubCap tidak punya genre/deskripsi/screenshot).
//   - Steam Store API (appdetails, publik/gratis) — metadata lengkap (nama,
//     genre, deskripsi, developer, publisher, tanggal rilis, screenshot,
//     banner/cover) SEKALIGUS dipakai buat filter "hanya game utama" lewat
//     field `type` bawaan Steam (game/dlc/demo/music/dst) — sumber yang
//     paling akurat untuk itu, bukan tebak-tebakan dari nama doang.
// ══════════════════════════════════════════════════════════════════════════
// Limit harian per paket sekarang diatur Admin lewat DB (lihat
// getRequestGameSettingsDoc() & REQUEST_GAME_SETTINGS_ID di bawah), bukan
// hardcoded lagi — konstanta lama dihapus supaya tidak ada 2 sumber kebenaran.
const REQUEST_GAME_EXCLUDE_NAME = /\b(demo|beta|soundtrack|ost|dedicated server|artbook|art book|tech test|playtest|closed test)\b/i;

// Cache appdetails Steam per App ID (RAM, TTL 30 menit) — di-share oleh SEMUA
// user yang browsing Request Game, supaya tidak nembak Steam berkali-kali
// buat App ID yang sama dalam waktu berdekatan (banyak user browsing katalog
// yang sama). Steam appdetails publik & gratis, tapi tetap sopan ke pihak luar.
const steamAppSummaryCache = new Map(); // appId -> { data, fetchedAt }
const STEAM_SUMMARY_CACHE_MS = 30 * 60 * 1000;
// TTL khusus untuk hasil GAGAL (result null) — jauh lebih pendek dari cache
// sukses, supaya App ID yang sempat gagal (mis. Steam lagi flaky) dicoba lagi
// dalam waktu singkat, bukan dianggap "gagal permanen" berjam-jam/berhari-hari.
const STEAM_SUMMARY_NEGATIVE_TTL_MS = 3 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════════
// FIX (permintaan user): halaman Request Game App sebelumnya pakai pipeline
// akumulasi+enrich Steam PER APP ID (lihat riwayat di atas) — walau sudah
// di-cache berlapis, pendekatan itu TETAP lambat & tidak lengkap di keadaan
// cache dingin/kombinasi search yang jarang, karena tetap butuh MEMANGGIL
// STEAM SATU-SATU untuk setiap App ID di katalog HubCap sebelum tahu itu
// "game utama" atau bukan. Diganti total: browse Request Game SEKARANG
// PERSIS SAMA seperti /api/admin/library-game (Library Game Admin Web) yang
// terbukti cepat & menampilkan SEMUA game — TIDAK ADA panggilan Steam sama
// sekali di jalur listing ini. Nama/ukuran/gambar langsung dari data HubCap
// + pola CDN Steam (tanpa request tambahan), filter "bukan Demo/DLC/dst"
// cukup lewat regex nama (instan, tanpa API call). Steam TETAP dipakai di
// halaman Detail (1 App ID, bukan daftar) dan saat submit Request — di situ
// panggilan tunggal tidak masalah performanya.
const requestGameBrowseCache = new Map(); // "search|page" -> { data, fetchedAt }
const REQUEST_GAME_BROWSE_CACHE_MS = 45 * 1000; // sama seperti LIBRARY_GAME_CACHE_MS punya admin

async function fetchRequestGameBrowsePage(search, page, limit) {
  const cacheKey = `${search.toLowerCase()}|${page}|${limit}`;
  const cached = requestGameBrowseCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < REQUEST_GAME_BROWSE_CACHE_MS) return cached.data;

  const offset = (page - 1) * limit;
  let body = null;
  let lastErr = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Endpoint /api/v1/library GRATIS (tidak potong kuota harian) — pakai
    // getKeyForFreeEndpoint() sama seperti Library Game Admin, supaya browsing
    // Request Game tidak ikut kena cooldown kuota download.
    const keyDoc = await hubcapKeyManager.getKeyForFreeEndpoint();
    if (!keyDoc) throw Object.assign(new Error('HubCap API Key belum dikonfigurasi admin. Coba lagi nanti.'), { code: 'NO_KEY' });
    const hcRes = await axios.get(`${HUBCAP_BASE_URL}/api/v1/library`, {
      headers: { Authorization: `Bearer ${keyDoc.key}` },
      params: { limit, offset, search: search || undefined, sort_by: 'updated' },
      timeout: 15000,
      validateStatus: () => true
    });
    if (hcRes.status === 200) { body = hcRes.data; lastErr = null; break; }
    if (hcRes.status === 429) {
      hubcapKeyManager.markFreeEndpointRateLimited(keyDoc);
      lastErr = Object.assign(new Error('HubCap API sedang sibuk, coba lagi sebentar lagi.'), { code: 'LIMITED' });
      continue;
    }
    if (hcRes.status === 401 || hcRes.status === 403) {
      await hubcapKeyManager.markError(keyDoc, `HTTP ${hcRes.status} saat GET /api/v1/library (Request Game)`).catch(() => {});
      lastErr = Object.assign(new Error('HubCap API Key ditolak.'), { code: 'LIMITED' });
      continue;
    }
    lastErr = Object.assign(new Error(`Gagal mengambil data dari HubCap (HTTP ${hcRes.status}).`), { code: 'FETCH_FAILED' });
    break;
  }
  if (!body) throw (lastErr || new Error('Gagal terhubung ke HubCap.'));

  const rawItems = body.games || body.results || body.data || (Array.isArray(body) ? body : []);
  const totalData = extractHubcapTotal(body) ?? rawItems.length;

  // Filter "hanya game utama" — CUMA regex nama (instan, tanpa API call sama
  // sekali), sama seperti jaring pengaman REQUEST_GAME_EXCLUDE_NAME yang sudah
  // ada. Tidak ada lagi filter berbasis `type` Steam di jalur listing ini.
  const items = rawItems.map(raw => {
    const appId = String(raw.game_id ?? raw.appid ?? raw.app_id ?? raw.id ?? '').trim();
    if (!appId) return null;
    const name = raw.game_name || raw.name || `App ${appId}`;
    if (REQUEST_GAME_EXCLUDE_NAME.test(name)) return null;
    const hubcapImage = pickHubcapImage(raw);
    logHubcapRawItemSampleOnce(raw, hubcapImage);
    const images = [hubcapImage, ...buildSteamCdnImageCandidates(appId)].filter(Boolean);
    return { appId, name, images, headerImage: images[0] || null, sizeLabel: raw.size || raw.size_label || null };
  }).filter(Boolean);

  // Sama seperti Library Game Admin — lengkapi/gantikan kandidat gambar tebakan
  // dengan gambar ASLI dari Steam Store API supaya tidak ada lagi game yang
  // "gambarnya gada" padahal sebenarnya tersedia (lihat enrichItemsWithSteamImages()).
  await enrichItemsWithSteamImages(items);

  const data = { items, totalData };
  requestGameBrowseCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}
// HubCap kadang menyertakan total keseluruhan katalog di response (nama field
// bisa beda-beda tergantung versi API mereka) — dicoba beberapa kemungkinan
// nama field yang umum dipakai. Kalau tidak ada satupun, return null (fallback
// ke jumlah item di halaman ini saja — lihat totalData di endpoint pemanggil).
function extractHubcapTotal(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [body.total, body.total_count, body.totalCount, body.count, body.total_games, body.totalGames];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}


// TTL cache Steam appdetails PERSISTEN di DB (collection `steamAppCache`) — di
// atas cache di-memori (steamAppSummaryCache) yang hilang tiap server restart.
// Metadata Steam (nama/genre/cover/dst) SANGAT jarang berubah, jadi aman
// disimpan lebih lama (24 jam) di DB supaya restart server TIDAK membuat semua
// game harus di-enrich ulang dari nol — ini penyebab utama loading pertama kali
// selalu lambat sebelumnya. Cache di-memori tetap dipakai sebagai lapisan
// tercepat (tanpa round-trip DB) untuk request yang berdekatan.
const STEAM_SUMMARY_DB_TTL_MS = 24 * 60 * 60 * 1000;
async function fetchSteamAppSummary(appId, force = false) {
  const key = String(appId);
  // PENTING (bug fix): SEBELUMNYA hasil GAGAL (result null — App ID belum
  // ketemu/Steam sempat gagal) di-cache dengan TTL YANG SAMA PANJANGNYA dengan
  // hasil SUKSES (30 menit di memori, 24 JAM di DB) — akibatnya, App ID yang
  // PERNAH gagal sekali (sebelum perbaikan retry cc/locale di bawah diterapkan)
  // akan TERUS dianggap "gagal" dari cache selama berjam-jam, TANPA PERNAH
  // benar-benar dicoba ulang ke Steam — perbaikan retry-nya jadi tidak pernah
  // kepakai untuk App ID yang sudah kadung ke-cache gagal. Sekarang hasil GAGAL
  // pakai TTL jauh lebih pendek (cuma beberapa menit), supaya percobaan ulang
  // (dengan logic retry cc/locale yang sudah diperbaiki) benar-benar jalan lagi
  // dalam waktu singkat, sementara hasil SUKSES tetap di-cache lama seperti biasa.
  const cached = steamAppSummaryCache.get(key);
  if (!force && cached) {
    const ttl = cached.data ? STEAM_SUMMARY_CACHE_MS : STEAM_SUMMARY_NEGATIVE_TTL_MS;
    if ((Date.now() - cached.fetchedAt) < ttl) return cached.data;
  }

  // Lapisan ke-2: cache persisten di DB — kalau in-memory kosong (baru restart)
  // tapi DB masih punya data yang belum kedaluwarsa, pakai itu dulu (instan,
  // tanpa panggil Steam sama sekali), sekaligus isi ulang cache di-memori.
  // Sama seperti di atas: hasil GAGAL di DB juga pakai TTL pendek, bukan 24 jam.
  if (!force && db) {
    try {
      const dbDoc = await db.collection('steamAppCache').findOne({ _id: key });
      if (dbDoc) {
        const dbTtl = dbDoc.data ? STEAM_SUMMARY_DB_TTL_MS : STEAM_SUMMARY_NEGATIVE_TTL_MS;
        if ((Date.now() - new Date(dbDoc.fetchedAt).getTime()) < dbTtl) {
          steamAppSummaryCache.set(key, { data: dbDoc.data, fetchedAt: new Date(dbDoc.fetchedAt).getTime() });
          return dbDoc.data;
        }
      }
    } catch (e) { /* best-effort — kalau DB gagal, tetap lanjut fetch dari Steam */ }
  }

  // PENTING (bug fix): sebelumnya cuma 1x percobaan (`l: 'english'`, TANPA
  // parameter `cc` / country-code, TANPA header User-Agent browser-like) — Steam
  // appdetails TERBUKTI kadang membalas `success: false` untuk App ID yang
  // SAH/valid kalau dipanggil tanpa `cc`, atau kalau User-Agent-nya terlihat
  // seperti bot/script (default axios). Ini yang menyebabkan game yang
  // sebenarnya valid & ada di HubCap malah muncul "Gagal memuat" di halaman
  // Detail App. Sekarang dicoba 2 kombinasi cc/locale berbeda (sesuai kode
  // referensi yang terbukti stabil) sebelum benar-benar dianggap tidak tersedia.
  const STEAM_REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'application/json'
  };
  const STEAM_PARAM_VARIANTS = [
    { appids: appId, cc: 'us', l: 'english' },
    { appids: appId, cc: 'id', l: 'indonesian' }
  ];

  let result = null;
  try {
    let entry = null;
    for (const params of STEAM_PARAM_VARIANTS) {
      let res;
      try {
        res = await axios.get('https://store.steampowered.com/api/appdetails', {
          params, headers: STEAM_REQUEST_HEADERS, timeout: 10000
        });
      } catch (e) {
        // Retry sekali kalau kena rate limit (429) sebelum lanjut ke varian berikutnya.
        if (e.response?.status === 429) {
          await new Promise(r => setTimeout(r, 600));
          try {
            res = await axios.get('https://store.steampowered.com/api/appdetails', {
              params, headers: STEAM_REQUEST_HEADERS, timeout: 10000
            });
          } catch (e2) { continue; }
        } else {
          continue; // error jaringan/timeout -> coba varian cc/locale berikutnya
        }
      }
      const candidate = res.data?.[String(appId)];
      if (candidate?.success && candidate.data) { entry = candidate; break; }
      // `success: false` atau entry kosong -> lanjut coba varian berikutnya
      // (bukan langsung menyerah di percobaan pertama).
    }

    if (entry?.success && entry.data) {
      const d = entry.data;
      result = {
        appId: String(appId),
        name: d.name || null,
        type: d.type || null, // 'game' | 'dlc' | 'demo' | 'music' | 'video' | 'series' | 'episode' | 'tool' | 'hardware' | dst
        headerImage: d.header_image || null,
        capsuleImageUrl: d.capsule_imagev5 || d.capsule_image || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg`,
        libraryImageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        heroImageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_hero.jpg`,
        description: (d.short_description || '').slice(0, 400) || null,
        fullDescription: d.about_the_game ? d.about_the_game.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null,
        developer: Array.isArray(d.developers) && d.developers.length ? d.developers.join(', ') : null,
        publisher: Array.isArray(d.publishers) && d.publishers.length ? d.publishers.join(', ') : null,
        releaseDate: d.release_date?.date || null,
        comingSoon: !!d.release_date?.coming_soon,
        genres: (d.genres || []).map(g => g.description).filter(Boolean),
        // Dipakai buat halaman Detail Request Game biar SEPADAN dengan halaman
        // Install Game (categories/metacritic/system requirements) — lihat
        // parseSteamRequirements() & fetchSteamDetailsForAppId() di atas, dipakai
        // ulang di sini TANPA menyentuh endpoint/alur Install Game yang sudah ada.
        categories: (d.categories || []).map(c => c.description).filter(Boolean),
        metacritic: (typeof d.metacritic?.score === 'number') ? d.metacritic.score : null,
        requirementsMin: parseSteamRequirements(d.pc_requirements?.minimum),
        requirementsRec: parseSteamRequirements(d.pc_requirements?.recommended),
        screenshots: (d.screenshots || []).slice(0, 10).map(s => s.path_full || s.path_thumbnail).filter(Boolean),
        storeUrl: `https://store.steampowered.com/app/${appId}/`
      };
    }
  } catch (e) { /* noop — dianggap tidak tersedia, dikeluarkan dari hasil browse */ }

  const fetchedAt = Date.now();
  steamAppSummaryCache.set(key, { data: result, fetchedAt });
  if (db) {
    db.collection('steamAppCache').updateOne(
      { _id: key },
      { $set: { data: result, fetchedAt: new Date(fetchedAt) } },
      { upsert: true }
    ).catch(() => {}); // best-effort, tidak menghambat response
  }
  return result;
}

// Filter "hanya game utama" — SEBELUMNYA pakai WHITELIST ketat (wajib type
// === 'game' PERSIS + wajib nama 100% huruf Latin/English) yang terbukti
// KEBLABASAN: banyak game bagus ke-buang gara-gara Steam kadang tidak
// mengisi `type` secara konsisten, atau judulnya punya subtitle/karakter
// non-Latin walau game-nya sendiri full English (mis. "Tales of X: 二番目").
// Diganti ke pola BLACKLIST (sama seperti kode referensi yang terbukti jalan
// lancar) — cuma buang tipe yang SUDAH JELAS bukan game (dlc/demo/soundtrack/
// video/tool/dll), selebihnya (termasuk yang `type`-nya kosong/tidak baku)
// TETAP ditampilkan. Filter nama (demo/beta/soundtrack/dst) tetap jadi jaring
// pengaman tambahan lewat REQUEST_GAME_EXCLUDE_NAME. TIDAK ADA LAGI filter
// bahasa — sesuai permintaan: tampilkan SEMUA game yang ada di katalog HubCap.
const STEAM_NON_GAME_TYPES = new Set([
  'dlc', 'music', 'video', 'advertising', 'mod', 'tool',
  'episode', 'series', 'config', 'hardware', 'guide', 'demo', 'shortcutset'
]);
function isMainGameType(summary) {
  if (!summary || !summary.name) return false;
  const type = (summary.type || '').toLowerCase();
  if (type && STEAM_NON_GAME_TYPES.has(type)) return false;
  if (REQUEST_GAME_EXCLUDE_NAME.test(summary.name)) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// REQUEST GAME — PENGATURAN (Aktif/Nonaktif fitur, limit harian per paket,
// jam reset). Disimpan 1 dokumen di `settings`, sama pola dengan kategori di
// bawah. Realtime lewat wsBroadcastAll supaya App yang sedang terbuka di
// halaman Request Game langsung menyesuaikan tanpa restart.
// ══════════════════════════════════════════════════════════════════════════
const REQUEST_GAME_SETTINGS_ID = 'request_game_settings';
const DEFAULT_REQUEST_GAME_SETTINGS = {
  _id: REQUEST_GAME_SETTINGS_ID,
  enabled: true,
  // 0 = tidak boleh request sama sekali (dipakai buat Public secara default).
  dailyLimits: { public: 0, gold: 1, platinum: 2, admin: 999 },
  resetHour: 0, // jam reset limit harian, WIB (0-23) — default tengah malam
  updatedAt: null, updatedBy: null
};

async function getRequestGameSettingsDoc() {
  let doc = await db.collection('settings').findOne({ _id: REQUEST_GAME_SETTINGS_ID });
  if (!doc) {
    doc = { ...DEFAULT_REQUEST_GAME_SETTINGS, updatedAt: new Date() };
    await db.collection('settings').insertOne(doc);
  }
  // Merge defaults — kalau ada role baru di masa depan yang belum ada di DB lama.
  return { ...DEFAULT_REQUEST_GAME_SETTINGS, ...doc, dailyLimits: { ...DEFAULT_REQUEST_GAME_SETTINGS.dailyLimits, ...(doc.dailyLimits || {}) } };
}
function publicRequestGameSettings(doc) {
  return { enabled: !!doc.enabled, dailyLimits: doc.dailyLimits, resetHour: doc.resetHour };
}

// Awal periode limit "hari ini" mengikuti jam reset yang diatur admin (WIB) —
// menggantikan startOfTodayWIB() yang lama (selalu jam 00:00, sekarang configurable).
function startOfLimitWindowWIB(resetHour = 0) {
  const wib = new Date(Date.now() + WIB_OFFSET_MS);
  const hourNow = wib.getUTCHours();
  wib.setUTCHours(resetHour, 0, 0, 0);
  if (hourNow < resetHour) wib.setUTCDate(wib.getUTCDate() - 1); // belum lewat jam reset -> window mulai kemarin
  return new Date(wib.getTime() - WIB_OFFSET_MS);
}
function nextResetTimeWIB(resetHour = 0) {
  const start = startOfLimitWindowWIB(resetHour);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

// App: info fitur + limit request harian milik user yang login (dipakai buat
// nampilkan tombol "Upgrade Paket" / "Login untuk Request" / sisa limit + reset).
app.get('/api/requests/limit-info', requireUser, async (req, res) => {
  try {
    const settings = await getRequestGameSettingsDoc();
    const role = req.user.role || 'public';
    const limit = settings.dailyLimits[role] ?? 0;
    const usedToday = limit > 0
      ? await db.collection('gameRequests').countDocuments({ discordId: req.user.discordId, requestedAt: { $gte: startOfLimitWindowWIB(settings.resetHour) } })
      : 0;
    res.json({
      enabled: settings.enabled,
      role,
      limit,
      used: usedToday,
      remaining: Math.max(0, limit - usedToday),
      allowed: settings.enabled && limit > 0,
      resetAt: nextResetTimeWIB(settings.resetHour).toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: lihat & simpan pengaturan Request Game (toggle fitur, limit per paket, jam reset).
app.get('/api/admin/request-game-settings', requireAdmin, async (req, res) => {
  try {
    const doc = await getRequestGameSettingsDoc();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/admin/request-game-settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getRequestGameSettingsDoc();
    const next = { ...current };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (Number.isInteger(body.resetHour) && body.resetHour >= 0 && body.resetHour <= 23) next.resetHour = body.resetHour;
    if (body.dailyLimits && typeof body.dailyLimits === 'object') {
      const cleaned = {};
      for (const [role, val] of Object.entries(body.dailyLimits)) {
        const n = parseInt(val, 10);
        cleaned[role] = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      next.dailyLimits = { ...current.dailyLimits, ...cleaned };
    }
    next.updatedAt = new Date();
    next.updatedBy = req.admin?.username || 'Admin';

    const { _id, ...setFields } = next;
    await db.collection('settings').updateOne({ _id: REQUEST_GAME_SETTINGS_ID }, { $set: setFields }, { upsert: true });

    const pub = publicRequestGameSettings(next);
    wsBroadcastAll('request-game-settings:update', pub);
    broadcastAdmin('request-game-settings:update', next);

    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function startOfTodayWIB() {
  const wib = new Date(Date.now() + WIB_OFFSET_MS);
  wib.setUTCHours(0, 0, 0, 0);
  return new Date(wib.getTime() - WIB_OFFSET_MS);
}

// Status request "milik user ini" buat 1 App ID tertentu — dipakai browse &
// detail supaya App bisa nonaktifkan tombol Request & tampilkan status yang
// benar (Tersedia / Pending / Approved / Rejected).
async function resolveRequestStatusForUser(discordId, appId) {
  const existingGame = await db.collection('games').findOne({ appId: String(appId) }, { projection: { _id: 1 } });
  if (existingGame) return { status: 'available', reason: null };

  const lastRequest = await db.collection('gameRequests')
    .find({ discordId, appId: String(appId) })
    .sort({ requestedAt: -1 })
    .limit(1)
    .toArray();
  if (lastRequest.length) {
    const r = lastRequest[0];
    return { status: r.status, reason: r.status === 'rejected' ? (r.rejectReason || null) : null };
  }
  return { status: null, reason: null };
}

// Versi batch dari resolveRequestStatusForUser() — dipakai buat 1 halaman
// browse (sampai 50 App ID sekaligus) supaya cuma butuh 2 query DB TOTAL
// (bukan sampai 100 query terpisah kayak manggil resolveRequestStatusForUser
// satu-satu per item), biar halaman List tetap cepat walau statusnya tetap
// fresh per user (tidak ikut ke-cache bareng hasil browse HubCap di atas).
async function resolveRequestStatusForUserBatch(discordId, appIds) {
  const [existingGames, requests] = await Promise.all([
    db.collection('games').find({ appId: { $in: appIds } }, { projection: { appId: 1 } }).toArray(),
    db.collection('gameRequests').find({ discordId, appId: { $in: appIds } }).sort({ requestedAt: -1 }).toArray()
  ]);
  const availableSet = new Set(existingGames.map(g => g.appId));
  const latestByAppId = new Map();
  for (const r of requests) { if (!latestByAppId.has(r.appId)) latestByAppId.set(r.appId, r); } // sudah urut terbaru dulu

  const result = new Map();
  for (const appId of appIds) {
    if (availableSet.has(appId)) { result.set(appId, { status: 'available', reason: null }); continue; }
    const r = latestByAppId.get(appId);
    if (r) { result.set(appId, { status: r.status, reason: r.status === 'rejected' ? (r.rejectReason || null) : null }); continue; }
    result.set(appId, { status: null, reason: null });
  }
  return result;
}

function publicGameRequest(r) {
  return {
    _id: r._id,
    discordId: r.discordId,
    username: r.username,
    role: r.role,
    appId: r.appId,
    name: r.gameData?.name || r.name,
    headerImage: r.gameData?.headerImage || r.gameData?.capsuleImageUrl || null,
    genres: r.gameData?.genres || [],
    status: r.status,
    rejectReason: r.rejectReason || null,
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt || null,
    decidedBy: r.decidedBy || null,
    createdGameId: r.createdGameId || null
  };
}

// ── APP: Browse katalog HubCap Library, diperkaya metadata Steam ──
// Pagination model: client kirim `rawOffset` (mulai 0) yang nunjuk ke offset
// MENTAH di HubCap (bukan jumlah item yang sudah difilter) — soalnya jumlah
// yang lolos filter "game utama" + genre per-batch itu bervariasi. Client
// tinggal terus panggil pakai `nextRawOffset` yang dikembalikan (infinite
// scroll / tombol "Muat Lebih Banyak") sampai `hasMore` = false.
// ══════════════════════════════════════════════════════════════════════════


app.get('/api/requests/browse', requireUser, async (req, res) => {
  try {
    const settings = await getRequestGameSettingsDoc();
    if (!settings.enabled) return res.status(503).json({ error: 'Fitur Request Game sedang dinonaktifkan oleh Admin.', disabled: true });

    const search = String(req.query.search || '').trim();
    // Validasi ketat parameter `page` — kalau ngirim nilai aneh (huruf, negatif,
    // desimal, dst) selalu dianggap halaman 1.
    const rawPageParam = parseInt(req.query.page, 10);
    const page = Number.isInteger(rawPageParam) && rawPageParam > 0 ? rawPageParam : 1;
    // 80 game/halaman (requirement APP: numbered pagination 80/page) — HARUS
    // tetap sinkron dengan RG_PAGE_SIZE di app/app.js. totalPages di response
    // di bawah SELALU dihitung dari totalData asli (Math.ceil(totalData/80)),
    // tidak pernah hardcode jumlah halaman.
    const PAGE_SIZE = 80;

    let data;
    try {
      data = await fetchRequestGameBrowsePage(search, page, PAGE_SIZE);
    } catch (e) {
      const statusCode = (e.code === 'LIMITED' || e.code === 'NO_KEY') ? 503 : 502;
      return res.status(statusCode).json({ error: e.message });
    }

    const totalPages = Math.max(1, Math.ceil(data.totalData / PAGE_SIZE));

    // Tempelkan status request user saat ini per item (Tersedia/Pending/Approved/
    // Rejected) — DI LUAR cache HubCap di atas (fresh per user), tapi lewat 1
    // query batch (bukan 1 query per item) supaya tetap cepat.
    const appIds = data.items.map(it => it.appId);
    const statusMap = appIds.length ? await resolveRequestStatusForUserBatch(req.user.discordId, appIds) : new Map();
    const items = data.items.map(it => {
      const st = statusMap.get(it.appId) || { status: null, reason: null };
      return {
        appId: it.appId,
        name: it.name,
        headerImage: it.headerImage,
        images: it.images,
        sizeLabel: it.sizeLabel,
        requestStatus: st.status,
        rejectReason: st.reason
      };
    });

    res.json({
      items,
      currentPage: page,
      totalPages,
      totalData: data.totalData,
      pageSize: PAGE_SIZE,
      hasPrevious: page > 1,
      hasNext: page < totalPages
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APP: Detail lengkap 1 game (buat halaman Detail Request Game) ──
app.get('/api/requests/detail/:appId', requireUser, async (req, res) => {
  try {
    const settings = await getRequestGameSettingsDoc();
    if (!settings.enabled) return res.status(503).json({ error: 'Fitur Request Game sedang dinonaktifkan oleh Admin.', disabled: true });
    const appId = String(req.params.appId).trim();
    const summary = await fetchSteamAppSummary(appId);
    if (!isMainGameType(summary)) {
      return res.status(404).json({ error: 'Game tidak ditemukan atau bukan game utama.' });
    }
    const st = await resolveRequestStatusForUser(req.user.discordId, appId);
    res.json({ ...summary, requestStatus: st.status, rejectReason: st.reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APP: Buat Request Game baru ──
app.post('/api/requests/games', requireUser, async (req, res) => {
  try {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: 'App ID wajib diisi.' });
    const discordId = req.user.discordId;
    const username = req.user.username || discordId;
    const role = req.user.role;

    const settings = await getRequestGameSettingsDoc();
    if (!settings.enabled) {
      return res.status(503).json({ error: 'Fitur Request Game sedang dinonaktifkan oleh Admin.' });
    }

    // Public (atau paket manapun dengan limit 0) tidak boleh request — arahkan upgrade paket.
    const limit = settings.dailyLimits[role] ?? 0;
    if (limit <= 0) {
      return res.status(403).json({ error: `Fitur Request Game tidak tersedia untuk paket ${roleLabelUpper(role)}. Upgrade paket kamu dulu untuk bisa request game.` });
    }

    // Limit harian sesuai pengaturan Admin (reset di jam yang Admin atur, WIB).
    const usedToday = await db.collection('gameRequests').countDocuments({
      discordId, requestedAt: { $gte: startOfLimitWindowWIB(settings.resetHour) }
    });
    if (usedToday >= limit) {
      const resetAt = nextResetTimeWIB(settings.resetHour);
      return res.status(429).json({
        error: `Limit Request Game harian kamu (${limit}x untuk paket ${roleLabelUpper(role)}) sudah habis. Reset jam ${resetAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB.`,
        resetAt: resetAt.toISOString()
      });
    }

    // Sudah tersedia di katalog?
    const existingGame = await db.collection('games').findOne({ appId: String(appId) }, { projection: { _id: 1 } });
    if (existingGame) return res.status(400).json({ error: 'Game ini sudah tersedia di aplikasi — cek halaman Games.' });

    // Sudah pernah direquest & masih pending/approved? (kalau REJECTED, boleh request ulang)
    const lastRequest = await db.collection('gameRequests')
      .find({ discordId, appId: String(appId) }).sort({ requestedAt: -1 }).limit(1).toArray();
    if (lastRequest.length && (lastRequest[0].status === 'pending' || lastRequest[0].status === 'approved')) {
      return res.status(400).json({ error: `Kamu sudah pernah request game ini (status: ${lastRequest[0].status === 'pending' ? 'Menunggu' : 'Disetujui'}).` });
    }

    const summary = await fetchSteamAppSummary(appId);
    if (!isMainGameType(summary)) {
      return res.status(400).json({ error: 'Game tidak ditemukan atau bukan game utama yang valid untuk direquest.' });
    }

    const doc = {
      discordId, username, role,
      appId: String(appId),
      gameData: summary, // snapshot lengkap — dipakai admin buat auto-fill form Add Game pas Approve
      status: 'pending',
      rejectReason: null,
      requestedAt: new Date(),
      decidedAt: null,
      decidedBy: null,
      createdGameId: null
    };
    const inserted = await db.collection('gameRequests').insertOne(doc);
    doc._id = inserted.insertedId;

    logActivity({
      type: 'request_game',
      username, discordId, role, status: 'info',
      ip: getReqIp(req),
      description: `${username} (${roleLabelUpper(role)}) membuat Request Game "${summary.name}" (App ID ${appId}).`,
      meta: { requestId: String(doc._id), appId, name: summary.name }
    }).catch(() => {});

    notifyUser(discordId, {
      type: 'game_request_created',
      title: 'Request Game Terkirim',
      message: `Request kamu untuk **${summary.name}** sudah diterima dan sedang menunggu review Admin.`,
      fields: [
        field('👤 Username', username, true),
        field('🎮 Nama Game', summary.name, true),
        field('🆔 App ID', appId, true),
        field('📦 Paket', roleLabelUpper(role), true)
      ],
      thumbnail: summary.capsuleImageUrl || summary.headerImage || undefined,
      dm: true, webhook: true
    }).catch(() => {});

    broadcastAdmin('gameRequest:new', publicGameRequest(doc));
    wsSendToUser(discordId, 'gameRequest:update', publicGameRequest(doc));

    res.json({ success: true, request: publicGameRequest(doc) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Daftar Request Game (realtime lewat broadcastAdmin 'gameRequest:new'/'gameRequest:decided') ──
app.get('/api/admin/game-requests', requireAdmin, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ username: rx }, { appId: rx }, { 'gameData.name': rx }];
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [rows, total] = await Promise.all([
      db.collection('gameRequests').find(filter).sort({ requestedAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).toArray(),
      db.collection('gameRequests').countDocuments(filter)
    ]);

    // Total SEMUA orang yang pernah request App ID yang sama (bukan cuma baris
    // ini) — dipakai Admin Web buat nampilin "3 user pernah request" & tombol
    // popup "Lihat Semua Requester" di tiap kartu, tanpa perlu query terpisah
    // per kartu (1 aggregate untuk App ID yang muncul di halaman ini saja).
    const appIdsOnPage = [...new Set(rows.map(r => r.appId))];
    const counts = appIdsOnPage.length
      ? await db.collection('gameRequests').aggregate([
          { $match: { appId: { $in: appIdsOnPage } } },
          { $group: { _id: '$appId', count: { $sum: 1 } } }
        ]).toArray()
      : [];
    const countMap = new Map(counts.map(c => [c._id, c.count]));

    res.json({
      items: rows.map(r => ({ ...publicGameRequest(r), requesterCount: countMap.get(r.appId) || 1 })),
      total, page: pageNum, totalPages: Math.max(1, Math.ceil(total / limitNum))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Semua user yang PERNAH request App ID tertentu (buat popup "Lihat
// Semua Requester" di kartu Request Game) — realtime karena selalu query
// langsung ke DB (tidak di-cache), dan halaman admin sudah dengar event
// broadcastAdmin('gameRequest:new'/'gameRequest:decided') buat auto-refresh.
app.get('/api/admin/game-requests/by-app/:appId', requireAdmin, async (req, res) => {
  try {
    const appId = String(req.params.appId).trim();
    if (!appId) return res.status(400).json({ error: 'App ID wajib diisi.' });
    const rows = await db.collection('gameRequests').find({ appId }).sort({ requestedAt: -1 }).toArray();
    res.json({ appId, items: rows.map(publicGameRequest) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Reject Request Game (approve TIDAK punya endpoint sendiri — approve
// dilakukan lewat POST /api/admin/games biasa dengan `requestId` disertakan,
// lihat penambahan di endpoint itu — supaya cuma ada SATU jalur pembuatan game,
// tidak ada logic ganda yang bisa saling berbeda/kena bug beda-beda). ──
app.put('/api/admin/game-requests/:id/reject', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const request = await db.collection('gameRequests').findOne({ _id: new ObjectId(req.params.id) });
    if (!request) return res.status(404).json({ error: 'Request tidak ditemukan.' });
    if (request.status !== 'pending') return res.status(400).json({ error: `Request ini sudah di-${request.status === 'approved' ? 'approve' : 'reject'} sebelumnya.` });

    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
    const update = { status: 'rejected', rejectReason: reason, decidedAt: new Date(), decidedBy: req.admin?.username || 'Admin' };
    await db.collection('gameRequests').updateOne({ _id: request._id }, { $set: update });
    const updated = { ...request, ...update };

    logActivity({
      type: 'request_game_rejected',
      username: req.admin?.username || 'Admin', admin: req.admin?.username || 'Admin', status: 'warning',
      ip: getReqIp(req),
      description: `Admin menolak Request Game "${request.gameData?.name || request.appId}" dari ${request.username}.${reason ? ` Alasan: ${reason}` : ''}`,
      meta: { requestId: String(request._id), appId: request.appId, reason }
    }).catch(() => {});

    notifyUser(request.discordId, {
      type: 'game_request_rejected',
      title: 'Request Game Ditolak',
      message: `Request kamu untuk **${request.gameData?.name || request.appId}** ditolak Admin.${reason ? ` Alasan: ${reason}` : ''}`,
      fields: [
        field('🎮 Nama Game', request.gameData?.name, true),
        field('🆔 App ID', request.appId, true),
        ...(reason ? [field('📝 Alasan', reason, false)] : [])
      ],
      thumbnail: request.gameData?.capsuleImageUrl || request.gameData?.headerImage || undefined,
      dm: true, webhook: true
    }).catch(() => {});

    broadcastAdmin('gameRequest:decided', publicGameRequest(updated));
    wsSendToUser(request.discordId, 'gameRequest:update', publicGameRequest(updated));

    res.json({ success: true, request: publicGameRequest(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


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

// Gateway Discord Slash Command (/setpaket, /cekpaket, /createvoucher) —
// koneksi TERPISAH dari roleSync di atas (lihat discordSlashCommands.js).
slashCommands.startGateway();