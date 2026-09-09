// ══════════════════════════════════════════════════════════════════════════
// TICKET SYSTEM MANAGER — modul BARU & TERPISAH untuk fitur "Discord Ticket
// Management System" yang dikelola sepenuhnya dari Website Admin.
//
// PENTING (sesuai requirement):
//  - Modul ini TIDAK terhubung ke App (aplikasi user) sama sekali. Ini murni
//    Website Admin <-> Discord.
//  - TIDAK pakai Slash Command. Interaksi user di Discord cuma lewat tombol
//    (Message Component) pada Panel Ticket & DM Rating. Semua tombol
//    ditangani lewat endpoint HTTP Interactions yang SUDAH ADA di server.js
//    (/api/discord/interactions) — custom_id berawalan "tkt_".
//  - Pola REST API langsung (bot token), SAMA seperti discordTicketManager.js
//    & discordRoleSync.js — tidak butuh koneksi gateway sama sekali, jadi
//    transcript pun diambil lewat REST (GET channel messages) pas ticket
//    ditutup, bukan lewat listener realtime.
//
// KOLEKSI MongoDB yang dipakai modul ini (semua baru, tidak menyentuh
// koleksi fitur lain):
//   ticketPanels   — panel yang dibuat admin (embed, tombol, tujuan channel)
//   tickets        — seluruh ticket (status, staff, transcript, rating)
//   ticketLogs     — activity log khusus modul ticket
//   ticketConfig   — 1 dokumen konfigurasi (server/channel/category default)
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { ObjectId } = require('mongodb');

const DISCORD_API = 'https://discord.com/api/v10';

// Role Staff default — dipakai sebagai fallback mention di embed notifikasi
// Rating & Feedback kalau Ticket-nya belum pernah di-Claim oleh Staff mana pun.
const DEFAULT_STAFF_ROLE_ID = '1444169960451735612';

