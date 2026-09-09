// ══════════════════════════════════════════════════════════════════════════
// DISCORD AUTO ORDER MANAGER — "Auto Order Paket Gold & Platinum" via Discord
// Bot. Modul ini SENGAJA ditulis terpisah (bukan ditempel manual di
// server.js) mengikuti pola SEMUA modul lain di project ini
// (klikqrisManager.js, discordTicketManager.js, discordRoleSync.js, dst):
// satu tanggung jawab per file, reusable, dan TIDAK mengubah cara kerja
// sistem yang sudah ada.
//
// PRINSIP UTAMA — "tidak mengubah sistem yang sudah berjalan":
//   Modul ini TIDAK membuat alur pembayaran baru. Order dari Discord Bot
//   memakai PERSIS pipeline Upgrade Paket yang sudah ada di server.js
//   (transactionManager + klikqrisManager + activateCompletedTransaction +
//   roleSync), jadi efek yang sudah teruji (role berubah, masa aktif
//   diperbarui, limit download ikut update, notif DM/Webhook, dst) otomatis
//   konsisten baik order dari App maupun dari Discord Bot. Modul ini CUMA
//   menambahkan:
//     1. Sumber order baru (tombol/menu Discord) yang memanggil endpoint
//        pembuatan transaksi yang sama.
//     2. Metadata tambahan (channel ticket invoice di Discord) yang disimpan
//        di collection TERPISAH (`discordAutoOrders`), di-link ke transaksi
//        lewat `orderId` — supaya collection `transactions` yang sudah ada
//        TIDAK perlu diubah skemanya sama sekali.
//     3. Hook best-effort (onOrderActivated/onOrderClosed) yang dipanggil
//        server.js di titik yang SUDAH ADA (activateCompletedTransaction,
//        cancelPendingTransaction, sweep expiry) — kalau order itu bukan
//        dari Discord Bot (tidak ada entri di `discordAutoOrders`), hook ini
//        langsung no-op, jadi alur pembelian dari App SAMA SEKALI tidak
//        terpengaruh.
//
// Cara pakai dari server.js (lihat INTEGRATION.md untuk titik pemasangan
// persisnya):
//   const discordAutoOrderManager = require('./discordAutoOrderManager')({
//     getDb: () => db, packageManager, klikqrisManager, transactionManager,
//     roleSync, notifyUser, logActivity, broadcastAdmin, wsSendToUser,
//     field, fmtDateTimeWIB, getReqIp,
//     refreshTransactionFromKlikqris: (tx) => refreshTransactionFromKlikqris(tx),
//     cancelPendingTransaction: (tx, o) => cancelPendingTransaction(tx, o),
//     APP_NAME, SERVER_URL
//   });
//   await discordAutoOrderManager.ensureIndexes();
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const DISCORD_API = 'https://discord.com/api/v10';
const COLLECTION = 'discordAutoOrders';
const SETTINGS_ID = 'discordAutoOrder';
const TIERS = ['gold', 'platinum'];
const TIER_LABEL = { gold: 'Gold', platinum: 'Platinum' };
const TIER_EMOJI = { gold: '🥇', platinum: '💎' };
const DEFAULT_COLOR = { gold: 0xffd76a, platinum: 0xa78bfa };

// Berapa lama channel invoice dibiarkan terbuka SETELAH order selesai
// (lunas/gagal/expired/dibatalkan) sebelum otomatis ditutup (dihapus) —
// cukup lama supaya user sempat baca hasilnya, tapi tetap "auto-close".
const CLOSE_DELAY_SUCCESS_MS = 20 * 1000;
const CLOSE_DELAY_OTHER_MS = 10 * 1000;

