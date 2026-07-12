import { Client, TextChannel, GuildMember } from 'discord.js';
import { prisma } from '../bot/client';
import { logger } from '../lib/logger';
import { buildTicketClosedEmbed } from '../lib/embeds';
import { scheduleChannelDeletion } from '../lib/ticketLifecycle';
import { isRefillExpired } from '../lib/pricing';
import { ENV } from '../config/env';

async function closeAndDeleteTicket(
  client:    Client,
  ticketId:  string,
  channelId: string,
  reason:    string
): Promise<void> {
  try {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status:       'closed',
        closed_at:    new Date(),
        close_reason: reason,
      },
    });

    const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
    if (channel) {
      await channel.send({ embeds: [buildTicketClosedEmbed(reason)] });
    }
    // Jadwalkan penghapusan channel secara persisten (tahan restart).
    await scheduleChannelDeletion(ticketId);

    logger.info(`[TicketGarbage] Closed ticket ${ticketId}: ${reason}`);
  } catch (err: any) {
    logger.error(`[TicketGarbage] Failed to close ticket ${ticketId}`, { error: err.message });
  }
}

/**
 * Sweeper penghapusan channel ticket yang PERSISTEN.
 * Memproses semua ticket yang delete_channel_at-nya sudah lewat (termasuk yang jatuh tempo
 * saat bot mati). Dijalankan saat boot dan berkala, menggantikan setTimeout in-memory.
 */
export async function runTicketChannelSweeper(client: Client): Promise<void> {
  try {
    const now = new Date();
    const due = await prisma.ticket.findMany({
      where: { delete_channel_at: { lte: now } },
    });

    for (const ticket of due) {
      try {
        const channel = await client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
        if (channel) {
          await channel.delete().catch(() => {});
        }
        await prisma.ticket.update({
          where: { id: ticket.id },
          data:  { delete_channel_at: null, archived_at: now },
        });
        logger.info(`[ChannelSweeper] Deleted channel for ticket ${ticket.id}`);
      } catch (err: any) {
        logger.error(`[ChannelSweeper] Failed for ticket ${ticket.id}`, { error: err.message });
      }
    }
  } catch (err: any) {
    logger.error('[ChannelSweeper] Worker failed', { error: err.message });
  }
}

export async function runTicketGarbageCollector(client: Client): Promise<void> {
  try {
    const now = new Date();

    // 1. Tutup ticket completed yang no-refill
    const completedOrders = await prisma.order.findMany({
      where: {
        status:        'completed',
        refill_status: { not: 'closed' },
      },
    });

    // Refill sekarang DECOUPLED dari channel tiket (bisa diklaim lewat /order refill walau tiket
    // sudah ditutup). Jadi tiket TIDAK perlu dibiarkan terbuka selama masa garansi. Kita tutup
    // semua tiket yang ordernya sudah selesai, setelah grace period agar pembeli sempat membaca
    // notif & memberi rating.
    const graceMs = Math.max(0, ENV.TICKET_AUTOCLOSE_HOURS) * 60 * 60 * 1000;

    for (const order of completedOrders) {
      const ticket = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });

      // Tiket sudah tidak aktif → cukup tandai order agar tidak diproses ulang.
      if (!ticket || ['closed', 'cancelled', 'orphaned'].includes(ticket.status)) {
        await prisma.order.update({
          where: { id: order.id },
          data:  { refill_status: 'closed' },
        }).catch(() => {});
        continue;
      }

      // Tunggu grace period sejak order selesai (order.updated_at) sebelum menutup.
      const completedAt = order.updated_at.getTime();
      if (graceMs > 0 && (now.getTime() - completedAt) < graceMs) continue;

      const service = await prisma.service.findUnique({ where: { id: order.service_id } });
      const stillGuaranteed = Boolean(service?.refill) && !isRefillExpired(order.refill_expires_at);
      const reason = stillGuaranteed
        ? 'Order selesai. Garansi/refill masih aktif — klaim kapan saja lewat `/order refill` dengan ID order kamu.'
        : 'Order selesai.';

      await closeAndDeleteTicket(client, ticket.id, ticket.ticket_channel_id, reason);
      await prisma.order.update({
        where: { id: order.id },
        data:  { refill_status: 'closed' },
      });
    }

    // 2. Cleanup ServiceSnapshot lebih dari 24 jam
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const deleted   = await prisma.serviceSnapshot.deleteMany({
      where: { fetched_at: { lt: oneDayAgo } },
    });
    if (deleted.count > 0) {
      logger.info(`[TicketGarbage] Cleaned ${deleted.count} old service snapshots`);
    }

    // 3. Cleanup log lebih dari 7 hari
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deletedLogs  = await prisma.orderLog.deleteMany({
      where: { created_at: { lt: sevenDaysAgo } },
    });
    if (deletedLogs.count > 0) {
      logger.info(`[TicketGarbage] Cleaned ${deletedLogs.count} old order logs`);
    }

  } catch (err: any) {
    logger.error('[TicketGarbage] Worker failed', { error: err.message });
  }
}

export async function handleMemberLeave(client: Client, member: GuildMember): Promise<void> {
  try {
    const tickets = await prisma.ticket.findMany({
      where: {
        discord_user_id: member.id,
        status: { notIn: ['closed', 'cancelled', 'orphaned'] },
      },
    });

    for (const ticket of tickets) {
      const activeOrder = await prisma.order.findFirst({
        where: {
          ticket_id: ticket.id,
          status:    { in: ['completed', 'processing', 'submitted', 'pending'] },
        },
      });

      if (!activeOrder) continue;

      const hasActiveGuarantee = activeOrder.refill_expires_at && activeOrder.refill_expires_at > new Date();
      const reason = hasActiveGuarantee
        ? 'Member keluar server — garansi hangus otomatis.'
        : 'Member keluar server.';

      await closeAndDeleteTicket(client, ticket.id, ticket.ticket_channel_id, reason);

      if (activeOrder.provider_order_id) {
        await prisma.order.update({
          where: { id: activeOrder.id },
          data:  { refill_status: 'cancelled' },
        });
      }

      // Notif admin
      try {
        const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
        if (adminChannel) {
          await adminChannel.send({
            content:
              `⚠️ **Member keluar server!**\n` +
              `👤 ${member.user.tag} (${member.id})\n` +
              `🎫 Ticket \`${ticket.id.slice(0, 8)}\` otomatis ditutup.\n` +
              `${reason}`,
          });
        }
      } catch (e) {}
    }
  } catch (err: any) {
    logger.error('[MemberLeave] Failed', { error: err.message });
  }
}
