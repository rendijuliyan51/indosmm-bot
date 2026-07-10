import { Client, TextChannel, GuildMember } from 'discord.js';
import { prisma } from '../bot/client';
import { logger } from '../lib/logger';
import { buildTicketClosedEmbed } from '../lib/embeds';
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
      setTimeout(async () => {
        await channel.delete().catch(() => {});
      }, 5 * 60 * 1000);
    }

    logger.info(`[TicketGarbage] Closed ticket ${ticketId}: ${reason}`);
  } catch (err: any) {
    logger.error(`[TicketGarbage] Failed to close ticket ${ticketId}`, { error: err.message });
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

    for (const order of completedOrders) {
      const service = await prisma.service.findUnique({ where: { id: order.service_id } });
      const ticket  = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });

      if (!ticket || ['closed', 'cancelled', 'orphaned'].includes(ticket.status)) continue;

      // No refill → tutup langsung setelah completed
      if (!service?.refill || service.refill_days === 0) {
        await closeAndDeleteTicket(client, ticket.id, ticket.ticket_channel_id, 'Order selesai.');
        await prisma.order.update({
          where: { id: order.id },
          data:  { refill_status: 'closed' },
        });
        continue;
      }

      // Ada refill tapi sudah expired → tutup
      if (order.refill_expires_at && order.refill_expires_at < now) {
        await closeAndDeleteTicket(client, ticket.id, ticket.ticket_channel_id, 'Masa garansi telah berakhir.');
        await prisma.order.update({
          where: { id: order.id },
          data:  { refill_status: 'closed' },
        });
      }
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
