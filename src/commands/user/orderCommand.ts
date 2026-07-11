import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildOrderHistoryEmbed } from '../../lib/embeds';

export async function handleOrderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'history') {
    const orders = await prisma.order.findMany({
      where:   { user_id: interaction.user.id },
      orderBy: { created_at: 'desc' },
      take:    10,
    });

    // Ambil nama layanan sekali (hindari query per order).
    const serviceIds = [...new Set(orders.map(o => o.service_id))];
    const services   = serviceIds.length
      ? await prisma.service.findMany({ where: { id: { in: serviceIds } } })
      : [];
    const nameMap = new Map(services.map(s => [s.id, s.name]));

    const rows = orders.map(o => ({
      id:          o.id,
      serviceName: nameMap.get(o.service_id) || 'Layanan',
      status:      o.status,
      quantity:    o.quantity,
      sellPrice:   o.sell_price,
      createdAt:   o.created_at,
    }));

    await interaction.editReply({ embeds: [buildOrderHistoryEmbed(interaction.user.id, rows)] });
    return;
  }

  await interaction.editReply({ content: '❌ Subcommand tidak dikenal.' });
}
