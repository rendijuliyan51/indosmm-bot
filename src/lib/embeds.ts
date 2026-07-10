import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ColorResolvable,
} from 'discord.js';
import { formatRupiah } from './pricing';
import { ENV } from '../config/env';

const GOLD   = '#F5C518' as ColorResolvable;
const DARK   = '#0D0D0D' as ColorResolvable;
const GREEN  = '#2ECC71' as ColorResolvable;
const RED    = '#E74C3C' as ColorResolvable;
const BLUE   = '#3498DB' as ColorResolvable;
const ORANGE = '#E67E22' as ColorResolvable;
const PURPLE = '#9B59B6' as ColorResolvable;

const BRAND       = 'Cellyn Community & Store';
const FOOTER_ICON = 'https://cdn.discordapp.com/embed/avatars/0.png';

const PLATFORM_EMOJI_MAP: Record<string, keyof typeof ENV.EMOJI> = {
  instagram:     'INSTAGRAM',
  tiktok:        'TIKTOK',
  youtube:       'YOUTUBE',
  facebook:      'FACEBOOK',
  twitter:       'TWITTER',
  telegram:      'TELEGRAM',
  spotify:       'SPOTIFY',
  shopee:        'SHOPEE',
  'snack video': 'SNACKVIDEO',
  github:        'GITHUB',
  pinterest:     'PINTEREST',
  line:          'LINE',
  threads:       'THREADS',
  whatsapp:      'WHATSAPP',
  linkedin:      'LINKEDIN',
};

export function getCategoryEmoji(category: string): string {
  const lower = category.toLowerCase();
  for (const [key, envKey] of Object.entries(PLATFORM_EMOJI_MAP)) {
    if (lower.includes(key)) return ENV.EMOJI[envKey];
  }
  return '🔷';
}

function footer() {
  return { text: `${BRAND} • ALL IN ONE`, iconURL: FOOTER_ICON };
}

function wibTime(): string {
  return new Date().toLocaleString('id-ID', {
    timeZone:  'Asia/Jakarta',
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' WIB';
}

function truncateForDropdown(name: string): string {
  if (name.length <= 100) return name;
  return name.slice(0, 97) + '...';
}

export function parseServiceInfo(name: string, description?: string | null): string {
  const text  = name + ' ' + (description || '');
  const lines: string[] = [];

  const qualityMatch = text.match(/HQ|LQ|High Quality|Real|Arab|Indonesia|Global|Premium|Old Accounts/i);
  if (qualityMatch) lines.push(`⭐ Quality    : **${qualityMatch[0]}**`);

  const startMatch = text.match(/Instant(?:\s+Start)?|\[Start[:\s]+([^\]]+)\]|Start[:\s]+(\S+)/i);
  if (startMatch) {
    const val = startMatch[1] || startMatch[2] || startMatch[0];
    lines.push(`⏱️ Start      : **${val.trim()}**`);
  }

  const speedMatch = text.match(/Day\s+([\d]+[KkMm])|Speed[:\s]+([\d]+[KkMm][^\],\s]*)/i);
  if (speedMatch) {
    const val = speedMatch[1] || speedMatch[2];
    lines.push(`⚡ Speed      : **${val.trim()}**`);
  }

  const dropMatch = text.match(/Drop\s+([\d]+-[\d]+%)/i);
  if (dropMatch) lines.push(`📉 Drop Rate  : **${dropMatch[1]}**`);

  const refillMatch = text.match(/(\d+)\s*Days?\s*Refill|Refill[:\s]+(\d+\s*Days?)/i);
  if (refillMatch) {
    const val = refillMatch[1] ? `${refillMatch[1]} Hari` : refillMatch[2];
    lines.push(`♻️ Refill     : **${val}**`);
  } else if (/no refill/i.test(text)) {
    lines.push(`♻️ Refill     : **Tidak tersedia**`);
  }

  const cancelMatch = text.match(/Cancel\s*Enable/i);
  if (cancelMatch) lines.push(`🚫 Cancel     : **Enable**`);

  const linkMatch = text.match(/link format[:\s]+([^\n|]+)/i);
  if (linkMatch) lines.push(`🔗 Link Format: **${linkMatch[1].trim()}**`);

  return lines.length > 0 ? lines.join('\n') : '_Info tidak tersedia — lihat nama layanan_';
}

