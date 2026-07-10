import { ButtonInteraction, TextChannel } from 'discord.js';
import { prisma } from '../../bot/client';
import { indosmm } from '../../providers/indosmm';
import { logger } from '../../lib/logger';
import { buildRefillEmbed } from '../../lib/embeds';
import { isRefillExpired } from '../../lib/pricing';

export async function handleRefillRequest(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const ticketId = interaction.customId.replace('refill_request_', '');

  const order = await prisma.order.findFirst({ where: { ticket_id: ticketId } });
  if (!order) {
    await interaction.editReply({ content: '❌ Order tidak ditemukan.' });
    return;
  }

  const service = await prisma.service.findUnique({ where: { id: order.service_id } });
  if (!service || !service.refill) {
    await interaction.editReply({ content: '❌ Layanan ini tidak mendukung refill.' });
    return;
  }

  if (isRefillExpired(order.refill_expires_at)) {
    await interaction.editReply({ content: '❌ Masa garansi refill sudah habis.' });
    return;
  }

  if (!order.provider_order_id) {
    await interaction.editReply({ content: '❌ Order belum memiliki provider order ID.' });
    return;
  }

  try {
    const result = await indosmm.requestRefill(order.provider_order_id);

    if (result.error) throw new Error(result.error);

    const refillRequest = await prisma.refillRequest.create({
      data: {
        order_id:          order.id,
        ticket_id:         ticketId,
        provider_refill_id: result.refill || null,
        status:            'pending',
      },
    });

    // Send refill status message to ticket channel
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (ticket) {
      const channel = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
      if (channel) {
        const embed = buildRefillEmbed({
          orderId:     order.id,
          status:      'pending',
          requestedAt: refillRequest.requested_at,
        });
        await channel.send({
          content: `<@${interaction.user.id}> Refill request berhasil dikirim!`,
          embeds:  [embed],
        });
      }
    }

    await interaction.editReply({ content: '✅ Refill request berhasil dikirim ke provider!' });
    logger.info(`[Refill] Refill requested for order ${order.id}`);

  } catch (err: any) {
    logger.error('[Refill] Failed', { error: err.message });
    await interaction.editReply({ content: `❌ Gagal request refill: ${err.message}` });
  }
}
