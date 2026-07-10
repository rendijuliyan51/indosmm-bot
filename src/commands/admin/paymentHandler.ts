import { ButtonInteraction, TextChannel } from 'discord.js';
import { prisma } from '../../bot/client';
import { indosmm } from '../../providers/indosmm';
import { logger } from '../../lib/logger';
import {
  buildOrderProgressEmbed,
  buildTicketClosedEmbed,
  buildOrderFailedNotif,
  buildLowBalanceNotif,
} from '../../lib/embeds';
import { ENV } from '../../config/env';

const LOW_BALANCE_THRESHOLD = 50000; // Notif kalau saldo di bawah 50rb

export async function handlePaymentApprove(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const ticketId = interaction.customId.replace('payment_approve_', '');

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) { await interaction.editReply({ content: '❌ Ticket tidak ditemukan.' }); return; }

  const payment = await prisma.manualPayment.findFirst({
    where:   { ticket_id: ticketId },
    orderBy: { created_at: 'desc' },
  });

  if (!payment) { await interaction.editReply({ content: '❌ Payment tidak ditemukan.' }); return; }
  if (payment.status === 'approved') { await interaction.editReply({ content: '⚠️ Payment sudah di-approve sebelumnya.' }); return; }
  if (payment.status === 'rejected') { await interaction.editReply({ content: '⚠️ Payment sudah di-reject sebelumnya.' }); return; }

  const order = await prisma.order.findFirst({ where: { ticket_id: ticketId } });
  if (!order) { await interaction.editReply({ content: '❌ Order tidak ditemukan.' }); return; }

  if (['submitted', 'processing', 'completed'].includes(order.status)) {
    await interaction.editReply({ content: '⚠️ Order ini sudah disubmit sebelumnya.' });
    return;
  }

  const service = await prisma.service.findUnique({ where: { id: order.service_id } });
  if (!service) { await interaction.editReply({ content: '❌ Service tidak ditemukan.' }); return; }

  // Cek saldo IndoSMM sebelum approve
  try {
    const balance = await indosmm.getBalance();
    if (balance < order.buy_price) {
      await interaction.editReply({
        content: `❌ Saldo IndoSMM tidak cukup!\nSaldo: **Rp ${balance.toLocaleString('id-ID')}**\nDibutuhkan: **Rp ${order.buy_price.toLocaleString('id-ID')}**\n\nSegera top up saldo di https://indosmm.id`,
      });
      return;
    }

    // Notif kalau saldo menipis
    if (balance < LOW_BALANCE_THRESHOLD) {
      try {
        const adminChannel = await interaction.client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as TextChannel | null;
        if (adminChannel) {
          const lowBalEmbed = buildLowBalanceNotif(balance, LOW_BALANCE_THRESHOLD);
          await adminChannel.send({ embeds: [lowBalEmbed] });
        }
      } catch (e) {}
    }
  } catch (balanceErr: any) {
    logger.warn('[PaymentApprove] Could not check balance', { error: balanceErr.message });
    // Lanjut approve meski cek saldo gagal
  }

  try {
    await prisma.manualPayment.update({
      where: { id: payment.id },
      data: {
        status:      'approved',
        approved_by: interaction.user.id,
        approved_at: new Date(),
      },
    });

    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'paid' } });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'paid', updated_at: new Date() } });

    const result = await indosmm.createOrder(
      service.provider_service_id,
      order.target_link,
      order.quantity,
    );

    if (result.error || !result.order) {
      throw new Error(result.error || 'No order ID returned');
    }

    const providerOrderId = String(result.order);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status:            'submitted',
        provider_order_id: providerOrderId,
        updated_at:        new Date(),
      },
    });

    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'processing' } });

    await prisma.orderLog.create({
      data: {
        order_id:          order.id,
        old_status:        'paid',
        new_status:        'submitted',
        message:           `Submitted. Provider order ID: ${providerOrderId}`,
        raw_response_json: JSON.stringify(result),
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'approve_payment',
        target_type:   'ticket',
        target_id:     ticketId,
        details_json:  JSON.stringify({ order_id: order.id, provider_order_id: providerOrderId }),
      },
    });

    const ticketChannel = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;

    const progressEmbed = buildOrderProgressEmbed({
      orderId:         order.id,
      serviceName:     service.name,
      category:        service.category,
      targetLink:      order.target_link,
      quantity:        order.quantity,
      total:           order.sell_price,
      status:          'submitted',
      providerOrderId: providerOrderId,
      refillExpiresAt: updatedOrder.refill_expires_at,
    });

    if (ticketChannel) {
      const botMsg = await prisma.botMessage.findFirst({
        where: { ticket_id: ticketId, message_type: 'order_progress' },
      });

      if (botMsg) {
        const msg = await ticketChannel.messages.fetch(botMsg.message_id).catch(() => null);
        if (msg) await msg.edit({ embeds: [progressEmbed], components: [] });
      } else {
        const newMsg = await ticketChannel.send({
          content: `✅ <@${ticket.discord_user_id}> Pembayaran dikonfirmasi! Order sedang diproses.`,
          embeds:  [progressEmbed],
        });
        await prisma.botMessage.create({
          data: {
            ticket_id:    ticketId,
            message_type: 'order_progress',
            channel_id:   ticketChannel.id,
            message_id:   newMsg.id,
          },
        });
      }
    }

    await interaction.editReply({ content: `✅ Approved! Provider order ID: \`${providerOrderId}\`` });
    logger.info(`[PaymentApprove] Order ${order.id} → provider ${providerOrderId}`);

  } catch (err: any) {
    logger.error('[PaymentApprove] Failed', { error: err.message });

    await prisma.order.update({
      where: { id: order.id },
      data:  { status: 'failed', notes: err.message, updated_at: new Date() },
    });

    await prisma.orderLog.create({
      data: {
        order_id:   order.id,
        old_status: 'paid',
        new_status: 'failed',
        message:    err.message,
      },
    });

    // Notif user di ticket kalau gagal
    try {
      const ticketChannel = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
      if (ticketChannel) {
        const failedEmbed = buildOrderFailedNotif({
          userId:      ticket.discord_user_id,
          serviceName: service?.name || 'Unknown',
          reason:      err.message,
        });
        await ticketChannel.send({
          content: `<@${ticket.discord_user_id}>`,
          embeds:  [failedEmbed],
        });
      }
    } catch (e) {}

    await interaction.editReply({ content: `❌ Gagal submit ke provider: ${err.message}` });
  }
}

