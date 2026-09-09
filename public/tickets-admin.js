// ══════════════════════════════════════════════════════════════════════════
// TICKET SYSTEM — Frontend admin (halaman terpisah, modular). Reuse token
// login admin yang sama (localStorage 'adminToken') supaya tidak perlu login
// dua kali dari halaman admin.html utama.
// ══════════════════════════════════════════════════════════════════════════
(function () {
  const token = localStorage.getItem('adminToken');
  if (!token) { window.location.href = 'admin.html'; return; }

  const API = '/api/admin/ticket-system';
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

  function fmtDate(d) { return d ? new Date(d).toLocaleString('id-ID') : '-'; }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ── TAB NAVIGATION ──
  const tabs = document.querySelectorAll('#ticketNav .nav-item');
  const pages = document.querySelectorAll('.tab-page');
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pages.forEach(p => p.classList.add('hidden'));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    if (btn.dataset.tab === 'panels') loadPanels();
    if (btn.dataset.tab === 'config') loadConfig();
    if (btn.dataset.tab === 'webhooks') loadWebhooks();
    if (btn.dataset.tab === 'transcripts') loadTranscripts();
    if (btn.dataset.tab === 'logs') loadLogs();
    if (btn.dataset.tab === 'ratings') loadRatings();
  }));

  function closeModal(el) { el.classList.add('hidden'); }
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('.modal-overlay').classList.add('hidden')));

  // ══════════════════════════ KONFIRMASI CLOSE TICKET (Ya/Tidak) ══════════════════════════
  // Klik "Close Ticket" TIDAK LANGSUNG menutup Ticket — modal ini WAJIB muncul dulu.
  // "Tidak" (atau data-close/✕) membatalkan, Ticket tetap terbuka. "Ya" baru benar-benar
  // memanggil API close (lihat openTicketDetail() di bawah untuk yang memicu modal ini).
  let pendingCloseTicketId = null;
  const modalConfirmClose = document.getElementById('modalConfirmClose');
  function openConfirmClose(id) {
    pendingCloseTicketId = id;
    modalConfirmClose.classList.remove('hidden');
  }
  document.getElementById('btnConfirmCloseNo').addEventListener('click', () => {
    pendingCloseTicketId = null;
    modalConfirmClose.classList.add('hidden');
  });
  document.getElementById('btnConfirmCloseYes').addEventListener('click', async () => {
    const id = pendingCloseTicketId;
    pendingCloseTicketId = null;
    modalConfirmClose.classList.add('hidden');
    if (!id) return;
    try {
      // Close SAJA — channel Ticket TIDAK ikut dihapus di sini. Channel tetap
      // ada, hanya bisa diakses Staff/Admin untuk review (lihat Delete Channel
      // / Send Transcript / Reopen di footer detail Ticket status Closed).
      await api(`/tickets/${id}/close`, { method: 'POST' });
      toast('Ticket ditutup', 'success');
      document.getElementById('modalTicketDetail').classList.add('hidden');
      loadTickets();
    } catch (e) { toast(e.message, 'error'); }
  });

  // ── STATUS BOT ──
  api('/status').then(d => {
    const box = document.getElementById('botStatusBox');
    box.innerHTML = d.configured
      ? '🟢 Bot terkonfigurasi & siap.'
      : '🔴 DISCORD_BOT_TOKEN belum diset di server (.env).';
  }).catch(() => {});

  // ══════════════════════════ TICKET MANAGEMENT ══════════════════════════
  let allTickets = [];

  async function loadTickets() {
    const search = document.getElementById('fSearch').value.trim();
    const status = document.getElementById('fStatus').value;
    const category = document.getElementById('fCategory').value;
    const staff = document.getElementById('fStaff').value;
    const qs = new URLSearchParams({ search, status, category, staff }).toString();
    try {
      const { tickets } = await api(`/tickets?${qs}`);
      allTickets = tickets;
      renderTicketFilters(tickets);
      renderTicketTable(tickets);
    } catch (e) {
      document.getElementById('ticketTableBody').innerHTML = `<tr><td colspan="8" class="empty-row">Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderTicketFilters(tickets) {
    const catSel = document.getElementById('fCategory');
    const staffSel = document.getElementById('fStaff');
    const curCat = catSel.value, curStaff = staffSel.value;
    const cats = [...new Set(tickets.map(t => t.category).filter(Boolean))];
    catSel.innerHTML = '<option value="all">Semua Kategori</option>' + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    catSel.value = curCat || 'all';
    const staffIds = [...new Set(tickets.flatMap(t => t.staffIds || []))];
    staffSel.innerHTML = '<option value="all">Semua Staff</option>' + staffIds.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    staffSel.value = curStaff || 'all';
  }

  function statusBadge(status) {
    const map = { open: ['status-open', '🟢 Open'], closed: ['status-closed', '🔴 Closed'], deleted: ['status-deleted', '⚫ Deleted'] };
    const [cls, label] = map[status] || ['status-deleted', status];
    return `<span class="status-badge ${cls}">${label}</span>`;
  }

  function renderTicketTable(tickets) {
    const body = document.getElementById('ticketTableBody');
    if (!tickets.length) { body.innerHTML = '<tr><td colspan="8" class="empty-row">Belum ada ticket.</td></tr>'; return; }
    body.innerHTML = tickets.map(t => `
      <tr>
        <td>${t.ticketNumberLabel || '-'}</td>
        <td>#${escapeHtml(t.channelName)}</td>
        <td>${escapeHtml(t.openedBy?.username)}</td>
        <td>${escapeHtml(t.category)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${t.rating ? '⭐'.repeat(t.rating.stars) : '<span style="color:var(--text-faint)">-</span>'}</td>
        <td>${fmtDate(t.createdAt)}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost" data-detail="${t._id}">Detail</button>
          </div>
        </td>
      </tr>
    `).join('');
    body.querySelectorAll('[data-detail]').forEach(btn => btn.addEventListener('click', () => openTicketDetail(btn.dataset.detail)));
  }

  document.getElementById('btnRefreshTickets').addEventListener('click', loadTickets);
  ['fSearch', 'fStatus', 'fCategory', 'fStaff'].forEach(id => {
    document.getElementById(id).addEventListener('input', debounce(loadTickets, 300));
    document.getElementById(id).addEventListener('change', loadTickets);
  });
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  async function openTicketDetail(id) {
    const { ticket } = await api(`/tickets/${id}`);
    document.getElementById('tdTitle').textContent = `Ticket ${ticket.ticketNumberLabel}`;
    document.getElementById('tdSubtitle').textContent = `#${ticket.channelName}`;
    document.getElementById('tdBody').innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><label class="form-label">Dibuka Oleh</label><div class="val">${escapeHtml(ticket.openedBy?.username)}</div></div>
        <div class="detail-item"><label class="form-label">Kategori</label><div class="val">${escapeHtml(ticket.category)}</div></div>
        <div class="detail-item"><label class="form-label">Status</label><div class="val">${statusBadge(ticket.status)}</div></div>
        <div class="detail-item"><label class="form-label">Rating</label><div class="val">${ticket.rating ? '⭐'.repeat(ticket.rating.stars) : '-'}</div></div>
        <div class="detail-item"><label class="form-label">Dibuat</label><div class="val">${fmtDate(ticket.createdAt)}</div></div>
        <div class="detail-item"><label class="form-label">Ditutup</label><div class="val">${fmtDate(ticket.closedAt)}</div></div>
      </div>
      ${ticket.rating?.feedback ? `<div class="form-group"><label class="form-label">Feedback Rating</label><div class="val">${escapeHtml(ticket.rating.feedback)}</div></div>` : ''}
      <div class="form-group"><label class="form-label">Staff IDs (pisahkan koma)</label><input class="form-input" id="tdStaffInput" value="${(ticket.staffIds || []).join(', ')}"></div>
    `;
    const footer = document.getElementById('tdFooter');
    footer.innerHTML = '';
    const mkBtn = (label, cls, action) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.innerHTML = label; b.onclick = action; return b; };

    footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-save"></use></svg> Simpan Staff', 'btn-secondary', async () => {
      const ids = document.getElementById('tdStaffInput').value.split(',').map(s => s.trim()).filter(Boolean);
      try { await api(`/tickets/${id}/staff`, { method: 'PUT', body: JSON.stringify({ staffIds: ids }) }); toast('Staff diperbarui', 'success'); loadTickets(); } catch (e) { toast(e.message, 'error'); }
    }));
    if (ticket.status === 'open') {
      // Cuma buka modal konfirmasi Ya/Tidak di sini — proses close (dan efeknya:
      // cabut akses user, status -> Closed, DM Rating, dst.) baru jalan kalau
      // Staff klik "Ya" di modal (lihat openConfirmClose() di atas). Channel
      // Discord-nya TIDAK dihapus oleh aksi Close.
      footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-lock"></use></svg> Close Ticket', 'btn-danger', () => openConfirmClose(id)));
    } else if (ticket.status === 'closed') {
      // Ticket Closed: channel-nya masih ada (cuma user yang kehilangan akses),
      // jadi Staff/Admin dapat 3 aksi review berikut:
      footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-trash-2"></use></svg> Delete Channel', 'btn-danger', async () => {
        if (!confirm(`Hapus channel Ticket ${ticket.ticketNumberLabel} secara permanen dari Discord? Tindakan ini tidak bisa dibatalkan.`)) return;
        try { await api(`/tickets/${id}`, { method: 'DELETE' }); toast('Channel Ticket dihapus', 'success'); document.getElementById('modalTicketDetail').classList.add('hidden'); loadTickets(); } catch (e) { toast(e.message, 'error'); }
      }));
      footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-scroll-text"></use></svg> Send Transcript', 'btn-secondary', async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try { await api(`/tickets/${id}/send-transcript`, { method: 'POST' }); toast('Transcript dikirim ke channel', 'success'); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
      }));
      footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-lock-open"></use></svg> Reopen Ticket', 'btn-secondary', async () => {
        try { await api(`/tickets/${id}/reopen`, { method: 'POST' }); toast('Ticket dibuka kembali', 'success'); document.getElementById('modalTicketDetail').classList.add('hidden'); loadTickets(); } catch (e) { toast(e.message, 'error'); }
      }));
    } else if (ticket.status !== 'deleted') {
      footer.appendChild(mkBtn('<svg class="icon icon-16"><use href="#ic-trash-2"></use></svg> Delete', 'btn-danger', async () => {
        if (!confirm('Yakin hapus ticket ini? Channel Discord akan ikut dihapus.')) return;
        try { await api(`/tickets/${id}`, { method: 'DELETE' }); toast('Ticket dihapus', 'success'); document.getElementById('modalTicketDetail').classList.add('hidden'); loadTickets(); } catch (e) { toast(e.message, 'error'); }
      }));
    }
    document.getElementById('modalTicketDetail').classList.remove('hidden');
  }

  // ══════════════════════════ TICKET PANEL + EMBED EDITOR ══════════════════════════
  let currentPanelId = null;
  let fields = [];
  let channelsCache = { textChannels: [], categories: [] };

  async function loadPanels() {
    const { panels } = await api('/panels');
    const grid = document.getElementById('panelGrid');
    if (!panels.length) { grid.innerHTML = '<p style="color:var(--text-faint);">Belum ada panel. Klik "Buat Panel" untuk mulai.</p>'; return; }
    grid.innerHTML = panels.map(p => `
      <div class="panel-card">
        <div class="panel-card-head">
          <div><div class="panel-card-name">${escapeHtml(p.name)}</div><div class="panel-card-meta">#${escapeHtml(p.channelId ? p.channelId : 'channel belum diset')}</div></div>
          <span class="pub-badge ${p.published ? 'pub-yes' : 'pub-no'}">${p.published ? 'Published' : 'Draft'}</span>
        </div>
        <div class="panel-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${p._id}"><svg class="icon icon-16"><use href="#ic-pencil"></use></svg> Edit</button>
          <button class="btn btn-primary btn-sm" data-publish="${p._id}"><svg class="icon icon-16"><use href="#ic-rocket"></use></svg> Publish</button>
          <button class="btn btn-danger btn-sm" data-del="${p._id}"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>
        </div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openPanelModal(b.dataset.edit)));
    grid.querySelectorAll('[data-publish]').forEach(b => b.addEventListener('click', async () => {
      try { await api(`/panels/${b.dataset.publish}/publish`, { method: 'POST' }); toast('Panel dipublish ke Discord', 'success'); loadPanels(); } catch (e) { toast(e.message, 'error'); }
    }));
    grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Hapus panel ini?')) return;
      try { await api(`/panels/${b.dataset.del}`, { method: 'DELETE' }); toast('Panel dihapus', 'success'); loadPanels(); } catch (e) { toast(e.message, 'error'); }
    }));
  }

  async function ensureChannelsLoaded(guildId) {
    if (!guildId) return;
    try {
      const data = await api(`/discord/guilds/${guildId}/channels`);
      channelsCache = data;
      fillChannelSelects();
    } catch (e) { toast('Gagal memuat channel: ' + e.message, 'error'); }
  }
  function fillChannelSelects() {
    const chSel = document.getElementById('pChannel');
    const catSel = document.getElementById('pCategory');
    const curCh = chSel.value, curCat = catSel.value;
    chSel.innerHTML = '<option value="">— pilih channel —</option>' + channelsCache.textChannels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
    catSel.innerHTML = '<option value="">— pakai default —</option>' + channelsCache.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (curCh) chSel.value = curCh;
    if (curCat) catSel.value = curCat;
  }

  function resetPanelForm() {
    currentPanelId = null;
    fields = [];
    document.getElementById('panelModalTitle').textContent = 'Buat Panel Ticket';
    ['pName', 'pWelcome', 'eAuthorName', 'eAuthorIcon', 'eTitle', 'eDesc', 'eThumb', 'eImage', 'eFooterText', 'eFooterIcon'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('pWelcome').value = 'Halo {user}, terima kasih sudah membuka ticket. Tim kami akan segera membantu.';
    document.getElementById('pBtnLabel').value = 'Buka Ticket';
    document.getElementById('pBtnEmoji').value = '🎫';
    document.getElementById('pBtnStyle').value = 'PRIMARY';
    document.getElementById('eTitle').value = 'Butuh Bantuan?';
    document.getElementById('eDesc').value = 'Klik tombol di bawah untuk membuka ticket baru.';
    document.getElementById('eColor').value = '#5865f2';
    renderFieldEditor();
    renderPreview();
  }

  async function openPanelModal(id) {
    resetPanelForm();
    const cfg = await api('/config').then(d => d.config).catch(() => null);
    if (cfg?.guildId) await ensureChannelsLoaded(cfg.guildId);
    if (id) {
      const { panel } = await api(`/panels/${id}`);
      currentPanelId = id;
      document.getElementById('panelModalTitle').textContent = 'Edit Panel Ticket';
      document.getElementById('pName').value = panel.name || '';
      document.getElementById('pChannel').value = panel.channelId || '';
      document.getElementById('pCategory').value = panel.categoryId || '';
      document.getElementById('pWelcome').value = panel.welcomeMessage || '';
      document.getElementById('pBtnLabel').value = panel.buttonLabel || 'Buka Ticket';
      document.getElementById('pBtnEmoji').value = panel.buttonEmoji || '🎫';
      document.getElementById('pBtnStyle').value = panel.buttonStyle || 'PRIMARY';
      const e = panel.embed || {};
      document.getElementById('eAuthorName').value = e.author?.name || '';
      document.getElementById('eAuthorIcon').value = e.author?.iconUrl || '';
      document.getElementById('eTitle').value = e.title || '';
      document.getElementById('eDesc').value = e.description || '';
      document.getElementById('eColor').value = e.color || '#5865f2';
      document.getElementById('eThumb').value = e.thumbnailUrl || '';
      document.getElementById('eImage').value = e.imageUrl || '';
      document.getElementById('eFooterText').value = e.footer?.text || '';
      document.getElementById('eFooterIcon').value = e.footer?.iconUrl || '';
      fields = (e.fields || []).map(f => ({ ...f }));
      renderFieldEditor();
      renderPreview();
    }
    document.getElementById('modalPanel').classList.remove('hidden');
  }
  document.getElementById('btnNewPanel').addEventListener('click', () => openPanelModal(null));

  function renderFieldEditor() {
    const list = document.getElementById('fieldEditorList');
    list.innerHTML = fields.map((f, i) => `
      <div class="field-row" data-i="${i}">
        <input class="form-input" placeholder="Nama field" data-fkey="name" value="${escapeHtml(f.name || '')}">
        <input class="form-input" placeholder="Isi" data-fkey="value" value="${escapeHtml(f.value || '')}">
        <label class="field-inline" style="font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:4px;">
          <input type="checkbox" data-fkey="inline" ${f.inline ? 'checked' : ''}> Inline
        </label>
        <button class="btn btn-danger btn-icon field-remove" data-remove="${i}">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-i]').forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelectorAll('[data-fkey]').forEach(input => {
        const evt = input.type === 'checkbox' ? 'change' : 'input';
        input.addEventListener(evt, () => {
          const key = input.dataset.fkey;
          fields[i][key] = input.type === 'checkbox' ? input.checked : input.value;
          renderPreview();
        });
      });
    });
    list.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
      fields.splice(Number(btn.dataset.remove), 1);
      renderFieldEditor(); renderPreview();
    }));
  }
  document.getElementById('btnAddField').addEventListener('click', () => {
    fields.push({ name: '', value: '', inline: true });
    renderFieldEditor(); renderPreview();
  });

  function collectPanelData() {
    return {
      name: document.getElementById('pName').value || 'Panel Baru',
      channelId: document.getElementById('pChannel').value,
      categoryId: document.getElementById('pCategory').value,
      welcomeMessage: document.getElementById('pWelcome').value,
      buttonLabel: document.getElementById('pBtnLabel').value,
      buttonEmoji: document.getElementById('pBtnEmoji').value,
      buttonStyle: document.getElementById('pBtnStyle').value,
      embed: {
        author: { name: document.getElementById('eAuthorName').value, iconUrl: document.getElementById('eAuthorIcon').value },
        title: document.getElementById('eTitle').value,
        description: document.getElementById('eDesc').value,
        color: document.getElementById('eColor').value,
        thumbnailUrl: document.getElementById('eThumb').value,
        imageUrl: document.getElementById('eImage').value,
        footer: { text: document.getElementById('eFooterText').value, iconUrl: document.getElementById('eFooterIcon').value },
        fields
      }
    };
  }

  function renderPreview() {
    const d = collectPanelData();
    const e = d.embed;
    const mock = document.getElementById('mockEmbed');
    mock.style.borderLeftColor = e.color || '#5865f2';
    mock.innerHTML = `
      ${e.thumbnailUrl ? `<img class="m-thumb" src="${escapeHtml(e.thumbnailUrl)}" onerror="this.style.display='none'">` : ''}
      ${e.author?.name ? `<div class="m-author">${e.author.iconUrl ? `<img src="${escapeHtml(e.author.iconUrl)}" onerror="this.style.display='none'">` : ''}${escapeHtml(e.author.name)}</div>` : ''}
      ${e.title ? `<div class="m-title">${escapeHtml(e.title)}</div>` : ''}
      ${e.description ? `<div class="m-desc">${escapeHtml(e.description)}</div>` : ''}
      ${e.imageUrl ? `<img class="m-image" src="${escapeHtml(e.imageUrl)}" onerror="this.style.display='none'">` : ''}
      ${fields.length ? `<div class="m-fields">${fields.filter(f => f.name).map(f => `<div class="m-field ${f.inline ? 'inline' : 'block'}"><b>${escapeHtml(f.name)}</b><span>${escapeHtml(f.value)}</span></div>`).join('')}</div>` : ''}
      ${e.footer?.text ? `<div class="m-footer">${e.footer.iconUrl ? `<img src="${escapeHtml(e.footer.iconUrl)}" onerror="this.style.display='none'">` : ''}${escapeHtml(e.footer.text)}</div>` : ''}
    `;
    document.getElementById('mockButton').innerHTML = `${escapeHtml(d.buttonEmoji || '')} ${escapeHtml(d.buttonLabel || 'Buka Ticket')}`;
  }
  ['pBtnLabel', 'pBtnEmoji', 'eAuthorName', 'eAuthorIcon', 'eTitle', 'eDesc', 'eColor', 'eThumb', 'eImage', 'eFooterText', 'eFooterIcon'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderPreview);
  });

  document.getElementById('btnSavePanel').addEventListener('click', async () => {
    const data = collectPanelData();
    try {
      if (currentPanelId) { await api(`/panels/${currentPanelId}`, { method: 'PUT', body: JSON.stringify(data) }); }
      else { const { panel } = await api('/panels', { method: 'POST', body: JSON.stringify(data) }); currentPanelId = panel._id; }
      toast('Panel disimpan', 'success');
      loadPanels();
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('btnPublishPanel').addEventListener('click', async () => {
    const data = collectPanelData();
    if (!data.channelId) { toast('Pilih channel tujuan dulu', 'error'); return; }
    try {
      if (currentPanelId) await api(`/panels/${currentPanelId}`, { method: 'PUT', body: JSON.stringify(data) });
      else { const { panel } = await api('/panels', { method: 'POST', body: JSON.stringify(data) }); currentPanelId = panel._id; }
      await api(`/panels/${currentPanelId}/publish`, { method: 'POST' });
      toast('Panel berhasil dipublish ke Discord!', 'success');
      document.getElementById('modalPanel').classList.add('hidden');
      loadPanels();
    } catch (e) { toast(e.message, 'error'); }
  });

  // ══════════════════════════ BOT CONFIG ══════════════════════════
  async function loadConfig() {
    const [{ guilds }, { config }] = await Promise.all([
      api('/discord/guilds').catch(() => ({ guilds: [] })),
      api('/config')
    ]);
    const guildSel = document.getElementById('cfgGuild');
    guildSel.innerHTML = guilds.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('') || '<option value="">Gagal memuat server</option>';
    if (config.guildId) guildSel.value = config.guildId;
    document.getElementById('cfgSupportRole').value = config.supportRoleId || '';
    document.getElementById('cfgNameFormat').value = config.ticketNameFormat || 'ticket-{username}-{number}';
    if (guildSel.value) await ensureConfigChannels(guildSel.value, config.defaultCategoryId);
  }
  async function ensureConfigChannels(guildId, selectedCategoryId) {
    try {
      const { categories } = await api(`/discord/guilds/${guildId}/channels`);
      const catSel = document.getElementById('cfgCategory');
      catSel.innerHTML = '<option value="">— tanpa category —</option>' + categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
      if (selectedCategoryId) catSel.value = selectedCategoryId;
    } catch (e) { toast('Gagal memuat category: ' + e.message, 'error'); }
  }
  document.getElementById('cfgGuild').addEventListener('change', (e) => ensureConfigChannels(e.target.value));
  document.getElementById('btnSaveConfig').addEventListener('click', async () => {
    const patch = {
      guildId: document.getElementById('cfgGuild').value,
      defaultCategoryId: document.getElementById('cfgCategory').value,
      supportRoleId: document.getElementById('cfgSupportRole').value,
      ticketNameFormat: document.getElementById('cfgNameFormat').value
    };
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify(patch) });
      document.getElementById('cfgHint').textContent = '✅ Konfigurasi tersimpan.';
      toast('Konfigurasi disimpan', 'success');
    } catch (e) { document.getElementById('cfgHint').textContent = '❌ ' + e.message; }
  });

  // ══════════════════════════ NOTIFICATION CHANNEL SETTINGS ══════════════════════════
  // Dropdown-nya berisi text channel dari server Discord yang sama dengan
  // Bot Channel Configuration (config.guildId) — bukan lagi daftar webhook.
  function channelOptionsHtml(textChannels, selectedId) {
    const opts = textChannels.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
    return `<option value="">— tidak dipakai —</option>${opts}`;
  }

  async function loadNotificationChannels() {
    try {
      const { config } = await api('/config');
      if (!config.guildId) {
        document.getElementById('notifHint').textContent = '⚠️ Atur Discord Server di halaman Bot Channel Configuration dulu.';
        ['cfgLogsChannel', 'cfgTranscriptChannel', 'cfgRatingChannel'].forEach(id => {
          document.getElementById(id).innerHTML = '<option value="">— pilih server dulu —</option>';
        });
        return;
      }
      const { textChannels } = await api(`/discord/guilds/${config.guildId}/channels`);
      document.getElementById('cfgLogsChannel').innerHTML = channelOptionsHtml(textChannels, config.logsChannelId || '');
      document.getElementById('cfgTranscriptChannel').innerHTML = channelOptionsHtml(textChannels, config.transcriptChannelId || '');
      document.getElementById('cfgRatingChannel').innerHTML = channelOptionsHtml(textChannels, config.ratingChannelId || '');
      document.getElementById('notifHint').textContent = '';
    } catch (e) {
      document.getElementById('notifHint').textContent = '❌ Gagal memuat pengaturan notifikasi: ' + e.message;
    }
  }

  document.getElementById('btnSaveNotif').addEventListener('click', async () => {
    const patch = {
      logsChannelId: document.getElementById('cfgLogsChannel').value,
      transcriptChannelId: document.getElementById('cfgTranscriptChannel').value,
      ratingChannelId: document.getElementById('cfgRatingChannel').value
    };
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify(patch) });
      document.getElementById('notifHint').textContent = '✅ Pengaturan notifikasi tersimpan.';
      toast('Pengaturan notifikasi disimpan', 'success');
    } catch (e) { document.getElementById('notifHint').textContent = '❌ ' + e.message; }
  });

  // Dipakai sebagai alias supaya kode lain (tab-switch, WS realtime) yang
  // masih memanggil loadWebhooks() tetap berjalan tanpa perlu diubah semua.
  function loadWebhooks() { return loadNotificationChannels(); }

  // ══════════════════════════ TRANSCRIPTS ══════════════════════════
  async function loadTranscripts() {
    const { tickets } = await api('/tickets?status=all');
    const withTranscript = tickets.filter(t => t.transcriptHtml);
    const body = document.getElementById('transcriptTableBody');
    if (!withTranscript.length) { body.innerHTML = '<tr><td colspan="5" class="empty-row">Belum ada transcript.</td></tr>'; return; }
    body.innerHTML = withTranscript.map(t => `
      <tr>
        <td>${t.ticketNumberLabel}</td>
        <td>#${escapeHtml(t.channelName)}</td>
        <td>${escapeHtml(t.openedBy?.username)}</td>
        <td>${fmtDate(t.closedAt)}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost" data-view="${t._id}"><svg class="icon icon-16"><use href="#ic-eye"></use></svg> Lihat</button>
            <button class="btn btn-secondary" data-dl="${t._id}"><svg class="icon icon-16"><use href="#ic-arrow-down-to-line"></use></svg> Download</button>
          </div>
        </td>
      </tr>
    `).join('');
    body.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => window.open(`${API}/tickets/${b.dataset.view}/transcript?token=${encodeURIComponent(token)}`, '_blank')));
    body.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = `${API}/tickets/${b.dataset.dl}/transcript?download=1&token=${encodeURIComponent(token)}`;
      a.click();
    }));
  }

  // ══════════════════════════ LOGS ══════════════════════════
  async function loadLogs() {
    const { logs } = await api('/logs');
    const body = document.getElementById('logsTableBody');
    if (!logs.length) { body.innerHTML = '<tr><td colspan="4" class="empty-row">Belum ada log.</td></tr>'; return; }
    body.innerHTML = logs.map(l => `
      <tr>
        <td>${fmtDate(l.createdAt)}</td>
        <td>${escapeHtml(l.type)}</td>
        <td>${escapeHtml(l.actorName)}</td>
        <td>${escapeHtml(l.description)}</td>
      </tr>
    `).join('');
  }

  // ══════════════════════════ RATINGS ══════════════════════════
  async function loadRatings() {
    const { tickets, average, total } = await api('/ratings');
    document.getElementById('ratingAvg').textContent = average || '0';
    document.getElementById('ratingStars').innerHTML = `<span class="star-line">${'⭐'.repeat(Math.round(average))}</span>`;
    document.getElementById('ratingTotal').textContent = `${total} rating`;
    const body = document.getElementById('ratingsTableBody');
    if (!tickets.length) { body.innerHTML = '<tr><td colspan="5" class="empty-row">Belum ada rating.</td></tr>'; return; }
    body.innerHTML = tickets.map(t => `
      <tr>
        <td>#${escapeHtml(t.channelName)}</td>
        <td>${escapeHtml(t.rating.by)}</td>
        <td><span class="star-line">${'⭐'.repeat(t.rating.stars)}</span></td>
        <td>${t.rating.feedback ? escapeHtml(t.rating.feedback) : '<span style="color:var(--text-faint)">-</span>'}</td>
        <td>${fmtDate(t.rating.ratedAt)}</td>
      </tr>
    `).join('');
  }

  // ══════════════════════════ REALTIME (reuse admin WS hub) ══════════════════════════
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?admin=1&token=${encodeURIComponent(token)}`);
    ws.onmessage = (msg) => {
      try {
        const { event } = JSON.parse(msg.data);
        if (['ticket:new', 'ticket:update', 'ticket:deleted'].includes(event)) {
          if (!document.getElementById('tab-tickets').classList.contains('hidden')) loadTickets();
        }
        if (event === 'ticket:panel' || event === 'ticket:panel_deleted') {
          if (!document.getElementById('tab-panels').classList.contains('hidden')) loadPanels();
        }
        if (event === 'ticket:log') {
          if (!document.getElementById('tab-logs').classList.contains('hidden')) loadLogs();
        }
        if (event === 'ticket:config') {
          if (!document.getElementById('tab-webhooks').classList.contains('hidden')) loadNotificationChannels();
          if (!document.getElementById('tab-config').classList.contains('hidden')) loadConfig();
        }
      } catch (e) {}
    };
    ws.onclose = () => setTimeout(connectWs, 4000);
  }
  connectWs();

  // ── INIT ──
  loadTickets();
})();
