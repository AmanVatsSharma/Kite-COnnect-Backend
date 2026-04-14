/**
 * @file falcon-provider.adapter.ts
 * @module falcon
 * @description Resilient adapter around KiteProviderService: per-endpoint rate limiting,
 *   Redis caching, and exponential-backoff retries for all Falcon market data calls.
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-14
 */
import { Injectable, Logger } from '@nestjs/common';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { RedisService } from '@infra/redis/redis.service';
import { createHash } from 'crypto';

type RateLimitKey = 'quote' | 'ltp' | 'ohlc' | 'historical' | 'profile' | 'margins';

@Injectable()
export class FalconProviderAdapter {
  private readonly logger = new Logger(FalconProviderAdapter.name);

  constructor(
    private kite: KiteProviderService,
    private redis: RedisService,
  ) {}

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Distributed rate limiting via Redis SET NX PX (tryAcquireLock).
   * Works correctly under multi-instance horizontal scale.
   * Falls back gracefully (fail-open) when Redis is unavailable.
   */
  private async rateLimit(key: RateLimitKey): Promise<void> {
    try {
      const limits: Record<RateLimitKey, number> = {
        quote: 1, ltp: 1, ohlc: 1, historical: 3, profile: 1, margins: 1,
      };
      const rps = limits[key] || 1;
      const lockTtlMs = Math.floor(1000 / rps);
      const lockKey = `falcon:rl:http:${key}`;
      const deadline = Date.now() + 5000;
      let acquired = false;
      while (!acquired && Date.now() < deadline) {
        acquired = await this.redis.tryAcquireLock(lockKey, lockTtlMs).catch(() => true); // fail-open
        if (!acquired) await new Promise((r) => setTimeout(r, 50));
      }
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
        this.logger.warn(
          `[FalconAdapter] ${key} attempt ${attempt + 1}/${maxRetries + 1} ${retryable ? '(retryable)' : ''}`,
          e as any,
        );
        if (!retryable || attempt === maxRetries) throw e;
        await new Promise((r) => setTimeout(r, Math.min(1500 * Math.pow(2, attempt), 4000)));
      }
    }
    throw new Error('unreachable');
  }

  private tokensHash(tokens: string[]): string {
    return createHash('sha1').update([...tokens].sort().join(',')).digest('hex').slice(0, 12);
  }

  private async getFromRedis<T>(key: string): Promise<T | null> {
    try {
      return await this.redis.get<T>(key);
    } catch {
      return null;
    }
  }

  private async setToRedis(key: string, value: any, ttl: number): Promise<void> {
    try {
      await this.redis.set(key, value, ttl);
    } catch {}
  }

  // ─── LTP ──────────────────────────────────────────────────────────────────

  async getLTP(tokens: string[]): Promise<Record<string, { last_price: number | null }>> {
    await this.rateLimit('ltp');
    const out: Record<string, { last_price: number | null }> = {};
    const cachedHits: string[] = [];
    for (const t of tokens) {
      const cache = await this.getFromRedis<any>(`ltp:${t}`);
      const lp = Number(cache?.last_price);
      if (Number.isFinite(lp) && lp > 0) {
        out[t] = { last_price: lp };
        cachedHits.push(t);
      }
    }
    const remaining = tokens.filter((t) => !cachedHits.includes(t));
    if (!remaining.length) return out;
    const fresh = await this.withRetry(() => this.kite.getLTP(remaining), 'getLTP');
    for (const [k, v] of Object.entries<any>(fresh || {})) {
      const lp = Number(v?.last_price);
      out[k] = { last_price: Number.isFinite(lp) && lp > 0 ? lp : null };
      if (Number.isFinite(lp) && lp > 0) {
        await this.setToRedis(`ltp:${k}`, { last_price: lp, ts: Date.now() }, 10);
      }
    }
    tokens.forEach((t) => { if (!(t in out)) out[t] = { last_price: null }; });
    return out;
  }

  // ─── Quote ────────────────────────────────────────────────────────────────

  async getQuote(tokens: string[]): Promise<Record<string, any>> {
    await this.rateLimit('quote');
    if (!tokens.length) return {};
    const cacheKey = `falcon:quote:${this.tokensHash(tokens)}`;
    const cached = await this.getFromRedis<Record<string, any>>(cacheKey);
    if (cached) return cached;
    const data = await this.withRetry(() => this.kite.getQuote(tokens), 'getQuote');
    if (data && typeof data === 'object') {
      await this.setToRedis(cacheKey, data, 5);
    }
    return data || {};
  }

  // ─── OHLC ─────────────────────────────────────────────────────────────────

  async getOHLC(tokens: string[]): Promise<Record<string, any>> {
    await this.rateLimit('ohlc');
    if (!tokens.length) return {};
    const cacheKey = `falcon:ohlc:${this.tokensHash(tokens)}`;
    const cached = await this.getFromRedis<Record<string, any>>(cacheKey);
    if (cached) return cached;
    const data = await this.withRetry(() => this.kite.getOHLC(tokens), 'getOHLC');
    if (data && typeof data === 'object') {
      await this.setToRedis(cacheKey, data, 5);
    }
    return data || {};
  }

  // ─── Historical ───────────────────────────────────────────────────────────

  async getHistoricalData(
    token: number,
    from: string,
    to: string,
    interval: string,
    continuous = false,
    oi = false,
  ): Promise<any> {
    await this.rateLimit('historical');
    const cacheKey = `falcon:hist:${token}:${from}:${to}:${interval}:${continuous ? 1 : 0}:${oi ? 1 : 0}`;
    const cached = await this.getFromRedis<any>(cacheKey);
    if (cached) return cached;
    const data = await this.withRetry(
      () => this.kite.getHistoricalData(token, from, to, interval, continuous, oi),
      'getHistoricalData',
    );
    if (data) {
      await this.setToRedis(cacheKey, data, 3600);
    }
    return data;
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(): Promise<any> {
    await this.rateLimit('profile');
    const cacheKey = 'falcon:profile';
    const cached = await this.getFromRedis<any>(cacheKey);
    if (cached) return cached;
    const data = await this.withRetry(() => this.kite.getProfile(), 'getProfile');
    if (data) {
      await this.setToRedis(cacheKey, data, 300);
    }
    return data;
  }

  // ─── Margins ──────────────────────────────────────────────────────────────

  async getMargins(segment?: 'equity' | 'commodity'): Promise<any> {
    await this.rateLimit('margins');
    const cacheKey = `falcon:margins:${segment || 'all'}`;
    const cached = await this.getFromRedis<any>(cacheKey);
    if (cached) return cached;
    const data = await this.withRetry(() => this.kite.getMargins(segment), 'getMargins');
    if (data) {
      await this.setToRedis(cacheKey, data, 60);
    }
    return data;
  }
}
