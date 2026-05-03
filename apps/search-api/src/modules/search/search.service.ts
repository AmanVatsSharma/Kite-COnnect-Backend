/**
 * @file apps/search-api/src/modules/search/search.service.ts
 * @module search-api
 * @description MeiliSearch-backed instrument search service with 2-server failover,
 *              LTP hydration from the trading-app, and Redis result caching.
 *              Documents are keyed by universal_instruments.id (not broker token).
 *
 * Exports:
 *   - SearchService              — NestJS injectable service
 *   - SearchResultItem           — internal shape of one search result document (full)
 *   - StreamProviderName         — internal provider name union (kite/vortex/massive/binance)
 *   - PUBLIC_FIELD_ALLOWLIST     — fields safe to return to retail clients
 *   - INTERNAL_ONLY_FIELDS       — fields gated behind ?include=internal + admin token
 *
 * Depends on:
 *   - MEILI_HOST_PRIMARY         — primary MeiliSearch server URL
 *   - MEILI_HOST_SECONDARY       — optional failover server URL (leave blank for single-node)
 *   - HYDRATION_BASE_URL         — trading-app base URL for LTP hydration
 *   - REDIS_HOST / REDIS_PORT    — for short-lived LTP cache
 *
 * Side-effects:
 *   - HTTP calls to MeiliSearch on every search
 *   - HTTP calls to trading-app for LTP hydration (circuit-broken, optional)
 *   - Redis reads/writes for LTP cache + synonym telemetry
 *
 * Key invariants:
 *   - Both Meili servers down → returns empty hits (graceful degrade, never throws)
 *   - LTP hydration down → results still return, last_price is null
 *   - Document primary key is `id` (universal_instruments.id as number)
 *   - Meili docs still carry internal provider names (kiteToken, streamProvider:'kite'); the
 *     controller layer projects them to public brand names before returning to clients
 *
 * Read order:
 *   1. MeiliClientPool  — 2-server failover pool with per-server circuit breaker
 *   2. SearchResultItem — document shape returned by Meili
 *   3. SearchService    — main service: searchInstruments, hydrateQuotes, telemetry
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import Redis from 'ioredis';

// ─── MeiliSearch document shape ───────────────────────────────────────────────

/** Provider that streams live ticks for an instrument (matches InternalProviderName in trading-app). */
export type StreamProviderName = 'kite' | 'vortex' | 'massive' | 'binance';

export type SearchResultItem = {
  id: number;                  // universal_instruments.id
  canonicalSymbol: string;     // e.g. "NSE:RELIANCE"
  symbol: string;
  name?: string;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  assetClass?: string;
  optionType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  lotSize?: number;
  tickSize?: number;
  isDerivative?: boolean;
  underlyingSymbol?: string;
  kiteToken?: number;
  vortexToken?: number;
  vortexExchange?: string;
  /** Massive symbol (e.g. "AAPL", "EURUSD"). String — Massive has no numeric tokens. */
  massiveToken?: string;
  /** Binance Spot symbol (e.g. "BTCUSDT"). String — Binance has no numeric tokens. */
  binanceToken?: string;
  /**
   * Routing fact: which provider streams this instrument's live ticks.
   * Precomputed by the indexer from `exchange` via EXCHANGE_TO_PROVIDER.
   */
  streamProvider?: StreamProviderName;
};

// ─── Field projection allow-lists ─────────────────────────────────────────────

/**
 * Fields that are safe to expose to **end-user clients** (retail traders).
 * Every field a public `?fields=` param can request must appear here, plus the
 * always-included anchors (id, canonicalSymbol, wsSubscribeUirId, last_price,
 * priceStatus, streamProvider) which are appended unconditionally.
 *
 * Notably absent: kiteToken, vortexToken, vortexExchange, massiveToken,
 * binanceToken — these are internal routing tokens that retail clients never
 * need (everyone subscribes by UIR id) and that leak the provider stack.
 */
export const PUBLIC_FIELD_ALLOWLIST: readonly string[] = [
  'symbol',
  'name',
  'exchange',
  'segment',
  'instrumentType',
  'assetClass',
  'optionType',
  'expiry',
  'strike',
  'lotSize',
  'tickSize',
  'isDerivative',
  'underlyingSymbol',
] as const;

/**
 * Fields the controller adds to every public response unconditionally.
 * Clients always need: a stable id, a human label (canonicalSymbol), the WS
 * subscribe hint (wsSubscribeUirId = id), the live price data (last_price +
 * priceStatus), and the public brand of the routing provider (streamProvider).
 */
