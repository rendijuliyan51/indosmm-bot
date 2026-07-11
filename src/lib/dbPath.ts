import path from 'path';
import { existsSync } from 'fs';
import { ENV } from '../config/env';

/**
 * Menemukan lokasi file database SQLite yang SEBENARNYA.
 *
 * Bug sebelumnya: backup mengecek `./dev.db` (relatif cwd), padahal tergantung cara Prisma
 * meresolusi `file:./dev.db`, file bisa berada di `prisma/dev.db`. Akibatnya backup mengecek
 * lokasi yang salah dan tidak pernah jalan. Helper ini mengecek beberapa kandidat lokasi dan
 * mengembalikan yang benar-benar ADA (sehingga backup pasti menemukan file yang tepat).
 *
 * Mengembalikan path absolut file DB yang ada; bila belum ada, mengembalikan kandidat utama.
 */
export function resolveDbFilePath(): string {
  const url = process.env.DATABASE_URL || ENV.DATABASE_URL || 'file:./dev.db';
  const filePart = url.startsWith('file:') ? url.slice('file:'.length) : url;
  const clean = filePart.replace(/^\.\//, '');

  const candidates = [
    path.resolve(filePart),               // relatif cwd, mis. /home/container/dev.db
    path.resolve('prisma', clean),        // relatif folder prisma/ (cara Prisma CLI resolve)
    path.resolve('./prisma/dev.db'),
    path.resolve('./dev.db'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

// Apakah file DB sudah ada di salah satu kandidat lokasi.
export function dbFileExists(): boolean {
  const p = resolveDbFilePath();
  return existsSync(p);
}
