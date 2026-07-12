import { Client, TextChannel } from 'discord.js';
import { ENV } from '../config/env';
import { logger } from './logger';

export type NotifyChannel = 'dm' | 'admin_log' | 'failed';

/**
 * Kirim notifikasi ke user dengan FALLBACK berlapis, supaya notifikasi tidak "hilang" hanya
 * karena channel tiket sudah ditutup/dihapus atau DM user tertutup:
 *
 *   1) DM langsung ke user (paling personal).
 *   2) Kalau DM gagal (user menutup DM) → kirim ke CHANNEL ADMIN LOG sambil menandai (tag) user,
 *      agar admin tahu dan bisa meneruskan/menindaklanjuti secara manual.
 *
 * Mengembalikan channel mana yang berhasil dipakai (untuk logging/telemetri).
 */
export async function notifyUserWithFallback(
  client: Client,
  userId: string,
  payload: { content?: string; embeds?: any[] },
): Promise<NotifyChannel> {
  // 1) Coba DM.
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return 'dm';
  } catch (e: any) {
    logger.info(`[Notify] DM ke ${userId} gagal (mungkin DM ditutup) — fallback ke admin log`, { error: e?.message });
  }

  // 2) Fallback: channel admin log.
  try {
    const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
    if (adminChannel) {
      const prefix = `📨 **Notifikasi untuk <@${userId}>** (DM tidak bisa dikirim, mohon diteruskan):`;
      await adminChannel.send({
        content:         payload.content ? `${prefix}\n${payload.content}` : prefix,
        embeds:          payload.embeds,
        allowedMentions: { users: [userId] },
      });
      return 'admin_log';
    }
  } catch (e: any) {
    logger.warn('[Notify] Gagal kirim fallback ke admin log', { error: e?.message });
  }

  logger.warn(`[Notify] Tidak bisa mengirim notifikasi ke ${userId} (DM & admin log gagal)`);
  return 'failed';
}
