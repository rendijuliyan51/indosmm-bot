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

async function registerCommands(): Promise<void> {
  logger.info('[Commands] Registering slash commands...');
  const commands = [
    new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Kelola ticket kamu')
      .addSubcommand((s: SlashCommandSubcommandBuilder) =>
        s.setName('status').setDescription('Lihat status ticket aktif')
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
        s.setName('audit-log').setDescription('Lihat audit log admin')
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ timeout: 15000 }).setToken(ENV.DISCORD_TOKEN);

  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) {
    logger.warn('[Commands] Bot belum berada di guild manapun — command tidak didaftarkan. Undang bot ke server lalu restart.');
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
}

// Salin file database SEBELUM migrasi sebagai jaring pengaman. Kalau migrasi bermasalah,
// admin masih punya salinan data (tiket/order) yang bisa dipulihkan. Hanya untuk SQLite lokal.
function backupDatabaseBeforeMigration(): void {
  try {
    const url = process.env.DATABASE_URL || ENV.DATABASE_URL;
    if (!url.startsWith('file:')) return;

    const dbPath = path.resolve(url.slice('file:'.length));
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
  `CREATE TABLE IF NOT EXISTS "Service" ("id" TEXT NOT NULL PRIMARY KEY, "provider_name" TEXT NOT NULL, "provider_service_id" TEXT NOT NULL UNIQUE, "category" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "description_override" TEXT, "min" INTEGER NOT NULL, "max" INTEGER NOT NULL DEFAULT 0, "price_buy" REAL NOT NULL DEFAULT 0, "price_sell" REAL NOT NULL DEFAULT 0, "markup_type" TEXT NOT NULL DEFAULT 'percentage', "markup_value" REAL NOT NULL DEFAULT 40, "refill" INTEGER NOT NULL DEFAULT 0, "refill_days" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "last_synced_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
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
];

// Kolom baru untuk DB LAMA yang tabelnya sudah ada. ALTER gagal "duplicate column name"
// bila kolom sudah ada — itu diabaikan (idempoten).
const ADD_COLUMN_STATEMENTS: string[] = [
  `ALTER TABLE "Service" ADD COLUMN "description_override" TEXT`,
  `ALTER TABLE "Ticket" ADD COLUMN "delete_channel_at" DATETIME`,
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

    try { await runRecovery(client); } catch (e: any) { logger.error('[Boot] Recovery failed', { error: e.message }); }
    // Segera bersihkan channel yang jatuh tempo hapus saat bot mati, dan sinkronkan status
    // order aktif langsung (jangan menunggu interval 60 detik) agar tidak "amnesia" pasca-restart.
    try { await runTicketChannelSweeper(client); } catch (e: any) { logger.error('[Boot] ChannelSweeper failed', { error: e.message }); }
    try { await runOrderStatusCheck(client); } catch (e: any) { logger.error('[Boot] OrderStatus initial failed', { error: e.message }); }
    try { await runServiceSync(); } catch (e: any) { logger.error('[Boot] ServiceSync failed', { error: e.message }); }
    try { await runCatalogUpdate(client); } catch (e: any) { logger.error('[Boot] Catalog failed', { error: e.message }); }
    try { await checkBalance(); } catch (e: any) { logger.error('[Boot] Balance check failed', { error: e.message }); }
    try { await runDatabaseBackup(); } catch (e: any) { logger.error('[Boot] Backup failed', { error: e.message }); }
    try { scheduleBackup(); } catch (e: any) { logger.error('[Boot] Schedule backup failed', { error: e.message }); }

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
    }, 60 * 60 * 1000);

    logger.info('[Boot] All workers started');
  });

  client.on('guildMemberRemove', async (member) => {
    try { await handleMemberLeave(client, member as GuildMember); } catch (e: any) { logger.error('[Event] MemberLeave failed', { error: e.message }); }
  });

  client.on('interactionCreate', handleInteraction);

  // Tangkap bukti pembayaran (gambar) yang diupload user di channel ticket.
  client.on('messageCreate', handleMessageCreate);

  // Diagnostik koneksi: bila bot "nyangkut" setelah login, listener ini menampilkan sebabnya
  // (mis. intent bermasalah / gateway putus) sehingga tidak diam tanpa info.
  client.on('error',          (e: any) => logger.error('[Discord] Client error', { error: e?.message }));
  client.on('shardError',     (e: any) => logger.error('[Discord] Shard error', { error: e?.message }));
  client.on('shardDisconnect', (ev: any, id: number) => logger.warn(`[Discord] Shard ${id} disconnected`, { code: ev?.code, reason: ev?.reason }));
  client.on('warn',           (m: string) => logger.warn('[Discord] Warn', { message: m }));

  // Watchdog: kalau event "ready" tak muncul dalam 30 detik, kemungkinan besar Privileged
  // Intents belum diaktifkan di Discord Developer Portal.
  const readyWatchdog = setTimeout(() => {
    logger.warn(
      '[Boot] Bot login tapi belum "ready" setelah 30 detik. ' +
      'Penyebab paling umum: PRIVILEGED INTENTS belum diaktifkan. ' +
      'Buka Discord Developer Portal → aplikasi bot → tab Bot → aktifkan ' +
      '"SERVER MEMBERS INTENT" dan "MESSAGE CONTENT INTENT", lalu restart bot. ' +
      'Bisa juga karena token salah atau bot belum diundang ke server.'
    );
  }, 30_000);
  client.once('ready', () => clearTimeout(readyWatchdog));

  try {
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
