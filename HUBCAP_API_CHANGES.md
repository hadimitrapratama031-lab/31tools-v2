# Halaman "Hubcap API" — Ringkasan Perubahan

## File baru
- `hubcapKeyManager.js` — modul pengelola API Key HubCap: CRUD, auto rotation, cooldown, dan pengambilan status/usage asli dari `hubcapmanifest.com` (dengan cache singkat 20 detik).

## File yang diubah
- `server.js`
  - API Key HubCap tidak lagi hanya dari `.env` (`HUBCAP_API_KEY`, `_2`, `_3`, `_4`) — sekarang disimpan di MongoDB (koleksi `hubcapApiKeys`) dan dikelola dari Admin Web.
  - Kalau koleksi `hubcapApiKeys` masih kosong tapi `.env` lama masih ada isinya, otomatis dimigrasikan sekali saat server start (`hubcapKeyManager.migrateLegacyEnvKeys()`), jadi kamu tidak perlu input ulang manual.
  - `streamHubcapManifest()` dan `checkHubcapManifest()` sekarang memakai `hubcapKeyManager` — auto rotation ke key aktif berikutnya kalau kena 429/401/403, realtime tanpa restart.
  - Endpoint admin baru:
    - `GET  /api/admin/hubcap/docs` — data dokumentasi 2 endpoint HubCap (health & user/stats).
    - `GET  /api/admin/hubcap/live/health` — proxy "Try it" ke `/api/v1/health` asli.
    - `GET  /api/admin/hubcap/live/stats` — proxy "Try it" ke `/api/v1/user/stats` asli (pakai key yang sedang aktif di rotasi).
    - `GET  /api/admin/hubcap/keys` / `GET /api/admin/hubcap/monitor` — snapshot daftar key + status + usage realtime (`?force=1` untuk bypass cache 20 detik).
    - `POST /api/admin/hubcap/keys` — tambah API Key.
    - `PUT  /api/admin/hubcap/keys/:id` — edit nama/API Key/status aktif.
    - `PUT  /api/admin/hubcap/keys/:id/toggle` — aktif/nonaktifkan cepat.
    - `DELETE /api/admin/hubcap/keys/:id` — hapus.
  - Log baru di `LOG_CATALOG` (kategori `hubcap`): tambah/edit/hapus API Key, kena limit, auto rotation, semua key limit, error API — semuanya juga muncul di halaman Logs & di-broadcast realtime lewat WebSocket admin (`event: 'hubcap:update'`).

- `public/admin.html` — nav baru "Hubcap API" + halaman baru dengan 4 tab: Dokumentasi API (ala Swagger), API Key Management, Monitoring, dan Logs. Plus modal Tambah/Edit API Key.
- `public/admin.css` — style baru untuk tab, kartu dokumentasi/code block, badge status, progress bar penggunaan.
- `public/admin.js` — semua logika halaman: render dokumentasi + tombol Copy Request + Try it, CRUD API Key, monitoring dengan progress bar realtime, dan tab Logs. Ter-update otomatis lewat WebSocket saat ada rotasi/limit tanpa perlu refresh manual.

## Yang perlu kamu lakukan
1. Deploy seperti biasa (`npm start` / redeploy Railway) — **tidak perlu env var baru**, key lama otomatis termigrasi sekali di start pertama.
2. Buka Admin Web > menu **Hubcap API** > tab **API Key** untuk lihat/kelola key yang sudah termigrasi, atau tambah key baru.
3. Kalau mau hapus dependensi ke `.env` sepenuhnya, boleh hapus `HUBCAP_API_KEY*` dari `.env` setelah memastikan semua key sudah muncul di Admin Web (migrasi hanya jalan sekali saat koleksi masih kosong).
