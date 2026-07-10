import { Client, TextChannel } from 'discord.js';
import { prisma } from '../bot/client';
import { logger } from '../lib/logger';
import { ENV } from '../config/env';
import { buildOrphanedEmbed } from '../lib/embeds';

const ACTIVE_TICKET_STATUSES = ['open', 'waiting_payment', 'paid', 'processing'];

export async function runRecovery(client: Client): Promise<void> {
  logger.info('[Recovery] Starting recovery worker...');

  try {
    const tickets = await prisma.ticket.findMany({
      where: { status: { in: ACTIVE_TICKET_STATUSES } },
    });

    logger.info(`[Recovery] Found ${tickets.length} active tickets to verify`);

    for (const ticket of tickets) {
      try {
        const channel = await client.channels.fetch(ticket.ticket_channel_id).catch(() => null);

        if (!channel) {
          logger.warn(`[Recovery] Channel missing for ticket ${ticket.id}, marking orphaned`);

          await prisma.ticket.update({
            where: { id: ticket.id },
            data:  { status: 'orphaned' },
          });

          await prisma.order.updateMany({
            where: { ticket_id: ticket.id, status: { notIn: ['completed', 'cancelled', 'failed'] } },
            data:  { status: 'orphaned' },
          });

          // Notify admin
          try {
            const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
            if (adminChannel) {
              const embed = buildOrphanedEmbed({
                ticketId: ticket.id,
                userId:   ticket.discord_user_id,
                reason:   'Channel tidak ditemukan saat bot restart',
              });
              await adminChannel.send({ embeds: [embed] });
            }
          } catch (e) {
            logger.error('[Recovery] Failed to notify admin of orphaned ticket');
          }

          continue;
        }

        // Verify bot messages
        const botMessages = await prisma.botMessage.findMany({
          where: { ticket_id: ticket.id },
        });

        for (const bm of botMessages) {
          try {
            const textChannel = channel as TextChannel;
            const msg = await textChannel.messages.fetch(bm.message_id).catch(() => null);
            if (!msg) {
              logger.warn(`[Recovery] Message ${bm.message_id} missing for ticket ${ticket.id}`);
              await prisma.botMessage.update({
                where: { id: bm.id },
                data:  { message_type: `orphaned_${bm.message_type}` },
              });
            }
          } catch (e) {
            logger.error(`[Recovery] Failed to verify message ${bm.message_id}`);
          }
        }

        logger.info(`[Recovery] Ticket ${ticket.id} verified OK`);
      } catch (err: any) {
        logger.error(`[Recovery] Failed to process ticket ${ticket.id}`, { error: err.message });
      }
    }

    logger.info('[Recovery] Recovery completed');
  } catch (err: any) {
    logger.error('[Recovery] Recovery worker failed', { error: err.message });
  }
}
