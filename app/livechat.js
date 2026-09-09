// ══════════════════════════════════════════════════════════════════════════
// LIVE CHAT SUPPORT — Floating Chat Widget (App Desktop)
// Modul BARU & TERPISAH dari app.js — sengaja dipisah file supaya tidak
// mengganggu logic app.js yang sudah ada. Reuse global yang SUDAH ADA di
// app.js (dimuat SEBELUM file ini di index.html, jadi tetap satu script
// scope yang sama): SERVER_URL, api(), currentUser, escapeHtml().
//
// Hook realtime: app.js meneruskan event WebSocket berawalan 'livechat:' ke
// window.LiveChatWidget.handleWsEvent(msg) lewat switch _ws.onmessage yang
// SUDAH ADA (lihat perubahan kecil di app.js) — TIDAK bikin koneksi
// WebSocket baru sama sekali, semua lewat _ws yang sama dengan fitur lain.
// ══════════════════════════════════════════════════════════════════════════

(function () {
  const EMOJI_LIST = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😎','😢','😭','😡','👍','👎','👏','🙏','🔥','🎉','❤️','💯','✅','❌','⚠️','🎮','💬','😴','🥳'];

  let widgetOpen = false;
  let widgetInited = false;
  let loadedOnce = false;
  let messages = [];
  let pendingImage = null; // { dataUrl, file }
  let unreadCount = 0;
  let adminOnline = false;
  let typingHideTimer = null;
  let sendTypingTimer = null;
  let lastTypingSentAt = 0;

  function $(id) { return document.getElementById(id); }

  function fmtTime(d) {
    try { return new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  // ══════════════════════════ FLOATING HINT ("butuh bantuan? chat admin") ══════════════════════════
  // FIX (perbaikan #2 — floating text harus LOOP TERUS, bukan berhenti
  // setelah beberapa kali): akar masalah versi lama ada di `hintStopped`
  // yang di-set true permanen begitu user membuka chat, jadi loop mati
  // selamanya untuk sesi itu. Sekarang diganti jadi PAUSE/RESUME murni lewat
  // `hintPaused` (bukan "stop") — dicek di setiap tick lewat
  // updateHintPauseState(), jadi begitu Chat Window ditutup (atau drag icon
  // selesai) siklus SHOW 5s / HIDE 5s otomatis lanjut lagi dari titik semula,
  // tanpa batas, sesuai poin #6 & #9 permintaan. Satu timer tunggal
  // (`hintTimer`) dipakai bergantian utk fase show & hide, selalu di-clear
  // sebelum dijadwalkan ulang — jadi TIDAK ada multiple timer/instance
  // menumpuk walau startHintLoop()/pollSessionState() terpanggil berkali-kali.
  let hintTimer = null;
  let hintPhase = 'hidden'; // 'show' | 'hidden' — fase siklus saat ini
  let hintPaused = false;   // true selagi Chat Window terbuka ATAU icon sedang di-drag
  const HINT_SHOW_MS = 5000;
  const HINT_HIDE_MS = 5000;
  const HINT_PAUSE_RECHECK_MS = 600; // seberapa sering dicek ulang selagi paused

  function scheduleHintTick(delay) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hintTick, delay);
  }

  function hintTick() {
    if (hintPaused) {
      // Jangan hentikan loop — cuma tunda sebentar, coba lagi nanti.
      scheduleHintTick(HINT_PAUSE_RECHECK_MS);
      return;
    }
    if (hintPhase === 'hidden') {
      showFloatingHint();
      hintPhase = 'show';
      scheduleHintTick(HINT_SHOW_MS);
    } else {
      hideFloatingHintNow();
      hintPhase = 'hidden';
      scheduleHintTick(HINT_HIDE_MS);
    }
  }

  // Dipanggil sekali saat FAB pertama kali tampil (login). Aman dipanggil
  // berkali-kali (selalu clear timer lama dulu) — TIDAK menciptakan timer
  // dobel walau terpanggil berulang, sesuai poin #8 permintaan.
  function startHintLoop() {
    hintPhase = 'hidden';
    hintPaused = false;
    scheduleHintTick(400);
  }

  // Dipanggil saat logout — matikan total timer (bukan cuma pause) karena
  // sesi sudah selesai; startHintLoop() akan dipanggil ulang dari awal kalau
  // ada user lain login di App yang sama.
  function stopHintLoop() {
    clearTimeout(hintTimer);
    hintTimer = null;
    hintPhase = 'hidden';
    hideFloatingHintNow();
  }

  function showFloatingHint() {
    const el = $('lcHint');
    if (!el) return;
    positionHintBubble();
    el.classList.remove('hide');
    // requestAnimationFrame supaya transisi masuk (opacity/transform) selalu
    // ke-trigger dengan mulus walau elemen baru saja diubah dari display awal.
    requestAnimationFrame(() => el.classList.add('show'));
  }

  function hideFloatingHintNow() {
    const el = $('lcHint');
    if (!el) return;
    el.classList.remove('show');
    el.classList.add('hide');
  }

  // Satu-satunya tempat yang menentukan pause/resume — dipanggil tiap kali
  // widgetOpen atau status drag icon berubah (lihat openWidget/closeWidget
  // dan onFabPointerMove/onFabPointerUp). Sengaja idempotent supaya aman
  // dipanggil dari banyak tempat tanpa efek samping.
  function updateHintPauseState() {
    const shouldPause = widgetOpen || (dragState && dragState.dragging);
    if (shouldPause && !hintPaused) {
      hintPaused = true;
      hideFloatingHintNow();
    } else if (!shouldPause && hintPaused) {
      hintPaused = false; // siklus lanjut normal di tick berikutnya (poin #9)
    }
  }

  // ══════════════════════════ FAB + WIDGET TOGGLE ══════════════════════════
  function setBadge(n) {
    unreadCount = n;
    const el = $('lcFabBadge');
    if (!el) return;
    if (n > 0) { el.style.display = 'flex'; el.textContent = n > 99 ? '99+' : String(n); }
    else el.style.display = 'none';
  }

  function openWidget() {
    widgetOpen = true;
    updateHintPauseState(); // pause hint selama chat terbuka (poin #9) — bukan stop permanen
    $('lcWidget').style.display = 'flex';
    positionWidget(); // taruh panel relatif ke posisi icon saat ini (poin #13/#14, konsisten dgn hint)
    $('lcFabBtn').classList.add('lc-open');
    hideNotifPopup();
    if (!loadedOnce) loadMessages();
    else resyncMessages(); // resync ringan tiap dibuka — jaga-jaga ada yang kelewat
    markRead();
    scrollToBottom(false);
    setTimeout(() => $('lcInputText')?.focus(), 120);
  }

  function closeWidget() {
    widgetOpen = false;
    $('lcWidget').style.display = 'none';
    $('lcFabBtn').classList.remove('lc-open');
    updateHintPauseState(); // Chat Window ditutup -> hint kembali mengikuti siklus normal (poin #9)
  }

  function toggleWidget() {
    if (widgetOpen) closeWidget(); else openWidget();
  }

  // ══════════════════════════ LOAD & RENDER ══════════════════════════
  function renderSkeleton() {
    const body = $('lcMessages');
    body.innerHTML = `<div class="lc-skeleton-row">
      <div class="lc-skeleton" style="width:60%;align-self:flex-start;"></div>
      <div class="lc-skeleton" style="width:45%;align-self:flex-end;"></div>
      <div class="lc-skeleton" style="width:70%;align-self:flex-start;"></div>
    </div>`;
  }

  let _syncing = false;

  async function loadMessages() {
    renderSkeleton();
    try {
      const data = await api('/api/livechat/messages');
      messages = data.messages || [];
      adminOnline = !!data.adminOnline;
      loadedOnce = true;
      renderAll();
      setHeaderStatus(adminOnline);
    } catch (e) {
      $('lcMessages').innerHTML = `<div class="lc-empty"><div class="lc-empty-sub">Gagal memuat chat. Coba lagi nanti.</div></div>`;
    }
  }

  // FIX (Live Chat realtime, akar masalah utama): dipanggil setiap kali socket
  // WS (re)connect (lihat hook di app.js `_ws.onopen`). Bandingkan riwayat lokal
  // vs riwayat server — kalau ada balasan Admin yang MASUK selama socket sempat
  // putus (mis. laptop sleep / jaringan pindah / server restart) tapi belum
  // sempat ter-render, langsung ditampilkan sekarang juga TANPA perlu user
  // menutup-buka App. Aman dipanggil berkali-kali (ada guard `_syncing`) dan
  // idempotent (dedup by _id) — tidak akan menimbulkan pesan dobel.
  async function resyncMessages({ silent } = {}) {
    if (!currentUser || _syncing) return;
    _syncing = true;
    try {
      const data = await api('/api/livechat/messages');
      const fresh = data.messages || [];
      adminOnline = !!data.adminOnline;
      setHeaderStatus(adminOnline);

      if (loadedOnce) {
        const knownIds = new Set(messages.map(m => String(m._id)));
        const missedAdminMsgs = fresh.filter(m => m.sender === 'admin' && !knownIds.has(String(m._id)) && !m.readByUser);
        messages = fresh;
        if (widgetOpen) {
          renderAll();
          markRead();
        } else if (missedAdminMsgs.length) {
          setBadge(unreadCount + missedAdminMsgs.length);
          showNotifPopup(missedAdminMsgs[missedAdminMsgs.length - 1]);
        }
      } else {
        messages = fresh;
        loadedOnce = true;
        if (widgetOpen) renderAll();
      }
    } catch (e) {
      // Diam-diam — akan dicoba lagi di reconnect/poll berikutnya, jangan
      // ganggu UI kalau memang cuma sesaat lagi offline.
    } finally {
      _syncing = false;
    }
  }

  function renderAll() {
    const empty = $('lcEmpty');
    const list = $('lcMessages');
    if (!messages.length) {
      empty.style.display = 'flex';
      empty.style.flexDirection = 'column';
      empty.style.alignItems = 'center';
      list.innerHTML = '';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = messages.map(renderMessageRow).join('');
    scrollToBottom(false);
  }

  function renderMessageRow(m) {
    const mine = m.sender === 'user';
    const imgHtml = m.imageData ? `<img src="${m.imageData}" data-lc-zoom loading="lazy" />` : '';
    const textHtml = m.text ? `<div>${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>` : '';
    const readTick = mine
      ? `<svg class="icon ${m.readByAdmin ? 'lc-read' : ''}"><use href="#ic-check-check"></use></svg>`
      : '';
    return `
      <div class="lc-msg-row ${mine ? 'lc-from-user' : 'lc-from-admin'}" data-id="${m._id}">
        <div class="lc-bubble">${textHtml}${imgHtml}</div>
        <div class="lc-msg-meta">${escapeHtml(fmtTime(m.createdAt))}${readTick}</div>
      </div>`;
  }

  function appendMessage(m) {
    // Guard yang sama seperti sisi Admin — cegah dobel kalau suatu saat ada event WS
    // yang echo balik ke pengirimnya sendiri.
    if (messages.some(x => String(x._id) === String(m._id))) return;
    messages.push(m);
    const empty = $('lcEmpty');
    if (empty) empty.style.display = 'none';
    const list = $('lcMessages');
    list.insertAdjacentHTML('beforeend', renderMessageRow(m));
    scrollToBottom(true);
  }

  function scrollToBottom(smooth) {
    const body = $('lcBody');
    if (!body) return;
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  // ══════════════════════════ SEND ══════════════════════════
  async function sendMessage() {
    const textEl = $('lcInputText');
    const text = (textEl.value || '').trim();
    if (!text && !pendingImage) return;

    const btn = $('lcSendBtn');
    btn.disabled = true;
    try {
      const body = { text };
      if (pendingImage) body.imageData = pendingImage.dataUrl;
      const res = await api('/api/livechat/send', { method: 'POST', body: JSON.stringify(body) });
      appendMessage(res.message);
      textEl.value = '';
      autoGrowTextarea(textEl);
      clearPendingImage();
    } catch (e) {
      showAppNotifToastSafe('Gagal Mengirim', e.message || 'Pesan gagal terkirim, coba lagi.');
    } finally {
      btn.disabled = false;
    }
  }

  function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 90) + 'px';
  }

  // ══════════════════════════ TYPING INDICATOR ══════════════════════════
  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSentAt < 1500) return; // throttle, jangan spam request tiap keystroke
    lastTypingSentAt = now;
    api('/api/livechat/typing', { method: 'POST', body: JSON.stringify({ typing: true }) }).catch(() => {});
  }

  function showTypingIndicator() {
    $('lcTypingIndicator').style.display = 'flex';
    scrollToBottom(true);
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => { $('lcTypingIndicator').style.display = 'none'; }, 3500);
  }

  // ══════════════════════════ READ STATUS ══════════════════════════
  async function markRead() {
    try {
      await api('/api/livechat/read', { method: 'POST' });
      setBadge(0);
    } catch (e) {}
  }

  // ══════════════════════════ ADMIN ONLINE STATUS ══════════════════════════
  function setHeaderStatus(online) {
    adminOnline = online;
    const el = $('lcHeaderStatus');
    if (el) {
      el.innerHTML = online
        ? `<span class="lc-dot lc-dot-online"></span> Online`
        : `<span class="lc-dot lc-dot-offline"></span> Offline`;
    }
    // Titik status kecil langsung di icon FAB — tambahan desain supaya icon
    // lebih jelas fungsinya (live chat + status admin) tanpa perlu buka panel.
    const dot = $('lcFabStatus');
    if (dot) dot.classList.toggle('online', !!online);
  }

  // ══════════════════════════ IMAGE UPLOAD ══════════════════════════
  function handleImageFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showAppNotifToastSafe('Gambar Terlalu Besar', 'Ukuran gambar maksimal 5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = { dataUrl: reader.result, file };
      $('lcImagePreviewImg').src = reader.result;
      $('lcImagePreview').style.display = 'block';
    };
    reader.readAsDataURL(file);
  }

  function clearPendingImage() {
    pendingImage = null;
    $('lcImagePreview').style.display = 'none';
    $('lcImagePreviewImg').src = '';
    $('lcImageInput').value = '';
  }

  // ══════════════════════════ EMOJI PICKER ══════════════════════════
  function buildEmojiPicker() {
    const el = $('lcEmojiPicker');
    el.innerHTML = EMOJI_LIST.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-emoji]');
      if (!btn) return;
      const textEl = $('lcInputText');
      textEl.value += btn.dataset.emoji;
      autoGrowTextarea(textEl);
      textEl.focus();
    });
  }

  function toggleEmojiPicker() {
    const el = $('lcEmojiPicker');
    const btn = $('lcEmojiBtn');
    const show = el.style.display === 'none';
    el.style.display = show ? 'grid' : 'none';
    btn.classList.toggle('active', show);
  }

  // ══════════════════════════ LIGHTBOX (perbesar gambar) ══════════════════════════
  function openLightbox(src) {
    const box = document.createElement('div');
    box.className = 'lc-lightbox';
    box.innerHTML = `<img src="${src}">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  // ══════════════════════════ NOTIFICATION POPUP (widget tertutup) ══════════════════════════
  function showNotifPopup(m) {
    const el = $('lcNotifPopup');
    const preview = m.text ? escapeHtml(m.text).slice(0, 90) : '📷 Mengirim gambar';
    el.innerHTML = `
      <div class="lc-notif-popup-icon">31</div>
      <div>
        <div class="lc-notif-popup-title">💬 31 Store Support</div>
        <div class="lc-notif-popup-msg">${preview}</div>
        <div class="lc-notif-popup-cta">Lihat Chat →</div>
      </div>`;
    el.classList.add('show');
    positionNotifPopup(); // tampilkan relatif ke posisi icon saat ini (poin #13)
    el.onclick = () => openWidget();
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(hideNotifPopup, 6000);
  }
  function hideNotifPopup() {
    const el = $('lcNotifPopup');
    if (el) el.classList.remove('show');
  }

  function showAppNotifToastSafe(title, msg) {
    // Reuse toast kecil app.js kalau ada, fallback diam-diam kalau tidak.
    if (typeof showAppNotifToast === 'function') {
      showAppNotifToast({ type: 'other', title, message: msg });
    }
  }

  // ══════════════════════════ REALTIME (dipanggil dari app.js) ══════════════════════════
  function handleWsEvent(msg) {
    if (!msg || !msg.event) return;
    if (msg.event === 'livechat:message') {
      const m = msg.data;
      if (!currentUser || m.discordId !== currentUser.discordId) return;
      if (m.sender === 'admin') {
        $('lcTypingIndicator').style.display = 'none';
        if (widgetOpen) {
          appendMessage(m);
          markRead();
        } else {
          messages.push(m);
          loadedOnce = true;
          setBadge(unreadCount + 1);
          showNotifPopup(m);
        }
      } else if (m.sender === 'user') {
        // Sinkron dari device lain milik user yang sama (multi-device) — hindari duplikat.
        if (!messages.some(x => String(x._id) === String(m._id))) {
          messages.push(m);
          if (widgetOpen) appendMessage2(m);
        }
      }
    } else if (msg.event === 'livechat:typing') {
      if (msg.data?.from === 'admin' && widgetOpen) showTypingIndicator();
    } else if (msg.event === 'livechat:adminStatus') {
      setHeaderStatus(!!msg.data?.online);
    } else if (msg.event === 'livechat:cleared') {
      // Auto delete tengah malam / TTL — reset tampilan chat, mulai percakapan baru.
      messages = [];
      unreadCount = 0;
      setBadge(0);
      if (widgetOpen) renderAll();
    }
  }
  // helper kecil supaya pesan dari device lain (bukan hasil kirim sendiri di
  // widget ini) tetap ter-render kalau widget sedang kebuka.
  function appendMessage2(m) {
    if (messages.some(x => String(x._id) === String(m._id))) return;
    const empty = $('lcEmpty');
    if (empty) empty.style.display = 'none';
    $('lcMessages').insertAdjacentHTML('beforeend', renderMessageRow(m));
    scrollToBottom(true);
  }

  // ══════════════════════════ FAB POSITIONING — DRAG & SAFE AREA ══════════════════════════
  // Modul BARU (perbaikan #1) — icon Live Chat sekarang bisa di-drag bebas
  // oleh user, posisinya tersimpan, dan sistem otomatis menjauh dari floating
  // Download/Install button existing (#detailActionBar, dipakai bareng oleh
  // Game Detail & Bypass Detail — lihat renderDetailActions() di app.js)
  // TANPA hardcode per-halaman, sesuai poin #1/#2/#5 permintaan. Tidak
  // menyentuh app.js/router sama sekali — cukup baca posisi #detailActionBar
  // lewat getBoundingClientRect() setiap kali perlu reposisi.
  const FAB_MARGIN = 24;   // jarak default dari tepi kanan-bawah viewport
  const SAFE_GAP = 16;     // jarak aman minimum ke floating Download/Install
  const VIEW_PAD = 8;      // padding aman ke tepi viewport
  const DRAG_THRESHOLD = 6; // px — di bawah ini dianggap klik biasa, bukan drag (poin #3)
  const POS_KEY = 'lc_fab_pos_v1'; // localStorage — reuse storage existing App, TIDAK bikin DB baru (poin #4)

  let fabPos = null;      // {left, top} posisi terapan terakhir (px, viewport)
  let dragState = null;   // {startX, startY, startLeft, startTop, dragging, pointerId}
  let suppressNextClick = false;

  function fabSize() {
    const el = $('lcFabBtn');
    return (el && el.offsetWidth) || 60;
  }

  function loadSavedNormPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.nx === 'number' && typeof p.ny === 'number' &&
          p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1) return p;
    } catch (e) {}
    return null;
  }

  // Simpan posisi RELATIF/NORMALIZED (0..1 terhadap area gerak yang valid),
  // bukan pixel absolut — supaya kalau window di-resize ke resolusi lain,
  // posisi tetap proporsional & tidak keluar layar (poin #4).
  function saveNormPos(nx, ny) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ nx, ny })); } catch (e) {}
  }

  function getDefaultPos(size) {
    const vw = window.innerWidth, vh = window.innerHeight;
    return { left: vw - FAB_MARGIN - size, top: vh - FAB_MARGIN - size };
  }

  // #detailActionBar ada di dalam <section id="page-detail"> (Game Detail &
  // Bypass Detail berbagi elemen yang sama — lihat renderDetailActions() di
  // app.js), dan .page yang tidak .active punya display:none dari CSS
  // existing, jadi begitu halaman lain dibuka rect-nya otomatis 0×0 — tidak
  // perlu deteksi halaman/route secara manual sama sekali.
  function getDetailActionBarRect() {
    const el = document.getElementById('detailActionBar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return r;
  }

  function clampToViewport(left, top, size) {
    const vw = window.innerWidth, vh = window.innerHeight;
    left = Math.min(Math.max(left, VIEW_PAD), Math.max(VIEW_PAD, vw - size - VIEW_PAD));
    top = Math.min(Math.max(top, VIEW_PAD), Math.max(VIEW_PAD, vh - size - VIEW_PAD));
    return { left, top };
  }

  // Geser posisi MENJAUH kalau bertabrakan dengan floating Download/Install
  // existing — tidak pernah mengubah posisi tombol Download/Install itu
  // sendiri (poin #5: "Download/Install tetap di posisi existing, Live Chat
  // yang menyesuaikan").
  function avoidActionBar(left, top, size) {
    const bar = getDetailActionBarRect();
    if (!bar) return { left, top };
    const f = { left: bar.left - SAFE_GAP, top: bar.top - SAFE_GAP, right: bar.right + SAFE_GAP, bottom: bar.bottom + SAFE_GAP };
    const overlap = left < f.right && (left + size) > f.left && top < f.bottom && (top + size) > f.top;
    if (!overlap) return { left, top };
    // 1) Coba geser ke atas dari action bar (paling natural, action bar ada di bawah).
    let tryTop = f.top - size;
    if (tryTop >= VIEW_PAD) return clampToViewport(left, tryTop, size);
    // 2) Kalau tidak muat, coba geser ke kiri dari action bar.
    let tryLeft = f.left - size;
    if (tryLeft >= VIEW_PAD) return clampToViewport(tryLeft, top, size);
    // 3) Fallback terakhir — clamp seaman mungkin, tetap dalam viewport.
    return clampToViewport(left, Math.max(VIEW_PAD, f.top - size), size);
  }

  function computeSafePos(left, top) {
    const size = fabSize();
    let p = clampToViewport(left, top, size);
    p = avoidActionBar(p.left, p.top, size);
    return p;
  }

  function applyFabPos(left, top) {
    const el = $('lcFabBtn');
    if (!el) return;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    fabPos = { left, top };
    positionFloatingExtras();
  }

  // Hitung ulang & terapkan posisi icon — dipanggil saat init, resize, login,
  // dan tiap kali layout halaman berubah (lihat maybeReposition()). Posisi
  // manual hasil drag SELALU diprioritaskan; sistem cuma menggeser SEPERLUNYA
  // kalau memang lagi bertabrakan dengan Download/Install, bukan reset ke
  // default (poin #2: "jangan hardcode berdasarkan satu halaman saja").
  function repositionFab() {
    const el = $('lcFabBtn');
    if (!el || el.style.display === 'none') return;
    const size = fabSize();
    const saved = loadSavedNormPos();
    let left, top;
    if (saved) {
      const vw = window.innerWidth, vh = window.innerHeight;
      left = saved.nx * Math.max(1, vw - size);
      top = saved.ny * Math.max(1, vh - size);
    } else {
      const d = getDefaultPos(size);
      left = d.left; top = d.top;
    }
    const safe = computeSafePos(left, top);
    applyFabPos(safe.left, safe.top);
  }

  // ── Posisikan elemen mengambang lain (hint/notif/widget) RELATIF terhadap
  // posisi icon saat ini — dipakai bareng supaya semuanya konsisten mengikuti
  // icon walau sudah dipindahkan (poin #13/#14). Otomatis pilih di atas/
  // bawah icon sesuai sisa ruang viewport, dan selalu clamp horizontal
  // supaya tidak pernah terpotong (poin #14).
  function computeAnchorNearIcon(elWidth, elHeight, gap) {
    const icon = $('lcFabBtn');
    const iconRect = icon ? icon.getBoundingClientRect() : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!iconRect || iconRect.width === 0) {
      return { left: vw - FAB_MARGIN - elWidth, top: vh - FAB_MARGIN - gap - elHeight, below: false };
    }
    const iconCenterY = iconRect.top + iconRect.height / 2;
    let below = iconCenterY < vh / 2; // icon di separuh ATAS layar -> elemen tampil DI BAWAH icon
    let top = below ? (iconRect.bottom + gap) : (iconRect.top - gap - elHeight);
    if (below && top + elHeight > vh - VIEW_PAD) { below = false; top = iconRect.top - gap - elHeight; }
    else if (!below && top < VIEW_PAD) { below = true; top = iconRect.bottom + gap; }
    top = Math.max(VIEW_PAD, Math.min(top, vh - elHeight - VIEW_PAD));
    let left = iconRect.left + iconRect.width / 2 - elWidth / 2;
    left = Math.min(Math.max(left, VIEW_PAD), Math.max(VIEW_PAD, vw - elWidth - VIEW_PAD));
    return { left, top, below };
  }

  function positionHintBubble() {
    const el = $('lcHint');
    if (!el) return;
    const pos = computeAnchorNearIcon(el.offsetWidth || 210, el.offsetHeight || 46, 14);
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.classList.toggle('lc-hint-below', pos.below);
  }

  function positionNotifPopup() {
    const el = $('lcNotifPopup');
    if (!el) return;
    const pos = computeAnchorNearIcon(el.offsetWidth || 300, el.offsetHeight || 70, 14);
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
  }

  function positionWidget() {
    const el = $('lcWidget');
    if (!el) return;
    const pos = computeAnchorNearIcon(el.offsetWidth || 400, el.offsetHeight || 560, 14);
    el.style.left = pos.left + 'px'; el.style.top = pos.top + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
  }

  function positionFloatingExtras() {
    positionHintBubble();
    // Notif popup & widget cuma direposisi kalau memang sedang tampil, biar
    // tidak menggeser sesuatu yang tidak sedang dilihat user tanpa alasan.
    const notif = $('lcNotifPopup');
    if (notif && notif.classList.contains('show')) positionNotifPopup();
    if (widgetOpen) positionWidget();
  }

  // ── Drag handle (poin #3/#11) — pointer events (bukan mouse/touch terpisah)
  // supaya stabil di Electron/Chromium & mendukung mouse maupun sentuh dari
  // satu jalur kode yang sama. Threshold DRAG_THRESHOLD memisahkan klik biasa
  // (buka Live Chat) dari drag (pindahkan icon) — persis sesuai spek.
  function onFabPointerDown(ev) {
    if (typeof ev.button === 'number' && ev.button !== 0) return; // klik kiri/sentuh saja
    const el = $('lcFabBtn');
    const rect = el.getBoundingClientRect();
    dragState = {
      startX: ev.clientX, startY: ev.clientY,
      startLeft: rect.left, startTop: rect.top,
      dragging: false, pointerId: ev.pointerId
    };
    try { el.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function onFabPointerMove(ev) {
    if (!dragState || dragState.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - dragState.startX;
    const dy = ev.clientY - dragState.startY;
    if (!dragState.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragState.dragging = true;
      $('lcFabBtn').classList.add('lc-dragging');
      updateHintPauseState();
    }
    ev.preventDefault();
    const safe = computeSafePos(dragState.startLeft + dx, dragState.startTop + dy);
    applyFabPos(safe.left, safe.top);
  }

  function onFabPointerUp(ev) {
    if (!dragState || dragState.pointerId !== ev.pointerId) return;
    const el = $('lcFabBtn');
    if (dragState.dragging) {
      el.classList.remove('lc-dragging');
      const size = fabSize();
      const vw = window.innerWidth, vh = window.innerHeight;
      const nx = fabPos ? fabPos.left / Math.max(1, vw - size) : 0;
      const ny = fabPos ? fabPos.top / Math.max(1, vh - size) : 0;
      saveNormPos(Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny)));
      suppressNextClick = true; // cegah 'click' yang menyusul pointerup ikut membuka widget
      updateHintPauseState();
    }
    try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
    dragState = null;
  }

  // ── Deteksi perubahan layout (pindah halaman / resize) TANPA menyentuh
  // router app.js — cukup poll signature ringan (dipanggil dari
  // pollSessionState() yang sudah ada, tiap 500ms) dan reposisi HANYA kalau
  // memang berubah, supaya murah dan tidak menggeser icon tanpa alasan.
  let _lastLayoutSig = '';
  function layoutSignature() {
    const bar = getDetailActionBarRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    return vw + 'x' + vh + '|' + (bar ? [bar.left, bar.top, bar.right, bar.bottom].map(Math.round).join(',') : 'none');
  }
  function maybeReposition() {
    const sig = layoutSignature();
    if (sig !== _lastLayoutSig) { _lastLayoutSig = sig; repositionFab(); }
  }

  // ══════════════════════════ POLLING FALLBACK (defense-in-depth, BUKAN mekanisme
  // utama) ══════════════════════════
  // Perbaikan utama realtime ada di resyncMessages() yang dipicu event 'onSocketOpen'
  // dari app.js setiap kali WS (re)connect — ini cuma jaring pengaman tambahan kalau
  // untuk alasan tak terduga koneksi terlihat "OPEN" tapi sebenarnya sudah mati tanpa
  // pernah memicu close/reconnect sama sekali (sangat jarang, tapi murah untuk dijaga).
  let pollTimer = null;
  function startPollFallback() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (currentUser) resyncMessages({ silent: true }); }, 25000);
  }

  // ══════════════════════════ SHOW/HIDE BERDASARKAN SESI LOGIN ══════════════════════════
  // FAB sengaja disembunyikan (display:none) di index.html sampai user benar-benar
  // login (currentUser terisi oleh app.js) — hindari nebak-nebak urutan bootstrap
  // app.js, cukup poll ringan tiap 500ms.
  let _wasLoggedIn = false;
  function pollSessionState() {
    const loggedIn = !!(typeof currentUser !== 'undefined' && currentUser && localStorage.getItem('token'));
    const fab = $('lcFabBtn');
    if (!fab) return;
    if (loggedIn && !_wasLoggedIn) {
      fab.style.display = 'flex';
      repositionFab(); // hitung posisi (tersimpan atau default) begitu icon pertama kali tampil
      loadMessages();
      startHintLoop();
    } else if (!loggedIn && _wasLoggedIn) {
      fab.style.display = 'none';
      closeWidget();
      messages = []; loadedOnce = false; setBadge(0);
      // Logout — matikan loop hint sesi ini; startHintLoop() dipanggil lagi
      // dari awal kalau ada user LAIN login di App yang sama.
      stopHintLoop();
    }
    _wasLoggedIn = loggedIn;
    if (loggedIn) maybeReposition(); // deteksi pindah halaman / resize (poin #10 & #16), murah krn di-skip kalau layout sama
  }

  // ══════════════════════════ INIT ══════════════════════════
  function init() {
    if (widgetInited) return;
    widgetInited = true;
    buildEmojiPicker();

    // Klik biasa membuka Live Chat; drag (lihat pointer handlers di bawah)
    // men-set suppressNextClick supaya klik yang menyusul pointerup TIDAK
    // ikut menganggap user "klik" sekaligus toggle widget (poin #3).
    $('lcFabBtn').addEventListener('click', (ev) => {
      if (suppressNextClick) { suppressNextClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
      toggleWidget();
    });
    $('lcFabBtn').addEventListener('pointerdown', onFabPointerDown);
    $('lcFabBtn').addEventListener('pointermove', onFabPointerMove);
    $('lcFabBtn').addEventListener('pointerup', onFabPointerUp);
    $('lcFabBtn').addEventListener('pointercancel', onFabPointerUp);
    $('lcMinimizeBtn').addEventListener('click', closeWidget);
    $('lcCloseBtn').addEventListener('click', closeWidget);

    $('lcSendBtn').addEventListener('click', sendMessage);
    $('lcInputText').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
    });
    $('lcInputText').addEventListener('input', (ev) => {
      autoGrowTextarea(ev.target);
      if (ev.target.value.trim()) notifyTyping();
    });

    $('lcEmojiBtn').addEventListener('click', toggleEmojiPicker);
    $('lcImageBtn').addEventListener('click', () => $('lcImageInput').click());
    $('lcImageInput').addEventListener('change', (ev) => handleImageFile(ev.target.files?.[0]));
    $('lcImagePreviewRemove').addEventListener('click', clearPendingImage);

    $('lcMessages').addEventListener('click', (ev) => {
      const img = ev.target.closest('img[data-lc-zoom]');
      if (img) openLightbox(img.src);
    });

    setInterval(pollSessionState, 500);
    pollSessionState();
    startPollFallback();

    // Resize langsung dapat respons cepat (tidak perlu nunggu poll 500ms) —
    // debounce kecil supaya tidak menghitung ulang berkali-kali saat window
    // masih di-drag-resize (poin #16 — test resize berbagai resolusi).
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(repositionFab, 80);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.LiveChatWidget = {
    handleWsEvent,
    openWidget,
    closeWidget,
    // Dipanggil dari app.js setiap kali _ws (re)connect — lihat catatan FIX di
    // resyncMessages() untuk penjelasan akar masalahnya.
    onSocketOpen: () => resyncMessages()
  };
})();
