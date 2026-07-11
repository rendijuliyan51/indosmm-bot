import { ChatInputCommandInteraction, TextChannel, MessageFlags } from 'discord.js';
import { prisma } from '../../bot/client';
import { logger } from '../../lib/logger';
import { runServiceSync } from '../../workers/serviceSyncWorker';
import { indosmm } from '../../providers/indosmm';
import { buildTicketClosedEmbed } from '../../lib/embeds';
import { scheduleChannelDeletion } from '../../lib/ticketLifecycle';

export async function handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'sync-services') {
    await interaction.editReply({ content: '🔄 Syncing services...' });
    await runServiceSync();
    const count = await prisma.service.count({ where: { active: true } });
    await interaction.editReply({ content: `✅ Sync selesai! Total **${count}** layanan aktif.` });
    return;
  }

  if (sub === 'set-catalog-channel') {
    const ch = interaction.options.getChannel('channel', true);
    await prisma.catalogMessage.deleteMany({});
    await prisma.catalogMessage.create({
      data: { guild_id: interaction.guildId!, channel_id: ch.id },
    });
    await interaction.editReply({ content: `✅ Catalog channel diset ke <#${ch.id}>` });
    return;
  }

  if (sub === 'set-markup') {
    const value = interaction.options.getNumber('value', true);

    await interaction.editReply({ content: `⏳ Menghitung ulang harga dengan markup ${value}%...` });

    // Ambil semua service aktif
    const services = await prisma.service.findMany({ where: { active: true } });

    // Recalculate price_sell untuk semua service
    for (const service of services) {
      const newSellPrice = service.price_buy * (1 + value / 100);
      await prisma.service.update({
        where: { id: service.id },
        data: {
          markup_value: value,
          price_sell:   newSellPrice,
          updated_at:   new Date(),
        },
      });
    }

    // Reset catalog hash biar auto-update
    await prisma.catalogMessage.updateMany({
      data: { last_hash: null },
    });

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'set_markup',
        details_json:  JSON.stringify({ markup: value, services_updated: services.length }),
      },
    });

    await interaction.editReply({
      content: `✅ Markup diset ke **${value}%**\n📊 **${services.length}** layanan harga sudah diupdate.\nKatalog akan refresh otomatis dalam 2 menit.`,
    });
    return;
  }

  if (sub === 'cancel-order') {
    const input = interaction.options.getString('order_id', true).trim();

    let order = await prisma.order.findUnique({ where: { id: input } });
    if (!order) {
      const orders = await prisma.order.findMany({
        where: { id: { startsWith: input } },
        take:  1,
      });
      order = orders[0] || null;
    }

    if (!order) {
      await interaction.editReply({ content: `❌ Order dengan ID \`${input}\` tidak ditemukan.` });
      return;
    }

    if (order.provider_order_id) {
      await indosmm.cancelOrders([order.provider_order_id]).catch(() => {});
    }

    await prisma.order.update({
      where: { id: order.id },
      data:  { status: 'cancelled', updated_at: new Date() },
    });

    // Tutup ticket terkait sekalian + jadwalkan hapus channel (persisten, tahan restart),
    // dan beri tahu pembeli di channel ticket.
    let ticketClosed = false;
    const ticket = await prisma.ticket.findUnique({ where: { id: order.ticket_id } });
    if (ticket && !['closed', 'cancelled', 'orphaned'].includes(ticket.status)) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status:       'cancelled',
          closed_at:    new Date(),
          closed_by:    interaction.user.id,
          close_reason: 'Order dibatalkan oleh admin',
        },
      });

      const ch = await interaction.client.channels.fetch(ticket.ticket_channel_id).catch(() => null) as TextChannel | null;
      if (ch) {
        await ch.send({
          content: `<@${ticket.discord_user_id}> Order kamu dibatalkan oleh admin.`,
          embeds:  [buildTicketClosedEmbed('Order dibatalkan oleh admin.')],
        }).catch(() => {});
      }

      await scheduleChannelDeletion(ticket.id);
      ticketClosed = true;
    }

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'cancel_order',
        target_type:   'order',
        target_id:     order.id,
        details_json:  JSON.stringify({ ticket_id: order.ticket_id, ticket_closed: ticketClosed }),
      },
    });

    await interaction.editReply({
      content: `✅ Order \`${order.id.slice(0, 8)}\` dibatalkan.` +
               (ticketClosed ? ' Ticket terkait ikut ditutup & channel akan dihapus.' : ''),
    });
    return;
  }

  if (sub === 'set-description') {
    const providerId = interaction.options.getString('service_id', true).trim();
    const text       = interaction.options.getString('text', true).trim();

    const service = await prisma.service.findUnique({
      where: { provider_service_id: providerId },
    });

    if (!service) {
      await interaction.editReply({ content: `❌ Layanan dengan provider service ID \`${providerId}\` tidak ditemukan. Pastikan sudah pernah sync.` });
      return;
    }

    // "-" berarti hapus override, kembali memakai deskripsi bawaan provider.
    const override = text === '-' ? null : text;

    await prisma.service.update({
      where: { id: service.id },
      data:  { description_override: override, updated_at: new Date() },
    });

    // Reset hash katalog agar embed ikut refresh bila perlu.
    await prisma.catalogMessage.updateMany({ data: { last_hash: null } });

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'set_description',
        target_type:   'service',
        target_id:     service.id,
        details_json:  JSON.stringify({ provider_service_id: providerId, cleared: override === null }),
      },
    });

    await interaction.editReply({
      content: override === null
        ? `✅ Deskripsi override untuk **${service.name}** dihapus. Kembali memakai deskripsi provider.`
        : `✅ Deskripsi untuk **${service.name}** berhasil diperbarui.\n\n**Preview:**\n${override.slice(0, 500)}${override.length > 500 ? '…' : ''}`,
    });
    return;
  }

  if (sub === 'audit-log') {
    const logs = await prisma.adminAuditLog.findMany({
      orderBy: { created_at: 'desc' },
      take:    10,
    });

    if (logs.length === 0) {
      await interaction.editReply({ content: '📭 Tidak ada audit log.' });
      return;
    }

    const lines = logs.map(l =>
      `\`${l.created_at.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\` — **${l.action}** by <@${l.actor_user_id}>`
    );

    await interaction.editReply({ content: `**Audit Log (10 terbaru):**\n${lines.join('\n')}` });
    return;
  }

  await interaction.editReply({ content: '❌ Command tidak dikenal.' });
}
