import { ENV } from '../config/env';

export function calculateSellPrice(buyPrice: number, markupValue?: number): number {
  const markup = markupValue ?? ENV.MARKUP_PERCENTAGE;
  return buyPrice * (1 + markup / 100);
}

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function calculateTotal(sellPricePerThousand: number, quantity: number): number {
  return (sellPricePerThousand / 1000) * quantity;
}

export function parseRefillDays(serviceName: string): number {
  const match = serviceName.match(/refill[:\s]+(\d+)\s*day/i);
  if (match) return parseInt(match[1]);
  if (/\bno[\s-]*refill\b/i.test(serviceName)) return 0;
  if (/lifetime/i.test(serviceName)) return 36500;
  return 0;
}

export function parseRefillSupport(serviceName: string): boolean {
  // \b (word boundary) mencegah "no refill" salah cocok di dalam kata lain, mis. "domiNO REFILL".
  if (/\bno[\s-]*refill\b/i.test(serviceName)) return false;
  if (/\brefill\b/i.test(serviceName)) return true;
  return false;
}

export function getRefillExpiryDate(orderDate: Date, refillDays: number): Date | null {
  if (refillDays === 0) return null;
  const expiry = new Date(orderDate);
  expiry.setDate(expiry.getDate() + refillDays);
  return expiry;
}

export function isRefillExpired(expiryDate: Date | null): boolean {
  if (!expiryDate) return true;
  return new Date() > expiryDate;
}