const GENERAL_RULES = [
  'Pastikan link/username benar sesuai format layanan yang tertera',
  'Jangan order layanan yang sama ke link yang sama secara bersamaan',
  'Akun/link yang diprivate atau dihapus = order otomatis completed, tidak ada refund',
  'Kesalahan input link adalah tanggung jawab pembeli sepenuhnya',
  'Komplain/report hanya diterima setelah 24 jam order dikirim',
  'Harga sudah final, tidak bisa dinegosiasi',
  'Pembayaran tidak bisa direfund setelah admin approve',
  'Jika order partial/cancelled, hubungi admin di ticket',
  'Proses refill memakan waktu 3-5 hari kerja, tidak dipantau otomatis',
  'Order diproses otomatis setelah payment dikonfirmasi admin',
  'Keluar server saat garansi aktif = garansi hangus otomatis',
];

export function buildServiceDetailEmbed(service: {
  id: string; name: string; category: string;
  description?: string | null; min: number; max: number;
  price_sell: number; refill: boolean; refill_days: number;
}): EmbedBuilder {
  const emoji    = getCategoryEmoji(service.category);
  const infoText = parseServiceInfo(service.name, service.description);
  const rules    = GENERAL_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');

  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${emoji} Detail Layanan`)
    .setDescription(`**${service.name}**`)
    .addFields(
      {
        name:  '📋 Info Layanan',
        value: infoText +
               `\n\nMin      : **${service.min.toLocaleString('id-ID')}**\n` +
               `Max      : **${service.max.toLocaleString('id-ID')}**\n` +
               `Harga    : **${formatRupiah(service.price_sell)}/1000**`,
        inline: false,
      },
      {
        name:  '⚠️ Syarat & Ketentuan — Wajib Dibaca Sebelum Order',
        value: `> ⚠️ **BACA SEBELUM ORDER!**\n> Dengan melanjutkan order, kamu menyetujui semua ketentuan berikut:\n\n${rules}`,
        inline: false,
      },
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildServiceDetailButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('catalog_order_now')
      .setLabel('Saya Mengerti — Order Sekarang')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('catalog_cancel_order')
      .setLabel('Batal')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildCatalogEmbed(categories: string[]): EmbedBuilder {
  const platformList = categories
    .map(c => `${getCategoryEmoji(c)} **${c}**`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('LAYANAN SMM (SOSIAL MEDIA MARKETING)')
    .setDescription(
      'Tingkatkan eksistensi sosial media kamu\n' +
      'bersama layanan terpercaya kami.\n\n' +
      '**Proses cepat • Harga terjangkau • Bergaransi**\n\n' +
      'Pilih platform untuk melihat layanan\n' +
      'yang tersedia beserta harga terbaik kami.\n\n' +
      platformList
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildCategorySelectMenu(categories: string[]): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('catalog_select_category')
      .setPlaceholder('Pilih Platform')
      .addOptions(categories.map(c => ({
        label: c,
        value: c.toLowerCase(),
        emoji: getCategoryEmoji(c),
      })))
  );
}

export function buildServiceTypeSelectMenu(types: string[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const TYPE_EMOJI: Record<string, string> = {
    'followers':   '👥',
    'likes':       '❤️',
    'views':       '👁️',
    'comments':    '💬',
    'share':       '🔁',
    'subscribers': '🔔',
    'members':     '👤',
    'plays':       '▶️',
    'retweet':     '🔄',
    'saves':       '🔖',
    'impressions': '📊',
    'other':       '🔷',
  };

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('catalog_select_type')
      .setPlaceholder('Pilih Jenis Layanan')
      .addOptions(types.slice(0, 25).map(t => ({
        label: t,
        value: t.toLowerCase(),
        emoji: TYPE_EMOJI[t.toLowerCase()] || '🔷',
      })))
  );
}

export const SERVICE_PAGE_SIZE = 25;

type ServiceOption = { id: string; name: string; price_sell: number; min: number; max: number };

/**
 * Membangun dropdown layanan dengan pagination. Discord membatasi 25 opsi per select menu,
 * jadi jika layanan > 25 kita tampilkan per halaman + tombol navigasi Prev/Next.
 * Mengembalikan array ActionRow (select + baris navigasi opsional).
 */
export function buildServiceSelectRows(
  services: ServiceOption[],
  page = 0,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const totalPages = Math.max(1, Math.ceil(services.length / SERVICE_PAGE_SIZE));
  const current    = Math.min(Math.max(0, page), totalPages - 1);
  const start      = current * SERVICE_PAGE_SIZE;
  const slice      = services.slice(start, start + SERVICE_PAGE_SIZE);

  const select = new StringSelectMenuBuilder()
    .setCustomId('catalog_select_service')
    .setPlaceholder(totalPages > 1 ? `Pilih Layanan (Hal ${current + 1}/${totalPages})` : 'Pilih Layanan')
    .addOptions(slice.map(s => ({
      label:       truncateForDropdown(s.name),
      value:       s.id,
      description: `${formatRupiah(s.price_sell)}/1000 • Min: ${s.min.toLocaleString('id-ID')} • Max: ${s.max.toLocaleString('id-ID')}`,
    })));

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(select),
  ];

  if (totalPages > 1) {
    const nav = new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`catalog_svc_page_${current - 1}`)
        .setLabel('◀ Sebelumnya')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current === 0),
      new ButtonBuilder()
        .setCustomId(`catalog_svc_page_${current + 1}`)
        .setLabel('Berikutnya ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current >= totalPages - 1),
    );
    rows.push(nav);
  }

  return rows;
}

export function buildInvoiceEmbed(data: {
  orderId: string; username: string; serviceName: string;
  category: string; targetLink: string; quantity: number;
  total: number; qrisUrl: string;
}): EmbedBuilder {
  const emoji = getCategoryEmoji(data.category);
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('Invoice Pesanan')
    .setDescription(
      `Hei <@${data.username}>! Berikut detail pesanan kamu\n\n` +
      `Layanan  → ${emoji} ${data.serviceName}\n` +
      `Target   → ${data.targetLink}\n` +
      `Jumlah   → ${data.quantity.toLocaleString('id-ID')}\n` +
      `Total    → **${formatRupiah(data.total)}**\n\n` +
      `Bayar via QRIS di bawah, lalu\nupload bukti transfer di sini ya!\n\n` +
      `\`Order ID: ${data.orderId.slice(0, 8)}\``
    )
    .setImage(data.qrisUrl)
    .setFooter(footer())
    .setTimestamp();
}

