import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import Redis from 'ioredis';

type SearchResultItem = {
  instrumentToken: number;
  symbol: string;
  tradingSymbol?: string;
  companyName?: string;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  // Enriched from indexer
  expiryDate?: string;
  strike?: number;
  tick?: number;
  lotSize?: number;
  vortexExchange?: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
  ticker?: string;
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger('SearchService');
  private readonly meili: AxiosInstance;
  private readonly hydrator: AxiosInstance;
  private readonly redis?: Redis;
  private hydrationFailures = 0;
  private hydrationBreakerUntil = 0;

  constructor() {
    const meiliHost = process.env.MEILI_HOST || 'http://meilisearch:7700';
    const meiliKey = process.env.MEILI_MASTER_KEY || '';
    const hydrateBase =
      process.env.HYDRATION_BASE_URL || 'http://trading-app:3000';
    const hydrateApiKey = process.env.HYDRATION_API_KEY || 'milli-key-1';
    const redisHost = process.env.REDIS_HOST || 'redis';
    const redisPort = Number(process.env.REDIS_PORT || 6379);

    this.meili = axios.create({
      baseURL: meiliHost,
      headers: meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {},
      timeout: Number(process.env.MEILI_TIMEOUT_MS || 1200),
    });

    const defaultHydratorHeaders: Record<string, string> = {};
    if (hydrateApiKey) defaultHydratorHeaders['x-api-key'] = hydrateApiKey;
    defaultHydratorHeaders['x-provider'] = 'vayu';
    this.hydrator = axios.create({
      baseURL: hydrateBase,
      timeout: Number(process.env.HYDRATE_TIMEOUT_MS || 1500),
      headers: defaultHydratorHeaders,
    });

    // Console logs for runtime visibility
    // eslint-disable-next-line no-console
    console.log('SearchService meiliHost=', meiliHost);
    // eslint-disable-next-line no-console
    console.log('SearchService hydrateBase=', hydrateBase);
    // eslint-disable-next-line no-console
    console.log('SearchService hydration x-api-key set=', Boolean(hydrateApiKey));
    // eslint-disable-next-line no-console
    console.log('SearchService hydration x-provider=vayu');

    try {
      this.redis = new Redis({ host: redisHost, port: redisPort, lazyConnect: true });
      // Lazy connect on first use
    } catch (err) {
      this.logger.warn('Redis not initialized, continuing without cache');
    }
  }

  private async safeMeiliSearch(index: string, body: any): Promise<any> {
    try {
      const resp = await this.meili.post(`/indexes/${index}/search`, body);
      return resp.data || { hits: [] };
    } catch (err: any) {
      const code = err?.response?.status;
      const m = err?.response?.data?.message || err?.message;
      if (code === 404) {
        // Index not found or no results yet – degrade gracefully
        this.logger.warn(`Meili search 404 (likely index missing): ${m}`);
        return { hits: [] };
      }
      this.logger.error(`Meili search failed: ${m}`);
      return { hits: [] };
    }
  }

  // Starts-with boosted search then contains fallback; returns deduped list
  async searchInstruments(q: string, limit = 10, filters: any = {}) {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const attributesToRetrieve = [
      'instrumentToken',
      'symbol',
      'tradingSymbol',
      'companyName',
      'exchange',
      'segment',
      'instrumentType',
      'expiryDate',
      'strike',
      'tick',
      'lotSize',
      'vortexExchange',
      'ticker',
    ];
    const filterExpr = this.buildFilter(filters);

    const startsWith = await this.safeMeiliSearch(index, {
      q,
      limit,
      attributesToRetrieve,
      filter: filterExpr,
      matchingStrategy: 'all',
    });

    // If enough, return
    const primary: SearchResultItem[] = startsWith.hits || [];
    if (primary.length >= limit) return primary.slice(0, limit);

    // Fallback broader search (contains)
    const contains = await this.safeMeiliSearch(index, {
      q,
      limit,
      attributesToRetrieve,
      filter: filterExpr,
      matchingStrategy: 'last',
    });

    const merged = this.dedupeByToken([...primary, ...(contains.hits || [])]);
    return merged.slice(0, limit);
  }

  async facetCounts(filters: any = {}) {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const filterExpr = this.buildFilter(filters);
    const facets = ['exchange', 'segment', 'instrumentType', 'expiryDate'];
    const resp = await this.safeMeiliSearch(index, {
      q: '',
      limit: 0,
      filter: filterExpr,
      facets,
    });
    return (resp as any)?.facetDistribution || {};
  }

  async hydrateQuotes(tokens: number[], mode: 'ltp' | 'ohlc' | 'full' = 'ltp') {
    if (!tokens.length) return {};
    const now = Date.now();
    if (now < this.hydrationBreakerUntil) {
      this.logger.warn('Hydration circuit breaker open, skipping external calls');
      return {};
    }
    const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
    const cacheKey = (t: number) => `q:${mode}:${t}`;
    const result: Record<string, any> = {};
    const toFetch: number[] = [];

    // Try cache first
    if (this.redis) {
      for (const t of tokens) {
        const v = await this.redis.get(cacheKey(t));
        if (v) {
          result[String(t)] = JSON.parse(v);
        } else {
          toFetch.push(t);
        }
      }
    } else {
      toFetch.push(...tokens);
    }

    if (toFetch.length) {
      try {
        const url = mode === 'ltp'
          ? '/api/stock/vayu/ltp'
          : `/api/stock/quotes?mode=${mode}&ltp_only=true`;
        const resp = await this.hydrator.post(url, { instruments: toFetch });
        const data = resp.data?.data || {};
        Object.assign(result, data);
        if (this.redis) {
          for (const [k, v] of Object.entries(data)) {
            await this.redis.setex(
              cacheKey(Number(k)),
              Math.ceil(cacheTTL / 1000),
              JSON.stringify(v),
            );
          }
        }
        // success: reset breaker
        this.hydrationFailures = 0;
        this.hydrationBreakerUntil = 0;
      } catch (err: any) {
        this.hydrationFailures += 1;
        const openAfter = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
        const openForMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
        if (this.hydrationFailures >= openAfter) {
          this.hydrationBreakerUntil = Date.now() + openForMs;
          this.logger.warn(
            `Hydration failed ${this.hydrationFailures}x, opening circuit for ${openForMs}ms`,
          );
          this.hydrationFailures = 0;
        } else {
          this.logger.warn(`Hydration fallback failed: ${err?.message}`);
        }
      }
    }
    return result;
  }

  // Hydrate LTP by exchange-token pairs (preferred when vortexExchange is available)
  async hydrateLtpByPairs(items: SearchResultItem[]) {
    const now = Date.now();
    if (now < this.hydrationBreakerUntil) {
      this.logger.warn('Hydration circuit breaker open, skipping external calls');
      return {};
    }
    const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
    const cacheKey = (t: number) => `q:ltp:${t}`;
    const result: Record<string, any> = {};
    const pairsFromIndex: Array<{ exchange: string; token: string }> = [];
    const toFetchTokens: number[] = [];

    for (const it of items) {
      const token = it.instrumentToken;
      // Try cache by token
      if (this.redis) {
        const v = await this.redis.get(cacheKey(token));
        if (v) {
          result[String(token)] = JSON.parse(v);
          continue;
        }
      }
      if (it?.vortexExchange) {
        pairsFromIndex.push({ exchange: it.vortexExchange, token: String(token) });
      } else {
        toFetchTokens.push(token);
      }
    }

    // Build authoritative pairs from DB mapping via hydrator debug endpoint
    // Prefer DB-derived pairs when available; fall back to index-provided pairs for any gaps
    let pairsToUse: Array<{ exchange: string; token: string }> = [];
    if (pairsFromIndex.length) {
      try {
        const tokensForDb = pairsFromIndex.map((p) => p.token);
        const q = encodeURIComponent(tokensForDb.join(','));
        const url = `/api/stock/vayu/debug/build-q?tokens=${q}&mode=ltp`;
        const dbg = await this.hydrator.get(url);
        const dbgPairs: string[] = Array.isArray(dbg?.data?.pairs) ? dbg.data.pairs : [];
        // Convert to objects and also compute exchange-by-token maps for mismatch logging
        const dbPairs: Array<{ exchange: string; token: string }> = [];
        const dbExchangeByToken = new Map<string, string>();
        for (const k of dbgPairs) {
          const [ex, tok] = String(k || '').split('-');
          if (ex && tok && /^\d+$/.test(tok)) {
            dbPairs.push({ exchange: ex, token: tok });
            dbExchangeByToken.set(tok, ex);
          }
        }
        // Mismatch diagnostics
        try {
          let mismatches = 0;
          for (const p of pairsFromIndex) {
            const dbEx = dbExchangeByToken.get(p.token);
            if (dbEx && String(dbEx).toUpperCase() !== String(p.exchange).toUpperCase()) {
              mismatches++;
            }
          }
          if (mismatches > 0) this.logger.warn(`[SearchService] exchange mapping mismatches (index vs DB): ${mismatches}/${pairsFromIndex.length}`);
        } catch {}
        // Use DB pairs primarily; include index pairs for tokens not present in DB response
        const covered = new Set(dbPairs.map((p) => p.token));
        const extras = pairsFromIndex.filter((p) => !covered.has(p.token));
        pairsToUse = [...dbPairs, ...extras];
      } catch (e: any) {
        this.logger.warn(`[SearchService] DB pair mapping check failed; using index pairs. ${e?.message}`);
        pairsToUse = pairsFromIndex;
      }
    }

    // Call pairs first (using DB-validated pairs when available)
    if (pairsToUse.length) {
      try {
        const resp = await this.hydrator.post('/api/stock/vayu/ltp', { pairs: pairsToUse });
        const data = resp.data?.data || {};
        // data is keyed by EXCHANGE-TOKEN; convert to token map
        for (const [exTok, val] of Object.entries<any>(data)) {
          const tokenPart = exTok.split('-').pop();
          if (!tokenPart) continue;
          result[tokenPart] = val;
          if (this.redis) {
            await this.redis.setex(
              cacheKey(Number(tokenPart)),
              Math.ceil(cacheTTL / 1000),
              JSON.stringify(val),
            );
          }
        }
      } catch (err: any) {
        this.logger.warn(`hydrateLtpByPairs failed: ${err?.message}`);
      }
    }

    // For any remaining tokens (no exchange info), fallback to instruments
    if (toFetchTokens.length) {
      try {
        const resp = await this.hydrator.post('/api/stock/vayu/ltp', {
          instruments: toFetchTokens,
        });
        const data = resp.data?.data || {};
        Object.assign(result, data);
        if (this.redis) {
          for (const [k, v] of Object.entries(data)) {
            await this.redis.setex(
              cacheKey(Number(k)),
              Math.ceil(cacheTTL / 1000),
              JSON.stringify(v),
            );
          }
        }
      } catch (err: any) {
        this.logger.warn(`hydrateLtpByPairs fallback failed: ${err?.message}`);
      }
    }

    // Second pass: cover tokens that still have missing/invalid LTP after pairs/instruments calls
    try {
      const allTokens = items.map((i) => i.instrumentToken);
      const missingTokens = allTokens.filter((t) => {
        const v: any = result[String(t)];
        return !(v && Number.isFinite(v.last_price) && v.last_price > 0);
      });
      if (missingTokens.length) {
        this.logger.warn(
          `[SearchService] hydrateLtpByPairs: instruments fallback for ${missingTokens.length}/${allTokens.length} tokens without valid LTP`,
        );
        try {
          const resp = await this.hydrator.post('/api/stock/vayu/ltp', {
            instruments: missingTokens,
          });
          const data = resp.data?.data || {};
          Object.assign(result, data);
          if (this.redis) {
            for (const [k, v] of Object.entries(data)) {
              await this.redis.setex(
                cacheKey(Number(k)),
                Math.ceil(cacheTTL / 1000),
                JSON.stringify(v),
              );
            }
          }
        } catch (e: any) {
          this.logger.warn(
            `[SearchService] instruments second-pass fallback failed: ${e?.message}`,
          );
        }
      }
    } catch (e) {
      // non-fatal guard
    }

    return result;
  }

  // Log selection telemetry for synonym learning (best effort, non-blocking)
  async logSelectionTelemetry(q: string, symbol: string, token?: number) {
    try {
      if (!this.redis) return;
      const normQ = String(q || '').trim().toLowerCase();
      const normSym = String(symbol || '').trim().toUpperCase();
      if (!normQ || !normSym) return;
      const ttlSec = Number(process.env.SYNONYMS_TTL_DAYS || 14) * 24 * 3600;
      const pipe = this.redis.pipeline();
      const k1 = `syn:q:${normQ}:sym:${normSym}`;
      pipe.incrby(k1, 1);
      if (ttlSec > 0) pipe.expire(k1, ttlSec);
      const k2 = `syn:sym:${normSym}`;
      pipe.incrby(k2, 1);
      if (ttlSec > 0) pipe.expire(k2, ttlSec);
      if (Number.isFinite(token)) {
        const k3 = `syn:tok:${token}:q:${normQ}`;
        pipe.incrby(k3, 1);
        if (ttlSec > 0) pipe.expire(k3, ttlSec);
      }
      await pipe.exec();
    } catch (e) {
      this.logger.warn('logSelectionTelemetry failed (non-fatal)');
    }
  }

  private buildFilter(filters: any): string | undefined {
    const parts: string[] = [];
    if (!filters) return undefined;
    if (filters.exchange) parts.push(`exchange = ${JSON.stringify(filters.exchange)}`);
    if (filters.segment) parts.push(`segment = ${JSON.stringify(filters.segment)}`);
    if (filters.instrumentType) parts.push(`instrumentType = ${JSON.stringify(filters.instrumentType)}`);
    if (filters.vortexExchange) parts.push(`vortexExchange = ${JSON.stringify(filters.vortexExchange)}`);
    // Expiry date range (expects ISO-like strings)
    if (filters.expiry_from) parts.push(`expiryDate >= ${JSON.stringify(filters.expiry_from)}`);
    if (filters.expiry_to) parts.push(`expiryDate <= ${JSON.stringify(filters.expiry_to)}`);
    // Strike price range
    if (Number.isFinite(Number(filters.strike_min))) parts.push(`strike >= ${Number(filters.strike_min)}`);
    if (Number.isFinite(Number(filters.strike_max))) parts.push(`strike <= ${Number(filters.strike_max)}`);
    return parts.length ? parts.join(' AND ') : undefined;
  }

  private dedupeByToken(items: SearchResultItem[]): SearchResultItem[] {
    const seen = new Set<number>();
    const out: SearchResultItem[] = [];
    for (const it of items) {
      if (!seen.has(it.instrumentToken)) {
        seen.add(it.instrumentToken);
        out.push(it);
      }
    }
    return out;
  }
}