module.exports = function createTicketSystemManager({ getDb, broadcastAdmin }) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

  function db() { return getDb(); }

  function isBotConfigured() { return !!BOT_TOKEN; }

  // ── Discord REST helper (sama pola dengan discordTicketManager.js) ──
  async function discordRequest(method, url, data) {
    const res = await axios({
      method,
      url: `${DISCORD_API}${url}`,
      data,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      validateStatus: () => true,
      timeout: 15000
    });
    if (res.status === 429) {
      const retryAfterMs = Math.ceil((res.data?.retry_after || 1) * 1000);
      await new Promise(r => setTimeout(r, retryAfterMs));
      return discordRequest(method, url, data);
    }
    if (res.status >= 400) {
      const err = new Error(`Discord API ${method} ${url} gagal (${res.status}): ${JSON.stringify(res.data)}`);
      err.discordStatus = res.status;
      err.discordBody = res.data;
      throw err;
    }
    return res.data;
  }

  // ── Notifikasi via Bot Discord (Transcript, Rating, Ticket Logs) ──
  // SEMUA notifikasi modul Ticket System sekarang dikirim LANGSUNG memakai
  // akun Bot Discord (REST API, header Authorization: Bot <token>) ke channel
  // yang dipilih admin di halaman "Notification Channel Settings" — TIDAK
  // ADA lagi Discord Webhook sama sekali. Best-effort: TIDAK PERNAH melempar
  // error ke pemanggil — kalau channel belum diset/request gagal, cukup
  // di-warn ke console, proses utama (close ticket / kasih rating / catat
  // log) tetap lanjut normal.
  async function sendChannelEmbed(channelId, { content, embeds } = {}) {
    if (!channelId) return;
    try {
      await discordRequest('POST', `/channels/${channelId}/messages`, { content, embeds });
    } catch (e) {
      console.warn('[Ticket] Gagal kirim notifikasi ke channel:', e.discordBody ? JSON.stringify(e.discordBody) : e.message);
    }
  }

  // Kirim embed + file lampiran (dipakai buat Transcript) langsung ke channel
  // Discord via Bot API (multipart/form-data, sama polanya dengan pengiriman
  // webhook lama, cuma tujuannya jadi endpoint channel messages + Bot token).
  async function sendChannelEmbedWithFile(channelId, { content, embeds, fileName, fileContent }) {
    if (!channelId) return;
    try {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content, embeds }));
      form.append('files[0]', new Blob([fileContent], { type: 'text/html' }), fileName);
      await axios.post(`${DISCORD_API}/channels/${channelId}/messages`, form, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
        timeout: 20000
      });
    } catch (e) {
      console.warn('[Ticket] Gagal kirim transcript ke channel:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
    }
  }

  // ══════════════════ NOTIFICATION CHANNEL SETTINGS ══════════════════
  // Admin cukup memilih channel Discord tujuan (dari server yang sama dengan
  // Bot Channel Configuration) untuk tiap jenis notifikasi lewat dropdown di
  // halaman "Notification Channel Settings":
  //   - logsChannelId       -> Ticket Logs
  //   - transcriptChannelId -> Transcript
  //   - ratingChannelId     -> Rating & Feedback
  // Disimpan di koleksi `ticketConfig` (dokumen yang sama dengan Bot Channel
  // Config), dibaca ULANG dari DB setiap kali mau kirim (tidak ada cache di
  // memori) -> perubahan channel langsung berlaku realtime tanpa perlu
  // restart bot/server.

  // Label & icon tampilan tiap jenis activity log — dipakai buat embed yang
  // diteruskan ke channel Ticket Logs (kalau diset admin di Notification
  // Channel Settings).
  const LOG_TYPE_META = {
    config_update: { icon: '⚙️', label: 'Konfigurasi Bot Channel Diubah', color: 0x5865F2 },
    panel_create: { icon: '➕', label: 'Panel Ticket Dibuat', color: 0x57F287 },
    panel_edit: { icon: '✏️', label: 'Panel Ticket Diedit', color: 0xFEE75C },
    panel_delete: { icon: '🗑️', label: 'Panel Ticket Dihapus', color: 0xED4245 },
    panel_publish: { icon: '🚀', label: 'Panel Ticket Dipublish', color: 0x5865F2 },
    ticket_open: { icon: '🎫', label: 'Ticket Dibuka', color: 0x57F287 },
    ticket_close: { icon: '🔒', label: 'Ticket Ditutup', color: 0xED4245 },
    ticket_reopen: { icon: '🔓', label: 'Ticket Dibuka Kembali', color: 0x57F287 },
    ticket_delete: { icon: '🗑️', label: 'Ticket Dihapus', color: 0xED4245 },
    ticket_staff: { icon: '👥', label: 'Staff Ticket Diubah', color: 0x5865F2 },
    ticket_rating: { icon: '⭐', label: 'Rating Diterima', color: 0xFEE75C },
    ticket_transcript_sent: { icon: '📄', label: 'Transcript Dikirim ke Channel', color: 0x5865F2 }
  };

  // Teruskan SATU entri ticketLogs ke channel Ticket Logs (kalau diset di
  // Notification Channel Settings). Best-effort, fire-and-forget — dipanggil
  // dari logTicket() di bawah. Bot langsung mengirim embed ke channel-nya.
  async function forwardLogToChannel(logDoc) {
    const cfg = await getConfig();
    if (!cfg.logsChannelId) return;
    const meta = LOG_TYPE_META[logDoc.type] || { icon: '📋', label: logDoc.type, color: 0x5865F2 };
    await sendChannelEmbed(cfg.logsChannelId, {
      embeds: [{
        title: `${meta.icon} ${meta.label}`,
        description: logDoc.description || '-',
        color: meta.color,
        fields: [{ name: 'Aktor', value: logDoc.actorName || 'System', inline: true }],
        timestamp: (logDoc.createdAt instanceof Date ? logDoc.createdAt : new Date()).toISOString()
      }]
    });
  }

  function slugify(str) {
    return String(str || 'user')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'user';
  }

  // Bikin nama channel dari template config, contoh: "ticket-{username}-{number}",
  // "{username}-{category}", dsb. Placeholder tidak dikenal dibiarkan apa adanya.
  // Hasil akhir tetap di-slugify & dipotong 90 char supaya selalu valid di Discord.
  function renderChannelName(format, vars) {
    const template = format && String(format).trim() ? format : 'ticket-{username}-{number}';
    const raw = template
      .replace(/\{username\}/g, vars.username || 'user')
      .replace(/\{number\}/g, vars.number || '0000')
      .replace(/\{category\}/g, vars.category || 'ticket');
    return slugify(raw).slice(0, 90) || `ticket-${vars.number || '0000'}`;
  }

  function logTicket({ type, ticketId, panelId, actorId, actorName, description, meta = {} }) {
    const doc = {
      type, ticketId: ticketId || null, panelId: panelId || null,
      actorId: actorId || null, actorName: actorName || 'System',
      description: description || '', meta, createdAt: new Date()
    };
    db().collection('ticketLogs').insertOne(doc).catch(() => {});
    broadcastAdmin && broadcastAdmin('ticket:log', doc);
    forwardLogToChannel(doc).catch(() => {});
    return doc;
  }

  // ══════════════════ CONFIG (Bot Channel Configuration) ══════════════════
  // Config ini juga menyimpan pilihan dropdown "Notification Channel Settings"
  // (transcriptChannelId/ratingChannelId/logsChannelId) — channel Discord
  // tujuan tiap jenis notifikasi, dikirim langsung oleh Bot (bukan Webhook).
  async function getConfig() {
    let cfg = await db().collection('ticketConfig').findOne({ _id: 'default' });
    if (!cfg) {
      cfg = {
        _id: 'default', guildId: process.env.DISCORD_GUILD_ID || '',
        defaultCategoryId: process.env.DISCORD_TICKET_CATEGORY_ID || '',
        supportRoleId: process.env.DISCORD_SUPPORT_ROLE_ID || '',
        logChannelId: '', ticketNameFormat: 'ticket-{username}-{number}',
        transcriptChannelId: '', ratingChannelId: '', logsChannelId: ''
      };
    }
    return {
      transcriptChannelId: '', ratingChannelId: '', logsChannelId: '',
      ...cfg
    };
  }
  async function saveConfig(patch, actor) {
    const before = await getConfig();
    const next = { ...before, ...patch, _id: 'default', updatedAt: new Date() };
    await db().collection('ticketConfig').updateOne({ _id: 'default' }, { $set: next }, { upsert: true });
    logTicket({ type: 'config_update', actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: 'Konfigurasi Bot Channel diubah', meta: { before, after: next } });
    broadcastAdmin && broadcastAdmin('ticket:config', next);
    return next;
  }

  // Daftar server (guild) yang bisa diakses bot ini
  async function listGuilds() {
    return discordRequest('GET', '/users/@me/guilds');
  }
  async function listChannels(guildId) {
    const channels = await discordRequest('GET', `/guilds/${guildId}/channels`);
    return {
      textChannels: channels.filter(c => c.type === 0).sort((a, b) => a.position - b.position),
      categories: channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position)
    };
  }

  // ══════════════════════════ TICKET PANEL ══════════════════════════
  function defaultEmbed() {
    return {
      author: { name: '', iconUrl: '' },
      title: 'Butuh Bantuan?',
      description: 'Klik tombol di bawah untuk membuka ticket baru.',
      color: '#5865F2',
      thumbnailUrl: '',
      imageUrl: '',
      footer: { text: '', iconUrl: '' },
      fields: []
    };
  }

  async function listPanels() {
    return db().collection('ticketPanels').find({}).sort({ createdAt: -1 }).toArray();
  }
  async function getPanel(id) {
    return db().collection('ticketPanels').findOne({ _id: new ObjectId(id) });
  }
  async function createPanel(data, actor) {
    const doc = {
      name: data.name || 'Panel Baru',
      guildId: data.guildId || '',
      channelId: data.channelId || '',
      categoryId: data.categoryId || '',
      buttonLabel: data.buttonLabel || 'Buka Ticket',
      buttonEmoji: data.buttonEmoji || '🎫',
      buttonStyle: data.buttonStyle || 'PRIMARY',
      welcomeMessage: data.welcomeMessage || 'Halo {user}, terima kasih sudah membuka ticket. Tim kami akan segera membantu.',
      embed: { ...defaultEmbed(), ...(data.embed || {}) },
      published: false,
      messageId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await db().collection('ticketPanels').insertOne(doc);
    doc._id = result.insertedId;
    logTicket({ type: 'panel_create', panelId: doc._id, actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: `Panel "${doc.name}" dibuat` });
    broadcastAdmin && broadcastAdmin('ticket:panel', doc);
    return doc;
  }
  async function updatePanel(id, data, actor) {
    const _id = new ObjectId(id);
    const patch = { updatedAt: new Date() };
    for (const k of ['name', 'guildId', 'channelId', 'categoryId', 'buttonLabel', 'buttonEmoji', 'buttonStyle', 'welcomeMessage']) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    if (data.embed) patch.embed = { ...defaultEmbed(), ...data.embed };
    await db().collection('ticketPanels').updateOne({ _id }, { $set: patch });
    const doc = await getPanel(id);
    // Kalau panel sudah pernah dipublish, sinkronkan editan ke pesan Discord-nya juga
    if (doc.published && doc.messageId) {
      try { await syncPublishedMessage(doc); } catch (e) { console.warn('[Ticket] Gagal sinkron edit panel ke Discord:', e.message); }
    }
    logTicket({ type: 'panel_edit', panelId: _id, actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: `Panel "${doc.name}" diedit` });
    broadcastAdmin && broadcastAdmin('ticket:panel', doc);
    return doc;
  }
  async function deletePanel(id, actor) {
    const doc = await getPanel(id);
    if (!doc) return;
    if (doc.published && doc.messageId && doc.channelId) {
      await discordRequest('DELETE', `/channels/${doc.channelId}/messages/${doc.messageId}`).catch(() => {});
    }
    await db().collection('ticketPanels').deleteOne({ _id: new ObjectId(id) });
    logTicket({ type: 'panel_delete', panelId: id, actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: `Panel "${doc.name}" dihapus` });
    broadcastAdmin && broadcastAdmin('ticket:panel_deleted', { _id: id });
  }

  function hexToInt(hex) {
    if (!hex) return 0x5865F2;
    const clean = String(hex).replace('#', '');
    const n = parseInt(clean, 16);
    return Number.isNaN(n) ? 0x5865F2 : n;
  }

  function buildEmbedPayload(embed) {
    const e = { color: hexToInt(embed.color) };
    if (embed.author?.name) e.author = { name: embed.author.name, icon_url: embed.author.iconUrl || undefined };
    if (embed.title) e.title = embed.title;
    if (embed.description) e.description = embed.description;
    if (embed.thumbnailUrl) e.thumbnail = { url: embed.thumbnailUrl };
    if (embed.imageUrl) e.image = { url: embed.imageUrl };
    if (embed.footer?.text) e.footer = { text: embed.footer.text, icon_url: embed.footer.iconUrl || undefined };
    if (Array.isArray(embed.fields) && embed.fields.length) {
      e.fields = embed.fields.filter(f => f.name).map(f => ({ name: f.name, value: f.value || '\u200b', inline: !!f.inline }));
    }
    return e;
  }

  const BUTTON_STYLE_MAP = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

  function buildOpenButtonComponent(panel) {
    return {
      type: 1,
      components: [{
        type: 2,
        style: BUTTON_STYLE_MAP[panel.buttonStyle] || 1,
        label: panel.buttonLabel || 'Buka Ticket',
        emoji: panel.buttonEmoji ? { name: panel.buttonEmoji } : undefined,
        custom_id: `tkt_open_${panel._id}`
      }]
    };
  }

  // Preview: TIDAK memanggil Discord sama sekali, cuma bentuk payload buat dirender frontend
  function previewPanel(panelData) {
    return { embed: buildEmbedPayload({ ...defaultEmbed(), ...(panelData.embed || {}) }), components: [buildOpenButtonComponent({ ...panelData, _id: 'preview' })] };
  }

  async function syncPublishedMessage(panel) {
    return discordRequest('PATCH', `/channels/${panel.channelId}/messages/${panel.messageId}`, {
      embeds: [buildEmbedPayload(panel.embed)],
      components: [buildOpenButtonComponent(panel)]
    });
  }

  async function publishPanel(id, actor) {
    const panel = await getPanel(id);
    if (!panel) throw new Error('Panel tidak ditemukan');
    if (!panel.channelId) throw new Error('Panel belum punya Channel tujuan — set di Bot Channel Configuration dulu');
    if (!isBotConfigured()) throw new Error('DISCORD_BOT_TOKEN belum dikonfigurasi di server');

    let message;
    if (panel.published && panel.messageId) {
      try {
        message = await syncPublishedMessage(panel);
      } catch (e) {
        // Pesan lama sudah tidak bisa di-edit lagi (mis. sudah dihapus manual di
        // Discord, channel-nya beda, atau bot kehilangan akses ke pesan itu).
        // Daripada publish gagal terus-menerus selamanya, fallback: kirim pesan
        // BARU ke channel tujuan (perilakunya sama seperti publish pertama kali).
        console.warn(`[Ticket] Gagal sinkron pesan panel lama (messageId=${panel.messageId}), fallback ke pesan baru:`, e.message);
        message = await discordRequest('POST', `/channels/${panel.channelId}/messages`, {
          embeds: [buildEmbedPayload(panel.embed)],
          components: [buildOpenButtonComponent(panel)]
        });
      }
    } else {
      message = await discordRequest('POST', `/channels/${panel.channelId}/messages`, {
        embeds: [buildEmbedPayload(panel.embed)],
        components: [buildOpenButtonComponent(panel)]
      });
    }
    await db().collection('ticketPanels').updateOne({ _id: panel._id }, { $set: { published: true, messageId: message.id, publishedAt: new Date() } });
    const doc = await getPanel(id);
    logTicket({ type: 'panel_publish', panelId: panel._id, actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: `Panel "${panel.name}" dipublish ke channel` });
    broadcastAdmin && broadcastAdmin('ticket:panel', doc);
    return doc;
  }

  // ══════════════════════════ TICKET LIFECYCLE ══════════════════════════
  async function nextTicketNumber() {
    const counter = await db().collection('ticketCounters').findOneAndUpdate(
      { _id: 'ticket' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
    );
    return (counter?.value?.seq) || (counter?.seq) || 1;
  }

  async function listTickets({ status, category, staff, search, limit = 100 } = {}) {
    const q = {};
    if (status && status !== 'all') q.status = status;
    if (category && category !== 'all') q.category = category;
    if (staff && staff !== 'all') q.staffIds = staff;
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ channelName: re }, { subject: re }, { 'openedBy.username': re }, { ticketNumberLabel: re }];
    }
    return db().collection('tickets').find(q).sort({ createdAt: -1 }).limit(limit).toArray();
  }
  async function getTicket(id) {
    return db().collection('tickets').findOne({ _id: new ObjectId(id) });
  }

  async function openTicketFromPanel(panelId, discordUser) {
    const panel = await getPanel(panelId);
    if (!panel) throw new Error('Panel tidak ditemukan / sudah dihapus');
    const cfg = await getConfig();
    const guildId = panel.guildId || cfg.guildId;
    const categoryId = panel.categoryId || cfg.defaultCategoryId;
    const supportRoleId = cfg.supportRoleId;

    // Cegah duplikat: kalau user ini sudah punya ticket OPEN dari panel yang sama, jangan bikin baru
    const existing = await db().collection('tickets').findOne({ 'openedBy.discordId': discordUser.id, panelId: String(panel._id), status: 'open' });
    if (existing) return { alreadyOpen: true, ticket: existing };

    const number = await nextTicketNumber();
    const channelName = renderChannelName(cfg.ticketNameFormat, {
      username: slugify(discordUser.username),
      number: String(number).padStart(4, '0'),
      category: slugify(panel.name)
    });

    const permissionOverwrites = [
      { id: guildId, type: 0, deny: '1024' },
      { id: discordUser.id, type: 1, allow: '3072' }
    ];
    if (supportRoleId) permissionOverwrites.push({ id: supportRoleId, type: 0, allow: '3072' });

    const channel = await discordRequest('POST', `/guilds/${guildId}/channels`, {
      name: channelName,
      type: 0,
      parent_id: categoryId || undefined,
      topic: `Ticket #${number} — dibuka oleh ${discordUser.username}`,
      permission_overwrites: permissionOverwrites
    });

    const ticket = {
      ticketNumber: number,
      ticketNumberLabel: `#${String(number).padStart(4, '0')}`,
      guildId, channelId: channel.id, channelName: channel.name,
      panelId: String(panel._id), panelName: panel.name,
      category: panel.name,
      subject: panel.name,
      status: 'open',
      openedBy: { discordId: discordUser.id, username: discordUser.username, avatar: discordUser.avatar || null },
      staffIds: [],
      claimedBy: null,
      createdAt: new Date(),
      closedAt: null,
      reopenedAt: null,
      deletedAt: null,
      transcriptHtml: null,
      rating: null
    };
    const result = await db().collection('tickets').insertOne(ticket);
    ticket._id = result.insertedId;

    const welcome = String(panel.welcomeMessage || '').replace('{user}', `<@${discordUser.id}>`);
    const closeRow = { type: 1, components: [{ type: 2, style: 4, label: 'Close Ticket', emoji: { name: '🔒' }, custom_id: `tkt_close_${ticket._id}` }] };
    await discordRequest('POST', `/channels/${channel.id}/messages`, {
      content: `${welcome}${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
      embeds: [{
        title: `🎫 Ticket ${ticket.ticketNumberLabel}`,
        description: 'Jelaskan kendala/kebutuhanmu di sini. Staff akan segera merespon.',
        color: 0x5865F2,
        fields: [
          { name: 'Dibuka Oleh', value: `<@${discordUser.id}>`, inline: true },
          { name: 'Kategori', value: panel.name, inline: true }
        ],
        timestamp: new Date().toISOString()
      }],
      components: [closeRow],
      allowed_mentions: { parse: [], users: [discordUser.id], roles: supportRoleId ? [supportRoleId] : [] }
    }).catch(() => {});

    logTicket({ type: 'ticket_open', ticketId: ticket._id, panelId: panel._id, actorId: discordUser.id, actorName: discordUser.username, description: `Ticket ${ticket.ticketNumberLabel} dibuka` });
    broadcastAdmin && broadcastAdmin('ticket:new', ticket);
    return { alreadyOpen: false, ticket };
  }

  // Ambil SELURUH history pesan channel (paginated, 100/request) buat transcript
  async function fetchAllMessages(channelId) {
    let all = [];
    let before;
    for (let i = 0; i < 50; i++) { // hard cap 5000 pesan biar tidak infinite loop
      const batch = await discordRequest('GET', `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
      if (!batch.length) break;
      all = all.concat(batch);
      before = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }
    return all.reverse(); // urut lama -> baru
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderTranscriptHtml(ticket, messages) {
    const rows = messages.map(m => {
      const author = escapeHtml(m.author?.username || 'Unknown');
      const avatar = m.author?.avatar
        ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;
      const time = new Date(m.timestamp).toLocaleString('id-ID');
      const content = escapeHtml(m.content || '').replace(/\n/g, '<br>');
      const embeds = (m.embeds || []).map(e => `
        <div style="border-left:3px solid #${(e.color || 5865950).toString(16).padStart(6, '0')};background:#2b2d31;padding:10px 14px;border-radius:6px;margin-top:6px;max-width:520px;">
          ${e.title ? `<div style="font-weight:600;color:#fff;">${escapeHtml(e.title)}</div>` : ''}
          ${e.description ? `<div style="color:#dbdee1;font-size:14px;margin-top:4px;">${escapeHtml(e.description).replace(/\n/g, '<br>')}</div>` : ''}
        </div>`).join('');
      const attachments = (m.attachments || []).map(a => `<div style="margin-top:6px;"><a href="${a.url}" style="color:#00a8fc;" target="_blank">📎 ${escapeHtml(a.filename)}</a></div>`).join('');
      return `
        <div style="display:flex;gap:12px;padding:10px 16px;border-bottom:1px solid #2f3136;">
          <img src="${avatar}" width="40" height="40" style="border-radius:50%;flex-shrink:0;">
          <div style="min-width:0;">
            <div><span style="font-weight:600;color:#fff;">${author}</span> <span style="color:#949ba4;font-size:12px;margin-left:6px;">${time}</span></div>
            <div style="color:#dbdee1;font-size:14px;white-space:pre-wrap;word-break:break-word;">${content}</div>
            ${embeds}${attachments}
          </div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8"><title>Transcript ${ticket.ticketNumberLabel}</title>
<style>body{background:#313338;margin:0;font-family:'gg sans',Segoe UI,Helvetica,Arial,sans-serif;}
.header{background:#2b2d31;padding:20px;color:#fff;border-bottom:1px solid #1e1f22;}
.header h1{margin:0;font-size:20px;}
.header p{margin:4px 0 0;color:#949ba4;font-size:13px;}
</style></head>
<body>
  <div class="header">
    <h1>🎫 Transcript — Ticket ${ticket.ticketNumberLabel}</h1>
    <p>Channel: #${escapeHtml(ticket.channelName)} · Dibuka oleh: ${escapeHtml(ticket.openedBy?.username)} · Kategori: ${escapeHtml(ticket.category)}</p>
    <p>Dibuat: ${new Date(ticket.createdAt).toLocaleString('id-ID')} · Ditutup: ${ticket.closedAt ? new Date(ticket.closedAt).toLocaleString('id-ID') : '-'}</p>
  </div>
  <div>${rows || '<p style="color:#949ba4;padding:20px;">Tidak ada pesan.</p>'}</div>
</body></html>`;
  }

  async function sendRatingDm(ticket) {
    try {
      const dmChannel = await discordRequest('POST', '/users/@me/channels', { recipient_id: ticket.openedBy.discordId });
      const row = {
        type: 1,
        components: [1, 2, 3, 4, 5].map(star => ({
          type: 2, style: 2, label: '⭐'.repeat(star), custom_id: `tkt_rate_${ticket._id}_${star}`
        }))
      };
      await discordRequest('POST', `/channels/${dmChannel.id}/messages`, {
        embeds: [{
          title: 'Beri Rating Layanan Kami',
          description: `Ticket ${ticket.ticketNumberLabel} (${ticket.category}) telah ditutup. Bagaimana pelayanan yang kamu terima?`,
          color: 0xFEE75C
        }],
        components: [row]
      });
    } catch (e) {
      console.warn('[Ticket] Gagal kirim DM rating (mungkin DM user ditutup):', e.message);
    }
  }

  async function closeTicket(ticketId, actor) {
    const ticket = await getTicket(ticketId);
    if (!ticket) throw new Error('Ticket tidak ditemukan');
    if (ticket.status === 'closed') return ticket;

    // Cabut akses channel sepenuhnya dari opener: begitu ticket ditutup, user
    // TIDAK LAGI bisa melihat ataupun mengakses channel-nya sama sekali
    // (deny VIEW_CHANNEL 1024 + SEND_MESSAGES 2048 = 3072). Channel-nya sendiri
    // TIDAK dihapus di sini — tetap ada, hanya bisa diakses Staff/Admin untuk
    // review (lihat reopenTicket() buat kembalikan akses saat Reopen).
    await discordRequest('PUT', `/channels/${ticket.channelId}/permissions/${ticket.openedBy.discordId}`, {
      type: 1, allow: '0', deny: '3072'
    }).catch(() => {});

    let transcriptHtml = null;
    try {
      const messages = await fetchAllMessages(ticket.channelId);
      transcriptHtml = renderTranscriptHtml(ticket, messages);
    } catch (e) {
      console.warn('[Ticket] Gagal generate transcript:', e.message);
    }

    // Tombol aksi buat Staff/Admin di channel yang sudah Closed (channel-nya
    // sengaja tidak dihapus supaya 3 tombol ini masih bisa dipakai untuk
    // review): Delete Channel, Send Transcript (ke channel Transcript saja), Reopen.
    const closedActionsRow = {
      type: 1,
      components: [
        { type: 2, style: 4, label: 'Delete Channel', emoji: { name: '🗑️' }, custom_id: `tkt_delchannel_${ticket._id}` },
        { type: 2, style: 2, label: 'Send Transcript', emoji: { name: '📄' }, custom_id: `tkt_sendtranscript_${ticket._id}` },
        { type: 2, style: 3, label: 'Reopen Ticket', emoji: { name: '🔓' }, custom_id: `tkt_reopen_${ticket._id}` }
      ]
    };
    await discordRequest('POST', `/channels/${ticket.channelId}/messages`, {
      embeds: [{ title: '🔒 Ticket Ditutup', description: `Ticket ditutup oleh ${actor?.username || 'Staff'}.`, color: 0xED4245, timestamp: new Date().toISOString() }],
      components: [closedActionsRow]
    }).catch(() => {});

    const patch = { status: 'closed', closedAt: new Date(), closedBy: actor?.username || 'Staff', transcriptHtml };
    await db().collection('tickets').updateOne({ _id: ticket._id }, { $set: patch });
    const updated = { ...ticket, ...patch };

    logTicket({ type: 'ticket_close', ticketId: ticket._id, actorId: actor?.discordId, actorName: actor?.username || 'Staff', description: `Ticket ${ticket.ticketNumberLabel} ditutup` });
    broadcastAdmin && broadcastAdmin('ticket:update', updated);

    // CATATAN: transcript TIDAK otomatis dikirim ke channel Transcript di sini
    // lagi. Transcript-nya sudah disimpan (transcriptHtml di atas) dan baru
    // dikirim ke channel Transcript kalau Staff/Admin klik tombol "Send
    // Transcript" secara manual (lihat sendTranscriptToChannel() di bawah,
    // dipicu dari tombol Discord "tkt_sendtranscript_..." atau Web Admin).

    sendRatingDm(updated).catch(() => {});
    return updated;
  }

  // Aksi "Send Transcript" (khusus Ticket berstatus Closed, dipicu manual oleh
  // Staff/Admin dari Ticket Detail). BEDA dengan notifikasi otomatis di
  // closeTicket() di atas: yang ini WAJIB melempar error kalau gagal/channel
  // belum diset, supaya Staff yang klik tombolnya dapat feedback jelas —
  // bukan best-effort/fire-and-forget seperti notifikasi lain. Transcript
  // dikirim LANGSUNG oleh Bot Discord (bukan Webhook) ke channel yang dipilih
  // di halaman "Notification Channel Settings", TIDAK PERNAH di-download/
  // dikirim sebagai response file ke browser.
  async function sendTranscriptToChannel(ticketId, actor) {
    const ticket = await getTicket(ticketId);
    if (!ticket) throw new Error('Ticket tidak ditemukan');
    if (ticket.status !== 'closed') throw new Error('Transcript hanya bisa dikirim untuk Ticket yang sudah Closed.');

    const cfg = await getConfig();
    if (!cfg.transcriptChannelId) throw new Error('Channel Transcript belum diatur di halaman Notification Channel Settings.');

    // Pakai transcript yang sudah tersimpan waktu Ticket ditutup; kalau karena
    // sesuatu hal belum ada, generate ulang dari history channel (channel-nya
    // memang sengaja tidak dihapus saat Close supaya ini tetap bisa dilakukan).
    let transcriptHtml = ticket.transcriptHtml;
    if (!transcriptHtml) {
      const messages = await fetchAllMessages(ticket.channelId);
      transcriptHtml = renderTranscriptHtml(ticket, messages);
      await db().collection('tickets').updateOne({ _id: ticket._id }, { $set: { transcriptHtml } });
    }

    await sendChannelEmbedWithFile(cfg.transcriptChannelId, {
      embeds: [{
        title: '📄 Transcript Ticket Dikirim',
        description: `Transcript Ticket **${ticket.ticketNumberLabel}** dikirim manual oleh **${actor?.username || 'Staff'}**.`,
        color: 0x5865F2,
        fields: [
          { name: 'Dibuka Oleh', value: ticket.openedBy?.username || '-', inline: true },
          { name: 'Kategori', value: ticket.category || '-', inline: true },
          { name: 'Channel', value: `#${ticket.channelName}`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }],
      fileName: `transcript-${ticket.ticketNumberLabel}.html`,
      fileContent: transcriptHtml
    });

    logTicket({ type: 'ticket_transcript_sent', ticketId: ticket._id, actorId: actor?.discordId, actorName: actor?.username || 'Staff', description: `Transcript ${ticket.ticketNumberLabel} dikirim ke channel` });
    return { sent: true };
  }

  async function reopenTicket(ticketId, actor) {
    const ticket = await getTicket(ticketId);
    if (!ticket) throw new Error('Ticket tidak ditemukan');
    await discordRequest('PUT', `/channels/${ticket.channelId}/permissions/${ticket.openedBy.discordId}`, {
      type: 1, allow: '3072', deny: '0'
    }).catch(() => {});
    await discordRequest('POST', `/channels/${ticket.channelId}/messages`, {
      embeds: [{ title: '🔓 Ticket Dibuka Kembali', description: `Ticket dibuka kembali oleh ${actor?.username || 'Staff'}.`, color: 0x57F287 }]
    }).catch(() => {});
    const patch = { status: 'open', reopenedAt: new Date() };
    await db().collection('tickets').updateOne({ _id: ticket._id }, { $set: patch });
    const updated = { ...ticket, ...patch };
    logTicket({ type: 'ticket_reopen', ticketId: ticket._id, actorId: actor?.discordId, actorName: actor?.username || 'Staff', description: `Ticket ${ticket.ticketNumberLabel} dibuka kembali` });
    broadcastAdmin && broadcastAdmin('ticket:update', updated);
    return updated;
  }

  async function deleteTicket(ticketId, actor) {
    const ticket = await getTicket(ticketId);
    if (!ticket) throw new Error('Ticket tidak ditemukan');
    await discordRequest('DELETE', `/channels/${ticket.channelId}`).catch(() => {});
    await db().collection('tickets').updateOne({ _id: ticket._id }, { $set: { status: 'deleted', deletedAt: new Date() } });
    logTicket({ type: 'ticket_delete', ticketId: ticket._id, actorId: actor?.discordId, actorName: actor?.username || 'Staff', description: `Ticket ${ticket.ticketNumberLabel} dihapus` });
    broadcastAdmin && broadcastAdmin('ticket:deleted', { _id: ticket._id });
  }

  async function setStaff(ticketId, staffIds, actor) {
    await db().collection('tickets').updateOne({ _id: new ObjectId(ticketId) }, { $set: { staffIds } });
    const updated = await getTicket(ticketId);
    logTicket({ type: 'ticket_staff', ticketId, actorId: actor?.discordId, actorName: actor?.username || 'Admin', description: `Staff ticket ${updated.ticketNumberLabel} diubah` });
    broadcastAdmin && broadcastAdmin('ticket:update', updated);
    return updated;
  }

  // ══════════════════════════ RATING (via DM button + modal Feedback) ══════════════════════════
  // `feedback` opsional — diisi lewat Modal ("Feedback (opsional)") yang muncul
  // setelah user klik salah satu tombol bintang di DM (lihat buildRatingModal
  // & handleInteraction custom_id "tkt_ratemodal_..." di bawah).
  async function saveRating(ticketId, stars, discordUser, feedback) {
    const ticket = await getTicket(ticketId);
    if (!ticket) return null;
    if (ticket.rating) return ticket; // sudah pernah rating, jangan overwrite
    const cleanFeedback = String(feedback || '').trim().slice(0, 1000) || null;
    const rating = { stars: Number(stars), feedback: cleanFeedback, ratedAt: new Date(), by: discordUser?.username || ticket.openedBy?.username, byDiscordId: discordUser?.id || ticket.openedBy?.discordId };
    await db().collection('tickets').updateOne({ _id: ticket._id }, { $set: { rating } });
    const updated = { ...ticket, rating };
    logTicket({ type: 'ticket_rating', ticketId: ticket._id, actorName: rating.by, description: `Rating ${'⭐'.repeat(stars)} diberikan untuk ${ticket.ticketNumberLabel}` });
    broadcastAdmin && broadcastAdmin('ticket:update', updated);

    // Notif rating ke channel Rating & Feedback (kalau diset di Notification
    // Channel Settings) — dikirim LANGSUNG oleh Bot. Layout 2 kolom x 3 baris
    // (inline:true + spacer '\u200b' tiap akhir baris supaya Discord tidak
    // "memadatkan" jadi 3 kolom). Staff tetap di-mention lewat `content`
    // (bukan field embed): kalau ticket sudah di-Claim (ticket.claimedBy
    // terisi) pakai mention User Staff itu, kalau belum pakai mention Role
    // Staff default (DEFAULT_STAFF_ROLE_ID).
    //
    // Field "Channel" HARUS mention channel asal Panel/Embed Ticket dibuat
    // (panel.channelId) — BUKAN channel ticket sementara (ticket.channelId)
    // ataupun channel log. Ticket menyimpan panelId saat dibuka (lihat
    // openTicketFromPanel), jadi panel-nya di-lookup lewat getPanel().
    getConfig().then(async cfg => {
      if (!cfg.ratingChannelId) return;
      const staffMention = updated.claimedBy ? `<@${updated.claimedBy}>` : `<@&${DEFAULT_STAFF_ROLE_ID}>`;
      const starsDisplay = `${'⭐'.repeat(Number(stars))}${'☆'.repeat(5 - Number(stars))} (${stars}/5)`;
      const panel = updated.panelId ? await getPanel(updated.panelId).catch(() => null) : null;
      const panelChannelMention = panel?.channelId ? `<#${panel.channelId}>` : '-';
      const spacer = { name: '\u200b', value: '\u200b', inline: true };
      sendChannelEmbed(cfg.ratingChannelId, {
        content: staffMention,
        embeds: [{
          title: '📊 Ticket Rating',
          color: 0xFEE75C,
          fields: [
            { name: '👤 User', value: rating.byDiscordId ? `<@${rating.byDiscordId}>` : (rating.by || '-'), inline: true },
            { name: '📂 Kategori', value: updated.category || '-', inline: true },
            spacer,
            { name: '💬 Channel', value: panelChannelMention, inline: true },
            { name: '🆔 Ticket ID', value: updated.ticketNumberLabel, inline: true },
            spacer,
            { name: '⭐ Rating', value: starsDisplay, inline: true },
            { name: '📝 Feedback', value: cleanFeedback || '_(tidak ada feedback)_', inline: true }
          ]
        }]
      });
    }).catch(() => {});

    return updated;
  }

  // Modal "Feedback (opsional)" yang dibalas LANGSUNG (synchronous, type 9)
  // ke Discord saat user klik tombol bintang — HARUS dibalas langsung tanpa
  // deferred ACK dulu (aturan Modal di Discord Interactions), makanya ini
  // dipanggil dari server.js SEBELUM masuk ke handleInteraction() di bawah.
  function buildRatingModal(customId) {
    const rest = customId.replace('tkt_rate_', ''); // "<ticketId>_<star>"
    return {
      type: 9, // MODAL
      data: {
        custom_id: `tkt_ratemodal_${rest}`,
        title: 'Beri Rating Layanan Kami',
        components: [{
          type: 1,
          components: [{
            type: 4, // TEXT_INPUT
            custom_id: 'tkt_rate_feedback',
            style: 2, // paragraph
            label: 'Feedback (opsional)',
            placeholder: 'Ceritakan pengalamanmu, boleh dikosongkan...',
            required: false,
            max_length: 500
          }]
        }]
      }
    };
  }
  // Klik tombol "Close Ticket" di channel TIDAK LANGSUNG menutup Ticket.
  // Dibalas LANGSUNG (synchronous, type 4, ephemeral lewat flags:64) dengan
  // pesan konfirmasi berisi tombol "Ya"/"Tidak" — sama polanya dengan
  // buildRatingModal() di atas (dibalas sebelum masuk ke alur deferred+
  // handleInteraction), karena di sini juga tidak ada proses berat yang perlu
  // di-defer. Ticket baru benar-benar ditutup kalau Staff klik "Ya"
  // (custom_id "tkt_closeyes_...", ditangani di handleInteraction di bawah).
  function buildCloseConfirmMessage(customId) {
    const ticketId = customId.replace('tkt_close_', '');
    return {
      type: 4,
      data: {
        flags: 64,
        embeds: [{ title: '🔒 Tutup Ticket', description: 'Apakah Anda yakin ingin menutup Ticket ini?', color: 0xED4245 }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 4, label: 'Ya', custom_id: `tkt_closeyes_${ticketId}` },
            { type: 2, style: 2, label: 'Tidak', custom_id: `tkt_closeno_${ticketId}` }
          ]
        }]
      }
    };
  }

  // Klik tombol "Delete Channel" (muncul di pesan "🔒 Ticket Ditutup" untuk
  // Ticket yang sudah Closed) JUGA tidak langsung menghapus — sama seperti
  // Close Ticket, dibalas langsung dengan konfirmasi "Ya"/"Tidak" dulu, karena
  // aksi ini menghapus channel secara PERMANEN dan tidak bisa dibatalkan.
  function buildDeleteConfirmMessage(customId) {
    const ticketId = customId.replace('tkt_delchannel_', '');
    return {
      type: 4,
      data: {
        flags: 64,
        embeds: [{ title: '🗑️ Delete Channel', description: 'Hapus channel Ticket ini secara **permanen** dari Discord? Tindakan ini tidak bisa dibatalkan.', color: 0xED4245 }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 4, label: 'Ya', custom_id: `tkt_delyes_${ticketId}` },
            { type: 2, style: 2, label: 'Tidak', custom_id: `tkt_delno_${ticketId}` }
          ]
        }]
      }
    };
  }

  async function listRatings() {
    const tickets = await db().collection('tickets').find({ rating: { $ne: null } }).sort({ 'rating.ratedAt': -1 }).toArray();
    const avg = tickets.length ? (tickets.reduce((s, t) => s + t.rating.stars, 0) / tickets.length) : 0;
    return { tickets, average: Math.round(avg * 10) / 10, total: tickets.length };
  }

  async function listLogs({ ticketId, limit = 200 } = {}) {
    const q = {};
    if (ticketId) q.ticketId = ticketId;
    return db().collection('ticketLogs').find(q).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  // ══════════════════════════ INTERACTION ROUTER ══════════════════════════
  function isHandledCustomId(customId) {
    return typeof customId === 'string' && customId.startsWith('tkt_');
  }

  // Dipanggil dari /api/discord/interactions di server.js untuk custom_id "tkt_*".
  // Discord butuh ACK cepat (<3 detik) -> caller sudah balas duluan (deferred),
  // fungsi ini jalan async di belakang layar (fire-and-forget dari sisi caller).
  async function handleInteraction(interaction) {
    const customId = interaction.data?.custom_id || '';
    const discordUser = interaction.member?.user || interaction.user;
    const applicationId = interaction.application_id;
    const token = interaction.token;

    async function editOriginal(payload) {
      return discordRequest('PATCH', `/webhooks/${applicationId}/${token}/messages/@original`, payload).catch(() => {});
    }

    try {
      if (customId.startsWith('tkt_open_')) {
        const panelId = customId.replace('tkt_open_', '');
        const { alreadyOpen, ticket } = await openTicketFromPanel(panelId, discordUser);
        await editOriginal({ content: alreadyOpen ? `⚠️ Kamu sudah punya ticket terbuka: <#${ticket.channelId}>` : `✅ Ticket berhasil dibuka: <#${ticket.channelId}>` });
        return;
      }
      // "tkt_close_..." (klik pertama) TIDAK PERNAH sampai ke sini — sudah
      // dijawab langsung dengan pesan konfirmasi lewat buildCloseConfirmMessage()
      // di server.js SEBELUM masuk ke alur deferred ini (lihat di sana). Yang
      // sampai ke sini cuma hasil klik "Ya"/"Tidak" pada pesan konfirmasi itu.
      if (customId.startsWith('tkt_closeyes_')) {
        const ticketId = customId.replace('tkt_closeyes_', '');
        await closeTicket(ticketId, { discordId: discordUser.id, username: discordUser.username });
        await editOriginal({ content: '🔒 Ticket ditutup.', embeds: [], components: [] });
        return;
      }
      if (customId.startsWith('tkt_closeno_')) {
        await editOriginal({ content: '❌ Dibatalkan. Ticket tetap terbuka.', embeds: [], components: [] });
        return;
      }
      // Tombol "Reopen Ticket" & "Send Transcript" di pesan "🔒 Ticket
      // Ditutup" — aksi langsung, tidak perlu konfirmasi tambahan.
      if (customId.startsWith('tkt_reopen_')) {
        const ticketId = customId.replace('tkt_reopen_', '');
        await reopenTicket(ticketId, { discordId: discordUser.id, username: discordUser.username });
        await editOriginal({ content: '🔓 Ticket dibuka kembali & akses user sudah dikembalikan.' });
        return;
      }
      if (customId.startsWith('tkt_sendtranscript_')) {
        const ticketId = customId.replace('tkt_sendtranscript_', '');
        await sendTranscriptToChannel(ticketId, { discordId: discordUser.id, username: discordUser.username });
        await editOriginal({ content: '📄 Transcript sudah dikirim ke channel.' });
        return;
      }
      // "tkt_delchannel_..." (klik pertama) TIDAK PERNAH sampai ke sini — sudah
      // dijawab langsung dengan pesan konfirmasi lewat buildDeleteConfirmMessage()
      // di server.js (channel dihapus permanen, jadi WAJIB dikonfirmasi dulu).
      // Yang sampai ke sini cuma hasil klik "Ya"/"Tidak" pada konfirmasi itu.
      if (customId.startsWith('tkt_delyes_')) {
        const ticketId = customId.replace('tkt_delyes_', '');
        await deleteTicket(ticketId, { discordId: discordUser.id, username: discordUser.username });
        // Channel-nya sendiri sudah hilang begitu deleteTicket() selesai, jadi
        // edit pesan konfirmasi ini best-effort saja (bisa saja gagal kalau
        // Discord sudah keburu membuang channel-nya).
        await editOriginal({ content: '🗑️ Channel Ticket sudah dihapus.', embeds: [], components: [] });
        return;
      }
      if (customId.startsWith('tkt_delno_')) {
        await editOriginal({ content: 'Dibatalkan. Channel tidak jadi dihapus.', embeds: [], components: [] });
        return;
      }
      // Submit Modal "Feedback (opsional)" — muncul setelah user klik tombol
      // bintang di DM (klik tombolnya sendiri dibalas langsung dengan Modal
      // lewat buildRatingModal() di server.js, TIDAK pernah sampai ke sini).
      if (customId.startsWith('tkt_ratemodal_')) {
        const rest = customId.replace('tkt_ratemodal_', '');
        const [ticketId, stars] = rest.split('_');
        const feedbackValue = interaction.data?.components?.[0]?.components?.[0]?.value || '';
        await saveRating(ticketId, stars, discordUser, feedbackValue);
        await editOriginal({ content: `Terima kasih atas rating ${'⭐'.repeat(Number(stars))}-nya! 🙏`, embeds: [], components: [] });
        return;
      }
      await editOriginal({ content: 'Aksi tidak dikenali.' });
    } catch (e) {
      console.error('[Ticket] handleInteraction error:', e.message);
      await editOriginal({ content: `❌ Gagal memproses: ${e.message}` });
    }
  }

  return {
    isBotConfigured,
    getConfig, saveConfig, listGuilds, listChannels,
    listPanels, getPanel, createPanel, updatePanel, deletePanel, publishPanel, previewPanel, defaultEmbed,
    listTickets, getTicket, closeTicket, reopenTicket, deleteTicket, setStaff, sendTranscriptToChannel,
    listRatings, listLogs,
    isHandledCustomId, handleInteraction, buildRatingModal, buildCloseConfirmMessage, buildDeleteConfirmMessage
  };
};