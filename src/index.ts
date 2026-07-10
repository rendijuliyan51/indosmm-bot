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
import { execFileSync } from 'child_process';
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

async function initDatabase(): Promise<void> {
  // Sinkronkan skema database dari prisma/schema.prisma (satu-satunya sumber kebenaran).
  // Menggantikan CREATE TABLE manual yang rawan drift terhadap schema.prisma.
  // Pastikan DATABASE_URL tersedia untuk Prisma CLI.
  process.env.DATABASE_URL = process.env.DATABASE_URL || ENV.DATABASE_URL;

  // 1) Amankan data dulu (salin DB sebelum menyentuh skema).
  backupDatabaseBeforeMigration();

  // 2) Terapkan skema. --accept-data-loss WAJIB agar migrasi non-interaktif di server tidak
  //    GAGAL saat ada perubahan destruktif yang memang disengaja (mis. menghapus tabel usang
  //    'User' yang tidak terpakai). Perubahan pada tabel aktif (Ticket/Order/dll) bersifat
  //    ADITIF (hanya menambah kolom/tabel), sehingga data tiket & order TETAP AMAN.
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    stdio: 'inherit',
    env:   process.env,
  });

  logger.info('[DB] Schema synced via prisma db push');
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
