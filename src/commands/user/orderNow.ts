import { ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getSelection } from '../../lib/selectionStore';
import { prisma } from '../../bot/client';

export async function handleOrderNow(interaction: ButtonInteraction): Promise<void> {
  const { service_id: serviceId } = await getSelection(interaction.user.id);

  if (!serviceId) {
    await interaction.reply({
      content: '❌ Pilih layanan terlebih dahulu dari dropdown di atas.',
      ephemeral: true,
    });
    return;
  }

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) {
    await interaction.reply({ content: '❌ Layanan tidak ditemukan.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`order_modal_${serviceId}`)
    .setTitle('Form Order');

  const linkInput = new TextInputBuilder()
    .setCustomId('target_link')
    .setLabel('Target Link / Username')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://instagram.com/username')
    .setRequired(true);

  const qtyInput = new TextInputBuilder()
    .setCustomId('quantity')
    .setLabel(`Jumlah (Min: ${service.min} • Max: ${service.max})`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`Contoh: ${service.min}`)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(linkInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(qtyInput),
  );

  await interaction.showModal(modal);
}
