import { StringSelectMenuInteraction } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceTypeSelectMenu } from '../../lib/embeds';
import { mapCategory } from '../../workers/catalogWorker';

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

// Store selected category per user
export const selectedCategoryMap = new Map<string, string>();

export async function handleCatalogSelectCategory(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const selectedLabel = interaction.values[0];
  selectedCategoryMap.set(interaction.user.id, selectedLabel);

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

function getCategoryEmoji(cat: string): string {
  const map: Record<string, string> = {
    instagram: '📸', tiktok: '🎵', telegram: '✈️', spotify: '🎧',
    'snack video': '🍿', youtube: '▶️', twitter: '🐦', shopee: '🛍️',
    facebook: '👤', roblox: '🎮', github: '💻',
  };
  const lower = cat.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (lower.includes(k)) return v;
  }
  return '🔷';
}
