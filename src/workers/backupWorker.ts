import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../lib/logger';

const DB_PATH     = path.resolve('./dev.db');
const BACKUP_DIR  = path.resolve('./backups');
const MAX_BACKUPS = 7;

export async function runDatabaseBackup(): Promise<void> {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    const now     = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).replace(/[/:, ]/g, '-').replace(/-+/g, '-');

    const backupPath = path.join(BACKUP_DIR, `dev.db.backup.${now}`);

    await fs.copyFile(DB_PATH, backupPath);
    logger.info(`[Backup] Database backed up to ${backupPath}`);

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

// Jadwalkan backup jam 00.00 WIB
export function scheduleBackup(): void {
  const now     = new Date();
  const wibNow  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const nextRun = new Date(wibNow);

  nextRun.setHours(0, 0, 0, 0);
  if (nextRun <= wibNow) nextRun.setDate(nextRun.getDate() + 1);

  const msUntilMidnight = nextRun.getTime() - wibNow.getTime();

  logger.info(`[Backup] Next backup scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  setTimeout(() => {
    runDatabaseBackup();
    setInterval(runDatabaseBackup, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}
