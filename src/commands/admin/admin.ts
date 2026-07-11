import { ChatInputCommandInteraction, TextChannel, MessageFlags, EmbedBuilder } from 'discord.js';
import { prisma } from '../../bot/client';
import { logger } from '../../lib/logger';
import { runServiceSync } from '../../workers/serviceSyncWorker';
import { mapCategory } from '../../workers/catalogWorker';
import { indosmm } from '../../providers/indosmm';
import { buildTicketClosedEmbed, buildStatsEmbed } from '../../lib/embeds';
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

  if (sub === 'stats') {
    const period = interaction.options.getString('periode') || 'week';
    const now = Date.now();
    let since: Date | null = null;
    let label = 'Semua';
    if (period === 'day')   { since = new Date(now - 24 * 60 * 60 * 1000);       label = 'Hari ini (24 jam)'; }
    if (period === 'week')  { since = new Date(now - 7 * 24 * 60 * 60 * 1000);   label = '7 Hari terakhir'; }
    if (period === 'month') { since = new Date(now - 30 * 24 * 60 * 60 * 1000);  label = '30 Hari terakhir'; }

    // Order yang dihitung sebagai penjualan = sudah dibayar hingga selesai.
    const salesStatuses = ['paid', 'submitted', 'processing', 'in progress', 'partial', 'completed'];
    const orders = await prisma.order.findMany({
      where: {
        status: { in: salesStatuses },
        ...(since ? { created_at: { gte: since } } : {}),
      },
    });

    const totalOrders     = orders.length;
    const completedOrders = orders.filter(o => o.status === 'completed').length;
    const omzet  = orders.reduce((a, o) => a + o.sell_price, 0);
    const profit = orders.reduce((a, o) => a + o.profit, 0);

    // Layanan terlaris.
    const countMap = new Map<string, number>();
    for (const o of orders) countMap.set(o.service_id, (countMap.get(o.service_id) || 0) + 1);
    const topIds = [...countMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const svc = topIds.length
      ? await prisma.service.findMany({ where: { id: { in: topIds.map(t => t[0]) } } })
      : [];
    const svcName = new Map(svc.map(s => [s.id, s.name]));
    const topServices = topIds.map(([id, count]) => ({ name: svcName.get(id) || 'Layanan', count }));

    // Rating rata-rata.
    const reviews = await prisma.review.findMany({ where: since ? { created_at: { gte: since } } : {} });
    const avgRating = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null;

    await interaction.editReply({
      embeds: [buildStatsEmbed({
        periodLabel: label, totalOrders, completedOrders, omzet, profit,
        topServices, avgRating, reviewCount: reviews.length,
      })],
    });
    return;
  }

  if (sub === 'set-markup-category') {
    const categoryInput = interaction.options.getString('kategori', true).trim();
    const value         = interaction.options.getNumber('value', true);

    await interaction.editReply({ content: `⏳ Set markup **${value}%** untuk kategori "${categoryInput}"...` });

    const all = await prisma.service.findMany({ where: { active: true } });
    const target = all.filter(s => {
      const mapped = mapCategory(s.category);
      return (mapped && mapped.toLowerCase() === categoryInput.toLowerCase())
          || s.category.toLowerCase().includes(categoryInput.toLowerCase());
    });

    if (target.length === 0) {
      await interaction.editReply({ content: `❌ Tidak ada layanan aktif untuk kategori "${categoryInput}".` });
      return;
    }

    for (const s of target) {
      await prisma.service.update({
        where: { id: s.id },
        data:  { markup_value: value, price_sell: s.price_buy * (1 + value / 100), updated_at: new Date() },
      });
    }
    await prisma.catalogMessage.updateMany({ data: { last_hash: null } });

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'set_markup_category',
        details_json:  JSON.stringify({ category: categoryInput, markup: value, services_updated: target.length }),
      },
    });

    await interaction.editReply({
      content: `✅ Markup kategori "${categoryInput}" diset ke **${value}%**\n📊 **${target.length}** layanan diperbarui. Katalog refresh otomatis.`,
    });
    return;
  }

  if (sub === 'hide-service') {
    const providerId = interaction.options.getString('service_id', true).trim();
    const hidden     = interaction.options.getBoolean('hidden', true);

    const service = await prisma.service.findUnique({ where: { provider_service_id: providerId } });
    if (!service) {
      await interaction.editReply({ content: `❌ Layanan dengan provider service ID \`${providerId}\` tidak ditemukan.` });
      return;
    }

    await prisma.service.update({ where: { id: service.id }, data: { hidden, updated_at: new Date() } });
    await prisma.catalogMessage.updateMany({ data: { last_hash: null } });

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'hide_service',
        target_type:   'service',
        target_id:     service.id,
        details_json:  JSON.stringify({ provider_service_id: providerId, hidden }),
      },
    });

    await interaction.editReply({
      content: hidden
        ? `✅ Layanan **${service.name}** disembunyikan dari katalog & pencarian.`
        : `✅ Layanan **${service.name}** ditampilkan kembali di katalog.`,
    });
    return;
  }

  if (sub === 'broadcast') {
    const chOpt = interaction.options.getChannel('channel', true);
    const pesan = interaction.options.getString('pesan', true);
    const judul = interaction.options.getString('judul') || 'Pengumuman';

    const target = await interaction.client.channels.fetch(chOpt.id).catch(() => null) as TextChannel | null;
    if (!target || !target.isTextBased()) {
      await interaction.editReply({ content: '❌ Channel tujuan tidak valid / bukan channel teks.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xF5C518)
      .setTitle(`📢 ${judul}`)
      .setDescription(pesan)
      .setTimestamp();

    try {
      await target.send({ embeds: [embed] });
    } catch (e: any) {
      await interaction.editReply({ content: `❌ Gagal kirim ke <#${chOpt.id}>: ${e.message}` });
      return;
    }

    await prisma.adminAuditLog.create({
      data: {
        actor_user_id: interaction.user.id,
        action:        'broadcast',
        target_type:   'channel',
        target_id:     chOpt.id,
      },
    });

    await interaction.editReply({ content: `✅ Pengumuman terkirim ke <#${chOpt.id}>.` });
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
