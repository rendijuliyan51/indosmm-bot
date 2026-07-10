import { Message, TextChannel } from 'discord.js';
import { prisma } from '../client';
import { logger } from '../../lib/logger';
import { ENV } from '../../config/env';
import { buildAdminPaymentNotif } from '../../lib/embeds';

function isImageAttachment(name: string | null, contentType: string | null): boolean {
  if (contentType && contentType.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(name || '');
}

/**
 * Menangkap bukti pembayaran yang diupload user di channel ticket.
 * Ketika user (pemilik ticket) mengirim gambar saat status masih waiting_payment:
 *  - simpan URL bukti ke ManualPayment.proof_url
 *  - kirim notif ke channel admin LENGKAP dengan tombol Approve/Reject + link bukti
 * Memerlukan privileged intent MessageContent untuk membaca attachment.
 */
export async function handleMessageCreate(message: Message): Promise<void> {
  try {
    if (message.author.bot || !message.guild) return;
    if (message.attachments.size === 0) return;

    const ticket = await prisma.ticket.findUnique({
      where: { ticket_channel_id: message.channelId },
    });
    if (!ticket) return;
    if (ticket.discord_user_id !== message.author.id) return;
    if (ticket.status !== 'waiting_payment') return;

    const image = message.attachments.find(a => isImageAttachment(a.name, a.contentType));
    if (!image) return;

    const payment = await prisma.manualPayment.findFirst({
      where:   { ticket_id: ticket.id },
      orderBy: { created_at: 'desc' },
    });
    if (!payment || payment.status !== 'pending') return;

    // Notif admin (dengan tombol) hanya dikirim SEKALI, yaitu saat bukti pertama diupload.
    // Upload berikutnya cuma memperbarui proof_url agar tidak spam tombol Approve ke admin.
    const isFirstProof = !payment.proof_url;

    await prisma.manualPayment.update({
      where: { id: payment.id },
      data:  { proof_url: image.url },
    });

    if (isFirstProof) {
      const order   = await prisma.order.findFirst({ where: { ticket_id: ticket.id } });
      const service = order ? await prisma.service.findUnique({ where: { id: order.service_id } }) : null;

      const adminChannel = await message.client.channels
        .fetch(ENV.ADMIN_LOG_CHANNEL_ID)
        .catch(() => null) as TextChannel | null;

      if (adminChannel) {
        const { embed, row } = buildAdminPaymentNotif({
          ticketId:    ticket.id,
          userId:      ticket.discord_user_id,
          serviceName: service?.name || 'Unknown',
          total:       payment.amount,
          proofUrl:    image.url,
        });
        await adminChannel.send({ embeds: [embed], components: [row] });
      }
    }

    await message.reply('🧾 Bukti pembayaran diterima! Admin akan segera memverifikasi. Mohon tunggu ya.')
      .catch(() => {});

    logger.info(`[Proof] Payment proof received for ticket ${ticket.id} (first=${isFirstProof})`);
  } catch (err: any) {
    logger.error('[MessageCreate] Failed to process message', { error: err.message });
  }
}
