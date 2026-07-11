import { Client, TextChannel } from 'discord.js';
import { createHash } from 'crypto';
import { prisma } from '../bot/client';
import { logger } from '../lib/logger';
import { buildCatalogEmbed, buildCategorySelectMenu, buildCatalogSearchRow } from '../lib/embeds';

const CATEGORY_MAP: Record<string, string> = {
  'instagram':   'Instagram',
  'tiktok':      'TikTok',
  'telegram':    'Telegram',
  'spotify':     'Spotify',
  'snack video': 'Snack Video',
  'youtube':     'YouTube',
  'twitter':     'Twitter',
  'shopee':      'Shopee',
  'facebook':    'Facebook',
  'roblox':      'Roblox',
  'github':      'GitHub',
  'pinterest':   'Pinterest',
  'line':        'Line',
  'threads':     'Threads',
  'whatsapp':    'WhatsApp',
  'linkedin':    'LinkedIn',
};

export function mapCategory(raw: string): string | null {
  const lower = raw.toLowerCase();
  for (const [key, label] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return label;
  }
  return null;
}

export async function runCatalogUpdate(client: Client): Promise<void> {
  try {
    const conf = await prisma.catalogMessage.findFirst();
    if (!conf) return;

    const services = await prisma.service.findMany({
      where:   { active: true, hidden: false },
      orderBy: { price_sell: 'asc' },
    });

    if (services.length === 0) return;

    const categorySet = new Set<string>();
    for (const s of services) {
      const mapped = mapCategory(s.category);
      if (mapped) categorySet.add(mapped);
    }

    const categories = [...categorySet].sort();
    if (categories.length === 0) return;

    const hash = createHash('md5').update(JSON.stringify(categories)).digest('hex');
    if (conf.last_hash === hash) return;

    const channel = await client.channels.fetch(conf.channel_id).catch(() => null) as TextChannel | null;
    if (!channel) { logger.error('[Catalog] Channel not found'); return; }

    const embed     = buildCatalogEmbed(categories);
    const row       = buildCategorySelectMenu(categories);
    const searchRow = buildCatalogSearchRow();

    if (conf.message_id) {
      const msg = await channel.messages.fetch(conf.message_id).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components: [row, searchRow] });
        await prisma.catalogMessage.update({
          where: { id: conf.id },
          data:  { last_hash: hash, updated_at: new Date() },
        });
        logger.info('[Catalog] Updated existing catalog message');
        return;
      }
    }

    const newMsg = await channel.send({ embeds: [embed], components: [row, searchRow] });
    await prisma.catalogMessage.update({
      where: { id: conf.id },
      data:  { message_id: newMsg.id, last_hash: hash, updated_at: new Date() },
    });
    logger.info('[Catalog] Sent new catalog message');
  } catch (err: any) {
    logger.error('[Catalog] Failed to update catalog', { error: err.message });
  }
}
