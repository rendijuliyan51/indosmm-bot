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
    const res = await request({ action: 'balance' }) as { balance?: string };
    return parseFloat(res?.balance || '0');
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

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const res = await request({ action: 'cancel', orders: orderIds.join(',') });
    return res;
  },
};
