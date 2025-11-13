import { Injectable, Logger } from '@nestjs/common';

interface CacheEntry {
  value: number;
  updatedAt: number;
}

@Injectable()
export class LtpMemoryCacheService {
  private readonly logger = new Logger(LtpMemoryCacheService.name);
  private store = new Map<string, CacheEntry>();
  private order: string[] = [];
  private maxEntries = 10000; // configurable if needed
  private ttlMs = 5000; // 5s TTL

  set(token: string | number, price: number) {
    try {
      const key = token.toString();
      if (!Number.isFinite(price) || price <= 0) return;
      const now = Date.now();
      this.store.set(key, { value: price, updatedAt: now });
      this.touch(key);
      this.evictIfNeeded();
    } catch (e) {
      this.logger.debug('LTP memory set failed', e as any);
    }
  }

  get(token: string | number): number | null {
    const key = token.toString();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    this.touch(key);
    return entry.value;
  }

  getMany(
    tokens: Array<string | number>,
  ): Record<string, { last_price: number | null }> {
    const out: Record<string, { last_price: number | null }> = {};
    const now = Date.now();
    for (const t of tokens) {
      const key = t.toString();
      const entry = this.store.get(key);
      if (entry && now - entry.updatedAt <= this.ttlMs) {
        out[key] = { last_price: entry.value };
        this.touch(key);
      } else {
        out[key] = { last_price: null };
      }
    }
    return out;
  }

  /**
   * Return values even if older than ttl, as long as within staleWithinMs window.
   * Does not delete stale entries and does not move LRU order.
   */
  getManyStaleWithin(
    tokens: Array<string | number>,
    staleWithinMs: number,
  ): Record<string, { last_price: number | null }> {
    const out: Record<string, { last_price: number | null }> = {};
    const now = Date.now();
    for (const t of tokens) {
      const key = t.toString();
      const entry = this.store.get(key);
      if (entry && now - entry.updatedAt <= staleWithinMs) {
        out[key] = { last_price: entry.value };
      } else {
        out[key] = { last_price: null };
      }
    }
    return out;
  }

  /**
   * Return a single value if within staleWithinMs window.
   */
  getStaleWithin(token: string | number, staleWithinMs: number): number | null {
    const key = token.toString();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt <= staleWithinMs) {
      return entry.value;
    }
    return null;
  }

  private touch(key: string) {
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(key);
  }

  private evictIfNeeded() {
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) this.store.delete(oldest);
    }
  }
}
