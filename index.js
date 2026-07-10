/*
 * Bootstrap universal untuk hosting tanpa akses terminal (EnderCloud / Pterodactyl).
 *
 * File ini SENGAJA ditulis dengan JavaScript polos (bukan TypeScript) supaya bisa langsung
 * dijalankan dengan `node index.js` tanpa langkah build manual. Tugasnya:
 *   1. Pasang dependency bila node_modules belum ada (jaga-jaga host tidak menjalankan npm install)
 *   2. Generate Prisma Client
 *   3. Compile TypeScript -> dist/ (hanya bila perlu, agar restart tetap cepat)
 *   4. Menjalankan bot hasil compile (dist/index.js). Bot akan menjalankan `prisma db push`
 *      sendiri saat boot untuk menyinkronkan skema database.
 *
 * Dengan begitu, di panel EnderCloud cukup set startup command ke `node index.js`
 * (atau `npm start`) — semua kebutuhan install & build berjalan otomatis.
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Prisma CLI butuh DATABASE_URL saat generate. Beri default sqlite bila belum diset di panel.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';

function run(cmd) {
  console.log(`[bootstrap] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: process.env, cwd: __dirname });
}

// Jalankan CLI JavaScript lewat `node <file>`. Ini menghindari error "Permission denied"
// pada skrip di node_modules/.bin yang di sebagian host (mis. EnderCloud) kehilangan bit
// executable. Menjalankan lewat `node` tidak memerlukan bit executable pada skrip tersebut.
function runNode(argsArray, label) {
  console.log(`[bootstrap] $ node ${label || argsArray.join(' ')}`);
  execFileSync(process.execPath, argsArray, { stdio: 'inherit', env: process.env, cwd: __dirname });
}

function cliPath(pkg, ...rel) {
  return path.join(__dirname, 'node_modules', pkg, ...rel);
}

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch { /* ignore */ }
      }
    }
  }
  return newest;
}

function needsBuild() {
  const distEntry = path.join(__dirname, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) return true;
  const srcNewest = newestMtime(path.join(__dirname, 'src'));
  let distMtime = 0;
  try { distMtime = fs.statSync(distEntry).mtimeMs; } catch { return true; }
  // Rebuild hanya bila ada file src yang lebih baru dari hasil build.
  return srcNewest > distMtime;
}

try {
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    run('npm install');
  }

  // 1) Generate Prisma Client (idempoten, cepat) — via node agar aman dari "Permission denied".
  const prismaCli = cliPath('prisma', 'build', 'index.js');
  if (fs.existsSync(prismaCli)) runNode([prismaCli, 'generate'], 'prisma generate');
  else run('npx prisma generate');

  // 2) Compile TypeScript -> dist/ (hanya bila ada perubahan) — juga via node.
  if (needsBuild()) {
    const tscCli = cliPath('typescript', 'bin', 'tsc');
    if (fs.existsSync(tscCli)) runNode([tscCli], 'tsc');
    else run('npx tsc');
  } else {
    console.log('[bootstrap] dist/ sudah terbaru, lewati build.');
  }
} catch (e) {
  console.error('[bootstrap] Langkah setup gagal:', e && e.message);
  console.error('[bootstrap] Mencoba tetap menjalankan bot dari build yang ada...');
}

// Jalankan bot. dist/index.js akan menjalankan `prisma db push` untuk sinkron skema DB.
require('./dist/index.js');
