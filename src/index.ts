import 'dotenv/config';
import { ENV } from './config/env';
import { logger } from './lib/logger';
import { client, prisma } from './bot/client';
import { handleInteraction } from './bot/handlers/interactionCreate';
import { runRecovery } from './workers/recoveryWorker';
import { runServiceSync } from './workers/serviceSyncWorker';
import { runOrderStatusCheck } from './workers/orderStatusWorker';
import { runCatalogUpdate } from './workers/catalogWorker';
import { runTicketGarbageCollector, runTicketChannelSweeper, handleMemberLeave } from './workers/ticketGarbageWorker';
import { runDatabaseBackup, scheduleBackup } from './workers/backupWorker';
import { REST, Routes, SlashCommandBuilder, SlashCommandSubcommandBuilder, GuildMember, TextChannel } from 'discord.js';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { indosmm } from './providers/indosmm';
import { buildLowBalanceNotif } from './lib/embeds';
import { handleMessageCreate } from './bot/handlers/messageCreate';
import { resolveDbFilePath } from './lib/dbPath';
import { createHash } from 'crypto';
import dns from 'dns';
import https from 'https';

// Helper jeda sederhana. Dipakai untuk "stagger" boot supaya panggilan REST ke Discord
// tidak meledak barengan saat startup (mengurangi risiko 429 / Cloudflare IP ban).
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// PENTING: paksa DNS mengutamakan IPv4. Di banyak host (container/VPS, termasuk sebagian
// EnderCloud) konektivitas IPv6 rusak/tidak terhubung. Karena undici (dipakai discord.js untuk
// REST) sering mencoba IPv6 lebih dulu, panggilan login ke API Discord bisa "menggantung" tanpa
// error sama sekali — persis gejala bot stuck di "Logging in to Discord...". ipv4first mencegahnya.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* Node lama: abaikan */ }

// Cek konektivitas ke API Discord memakai modul https bawaan Node (tanpa token, endpoint publik).
// Ini memisahkan masalah "jaringan host tidak bisa menghubungi Discord" dari masalah lain,
// sehingga log jelas menunjukkan penyebab bila bot gagal login.
function probeDiscordApi(): Promise<void> {
  return new Promise((resolve) => {
    const req = https.get('https://discord.com/api/v10/gateway', { timeout: 10_000 }, (res) => {
      const code = res.statusCode;
      if (code === 429) {
        const retryAfter = res.headers['retry-after'];
        logger.error(
          '[Net] API Discord membalas 429 (RATE LIMITED — IP host sedang diblokir sementara oleh Discord/Cloudflare). ' +
          (retryAfter ? `Coba lagi setelah ~${retryAfter} detik. ` : '') +
          'Ini BUKAN bug kode. Penyebab umum: bot di-restart/login TERLALU SERING dalam waktu singkat ' +
          '(mis. akibat crash-loop saat debugging), atau IP shared hosting bereputasi buruk. ' +
          'SOLUSI: MATIKAN bot, JANGAN restart berulang, tunggu 30–60 menit, lalu START SEKALI saja. ' +
          'Kalau tetap 429 setelah menunggu, minta ganti IP/node ke EnderCloud.'
        );
      } else {
        logger.info(`[Net] API Discord terjangkau (HTTP ${code}).`);
      }
      res.resume();
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      logger.error('[Net] TIMEOUT menghubungi API Discord (10 dtk). Kemungkinan jaringan host / IPv6 bermasalah, atau firewall memblokir discord.com.');
      resolve();
    });
    req.on('error', (e: any) => {
      logger.error('[Net] Gagal menghubungi API Discord', { error: e?.message });
      resolve();
    });
  });
}