module.exports = function createDiscordAutoOrderManager({
  getDb,
  packageManager,
  klikqrisManager,
  transactionManager,
  roleSync,
  notifyUser,
  logActivity,
  broadcastAdmin,
  wsSendToUser,
  field,
  fmtDateTimeWIB,
  refreshTransactionFromKlikqris,
  cancelPendingTransaction,
  APP_NAME,
  SERVER_URL
}) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
  const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
  // Kategori channel khusus utk ticket invoice Auto Order. Kalau kosong,
  // fallback ke kategori ticket yang sudah ada (DISCORD_TICKET_CATEGORY_ID)
  // supaya admin yang sudah setup kategori ticket umum tidak perlu setup ulang.
  const CATEGORY_ID = process.env.DISCORD_AUTOORDER_CATEGORY_ID || process.env.DISCORD_TICKET_CATEGORY_ID || '';
  const SUPPORT_ROLE_ID = process.env.DISCORD_SUPPORT_ROLE_ID || '';

  function isBotConfigured() {
    return !!(BOT_TOKEN && GUILD_ID && CLIENT_ID);
  }

  // ── HTTP helper ke Discord REST API (bot token) — pola sama persis dgn
  // discordTicketManager.js, termasuk auto-retry kalau kena rate limit 429. ──
  async function discordRequest(method, url, data) {
    const res = await axios({
      method, url: `${DISCORD_API}${url}`, data,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      validateStatus: () => true, timeout: 15000
    });
    if (res.status === 429) {
      const retryAfterMs = Math.ceil((res.data?.retry_after || 1) * 1000);
      await new Promise(r => setTimeout(r, retryAfterMs));
      return discordRequest(method, url, data);
    }
    if (res.status >= 400) {
      throw new Error(`Discord API ${method} ${url} gagal (${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data;
  }

  // Balas/isi ulang response interaction yang sudah di-ACK duluan (deferred)
  // oleh server.js — WAJIB dipakai (bukan res.json langsung) karena
  // pembuatan channel + transaksi KlikQRIS bisa lebih dari 3 detik (batas ACK
  // interaction Discord), jadi server.js selalu ACK duluan dgn `type:5`
  // (deferred, ephemeral) lalu modul ini yang mengisi jawaban aslinya di sini.
  async function editOriginalResponse(token, payload) {
    return axios.patch(
      `${DISCORD_API}/webhooks/${CLIENT_ID}/${token}/messages/@original`,
      payload, { timeout: 15000 }
    ).catch(e => console.warn('[Discord Auto Order] Gagal edit original response:', e.message));
  }

  function slugifyUsername(username) {
    const slug = String(username || 'user').toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return slug || 'user';
  }

  // ══════════════════════════════════════════════════════════════════════
  // SETTINGS — form embed yang bisa diatur Admin (title/deskripsi/banner/
  // benefit/warna/tombol/footer/channel tujuan). Disimpan di collection
  // `settings` (_id: 'discordAutoOrder'), dibaca ulang dari DB tiap dipakai
  // (TANPA cache) supaya perubahan Admin langsung berlaku tanpa restart bot
  // — sama persis pola packageManager.js/klikqrisManager.js di project ini.
  // ══════════════════════════════════════════════════════════════════════

  function defaultMenuConfig() {
    return {
      menuTitle: `✨ Paket Membership ${APP_NAME || '31 Tools'}`,
      menuDescription: 'Aktifkan paket premium dan nikmati akses game inject tanpa batas. Pembayaran otomatis via QRIS — langsung aktif setelah bayar!',
      banner: '',
      thumbnail: '',
      color: 0xffd76a,
      caraOrderSteps: [
        'Klik tombol Order di bawah',
        'Channel order pribadi akan dibuat otomatis',
        'Scan QRIS yang muncul di channel tersebut',
        'Paket langsung aktif setelah pembayaran berhasil!'
      ],
      infoNotes: [
        'Pembayaran via QRIS (semua e-wallet & m-banking)',
        'Aktivasi otomatis dalam hitungan detik',
        'Hubungi admin jika ada kendala'
      ],
      messageId: ''
    };
  }

  // Field per-tier SEKARANG jauh lebih ringkas — cuma benefit override & label
  // tombol (judul/deskripsi/banner/warna sudah jadi 1 milik menu gabungan di
  // atas, bukan per-tier lagi). Platinum dapat 1 label tombol tambahan buat
  // "Perpanjang Platinum" (lihat buildMenuButtonRow) — secara sistem SAMA
  // persis dengan tombol beli Platinum biasa (beli Platinum saat masih aktif
  // = otomatis memperpanjang, bukan alur/harga terpisah), cuma beda label
  // supaya user yang sudah Platinum tahu tombol mana yang relevan buat mereka.
  function defaultTierConfig(tier) {
    return {
      buttonLabel: `Order Paket ${TIER_LABEL[tier]}`,
      renewButtonLabel: tier === 'platinum' ? 'Perpanjang Platinum' : undefined,
      benefits: [] // kosong = otomatis ambil dari packageManager (Upgrade Paket)
    };
  }

  async function getSettings() {
    const db = getDb();
    const fallback = {
      _id: SETTINGS_ID, enabled: false, channelId: '',
      footer: `${APP_NAME || '31 Tools'} · Auto Store · Live Stock · Powered by KlikQRIS`,
      ...defaultMenuConfig(),
      gold: defaultTierConfig('gold'), platinum: defaultTierConfig('platinum')
    };
    if (!db) return fallback;
    let doc = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) {
      doc = { ...fallback, updatedAt: new Date() };
      await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: doc }, { upsert: true });
    }
    const menuDefaults = defaultMenuConfig();
    return {
      _id: SETTINGS_ID,
      enabled: !!doc.enabled,
      channelId: doc.channelId || '',
      footer: doc.footer || fallback.footer,
      menuTitle: doc.menuTitle || menuDefaults.menuTitle,
      menuDescription: doc.menuDescription ?? menuDefaults.menuDescription,
      banner: doc.banner || '',
      thumbnail: doc.thumbnail || '',
      color: Number.isFinite(doc.color) ? doc.color : menuDefaults.color,
      caraOrderSteps: Array.isArray(doc.caraOrderSteps) && doc.caraOrderSteps.length ? doc.caraOrderSteps : menuDefaults.caraOrderSteps,
      infoNotes: Array.isArray(doc.infoNotes) && doc.infoNotes.length ? doc.infoNotes : menuDefaults.infoNotes,
      messageId: doc.messageId || '',
      gold: { ...defaultTierConfig('gold'), ...(doc.gold || {}) },
      platinum: { ...defaultTierConfig('platinum'), ...(doc.platinum || {}) },
      updatedAt: doc.updatedAt || null
    };
  }

  async function updateSettings(patch = {}) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const current = await getSettings();
    const next = {
      enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
      channelId: patch.channelId !== undefined ? String(patch.channelId || '').trim() : current.channelId,
      footer: patch.footer !== undefined ? String(patch.footer || '').slice(0, 200) : current.footer,
      menuTitle: patch.menuTitle !== undefined ? (String(patch.menuTitle || '').slice(0, 256) || current.menuTitle) : current.menuTitle,
      menuDescription: patch.menuDescription !== undefined ? String(patch.menuDescription || '').slice(0, 4000) : current.menuDescription,
      banner: patch.banner !== undefined ? String(patch.banner || '').slice(0, 1000) : current.banner,
      thumbnail: patch.thumbnail !== undefined ? String(patch.thumbnail || '').slice(0, 1000) : current.thumbnail,
      color: current.color,
      caraOrderSteps: Array.isArray(patch.caraOrderSteps) ? patch.caraOrderSteps.map(s => String(s || '').slice(0, 150)).filter(Boolean).slice(0, 10) : current.caraOrderSteps,
      infoNotes: Array.isArray(patch.infoNotes) ? patch.infoNotes.map(s => String(s || '').slice(0, 150)).filter(Boolean).slice(0, 10) : current.infoNotes,
      messageId: current.messageId,
      gold: sanitizeTierPatch(current.gold, patch.gold),
      platinum: sanitizeTierPatch(current.platinum, patch.platinum),
      updatedAt: new Date()
    };
    if (patch.color !== undefined) {
      const c = String(patch.color || '').replace('#', '');
      const n = parseInt(c, 16);
      if (Number.isFinite(n)) next.color = n;
    }
    await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: next }, { upsert: true });
    return getSettings();
  }

  function sanitizeTierPatch(currentTier, patch) {
    if (!patch || typeof patch !== 'object') return currentTier;
    const out = { ...currentTier };
    if (patch.buttonLabel !== undefined) out.buttonLabel = String(patch.buttonLabel || '').slice(0, 80) || currentTier.buttonLabel;
    if (patch.renewButtonLabel !== undefined) out.renewButtonLabel = String(patch.renewButtonLabel || '').slice(0, 80) || currentTier.renewButtonLabel;
    if (Array.isArray(patch.benefits)) out.benefits = patch.benefits.map(b => String(b || '').slice(0, 200)).filter(Boolean).slice(0, 15);
    return out;
  }

  // Info role Discord ditampilkan read-only di halaman Auto Order (sumber
  // kebenarannya TETAP halaman "Verify Role" / roleSync — sengaja TIDAK
  // diduplikasi di sini supaya tidak ada dua tempat pengaturan yang bisa
  // beda/bentrok utk mapping role yang sama).
  async function getRoleMappingInfo() {
    try {
      const s = await roleSync.getSettings();
      return s.discordRoleMap || {};
    } catch (e) { return {}; }
  }

  // ══════════════════════════════════════════════════════════════════════
  // INDEXES
  // ══════════════════════════════════════════════════════════════════════
  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(COLLECTION).createIndex({ orderId: 1 }, { unique: true }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ discordId: 1, status: 1 }).catch(() => {});
    await db.collection(COLLECTION).createIndex({ channelId: 1 }).catch(() => {});
  }

  async function getActivePendingForDiscordUser(discordId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({ discordId, status: 'pending' }, { sort: { createdAt: -1 } });
  }

  async function getByOrderId(orderId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(COLLECTION).findOne({ orderId });
  }

  // ══════════════════════════════════════════════════════════════════════
  // EMBED BUILDERS — SATU embed gabungan (Gold & Platinum tampil berdampingan
  // lewat 2 field `inline:true`, persis referensi), bukan 2 pesan terpisah
  // seperti sebelumnya.
  // ══════════════════════════════════════════════════════════════════════
  function tierFieldValue(tierCfg, pkg) {
    const priceLabel = pkg && pkg.active ? `Rp${Number(pkg.price).toLocaleString('id-ID')}` : 'Tidak tersedia';
    const durationLabel = pkg ? `${pkg.durationAmount} ${packageManager.DURATION_UNIT_LABEL[pkg.durationUnit]}` : '-';
    const benefits = (tierCfg.benefits && tierCfg.benefits.length ? tierCfg.benefits : (pkg?.benefits || []));
    const lines = [`💰 **Rp${pkg ? Number(pkg.price).toLocaleString('id-ID') : '-'}** / ${durationLabel}`];
    if (!pkg || !pkg.active) lines[0] = `⚠️ ${priceLabel}`;
    benefits.forEach(b => lines.push(`• ${b}`));
    return lines.join('\n') || '-';
  }

  function buildCombinedMenuEmbed(settings, packages) {
    const embed = {
      title: settings.menuTitle,
      description: settings.menuDescription || undefined,
      color: settings.color,
      fields: [
        { name: `${TIER_EMOJI.gold} Paket GOLD`, value: tierFieldValue(settings.gold, packages.gold), inline: true },
        { name: `${TIER_EMOJI.platinum} Paket PLATINUM`, value: tierFieldValue(settings.platinum, packages.platinum), inline: true }
      ],
      footer: { text: settings.footer },
      timestamp: new Date().toISOString()
    };
    if (settings.caraOrderSteps?.length) {
      embed.fields.push({ name: '⚡ Cara Order', value: settings.caraOrderSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') });
    }
    if (settings.infoNotes?.length) {
      embed.fields.push({ name: '📝 Info', value: settings.infoNotes.map(s => `• ${s}`).join('\n') });
    }
    if (settings.banner) embed.image = { url: settings.banner };
    if (settings.thumbnail) embed.thumbnail = { url: settings.thumbnail };
    return embed;
  }

  // Satu baris berisi 3 tombol: Beli Gold, Beli Platinum, dan Perpanjang
  // Platinum. "Perpanjang" custom_id-nya beda (`dao_renew_platinum`) tapi
  // dirutekan ke alur beli Platinum yang SAMA PERSIS (lihat handleInteraction)
  // — di sistem ini beli paket yang sama saat masih aktif otomatis
  // memperpanjang masa aktifnya, bukan alur/harga terpisah.
  function buildMenuButtonRow(settings, packages) {
    const goldDisabled = !settings.enabled || !packages.gold?.active;
    const platDisabled = !settings.enabled || !packages.platinum?.active;
    return {
      type: 1,
      components: [
        { type: 2, style: 2, label: settings.gold.buttonLabel, custom_id: 'dao_buy_gold', emoji: { name: TIER_EMOJI.gold }, disabled: goldDisabled },
        { type: 2, style: 1, label: settings.platinum.buttonLabel, custom_id: 'dao_buy_platinum', emoji: { name: TIER_EMOJI.platinum }, disabled: platDisabled },
        { type: 2, style: 2, label: settings.platinum.renewButtonLabel || 'Perpanjang Platinum', custom_id: 'dao_renew_platinum', emoji: { name: '🔁' }, disabled: platDisabled }
      ]
    };
  }

  // Post SATU pesan menu gabungan ke channel tujuan (atau EDIT pesan lama
  // kalau sudah pernah dipublish) — dipanggil dari Admin Web tombol
  // "Publish/Update Menu", dan otomatis dipanggil ulang tiap Admin menyimpan
  // pengaturan supaya "perubahan langsung diterapkan tanpa restart bot".
  async function publishMenu() {
    if (!isBotConfigured()) throw new Error('Bot Discord belum dikonfigurasi (DISCORD_BOT_TOKEN/DISCORD_GUILD_ID/DISCORD_CLIENT_ID).');
    const settings = await getSettings();
    if (!settings.channelId) throw new Error('Channel tujuan belum diatur.');
    const packages = await packageManager.getPackages();
    const embed = buildCombinedMenuEmbed(settings, packages);
    const row = buildMenuButtonRow(settings, packages);
    const body = { embeds: [embed], components: [row] };

    let message;
    if (settings.messageId) {
      try {
        message = await discordRequest('PATCH', `/channels/${settings.channelId}/messages/${settings.messageId}`, body);
      } catch (e) {
        message = null; // pesan lama mungkin sudah dihapus manual -> bikin baru di bawah
      }
    }
    if (!message) {
      message = await discordRequest('POST', `/channels/${settings.channelId}/messages`, body);
    }

    const db = getDb();
    if (db) await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: { messageId: message.id, updatedAt: new Date() } });
    return message;
  }

  // ══════════════════════════════════════════════════════════════════════
  // TICKET CHANNEL — dibuat SEKALI per order (mirip discordTicketManager.js,
  // tapi khusus invoice Auto Order supaya jelas kebedaannya di Discord).
  // ══════════════════════════════════════════════════════════════════════
  async function createInvoiceChannel({ discordId, username, tier, orderId }) {
    const shortCode = String(orderId || '').slice(-6);
    const channelName = `order-${slugifyUsername(username)}-${shortCode}`.toLowerCase();
    const permissionOverwrites = [
      { id: GUILD_ID, type: 0, deny: '1024' },
      { id: discordId, type: 1, allow: '3072' }
    ];
    if (SUPPORT_ROLE_ID) permissionOverwrites.push({ id: SUPPORT_ROLE_ID, type: 0, allow: '3072' });

    const channel = await discordRequest('POST', `/guilds/${GUILD_ID}/channels`, {
      name: channelName, type: 0, parent_id: CATEGORY_ID || undefined,
      topic: `Auto Order Paket ${TIER_LABEL[tier]} — Invoice ${orderId}`,
      permission_overwrites: permissionOverwrites
    });
    return channel;
  }

  function buildInvoiceEmbed(tx, { status } = {}) {
    const st = status || tx.status;
    const statusLabel = {
      pending: '⏳ Menunggu Pembayaran', completed: '✅ Lunas', failed: '❌ Gagal',
      expired: '⏰ Kedaluwarsa', cancelled: '🚫 Dibatalkan'
    }[st] || st;
    const tierLabel = TIER_LABEL[tx.tier] || tx.tier;
    const pkg = tx.packageSnapshot || {};
    const durationLabel = pkg.durationAmount ? `${pkg.durationAmount} ${packageManager.DURATION_UNIT_LABEL[pkg.durationUnit] || 'hari'}` : '';

    const fields = [
      { name: '📄 Order ID', value: `\`${tx.orderId}\`` },
      { name: '🛍️ Produk', value: `Paket ${tierLabel}${durationLabel ? ` (${durationLabel})` : ''}`, inline: true },
      { name: '💳 Total Bayar', value: `Rp${Number(tx.totalPayment ?? tx.amount).toLocaleString('id-ID')}`, inline: true }
    ];
    // Batas Waktu pakai format timestamp relatif Discord (`<t:unix:R>` -> "in 10
    // minutes") — otomatis nge-countdown live di sisi Discord, tidak perlu
    // dihitung ulang manual & selalu benar di zona waktu masing-masing user.
    if (tx.status === 'pending' && tx.expiresAt) {
      const unixTs = Math.floor(new Date(tx.expiresAt).getTime() / 1000);
      fields.push({ name: '⏳ Batas Waktu', value: `<t:${unixTs}:R>`, inline: true });
    }
    fields.push({ name: '📊 Status', value: statusLabel });
    if (st === 'pending') {
      fields.push({
        name: '📃 Cara Bayar',
        value: tx.paymentMethod === 'qris'
          ? '1. Buka **m-banking / e-wallet** kamu\n2. Pilih **Scan QR / QRIS**\n3. Scan QR di bawah\n4. Pastikan nominal sesuai lalu konfirmasi\n5. Paket **langsung aktif** otomatis!'
          : '1. Buka **m-banking / e-wallet** kamu\n2. Pilih **Transfer Virtual Account**\n3. Masukkan nomor VA di atas\n4. Pastikan nominal sesuai lalu konfirmasi\n5. Paket **langsung aktif** otomatis!'
      });
      if (tx.paymentMethod !== 'qris' && tx.paymentNumber) {
        fields.splice(fields.length - 1, 0, { name: '🏦 Nomor Virtual Account', value: `\`${tx.paymentNumber}\`` });
      }
    }

    const embed = {
      title: `🎯 Order Paket ${tierLabel}`,
      description: `Halo <@${tx.discordId}>! Berikut detail transaksimu.${st === 'pending' ? ' Scan QR di bawah untuk menyelesaikan pembayaran.' : ''}`,
      color: st === 'completed' ? 0x2ecc71 : (st === 'failed' || st === 'expired') ? 0xe74c3c : st === 'cancelled' ? 0x95a5a6 : 0xf1c40f,
      fields,
      footer: { text: `${APP_NAME || '31 Tools'} · Powered by KlikQRIS` },
      timestamp: new Date().toISOString()
    };
    // PENTING: JANGAN generate ulang QR dari teks paymentNumber/qrisUrl lewat
    // qrserver.com — paymentNumber/qrisUrl isinya URL ke GAMBAR QRIS (bukan
    // string payload QRIS/EMVCo), jadi kalau di-encode ulang jadi QR baru,
    // hasilnya QR yang isinya "sebuah URL", BUKAN QRIS yang bisa dipakai
    // bayar — makanya muncul INVALID saat discan pakai app pembayaran.
    // tx.qrisUrl SUDAH berupa link gambar QRIS ASLI dari KlikQRIS, jadi
    // langsung dipakai sebagai embed.image (Discord embed image butuh URL
    // http(s), tidak bisa data:base64 — makanya di sini pakai qrisUrl,
    // BEDA dengan App yang bisa langsung pakai qrisImage base64 lewat <img>).
    if (st === 'pending' && tx.paymentMethod === 'qris' && tx.qrisUrl) {
      embed.image = { url: tx.qrisUrl };
    }
    return embed;
  }

  function buildInvoiceComponents(tx) {
    if (tx.status !== 'pending') return [];
    return [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Cek Status', custom_id: `dao_check_${tx.orderId}`, emoji: { name: '🔄' } },
        { type: 2, style: 4, label: 'Batalkan', custom_id: `dao_cancel_${tx.orderId}`, emoji: { name: '✖️' } }
      ]
    }];
  }

  async function postInvoiceMessage(channelId, discordId, tx) {
    const embed = buildInvoiceEmbed(tx);
    const message = await discordRequest('POST', `/channels/${channelId}/messages`, {
      content: `<@${discordId}>`,
      embeds: [embed],
      components: buildInvoiceComponents(tx),
      allowed_mentions: { users: [discordId] }
    });
    return message;
  }

  async function updateInvoiceMessage(channelId, messageId, tx, status) {
    if (!channelId || !messageId) return;
    await discordRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      embeds: [buildInvoiceEmbed(tx, { status })],
      components: buildInvoiceComponents({ ...tx, status })
    }).catch(e => console.warn('[Discord Auto Order] Gagal update invoice message:', e.message));
  }

  function scheduleChannelClose(channelId, delayMs) {
    if (!channelId) return;
    setTimeout(() => {
      discordRequest('DELETE', `/channels/${channelId}`).catch(() => {});
    }, delayMs);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ALUR ORDER — dipanggil dari handler interaction Discord (server.js)
  // ══════════════════════════════════════════════════════════════════════

  // Langkah 1: user klik tombol "Beli Gold/Platinum" di menu persistent.
  async function startBuyFlow({ tier, discordId, username, token }) {
    const db = getDb();
    const user = db ? await db.collection('users').findOne({ discordId }) : null;
    if (!user) {
      return editOriginalResponse(token, {
        content: `⚠️ Akun kamu belum terdaftar di ${APP_NAME || 'aplikasi'}. Buka Aplikasi dan login sekali pakai akun Discord ini dulu, baru ulangi order-nya di sini.`
      });
    }

    const existing = await getActivePendingForDiscordUser(discordId);
    if (existing) {
      return editOriginalResponse(token, { content: `ℹ️ Kamu masih punya order yang belum selesai: <#${existing.channelId}>. Selesaikan/batalkan dulu order itu sebelum membuat order baru.` });
    }

    const packages = await packageManager.getPackages();
    const pkg = packages[tier];
    if (!pkg || !pkg.active) {
      return editOriginalResponse(token, { content: `⚠️ Paket ${TIER_LABEL[tier]} sedang tidak tersedia.` });
    }

    const gatewayCfg = await klikqrisManager.getSettings();
    if (!gatewayCfg.enabled) {
      return editOriginalResponse(token, { content: '⚠️ Payment gateway sedang dinonaktifkan Admin, coba lagi nanti.' });
    }

    // Tampilkan pilihan metode pembayaran (select menu ephemeral).
    return editOriginalResponse(token, {
      content: `Pilih metode pembayaran untuk paket **${TIER_LABEL[tier]}** (Rp${Number(pkg.price).toLocaleString('id-ID')}):`,
      components: [{
        type: 1,
        components: [{
          type: 3, custom_id: `dao_method_${tier}`,
          placeholder: 'Pilih metode pembayaran...',
          options: klikqrisManager.PAYMENT_METHODS.map(m => ({ label: m.label, value: m.key }))
        }]
      }]
    });
  }

  // Langkah 2: user pilih metode pembayaran -> buat order beneran.
  async function createOrder({ tier, method, discordId, username, token }) {
    const db = getDb();
    try {
      const user = db ? await db.collection('users').findOne({ discordId }) : null;
      if (!user) {
        return editOriginalResponse(token, { content: '⚠️ Akun tidak ditemukan, silakan login dulu di App.' });
      }
      const existing = await getActivePendingForDiscordUser(discordId);
      if (existing) {
        return editOriginalResponse(token, { content: `ℹ️ Kamu sudah punya order berjalan: <#${existing.channelId}>` });
      }
      if (!klikqrisManager.isValidMethod(method)) {
        return editOriginalResponse(token, { content: '⚠️ Metode pembayaran tidak valid.' });
      }

      const packages = await packageManager.getPackages();
      const pkg = packages[tier];
      if (!pkg || !pkg.active) {
        return editOriginalResponse(token, { content: `⚠️ Paket ${TIER_LABEL[tier]} sedang tidak tersedia.` });
      }

      // Cegah double order: transactionManager sendiri sudah cegah 1 user (per
      // discordId) punya >1 transaksi pending aktif — dipakai ulang di sini
      // (sumber kebenaran TETAP satu, sama dgn App).
      const existingTx = await transactionManager.getActivePendingForUser(discordId);
      if (existingTx) {
        const linked = await getByOrderId(existingTx.orderId);
        if (linked) return editOriginalResponse(token, { content: `ℹ️ Kamu sudah punya order berjalan: <#${linked.channelId}>` });
        // Ada transaksi pending tapi dibuat dari App (bukan bot) -> arahkan ke App.
        return editOriginalResponse(token, { content: 'ℹ️ Kamu sudah punya transaksi pembelian yang sedang berjalan di Aplikasi. Selesaikan/batalkan dulu transaksi itu.' });
      }

      const orderId = transactionManager.generateOrderId();
      const keterangan = klikqrisManager.keteranganDiscordBot(TIER_LABEL[tier] ? `Paket ${TIER_LABEL[tier]}` : null);
      const payment = await klikqrisManager.createTransaction({ orderId, amount: pkg.price, keterangan });
      const tx = await transactionManager.createPendingTransaction({
        discordId, username, tier, amount: pkg.price, method, payment,
        packageSnapshot: { price: pkg.price, durationAmount: pkg.durationAmount, durationUnit: pkg.durationUnit, benefits: pkg.benefits }
      });

      const channel = await createInvoiceChannel({ discordId, username, tier, orderId });
      const invoiceMsg = await postInvoiceMessage(channel.id, discordId, tx).catch(() => null);

      if (db) {
        await db.collection(COLLECTION).insertOne({
          orderId, discordId, username: username || null, tier,
          channelId: channel.id, invoiceMessageId: invoiceMsg?.id || null,
          status: 'pending', createdAt: new Date()
        });
      }

      logActivity({
        type: 'discord_autoorder_created',
        username, discordId, role: tier, status: 'info',
        description: `${username || discordId} membuat order ${orderId} (paket ${TIER_LABEL[tier]}) via Discord Bot — channel <#${channel.id}>.`,
        meta: { orderId, tier, amount: pkg.price, method: payment.payment_method, channelId: channel.id }
      }).catch(() => {});

      broadcastAdmin('transaction:update', transactionManager.publicTransaction(tx));
      broadcastAdmin('discord_autoorder:update', { orderId, tier, channelId: channel.id, status: 'pending' });

      return editOriginalResponse(token, { content: `✅ Order dibuat! Lanjutkan pembayaran di <#${channel.id}> (batas waktu 10 menit).`, components: [] });
    } catch (e) {
      console.error('[Discord Auto Order] Gagal membuat order:', e.message);
      logActivity({
        type: 'discord_autoorder_error', username, discordId, status: 'error',
        description: `Gagal membuat order Auto Order (${tier}) via Discord Bot: ${e.message}`,
        meta: { tier, method, error: e.message }
      }).catch(() => {});
      return editOriginalResponse(token, { content: `❌ Gagal membuat order: ${e.message}` });
    }
  }

  // Tombol "Cek Status" di dalam channel invoice.
  async function checkStatus({ orderId, discordId, token }) {
    const tx = await transactionManager.getByOrderId(orderId);
    if (!tx || tx.discordId !== discordId) {
      return editOriginalResponse(token, { content: '⚠️ Order tidak ditemukan / bukan milik kamu.' });
    }
    if (tx.status === 'pending') {
      await refreshTransactionFromKlikqris(tx).catch(e => console.warn('[Discord Auto Order] refresh gagal:', e.message));
    }
    const fresh = await transactionManager.getByOrderId(orderId);
    const statusText = {
      pending: '🟡 Masih menunggu pembayaran.', completed: '🟢 Sudah lunas, paket aktif!',
      failed: '🔴 Pembayaran gagal.', expired: '⚫ Sudah kedaluwarsa.', cancelled: '⚪ Sudah dibatalkan.'
    }[fresh?.status] || 'Status tidak diketahui.';
    return editOriginalResponse(token, { content: statusText });
  }

  // Tombol "Batalkan" di dalam channel invoice.
  async function cancelOrder({ orderId, discordId, token }) {
    const tx = await transactionManager.getByOrderId(orderId);
    if (!tx || tx.discordId !== discordId) {
      return editOriginalResponse(token, { content: '⚠️ Order tidak ditemukan / bukan milik kamu.' });
    }
    if (tx.status !== 'pending') {
      return editOriginalResponse(token, { content: `ℹ️ Order ini sudah berstatus ${tx.status}, tidak bisa dibatalkan.` });
    }
    const cancelled = await cancelPendingTransaction(tx, { by: 'user' });
    if (!cancelled) return editOriginalResponse(token, { content: '⚠️ Order baru saja berubah status (mungkin sudah lunas), coba Cek Status.' });
    return editOriginalResponse(token, { content: '✅ Order dibatalkan.' });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ROUTER — dipanggil server.js dari handler /api/discord/interactions
  // SETELAH server.js membalas ACK deferred (type 5) ke Discord. Dijalankan
  // async (fire-and-forget) — semua error ditangkap & dicatat, tidak pernah
  // melempar balik ke pemanggil.
  // ══════════════════════════════════════════════════════════════════════
  async function handleInteraction(interaction) {
    try {
      const customId = interaction.data?.custom_id || '';
      const token = interaction.token;
      const discordId = interaction.member?.user?.id || interaction.user?.id;
      const username = interaction.member?.user?.username || interaction.user?.username || discordId;

      if (customId.startsWith('dao_buy_') || customId.startsWith('dao_renew_')) {
        const tier = customId.startsWith('dao_renew_') ? customId.replace('dao_renew_', '') : customId.replace('dao_buy_', '');
        if (!TIERS.includes(tier)) return;
        return startBuyFlow({ tier, discordId, username, token });
      }
      if (customId.startsWith('dao_method_')) {
        const tier = customId.replace('dao_method_', '');
        const method = interaction.data?.values?.[0];
        if (!TIERS.includes(tier) || !method) return;
        return createOrder({ tier, method, discordId, username, token });
      }
      if (customId.startsWith('dao_check_')) {
        const orderId = customId.replace('dao_check_', '');
        return checkStatus({ orderId, discordId, token });
      }
      if (customId.startsWith('dao_cancel_')) {
        const orderId = customId.replace('dao_cancel_', '');
        return cancelOrder({ orderId, discordId, token });
      }
    } catch (e) {
      console.error('[Discord Auto Order] handleInteraction error:', e);
      logActivity({
        type: 'discord_autoorder_error', status: 'error',
        description: `Error tidak terduga di interaction handler Auto Order: ${e.message}`,
        meta: { customId: interaction.data?.custom_id }
      }).catch(() => {});
      if (interaction.token) {
        editOriginalResponse(interaction.token, { content: '❌ Terjadi kesalahan sistem, coba lagi sebentar.' }).catch(() => {});
      }
    }
  }

  function isCustomIdHandled(customId) {
    return !!customId && customId.startsWith('dao_');
  }

  // ══════════════════════════════════════════════════════════════════════
  // HOOKS — dipanggil server.js dari activateCompletedTransaction (lunas),
  // cancelPendingTransaction (batal/gagal) & sweep expiry (kedaluwarsa) —
  // di titik yang SUDAH ADA. Kalau `orderId` bukan berasal dari Discord Bot
  // (tidak ada entri di collection `discordAutoOrders`), hook ini langsung
  // no-op — TIDAK ADA efek apapun ke order dari App.
  // ══════════════════════════════════════════════════════════════════════
  async function onOrderActivated(tx) {
    try {
      const order = await getByOrderId(tx.orderId);
      if (!order) return; // bukan order dari Discord Bot
      const db = getDb();
      if (db) await db.collection(COLLECTION).updateOne({ orderId: tx.orderId }, { $set: { status: 'completed', completedAt: new Date() } });
      await updateInvoiceMessage(order.channelId, order.invoiceMessageId, tx, 'completed');
      scheduleChannelClose(order.channelId, CLOSE_DELAY_SUCCESS_MS);
      broadcastAdmin('discord_autoorder:update', { orderId: tx.orderId, tier: tx.tier, channelId: order.channelId, status: 'completed' });
    } catch (e) {
      console.warn('[Discord Auto Order] onOrderActivated gagal:', e.message);
    }
  }

  async function onOrderClosed(tx, reason) {
    try {
      const order = await getByOrderId(tx.orderId);
      if (!order) return; // bukan order dari Discord Bot
      const status = reason === 'expired' ? 'expired' : reason === 'cancelled' ? 'cancelled' : 'failed';
      const db = getDb();
      if (db) await db.collection(COLLECTION).updateOne({ orderId: tx.orderId }, { $set: { status, closedAt: new Date() } });
      await updateInvoiceMessage(order.channelId, order.invoiceMessageId, tx, status);
      scheduleChannelClose(order.channelId, CLOSE_DELAY_OTHER_MS);
      broadcastAdmin('discord_autoorder:update', { orderId: tx.orderId, tier: tx.tier, channelId: order.channelId, status });
    } catch (e) {
      console.warn('[Discord Auto Order] onOrderClosed gagal:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ADMIN HELPERS — daftar channel teks di guild (dropdown "Channel tujuan"
  // di Admin Web), pola sama dgn discordRoleSync.getGuildRoles().
  // ══════════════════════════════════════════════════════════════════════
  async function getGuildTextChannels() {
    if (!BOT_TOKEN || !GUILD_ID) return [];
    const channels = await discordRequest('GET', `/guilds/${GUILD_ID}/channels`);
    return (channels || [])
      .filter(c => c.type === 0)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(c => ({ id: c.id, name: c.name }));
  }

  // Riwayat order Auto Order utk Admin Web (join tipis ke `transactions`
  // lewat orderId — TIDAK menduplikasi data transaksi, cuma nambah info
  // channelId/status Discord-nya).
  async function listOrders({ limit = 100, skip = 0 } = {}) {
    const db = getDb();
    if (!db) return { items: [], total: 0 };
    const [items, total] = await Promise.all([
      db.collection(COLLECTION).find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      db.collection(COLLECTION).countDocuments({})
    ]);
    return { items, total };
  }

  return {
    // settings (Admin Web)
    getSettings, updateSettings, getRoleMappingInfo, getGuildTextChannels,
    // publish menu (Admin Web tombol "Publish/Update Menu")
    publishMenu, isBotConfigured,
    // interaction router (server.js /api/discord/interactions)
    handleInteraction, isCustomIdHandled,
    // hooks (server.js activateCompletedTransaction / cancelPendingTransaction / sweep expiry)
    onOrderActivated, onOrderClosed,
    // data
    ensureIndexes, getByOrderId, listOrders,
    TIERS, TIER_LABEL
  };
};
