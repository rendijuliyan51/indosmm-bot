import { StringSelectMenuInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceDetailEmbed, buildServiceDetailButtons } from '../../lib/embeds';
import { setService } from '../../lib/selectionStore';

export async function handleCatalogSelectService(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  const serviceId = interaction.values[0];
  const service   = await prisma.service.findUnique({ where: { id: serviceId } });

  if (!service) {
    await interaction.reply({ content: '❌ Layanan tidak ditemukan.', ephemeral: true });
    return;
  }

  await setService(interaction.user.id, serviceId);

  const embed = buildServiceDetailEmbed(service);
  const row   = buildServiceDetailButtons();

  await interaction.reply({
    ephemeral:  true,
    embeds:     [embed],
    components: [row],
  });
}