export async function handlePaymentReject(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const ticketId = interaction.customId.replace('payment_reject_', '');

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) { await interaction.editReply({ content: '❌ Ticket tidak ditemukan.' }); return; }

  const payment = await prisma.manualPayment.findFirst({
    where:   { ticket_id: ticketId },
    orderBy: { created_at: 'desc' },
  });

  if (payment?.status === 'pending') {
    await prisma.manualPayment.update({
      where: { id: payment.id },
      data: {
        status:      'rejected',
        approved_by: interaction.user.id,
        approved_at: new Date(),
      },
    });
  }

  await prisma.order.updateMany({
    where: { ticket_id: ticketId },
    data:  { status: 'cancelled', updated_at: new Date() },
  });

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status:       'cancelled',
      closed_at:    new Date(),
      closed_by:    interaction.user.id,
      close_reason: 'Payment rejected by admin',
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      actor_user_id: interaction.user.id,
      action:        'reject_payment',
      target_type:   'ticket',
      target_id:     ticketId,
    },
  });

  try {
    const ticketChannel = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
    if (ticketChannel) {
      await ticketChannel.send({
        content: `<@${ticket.discord_user_id}> ❌ Maaf, pembayaran kamu ditolak oleh admin. Silakan hubungi admin jika ada pertanyaan.`,
        embeds:  [buildTicketClosedEmbed('Payment ditolak oleh admin.')],
      });
      setTimeout(async () => { await ticketChannel.delete().catch(() => {}); }, 5 * 60 * 1000);
    }
  } catch (e) {}

  await interaction.editReply({ content: '✅ Payment rejected. Ticket akan ditutup.' });
  logger.info(`[PaymentReject] Ticket ${ticketId} rejected by ${interaction.user.tag}`);
}
