import { ButtonInteraction, MessageFlags } from 'discord.js';
import { prisma } from '../../bot/client';
import { indosmm } from '../../providers/indosmm';
import { logger } from '../../lib/logger';
import { isRefillExpired, getRefillExpiryDate } from '../../lib/pricing';

const REFILLABLE_ORDER_STATUSES = ['completed', 'partial'];

export interface RefillClaimResult {
  ok:      boolean;
  message: string;
}

/**
 * Inti proses klaim refill — TIDAK bergantung pada channel tiket, sehingga bisa dipanggil dari
 * mana saja: tombol di dalam tiket MAUPUN command /order refill (walau tiket sudah ditutup).
 *
 * @param orderInput  ID order (boleh 8 karakter awal atau ID penuh).
 * @param requesterId ID user yang mengklaim. Jika null → lewati cek kepemilikan (konteks tepercaya
 *                    seperti tombol di channel tiket yang aksesnya sudah dibatasi, atau admin).
 */
export async function claimRefill(orderInput: string, requesterId: string | null): Promise<RefillClaimResult> {
  const input = orderInput.trim();
  if (!input) return { ok: false, message: '❌ ID order tidak boleh kosong.' };

  const order = await prisma.order.findFirst({
    where: {
      id: { startsWith: input },
      ...(requesterId ? { user_id: requesterId } : {}),
    },
    orderBy: { created_at: 'desc' },
  });

  if (!order) {
    return { ok: false, message: '❌ Order tidak ditemukan (atau bukan milik kamu). Cek ID order di `/order history`.' };
  }

  const service = await prisma.service.findUnique({ where: { id: order.service_id } });
  if (!service || !service.refill) {
    return { ok: false, message: '❌ Layanan ini tidak mendukung refill/garansi.' };
  }

  if (!REFILLABLE_ORDER_STATUSES.includes(order.status.toLowerCase().trim())) {
    return { ok: false, message: '❌ Refill hanya bisa diklaim setelah order **selesai** (completed/partial).' };
  }

  if (!order.provider_order_id) {
    return { ok: false, message: '❌ Order ini belum punya provider order ID, jadi belum bisa direfill.' };
  }

  // Fallback untuk order LAMA yang refill_expires_at-nya null (mis. dibuat saat deteksi refill
  // masih bermasalah sehingga masa garansi tak sempat diset): hitung dari created_at + masa
  // garansi layanan, agar order yang seharusnya masih bergaransi tetap bisa diklaim.
  const effectiveExpiry = order.refill_expires_at
    ?? (service.refill_days > 0 ? getRefillExpiryDate(order.created_at, service.refill_days) : null);
  if (isRefillExpired(effectiveExpiry)) {
    return { ok: false, message: '❌ Masa garansi refill untuk order ini sudah habis.' };
  }

  // Cegah dobel klaim: kalau masih ada refill 'pending' untuk order ini, jangan kirim lagi.
  const pending = await prisma.refillRequest.findFirst({
    where: { order_id: order.id, status: 'pending' },
  });
  if (pending) {
    return { ok: false, message: '⏳ Sudah ada permintaan refill yang masih diproses untuk order ini. Mohon tunggu sampai selesai.' };
  }

  try {
    const result = await indosmm.requestRefill(order.provider_order_id);
    if (result.error) throw new Error(result.error);

    await prisma.refillRequest.create({
      data: {
        order_id:           order.id,
        ticket_id:          order.ticket_id,
        provider_refill_id: result.refill || null,
        status:             'pending',
      },
    });

    logger.info(`[Refill] Refill requested for order ${order.id} (by ${requesterId ?? 'trusted-context'})`);
    return {
      ok:      true,
      message:
        `✅ Permintaan refill untuk order \`${order.id.slice(0, 8)}\` berhasil dikirim ke provider.\n` +
        `Kamu akan diberi tahu (lewat DM) begitu refill selesai.`,
    };
  } catch (err: any) {
    logger.error('[Refill] Failed', { error: err.message });
    return { ok: false, message: `❌ Gagal request refill: ${err.message}` };
  }
}

// Handler tombol "Request Refill" yang ada di dalam channel tiket. Channel tiket aksesnya sudah
// dibatasi (hanya pemilik & admin), jadi konteksnya tepercaya → lewati cek kepemilikan.
export async function handleRefillRequest(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticketId = interaction.customId.replace('refill_request_', '');
  const order = await prisma.order.findFirst({
    where:   { ticket_id: ticketId },
    orderBy: { created_at: 'desc' },
  });

  if (!order) {
    await interaction.editReply({ content: '❌ Order tidak ditemukan.' });
    return;
  }

  const res = await claimRefill(order.id, null);
  await interaction.editReply({ content: res.message });
}
