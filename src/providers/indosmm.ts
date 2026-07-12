import axios from 'axios';
import { ENV } from '../config/env';
import { logger } from '../lib/logger';

export interface IndoSMMService {
  service:     string;
  name:        string;
  category:    string;
  rate:        string;
  min:         string;
  max:         string;
  refill:      boolean;
  // Beberapa panel SMM mengembalikan deskripsi via field "desc", sebagian via "description".
  // Kita dukung keduanya.
  desc?:        string;
  description?: string;
}

export interface IndoSMMOrderResult {
  order?: string;
  error?: string;
}

export interface IndoSMMStatus {
  charge:      string;
  start_count: string;
  status:      string;
  remains:     string;
  currency:    string;
  error?:      string;
}

export interface IndoSMMRefillResult {
  refill?: string;
  error?:  string;
}

export interface IndoSMMRefillStatus {
  status?: string;
  error?:  string;
}

async function request(data: Record<string, unknown>, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(ENV.INDOSMM_API_URL, {
        key: ENV.INDOSMM_API_KEY,
        ...data,
      }, { timeout: 15000 });
      return res.data;
    } catch (err: unknown) {
      const isLast = i === retries - 1;
      if (isLast) throw err;
      const wait = (i + 1) * 2000;
      logger.warn(`Provider request failed, retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

export const indosmm = {
  async getServices(): Promise<IndoSMMService[]> {
    const res = await request({ action: 'services' });
    if (!Array.isArray(res)) throw new Error('Invalid services response');
    return res as IndoSMMService[];
  },

  async getBalance(): Promise<number> {
    const info = await indosmm.getBalanceInfo();
    return info.balance;
  },

  // Ambil saldo LENGKAP: nilai numerik, mata uang, dan respons mentah provider.
  // Respons mentah di-log untuk memudahkan AUDIT (mengecek nilai & mata uang asli dari IndoSMM
  // bila ada keraguan soal angka saldo yang tampil).
  async getBalanceInfo(): Promise<{ balance: number; currency: string; raw: unknown }> {
    const res = await request({ action: 'balance' }) as { balance?: string; currency?: string };
    // Parse aman: IndoSMM umumnya mengirim "12345.6700" (titik desimal, tanpa pemisah ribuan).
    // Buang karakter non-numerik (mis. "Rp"/spasi/koma ribuan) agar tidak salah baca.
    const parsed  = parseFloat(String(res?.balance ?? '0').replace(/[^0-9.\-]/g, ''));
    const balance = Number.isFinite(parsed) ? parsed : 0;
    logger.info('[Balance] Respons saldo provider (mentah)', { raw: res });
    return { balance, currency: res?.currency ?? 'IDR', raw: res };
  },

  async createOrder(serviceId: string, link: string, quantity: number): Promise<IndoSMMOrderResult> {
    const res = await request({ action: 'add', service: serviceId, link, quantity });
    return res as IndoSMMOrderResult;
  },

  async getOrderStatus(orderId: string): Promise<IndoSMMStatus> {
    const res = await request({ action: 'status', order: orderId });
    return res as IndoSMMStatus;
  },

  async requestRefill(orderId: string): Promise<IndoSMMRefillResult> {
    const res = await request({ action: 'refill', order: orderId });
    return res as IndoSMMRefillResult;
  },

  // Cek status refill pakai refill ID (BUKAN order ID). IndoSMM: action=refill_status, refill=<id>.
  // Respons bisa berupa objek { status } atau array [{ refill, status }].
  async getRefillStatus(refillId: string): Promise<IndoSMMRefillStatus> {
    const res = await request({ action: 'refill_status', refill: refillId });
    if (Array.isArray(res)) {
      const first = res[0] as { status?: string; error?: string } | undefined;
      return { status: first?.status, error: first?.error };
    }
    return res as IndoSMMRefillStatus;
  },

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const res = await request({ action: 'cancel', orders: orderIds.join(',') });
    return res;
  },
};
