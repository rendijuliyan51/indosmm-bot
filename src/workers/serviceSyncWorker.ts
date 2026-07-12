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

// Jumlah operasi tulis per transaksi. Menulis dalam batch transaksi jauh lebih cepat di SQLite
// (satu commit per batch, bukan satu commit per baris).
const WRITE_CHUNK = 300;

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

    // OPTIMASI: ambil SEMUA service existing dalam SATU query (bukan findUnique per item).
    // Sebelumnya loop 2600+ layanan masing-masing melakukan findUnique + upsert secara
    // berurutan (~70 detik). Sekarang baca sekali ke Map, proses di memori, lalu tulis
    // dalam batch transaksi.
    const existingList = await prisma.service.findMany({ where: { provider_name: 'IndoSMM' } });
    const existingMap  = new Map(existingList.map(e => [e.provider_service_id, e]));

    // Kumpulkan operasi tulis (lazy PrismaPromise; belum dieksekusi sampai masuk $transaction).
    const writeOps: any[] = [];
    let changedCount = 0;
    const now = new Date();

    for (const s of filtered) {
      const providerServiceId = String(s.service);
      const buyPrice    = parseFloat(s.rate);

      // PENENTUAN SUPPORT REFILL (akurat):
      // Sumber kebenaran utama = flag `refill` dari API IndoSMM (paling bisa dipercaya karena
      // datang langsung dari provider). Nama layanan HANYA dipakai sebagai pelengkap:
      //   - Kalau nama menyebut "no refill" secara eksplisit → PAKSA false (hindari menjanjikan
      //     garansi yang tak ada).
      //   - Kalau flag API tidak tersedia (bukan boolean) → jatuh ke isyarat nama.
      // Ini mencegah salah tandai layanan refill/non-refill hanya karena kata "refill" muncul
      // di nama.
      const nameSaysNoRefill = /no\s*refill/i.test(s.name);
      const apiRefill        = typeof s.refill === 'boolean' ? s.refill : undefined;
      const refill           = nameSaysNoRefill ? false : (apiRefill ?? parseRefillSupport(s.name));

      // MASA GARANSI (hari): coba baca dari nama ("Refill: 30 Days" / "Lifetime"). Kalau layanan
      // mendukung refill TAPI harinya tidak tercantum (hasil parse 0), pakai default dari ENV,
      // supaya garansi tidak langsung dianggap expired & refill benar-benar bisa diklaim.
      let refillDays = parseRefillDays(s.name);
      if (refill && refillDays === 0 && ENV.REFILL_DEFAULT_DAYS > 0) {
        refillDays = ENV.REFILL_DEFAULT_DAYS;
      }

      const min         = parseInt(s.min);
      const max         = parseInt(s.max);
      // Deskripsi dari provider bisa datang lewat "description" atau "desc".
      const providerDesc = (s.description ?? s.desc ?? '').trim() || null;

      const existing = existingMap.get(providerServiceId);

      // PENTING: pertahankan markup kustom per-layanan saat update (jangan reset ke default).
      //   - UPDATE → pakai markup_value milik service yang sudah tersimpan
      //   - CREATE → pakai markup default dari ENV
      const createMarkup = ENV.MARKUP_PERCENTAGE;
      const updateMarkup = existing?.markup_value ?? ENV.MARKUP_PERCENTAGE;
      const sellPriceUpdate = calculateSellPrice(buyPrice, updateMarkup);
      const sellPriceCreate = calculateSellPrice(buyPrice, createMarkup);

      // Snapshot hanya ditulis saat data provider berubah (hindari ribuan baris identik).
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

      writeOps.push(prisma.service.upsert({
        where:  { provider_service_id: providerServiceId },
        update: {
          name:           s.name,
          category:       s.category,
          description:    providerDesc,
          // description_override & markup_value TIDAK diubah (jaga setelan manual admin).
          min,
          max,
          price_buy:      buyPrice,
          price_sell:     sellPriceUpdate,
          refill,
          refill_days:    refillDays,
          active:         true,
          last_synced_at: now,
          updated_at:     now,
        },
        create: {
          provider_name:       'IndoSMM',
          provider_service_id: providerServiceId,
          category:            s.category,
          name:                s.name,
          description:         providerDesc,
          min,
          max,
          price_buy:           buyPrice,
          price_sell:          sellPriceCreate,
          markup_type:         'percentage',
          markup_value:        createMarkup,
          refill,
          refill_days:         refillDays,
          active:              true,
          last_synced_at:      now,
        },
      }));

      if (changed) {
        changedCount++;
        writeOps.push(prisma.serviceSnapshot.create({
          data: {
            service_id: providerServiceId,
            raw_json:   JSON.stringify(s),
            fetched_at: startedAt,
          },
        }));
      }
    }

    // Eksekusi semua tulisan dalam batch transaksi.
    for (let i = 0; i < writeOps.length; i += WRITE_CHUNK) {
      await prisma.$transaction(writeOps.slice(i, i + WRITE_CHUNK));
    }

    // Nonaktifkan layanan yang tidak lagi ada di provider.
    await prisma.service.updateMany({
      where: {
        provider_name:       'IndoSMM',
        provider_service_id: { notIn: Array.from(providerIds) },
        active:              true,
      },
      data: { active: false, updated_at: now },
    });

    await prisma.providerSyncLog.create({
      data: {
        provider_name: 'IndoSMM',
        status:        'success',
        message:       `Synced ${filtered.length} services (${changedCount} changed)`,
      },
    });

    const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    logger.info(`[ServiceSync] Sync completed in ${elapsed}s — ${filtered.length} services, ${changedCount} snapshot(s)`);
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
