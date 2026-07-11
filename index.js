/*
 * Bootstrap universal untuk hosting tanpa akses terminal (EnderCloud / Pterodactyl).
 *
 * File ini SENGAJA ditulis dengan JavaScript polos (bukan TypeScript) supaya bisa langsung
 * dijalankan dengan `node index.js` tanpa langkah build manual. Tugasnya:
 *   1. Pasang dependency bila node_modules belum ada (jaga-jaga host tidak menjalankan npm install)
 *   2. Generate Prisma Client (lewat `node`, aman dari masalah permission node_modules/.bin)
 *   3. Compile TypeScript -> dist/ (SELALU, agar hasil deploy terbaru pasti terpakai)
 *   4. Menjalankan bot hasil compile (dist/index.js). Bot akan menyiapkan skema database
 *      sendiri saat boot (CREATE TABLE IF NOT EXISTS, idempoten).
 *
 * Di panel EnderCloud cukup set startup command ke `node index.js` (atau `npm start`).
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Utamakan IPv4 saat resolusi DNS (banyak host punya IPv6 rusak yang bikin koneksi menggantung).
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* Node lama: abaikan */ }

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

try {
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    run('npm install');
  }

  // 1) Generate Prisma Client (idempoten, cepat) — via node agar aman dari "Permission denied".
  const prismaCli = cliPath('prisma', 'build', 'index.js');
  if (fs.existsSync(prismaCli)) runNode([prismaCli, 'generate'], 'prisma generate');
  else run('npx prisma generate');

  // 2) Compile TypeScript -> dist/ SELALU. Build TypeScript bersifat incremental (cepat),
  //    dan ini menjamin kode terbaru hasil deploy benar-benar terpakai (bukan build lama).
  const tscCli = cliPath('typescript', 'bin', 'tsc');
  if (fs.existsSync(tscCli)) runNode([tscCli], 'tsc');
  else run('npx tsc');
} catch (e) {
  console.error('[bootstrap] Langkah setup gagal:', e && e.message);
  console.error('[bootstrap] Mencoba tetap menjalankan bot dari build yang ada...');
}

// Jalankan bot.
require('./dist/index.js');
