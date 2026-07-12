import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/env';

export const prisma = new PrismaClient({
  datasourceUrl: ENV.DATABASE_URL,
});

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // MessageContent (privileged) diperlukan untuk membaca lampiran bukti pembayaran
    // yang diupload user di channel ticket (lihat handler messageCreate).
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
  // Konfigurasi REST lebih "sopan" terhadap rate limit Discord:
  // - offset: tambah buffer 250ms pada perhitungan reset bucket agar tidak menembak tepat di
  //   batas (menghindari 429 karena selisih jam antara host & Discord).
  // - timeout: 20s supaya request lambat tidak menggantung terlalu lama.
  // - retries: batasi retry otomatis (429 sudah ditangani antrian internal discord.js yang
  //   menghormati Retry-After; retry berlebih hanya menambah beban saat sedang dibatasi).
  rest: {
    offset:  250,
    timeout: 20_000,
    retries: 2,
  },
});
