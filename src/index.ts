import 'dotenv/config';
import { ENV } from './config/env';
import { logger } from './lib/logger';
import { client, prisma } from './bot/client';
import { handleInteraction } from './bot/handlers/interactionCreate';
import { runRecovery } from './workers/recoveryWorker';
import { runServiceSync } from './workers/serviceSyncWorker';
import { runOrderStatusCheck } from './workers/orderStatusWorker';
import { runCatalogUpdate } from './workers/catalogWorker';
import { runTicketGarbageCollector, handleMemberLeave } from './workers/ticketGarbageWorker';
import { runDatabaseBackup, scheduleBackup } from './workers/backupWorker';
import { REST, Routes, SlashCommandBuilder, SlashCommandSubcommandBuilder, GuildMember, TextChannel } from 'discord.js';
import { indosmm } from './providers/indosmm';
import { buildLowBalanceNotif } from './lib/embeds';

const LOW_BALANCE_THRESHOLD = 50000;

async function checkBalance(): Promise<void> {
  try {
    const balance = await indosmm.getBalance();
    if (balance < LOW_BALANCE_THRESHOLD) {
      const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
      if (adminChannel) await adminChannel.send({ embeds: [buildLowBalanceNotif(balance, LOW_BALANCE_THRESHOLD)] });
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
        s.setName('audit-log').setDescription('Lihat audit log admin')
      ),
  ].map(c => c.toJSON());

  // Gunakan token langsung dari client yang sudah login
  const rest = new REST({ timeout: 15000 }).setToken(ENV.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(ENV.DISCORD_CLIENT_ID, client.guilds.cache.first()!.id),
    { body: commands }
  );
  logger.info('[Commands] Slash commands registered successfully');
}

async function initDatabase(): Promise<void> {
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "User" ("id" TEXT NOT NULL PRIMARY KEY, "discord_user_id" TEXT NOT NULL UNIQUE, "username" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'user', "balance" REAL NOT NULL DEFAULT 0, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "Service" ("id" TEXT NOT NULL PRIMARY KEY, "provider_name" TEXT NOT NULL, "provider_service_id" TEXT NOT NULL UNIQUE, "category" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "min" INTEGER NOT NULL, "max" INTEGER NOT NULL DEFAULT 0, "price_buy" REAL NOT NULL DEFAULT 0, "price_sell" REAL NOT NULL DEFAULT 0, "markup_type" TEXT NOT NULL DEFAULT 'percentage', "markup_value" REAL NOT NULL DEFAULT 40, "refill" INTEGER NOT NULL DEFAULT 0, "refill_days" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "last_synced_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "ServiceSnapshot" ("id" TEXT NOT NULL PRIMARY KEY, "service_id" TEXT NOT NULL, "raw_json" TEXT NOT NULL, "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "CatalogMessage" ("id" TEXT NOT NULL PRIMARY KEY, "guild_id" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "message_id" TEXT, "message_type" TEXT NOT NULL DEFAULT 'catalog', "last_hash" TEXT, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "Ticket" ("id" TEXT NOT NULL PRIMARY KEY, "discord_user_id" TEXT NOT NULL, "guild_id" TEXT NOT NULL, "ticket_channel_id" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL DEFAULT 'open', "subject" TEXT NOT NULL, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "closed_at" DATETIME, "archived_at" DATETIME, "closed_by" TEXT, "close_reason" TEXT)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "Order" ("id" TEXT NOT NULL PRIMARY KEY, "ticket_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "service_id" TEXT NOT NULL, "provider_order_id" TEXT, "target_link" TEXT NOT NULL, "quantity" INTEGER NOT NULL, "buy_price" REAL NOT NULL, "sell_price" REAL NOT NULL, "profit" REAL NOT NULL, "status" TEXT NOT NULL DEFAULT 'waiting_payment', "start_count" INTEGER, "remains" INTEGER, "refill_status" TEXT, "refill_expires_at" DATETIME, "notes" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "OrderLog" ("id" TEXT NOT NULL PRIMARY KEY, "order_id" TEXT NOT NULL, "old_status" TEXT, "new_status" TEXT NOT NULL, "message" TEXT, "raw_response_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "ManualPayment" ("id" TEXT NOT NULL PRIMARY KEY, "user_id" TEXT NOT NULL, "ticket_id" TEXT NOT NULL, "amount" REAL NOT NULL, "method" TEXT NOT NULL DEFAULT 'qris', "proof_url" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "approved_by" TEXT, "approved_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "BotMessage" ("id" TEXT NOT NULL PRIMARY KEY, "ticket_id" TEXT NOT NULL, "message_type" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "message_id" TEXT NOT NULL, "last_hash" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "ProviderSyncLog" ("id" TEXT NOT NULL PRIMARY KEY, "provider_name" TEXT NOT NULL, "status" TEXT NOT NULL, "message" TEXT, "raw_response_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "AdminAuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "actor_user_id" TEXT NOT NULL, "action" TEXT NOT NULL, "target_type" TEXT, "target_id" TEXT, "details_json" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS "RefillRequest" ("id" TEXT NOT NULL PRIMARY KEY, "order_id" TEXT NOT NULL, "ticket_id" TEXT NOT NULL, "provider_refill_id" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "requested_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" DATETIME, "notes" TEXT)`;
  logger.info('[DB] All tables initialized');
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

    setInterval(async () => {
      try { await checkBalance(); } catch (e: any) { logger.error('[Worker] Balance failed', { error: e.message }); }
    }, 60 * 60 * 1000);

    logger.info('[Boot] All workers started');
  });

  client.on('guildMemberRemove', async (member) => {
    try { await handleMemberLeave(client, member as GuildMember); } catch (e: any) { logger.error('[Event] MemberLeave failed', { error: e.message }); }
  });

  client.on('interactionCreate', handleInteraction);

  try {
    logger.info('[Boot] Logging in to Discord...');
    await client.login(ENV.DISCORD_TOKEN);
  } catch (err: any) {
    logger.error('[Boot] Discord login failed', { error: err.message });
    process.exit(1);
  }
}

main().catch(err => {
  logger.error('[Boot] Fatal error', { error: err.message });
  process.exit(1);
});
