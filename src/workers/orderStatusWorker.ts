import { Client, TextChannel } from 'discord.js';
import { prisma } from '../bot/client';
import { indosmm } from '../providers/indosmm';
import { logger } from '../lib/logger';
import {
  buildOrderProgressEmbed,
  buildOrderActionRow,
  buildOrderCompletedNotif,
  buildOrderFailedNotif,
  buildOrderCanceledNotif,
  buildAdminOrderCanceledAlert,
  buildReviewButtonRow,
} from '../lib/embeds';
import { isRefillExpired } from '../lib/pricing';
import { notifyUserWithFallback } from '../lib/notify';
import { scheduleChannelDeletion } from '../lib/ticketLifecycle';
import { ENV } from '../config/env';

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
      const providerOrderId = order.provider_order_id; // string terjamin (dipakai lintas await)

      try {
        const res = await indosmm.getOrderStatus(providerOrderId);
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

        // Ambil data yang dibutuhkan untuk notifikasi & update status tiket.
        const service = await prisma.service.findUnique({ where: { id: order.service_id } });
        const ticket  = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });

        // Update embed progress di channel tiket (BEST-EFFORT). Kalau channel/pesan sudah tidak
        // ada (mis. tiket sudah ditutup), JANGAN berhenti — status terminal seperti canceled/
        // failed tetap wajib memberi tahu pembeli & admin serta menutup tiket.
        const botMsg = await prisma.botMessage.findFirst({
          where: { ticket_id: order.ticket_id, message_type: 'order_progress' },
        });
        const channel = botMsg
          ? (await client.channels.fetch(botMsg.channel_id).catch(() => null)) as TextChannel | null
          : null;
        const msg = (botMsg && channel)
          ? await channel.messages.fetch(botMsg.message_id).catch(() => null)
          : null;

        if (msg && service) {
          const progressBar = (remains != null && startCount != null && order.quantity > 0)
            ? buildProgressBar(order.quantity, remains)
            : null;

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
            serviceId:       service.provider_service_id,
            ticketId:        order.ticket_id,
          });

          const row = buildOrderActionRow({
            ticketId:       order.ticket_id,
            supportsRefill: service.refill,
            refillExpired:  isRefillExpired(updated.refill_expires_at),
            status:         newStatus,
          });

          const components = row.components.length > 0 ? [row] : [];
          await msg.edit({ embeds: [embed], components }).catch(() => {});
        }

        // Tanpa data tiket, pembeli tidak bisa diberi tahu — lewati sisanya.
        if (!ticket) continue;
        const serviceName = service?.name ?? 'Layanan';

        // === COMPLETED === (notif di tiket bila ada + DM, plus tombol beri rating)
        if (statusChanged && newStatus === 'completed') {
          const completedEmbed = buildOrderCompletedNotif({
            userId:          ticket.discord_user_id,
            serviceName:     serviceName,
            category:        service?.category ?? '',
            quantity:        order.quantity,
            orderId:         order.id,
            refillSupported: Boolean(service?.refill),
            refillExpiresAt: updated.refill_expires_at,
          });
          const reviewRow = buildReviewButtonRow(order.id);
          if (channel) {
            await channel.send({
              content:    `<@${ticket.discord_user_id}>`,
              embeds:     [completedEmbed],
              components: [reviewRow],
            }).catch(() => {});
          }
          await dmUser(client, ticket.discord_user_id, { embeds: [completedEmbed] });

          await prisma.ticket.update({
            where: { id: order.ticket_id },
            data:  { status: 'completed' },
          });
        }

        // === FAILED / ERROR ===
        if (statusChanged && (newStatus === 'failed' || newStatus === 'error')) {
          const failedEmbed = buildOrderFailedNotif({
            userId:      ticket.discord_user_id,
            serviceName: serviceName,
            reason:      res.error || 'Order gagal diproses oleh provider.',
          });
          if (channel) {
            await channel.send({
              content: `<@${ticket.discord_user_id}>`,
              embeds:  [failedEmbed],
            }).catch(() => {});
          }
          await dmUser(client, ticket.discord_user_id, { embeds: [failedEmbed] });
        }

        // === CANCELED (dibatalkan PROVIDER) ===
        // Kebijakan: TIDAK ada refund — order diganti dengan layanan baru. Beri tahu pembeli &
        // admin, lalu tutup tiket (channel dihapus ~5 menit lagi) agar bisa lanjut ke pergantian.
        if (statusChanged && (newStatus === 'canceled' || newStatus === 'cancelled')) {
          const canceledEmbed = buildOrderCanceledNotif({
            userId:      ticket.discord_user_id,
            serviceName: serviceName,
            orderId:     order.id,
          });

          // Beri tahu pembeli: di channel (best-effort) + DM dengan fallback ke admin log.
          if (channel) {
            await channel.send({
              content: `<@${ticket.discord_user_id}>`,
              embeds:  [canceledEmbed],
            }).catch(() => {});
          }
          await notifyUserWithFallback(client, ticket.discord_user_id, { embeds: [canceledEmbed] });

          // Alert admin: perlu proses PERGANTIAN layanan (bukan refund).
          try {
            const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
            if (adminChannel) {
              await adminChannel.send({
                content:         `<@&${ENV.ADMIN_ROLE_ID}>`,
                embeds:          [buildAdminOrderCanceledAlert({
                  orderId:         order.id,
                  userId:          ticket.discord_user_id,
                  serviceName:     serviceName,
                  total:           order.sell_price,
                  providerOrderId: providerOrderId,
                })],
                allowedMentions: { roles: [ENV.ADMIN_ROLE_ID] },
              });
            }
          } catch (e: any) {
            logger.warn('[OrderStatus] Gagal alert admin (canceled)', { error: e?.message });
          }

          // Tutup tiket + jadwalkan hapus channel (default ~5 menit) supaya cepat lanjut ke
          // pergantian layanan baru.
          if (!['closed', 'cancelled', 'orphaned'].includes(ticket.status)) {
            await prisma.ticket.update({
              where: { id: order.ticket_id },
              data: {
                status:       'cancelled',
                closed_at:    new Date(),
                close_reason: 'Order dibatalkan provider — akan diganti layanan baru.',
              },
            });
            await scheduleChannelDeletion(order.ticket_id);
          }
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

        // Notif refill selesai — TIDAK bergantung channel tiket (bisa saja sudah ditutup/dihapus).
        // Pakai fallback: DM dulu, kalau gagal ke channel admin log.
        if (newStatus === 'completed') {
          const ticket = await prisma.ticket.findUnique({ where: { id: refill.ticket_id } });
          const buyerId = ticket?.discord_user_id;
          if (buyerId) {
            await notifyUserWithFallback(client, buyerId, {
              content: `<@${buyerId}> ♻️ Refill kamu untuk order \`${refill.order_id.slice(0, 8)}\` sudah **selesai**! Silakan cek akun kamu.`,
            });
          }
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
