import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { prisma } from '../../bot/client';
import { buildOrderHistoryEmbed } from '../../lib/embeds';
import { isRefillExpired } from '../../lib/pricing';
import { claimRefill } from './refillRequest';
import { ENV } from '../../config/env';

// Jumlah order terakhir yang ditampilkan di /order history.
const HISTORY_LIMIT = 15;

function memberIsAdmin(interaction: ChatInputCommandInteraction): boolean {
  const roles = (interaction.member as any)?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(ENV.ADMIN_ROLE_ID);
  if ('cache' in roles) return roles.cache.has(ENV.ADMIN_ROLE_ID);
  return false;
}

export async function handleOrderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'history') {
    const orders = await prisma.order.findMany({
      where:   { user_id: interaction.user.id },
      orderBy: { created_at: 'desc' },
      take:    HISTORY_LIMIT,
    });

    // Ambil layanan sekali (hindari query per order) — butuh nama & flag refill.
    const serviceIds = [...new Set(orders.map(o => o.service_id))];
    const services   = serviceIds.length
      ? await prisma.service.findMany({ where: { id: { in: serviceIds } } })
      : [];
    const svcMap = new Map(services.map(s => [s.id, s]));

    const rows = orders.map(o => {
      const svc = svcMap.get(o.service_id);
      // Garansi masih aktif & bisa diklaim bila: layanan mendukung refill, order sudah terkirim
      // ke provider, dan masa garansi belum habis.
      const refillActive = Boolean(svc?.refill) && Boolean(o.provider_order_id) && !isRefillExpired(o.refill_expires_at);
      return {
        id:              o.id,
        serviceName:     svc?.name || 'Layanan',
        status:          o.status,
        quantity:        o.quantity,
        sellPrice:       o.sell_price,
        createdAt:       o.created_at,
        refillActive,
        refillExpiresAt: o.refill_expires_at,
      };
    });

    await interaction.editReply({ embeds: [buildOrderHistoryEmbed(interaction.user.id, rows)] });
    return;
  }

  if (sub === 'refill') {
    const orderId = interaction.options.getString('order_id', true);
    // User biasa hanya boleh merefill order miliknya sendiri; admin boleh merefill order siapa pun.
    const requesterId = memberIsAdmin(interaction) ? null : interaction.user.id;
    const res = await claimRefill(orderId, requesterId);
    await interaction.editReply({ content: res.message });
    return;
  }

  await interaction.editReply({ content: '❌ Subcommand tidak dikenal.' });
}
