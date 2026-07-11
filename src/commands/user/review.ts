import {
  ButtonInteraction, ModalSubmitInteraction, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, TextChannel,
} from 'discord.js';
import { prisma } from '../../bot/client';
import { logger } from '../../lib/logger';
import { ENV } from '../../config/env';
import { buildReviewThanksEmbed, buildTestimonialEmbed } from '../../lib/embeds';

// Tombol "Beri Rating" pada notif order selesai → tampilkan modal rating.
export async function handleReviewStart(interaction: ButtonInteraction): Promise<void> {
  const orderId = interaction.customId.replace('review_start_', '');

  const existing = await prisma.review.findUnique({ where: { order_id: orderId } }).catch(() => null);
  if (existing) {
    await interaction.reply({ content: '✅ Kamu sudah memberi rating untuk order ini. Terima kasih!', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder().setCustomId(`review_modal_${orderId}`).setTitle('Beri Rating');
  const ratingInput = new TextInputBuilder()
    .setCustomId('rating')
    .setLabel('Rating (angka 1-5)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('5')
    .setRequired(true)
    .setMaxLength(1);
  const commentInput = new TextInputBuilder()
    .setCustomId('comment')
    .setLabel('Ulasan (opsional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(ratingInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(commentInput),
  );
  await interaction.showModal(modal);
}

export async function handleReviewModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const orderId   = interaction.customId.replace('review_modal_', '');
  const ratingRaw = interaction.fields.getTextInputValue('rating').trim();
  const comment   = (interaction.fields.getTextInputValue('comment') || '').trim() || null;
  const rating    = parseInt(ratingRaw, 10);

  if (isNaN(rating) || rating < 1 || rating > 5) {
    await interaction.editReply({ content: '❌ Rating harus berupa angka 1 sampai 5.' });
    return;
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) { await interaction.editReply({ content: '❌ Order tidak ditemukan.' }); return; }
  if (order.user_id !== interaction.user.id) { await interaction.editReply({ content: '❌ Ini bukan order kamu.' }); return; }

  try {
    await prisma.review.create({
      data: { order_id: orderId, user_id: interaction.user.id, service_id: order.service_id, rating, comment },
    });
  } catch {
    // Melanggar unique constraint order_id → sudah pernah review.
    await interaction.editReply({ content: '✅ Kamu sudah memberi rating untuk order ini.' });
    return;
  }

  await interaction.editReply({ embeds: [buildReviewThanksEmbed(rating, comment)] });
  logger.info(`[Review] ${interaction.user.tag} rated order ${orderId}: ${rating}/5`);

  // Auto-post testimoni ke channel (hanya rating 4-5, dan hanya bila channel diset).
  if (rating >= 4 && ENV.TESTIMONIAL_CHANNEL_ID) {
    try {
      const service = await prisma.service.findUnique({ where: { id: order.service_id } });
      const channel = await interaction.client.channels
        .fetch(ENV.TESTIMONIAL_CHANNEL_ID)
        .catch(() => null) as TextChannel | null;

      if (channel && channel.isTextBased()) {
        await channel.send({
          embeds: [buildTestimonialEmbed({
            userId:      interaction.user.id,
            username:    interaction.user.username,
            avatarUrl:   interaction.user.displayAvatarURL(),
            rating,
            comment,
            serviceName: service?.name || 'Layanan',
            category:    service?.category || '',
          })],
        });
      }
    } catch (e: any) {
      logger.error('[Review] Gagal post testimoni', { error: e.message });
    }
  }
}
