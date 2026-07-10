import { prisma } from '../bot/client';
import { indosmm } from '../providers/indosmm';
import { logger } from '../lib/logger';
import { calculateSellPrice, parseRefillDays, parseRefillSupport } from '../lib/pricing';
import { ENV } from '../config/env';

const ALLOWED_CATEGORIES = [
  'instagram', 'tiktok', 'telegram', 'spotify', 'snack video',
  'youtube', 'twitter', 'shopee', 'facebook', 'roblox', 'github',
  'pinterest', 'line', 'threads', 'whatsapp', 'linkedin',
];

const MAX_PRICE_PER_1000 = 100000;

function isAllowedCategory(category: string): boolean {
  const lower = category.toLowerCase();
  return ALLOWED_CATEGORIES.some(c => lower.includes(c));
}

export async function runServiceSync(): Promise<void> {
  logger.info('[ServiceSync] Starting sync...');
  const startedAt = new Date();

  try {
    const services = await indosmm.getServices();
    logger.info(`[ServiceSync] Fetched ${services.length} services from provider`);

    const filtered = services.filter(s => {
      if (!isAllowedCategory(s.category)) return false;
      const sellPrice = calculateSellPrice(parseFloat(s.rate));
      if (sellPrice > MAX_PRICE_PER_1000) return false;
      return true;
    });

    logger.info(`[ServiceSync] ${filtered.length} services match allowed categories & price filter`);

    const providerIds = new Set(filtered.map(s => String(s.service)));

    for (const s of filtered) {
      const buyPrice   = parseFloat(s.rate);
      const refill     = parseRefillSupport(s.name) || s.refill;
      const refillDays = parseRefillDays(s.name);
      const min        = parseInt(s.min);
      const max        = parseInt(s.max);
      // Deskripsi dari provider bisa datang lewat "description" atau "desc".
      const providerDesc = (s.description ?? s.desc ?? '').trim() || null;

      const existing = await prisma.service.findUnique({
        where: { provider_service_id: String(s.service) },
      });

      // PENTING: pertahankan markup kustom per-layanan saat update. Sebelumnya price_sell
      // dihitung ulang dengan markup DEFAULT tiap sync, sehingga markup yang di-set admin
      // lewat /admin set-markup ter-reset setiap 30 menit. Sekarang:
      //   - UPDATE  → pakai markup_value milik service yang sudah tersimpan
      //   - CREATE  → pakai markup default dari ENV
      const createMarkup = ENV.MARKUP_PERCENTAGE;
      const updateMarkup = existing?.markup_value ?? ENV.MARKUP_PERCENTAGE;
      const sellPriceUpdate = calculateSellPrice(buyPrice, updateMarkup);
      const sellPriceCreate = calculateSellPrice(buyPrice, createMarkup);

      // Deteksi perubahan pada data provider agar snapshot hanya ditulis saat ada perubahan
      // (menghindari ribuan baris snapshot identik tiap sync).
      const changed =
        !existing ||
        existing.name        !== s.name ||
        existing.category    !== s.category ||
        existing.description !== providerDesc ||
        existing.min         !== min ||
        existing.max         !== max ||
        existing.price_buy   !== buyPrice ||
        existing.refill      !== refill ||
        existing.refill_days !== refillDays ||
        !existing.active;

      await prisma.service.upsert({
        where:  { provider_service_id: String(s.service) },
        update: {
          name:           s.name,
          category:       s.category,
          description:    providerDesc,
          // description_override TIDAK diubah agar deskripsi manual admin tetap terjaga.
          min,
          max,
          price_buy:      buyPrice,
          // markup_value TIDAK diubah agar markup kustom admin tetap terjaga.
          price_sell:     sellPriceUpdate,
          refill:         refill,
          refill_days:    refillDays,
          active:         true,
          last_synced_at: new Date(),
          updated_at:     new Date(),
        },
        create: {
          provider_name:       'IndoSMM',
          provider_service_id: String(s.service),
          category:            s.category,
          name:                s.name,
          description:         providerDesc,
          min,
          max,
          price_buy:           buyPrice,
          price_sell:          sellPriceCreate,
          markup_type:         'percentage',
          markup_value:        createMarkup,
          refill:              refill,
          refill_days:         refillDays,
          active:              true,
          last_synced_at:      new Date(),
        },
      });

      if (changed) {
        await prisma.serviceSnapshot.create({
          data: {
            service_id: String(s.service),
            raw_json:   JSON.stringify(s),
            fetched_at: startedAt,
          },
        });
      }
    }

    await prisma.service.updateMany({
      where: {
        provider_name:       'IndoSMM',
        provider_service_id: { notIn: Array.from(providerIds) },
        active:              true,
      },
      data: { active: false, updated_at: new Date() },
    });

    await prisma.providerSyncLog.create({
      data: {
        provider_name: 'IndoSMM',
        status:        'success',
        message:       `Synced ${filtered.length} services`,
      },
    });

    logger.info('[ServiceSync] Sync completed successfully');
  } catch (error: any) {
    logger.error('[ServiceSync] Sync failed', { error: error.message });
    await prisma.providerSyncLog.create({
      data: {
        provider_name:     'IndoSMM',
        status:            'error',
        message:           error.message,
        raw_response_json: JSON.stringify(error),
      },
    });
  }
}
