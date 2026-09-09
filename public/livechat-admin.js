// ══════════════════════════════════════════════════════════════════════════
// LIVE CHAT — Frontend Admin Web (halaman terpisah, modular, pola SAMA PERSIS
// dengan tickets-admin.js). Reuse token login admin yang sama (localStorage
// 'adminToken') supaya tidak perlu login dua kali dari admin.html utama.
// ══════════════════════════════════════════════════════════════════════════
(function () {
  const token = localStorage.getItem('adminToken');
  if (!token) { window.location.href = 'admin.html'; return; }

  const API = '/api/admin/livechat';
  const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request gagal (${res.status})`);
    return data;
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toastStack').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function $(id) { return document.getElementById(id); }
  function fmtTime(d) { try { return new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function fmtRelTime(d) {
    if (!d) return '';
    const diffMs = Date.now() - new Date(d).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'baru saja';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}j`;
    return `${Math.floor(h / 24)}h`;
  }
  const EMOJI_LIST = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😎','😢','😭','😡','👍','👎','👏','🙏','🔥','🎉','❤️','💯','✅','❌','⚠️','🎮','💬','😴','🥳'];

  // ── STATE ──
  let conversations = [];
  let activeDiscordId = null;
  let activeMessages = [];
  let currentFilter = 'all';
  let currentSearch = '';
  let pendingImage = null;
  let typingHideTimer = null;
  let lastTypingSentAt = 0;

  // ══════════════════════════ CONVERSATION LIST ══════════════════════════
  async function loadConversations() {
    try {
      const { conversations: list } = await api(`/conversations?filter=${currentFilter}&search=${encodeURIComponent(currentSearch)}`);
      conversations = list;
      renderConvoList();
    } catch (e) {
      $('lcaConvoList').innerHTML = `<div class="lc-convo-empty">Gagal memuat: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderConvoList() {
    const el = $('lcaConvoList');
    if (!conversations.length) {
      el.innerHTML = `<div class="lc-convo-empty">Belum ada percakapan.</div>`;
      return;
    }
    el.innerHTML = conversations.map(c => {
      const preview = c.lastMessage
        ? (c.lastMessage.imageData ? '📷 Gambar' : escapeHtml(c.lastMessage.text || '').slice(0, 46))
        : 'Belum ada pesan';
      const prefix = c.lastMessage?.sender === 'admin' ? 'Anda: ' : '';
      const avatar = c.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(c.username)}`;
      return `
        <div class="lc-convo-item ${c.discordId === activeDiscordId ? 'active' : ''}" data-id="${c.discordId}">
          <div class="lc-convo-avatar-wrap">
            <img class="lc-convo-avatar" src="${avatar}" alt="">
            <span class="lc-convo-online-dot ${c.online ? 'online' : ''}"></span>
          </div>
          <div class="lc-convo-main">
            <div class="lc-convo-top">
              <div class="lc-convo-name">${escapeHtml(c.username)}</div>
              <div class="lc-convo-time">${fmtRelTime(c.lastActivity)}</div>
            </div>
            <div class="lc-convo-last">${prefix}${preview}</div>
          </div>
          ${c.unreadCount > 0 ? `<div class="lc-convo-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</div>` : ''}
        </div>`;
    }).join('');
  }

  function upsertConversation(summary) {
    const idx = conversations.findIndex(c => c.discordId === summary.discordId);
    if (idx >= 0) conversations[idx] = summary; else conversations.unshift(summary);
    // Percakapan dengan pesan baru otomatis pindah ke atas daftar.
    conversations.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
    applyClientFilterAndRender();
  }

  function applyClientFilterAndRender() {
    // Re-fetch dari server tetap paling akurat untuk filter/search kompleks,
    // tapi supaya reorder & badge terasa instan tanpa nunggu round-trip, re-render
    // langsung dari state lokal dulu.
    renderConvoList();
  }

  $('lcaConvoList').addEventListener('click', (ev) => {
    const item = ev.target.closest('.lc-convo-item');
    if (!item) return;
    openConversation(item.dataset.id);
  });

  $('lcaSearch').addEventListener('input', debounce((ev) => {
    currentSearch = ev.target.value.trim();
    loadConversations();
  }, 350));

  $('lcaFilters').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.lc-filter-chip');
    if (!chip) return;
    document.querySelectorAll('.lc-filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    loadConversations();
  });

  $('btnRefreshConvos').addEventListener('click', () => { loadConversations(); if (activeDiscordId) loadActiveMessages(); });

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ══════════════════════════ CHAT PANEL ══════════════════════════
  async function openConversation(discordId) {
    activeDiscordId = discordId;
    document.querySelectorAll('.lc-convo-item').forEach(el => el.classList.toggle('active', el.dataset.id === discordId));
    $('lcaChatEmptyState').style.display = 'none';
    $('lcaChatActive').style.display = 'flex';

    const convo = conversations.find(c => c.discordId === discordId);
    $('lcaChatAvatar').src = convo?.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(convo?.username || discordId)}`;
    $('lcaChatUsername').textContent = convo?.username || discordId;
    setUserStatus(convo?.online);
    clearPendingImage();
    $('lcaInputText').value = '';

    await loadActiveMessages();
    await markRead(discordId);
  }

  function setUserStatus(online) {
    $('lcaChatUserStatus').innerHTML = online
      ? `<span class="lc-dot lc-dot-online"></span> Online`
      : `<span class="lc-dot lc-dot-offline"></span> Offline`;
  }

  async function loadActiveMessages() {
    if (!activeDiscordId) return;
    $('lcaMessages').innerHTML = `<div class="lc-skeleton-row">
      <div class="lc-skeleton" style="width:50%;align-self:flex-start;"></div>
      <div class="lc-skeleton" style="width:40%;align-self:flex-end;"></div>
      <div class="lc-skeleton" style="width:60%;align-self:flex-start;"></div>
    </div>`;
    try {
      const { messages } = await api(`/conversations/${activeDiscordId}/messages`);
      activeMessages = messages;
      renderMessages();
    } catch (e) {
      $('lcaMessages').innerHTML = `<div class="lc-convo-empty">Gagal memuat pesan: ${escapeHtml(e.message)}</div>`;
    }
  }

  // Versi "diam-diam" dari resync — dipakai fallback periodik (bukan mekanisme
  // utama) supaya TIDAK menghapus-ulang seluruh panel (skeleton loader) dan
  // mengganggu admin yang sedang mengetik balasan. Cuma pesan yang benar-benar
  // baru (belum ada di layar) yang di-append.
  async function silentRefreshActiveMessages() {
    if (!activeDiscordId) return;
    try {
      const { messages: fresh } = await api(`/conversations/${activeDiscordId}/messages`);
      const knownIds = new Set(activeMessages.map(m => String(m._id)));
      const newOnes = fresh.filter(m => !knownIds.has(String(m._id)));
      if (newOnes.length) { newOnes.forEach(appendActiveMessage); }
    } catch (e) { /* diam-diam */ }
  }

  function renderMessages() {
    $('lcaMessages').innerHTML = activeMessages.map(renderMessageRow).join('');
    scrollChatToBottom();
  }

  function renderMessageRow(m) {
    const mine = m.sender === 'admin';
    const imgHtml = m.imageData ? `<img src="${m.imageData}" data-lca-zoom loading="lazy" />` : '';
    const textHtml = m.text ? `<div>${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>` : '';
    const readTick = mine ? `<svg class="icon ${m.readByUser ? 'lc-read' : ''}"><use href="#ic-check-check"></use></svg>` : '';
    return `
      <div class="lc-msg-row ${mine ? 'lc-from-admin' : 'lc-from-user'}" data-id="${m._id}">
        <div class="lc-bubble">${textHtml}${imgHtml}</div>
        <div class="lc-msg-meta">${escapeHtml(fmtTime(m.createdAt))}${readTick}</div>
      </div>`;
  }

  function appendActiveMessage(m) {
    // FIX (duplicate message): broadcastAdmin() mengirim event ke SEMUA admin yang
    // sedang online, TERMASUK admin yang baru saja mengirim pesan itu sendiri (yang
    // sudah lebih dulu di-append langsung dari response REST di sendReply()). Tanpa
    // guard ini, pesan admin yang lagi mengetik akan muncul dobel di layarnya sendiri.
    if (activeMessages.some(x => String(x._id) === String(m._id))) return;
    activeMessages.push(m);
    $('lcaMessages').insertAdjacentHTML('beforeend', renderMessageRow(m));
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const body = $('lcaChatBody');
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  async function markRead(discordId) {
    try { await api(`/conversations/${discordId}/read`, { method: 'POST' }); } catch (e) {}
  }

  // ══════════════════════════ SEND ══════════════════════════
  async function sendReply() {
    if (!activeDiscordId) return;
    const textEl = $('lcaInputText');
    const text = (textEl.value || '').trim();
    if (!text && !pendingImage) return;

    const btn = $('lcaSendBtn');
    btn.disabled = true;
    try {
      const body = { text };
      if (pendingImage) body.imageData = pendingImage;
      const { message } = await api(`/conversations/${activeDiscordId}/send`, { method: 'POST', body: JSON.stringify(body) });
      appendActiveMessage(message);
      textEl.value = '';
      autoGrow(textEl);
      clearPendingImage();
    } catch (e) {
      toast(e.message || 'Gagal mengirim balasan', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

  $('lcaSendBtn').addEventListener('click', sendReply);
  $('lcaInputText').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendReply(); }
  });
  $('lcaInputText').addEventListener('input', (ev) => {
    autoGrow(ev.target);
    if (ev.target.value.trim() && activeDiscordId) notifyTyping();
  });

  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSentAt < 1500) return;
    lastTypingSentAt = now;
    api(`/conversations/${activeDiscordId}/typing`, { method: 'POST', body: JSON.stringify({ typing: true }) }).catch(() => {});
  }

  function showTypingIndicator(discordId) {
    if (discordId !== activeDiscordId) return;
    $('lcaTypingIndicator').style.display = 'flex';
    scrollChatToBottom();
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => { $('lcaTypingIndicator').style.display = 'none'; }, 3500);
  }

  // ══════════════════════════ IMAGE UPLOAD ══════════════════════════
  function handleImageFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Ukuran gambar maksimal 5MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = reader.result;
      $('lcaImagePreviewImg').src = reader.result;
      $('lcaImagePreview').style.display = 'block';
    };
    reader.readAsDataURL(file);
  }
  function clearPendingImage() {
    pendingImage = null;
    $('lcaImagePreview').style.display = 'none';
    $('lcaImagePreviewImg').src = '';
    $('lcaImageInput').value = '';
  }
  $('lcaImageBtn').addEventListener('click', () => $('lcaImageInput').click());
  $('lcaImageInput').addEventListener('change', (ev) => handleImageFile(ev.target.files?.[0]));
  $('lcaImagePreviewRemove').addEventListener('click', clearPendingImage);

  // ══════════════════════════ EMOJI PICKER ══════════════════════════
  $('lcaEmojiPicker').innerHTML = EMOJI_LIST.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  $('lcaEmojiPicker').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-emoji]');
    if (!btn) return;
    const textEl = $('lcaInputText');
    textEl.value += btn.dataset.emoji;
    autoGrow(textEl);
    textEl.focus();
  });
  $('lcaEmojiBtn').addEventListener('click', () => {
    const el = $('lcaEmojiPicker');
    const show = el.style.display === 'none';
    el.style.display = show ? 'grid' : 'none';
    $('lcaEmojiBtn').classList.toggle('active', show);
  });

  // ══════════════════════════ LIGHTBOX ══════════════════════════
  $('lcaMessages').addEventListener('click', (ev) => {
    const img = ev.target.closest('img[data-lca-zoom]');
    if (!img) return;
    const box = document.createElement('div');
    box.className = 'lc-lightbox';
    box.innerHTML = `<img src="${img.src}">`;
    box.addEventListener('click', () => box.remove());
    $('lcaLightboxRoot').appendChild(box);
  });

  // ══════════════════════════ REALTIME — WebSocket Admin ══════════════════════════
  let ws = null;
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?admin=1&token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      // FIX (Live Chat realtime): sama seperti App Desktop — setiap kali socket ini
      // (re)connect, langsung resync sidebar percakapan + panel chat yang lagi kebuka
      // supaya tidak ada pesan yang "nyangkut" kalau koneksi sempat putus diam-diam.
      loadConversations();
      if (activeDiscordId) silentRefreshActiveMessages();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg?.event) return;

      if (msg.event === 'livechat:message') {
        const m = msg.data;
        upsertConversationFromMessage(m);
        if (m.discordId === activeDiscordId) {
          $('lcaTypingIndicator').style.display = 'none';
          appendActiveMessage(m);
          if (m.sender === 'user') markRead(activeDiscordId);
        }
      } else if (msg.event === 'livechat:conversation') {
        upsertConversation(msg.data);
        if (msg.data.discordId === activeDiscordId) setUserStatus(msg.data.online);
      } else if (msg.event === 'livechat:typing') {
        if (msg.data?.from === 'user') showTypingIndicator(msg.data.discordId);
      } else if (msg.event === 'livechat:read') {
        if (msg.data?.discordId === activeDiscordId) renderMessages();
      } else if (msg.event === 'livechat:cleared') {
        conversations = [];
        activeMessages = [];
        activeDiscordId = null;
        renderConvoList();
        $('lcaChatActive').style.display = 'none';
        $('lcaChatEmptyState').style.display = 'flex';
        toast('Seluruh riwayat Live Chat direset otomatis (pergantian hari).', 'info');
      }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
    ws.onerror = () => ws.close();
  }

  function upsertConversationFromMessage(m) {
    // Kalau summary lengkap belum sempat nyampe lewat event 'livechat:conversation'
    // (race kecil), tetap update preview dasar dari pesan yang baru masuk supaya
    // sidebar tidak kelihatan basi.
    const idx = conversations.findIndex(c => c.discordId === m.discordId);
    if (idx >= 0) {
      conversations[idx] = {
        ...conversations[idx],
        lastMessage: m,
        lastActivity: m.createdAt,
        unreadCount: m.sender === 'user' && m.discordId !== activeDiscordId
          ? (conversations[idx].unreadCount || 0) + 1
          : conversations[idx].unreadCount
      };
      conversations.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
      renderConvoList();
    } else {
      loadConversations();
    }
  }

  // ══════════════════════════ INIT ══════════════════════════
  loadConversations();
  connectWs();
  // Fallback ringan (BUKAN mekanisme utama — lihat ws.onopen di atas untuk perbaikan
  // utamanya) kalau untuk alasan tak terduga WS terlihat "OPEN" tapi sebenarnya mati.
  setInterval(() => {
    loadConversations();
    if (activeDiscordId) loadActiveMessages();
  }, 30000);
})();
