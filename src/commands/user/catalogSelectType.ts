import { StringSelectMenuInteraction, ButtonInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceSelectRows } from '../../lib/embeds';
import { mapCategory } from '../../workers/catalogWorker';
import { detectServiceType } from './catalogSelectCategory';
import { getSelection, setServiceType } from '../../lib/selectionStore';

type ServiceRow = Awaited<ReturnType<typeof prisma.service.findMany>>[number];

/**
 * Ambil semua layanan aktif yang cocok dengan kategori & jenis yang dipilih,
 * diurutkan termurah ke termahal. Dipakai ulang oleh handler pilih-jenis dan navigasi halaman.
 */
export async function getFilteredServices(category: string, type: string): Promise<ServiceRow[]> {
  const allServices = await prisma.service.findMany({
    where:   { active: true },
    orderBy: { price_sell: 'asc' },
  });

  return allServices.filter(s => {
    const mapped = mapCategory(s.category);
    if (mapped?.toLowerCase() !== category.toLowerCase()) return false;
    return detectServiceType(s.name).toLowerCase() === type.toLowerCase();
  });
}

export async function handleCatalogSelectType(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const selectedType = interaction.values[0];
  const selection    = await getSelection(interaction.user.id);

  if (!selection.category) {
    await interaction.editReply({ content: '❌ Pilih kategori dulu.' });
    return;
  }

  await setServiceType(interaction.user.id, selectedType);

  const services = await getFilteredServices(selection.category, selectedType);

  if (services.length === 0) {
    await interaction.editReply({ content: '❌ Tidak ada layanan untuk jenis ini.' });
    return;
  }

  const rows = buildServiceSelectRows(services, 0);

  await interaction.editReply({
    content:    `**${services.length} layanan tersedia — termurah ke termahal:**`,
    components: rows,
  });
}

// Handler navigasi halaman dropdown layanan (tombol ◀/▶). Halaman diambil dari customId,
// filter (kategori+jenis) diambil dari state pilihan user yang tersimpan di DB.
export async function handleServicePage(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const page      = parseInt(interaction.customId.replace('catalog_svc_page_', ''), 10) || 0;
  const selection = await getSelection(interaction.user.id);

  if (!selection.category || !selection.service_type) {
    await interaction.editReply({ content: '❌ Pilih kategori & jenis layanan dulu.', components: [] });
    return;
  }

  const services = await getFilteredServices(selection.category, selection.service_type);
  if (services.length === 0) {
    await interaction.editReply({ content: '❌ Tidak ada layanan untuk jenis ini.', components: [] });
    return;
  }

  const rows = buildServiceSelectRows(services, page);

  await interaction.editReply({
    content:    `**${services.length} layanan tersedia — termurah ke termahal:**`,
    components: rows,
  });
}