export const PUBLIC_ALWAYS_INCLUDED: readonly string[] = [
  'id',
  'canonicalSymbol',
  'wsSubscribeUirId',
  'last_price',
  'priceStatus',
  'streamProvider',
] as const;

/**
 * Internal token fields gated behind ?include=internal + admin auth.
 * The admin dashboard uses these for the "VIA" badge + per-provider debugging.
 */
export const INTERNAL_ONLY_FIELDS: readonly string[] = [
  'kiteToken',
  'vortexToken',
  'vortexExchange',
  'massiveToken',
  'binanceToken',
  '_internalProvider', // synthetic: raw streamProvider value before brand mapping
] as const;

// ─── 2-server failover pool ───────────────────────────────────────────────────

class MeiliClientPool {
  private readonly clients: AxiosInstance[];
  private readonly openUntil: number[];
  private readonly failureCount: number[];
  private readonly logger = new Logger('MeiliClientPool');

  constructor(hosts: string[], apiKey: string, timeoutMs: number) {
    this.clients = hosts.map((h) =>
      axios.create({
        baseURL: h,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        timeout: timeoutMs,
      }),
    );
    this.openUntil = hosts.map(() => 0);
    this.failureCount = hosts.map(() => 0);
  }

  async search(index: string, body: Record<string, unknown>): Promise<any> {
    for (let i = 0; i < this.clients.length; i++) {
      if (Date.now() < this.openUntil[i]) continue; // circuit open for this server

      try {
        const resp = await this.clients[i].post(`/indexes/${index}/search`, body);
        this.failureCount[i] = 0; // reset on success
        return resp.data || { hits: [] };
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
          // Index not yet created — degrade gracefully
          this.logger.warn(`Meili server[${i}] index not found: ${index}`);
          return { hits: [] };
        }
        this.failureCount[i]++;
        if (this.failureCount[i] >= 3) {
          this.openUntil[i] = Date.now() + 10_000;
          this.failureCount[i] = 0;
          this.logger.warn(`Meili server[${i}] circuit opened (3 failures in a row)`);
        }
      }
    }
    // All servers failed or circuited
    return { hits: [] };
  }
}

// ─── SearchService ────────────────────────────────────────────────────────────

@Injectable()
export class SearchService {
  private readonly logger = new Logger('SearchService');
  private readonly meili: MeiliClientPool;
  private readonly hydrator: AxiosInstance;
  private readonly redis?: Redis;
  private hydrationFailures = 0;
  private hydrationBreakerUntil = 0;

