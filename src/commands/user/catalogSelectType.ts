import { StringSelectMenuInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceSelectMenu } from '../../lib/embeds';
import { mapCategory } from '../../workers/catalogWorker';
import { detectServiceType, selectedCategoryMap } from './catalogSelectCategory';

export const selectedTypeMap = new Map<string, string>();

export async function handleCatalogSelectType(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const selectedType  = interaction.values[0];
  const selectedLabel = selectedCategoryMap.get(interaction.user.id);

  if (!selectedLabel) {
    await interaction.editReply({ content: '❌ Pilih kategori dulu.' });
    return;
  }

  selectedTypeMap.set(interaction.user.id, selectedType);

  const allServices = await prisma.service.findMany({
    where:   { active: true },
    orderBy: { price_sell: 'asc' },
  });

  const services = allServices.filter(s => {
    const mapped = mapCategory(s.category);
    if (mapped?.toLowerCase() !== selectedLabel.toLowerCase()) return false;
    return detectServiceType(s.name).toLowerCase() === selectedType.toLowerCase();
  }).slice(0, 25);

  if (services.length === 0) {
    await interaction.editReply({ content: '❌ Tidak ada layanan untuk jenis ini.' });
    return;
  }

  const selectRow = buildServiceSelectMenu(services);

  await interaction.editReply({
    content:    `**${services.length} layanan tersedia — termurah ke termahal:**`,
    components: [selectRow],
  });
}
