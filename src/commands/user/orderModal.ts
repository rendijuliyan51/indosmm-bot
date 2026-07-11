import { ModalSubmitInteraction, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { prisma } from '../../bot/client';
import { ENV } from '../../config/env';
import { logger } from '../../lib/logger';
import { calculateTotal } from '../../lib/pricing';
import { buildInvoiceEmbed, buildAdminNewOrderNotif } from '../../lib/embeds';
import { clearSelection } from '../../lib/selectionStore';

/**
 * Validasi target order.
 * - Kalau input berupa URL → wajib http/https dengan hostname yang punya domain (mengandung titik).
 * - Layanan berbasis konten (like/view/comment/share/play/repost/retweet/save/watch) WAJIB URL,
 *   bukan sekadar username.
 * - Selain itu boleh username: hanya huruf/angka/titik/underscore/dash (opsional diawali '@'),
 *   panjang 2-100 karakter, tanpa spasi.
 */
function isValidTarget(target: string, serviceName: string): boolean {
  const t = target.trim();
  if (!t) return false;

  const lower  = serviceName.toLowerCase();
  const isUrl  = /^https?:\/\//i.test(t);
  const needsUrl = /(like|view|comment|share|play|repost|retweet|save|watch|impression)/i.test(lower);

  if (isUrl) {
    try {
      const u = new URL(t);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (!u.hostname.includes('.')) return false;
      return true;
    } catch {
      return false;
    }
  }

  if (needsUrl) return false; // layanan metrik konten wajib link, bukan username
  return /^@?[A-Za-z0-9._-]{2,100}$/.test(t);
}

// Normalisasi target untuk membandingkan kesamaan link/username (abaikan huruf besar/kecil,
// trailing slash, dan protokol http/https).
function normalizeTarget(target: string): string {
  return target
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

// Status order yang dianggap SUDAH selesai/berhenti (boleh order ulang di link yang sama).
const FINISHED_ORDER_STATUSES = ['completed', 'cancelled', 'canceled', 'failed', 'orphaned'];

export async function handleOrderModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

  // CEGAH ORDER DUPLIKAT: IndoSMM melarang menumpuk order pada LINK + LAYANAN yang sama
  // selagi order sebelumnya belum selesai — order yang menumpuk bisa dianggap "completed"
  // padahal belum tuntas. Jadi kita tolak bila masih ada order aktif untuk kombinasi ini
  // (lintas semua pembeli, karena batasannya di sisi provider).
  const normalizedNew = normalizeTarget(targetLink);
  const activeSameService = await prisma.order.findMany({
    where: {
      service_id: service.id,
      status:     { notIn: FINISHED_ORDER_STATUSES },
    },
    select: { target_link: true },
  });

  const duplicate = activeSameService.some(o => normalizeTarget(o.target_link) === normalizedNew);
  if (duplicate) {
    await interaction.editReply({
      content:
        '❌ Sudah ada order **aktif** untuk link + layanan yang sama.\n\n' +
        'IndoSMM melarang menumpuk order di link & layanan yang sama sebelum order sebelumnya selesai ' +
        '(order bisa dianggap selesai padahal belum tuntas). ' +
        'Mohon tunggu sampai order sebelumnya **completed**, lalu order lagi.',
    });
    return;
  }

  const total    = calculateTotal(service.price_sell, quantity);
  const buyTotal = calculateTotal(service.price_buy, quantity);
  const profit   = total - buyTotal;
  // #6: refill_expires_at TIDAK diset di sini. Countdown garansi dimulai saat order
  // di-approve & dikirim ke provider (lihat paymentHandler).

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

    // Notif admin (informatif). Tombol Approve/Reject baru dikirim SETELAH user upload
    // bukti transfer (lihat handler messageCreate) agar admin tidak approve tanpa bukti.
    try {
      const { client } = await import('../../bot/client');
      const adminChannel = await client.channels.fetch(ENV.ADMIN_LOG_CHANNEL_ID).catch(() => null) as any;
      if (adminChannel) {
        const embed = buildAdminNewOrderNotif({
          ticketId:    ticket.id,
          userId:      interaction.user.id,
          serviceName: service.name,
          total:       total,
          channelId:   ticketChannel.id,
        });
        await adminChannel.send({ embeds: [embed] });
      }
    } catch (e) {
      logger.error('[OrderModal] Failed to notify admin', { error: (e as any).message });
    }

    await clearSelection(interaction.user.id);

    await interaction.editReply({
      content: `✅ Ticket berhasil dibuat! Lanjutkan di <#${ticketChannel.id}>`,
    });

    logger.info(`[OrderModal] Order ${order.id} by ${interaction.user.tag}`);
  } catch (err: any) {
    logger.error('[OrderModal] Failed', { error: err.message });
    await interaction.editReply({ content: '❌ Gagal membuat order. Coba lagi.' });
  }
}
