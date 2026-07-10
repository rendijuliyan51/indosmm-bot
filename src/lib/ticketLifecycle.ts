import { prisma } from '../bot/client';

// Jeda default sebelum channel ticket dihapus, memberi waktu user membaca pesan penutup.
export const CHANNEL_DELETE_DELAY_MS = 5 * 60 * 1000;

/**
 * Menjadwalkan penghapusan channel ticket secara PERSISTEN.
 * Alih-alih setTimeout in-memory (hilang saat bot restart), kita simpan waktu targetnya
 * di kolom Ticket.delete_channel_at. Worker sweeper yang akan mengeksekusi penghapusan,
 * termasuk saat bot baru menyala kembali.
 */
export async function scheduleChannelDeletion(
  ticketId: string,
  delayMs: number = CHANNEL_DELETE_DELAY_MS,
): Promise<void> {
  await prisma.ticket.update({
    where: { id: ticketId },
    data:  { delete_channel_at: new Date(Date.now() + delayMs) },
  }).catch(() => {});
}