export function buildPaymentActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`payment_approve_${ticketId}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`payment_reject_${ticketId}`)
      .setLabel('Reject')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

const STATUS_CONFIG: Record<string, { color: ColorResolvable; emoji: string; label: string }> = {
  pending:         { color: BLUE,   emoji: '📋', label: 'Pending (Antrian)'          },
  waiting_payment: { color: ORANGE, emoji: '⏳', label: 'Menunggu Pembayaran'        },
  paid:            { color: BLUE,   emoji: '💳', label: 'Pembayaran Diterima'        },
  submitted:       { color: BLUE,   emoji: '📤', label: 'Order Dikirim ke Provider'  },
  processing:      { color: BLUE,   emoji: '⚙️', label: 'Sedang Diproses'            },
  inprogress:      { color: BLUE,   emoji: '⚙️', label: 'Sedang Diproses'            },
  'in progress':   { color: BLUE,   emoji: '⚙️', label: 'Sedang Diproses'            },
  partial:         { color: ORANGE, emoji: '⚠️', label: 'Partial (Sebagian)'         },
  completed:       { color: GREEN,  emoji: '✅', label: 'Selesai'                    },
  cancelled:       { color: RED,    emoji: '❌', label: 'Dibatalkan'                 },
  canceled:        { color: RED,    emoji: '❌', label: 'Dibatalkan'                 },
  failed:          { color: RED,    emoji: '❌', label: 'Gagal'                      },
  refill_pending:  { color: PURPLE, emoji: '🔄', label: 'Refill Sedang Diproses'     },
  error:           { color: RED,    emoji: '❌', label: 'Error'                      },
};

export function buildOrderProgressEmbed(data: {
  orderId: string; serviceName: string; category: string;
  targetLink: string; quantity: number; total: number; status: string;
  startCount?: number | null; remains?: number | null;
  progressBar?: string | null; refillExpiresAt?: Date | null;
  providerOrderId?: string | null;
}): EmbedBuilder {
  const normalizedStatus = data.status.toLowerCase().trim();
  const cfg   = STATUS_CONFIG[normalizedStatus] ?? { color: DARK, emoji: '🔷', label: data.status };
  const emoji = getCategoryEmoji(data.category);

  let desc =
    `${cfg.emoji} **${cfg.label}**\n\n` +
    `Layanan  : ${emoji} ${data.serviceName}\n` +
    `Target   : ${data.targetLink}\n` +
    `Jumlah   : ${data.quantity.toLocaleString('id-ID')}\n` +
    `Total    : ${formatRupiah(data.total)}`;

  if (data.progressBar) {
    desc += `\n\n\`${data.progressBar}\``;
  }

  if (data.startCount != null && data.remains != null) {
    desc += `\nRemains  : ${data.remains.toLocaleString('id-ID')} dari ${data.quantity.toLocaleString('id-ID')}`;
  }

  if (data.providerOrderId) {
    desc += `\n\nProvider ID : \`${data.providerOrderId}\``;
  }

  if (data.refillExpiresAt) {
    desc += `\nGaransi     : ${data.refillExpiresAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
  }

  desc += `\n\n\`Order ID: ${data.orderId.slice(0, 8)}\``;

  return new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle('Status Pesanan')
    .setDescription(desc)
    .setFooter(footer())
    .setTimestamp();
}