// Ping URL health-check (mis. healthchecks.io / UptimeRobot push / Better Uptime) supaya
// kamu dapat notifikasi kalau bot MATI. Diaktifkan hanya bila HEALTHCHECK_URL diisi.
function pingHealthcheck(): void {
  if (!ENV.HEALTHCHECK_URL) return;
  try {
    const req = https.get(ENV.HEALTHCHECK_URL, { timeout: 10_000 }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', (e: any) => logger.warn('[Health] Ping gagal', { error: e?.message }));
  } catch (e: any) {
    logger.warn('[Health] Ping error', { error: e?.message });
  }
}

async function checkBalance(): Promise<void> {
  try {
    const balance = await indosmm.getBalance();
    if (balance < ENV.LOW_BALANCE_THRESHOLD) {
      const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
      if (adminChannel) await adminChannel.send({ embeds: [buildLowBalanceNotif(balance, ENV.LOW_BALANCE_THRESHOLD)] });
      logger.warn(`[Balance] Low balance: Rp ${balance}`);
    }
  } catch (err: any) {
    logger.error('[Balance] Failed to check balance', { error: err.message });
  }
}

// Bangun daftar definisi slash command (JSON). Dipisah dari proses register agar bisa
// dipakai ulang (register saat boot & register khusus guild baru) dan di-hash untuk deteksi
// perubahan.
function buildCommandsJson(): any[] {
  return [
    new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Kelola ticket kamu')
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('status').setDescription('Lihat status ticket aktif')
      ),
    new SlashCommandBuilder()
      .setName('order')
      .setDescription('Order kamu')
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('history').setDescription('Lihat riwayat order kamu')
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('refill')
          .setDescription('Klaim garansi/refill order (bisa dipakai walau tiket sudah ditutup)')
          .addStringOption(o =>
            o.setName('order_id')
              .setDescription('ID order (8 karakter, lihat di /order history)')
              .setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Admin commands')
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('sync-services').setDescription('Sync layanan dari IndoSMM')
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('set-catalog-channel')
          .setDescription('Set channel katalog')
          .addChannelOption(o => o.setName('channel').setDescription('Channel katalog').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('set-markup')
          .setDescription('Set markup harga')
          .addNumberOption(o => o.setName('value').setDescription('Markup persen').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('cancel-order')
          .setDescription('Batalkan order')
          .addStringOption(o => o.setName('order_id').setDescription('ID Order (8 karakter)').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('set-description')
          .setDescription('Set/timpa deskripsi layanan (disalin dari web IndoSMM)')
          .addStringOption(o => o.setName('service_id').setDescription('ID layanan provider (angka dari IndoSMM)').setRequired(true))
          .addStringOption(o => o.setName('text').setDescription('Isi deskripsi. Ketik "-" untuk menghapus override').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('find-service')
          .setDescription('Cari layanan & lihat Service ID-nya')
          .addStringOption(o => o.setName('keyword').setDescription('Kata kunci: nama / kategori / ID layanan').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('audit-log').setDescription('Lihat audit log admin')
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('stats')
          .setDescription('Dashboard statistik toko (omzet, profit, order, terlaris)')
          .addStringOption(o => o.setName('periode').setDescription('Periode statistik').addChoices(
            { name: 'Hari ini', value: 'day' },
            { name: '7 hari', value: 'week' },
            { name: '30 hari', value: 'month' },
            { name: 'Semua', value: 'all' },
          ))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('set-markup-category')
          .setDescription('Set markup per kategori (mis. Instagram 50%)')
          .addStringOption(o => o.setName('kategori').setDescription('Nama kategori (mis. Instagram, TikTok)').setRequired(true))
          .addNumberOption(o => o.setName('value').setDescription('Markup persen').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('hide-service')
          .setDescription('Sembunyikan/tampilkan layanan dari katalog')
          .addStringOption(o => o.setName('service_id').setDescription('ID layanan provider (angka dari IndoSMM)').setRequired(true))
          .addBooleanOption(o => o.setName('hidden').setDescription('true = sembunyikan, false = tampilkan').setRequired(true))
      )
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('broadcast')
          .setDescription('Kirim pengumuman ke sebuah channel')
          .addChannelOption(o => o.setName('channel').setDescription('Channel tujuan').setRequired(true))
          .addStringOption(o => o.setName('pesan').setDescription('Isi pengumuman').setRequired(true))
          .addStringOption(o => o.setName('judul').setDescription('Judul pengumuman (opsional)'))
      ),
  ].map(c => c.toJSON());
}

// Baca nilai dari tabel key-value BotState (best-effort; kembalikan null bila belum ada).
async function readBotState(key: string): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
      'SELECT "value" FROM "BotState" WHERE "key" = ?', key,
    );
    return rows?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

// Simpan nilai ke BotState (upsert).
async function writeBotState(key: string, value: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "BotState" ("key", "value", "updated_at") VALUES (?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = CURRENT_TIMESTAMP',
    key, value,
  );
}

// Register command ke SATU guild (dipakai saat bot diundang ke server baru, tanpa
// perlu re-register ke semua guild atau restart).
async function registerCommandsForGuild(guildId: string): Promise<void> {
  try {
    const commands = buildCommandsJson();
    const rest = new REST({ timeout: 15000 }).setToken(ENV.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(ENV.DISCORD_CLIENT_ID, guildId), { body: commands });
    logger.info(`[Commands] Command didaftarkan untuk guild baru ${guildId}`);
  } catch (e: any) {
    logger.error(`[Commands] Gagal daftar command untuk guild baru ${guildId}`, { error: e.message });
  }
}

async function registerCommands(): Promise<void> {
  const commands = buildCommandsJson();

  // PENTING (anti rate-limit): JANGAN register ulang tiap boot. Endpoint pendaftaran command
  // punya limit ketat; kalau bot sering restart/crash-loop, PUT global + per-guild yang
  // berulang bisa memicu 429 sampai Cloudflare mem-blokir IP host ~1 jam. Kita hanya register
  // bila definisi command BERUBAH (dibandingkan via hash yang disimpan di DB). Paksa register
  // ulang dengan env FORCE_REGISTER_COMMANDS=1 (mis. sekali setelah menambah command baru).
  const force = process.env.FORCE_REGISTER_COMMANDS === '1';
  const hash  = createHash('md5').update(JSON.stringify(commands)).digest('hex');
  const prevHash = await readBotState('commands_hash');

  if (!force && prevHash === hash) {
    logger.info('[Commands] Definisi command tidak berubah — lewati pendaftaran (hemat request, cegah 429). Set FORCE_REGISTER_COMMANDS=1 untuk memaksa.');
    return;
  }

  logger.info(`[Commands] Registering slash commands... (alasan: ${force ? 'FORCE_REGISTER_COMMANDS' : prevHash ? 'definisi berubah' : 'pertama kali'})`);
  const rest = new REST({ timeout: 15000 }).setToken(ENV.DISCORD_TOKEN);

  // Hapus command GLOBAL yang mungkin tersisa dari versi bot lama. Kalau global & guild
  // sama-sama ada, slash command tampil DOBEL. Bot ini hanya memakai guild commands (instan),
  // jadi global kita kosongkan.
  try {
    await rest.put(Routes.applicationCommands(ENV.DISCORD_CLIENT_ID), { body: [] });
    logger.info('[Commands] Global commands lama dibersihkan (mencegah duplikat).');
  } catch (e: any) {
    logger.warn('[Commands] Gagal membersihkan global commands', { error: e.message });
  }

  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) {
    logger.warn('[Commands] Bot belum berada di guild manapun — command tidak didaftarkan. Undang bot ke server (command akan otomatis terdaftar saat join).');
    return;
  }

  // Daftarkan guild commands (instan) ke SEMUA guild tempat bot berada.
  let registered = 0;
  for (const guildId of guildIds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(ENV.DISCORD_CLIENT_ID, guildId),
        { body: commands },
      );
      registered++;
    } catch (e: any) {
      logger.error(`[Commands] Gagal daftar command di guild ${guildId}`, { error: e.message });
    }
  }
  logger.info(`[Commands] Slash commands registered on ${registered}/${guildIds.length} guild(s)`);

  // Simpan hash HANYA bila SEMUA guild berhasil, supaya kalau ada yang gagal, boot berikutnya
  // mencoba lagi (tidak langsung ter-skip).
  if (registered === guildIds.length) {
    await writeBotState('commands_hash', hash).catch((e: any) =>
      logger.warn('[Commands] Gagal menyimpan hash command', { error: e.message }));
  }
}

// Salin file database SEBELUM migrasi sebagai jaring pengaman. Kalau migrasi bermasalah,
// admin masih punya salinan data (tiket/order) yang bisa dipulihkan. Hanya untuk SQLite lokal.
function backupDatabaseBeforeMigration(): void {
  try {
    const url = process.env.DATABASE_URL || ENV.DATABASE_URL;
    if (!url.startsWith('file:')) return;

    // Cari lokasi file DB yang sebenarnya (cwd vs prisma/) agar backup tidak salah lokasi.
    const dbPath = resolveDbFilePath();
    if (!existsSync(dbPath)) {
      logger.info('[DB] Database belum ada — lewati backup pra-migrasi (fresh install).');
      return;
    }

    const dir = path.resolve('./backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest  = path.join(dir, `pre-migrate-${stamp}.db`);
    copyFileSync(dbPath, dest);
    logger.info(`[DB] Backup pra-migrasi dibuat: ${dest}`);

    // Simpan maksimal 10 backup pra-migrasi terakhir agar tidak menumpuk.
    const files = readdirSync(dir)
      .filter(f => f.startsWith('pre-migrate-') && f.endsWith('.db'))
      .map(f => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    while (files.length > 10) {
      const oldest = files.shift();
      if (oldest) { try { unlinkSync(path.join(dir, oldest.f)); } catch { /* ignore */ } }
    }
  } catch (e: any) {
    logger.warn('[DB] Backup pra-migrasi gagal (migrasi tetap dilanjutkan)', { error: e.message });
  }
}

// DDL idempoten untuk menyiapkan skema. Kita SENGAJA memakai CREATE TABLE IF NOT EXISTS +
// ALTER ADD COLUMN (bukan `prisma db push`) karena `db push` pada SQLite bisa GAGAL dengan
// error "index ... cannot be dropped" saat mereconcile skema lama. Pendekatan ini TIDAK PERNAH
// men-drop apa pun, jadi aman untuk DB baru maupun DB lama yang sudah berisi data tiket/order.
const CREATE_TABLE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "Service" ("id" TEXT NOT NULL PRIMARY KEY, "provider_name" TEXT NOT NULL, "provider_service_id" TEXT NOT NULL UNIQUE, "category" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "description_override" TEXT, "min" INTEGER NOT NULL, "max" INTEGER NOT NULL DEFAULT 0, "price_buy" REAL NOT NULL DEFAULT 0, "price_sell" REAL NOT NULL DEFAULT 0, "markup_type" TEXT NOT NULL DEFAULT 'percentage', "markup_value" REAL NOT NULL DEFAULT 40, "refill" INTEGER NOT NULL DEFAULT 0, "refill_days" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "hidden" INTEGER NOT NULL DEFAULT 0, "last_synced_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "Review" ("id" TEXT NOT NULL PRIMARY KEY, "order_id" TEXT NOT NULL UNIQUE, "user_id" TEXT NOT NULL, "service_id" TEXT NOT NULL, "rating" INTEGER NOT NULL, "comment" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "ServiceSnapshot" ("id" TEXT NOT NULL PRIMARY KEY, "service_id" TEXT NOT NULL, "raw_json" TEXT NOT NULL, "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "CatalogMessage" ("id" TEXT NOT NULL PRIMARY KEY, "guild_id" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "message_id" TEXT, "message_type" TEXT NOT NULL DEFAULT 'catalog', "last_hash" TEXT, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "Ticket" ("id" TEXT NOT NULL PRIMARY KEY, "discord_user_id" TEXT NOT NULL, "guild_id" TEXT NOT NULL, "ticket_channel_id" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL DEFAULT 'open', "subject" TEXT NOT NULL, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "closed_at" DATETIME, "archived_at" DATETIME, "closed_by" TEXT, "close_reason" TEXT, "delete_channel_at" DATETIME)`,
  `CREATE TABLE IF NOT EXISTS "Order" ("id" TEXT NOT NULL PRIMARY KEY, "ticket_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "service_id" TEXT NOT NULL, "provider_order_id" TEXT, "target_link" TEXT NOT NULL, "quantity" INTEGER NOT NULL, "buy_price" REAL NOT NULL, "sell_price" REAL NOT NULL, "profit" REAL NOT NULL, "status" TEXT NOT NULL DEFAULT 'waiting_payment', "start_count" INTEGER, "remains" INTEGER, "refill_status" TEXT, "refill_expires_at" DATETIME, "notes" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "OrderLog" ("id" TEXT NOT NULL PRIMARY KEY, "order_id" TEXT NOT NULL, "old_status" TEXT, "new_status" TEXT NOT NULL, "message" TEXT, "raw_response_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "ManualPayment" ("id" TEXT NOT NULL PRIMARY KEY, "user_id" TEXT NOT NULL, "ticket_id" TEXT NOT NULL, "amount" REAL NOT NULL, "method" TEXT NOT NULL DEFAULT 'qris', "proof_url" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "approved_by" TEXT, "approved_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "BotMessage" ("id" TEXT NOT NULL PRIMARY KEY, "ticket_id" TEXT NOT NULL, "message_type" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "message_id" TEXT NOT NULL, "last_hash" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "ProviderSyncLog" ("id" TEXT NOT NULL PRIMARY KEY, "provider_name" TEXT NOT NULL, "status" TEXT NOT NULL, "message" TEXT, "raw_response_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "AdminAuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "actor_user_id" TEXT NOT NULL, "action" TEXT NOT NULL, "target_type" TEXT, "target_id" TEXT, "details_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "RefillRequest" ("id" TEXT NOT NULL PRIMARY KEY, "order_id" TEXT NOT NULL, "ticket_id" TEXT NOT NULL, "provider_refill_id" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "requested_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" DATETIME, "notes" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CatalogSelection" ("discord_user_id" TEXT NOT NULL PRIMARY KEY, "category" TEXT, "service_type" TEXT, "service_id" TEXT, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // Key-value sederhana untuk state internal bot (mis. hash definisi slash command agar tidak
  // register ulang tiap boot — lihat registerCommands()).
  `CREATE TABLE IF NOT EXISTS "BotState" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];

// Kolom baru untuk DB LAMA yang tabelnya sudah ada. ALTER gagal "duplicate column name"
// bila kolom sudah ada — itu diabaikan (idempoten).
const ADD_COLUMN_STATEMENTS: string[] = [
  `ALTER TABLE "Service" ADD COLUMN "description_override" TEXT`,
  `ALTER TABLE "Ticket" ADD COLUMN "delete_channel_at" DATETIME`,
  `ALTER TABLE "Service" ADD COLUMN "hidden" INTEGER NOT NULL DEFAULT 0`,
];

async function initDatabase(): Promise<void> {
  process.env.DATABASE_URL = process.env.DATABASE_URL || ENV.DATABASE_URL;

  // Amankan data dulu (salin DB sebelum menyentuh skema) — best-effort.
  backupDatabaseBeforeMigration();

  // Buat tabel yang belum ada (aman untuk DB baru & lama; tidak pernah men-drop).
  for (const sql of CREATE_TABLE_STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
  }

  // Tambahkan kolom baru ke tabel lama; abaikan bila kolom sudah ada.
  for (const sql of ADD_COLUMN_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e: any) {
      if (!/duplicate column name/i.test(e?.message || '')) {
        logger.warn('[DB] ALTER dilewati', { error: e?.message });
      }
    }
  }

  logger.info('[DB] Schema siap (idempotent, tanpa drop).');
}

async function main(): Promise<void> {
  logger.info('[Boot] Starting ALL IN ONE Bot...');

  try {
    await initDatabase();
    logger.info('[Boot] Database ready');
  } catch (err: any) {
    logger.error('[Boot] Database init failed', { error: err.message });
    process.exit(1);
  }

  client.once('ready', async () => {
    logger.info(`[Boot] Bot ready: ${client.user?.tag}`);

    // Register commands SETELAH bot ready — pakai guild commands agar instan
    try { await registerCommands(); } catch (e: any) { logger.error('[Boot] Command register failed', { error: e.message }); }

    // Stagger boot: beri jeda antar-worker yang banyak memanggil REST Discord supaya panggilan
    // tidak meledak bersamaan saat startup. Ini menurunkan puncak request/detik dan akumulasi
    // "invalid request" yang bisa memicu 429 / Cloudflare IP ban, terutama saat restart beruntun.
    try { await runRecovery(client); } catch (e: any) { logger.error('[Boot] Recovery failed', { error: e.message }); }
    await sleep(1500);
    // Segera bersihkan channel yang jatuh tempo hapus saat bot mati, dan sinkronkan status
    // order aktif langsung (jangan menunggu interval 60 detik) agar tidak "amnesia" pasca-restart.
    try { await runTicketChannelSweeper(client); } catch (e: any) { logger.error('[Boot] ChannelSweeper failed', { error: e.message }); }
    await sleep(1500);
    try { await runOrderStatusCheck(client); } catch (e: any) { logger.error('[Boot] OrderStatus initial failed', { error: e.message }); }
    await sleep(1500);
    try { await runServiceSync(); } catch (e: any) { logger.error('[Boot] ServiceSync failed', { error: e.message }); }
    await sleep(1500);
    try { await runCatalogUpdate(client); } catch (e: any) { logger.error('[Boot] Catalog failed', { error: e.message }); }
    await sleep(1000);
    try { await checkBalance(); } catch (e: any) { logger.error('[Boot] Balance check failed', { error: e.message }); }
    try { await runDatabaseBackup(); } catch (e: any) { logger.error('[Boot] Backup failed', { error: e.message }); }
    try { scheduleBackup(); } catch (e: any) { logger.error('[Boot] Schedule backup failed', { error: e.message }); }
    pingHealthcheck();

    setInterval(async () => {
      try {
        const count = await prisma.order.count({
          where: { status: { in: ['submitted', 'processing', 'partial', 'pending', 'in progress'] } },
        });
        if (count > 0) await runOrderStatusCheck(client);
      } catch (e: any) { logger.error('[Worker] OrderStatus failed', { error: e.message }); }
    }, 60 * 1000);

    setInterval(async () => {
      try { await runCatalogUpdate(client); } catch (e: any) { logger.error('[Worker] Catalog failed', { error: e.message }); }
    }, 2 * 60 * 1000);

    setInterval(async () => {
      try { await runServiceSync(); } catch (e: any) { logger.error('[Worker] ServiceSync failed', { error: e.message }); }
    }, 30 * 60 * 1000);

    setInterval(async () => {
      try { await runTicketGarbageCollector(client); } catch (e: any) { logger.error('[Worker] GarbageCollector failed', { error: e.message }); }
    }, 5 * 60 * 1000);

    // Sweeper penghapusan channel ticket (persisten) — tiap 60 detik.
    setInterval(async () => {
      try { await runTicketChannelSweeper(client); } catch (e: any) { logger.error('[Worker] ChannelSweeper failed', { error: e.message }); }
    }, 60 * 1000);

    setInterval(async () => {
      try { await checkBalance(); } catch (e: any) { logger.error('[Worker] Balance failed', { error: e.message }); }
    }, Math.max(1, ENV.BALANCE_CHECK_INTERVAL_HOURS) * 60 * 60 * 1000);

    // Health-check ping tiap 5 menit (hanya bila HEALTHCHECK_URL diisi).
    setInterval(() => pingHealthcheck(), 5 * 60 * 1000);

    logger.info('[Boot] All workers started');
  });

  client.on('guildMemberRemove', async (member) => {
    try { await handleMemberLeave(client, member as GuildMember); } catch (e: any) { logger.error('[Event] MemberLeave failed', { error: e.message }); }
  });

  // Bot diundang ke server baru → daftarkan command HANYA untuk guild itu (tidak perlu
  // re-register ke semua guild atau restart). Aman dari sisi rate-limit.
  client.on('guildCreate', async (guild) => {
    logger.info(`[Event] Bergabung ke guild baru ${guild.id} (${guild.name})`);
    try { await registerCommandsForGuild(guild.id); } catch (e: any) { logger.error('[Event] guildCreate register failed', { error: e.message }); }
  });

  client.on('interactionCreate', handleInteraction);

  // Tangkap bukti pembayaran (gambar) yang diupload user di channel ticket.
  client.on('messageCreate', handleMessageCreate);

  // Diagnostik koneksi: bila bot "nyangkut" setelah login, listener ini menampilkan sebabnya
  // (mis. intent bermasalah / gateway putus) sehingga tidak diam tanpa info.
  // OBSERVABILITY RATE LIMIT: log setiap kali REST Discord kena rate limit, LENGKAP dengan
  // route/method-nya. Ini menjawab "request mana yang bikin kena limit" tanpa menebak — cek
  // log [REST] untuk tahu endpoint persisnya (mis. edit message di route order/catalog).
  client.rest.on('rateLimited', (info: any) => {
    logger.warn('[REST] Kena rate limit Discord', {
      global:        info?.global,
      method:        info?.method,
      route:         info?.route,
      url:           info?.url,
      limit:         info?.limit,
      timeToResetMs: info?.timeToReset,
    });
  });
  // PERINGATAN DINI Cloudflare: Discord menghitung "invalid request" (401/403/429). Bila terlalu
  // banyak dalam 10 menit, SELURUH IP host diblokir ~1 jam (inilah gejala "tiba-tiba 429").
  // Listener ini memberi peringatan sebelum ambang tercapai.
  client.rest.on('invalidRequestWarning', (info: any) => {
    logger.error('[REST] PERINGATAN: banyak invalid request (401/403/429) — mendekati Cloudflare IP ban ~1 jam! Periksa penyebab (restart beruntun / permission channel).', {
      count:           info?.count,
      remainingTimeMs: info?.remainingTime,
    });
  });

  client.on('error',          (e: any) => logger.error('[Discord] Client error', { error: e?.message }));
  client.on('shardError',     (e: any) => logger.error('[Discord] Shard error', { error: e?.message }));
  client.on('shardDisconnect', (ev: any, id: number) => logger.warn(`[Discord] Shard ${id} disconnected`, { code: ev?.code, reason: ev?.reason }));
  client.on('warn',           (m: string) => logger.warn('[Discord] Warn', { message: m }));
  // Log tahap koneksi gateway secara detail. Aktifkan dengan env DISCORD_DEBUG=1 untuk melihat
  // persis di mana proses berhenti (fetch gateway / connecting wss / identify / ready).
  if (process.env.DISCORD_DEBUG) {
    client.on('debug', (m: string) => logger.info('[Discord][debug]', { m }));
  }

  // Watchdog: kalau event "ready" tak muncul dalam 30 detik, tampilkan kemungkinan penyebab.
  const readyWatchdog = setTimeout(() => {
    logger.warn(
      '[Boot] Bot login tapi belum "ready" setelah 30 detik. Kemungkinan penyebab: ' +
      '(1) IP host di-RATE LIMIT Discord (cek baris [Net] — kalau HTTP 429, jangan restart berulang, tunggu 30–60 menit lalu start sekali), ' +
      '(2) jaringan host tidak stabil / IPv6 bermasalah, ' +
      '(3) Node.js non-LTS (pakai Node 20/22), ' +
      '(4) Privileged Intents belum aktif, atau (5) token/invite bermasalah. ' +
      'Set env DISCORD_DEBUG=1 lalu restart untuk log detail tahap koneksi.'
    );
  }, 30_000);
  client.once('ready', () => clearTimeout(readyWatchdog));

  try {
    // Cek konektivitas dulu supaya masalah jaringan langsung kelihatan di log.
    await probeDiscordApi();

    logger.info('[Boot] Logging in to Discord...');
    await client.login(ENV.DISCORD_TOKEN);
    logger.info('[Boot] Login OK, menunggu event ready dari gateway...');
  } catch (err: any) {
    clearTimeout(readyWatchdog);
    const msg = String(err?.message || err);
    logger.error('[Boot] Discord login failed', { error: msg });
    if (/disallowed intents|used disallowed/i.test(msg)) {
      logger.error('[Boot] >> Aktifkan Privileged Intents (Server Members + Message Content) di Discord Developer Portal, lalu restart.');
    }
    process.exit(1);
  }
}

main().catch(err => {
  logger.error('[Boot] Fatal error', { error: err.message });
  process.exit(1);
});
