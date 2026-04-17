/**
 * @file vortex-provider.service.ts
 * @module stock
 * @description Rupeezy Vortex REST + WebSocket market data provider (sharded WS, OHLCV/full parsing).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-03-28 — CSV/binary tick parsing extracted to infra utils.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataProvider, TickerLike } from '@features/market-data/infra/market-data.provider';
import axios, { AxiosInstance } from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { VortexSession } from '@features/stock/domain/vortex-session.entity';
import { Instrument } from '@features/market-data/domain/instrument.entity';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { RedisService } from '@infra/redis/redis.service';
import { AppConfigService } from '@infra/app-config/app-config.service';
import { LtpMemoryCacheService } from '@features/market-data/application/ltp-memory-cache.service';
import { ProviderQueueService } from '@features/market-data/application/provider-queue.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { VortexShardedTicker } from '@features/stock/infra/vortex-ws-ticker';
import { parseVortexCsv } from '@features/stock/infra/vortex-csv.util';
import { parseVortexBinaryTicks } from '@features/stock/infra/vortex-ws-binary-tick.parser';

// Minimal safe no-op ticker used when Vortex streaming is not configured
class NoopTicker {
  private readonly logger: Logger;
  private handlers: Record<string, Function[]> = {};
  constructor(logger: Logger) {
    this.logger = logger;
  }
  on(event: string, handler: Function) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }
  connect() {
    this.logger.warn(
      '[Vortex] NoopTicker.connect called (stream not configured)',
    );
  }
  disconnect() {
    this.logger.warn('[Vortex] NoopTicker.disconnect called');
  }
  subscribe(_tokens: number[], _mode?: string) {
    this.logger.warn('[Vortex] NoopTicker.subscribe called');
  }
  unsubscribe(_tokens: number[]) {
    this.logger.warn('[Vortex] NoopTicker.unsubscribe called');
  }
  setMode(_mode: string, _tokens: number[]) {
    this.logger.warn('[Vortex] NoopTicker.setMode called');
  }
}

@Injectable()
export class VortexProviderService implements OnModuleInit, MarketDataProvider {
  readonly providerName = 'vortex' as const;
  private readonly logger = new Logger(VortexProviderService.name);
  readonly providerName = 'vortex';
  private ticker: TickerLike;
  private initialized = false;
  private http: AxiosInstance | null = null;
  private accessToken: string | null = null;
  private wsConnected = false;
  private reconnectAttempts = 0;
  // Runtime config overrides (persisted to Redis, survive restarts)
  private vortexApiKeyOverride: string | null = null;
  private vortexBaseUrlOverride: string | null = null;
  private vortexWsUrlOverride: string | null = null;
  private vortexAppIdOverride: string | null = null;
  private readonly maxReconnectAttempts = 8;
  private readonly maxSubscriptionsPerSocket = 1000;
  /** Mirrors VortexShardedTicker maxShards after initializeTicker(). */
  private vortexShardCount = 1;
  // SWR config
  private readonly swrServeStaleMs = Math.max(
    0,
    Number(process.env.LTP_SWR_STALE_MS || 5000),
  );
  private ltpRefreshInFlight: Set<string> = new Set();
  // Micro-aggregator for pair LTP to avoid 1s batching wait
  private pairAggTimer: NodeJS.Timeout | null = null;
  private pairAggWindowMs = Math.max(5, Number(process.env.LTP_AGG_WINDOW_MS || 25));
  private pairAggRequests: Array<{
    keys: string[];
    resolve: (v: Record<string, { last_price: number | null }>) => void;
    reject: (e: any) => void;
    options?: { bypassCache?: boolean; backgroundRefresh?: boolean };
  }> = [];
  // Hotset warmer (WS) — gated by env
  private hotsetEnabled =
    String(process.env.VORTEX_HOTSET_WARMER || '').toLowerCase() === 'true';
  private hotsetMax = Math.max(1, Number(process.env.VORTEX_HOTSET_SIZE || 800));
  private hotsetRecent: Map<string, number> = new Map(); // token -> lastSeenMs
  private hotsetTimer: NodeJS.Timeout | null = null;
  // Simple circuit breaker per REST key
  private breaker: Record<string, { state: 'closed' | 'open' | 'half_open'; failures: number; nextAttemptAt: number }> = {
    quotes: { state: 'closed', failures: 0, nextAttemptAt: 0 },
    ltp: { state: 'closed', failures: 0, nextAttemptAt: 0 },
    ohlc: { state: 'closed', failures: 0, nextAttemptAt: 0 },
    history: { state: 'closed', failures: 0, nextAttemptAt: 0 },
  };
  private readonly breakerFailureThreshold = 5;
  private readonly breakerOpenMs = 30000;

  private isRetryableError(e: any): boolean {
    try {
      const status = e?.response?.status;
      const code = e?.code;
      if (status && (status >= 500 || status === 429)) return true;
      if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String(code))) return true;
      // Axios timeout
      if (e?.message && /timeout/i.test(String(e.message))) return true;
      return false;
    } catch {
      return false;
    }
  }

  private breakerBefore(key: 'quotes' | 'ltp' | 'ohlc' | 'history'): boolean {
    const b = this.breaker[key];
    const now = Date.now();
    if (b.state === 'open' && now < b.nextAttemptAt) {
      this.logger.warn(`[Vortex] Circuit OPEN for ${key}; short-circuiting request`);
      return false;
    }
    if (b.state === 'open' && now >= b.nextAttemptAt) {
      b.state = 'half_open';
      this.logger.warn(`[Vortex] Circuit HALF-OPEN for ${key}; probing`);
    }
    return true;
  }

  private breakerSuccess(key: 'quotes' | 'ltp' | 'ohlc' | 'history') {
    const b = this.breaker[key];
    b.failures = 0;
    if (b.state !== 'closed') {
      b.state = 'closed';
      this.logger.log(`[Vortex] Circuit CLOSED for ${key}`);
    }
  }

  private breakerFailure(key: 'quotes' | 'ltp' | 'ohlc' | 'history') {
    const b = this.breaker[key];
    b.failures += 1;
    if (b.failures >= this.breakerFailureThreshold) {
      b.state = 'open';
      b.nextAttemptAt = Date.now() + this.breakerOpenMs;
      this.logger.error(`[Vortex] Circuit OPENED for ${key} after ${b.failures} failures; cooling for ${this.breakerOpenMs}ms`);
    }
  }

  private async httpGet(url: string, key: 'quotes' | 'ltp' | 'ohlc' | 'history', timeoutOverride?: number): Promise<any | null> {
    if (!this.http) return null;
    if (!this.breakerBefore(key)) return null;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await this.http.get(url, {
          headers: this.authHeaders(),
          timeout: timeoutOverride ?? 10000,
        });
        this.breakerSuccess(key);
        return resp;
      } catch (e) {
        const retryable = this.isRetryableError(e);
        this.logger.warn(`[Vortex] HTTP GET failed (${key}) attempt ${attempt + 1}/${maxRetries + 1} ${retryable ? '(retryable)' : ''}`, e as any);
        this.breakerFailure(key);
        if (attempt < maxRetries && retryable) {
          const backoff = Math.min(1500 * Math.pow(2, attempt), 5000);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        // Final failure
        return null;
      }
    }
    return null;
  }

  private async getCachedLtpForTokens(tokens: string[], opts?: { staleWithinMs?: number }): Promise<Record<string, { last_price: number | null }>> {
    const out: Record<string, { last_price: number | null }> = {};
    try {
      // 1) In-memory cache
      const mem =
        opts?.staleWithinMs && opts.staleWithinMs > 0
          ? this.ltpCache.getManyStaleWithin(tokens, opts.staleWithinMs)
          : this.ltpCache.getMany(tokens);
      for (const t of tokens) out[String(t)] = { last_price: mem[String(t)]?.last_price ?? null } as any;
      // 2) Redis fallback for misses
      const misses = tokens.filter((t) => !Number.isFinite(out[String(t)]?.last_price as any));
      for (const t of misses) {
        try {
          const cached = await this.redisService.get<{ last_price: number }>(`ltp:${t}`);
          if (cached && Number.isFinite((cached as any).last_price) && ((cached as any).last_price > 0)) {
            out[String(t)] = { last_price: (cached as any).last_price } as any;
            this.ltpCache.set(t, (cached as any).last_price);
          }
        } catch {}
      }
    } catch {}
    return out;
  }

  private async setCachedLtp(token: string | number, price: number | null) {
    try {
      if (Number.isFinite(price) && (price as any) > 0) {
        this.ltpCache.set(token, price as any);
        await this.redisService.set(`ltp:${token}`, { last_price: price, ts: Date.now() }, 10);
        this.noteHotset(token);
      }
    } catch {}
  }

  constructor(
    private configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly ltpCache: LtpMemoryCacheService,
    private readonly providerQueue: ProviderQueueService,
    private readonly metrics: MetricsService,
    @InjectRepository(VortexSession)
    private vortexSessionRepo: Repository<VortexSession>,
    @InjectRepository(Instrument)
    private instrumentRepo: Repository<Instrument>,
    @InjectRepository(VortexInstrument)
    private vortexInstrumentRepo: Repository<VortexInstrument>,
    @InjectRepository(InstrumentMapping)
    private instrumentMappingRepo: Repository<InstrumentMapping>,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit() {
    await this.loadConfigOverrides();
    await this.initialize();
    // Auto-load saved access token on startup
    await this.loadSavedToken();
    this.refreshVortexDegradedMetric();
    // Start WS hotset warmer if enabled
    if (this.hotsetEnabled) {
      this.startHotsetWarmer();
    }
  }

  async initialize(): Promise<void> {
    try {
      // For now, we do not fail if creds are missing; the provider stays in degraded mode
      const apiKey = this.vortexApiKeyOverride || this.configService.get('VORTEX_API_KEY');
      const baseUrl = this.vortexBaseUrlOverride || this.configService.get('VORTEX_BASE_URL');
      if (!apiKey || !baseUrl) {
        this.logger.warn(
          '[Vortex] API key or base URL not configured. REST methods will return empty.',
        );
      } else {
        this.http = axios.create({
          baseURL: baseUrl,
          timeout: 10000,
          headers: { 'x-api-key': apiKey },
        });
        this.logger.log('[Vortex] HTTP client initialized');
      }
      this.initialized = true;
      this.refreshVortexDegradedMetric();
    } catch (error) {
      this.logger.error('[Vortex] initialize failed (non-fatal)', error as any);
      this.initialized = false; // but keep provider usable with stubs
      this.refreshVortexDegradedMetric();
    }
  }

  private refreshVortexDegradedMetric() {
    try {
      const degraded = this.http ? 0 : 1;
      this.metrics.providerDegradedMode.labels('vortex').set(degraded);
    } catch {
      /* non-fatal */
    }
  }

  async getInstruments(
    exchange?: string,
    opts?: { csvUrl?: string },
  ): Promise<any[]> {
    try {
      const csvUrl =
        opts?.csvUrl || this.configService.get('VORTEX_INSTRUMENTS_CSV_URL');
      if (!csvUrl) {
        this.logger.warn(
          '[Vortex] CSV URL not configured for instruments. Returning empty list.',
        );
        return [];
      }
      // Download with basic retry/backoff
      let attempt = 0;
      let res: Response | null = null;
      let lastErr: any = null;
      while (attempt < 3) {
        try {
          // Lazy import to avoid hard dependency if unused
          res = await fetch(csvUrl, {
            headers: { 'Accept-Encoding': 'gzip, deflate' } as any,
          });
          if (res.ok) break;
          lastErr = new Error('HTTP ' + res.status);
        } catch (e) {
          lastErr = e;
        }
        const delay = 500 * Math.pow(2, attempt++);
        await new Promise((r) => setTimeout(r, delay));
      }
      if (!res || !res.ok) {
        this.logger.warn(
          `[Vortex] Failed to download CSV from ${csvUrl}: ${lastErr?.message || 'unknown'}`,
        );
        return [];
      }
      if (!res.ok) {
        this.logger.warn(
          `[Vortex] Failed to download CSV from ${csvUrl}: ${res.status}`,
        );
        return [];
      }
      const text = await res.text();
      const rows = parseVortexCsv(text);
      const items: any[] = [];
      for (const row of rows) {
        // Map Vortex CSV fields according to API documentation
        const token = Number(row['token']);
        if (!Number.isFinite(token)) {
          this.logger.debug(
            `[Vortex] Skipping row with invalid token: ${row['token']}`,
          );
          continue;
        }

        // Parse strike price - handle both string and number formats
        let strike_price = 0;
        if (row['strike_price']) {
          strike_price = Number(row['strike_price']);
          if (!Number.isFinite(strike_price)) {
            this.logger.debug(
              `[Vortex] Invalid strike_price for token ${token}: ${row['strike_price']}`,
            );
            strike_price = 0;
          }
        }

        // Parse tick size - handle both string and number formats
        let tick = 0.05;
        if (row['tick']) {
          tick = Number(row['tick']);
          if (!Number.isFinite(tick) || tick <= 0) {
            this.logger.debug(
              `[Vortex] Invalid tick for token ${token}: ${row['tick']}, using default 0.05`,
            );
            tick = 0.05;
          }
        }

        // Parse lot size - handle both string and number formats
        let lot_size = 1;
        if (row['lot_size']) {
          lot_size = Number(row['lot_size']);
          if (!Number.isFinite(lot_size) || lot_size <= 0) {
            this.logger.debug(
              `[Vortex] Invalid lot_size for token ${token}: ${row['lot_size']}, using default 1`,
            );
            lot_size = 1;
          }
        }

        const instrument = {
          token,
          exchange: row['exchange'] || exchange || 'NSE_EQ',
          symbol: row['symbol'] || '',
          instrument_name: row['instrument_name'] || '',
          expiry_date: row['expiry_date'] || null,
          option_type: row['option_type'] || null,
          strike_price,
          tick,
          lot_size,
        };

        // Log first few instruments for debugging
        if (items.length < 5) {
          this.logger.debug(
            `[Vortex] Parsed instrument ${items.length + 1}:`,
            instrument,
          );
        }

        items.push(instrument);
      }
      this.logger.log(`[Vortex] Parsed ${items.length} instruments from CSV`);
      return items;
    } catch (error) {
      this.logger.error(
        '[Vortex] Failed to fetch/parse instruments CSV',
        error as any,
      );
      return [];
    }
  }

  async getQuote(tokens: string[]): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getQuote called without credentials. Returning empty result.',
        );
        return {};
      }
      // Rate limit per Vortex docs (1 req/sec per endpoint)
      await this.rateLimit('quotes');
      // Build query q=exchange-token pairs using DB-backed exchange mapping (skip unresolved)
      const exMap = await this.getExchangesForTokens(tokens);
      const toQuery = tokens.filter((t) => exMap.has(t));
      const missing = tokens.filter((t) => !exMap.has(t));
      if (missing.length) {
        this.logger.warn(
          `[Vortex] getQuote: ${missing.length}/${tokens.length} tokens lack exchange mapping; skipping in request. Examples: ${missing
            .slice(0, 5)
            .join(',')}`,
        );
      }
      const qParams = toQuery
        .map((t) => `q=${encodeURIComponent(`${exMap.get(t)}-${t}`)}`)
        .join('&');
      const mode = 'full';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      this.logger.debug(
        `[Vortex] getQuote request: requested=${tokens.length}, querying=${toQuery.length}, url=${url}`,
      );
      let data: any = {};
      if (toQuery.length > 0) {
        const resp = await this.providerQueue.execute('quotes' as any, async () =>
          this.httpGet(url, 'quotes'),
        );
        data = (resp as any)?.data?.data || {};
      }
      const out: Record<string, any> = {};
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        out[tokenPart] = this.normalizeQuote(quote);
      }
      // Enrichment: ensure last_price is present by fetching LTP for missing tokens in one shot
      const missingLtp = Object.entries(out)
        .filter(
          ([, v]) =>
            !Number.isFinite(v?.last_price) || (v?.last_price ?? 0) <= 0,
        )
        .map(([k]) => k);
      if (missingLtp.length) {
        this.logger.warn(
          `[Vortex] getQuote missing LTP for ${missingLtp.length}/${tokens.length} tokens → fetching LTP fallback`,
        );
        try {
          const ltpMap = await this.getLTP(missingLtp);
          for (const tok of missingLtp) {
            const lv = ltpMap?.[tok]?.last_price;
            if (Number.isFinite(lv) && lv > 0) {
              out[tok] = { ...(out[tok] || {}), last_price: lv };
            }
          }
        } catch (e) {
          this.logger.warn(
            '[Vortex] LTP fallback during getQuote failed',
            e as any,
          );
        }
      }
      // Ensure all requested tokens present in output
      for (const t of tokens) {
        if (!(t in out)) out[t] = { last_price: null } as any;
      }
      this.logger.debug(
        `[Vortex] getQuote result coverage: total=${tokens.length}, withLTP=${Object.values(out).filter((v) => Number.isFinite((v as any)?.last_price) && (v as any).last_price > 0).length}`,
      );
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getQuote failed (non-fatal)', error as any);
      return {};
    }
  }

  async getLTP(tokens: string[], options?: { bypassCache?: boolean; backgroundRefresh?: boolean }): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getLTP called without credentials. Returning empty result.',
        );
        return {};
      }
      await this.rateLimit('ltp');
      // Try cache first unless bypassCache=true
      const useCache = !(options && options.bypassCache === true);
      const cache = useCache ? await this.getCachedLtpForTokens(tokens, { staleWithinMs: this.swrServeStaleMs }) : {};
      const missingForCache = tokens.filter((t) => {
        const lp = cache[String(t)]?.last_price;
        return !(Number.isFinite(lp as any) && (lp as any) > 0);
      });
      const exMap = await this.getExchangesForTokens(missingForCache);
      const toQuery = missingForCache.filter((t) => exMap.has(t));
      const missing = tokens.filter((t) => !exMap.has(t));
      if (missing.length) {
        this.logger.warn(
          `[Vortex] getLTP: ${missing.length}/${tokens.length} tokens lack exchange mapping; skipping in request. Examples: ${missing
            .slice(0, 5)
            .join(',')}`,
        );
      }
      const qParams = toQuery
        .map((t) => `q=${encodeURIComponent(`${exMap.get(t)}-${t}`)}`)
        .join('&');
      const mode = 'ltp';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      this.logger.debug(
        `[Vortex] getLTP request: requested=${tokens.length}, querying=${toQuery.length}, url=${url}`,
      );
      let data: any = {};
      if (toQuery.length > 0) {
        const resp = await this.providerQueue.execute('ltp' as any, async () =>
          this.httpGet(url, 'ltp'),
        );
        data = (resp as any)?.data?.data || {};
      }
      const out: Record<string, any> = {};
      // Start with cache values when allowed
      if (useCache) {
        for (const t of tokens) {
          const cached = cache[String(t)]?.last_price ?? null;
          if (Number.isFinite(cached as any) && (cached as any) > 0) {
            out[String(t)] = { last_price: cached };
          }
        }
      }
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        const raw = Number(
          (quote && (quote as any).last_trade_price) ?? (quote as any)?.ltp,
        );
        out[tokenPart] = {
          last_price: Number.isFinite(raw) && raw > 0 ? raw : null,
        };
        await this.setCachedLtp(tokenPart, out[tokenPart].last_price);
      }
      // Ensure all requested tokens present in output
      for (const t of tokens) {
        if (!(t in out)) out[t] = { last_price: null } as any;
      }
      this.logger.debug(
        `[Vortex] getLTP result coverage: total=${tokens.length}, withLTP=${Object.values(out).filter((v) => Number.isFinite((v as any)?.last_price) && (v as any).last_price > 0).length}`,
      );
      // SWR background refresh if we served cache and didn't query provider for some/all tokens
      if (useCache && (options?.backgroundRefresh ?? true)) {
        const allFromCache = toQuery.length === 0;
        if (allFromCache) {
          this.refreshLtpInBackground(tokens.map((t) => String(t)));
        }
      }
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getLTP failed (non-fatal)', error as any);
      return {};
    }
  }

  /**
   * Fetch LTP for explicit exchange-token pairs using Vortex REST quotes API in ltp mode.
   * - Accepts up to 1000 pairs per HTTP request; chunks larger inputs and rate-limits per docs
   * - Returns map keyed by "EXCHANGE-TOKEN" → { last_price }
   */
  async getLTPByPairs(
    pairs: Array<{
      exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
      token: string | number;
    }>,
    options?: { bypassCache?: boolean; backgroundRefresh?: boolean },
  ): Promise<Record<string, { last_price: number | null }>> {
    const result: Record<string, { last_price: number | null }> = {};
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getLTPByPairs called without credentials. Returning empty result.',
        );
        return result;
      }

      if (!Array.isArray(pairs) || pairs.length === 0) return result;

      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      // Sanitize and prepare keys
      const keys: string[] = [];
      for (const p of pairs) {
        const ex = String(p?.exchange || '').toUpperCase();
        const tok = String(p?.token ?? '').trim();
        if (!allowed.has(ex)) {
          this.logger.debug(
            `[Vortex] getLTPByPairs: skipping unsupported exchange=${p?.exchange}`,
          );
          continue;
        }
        if (!tok || !/^\d+$/.test(tok)) {
          this.logger.debug(
            `[Vortex] getLTPByPairs: skipping invalid token=${p?.token}`,
          );
          continue;
        }
        keys.push(`${ex}-${tok}`);
      }

      if (keys.length === 0) return result;

      // Short-circuit using cache where possible (per-token basis)
      const tokenByKey = new Map<string, number>();
      for (const k of keys) {
        const tokenPart = Number(String(k.split('-').pop()));
        if (Number.isFinite(tokenPart)) tokenByKey.set(k, tokenPart);
      }
      const useCache = !(options && options.bypassCache === true);
      if (useCache && tokenByKey.size) {
        const cached = await this.getCachedLtpForTokens(
          Array.from(new Set(Array.from(tokenByKey.values()).map((n) => String(n)))),
          { staleWithinMs: this.swrServeStaleMs },
        );
        for (const [pairKey, tok] of tokenByKey.entries()) {
          const lp = cached[String(tok)]?.last_price;
          if (Number.isFinite(lp as any) && (lp as any) > 0) {
            result[pairKey] = { last_price: lp as any };
          }
        }
      }

      const remainingKeys = keys.filter((k) => !(k in result));

      // Helper to chunk array into max 1000 items
      const MAX_PER_REQ = 1000;
      const chunks: string[][] = [];
      for (let i = 0; i < remainingKeys.length; i += MAX_PER_REQ) {
        chunks.push(remainingKeys.slice(i, i + MAX_PER_REQ));
      }

      let withLtp = 0;
      for (const chunk of chunks) {
        await this.rateLimit('ltp');
        const qParams = chunk
          .map((k) => `q=${encodeURIComponent(k)}`)
          .join('&');
        const url = `/data/quotes?${qParams}&mode=ltp`;
        this.logger.debug(
          `[Vortex] getLTPByPairs request: pairs=${chunk.length}, url=${url}`,
        );
        try {
          const resp = await this.providerQueue.execute('ltp' as any, async () =>
            this.httpGet(url, 'ltp'),
          );
          const data = (resp as any)?.data?.data || {};
          for (const [exToken, quote] of Object.entries<any>(data)) {
            const raw = Number(
              (quote && (quote as any).last_trade_price) ?? (quote as any)?.ltp,
            );
            const lp = Number.isFinite(raw) && raw > 0 ? raw : null;
            if (lp !== null) withLtp++;
            result[exToken] = { last_price: lp };
            const tok = Number(String(exToken.split('-').pop()))
            if (Number.isFinite(tok)) await this.setCachedLtp(tok, lp);
          }
        } catch (e) {
          this.logger.error('[Vortex] getLTPByPairs HTTP error', e as any);
        }
      }

      // Ensure all requested keys present in output (null when missing)
      for (const k of keys) {
        if (!(k in result)) result[k] = { last_price: null };
      }

      this.logger.debug(
        `[Vortex] getLTPByPairs coverage: total=${keys.length}, withLTP=${Object.values(result).filter((v) => Number.isFinite((v as any)?.last_price) && (v as any).last_price > 0).length}`,
      );
      // SWR background refresh if we served cache and didn't query provider for this batch
      if (useCache && (options?.backgroundRefresh ?? true)) {
        const noneFetched = remainingKeys.length === 0 && tokenByKey.size > 0;
        if (noneFetched) {
          const tokens = Array.from(new Set(Array.from(tokenByKey.values()).map((n) => String(n))));
          this.refreshLtpInBackground(tokens);
        }
      }
      return result;
    } catch (error) {
      this.logger.error('[Vortex] getLTPByPairs failed (non-fatal)', error as any);
      return result;
    }
  }

  /**
   * Micro-aggregated pair-based LTP: coalesces concurrent callers within a very small window.
   */
  async getLTPByPairsAggregated(
    pairs: Array<{
      exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
      token: string | number;
    }>,
    options?: { bypassCache?: boolean; backgroundRefresh?: boolean },
  ): Promise<Record<string, { last_price: number | null }>> {
    const keys = (pairs || [])
      .map((p) => `${String(p?.exchange || '').toUpperCase()}-${String(p?.token ?? '').trim()}`)
      .filter((k) => !!k && /^[A-Z_]+-\d+$/.test(k));
    if (keys.length === 0) return {};
    return new Promise((resolve, reject) => {
      try {
        this.pairAggRequests.push({ keys, resolve, reject, options });
        if (!this.pairAggTimer) {
          this.pairAggTimer = setTimeout(() => this.flushPairAgg(), this.pairAggWindowMs);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  private async flushPairAgg() {
    const batch = this.pairAggRequests.splice(0, this.pairAggRequests.length);
    if (this.pairAggTimer) {
      clearTimeout(this.pairAggTimer);
      this.pairAggTimer = null;
    }
    if (!batch.length) return;
    try {
      const unionKeys = Array.from(new Set(batch.flatMap((b) => b.keys)));
      // Build pairs from keys
      const unionPairs: Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string | number }> = [];
      for (const k of unionKeys) {
        const [ex, tok] = k.split('-');
        if (ex && tok && /^\d+$/.test(tok)) {
          if (ex === 'NSE_EQ' || ex === 'NSE_FO' || ex === 'NSE_CUR' || ex === 'MCX_FO') {
            unionPairs.push({ exchange: ex as any, token: tok });
          }
        }
      }
      const anyOpts = batch.find((b) => !!b.options)?.options || {};
      const map = await this.getLTPByPairs(unionPairs, anyOpts as any);
      for (const req of batch) {
        const slice: Record<string, { last_price: number | null }> = {};
        for (const k of req.keys) {
          slice[k] = map[k] ?? { last_price: null };
        }
        req.resolve(slice);
      }
    } catch (e) {
      for (const req of batch) {
        try {
          req.reject(e);
        } catch {}
      }
    }
  }

  async getOHLC(tokens: string[]): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getOHLC called without credentials. Returning empty result.',
        );
        return {};
      }
      await this.rateLimit('ohlc');
      const exMap = await this.getExchangesForTokens(tokens);
      const toQuery = tokens.filter((t) => exMap.has(t));
      const missing = tokens.filter((t) => !exMap.has(t));
      if (missing.length) {
        this.logger.warn(
          `[Vortex] getOHLC: ${missing.length}/${tokens.length} tokens lack exchange mapping; skipping in request. Examples: ${missing
            .slice(0, 5)
            .join(',')}`,
        );
      }
      const qParams = toQuery
        .map((t) => `q=${encodeURIComponent(`${exMap.get(t)}-${t}`)}`)
        .join('&');
      const mode = 'ohlc';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      let data: any = {};
      if (toQuery.length > 0) {
        const resp = await this.providerQueue.execute('ohlc' as any, async () =>
          this.httpGet(url, 'ohlc'),
        );
        data = (resp as any)?.data?.data || {};
      }
      const out: Record<string, any> = {};
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        out[tokenPart] = {
          last_price: quote?.last_trade_price,
          ohlc: {
            open: quote?.open_price,
            high: quote?.high_price,
            low: quote?.low_price,
            close: quote?.close_price,
          },
        };
      }
      // Enrichment: fetch LTP for any tokens without a valid last_price
      const missingLtp = Object.entries(out)
        .filter(
          ([, v]) =>
            !Number.isFinite(v?.last_price) || (v?.last_price ?? 0) <= 0,
        )
        .map(([k]) => k);
      if (missingLtp.length) {
        this.logger.warn(
          `[Vortex] getOHLC missing LTP for ${missingLtp.length}/${tokens.length} tokens → fetching LTP fallback`,
        );
        try {
          const ltpMap = await this.getLTP(missingLtp);
          for (const tok of missingLtp) {
            const lv = ltpMap?.[tok]?.last_price;
            if (Number.isFinite(lv) && lv > 0) {
              out[tok] = { ...(out[tok] || {}), last_price: lv };
            }
          }
        } catch (e) {
          this.logger.warn(
            '[Vortex] LTP fallback during getOHLC failed',
            e as any,
          );
        }
      }
      // Ensure all requested tokens present in output
      for (const t of tokens) {
        if (!(t in out)) out[t] = { last_price: null } as any;
      }
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getOHLC failed (non-fatal)', error as any);
      return {};
    }
  }

  async getHistoricalData(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<any> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getHistoricalData called without credentials. Returning empty candles.',
        );
        return { candles: [] };
      }
      await this.rateLimit('history');
      const exMap = await this.getExchangesForTokens([String(token)]);
      const exchange = exMap.get(String(token));
      if (!exchange) {
        this.logger.warn(
          `[Vortex] getHistoricalData: token ${token} has no exchange mapping; returning empty candles`,
        );
        return { candles: [] };
      }
      const fromSec = Math.floor(new Date(from).getTime() / 1000);
      const toSec = Math.floor(new Date(to).getTime() / 1000);
      const resolution = this.mapInterval(interval);
      const url = `/data/history?exchange=${exchange}&token=${token}&to=${toSec}&from=${fromSec}&resolution=${resolution}`;
      const resp = await this.providerQueue.execute('history' as any, async () =>
        this.httpGet(url, 'history'),
      );
      const d = (resp as any)?.data || {};
      if (d?.s !== 'ok') return { candles: [] };
      const candles: any[] = [];
      const len = Math.min(
        d.t?.length || 0,
        d.o?.length || 0,
        d.h?.length || 0,
        d.l?.length || 0,
        d.c?.length || 0,
      );
      for (let i = 0; i < len; i++) {
        const ts = new Date((d.t[i] || 0) * 1000).toISOString();
        candles.push([ts, d.o[i], d.h[i], d.l[i], d.c[i]]);
      }
      return { candles };
    } catch (error) {
      this.logger.error(
        '[Vortex] getHistoricalData failed (non-fatal)',
        error as any,
      );
      return { candles: [] };
    }
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    const streamUrl =
      this.vortexWsUrlOverride || this.configService.get('VORTEX_WS_URL') || 'wss://wire.rupeezy.in/ws';
    this.logger.log(
      `[Vortex] Using WebSocket URL: ${streamUrl.replace(/auth_token=[^&]*/, 'auth_token=***')}`,
    );
    const maxShards = Math.min(
      3,
      Math.max(1, Number(process.env.VORTEX_WS_MAX_SHARDS || 3)),
    );
    this.vortexShardCount = maxShards;
    const self = this;
    this.ticker = new VortexShardedTicker({
      streamUrl,
      maxShards,
      maxSubscriptionsPerSocket: this.maxSubscriptionsPerSocket,
      logger: this.logger,
      parseBinaryTicks: (buf: Buffer) => parseVortexBinaryTicks(buf, this.logger),
      getExchangesForTokens: (tokens: string[]) =>
        this.getExchangesForTokens(tokens),
      getAccessToken: () => self.accessToken,
      getConfigAccessToken: () => self.configService.get('VORTEX_ACCESS_TOKEN'),
      maxReconnectAttempts: this.maxReconnectAttempts,
      onParentWsConnected: (anyConnected: boolean) => {
        self.wsConnected = anyConnected;
      },
      metrics: {
        incSubscribeDropped: (reason: string) => {
          try {
            self.metrics.vortexSubscribeDroppedTotal.labels(reason).inc();
          } catch {
            /* ignore */
          }
        },
        setShardsConnected: (n: number) => {
          try {
            self.metrics.vortexWsShardsConnected.labels('vortex').set(n);
          } catch {
            /* ignore */
          }
        },
      },
    });
    return this.ticker;
  }

  getTicker(): TickerLike {
    return this.ticker;
  }

  // Public: total upstream instrument capacity (Vortex: shards × 1000 per Rupeezy limits)
  getSubscriptionLimit(): number {
    return this.maxSubscriptionsPerSocket * this.vortexShardCount;
  }

  /** Vortex-only: per-socket cap, shard count, and total instruments (null when ticker not built). */
  getVortexWsLimits(): {
    perSocket: number;
    maxShards: number;
    total: number;
  } | null {
    const t = this.ticker as VortexShardedTicker | undefined;
    if (!t || typeof (t as any).getTotalCapacity !== 'function') {
      return null;
    }
    return {
      perSocket: t.getMaxPerSocket(),
      maxShards: t.getShardCount(),
      total: t.getTotalCapacity(),
    };
  }

  // Public: reusable exchange resolution for gateways/services (same precedence as REST)
  async resolveExchanges(
    tokens: string[],
  ): Promise<Map<string, 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'>> {
    return this.getExchangesForTokens(tokens);
  }

  // Public: prime the ticker's exchange mapping so subscribe() can avoid defaults
  primeExchangeMapping(
    pairs: Array<{ token: number; exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' }>,
  ) {
    try {
      const t = this.getTicker() as any;
      if (t && typeof t.primeExchangeMapping === 'function') {
        t.primeExchangeMapping(pairs);
      }
    } catch (e) {
      this.logger.warn('[Vortex] primeExchangeMapping failed', e as any);
    }
  }

  async updateAccessToken(token: string) {
    this.accessToken = token;
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.vortexApiKeyOverride || this.configService.get('VORTEX_API_KEY') || '';
    const bearer = this.accessToken || '';
    const h: Record<string, string> = { 'x-api-key': apiKey };
    if (bearer) h['Authorization'] = `Bearer ${bearer}`;
    return h;
  }

  private normalizeQuote(q: any) {
    const lp = Number(q?.last_trade_price);
    const open = Number(q?.open_price);
    const high = Number(q?.high_price);
    const low = Number(q?.low_price);
    const close = Number(q?.close_price);
    const volume = Number(q?.volume);
    const normalized = {
      last_price: Number.isFinite(lp) && lp > 0 ? lp : null,
      ohlc: {
        open: Number.isFinite(open) ? open : null,
        high: Number.isFinite(high) ? high : null,
        low: Number.isFinite(low) ? low : null,
        close: Number.isFinite(close) ? close : null,
      },
      volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    } as any;
    if (normalized.last_price === null) {
      this.logger.debug(
        '[Vortex] normalizeQuote: missing/invalid last_trade_price in provider response',
      );
    }
    return normalized;
  }

  getDebugStatus() {
    return {
      initialized: this.initialized,
      httpConfigured: !!this.http,
      httpClientReady: !!this.http,
      degraded: !this.http,
      wsConnected: this.wsConnected,
      reconnectAttempts: this.reconnectAttempts,
      hasAccessToken: !!this.accessToken,
    };
  }

  /**
   * Debug-only: Resolve exchanges for tokens with source attribution.
   * Order: vortex_instruments → instrument_mappings(provider=vortex) → instruments (legacy)
   */
  async debugResolveExchanges(
    tokens: string[],
  ): Promise<
    Array<{
      token: string;
      exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' | null;
      source: 'vortex_instruments' | 'instrument_mappings' | 'instruments' | null;
    }>
  > {
    try {
      const input = Array.from(
        new Set(tokens.map((t) => String(t || '').trim()).filter((t) => /^\d+$/.test(t))),
      );
      const nums = input.map((t) => Number(t));
      const resolved = new Map<string, { exchange: any; source: any }>();
      let viCount = 0;
      let imCount = 0;
      let instCount = 0;

      // 1) vortex_instruments
      try {
        const viRows = await this.vortexInstrumentRepo.find({
          where: { token: In(nums) } as any,
          select: ['token', 'exchange'] as any,
        });
        for (const r of viRows) {
          const ex = this.normalizeExchange(r.exchange || '');
          if (ex) {
            resolved.set(String(r.token), { exchange: ex, source: 'vortex_instruments' });
            viCount++;
          }
        }
      } catch (e) {
        this.logger.warn('[Vortex] debugResolveExchanges: vi lookup failed', e as any);
      }

      // 2) instrument_mappings (provider=vortex)
      try {
        const remaining = nums.filter((n) => !resolved.has(String(n)));
        if (remaining.length) {
          const maps = await this.instrumentMappingRepo.find({
            where: { provider: 'vortex', instrument_token: In(remaining) } as any,
            select: ['provider_token', 'instrument_token'] as any,
          });
          for (const m of maps) {
            const key = String(m.provider_token || '').toUpperCase();
            const [exPart] = key.split('-');
            const ex = this.normalizeExchange(exPart || '');
            if (ex) {
              resolved.set(String(m.instrument_token), {
                exchange: ex,
                source: 'instrument_mappings',
              });
              imCount++;
            }
          }
        }
      } catch (e) {
        this.logger.warn('[Vortex] debugResolveExchanges: mapping lookup failed', e as any);
      }

      // 3) legacy instruments
      try {
        const remaining = nums.filter((n) => !resolved.has(String(n)));
        if (remaining.length) {
          const rows = await this.instrumentRepo.find({
            where: { instrument_token: In(remaining) } as any,
            select: ['instrument_token', 'exchange', 'segment'] as any,
          });
          for (const r of rows) {
            const ex = this.normalizeExchange(r.exchange || r.segment || '');
            if (ex) {
              resolved.set(String(r.instrument_token), {
                exchange: ex,
                source: 'instruments',
              });
              instCount++;
            }
          }
        }
      } catch (e) {
        this.logger.warn('[Vortex] debugResolveExchanges: legacy lookup failed', e as any);
      }

      const out = input.map((t) => {
        const r = resolved.get(t);
        return { token: t, exchange: (r?.exchange as any) || null, source: (r?.source as any) || null };
      });

      this.logger.debug('[Vortex Debug] resolve summary', {
        requested: input.length,
        resolved: out.filter((x) => !!x.exchange).length,
        via: { vortex_instruments: viCount, instrument_mappings: imCount, instruments: instCount },
      });

      return out;
    } catch (e) {
      this.logger.warn('[Vortex] debugResolveExchanges failed', e as any);
      return tokens.map((t) => ({ token: String(t || ''), exchange: null, source: null }));
    }
  }

  /**
   * Debug-only: Build Vortex quotes query for tokens using resolved exchanges.
   */
  async debugBuildQuery(
    tokens: string[],
    mode: 'ltp' | 'ohlc' | 'full' = 'ltp',
  ): Promise<{ pairs: string[]; url: string; stats: { requested: number; included: number; unresolved: number } }> {
    const resolution = await this.debugResolveExchanges(tokens);
    const pairs = resolution
      .filter((r) => !!r.exchange)
      .map((r) => `${r.exchange}-${r.token}`);
    const qParams = pairs.map((k) => `q=${encodeURIComponent(k)}`).join('&');
    const url = `/data/quotes?${qParams}&mode=${mode}`;
    this.logger.debug('[Vortex Debug] buildQuery', {
      mode,
      requested: tokens.length,
      included: pairs.length,
    });
    return {
      pairs,
      url,
      stats: { requested: tokens.length, included: pairs.length, unresolved: tokens.length - pairs.length },
    };
  }

  private mapInterval(interval: string): string {
    const i = (interval || '').toLowerCase();
    if (i.includes('day')) return '1D';
    if (i.includes('week')) return '1W';
    if (i.includes('month')) return '1M';
    const m = parseInt(i) || 1;
    return String(Math.max(1, Math.min(240, m)));
  }

  // Resolve Vortex exchange per token using authoritative sources first.
  // Order of precedence:
  // 1) vortex_instruments.exchange
  // 2) instrument_mappings (provider=vortex → provider_token = EXCHANGE-TOKEN)
  // 3) instruments.exchange/segment (legacy)
  private async getExchangesForTokens(
    tokens: string[],
  ): Promise<Map<string, 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'>> {
    const map = new Map<string, any>();
    try {
      const nums = Array.from(
        new Set(
          tokens
            .map((t) => Number(String(t)))
            .filter((n) => Number.isFinite(n)),
        ),
      );
      if (!nums.length) return map;

      // 1) Use vortex_instruments (authoritative)
      let viRows: Array<{ token: number; exchange: string }> = [];
      try {
        viRows = await this.vortexInstrumentRepo.find({
          where: { token: In(nums) } as any,
          select: ['token', 'exchange'] as any,
        });
        for (const r of viRows) {
          const ex = this.normalizeExchange(r.exchange || '');
          if (ex) map.set(String(r.token), ex);
        }
      } catch (e) {
        this.logger.warn('[Vortex] Failed vortex_instruments lookup', e as any);
      }

      // 2) Use instrument_mappings (provider=vortex)
      const missingAfterVI = nums.filter((n) => !map.has(String(n)));
      let imRows: Array<{ provider_token: string; instrument_token: number }> = [];
      if (missingAfterVI.length) {
        try {
          imRows = await this.instrumentMappingRepo.find({
            where: { provider: 'vortex', instrument_token: In(missingAfterVI) } as any,
            select: ['provider_token', 'instrument_token'] as any,
          });
          for (const m of imRows) {
            const key = String(m.provider_token || '').toUpperCase();
            const [exPart] = key.split('-');
            const ex = this.normalizeExchange(exPart || '');
            if (ex) map.set(String(m.instrument_token), ex);
          }
        } catch (e) {
          this.logger.warn('[Vortex] Failed instrument_mappings lookup', e as any);
        }
      }

      // 3) Fall back to legacy instruments table
      const stillMissing = nums.filter((n) => !map.has(String(n)));
      if (stillMissing.length) {
        try {
          const rows = await this.instrumentRepo.find({
            where: { instrument_token: In(stillMissing) } as any,
            select: ['instrument_token', 'exchange', 'segment'] as any,
          });
          for (const r of rows) {
            const ex = this.normalizeExchange(r.exchange || r.segment || '');
            if (ex) map.set(String(r.instrument_token), ex);
          }
        } catch (e) {
          this.logger.warn('[Vortex] Legacy instruments lookup failed', e as any);
        }
      }

      const unresolved = nums.filter((n) => !map.has(String(n)));
      if (unresolved.length) {
        this.logger.debug(
          `[Vortex] Exchange unresolved for ${unresolved.length}/${nums.length} tokens (will use fallback in caller if any). Examples: ${unresolved
            .slice(0, 5)
            .join(',')}`,
        );
      }

      this.logger.debug(
        `[Vortex] Exchange resolution summary: requested=${nums.length}, resolved=${nums.length - unresolved.length}, via vi=${viRows.length}, map=${imRows.length}`,
      );
    } catch (e) {
      this.logger.warn(
        '[Vortex] getExchangesForTokens failed; callers may apply fallback',
        e as any,
      );
    }
    return map;
  }

  private normalizeExchange(
    ex: string,
  ): 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' | null {
    const s = (ex || '').toUpperCase();

    // 1. MCX check first to capture MCX_FO correctly
    if (s.includes('MCX')) return 'MCX_FO';

    // 2. Currency check next (specific segment)
    if (s.includes('NSE_CUR') || s.includes('CDS') || s.includes('CUR'))
      return 'NSE_CUR';

    // 3. F&O check (generic derivative terms like FO/FUT must be checked after MCX/Currency)
    if (
      s.includes('NSE_FO') ||
      s.includes('FO') ||
      s.includes('FUT') ||
      s.includes('FNO')
    )
      return 'NSE_FO';

    // 4. Equity check
    if (
      s.includes('NSE_EQ') ||
      s === 'NSE' ||
      s === 'EQ' ||
      s.includes('EQUITY')
    )
      return 'NSE_EQ';

    return null;
  }

  // Simple per-endpoint rate limiter for Vortex REST (1 req/sec)
  private lastReqAt: Record<string, number> = {};
  private async rateLimit(key: 'quotes' | 'ltp' | 'ohlc' | 'history') {
    try {
      const now = Date.now();
      const last = this.lastReqAt[key] || 0;
      const elapsed = now - last;
      const minInterval = 1000 + Math.floor(Math.random() * 100); // jitter up to 100ms
      if (elapsed < minInterval) {
        const sleep = minInterval - elapsed;
        await new Promise((r) => setTimeout(r, sleep));
      }
      this.lastReqAt[key] = Date.now();
    } catch {}
  }

  /**
   * Background refresh for LTP using singleflight per-token guard.
   */
  private refreshLtpInBackground(tokens: string[]) {
    try {
      const unique = Array.from(new Set(tokens.map((t) => String(t))));
      const pending: string[] = [];
      for (const t of unique) {
        if (!this.ltpRefreshInFlight.has(t)) {
          this.ltpRefreshInFlight.add(t);
          pending.push(t);
          this.noteHotset(t);
        }
      }
      if (!pending.length) return;
      (async () => {
        try {
          await this.getLTP(pending, { bypassCache: true, backgroundRefresh: false });
        } catch (e) {
          this.logger.debug('[Vortex] Background LTP refresh failed (non-fatal)', e as any);
        } finally {
          pending.forEach((t) => this.ltpRefreshInFlight.delete(t));
        }
      })();
    } catch (e) {
      this.logger.debug('[Vortex] refreshLtpInBackground scheduling failed', e as any);
    }
  }

  // Record tokens for potential hotset warming
  private noteHotset(token: string | number) {
    try {
      const key = String(token);
      this.hotsetRecent.set(key, Date.now());
      // Soft cap map size to avoid unbounded growth
      if (this.hotsetRecent.size > this.hotsetMax * 4) {
        // Drop oldest quarter
        const arr = Array.from(this.hotsetRecent.entries()).sort((a, b) => a[1] - b[1]);
        const drop = Math.floor(arr.length / 4);
        for (let i = 0; i < drop; i++) this.hotsetRecent.delete(arr[i][0]);
      }
    } catch {}
  }

  private startHotsetWarmer() {
    try {
      if (this.hotsetTimer) return;
      // Prime WS ticker
      const t = this.initializeTicker();
      // Attempt connect
      try {
        (t as any)?.connect?.();
      } catch {}
      const intervalMs = Math.max(10000, Number(process.env.VORTEX_HOTSET_INTERVAL_MS || 30000));
      this.hotsetTimer = setInterval(() => this.warmHotsetOnce(), intervalMs);
      this.logger.log(`[Vortex] Hotset warmer started (size=${this.hotsetMax})`);
    } catch (e) {
      this.logger.warn('[Vortex] Hotset warmer failed to start', e as any);
    }
  }

  private async warmHotsetOnce() {
    try {
      if (!this.hotsetEnabled) return;
      const ticker = this.getTicker() as any;
      if (!ticker || typeof ticker.subscribe !== 'function') return;
      // Pick top-K recent tokens
      const top = Array.from(this.hotsetRecent.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.hotsetMax)
        .map((e) => Number(e[0]))
        .filter((n) => Number.isFinite(n));
      if (!top.length) return;
      // Prime exchange mapping for better subscribe success
      try {
        const exMap = await this.getExchangesForTokens(top.map((n) => String(n)));
        const pairs: Array<{ token: number; exchange: any }> = [];
        for (const n of top) {
          const ex = exMap.get(String(n));
          if (ex) pairs.push({ token: n, exchange: ex });
        }
        this.primeExchangeMapping(pairs as any);
      } catch {}
      // Subscribe in LTP mode (ticker handles de-dup)
      try {
        ticker.subscribe(top, 'ltp');
      } catch (e) {
        this.logger.debug('[Vortex] Hotset subscribe failed (non-fatal)', e as any);
      }
    } catch (e) {
      this.logger.debug('[Vortex] warmHotsetOnce failed', e as any);
    }
  }

  /** Load DB-persisted config overrides into instance fields before initialize(). */
  private async loadConfigOverrides(): Promise<void> {
    try {
      const [apiKey, baseUrl, wsUrl, appId] = await Promise.all([
        this.appConfig.get('config:vortex:api_key').catch(() => null),
        this.appConfig.get('config:vortex:base_url').catch(() => null),
        this.appConfig.get('config:vortex:ws_url').catch(() => null),
        this.appConfig.get('config:vortex:app_id').catch(() => null),
      ]);
      if (apiKey) this.vortexApiKeyOverride = apiKey;
      if (baseUrl) this.vortexBaseUrlOverride = baseUrl;
      if (wsUrl) this.vortexWsUrlOverride = wsUrl;
      if (appId) this.vortexAppIdOverride = appId;
    } catch {}
  }

  /** Persist Vortex credential overrides to the DB and reinitialize provider. */
  async updateApiCredentials(params: {
    apiKey?: string;
    baseUrl?: string;
    wsUrl?: string;
    appId?: string;
  }): Promise<void> {
    const { apiKey, baseUrl, wsUrl, appId } = params;
    if (apiKey?.trim()) {
      this.vortexApiKeyOverride = apiKey.trim();
      await this.appConfig.set('config:vortex:api_key', apiKey.trim());
    }
    if (baseUrl?.trim()) {
      this.vortexBaseUrlOverride = baseUrl.trim();
      await this.appConfig.set('config:vortex:base_url', baseUrl.trim());
    }
    if (wsUrl?.trim()) {
      this.vortexWsUrlOverride = wsUrl.trim();
      await this.appConfig.set('config:vortex:ws_url', wsUrl.trim());
    }
    if (appId?.trim()) {
      this.vortexAppIdOverride = appId.trim();
      await this.appConfig.set('config:vortex:app_id', appId.trim());
    }
    // Re-init HTTP client if key or baseUrl changed
    if (apiKey || baseUrl) {
      await this.initialize();
    }
    this.logger.log('[Vortex] API credentials updated via admin endpoint');
  }

  /** Return masked config status for the admin dashboard. */
  async getConfigStatus() {
    const envApiKey = this.configService.get<string>('VORTEX_API_KEY');
    const envBaseUrl = this.configService.get<string>('VORTEX_BASE_URL');
    const envWsUrl = this.configService.get<string>('VORTEX_WS_URL');
    const envAppId = this.configService.get<string>('VORTEX_APP_ID');
    return {
      apiKey: {
        masked: this.maskCred(this.vortexApiKeyOverride || envApiKey || null),
        hasValue: !!(this.vortexApiKeyOverride || envApiKey),
        source: this.vortexApiKeyOverride ? 'redis' : (envApiKey ? 'env' : 'none'),
      },
      baseUrl: {
        value: this.vortexBaseUrlOverride || envBaseUrl || null,
        source: this.vortexBaseUrlOverride ? 'redis' : (envBaseUrl ? 'env' : 'none'),
      },
      wsUrl: {
        value: this.vortexWsUrlOverride || envWsUrl || 'wss://wire.rupeezy.in/ws',
        source: this.vortexWsUrlOverride ? 'redis' : (envWsUrl ? 'env' : 'default'),
      },
      appId: {
        masked: this.maskCred(this.vortexAppIdOverride || envAppId || null),
        hasValue: !!(this.vortexAppIdOverride || envAppId),
        source: this.vortexAppIdOverride ? 'redis' : (envAppId ? 'env' : 'none'),
      },
      initialized: !!this.http,
      hasAccessToken: !!this.accessToken,
    };
  }

  private maskCred(v: string | null): string | null {
    if (!v) return null;
    const s = String(v);
    if (s.length <= 6) return '****';
    return `${s.slice(0, 2)}****${s.slice(-4)}`;
  }

  private async loadSavedToken(): Promise<void> {
    try {
      const active = await this.vortexSessionRepo.findOne({
        where: { is_active: true },
        order: { created_at: 'DESC' },
      });
      if (active?.access_token) {
        // If expired, skip
        if (active.expires_at && active.expires_at.getTime() <= Date.now()) {
          this.logger.warn(
            '[Vortex] Saved token is expired; please login again',
          );
          return;
        }
        this.accessToken = active.access_token;
        this.logger.log('[Vortex] Auto-loaded access token from DB on startup');
      } else {
        this.logger.log('[Vortex] No active token found in DB; login required');
      }
    } catch (e) {
      this.logger.warn('[Vortex] Failed to load saved token from DB', e as any);
    }
  }

  private async ensureTokenLoaded(): Promise<void> {
    if (this.accessToken) return;
    try {
      const active = await this.vortexSessionRepo.findOne({
        where: { is_active: true },
        order: { created_at: 'DESC' },
      });
      if (active?.access_token) {
        // If expired, skip
        if (active.expires_at && active.expires_at.getTime() <= Date.now()) {
          this.logger.warn(
            '[Vortex] Active DB token is expired; please login again',
          );
          return;
        }
        this.accessToken = active.access_token;
        this.logger.log('[Vortex] Loaded access token from DB');
      }
    } catch (e) {
      this.logger.warn('[Vortex] Failed to load token from DB', e as any);
    }
  }

  // Lightweight provider health ping; does not throw
  async ping(): Promise<{ httpOk: boolean; reason?: string }> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) return { httpOk: false, reason: 'http_not_configured' };
      const url = `/data/quotes?q=NSE_EQ-26000&mode=ltp`;
      try {
        const resp = await this.httpGet(url, 'ltp', 3000);
        const ok = !!(resp as any)?.data;
        this.logger.debug(`[Vortex] Health ping successful: ${ok}`);
        return { httpOk: ok };
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 401 || status === 403) {
          // Service reachable but auth missing/expired
          this.logger.warn(
            `[Vortex] Health ping failed: auth error (${status})`,
          );
          return { httpOk: true, reason: 'auth_error' };
        }
        if (status === 429) {
          // Rate limit exceeded
          this.logger.warn('[Vortex] Health ping failed: rate limit exceeded');
          return { httpOk: true, reason: 'rate_limit' };
        }
        this.logger.error(
          `[Vortex] Health ping failed: ${status ? `HTTP ${status}` : e?.code || 'network_error'}`,
        );
        return {
          httpOk: false,
          reason: status ? `http_${status}` : e?.code || 'network_error',
        };
      }
    } catch (e: any) {
      this.logger.error(
        `[Vortex] Health ping error: ${e?.message || 'unknown'}`,
      );
      return { httpOk: false, reason: e?.message || 'unknown' };
    }
  }
}
