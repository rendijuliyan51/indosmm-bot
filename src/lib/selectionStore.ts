import { prisma } from '../bot/client';

/**
 * Menyimpan state pilihan katalog per user di database (model CatalogSelection)
 * agar alur pemilihan tetap valid meski bot restart.
 */

export interface CatalogSelectionState {
  category: string | null;
  service_type: string | null;
  service_id: string | null;
}

export async function getSelection(userId: string): Promise<CatalogSelectionState> {
  const row = await prisma.catalogSelection.findUnique({ where: { discord_user_id: userId } });
  return {
    category:     row?.category ?? null,
    service_type: row?.service_type ?? null,
    service_id:   row?.service_id ?? null,
  };
}

// Set kategori & reset pilihan turunannya (type + service).
export async function setCategory(userId: string, category: string): Promise<void> {
  await prisma.catalogSelection.upsert({
    where:  { discord_user_id: userId },
    update: { category, service_type: null, service_id: null },
    create: { discord_user_id: userId, category },
  });
}

// Set jenis layanan & reset service yang dipilih.
export async function setServiceType(userId: string, serviceType: string): Promise<void> {
  await prisma.catalogSelection.upsert({
    where:  { discord_user_id: userId },
    update: { service_type: serviceType, service_id: null },
    create: { discord_user_id: userId, service_type: serviceType },
  });
}

export async function setService(userId: string, serviceId: string): Promise<void> {
  await prisma.catalogSelection.upsert({
    where:  { discord_user_id: userId },
    update: { service_id: serviceId },
    create: { discord_user_id: userId, service_id: serviceId },
  });
}

export async function clearSelection(userId: string): Promise<void> {
  await prisma.catalogSelection.deleteMany({ where: { discord_user_id: userId } });
}
