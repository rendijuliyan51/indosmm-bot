import { ModalSubmitInteraction, ChannelType, PermissionFlagsBits } from 'discord.js';
import { prisma } from '../../bot/client';
import { ENV } from '../../config/env';
import { logger } from '../../lib/logger';
import { calculateTotal, getRefillExpiryDate } from '../../lib/pricing';
import { buildInvoiceEmbed, buildAdminPaymentNotif } from '../../lib/embeds';
import { selectedServiceMap } from './catalogSelectService';

function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function isValidTarget(target: string, serviceName: string): boolean {
  const lower = serviceName.toLowerCase();
  // Layanan yang pakai username (bukan URL)
  const usernameServices = ['telegram', 'twitter', 'instagram', 'tiktok', 'spotify', 'youtube'];
  const isUsername = usernameServices.some(s => lower.includes(s));
  if (isUsername && !target.startsWith('http')) return true; // username ok
  if (target.startsWith('http')) return isValidUrl(target);
  return target.length > 2; // minimal 3 karakter
}

export async function handleOrderModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const serviceId = interaction.customId.replace('order_modal_', '');
  const service   = await prisma.service.findUnique({ where: { id: serviceId } });

  if (!service) {
    await interaction.editReply({ content: '❌ Layanan tidak ditemukan.' });
    return;
  }

  const targetLink = interaction.fields.getTextInputValue('target_link').trim();
  const qtyRaw     = interaction.fields.getTextInputValue('quantity').trim();
  const quantity   = parseInt(qtyRaw);

  // Validasi quantity
  if (isNaN(quantity)) {
    await interaction.editReply({ content: '❌ Jumlah harus berupa angka.' });
    return;
  }
  if (quantity < service.min) {
    await interaction.editReply({ content: `❌ Minimum order: **${service.min.toLocaleString('id-ID')}**` });
    return;
  }
  if (quantity > service.max) {
    await interaction.editReply({ content: `❌ Maksimum order: **${service.max.toLocaleString('id-ID')}**` });
    return;
  }

  // Validasi target link
  if (!isValidTarget(targetLink, service.name)) {
    await interaction.editReply({
      content: '❌ Format link/username tidak valid. Pastikan kamu memasukkan URL atau username yang benar sesuai format layanan.',
    });
    return;
  }

  // Cek apakah user sudah punya ticket aktif
  const existingTicket = await prisma.ticket.findFirst({
    where: {
      discord_user_id: interaction.user.id,
      status: { notIn: ['closed', 'cancelled', 'orphaned', 'completed'] },
    },
  });

  if (existingTicket) {
    await interaction.editReply({
      content: `❌ Kamu masih punya ticket aktif di <#${existingTicket.ticket_channel_id}>.\nSelesaikan atau tutup ticket tersebut sebelum membuat order baru.`,
    });
    return;
  }

  const total        = calculateTotal(service.price_sell, quantity);
  const buyTotal     = calculateTotal(service.price_buy, quantity);
  const profit       = total - buyTotal;
  const refillExpiry = getRefillExpiryDate(new Date(), service.refill_days);

  try {
    const guild = interaction.guild!;
    const ticketChannel = await guild.channels.create({
      name:   `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32),
      type:   ChannelType.GuildText,
      parent: ENV.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id:    interaction.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
        },
        {
          id:    ENV.ADMIN_ROLE_ID,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        },
      ],
    });

    const ticket = await prisma.ticket.create({
      data: {
        discord_user_id:   interaction.user.id,
        guild_id:          guild.id,
        ticket_channel_id: ticketChannel.id,
        status:            'waiting_payment',
        subject:           `Order: ${service.name}`,
      },
    });

    const order = await prisma.order.create({
      data: {
        ticket_id:         ticket.id,
        user_id:           interaction.user.id,
        service_id:        service.id,
        target_link:       targetLink,
        quantity:          quantity,
        buy_price:         buyTotal,
        sell_price:        total,
        profit:            profit,
        status:            'waiting_payment',
        refill_expires_at: refillExpiry,
      },
    });

    await prisma.manualPayment.create({
      data: {
        user_id:   interaction.user.id,
        ticket_id: ticket.id,
        amount:    total,
        method:    'qris',
        status:    'pending',
      },
    });

    const invoiceEmbed = buildInvoiceEmbed({
      orderId:     order.id,
      username:    interaction.user.id,
      serviceName: service.name,
      category:    service.category,
      targetLink:  targetLink,
      quantity:    quantity,
      total:       total,
      qrisUrl:     ENV.QRIS_IMAGE_URL,
    });

    const invoiceMsg = await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds:  [invoiceEmbed],
    });

    await prisma.botMessage.create({
      data: {
        ticket_id:    ticket.id,
        message_type: 'invoice',
        channel_id:   ticketChannel.id,
        message_id:   invoiceMsg.id,
      },
    });

    // Notif admin
    try {
      const { client } = await import('../../bot/client');
      const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as any;
      if (adminChannel) {
        const { embed, row } = buildAdminPaymentNotif({
          ticketId:    ticket.id,
          userId:      interaction.user.id,
          serviceName: service.name,
          total:       total,
        });
        await adminChannel.send({ embeds: [embed], components: [row] });
      }
    } catch (e) {
      logger.error('[OrderModal] Failed to notify admin', { error: (e as any).message });
    }

    selectedServiceMap.delete(interaction.user.id);

    await interaction.editReply({
      content: `✅ Ticket berhasil dibuat! Lanjutkan di <#${ticketChannel.id}>`,
    });

    logger.info(`[OrderModal] Order ${order.id} by ${interaction.user.tag}`);
  } catch (err: any) {
    logger.error('[OrderModal] Failed', { error: err.message });
    await interaction.editReply({ content: '❌ Gagal membuat order. Coba lagi.' });
  }
}
