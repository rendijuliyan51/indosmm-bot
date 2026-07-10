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
});
