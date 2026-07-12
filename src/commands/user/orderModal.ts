import { ModalSubmitInteraction, ChannelType, PermissionFlagsBits, MessageFlags, AttachmentBuilder } from 'discord.js';
import { prisma } from '../../bot/client';
import { ENV } from '../../config/env';
import { logger } from '../../lib/logger';
import { calculateTotal, formatRupiah } from '../../lib/pricing';
import { buildInvoiceEmbed, buildAdminNewOrderNotif } from '../../lib/embeds';
import { buildDynamicQrisPayload, buildQrisPngBuffer } from '../../lib/qris';
import { clearSelection } from '../../lib/selectionStore';
import { mapCategory } from '../../workers/catalogWorker';
import { detectServiceType } from './catalogSelectCategory';

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

// Cek apakah yang melakukan order adalah admin (punya ADMIN_ROLE_ID). Dipakai untuk
// mengecualikan admin dari batas minimum belanja (mis. buat order tes bernominal kecil).
function isAdminMember(interaction: ModalSubmitInteraction): boolean {
  const roles = (interaction.member as any)?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(ENV.ADMIN_ROLE_ID);
  if ('cache' in roles) return roles.cache.has(ENV.ADMIN_ROLE_ID);
  return false;
}

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

  // Batasi JUMLAH ticket aktif per user (anti-spam channel), BUKAN melarang total.
  // User boleh punya beberapa order berjalan sekaligus untuk layanan/platform berbeda
  // (mis. Instagram Likes + TikTok Likes) selama belum melewati batas. Order duplikat pada
  // link + layanan yang sama tetap dicegah oleh guard di bawah. Set MAX_ACTIVE_TICKETS_PER_USER=0
  // untuk tanpa batas.
  if (ENV.MAX_ACTIVE_TICKETS_PER_USER > 0) {
    const activeTicketCount = await prisma.ticket.count({
      where: {
        discord_user_id: interaction.user.id,
        status: { notIn: ['closed', 'cancelled', 'orphaned', 'completed'] },
      },
    });

    if (activeTicketCount >= ENV.MAX_ACTIVE_TICKETS_PER_USER) {
      await interaction.editReply({
        content:
          `❌ Kamu sudah punya **${activeTicketCount}** ticket aktif (maksimal ${ENV.MAX_ACTIVE_TICKETS_PER_USER}).\n` +
          `Selesaikan atau tutup salah satu ticket dulu sebelum membuat order baru.`,
      });
      return;
    }
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

  // MINIMUM BELANJA: tolak order yang tagihannya di bawah ambang. Order kecil (mis. Rp 2.000)
  // tidak ekonomis karena deposit minimum IndoSMM Rp 10.000. Kita bantu user dengan memberi
  // tahu quantity minimal untuk mencapai minimum belanja. Set MIN_ORDER_BILL=0 untuk menonaktifkan.
  // ADMIN DIKECUALIKAN dari minimum belanja (mis. untuk order tes bernominal kecil).
  if (!isAdminMember(interaction) && ENV.MIN_ORDER_BILL > 0 && total < ENV.MIN_ORDER_BILL) {
    const perUnit     = service.price_sell / 1000;
    const minQty      = perUnit > 0 ? Math.ceil(ENV.MIN_ORDER_BILL / perUnit) : Infinity;
    const maxBill     = calculateTotal(service.price_sell, service.max);

    // Kalau bahkan pada qty maksimum pun tagihan masih di bawah minimum belanja, layanan ini
    // tidak bisa memenuhi minimum — arahkan user memilih layanan lain.
    if (minQty > service.max || maxBill < ENV.MIN_ORDER_BILL) {
      await interaction.editReply({
        content:
          `❌ Minimum belanja **${formatRupiah(ENV.MIN_ORDER_BILL)}** per order.\n` +
          `Layanan ini maksimal hanya **${formatRupiah(maxBill)}** (pada qty maksimum ${service.max.toLocaleString('id-ID')}), ` +
          `jadi tidak bisa memenuhi minimum belanja. Silakan pilih layanan lain.`,
      });
      return;
    }

    await interaction.editReply({
      content:
        `❌ Minimum belanja **${formatRupiah(ENV.MIN_ORDER_BILL)}** per order.\n` +
        `Tagihan pesananmu baru **${formatRupiah(total)}** untuk ${quantity.toLocaleString('id-ID')} qty.\n\n` +
        `👉 Pesan minimal **${minQty.toLocaleString('id-ID')}** untuk layanan ini agar mencapai minimum belanja.`,
    });
    return;
  }

  // #6: refill_expires_at TIDAK diset di sini. Countdown garansi dimulai saat order
  // di-approve & dikirim ke provider (lihat paymentHandler).

  try {
    const guild = interaction.guild!;

    // Nama channel tiket: Platform-Layanan-Username-NomorUrut (mis. instagram-likes-equality-001).
    // - Platform  : kategori yang sudah dirapikan (Instagram, TikTok, dst).
    // - Layanan   : jenis layanan (Likes, Followers, Views, dst).
    // - Username  : username Discord pembeli.
    // - NomorUrut : nomor urut tiket global (3 digit), naik terus.
    // CATATAN: Discord OTOMATIS memaksa nama channel jadi HURUF KECIL & mengganti karakter
    // non-alfanumerik dengan '-'. Jadi hasil akhirnya lowercase (instagram-likes-equality-001).
    const platform   = mapCategory(service.category) || service.category || 'order';
    const svcType    = detectServiceType(service.name);
    const ticketNo   = String((await prisma.ticket.count()) + 1).padStart(3, '0');
    const namePrefix = `${platform}-${svcType}-${interaction.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);           // sisakan ruang untuk "-NNN" (batas nama channel Discord 100 char)
    const channelName = `${namePrefix}-${ticketNo}`;

    const ticketChannel = await guild.channels.create({
      name:   channelName,
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

    // QRIS: kalau QRIS_STATIC_PAYLOAD diisi → buat QRIS DINAMIS (nominal auto sesuai tagihan).
    // Kalau tidak → pakai gambar QRIS statis (QRIS_IMAGE_URL) seperti sebelumnya.
    const invoiceFiles: AttachmentBuilder[] = [];
    let qrisImageRef = ENV.QRIS_IMAGE_URL;
    if (ENV.QRIS_STATIC_PAYLOAD) {
      try {
        const payload = buildDynamicQrisPayload(ENV.QRIS_STATIC_PAYLOAD, total);
        const png     = await buildQrisPngBuffer(payload);
        invoiceFiles.push(new AttachmentBuilder(png, { name: 'qris.png' }));
        qrisImageRef = 'attachment://qris.png';
      } catch (e: any) {
        logger.error('[OrderModal] Gagal membuat QRIS dinamis, fallback ke gambar statis', { error: e.message });
      }
    }

    const invoiceEmbed = buildInvoiceEmbed({
      orderId:     order.id,
      username:    interaction.user.id,
      serviceName: service.name,
      category:    service.category,
      targetLink:  targetLink,
      quantity:    quantity,
      total:       total,
      qrisUrl:     qrisImageRef,
      serviceId:   service.provider_service_id,
    });

    const invoiceMsg = await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds:  [invoiceEmbed],
      files:   invoiceFiles,
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
        await adminChannel.send({
          content:         `<@&${ENV.ADMIN_ROLE_ID}> pesanan baru masuk!`,
          embeds:          [embed],
          allowedMentions: { roles: [ENV.ADMIN_ROLE_ID] },
        });
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
