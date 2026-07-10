import { ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildOrderProgressEmbed } from '../../lib/embeds';

export async function handleTicketCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'status') {
    const tickets = await prisma.ticket.findMany({
      where: {
        discord_user_id: interaction.user.id,
        status: { notIn: ['closed', 'cancelled', 'orphaned'] },
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });

    if (tickets.length === 0) {
      await interaction.editReply({ content: '📭 Kamu tidak memiliki ticket aktif.' });
      return;
    }

    const lines = tickets.map(t =>
      `🎫 <#${t.ticket_channel_id}> — **${t.status.toUpperCase()}** — \`${t.id.slice(0, 8)}\``
    );

    await interaction.editReply({
      content: `**Ticket Aktif Kamu:**\n${lines.join('\n')}`,
    });
    return;
  }
}
