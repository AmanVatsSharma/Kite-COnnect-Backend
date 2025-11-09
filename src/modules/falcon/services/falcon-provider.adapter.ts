import { Injectable, Logger } from '@nestjs/common';
import { KiteProviderService } from '../../../providers/kite-provider.service';
import { RedisService } from '../../../services/redis.service';

/**
 * FalconProviderAdapter
 *
 * A thin adapter around KiteProviderService that adds:
 * - Per-endpoint rate limiting aligned to Kite docs
 * - Memory + Redis LTP caching helpers (write-through)
 * - Basic retries on network/transient failures
 *
 * This adapter is used by Falcon REST endpoints. It does not modify the core provider.
 */
@Injectable()
export class FalconProviderAdapter {
  private readonly logger = new Logger(FalconProviderAdapter.name);
  private lastReqAt: Record<string, number> = {};

  constructor(
    private kite: KiteProviderService,
    private redis: RedisService,
  ) {}

  private async rateLimit(key: 'quote' | 'ltp' | 'ohlc' | 'history') {
    try {
      // Defaults based on Kite docs (req/sec)
      const limits: Record<string, number> = {
        quote: 1,
        ltp: 1,
        ohlc: 1,
        history: 3,
      };
      const rps = limits[key] || 1;
      const minInterval = Math.floor(1000 / rps);
      const now = Date.now();
      const last = this.lastReqAt[key] || 0;
      const elapsed = now - last;
      if (elapsed < minInterval) {
        const sleep = minInterval - elapsed;
        await new Promise((r) => setTimeout(r, sleep));
      }
      this.lastReqAt[key] = Date.now();
    } catch {}
  }

  private isRetryable(e: any): boolean {
    const status = e?.response?.status;
    const code = e?.code;
    if (status && (status >= 500 || status === 429)) return true;
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(code))) return true;
    if (e?.message && /timeout/i.test(String(e.message))) return true;
    return false;
  }

  private async withRetry<T>(op: () => Promise<T>, key: string, maxRetries = 2): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await op();
      } catch (e) {
        const retryable = this.isRetryable(e);
        this.logger.warn(`[FalconAdapter] ${key} attempt ${attempt + 1}/${maxRetries + 1} ${retryable ? '(retryable)' : ''}`, e as any);
        if (!retryable || attempt === maxRetries) throw e;
        const backoff = Math.min(1500 * Math.pow(2, attempt), 4000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error('unreachable');
  }

  async getLTP(tokens: string[]): Promise<Record<string, { last_price: number | null }>> {
    await this.rateLimit('ltp');
    const out: Record<string, { last_price: number | null }> = {};
    const cachedHits: string[] = [];
    // Try Redis cache
    for (const t of tokens) {
      try {
        const cache: any = await this.redis.get(`ltp:${t}`);
        const lp = Number(cache?.last_price);
        if (Number.isFinite(lp) && lp > 0) {
          out[t] = { last_price: lp };
          cachedHits.push(t);
        }
      } catch {}
    }
    const remaining = tokens.filter((t) => !cachedHits.includes(t));
    if (!remaining.length) return out;
    const fresh = await this.withRetry(
      async () => this.kite.getLTP(remaining),
      'getLTP',
    );
    for (const [k, v] of Object.entries<any>(fresh || {})) {
      const lp = Number(v?.last_price);
      out[k] = { last_price: Number.isFinite(lp) && lp > 0 ? lp : null };
      if (Number.isFinite(lp) && lp > 0) {
        try {
          await this.redis.set(`ltp:${k}`, { last_price: lp, ts: Date.now() }, 10);
        } catch {}
      }
    }
    // Ensure all present
    tokens.forEach((t) => {
      if (!(t in out)) out[t] = { last_price: null };
    });
    return out;
  }
}


