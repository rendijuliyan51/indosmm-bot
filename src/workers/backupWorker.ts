import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { resolveDbFilePath } from '../lib/dbPath';

const BACKUP_DIR  = path.resolve('./backups');
const MAX_BACKUPS = 7;
// WIB adalah UTC+7 tetap (tanpa DST).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export async function runDatabaseBackup(): Promise<void> {
  try {
    // Resolusi path DB SAAT backup (bukan saat modul dimuat), dan cari lokasi file yang benar.
    const dbPath = resolveDbFilePath();
    if (!existsSync(dbPath)) {
      logger.warn('[Backup] File DB belum ada, backup dilewati', { dbPath });
      return;
    }

    await fs.mkdir(BACKUP_DIR, { recursive: true });

    const now     = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).replace(/[/:, ]/g, '-').replace(/-+/g, '-');

    const backupPath = path.join(BACKUP_DIR, `dev.db.backup.${now}`);

    await fs.copyFile(dbPath, backupPath);
    logger.info(`[Backup] Database backed up to ${backupPath} (dari ${dbPath})`);

    // Hapus backup lama, simpan hanya MAX_BACKUPS terakhir
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files
      .filter(f => f.startsWith('dev.db.backup.'))
      .sort();

    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(0, backups.length - MAX_BACKUPS);
      for (const file of toDelete) {
        await fs.unlink(path.join(BACKUP_DIR, file));
        logger.info(`[Backup] Deleted old backup: ${file}`);
      }
    }

  } catch (err: any) {
    logger.error('[Backup] Database backup failed', { error: err.message });
  }
}

// Jadwalkan backup jam 00.00 WIB.
// Dihitung murni dari epoch UTC + offset WIB tetap agar tidak bergantung timezone server.
export function scheduleBackup(): void {
  const msUntilMidnight = msUntilNextWibMidnight();

  logger.info(`[Backup] Next backup scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  setTimeout(() => {
    runDatabaseBackup();
    setInterval(runDatabaseBackup, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

export function msUntilNextWibMidnight(nowMs: number = Date.now()): number {
  // Geser ke "wall clock" WIB, lalu cari sisa waktu menuju batas hari berikutnya.
  const wibMs        = nowMs + WIB_OFFSET_MS;
  const msIntoWibDay = ((wibMs % 86_400_000) + 86_400_000) % 86_400_000;
  return 86_400_000 - msIntoWibDay;
}
