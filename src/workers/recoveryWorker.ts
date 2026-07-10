import { Client, TextChannel } from 'discord.js';
import { prisma } from '../bot/client';
import { logger } from '../lib/logger';
import { ENV } from '../config/env';
import { buildOrphanedEmbed, buildAdminPaymentNotif } from '../lib/embeds';

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

    // Pulihkan order yang "nyangkut" akibat restart di tengah proses approve.
    await recoverStuckOrders(client);

    logger.info('[Recovery] Recovery completed');
  } catch (err: any) {
    logger.error('[Recovery] Recovery worker failed', { error: err.message });
  }
}

/**
 * Order dengan status 'paid' TAPI belum punya provider_order_id berarti bot mati di antara
 * "pembayaran di-approve" dan "order terkirim ke provider". Order seperti ini tidak akan
 * dipoll oleh orderStatusWorker (statusnya bukan status aktif), sehingga bisa terlupakan.
 *
 * Kita TIDAK auto-resubmit (menghindari risiko order ganda bila ternyata order sudah dibuat
 * di provider tepat sebelum crash). Sebagai gantinya: reset pembayaran ke 'pending', set order
 * ke 'needs_review', lalu minta admin verifikasi manual di dashboard provider sebelum approve ulang.
 */
export async function recoverStuckOrders(client: Client): Promise<void> {
  try {
    const stuck = await prisma.order.findMany({
      where: { status: 'paid', provider_order_id: null },
    });
    if (stuck.length === 0) return;

    logger.warn(`[Recovery] Found ${stuck.length} stuck 'paid' order(s) needing review`);

    for (const order of stuck) {
      try {
        const ticket  = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });
        const service = await prisma.service.findUnique({ where: { id: order.service_id } });

        // Reset payment ke pending agar admin bisa approve ulang setelah verifikasi.
        const payment = await prisma.manualPayment.findFirst({
          where:   { ticket_id: order.ticket_id },
          orderBy: { created_at: 'desc' },
        });
        if (payment) {
          await prisma.manualPayment.update({
            where: { id: payment.id },
            data:  { status: 'pending', approved_by: null, approved_at: null },
          });
        }

        await prisma.order.update({
          where: { id: order.id },
          data: {
            status:     'needs_review',
            notes:      'Recovery: pembayaran approved tetapi order belum terkirim ke provider saat restart.',
            updated_at: new Date(),
          },
        });

        await prisma.orderLog.create({
          data: {
            order_id:   order.id,
            old_status: 'paid',
            new_status: 'needs_review',
            message:    'Flagged by recovery worker on boot (stuck paid order).',
          },
        });

        // Notif admin + tombol approve ulang, dengan peringatan jelas.
        const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
        if (adminChannel && ticket) {
          const { embed, row } = buildAdminPaymentNotif({
            ticketId:    ticket.id,
            userId:      ticket.discord_user_id,
            serviceName: service?.name || 'Unknown',
            total:       order.sell_price,
          });
          await adminChannel.send({
            content:
              '⚠️ **Order perlu verifikasi setelah restart.**\n' +
              'Cek dashboard provider dulu apakah order ini SUDAH dibuat.\n' +
              '• Jika **BELUM** → klik Approve untuk kirim ulang.\n' +
              '• Jika **SUDAH** → JANGAN approve (hindari order ganda), tangani manual.',
            embeds:     [embed],
            components: [row],
          });
        }

        // Notif user di ticket.
        if (ticket) {
          const ch = await client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
          if (ch) {
            await ch.send({
              content: `<@${ticket.discord_user_id}> ⏳ Pesananmu sedang diverifikasi ulang oleh admin setelah pemeliharaan sistem. Mohon tunggu sebentar ya.`,
            });
          }
        }

        logger.info(`[Recovery] Order ${order.id} flagged as needs_review`);
      } catch (e: any) {
        logger.error(`[Recovery] Failed to recover stuck order ${order.id}`, { error: e.message });
      }
    }
  } catch (err: any) {
    logger.error('[Recovery] recoverStuckOrders failed', { error: err.message });
  }
}
