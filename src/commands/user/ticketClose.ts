import { ButtonInteraction, TextChannel, PermissionFlagsBits } from 'discord.js';
import { prisma } from '../../bot/client';
import { logger } from '../../lib/logger';
import { buildTicketClosedEmbed } from '../../lib/embeds';
import { scheduleChannelDeletion } from '../../lib/ticketLifecycle';
import { ENV } from '../../config/env';

function isAdmin(interaction: ButtonInteraction): boolean {
  const roles = (interaction.member as any)?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(ENV.ADMIN_ROLE_ID);
  if ('cache' in roles) return roles.cache.has(ENV.ADMIN_ROLE_ID);
  return false;
}

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const ticketId = interaction.customId.replace('ticket_close_', '');

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    await interaction.editReply({ content: '❌ Ticket tidak ditemukan.' });
    return;
  }

  // Pemilik ticket ATAU admin boleh menutup ticket.
  const admin = isAdmin(interaction);
  if (ticket.discord_user_id !== interaction.user.id && !admin) {
    await interaction.editReply({ content: '❌ Kamu tidak bisa menutup ticket ini.' });
    return;
  }

  const closeReason = admin && ticket.discord_user_id !== interaction.user.id
    ? 'Ditutup oleh admin'
    : 'Ditutup oleh user';

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status:       'closed',
      closed_at:    new Date(),
      closed_by:    interaction.user.id,
      close_reason: closeReason,
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
    await channel.send({ embeds: [buildTicketClosedEmbed(`${closeReason}.`)] });

    // Lock channel
    await channel.permissionOverwrites.edit(ticket.discord_user_id, {
      SendMessages: false,
    }).catch(() => {});
  }

  // Jadwalkan penghapusan channel secara persisten (tahan restart).
  await scheduleChannelDeletion(ticketId);

  await interaction.editReply({ content: '✅ Ticket sedang ditutup...' });
  logger.info(`[TicketClose] Ticket ${ticketId} closed by ${interaction.user.tag}`);
}
