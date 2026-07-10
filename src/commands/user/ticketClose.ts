import { ButtonInteraction, TextChannel, PermissionFlagsBits } from 'discord.js';
import { prisma } from '../../bot/client';
import { logger } from '../../lib/logger';
import { buildTicketClosedEmbed } from '../../lib/embeds';

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const ticketId = interaction.customId.replace('ticket_close_', '');

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    await interaction.editReply({ content: '❌ Ticket tidak ditemukan.' });
    return;
  }

  if (ticket.discord_user_id !== interaction.user.id) {
    await interaction.editReply({ content: '❌ Kamu tidak bisa menutup ticket ini.' });
    return;
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status:       'closed',
      closed_at:    new Date(),
      closed_by:    interaction.user.id,
      close_reason: 'Ditutup oleh user',
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      actor_user_id: interaction.user.id,
      action:        'close_ticket',
      target_type:   'ticket',
      target_id:     ticketId,
    },
  });

  const channel = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
  if (channel) {
    await channel.send({ embeds: [buildTicketClosedEmbed('Ditutup oleh user.')] });

    // Lock channel
    await channel.permissionOverwrites.edit(ticket.discord_user_id, {
      SendMessages: false,
    }).catch(() => {});

    // Delete after 5 minutes
    setTimeout(async () => {
      await channel.delete().catch(() => {});
    }, 5 * 60 * 1000);
  }

  await interaction.editReply({ content: '✅ Ticket sedang ditutup...' });
  logger.info(`[TicketClose] Ticket ${ticketId} closed by ${interaction.user.tag}`);
}
