import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { ENV } from '../config/env';

// Ambil path file DB dari DATABASE_URL (format sqlite: "file:./dev.db").
function resolveDbPath(): string {
  const url = ENV.DATABASE_URL || 'file:./dev.db';
  const filePart = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.resolve(filePart);
}

const DB_PATH     = resolveDbPath();
const BACKUP_DIR  = path.resolve('./backups');
const MAX_BACKUPS = 7;
// WIB adalah UTC+7 tetap (tanpa DST).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

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