  constructor() {
    const primaryHost = process.env.MEILI_HOST_PRIMARY
      || process.env.MEILI_HOST
      || 'http://meilisearch:7700';
    const secondaryHost = process.env.MEILI_HOST_SECONDARY || '';
    const meiliKey = process.env.MEILI_MASTER_KEY || '';
    const meiliTimeout = Number(process.env.MEILI_TIMEOUT_MS || 1200);

    const hosts = [primaryHost, secondaryHost].filter(Boolean);
    this.meili = new MeiliClientPool(hosts, meiliKey, meiliTimeout);

    const hydrateBase = process.env.HYDRATION_BASE_URL || 'http://trading-app:3000';
    const hydrateApiKey = process.env.HYDRATION_API_KEY || '';
    const hydratorHeaders: Record<string, string> = {};
    if (hydrateApiKey) hydratorHeaders['x-api-key'] = hydrateApiKey;
    hydratorHeaders['x-provider'] = 'vayu';

    this.hydrator = axios.create({
      baseURL: hydrateBase,
      timeout: Number(process.env.HYDRATE_TIMEOUT_MS || 1500),
      headers: hydratorHeaders,
    });

    try {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: Number(process.env.REDIS_PORT || 6379),
        lazyConnect: true,
      });
    } catch {
      this.logger.warn('Redis init failed — continuing without cache');
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Default `attributesToRetrieve` used when the controller doesn't pass a custom one.
   * Pulls every field the indexer might write — internal token fields included, since
   * the search service itself is provider-agnostic; the controller decides what to
   * expose to a given response.
   */
  private static readonly DEFAULT_ATTRS_TO_RETRIEVE: readonly string[] = [
    'id', 'canonicalSymbol', 'symbol', 'name', 'exchange', 'segment',
    'instrumentType', 'assetClass', 'optionType', 'expiry', 'strike',
    'lotSize', 'tickSize', 'isDerivative', 'underlyingSymbol',
    'kiteToken', 'vortexToken', 'vortexExchange',
    'massiveToken', 'binanceToken', 'streamProvider',
  ];

  async searchInstruments(
    q: string,
    limit = 10,
    filters: {
      exchange?: string;
      segment?: string;
      instrumentType?: string;
      vortexExchange?: string;
      optionType?: string;
      assetClass?: string;
      streamProvider?: StreamProviderName;
      isDerivative?: boolean;
      expiry_from?: string;
      expiry_to?: string;
      strike_min?: number | string;
      strike_max?: number | string;
    } = {},
    /**
     * Optional override for Meili's `attributesToRetrieve`. When the caller knows
     * exactly which fields it'll project (e.g. via the public `?fields=` param),
     * passing a narrower set here reduces Meili payload size + parse cost.
     * Pass `undefined` to use the default (all known fields).
     */
    attributesToRetrieve?: readonly string[],
  ): Promise<SearchResultItem[]> {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const attrs = attributesToRetrieve && attributesToRetrieve.length > 0
      ? Array.from(attributesToRetrieve)
      : Array.from(SearchService.DEFAULT_ATTRS_TO_RETRIEVE);
    const filterExpr = this.buildFilter(filters);

    // Primary: all-words matching (precise, higher quality)
    const precise = await this.meili.search(index, {
      q,
      limit,
      attributesToRetrieve: attrs,
      filter: filterExpr,
      matchingStrategy: 'all',
    });

    const primary: SearchResultItem[] = precise.hits || [];
    if (primary.length >= limit) return primary.slice(0, limit);

    // Fallback: last-word matching (broader, catches partial queries)
    const broad = await this.meili.search(index, {
      q,
      limit,
      attributesToRetrieve: attrs,
      filter: filterExpr,
      matchingStrategy: 'last',
    });

    return this.dedupeById([...primary, ...(broad.hits || [])]).slice(0, limit);
  }

  async facetCounts(filters: Record<string, string | undefined> = {}): Promise<Record<string, any>> {
    const index = process.env.MEILI_INDEX || 'instruments_v1';
    const filterExpr = this.buildFilter(filters);
    const resp = await this.meili.search(index, {
      q: '',
      limit: 0,
      filter: filterExpr,
      facets: ['exchange', 'segment', 'instrumentType', 'optionType', 'assetClass'],
    });
    return (resp as any)?.facetDistribution || {};
  }

  // ── LTP hydration ─────────────────────────────────────────────────────────

  async hydrateQuotes(tokens: number[], mode: 'ltp' | 'ohlc' | 'full' = 'ltp'): Promise<Record<string, any>> {
    if (!tokens.length) return {};
    if (Date.now() < this.hydrationBreakerUntil) return {};

    const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
    const cacheKey = (t: number) => `q:${mode}:${t}`;
    const result: Record<string, any> = {};
    const toFetch: number[] = [];

    if (this.redis) {
      for (const t of tokens) {
        const v = await this.redis.get(cacheKey(t));
        if (v) result[String(t)] = JSON.parse(v);
        else toFetch.push(t);
      }
    } else {
      toFetch.push(...tokens);
    }

    if (!toFetch.length) return result;

    try {
      const url = mode === 'ltp' ? '/api/stock/vayu/ltp' : `/api/stock/quotes?mode=${mode}&ltp_only=true`;
      const resp = await this.hydrator.post(url, { instruments: toFetch });
      const data = resp.data?.data || {};
      Object.assign(result, data);
      if (this.redis) {
        const ttlSec = Math.ceil(cacheTTL / 1000);
        for (const [k, v] of Object.entries(data)) {
          await this.redis.setex(cacheKey(Number(k)), ttlSec, JSON.stringify(v));
        }
      }
      this.hydrationFailures = 0;
      this.hydrationBreakerUntil = 0;
    } catch (err: any) {
      this.hydrationFailures++;
      const threshold = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
      const openMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
      if (this.hydrationFailures >= threshold) {
        this.hydrationBreakerUntil = Date.now() + openMs;
        this.hydrationFailures = 0;
        this.logger.warn(`Hydration circuit opened for ${openMs}ms`);
      }
    }

    return result;
  }

  /**
   * Pair-based LTP hydration using vortexToken + vortexExchange from the Meili document.
   * Falls back to kiteToken for instruments without a vortex mapping.
   */
  async hydrateLtpByItems(items: SearchResultItem[]): Promise<Record<string, any>> {
    if (!items.length) return {};
    if (Date.now() < this.hydrationBreakerUntil) return {};

    const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
    const ttlSec = Math.ceil(cacheTTL / 1000);
    const cacheKey = (id: number) => `q:ltp:uid:${id}`;
    const result: Record<string, any> = {};
    const toFetch: number[] = [];

    // Check Redis cache keyed by universal instrument id
    if (this.redis) {
      for (const item of items) {
        const cached = await this.redis.get(cacheKey(item.id));
        if (cached) result[String(item.id)] = JSON.parse(cached);
        else toFetch.push(item.id);
      }
    } else {
      toFetch.push(...items.map((i) => i.id));
    }

    if (!toFetch.length) return result;

    // Single call — trading-app resolves vortex vs kite internally by universal id
    try {
      const resp = await this.hydrator.post('/api/stock/universal/ltp', { ids: toFetch });
      const data: Record<string, any> = resp.data?.data || {};
      Object.assign(result, data);
      if (this.redis) {
        for (const [k, v] of Object.entries(data)) {
          await this.redis.setex(cacheKey(Number(k)), ttlSec, JSON.stringify(v));
        }
      }
      this.hydrationFailures = 0;
      this.hydrationBreakerUntil = 0;
    } catch (err: any) {
      this.hydrationFailures++;
      const threshold = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
      const openMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
      if (this.hydrationFailures >= threshold) {
        this.hydrationBreakerUntil = Date.now() + openMs;
        this.hydrationFailures = 0;
        this.logger.warn(`Hydration circuit opened for ${openMs}ms`);
      }
    }

    return result;
  }

  // ── Synonym telemetry ─────────────────────────────────────────────────────

  async logSelectionTelemetry(q: string, symbol: string, universalId?: number): Promise<void> {
    try {
      if (!this.redis) return;
      const normQ = String(q || '').trim().toLowerCase();
      const normSym = String(symbol || '').trim().toUpperCase();
      if (!normQ || !normSym) return;
      const ttlSec = Number(process.env.SYNONYMS_TTL_DAYS || 14) * 86400;
      const keys = [
        `syn:q:${normQ}:sym:${normSym}`,
        `syn:sym:${normSym}`,
        ...(Number.isFinite(universalId) ? [`syn:uid:${universalId}:q:${normQ}`] : []),
      ];
      for (const k of keys) {
        await this.redis.incrby(k, 1);
        if (ttlSec > 0) await this.redis.expire(k, ttlSec);
      }
    } catch {
      // Best effort — never block the caller
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  buildFilter(filters: Record<string, any>): string | undefined {
    const parts: string[] = [];
    if (!filters) return undefined;

    if (filters.exchange) parts.push(`exchange = ${JSON.stringify(filters.exchange)}`);
    if (filters.segment) parts.push(`segment = ${JSON.stringify(filters.segment)}`);
    if (filters.instrumentType) parts.push(`instrumentType = ${JSON.stringify(filters.instrumentType)}`);
    if (filters.vortexExchange) parts.push(`vortexExchange = ${JSON.stringify(filters.vortexExchange)}`);
    if (filters.optionType) parts.push(`optionType = ${JSON.stringify(filters.optionType)}`);
    if (filters.assetClass) parts.push(`assetClass = ${JSON.stringify(filters.assetClass)}`);
    if (filters.streamProvider) parts.push(`streamProvider = ${JSON.stringify(filters.streamProvider)}`);
    if (filters.isDerivative !== undefined) parts.push(`isDerivative = ${!!filters.isDerivative}`);

    if (filters.expiry_from) parts.push(`expiry >= ${JSON.stringify(filters.expiry_from)}`);
    if (filters.expiry_to) parts.push(`expiry <= ${JSON.stringify(filters.expiry_to)}`);

    if (Number.isFinite(Number(filters.strike_min))) parts.push(`strike >= ${Number(filters.strike_min)}`);
    if (Number.isFinite(Number(filters.strike_max))) parts.push(`strike <= ${Number(filters.strike_max)}`);

    return parts.length ? parts.join(' AND ') : undefined;
  }

  private dedupeById(items: SearchResultItem[]): SearchResultItem[] {
    const seen = new Set<number>();
    const out: SearchResultItem[] = [];
    for (const item of items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }
}
