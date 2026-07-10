import { StringSelectMenuInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceTypeSelectMenu, getCategoryEmoji } from '../../lib/embeds';
import { mapCategory } from '../../workers/catalogWorker';
import { setCategory } from '../../lib/selectionStore';

const TYPE_KEYWORDS: Record<string, string[]> = {
  'Followers':    ['follower'],
  'Likes':        ['like', 'love', 'heart'],
  'Views':        ['view', 'watch', 'play', 'stream', 'impression'],
  'Comments':     ['comment'],
  'Share':        ['share', 'retweet', 'repost'],
  'Subscribers':  ['subscriber'],
  'Members':      ['member'],
  'Saves':        ['save', 'bookmark'],
  'Other':        [],
};

export function detectServiceType(name: string): string {
  const lower = name.toLowerCase();
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (type === 'Other') continue;
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'Other';
}

export async function handleCatalogSelectCategory(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const selectedLabel = interaction.values[0];
  await setCategory(interaction.user.id, selectedLabel);

  const allServices = await prisma.service.findMany({
    where:   { active: true },
    orderBy: { price_sell: 'asc' },
  });

  const services = allServices.filter(s => {
    const mapped = mapCategory(s.category);
    return mapped?.toLowerCase() === selectedLabel.toLowerCase();
  });

  if (services.length === 0) {
    await interaction.editReply({ content: '❌ Tidak ada layanan untuk kategori ini.' });
    return;
  }

  // Detect unique types
  const typeSet = new Set<string>();
  for (const s of services) {
    typeSet.add(detectServiceType(s.name));
  }

  const types = [...typeSet].sort();

  const selectRow = buildServiceTypeSelectMenu(types);

  await interaction.editReply({
    content:    `${getCategoryEmoji(selectedLabel)} **${selectedLabel}** — Pilih jenis layanan:`,
    components: [selectRow],
  });
}