export function buildOrderActionRow(data: {
  ticketId: string; supportsRefill: boolean;
  refillExpired: boolean; status: string;
}): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const normalizedStatus = data.status.toLowerCase().trim();
  if (normalizedStatus === 'completed' || normalizedStatus === 'partial') {
    if (data.supportsRefill) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`refill_request_${data.ticketId}`)
          .setLabel(data.refillExpired ? 'Garansi Expired' : 'Request Refill')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(data.refillExpired)
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_close_${data.ticketId}`)
        .setLabel('Tutup Ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
    );
  }
  return row;
}

export function buildOrderCompletedNotif(data: {
  userId: string; serviceName: string; category: string; quantity: number;
}): EmbedBuilder {
  const emoji = getCategoryEmoji(data.category);
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('Order Selesai!')
    .setDescription(
      `Hei <@${data.userId}>! Order kamu sudah selesai diproses.\n\n` +
      `${emoji} ${data.serviceName}\n` +
      `Jumlah : ${data.quantity.toLocaleString('id-ID')}\n\n` +
      `Silakan cek akun kamu sekarang.\n` +
      `Jika ada masalah, gunakan tombol **Request Refill** di bawah.`
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildOrderFailedNotif(data: {
  userId: string; serviceName: string; reason: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle('Order Gagal')
    .setDescription(
      `Hei <@${data.userId}>! Maaf, order kamu gagal diproses.\n\n` +
      `Layanan : ${data.serviceName}\n` +
      `Alasan  : ${data.reason}\n\n` +
      `Silakan hubungi admin untuk bantuan lebih lanjut.`
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildLowBalanceNotif(balance: number, threshold: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle('⚠️ Peringatan Saldo IndoSMM Menipis!')
    .setDescription(
      `Saldo akun IndoSMM kamu saat ini: **Rp ${balance.toLocaleString('id-ID')}**\n` +
      `Batas minimum: **Rp ${threshold.toLocaleString('id-ID')}**\n\n` +
      `Segera deposit saldo agar order tidak gagal!\n` +
      `Top up di: https://indosmm.id`
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildRefillEmbed(data: {
  orderId: string; status: string; requestedAt: Date;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(data.status === 'completed' ? GREEN : ORANGE)
    .setTitle('Refill Request')
    .setDescription(
      `Status   : **${data.status}**\n` +
      `Waktu    : ${data.requestedAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
      `\`Order ID: ${data.orderId.slice(0, 8)}\``
    )
    .setFooter(footer())
    .setTimestamp();
}

// Notif informatif saat order baru dibuat (belum ada bukti bayar) — TANPA tombol approve.
export function buildAdminNewOrderNotif(data: {
  ticketId: string; userId: string; serviceName: string; total: number; channelId: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('Order Baru — Menunggu Bukti Pembayaran')
    .setDescription(
      `User     : <@${data.userId}>\n` +
      `Layanan  : ${data.serviceName}\n` +
      `Total    : **${formatRupiah(data.total)}**\n` +
      `Channel  : <#${data.channelId}>\n` +
      `Waktu    : ${wibTime()}\n\n` +
      `Tombol konfirmasi akan muncul setelah user mengupload bukti transfer.\n` +
      `\`Ticket ID: ${data.ticketId.slice(0, 8)}\``
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildAdminPaymentNotif(data: {
  ticketId: string; userId: string; serviceName: string;
  total: number; proofUrl?: string;
}): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle('Pembayaran Masuk — Perlu Konfirmasi')
    .setDescription(
      `User     : <@${data.userId}>\n` +
      `Layanan  : ${data.serviceName}\n` +
      `Total    : **${formatRupiah(data.total)}**\n` +
      `Waktu    : ${wibTime()}\n` +
      `Bukti    : ${data.proofUrl ? `[Lihat Gambar](${data.proofUrl})` : 'Di ticket channel'}\n\n` +
      `\`Ticket ID: ${data.ticketId.slice(0, 8)}\``
    )
    .setFooter(footer())
    .setTimestamp();

  return { embed, row: buildPaymentActionRow(data.ticketId) };
}

export function buildTicketClosedEmbed(reason?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle('Sesi Selesai')
    .setDescription(
      (reason ? `Alasan: ${reason}\n\n` : '') +
      'Sesi order selesai. Sampai jumpa di order berikutnya!'
    )
    .setFooter(footer())
    .setTimestamp();
}

export function buildOrphanedEmbed(data: {
  ticketId: string; userId: string; reason: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle('Ticket Orphaned')
    .setDescription(
      `User     : <@${data.userId}>\n` +
      `Alasan   : ${data.reason}\n` +
      `\`Ticket ID: ${data.ticketId.slice(0, 8)}\``
    )
    .setFooter(footer())
    .setTimestamp();
}
