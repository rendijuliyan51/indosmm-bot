import { Client, TextChannel } from 'discord.js';
import { prisma } from '../bot/client';
import { indosmm } from '../providers/indosmm';
import { logger } from '../lib/logger';
import {
  buildOrderProgressEmbed,
  buildOrderActionRow,
  buildOrderCompletedNotif,
  buildOrderFailedNotif,
  buildReviewButtonRow,
} from '../lib/embeds';
import { isRefillExpired } from '../lib/pricing';

const ACTIVE_STATUSES = ['submitted', 'processing', 'partial', 'pending', 'in progress'];

// Cegah dua run tumpang tindih (mis. saat banyak order membuat satu run > 60 detik).
let statusCheckRunning = false;

// Kirim DM ke user (best-effort). Kalau DM user tertutup, cukup catat warning.
async function dmUser(client: Client, userId: string, payload: any): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
  } catch (e: any) {
    logger.info(`[DM] Tidak bisa kirim DM ke ${userId} (mungkin DM ditutup)`, { error: e?.message });
  }
}

function buildProgressBar(quantity: number, remains: number): string {
  const done    = Math.max(0, quantity - remains);
  const percent = Math.min(100, Math.round((done / quantity) * 100));
  const filled  = Math.round(percent / 5);
  const empty   = 20 - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent}%`;
}

export async function runOrderStatusCheck(client: Client): Promise<void> {
  if (statusCheckRunning) {
    logger.info('[OrderStatus] Previous run masih berjalan, dilewati.');
    return;
  }
  statusCheckRunning = true;
  try {
    const orders = await prisma.order.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
    });

    if (orders.length === 0) return;
    logger.info(`[OrderStatus] Checking ${orders.length} active orders`);

    for (const order of orders) {
      if (!order.provider_order_id) continue;

      try {
        const res = await indosmm.getOrderStatus(order.provider_order_id);
        if (res.error) {
          logger.warn(`[OrderStatus] Provider error for order ${order.id}: ${res.error}`);
          continue;
        }

        const newStatus  = (res.status ?? order.status).toLowerCase().trim();
        const remains    = res.remains    ? parseInt(res.remains)     : order.remains;
        const startCount = res.start_count ? parseInt(res.start_count) : order.start_count;

        const statusChanged  = newStatus !== order.status.toLowerCase().trim();
        const remainsChanged = remains !== order.remains;

        if (!statusChanged && !remainsChanged) continue;

        const updated = await prisma.order.update({
          where: { id: order.id },
          data: {
            status:      newStatus,
            remains:     remains,
            start_count: startCount,
            updated_at:  new Date(),
          },
        });

        if (statusChanged) {
          await prisma.orderLog.create({
            data: {
              order_id:          order.id,
              old_status:        order.status,
              new_status:        newStatus,
              message:           `Status: ${order.status} → ${newStatus}`,
              raw_response_json: JSON.stringify(res),
            },
          });
          logger.info(`[OrderStatus] Order ${order.id}: ${order.status} → ${newStatus}`);
        }

        // Update embed di ticket
        const botMsg = await prisma.botMessage.findFirst({
          where: { ticket_id: order.ticket_id, message_type: 'order_progress' },
        });
        if (!botMsg) continue;

        const channel = await client.channels.fetch(botMsg.channel_id).catch(() => null) as TextChannel | null;
        if (!channel) continue;

        const msg = await channel.messages.fetch(botMsg.message_id).catch(() => null);
        if (!msg) continue;

        const service = await prisma.service.findUnique({ where: { id: order.service_id } });
        if (!service) continue;

        const ticket = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });
        if (!ticket) continue;

        const progressBar = (remains != null && startCount != null && order.quantity > 0)
          ? buildProgressBar(order.quantity, remains)
          : null;

        const refillExpired = isRefillExpired(updated.refill_expires_at);

        const embed = buildOrderProgressEmbed({
          orderId:         order.id,
          serviceName:     service.name,
          category:        service.category,
          targetLink:      order.target_link,
          quantity:        order.quantity,
          total:           order.sell_price,
          status:          newStatus,
          startCount:      startCount,
          remains:         remains,
          progressBar:     progressBar,
          refillExpiresAt: updated.refill_expires_at,
          providerOrderId: order.provider_order_id,
          createdAt:       order.created_at,
        });

        const row = buildOrderActionRow({
          ticketId:       order.ticket_id,
          supportsRefill: service.refill,
          refillExpired:  refillExpired,
          status:         newStatus,
        });

        const components = row.components.length > 0 ? [row] : [];
        await msg.edit({ embeds: [embed], components });

        // Notif user kalau completed (di ticket + DM), plus tombol beri rating.
        if (statusChanged && newStatus === 'completed') {
          const completedEmbed = buildOrderCompletedNotif({
            userId:      ticket.discord_user_id,
            serviceName: service.name,
            category:    service.category,
            quantity:    order.quantity,
          });
          const reviewRow = buildReviewButtonRow(order.id);
          await channel.send({
            content:    `<@${ticket.discord_user_id}>`,
            embeds:     [completedEmbed],
            components: [reviewRow],
          });
          // DM notifikasi (tanpa tombol, sekadar pemberitahuan).
          await dmUser(client, ticket.discord_user_id, { embeds: [completedEmbed] });

          // Update ticket status
          await prisma.ticket.update({
            where: { id: order.ticket_id },
            data:  { status: 'completed' },
          });
        }

        // Notif user kalau failed (di ticket + DM).
        if (statusChanged && (newStatus === 'failed' || newStatus === 'error')) {
          const failedEmbed = buildOrderFailedNotif({
            userId:      ticket.discord_user_id,
            serviceName: service.name,
            reason:      res.error || 'Order gagal diproses oleh provider.',
          });
          await channel.send({
            content: `<@${ticket.discord_user_id}>`,
            embeds:  [failedEmbed],
          });
          await dmUser(client, ticket.discord_user_id, { embeds: [failedEmbed] });
        }

      } catch (err: any) {
        logger.error(`[OrderStatus] Failed order ${order.id}`, { error: err.message });
      }
    }

    // Poll refill status
    await checkRefillStatuses(client);

  } catch (err: any) {
    logger.error('[OrderStatus] Worker failed', { error: err.message });
  } finally {
    statusCheckRunning = false;
  }
}

async function checkRefillStatuses(client: Client): Promise<void> {
  try {
    const pendingRefills = await prisma.refillRequest.findMany({
      where: { status: 'pending', provider_refill_id: { not: null } },
    });

    for (const refill of pendingRefills) {
      try {
        if (!refill.provider_refill_id) continue;

        // Gunakan endpoint refill_status (bukan status order) dengan refill ID.
        const res = await indosmm.getRefillStatus(refill.provider_refill_id);
        if (!res || res.error) continue;

        const newStatus = (res.status ?? '').toLowerCase().trim();
        if (!newStatus || newStatus === refill.status) continue;

        await prisma.refillRequest.update({
          where: { id: refill.id },
          data: {
            status:       newStatus,
            completed_at: newStatus === 'completed' ? new Date() : null,
          },
        });

        // Notif ke ticket
        const ticket = await prisma.ticket.findUnique({ where: { id: refill.ticket_id } });
        if (!ticket) continue;

        const channel = await client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
        if (!channel) continue;

        if (newStatus === 'completed') {
          await channel.send({
            content: `<@${ticket.discord_user_id}> ♻️ Refill kamu sudah selesai! Silakan cek akun kamu.`,
          });
        }

        logger.info(`[RefillStatus] Refill ${refill.id}: ${refill.status} → ${newStatus}`);
      } catch (err: any) {
        logger.error(`[RefillStatus] Failed refill ${refill.id}`, { error: err.message });
      }
    }
  } catch (err: any) {
    logger.error('[RefillStatus] Worker failed', { error: err.message });
  }
}
