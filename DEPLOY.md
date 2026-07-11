# Panduan Deploy — Cellyn Community & Store Bot (EnderCloud / Pterodactyl)

Panduan ini adalah checklist permanen untuk men-deploy & meng-update bot di hosting
tanpa akses terminal (EnderCloud/Pterodactyl). Ikuti berurutan.

---

## ⚠️ 2 SETELAN WAJIB (paling sering bikin bot gagal online)

### 1. Aktifkan Privileged Intents di Discord Developer Portal
Bot butuh 2 intent privileged. Kalau belum aktif, bot bisa **login tapi tidak pernah "ready"**.
1. Buka https://discord.com/developers/applications
2. Pilih aplikasi bot → tab **Bot**
3. Scroll ke **Privileged Gateway Intents**, aktifkan:
   - ✅ **SERVER MEMBERS INTENT**
   - ✅ **MESSAGE CONTENT INTENT**
4. **Save Changes**.

### 2. Pakai Node.js LTS (v20 atau v22), BUKAN versi ganjil (v23/v25)
- LTS = *Long Term Support* (versi genap: **20** atau **22**). Stabil & kompatibel dengan discord.js v14.
- Di panel EnderCloud, pilih versi Node **v22** (atau v20) — bukan v25.
- Ini **bukan egg**, melainkan versi runtime. Egg "Node.js Generic" tetap dipakai.

---

## Startup Command
Set startup command di panel ke salah satu:
```
node index.js
```
atau
```
npm start
```
`index.js` adalah bootstrap otomatis: ia menjalankan `npm install` (bila perlu), `prisma generate`,
compile TypeScript, lalu menjalankan bot. **Jangan** pakai `dist/index.js` (itu melewati bootstrap).

---

## Environment Variables (.env)
Isi lewat menu Environment/Startup di panel, atau file `.env`. Lihat daftar lengkap di
[`.env.example`](./.env.example). Yang WAJIB:

| Variabel | Keterangan |
|----------|------------|
| `DISCORD_TOKEN` | Token bot dari Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID bot |
| `ADMIN_ROLE_ID` | ID role admin |
| `ADMIN_LOG_CHANNEL_ID` | ID channel log/konfirmasi admin |
| `INDOSMM_API_URL` | mis. `https://indosmm.id/api/v2` |
| `INDOSMM_API_KEY` | API key IndoSMM |
| `QRIS_IMAGE_URL` | URL gambar QRIS pembayaran |

Opsional penting: `TICKET_CATEGORY_ID`, `MARKUP_PERCENTAGE` (default 40),
`LOW_BALANCE_THRESHOLD` (default 50000), `DATABASE_URL` (default `file:./dev.db`),
dan variabel `EMOJI_*` untuk emoji custom server (lihat `.env.example`).

---

## A. Deploy Pertama Kali
1. Upload seluruh isi repo ke server (atau clone via panel).
2. Set **Startup Command** = `node index.js`.
3. Set **Node version** = v22 (LTS).
4. Isi semua Environment Variables (lihat tabel di atas).
5. Aktifkan **Privileged Intents** (bagian wajib #1).
6. Pastikan bot sudah **diundang ke server** dengan scope `bot` + `applications.commands`.
7. Klik **Start**. Tunggu proses build (boot pertama agak lama).
8. Setelah online, jalankan `/admin sync-services` lalu `/admin set-catalog-channel #channel`.

---

## B. Update / Redeploy (kode versi baru)
> ‼️ **JANGAN hapus atau timpa file berikut** — ini DATA milikmu:
> - `dev.db` dan `dev.db-journal` (database: tiket, order, dsb)
> - `.env` (konfigurasi & token)
> - folder `backups/`

Langkah aman:
1. (Disarankan) **Backup dulu**: download `dev.db` lewat File Manager panel.
2. Merge PR terbaru di GitHub, lalu **download ZIP** dari branch `main`
   (ZIP GitHub TIDAK berisi `dev.db`/`.env`, jadi aman menimpa file kode).
3. Upload & **timpa file kode**: `index.js`, `package.json`, `tsconfig.json`,
   `prisma/schema.prisma`, folder `src/`, `.env.example`.
4. (Opsional, disarankan bila `package.json` berubah) hapus folder `node_modules`
   dan `dist` — keduanya BUKAN data, akan dibuat ulang otomatis.
5. **Start** (sekali saja). Bootstrap akan generate + build + jalan.

---

## C. Verifikasi Log Sukses
Log yang diharapkan saat boot normal:
```
[bootstrap] $ node prisma generate
[bootstrap] $ node tsc
[Boot] Starting ALL IN ONE Bot...
[DB] Schema siap (idempotent, tanpa drop).
[Boot] Database ready
[Net] API Discord terjangkau (HTTP 200).
[Boot] Logging in to Discord...
[Boot] Login OK, menunggu event ready dari gateway...
[Boot] Bot ready: NamaBot#1234        ← ✅ ONLINE
```

---

## D. Troubleshooting

| Gejala di log | Penyebab | Solusi |
|---------------|----------|--------|
| Stuck di `Logging in to Discord...` (tak ada "Bot ready") | Privileged Intents belum aktif | Aktifkan 2 intent (wajib #1), restart |
| `[Net] ... (HTTP 429)` | IP di-*rate limit* Discord (biasanya karena on-off berulang) | **Matikan bot, tunggu 30–60 menit, start SEKALI.** Jangan restart beruntun |
| `[Net] TIMEOUT` | Jaringan host tak bisa ke discord.com / IPv6 rusak | Sudah dipaksa IPv4; bila tetap, hubungi support host |
| `prisma: Permission denied` | Skrip `.bin` tak executable | Sudah ditangani (dijalankan via `node`) — pastikan pakai kode terbaru |
| `index ... cannot be dropped` | Migrasi lama SQLite | Sudah ditangani (init idempoten) — pastikan pakai kode terbaru |
| Slash command **dobel** | Sisa command global versi lama | Sudah dibersihkan otomatis; command global hilang total dalam ~1 jam |
| Command "interaction failed" | Cache command lama di app Discord | Refresh Discord: **Ctrl+R** (desktop) atau tutup-buka app |
| Warning `ephemeral deprecated` | (Hanya warning) | Aman; sudah dibersihkan di versi terbaru |

### Tips penting
- **Jangan on-off bot berulang cepat** → memicu rate limit 429.
- Untuk melihat detail tahap koneksi, set env `DISCORD_DEBUG=1` lalu restart.
- Bot otomatis membuat backup DB harian ke folder `backups/` + backup pra-migrasi sebelum boot.
