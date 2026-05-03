/**
 * @file kite-provider.service.ts
 * @module kite-connect
 * @description Kite Connect HTTP + ticker provider implementing MarketDataProvider; ticker wrapped for stream mode parity with Vortex (ohlcv → quote).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-21 — fix: persist currentApiKey in initialize() before early return; appConfig fallback in updateAccessToken, KITE_WS_MAX_SHARDS, getSubscriptionLimit/getShardStatus, exponential-backoff reconnect, resolveExchanges(), Redis pub/sub events, kite reconnect metrics
 *
 * Notes:
 * - refreshSession / isClientInitialized support scheduled Falcon instrument sync.
 * - getHistoricalData: SDK param order is (token, interval, from, to, continuous, oi).
 * - getProfile / getMargins: Kite account info endpoints.
 * - resolveExchanges: queries falcon_instruments DB, caches result in Redis 24h.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { RedisService } from '@infra/redis/redis.service';
import { AppConfigService } from '@infra/app-config/app-config.service';
import {
  MarketDataProvider,
  MarketDataExchangeToken,
  MarketDataLtpPair,
  TickerLike,
} from '@features/market-data/infra/market-data.provider';
import { MetricsService } from '@infra/observability/metrics.service';
import { FalconInstrument } from '@features/falcon/domain/falcon-instrument.entity';
import { KiteSession } from '@features/kite-connect/domain/kite-session.entity';
import { KiteConnect } from 'kiteconnect';
import { KiteShardedTicker, KiteShardStatus } from '@features/kite-connect/infra/kite-sharded-ticker';

/** Kite segment → Vortex-style exchange label (used by resolveExchanges). */
const SEGMENT_TO_EXCHANGE: Record<string, string> = {
  NSE: 'NSE_EQ',
  BSE: 'BSE_EQ',
  NFO: 'NSE_FO',
  'NFO-FUT': 'NSE_FO',
  'NFO-OPT': 'NSE_FO',
  MCX: 'MCX_FO',
  'MCX-FUT': 'MCX_FO',
  'MCX-OPT': 'MCX_FO',
  CDS: 'NSE_CUR',
  'CDS-FUT': 'NSE_CUR',
  'CDS-OPT': 'NSE_CUR',
  BFO: 'BSE_FO',
};

@Injectable()
export class KiteProviderService implements OnModuleInit, MarketDataProvider {
  readonly providerName = 'kite' as const;
  private readonly logger = new Logger(KiteProviderService.name);
  private kite: KiteConnect | undefined;
  private ticker: TickerLike | undefined;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private disableReconnect = false;
  private currentApiKey: string | null = null;
  private currentAccessToken: string | null = null;
  private lastTickerError: {
    message: string;
    code?: any;
    status?: any;
    time: string;
  } | null = null;
  private reconnectCount = 0;
  /** Number of WS shards configured (read from KITE_WS_MAX_SHARDS on first initializeTicker call). */
  private maxShards = 1;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private metrics: MetricsService,
    private appConfig: AppConfigService,
    @InjectRepository(FalconInstrument)
    private falconInstrumentRepo: Repository<FalconInstrument>,
    @InjectRepository(KiteSession)
    private kiteSessionRepo: Repository<KiteSession>,
  ) {}

  async onModuleInit() {
    await this.initialize();
  }

  private static readonly REDIS_API_KEY = 'config:kite:api_key';
  private static readonly REDIS_API_SECRET = 'config:kite:api_secret';

  async initialize(): Promise<void> {
    try {
      // Prefer DB override (set via admin endpoint), then env var
      let apiKey = this.configService.get<string>('KITE_API_KEY');
      try {
        const dbApiKey = await this.appConfig.get(KiteProviderService.REDIS_API_KEY);
        if (dbApiKey) apiKey = dbApiKey;
      } catch {}
      // Priority: Redis (freshest, set by OAuth callback) → env var (startup default) → DB session
      let accessToken: string | undefined;
      if (this.redisService?.isRedisAvailable?.()) {
        try {
          accessToken =
            (await this.redisService.get<string>('kite:access_token')) ||
            undefined;
          if (accessToken)
            this.logger.log('[Kite] Loaded access token from Redis cache');
        } catch {}
      }
      if (!accessToken) {
        accessToken = this.configService.get('KITE_ACCESS_TOKEN') || undefined;
      }
      // Last-resort: read from kite_sessions table (survives restarts when Redis is unavailable)
      if (!accessToken) {
        try {
          const session = await this.kiteSessionRepo.findOne({
            where: { is_active: true },
            order: { created_at: 'DESC' },
          });
          if (session?.access_token) {
            accessToken = session.access_token;
            this.logger.log('[Kite] Loaded access token from kite_sessions DB table');
          }
        } catch {}
      }

      // Persist the API key even when access token is absent — updateAccessToken()
      // needs it later when the OAuth callback fires after a server restart.
      if (apiKey) this.currentApiKey = apiKey;

      if (!apiKey || !accessToken) {
        this.logger.warn(
          '[Kite] Credentials not found. Provider will operate in degraded mode.',
        );
        this.logger.warn(
          '[Kite] Visit /api/auth/falcon/login to authenticate and enable ticker.',
        );
        this.refreshDegradedMetric();
        return;
      }

      this.currentApiKey = apiKey;
      this.currentAccessToken = accessToken;
      this.kite = new KiteConnect({
        api_key: apiKey,
        access_token: accessToken,
      });
      this.logger.log('[Kite] Client initialized successfully');
      this.refreshDegradedMetric();
    } catch (error) {
      this.logger.error('[Kite] Failed to initialize client', error as any);
      this.refreshDegradedMetric();
    }
  }

  async updateAccessToken(accessToken: string): Promise<void> {
    try {
      this.currentAccessToken = accessToken;
      if (!this.kite) {
        let apiKey = this.currentApiKey || this.configService.get('KITE_API_KEY');
        // Last-resort: API key was saved to DB after initialize() ran (e.g. via admin UI)
        if (!apiKey) {
          apiKey = await this.appConfig.get(KiteProviderService.REDIS_API_KEY).catch(() => null);
        }
        if (!apiKey) throw new Error('Kite API key not configured');
        this.currentApiKey = apiKey;
        this.kite = new KiteConnect({
          api_key: apiKey,
          access_token: accessToken,
        });
      } else if (typeof (this.kite as any).setAccessToken === 'function') {
        (this.kite as any).setAccessToken(accessToken);
      } else {
        const apiKey =
          this.currentApiKey || this.configService.get('KITE_API_KEY');
        this.currentApiKey = apiKey;
        this.kite = new KiteConnect({
          api_key: apiKey,
          access_token: accessToken,
        });
      }
      this.logger.log('[Kite] Access token updated');
      this.refreshDegradedMetric();
    } catch (error) {
      this.logger.error('[Kite] Failed to update access token', error as any);
      throw error;
    }
  }

  /** Kite quotes are token-scoped; exchange priming is a no-op. */
  primeExchangeMapping(_pairs: MarketDataExchangeToken[]): void {
    void _pairs;
  }

  async getLTPByPairs(
    pairs: MarketDataLtpPair[],
  ): Promise<Record<string, { last_price: number | null }>> {
    const out: Record<string, { last_price: number | null }> = {};
    if (!pairs?.length) return out;
    if (!this.kite) {
      for (const p of pairs) {
        const k = `${String(p.exchange).toUpperCase()}-${String(p.token)}`;
        out[k] = { last_price: null };
      }
      return out;
    }
    const uniq = [...new Set(pairs.map((p) => String(p.token)))];
    let ltpMap: Record<string, any> = {};
    try {
      ltpMap = await this.kite.getLTP(uniq);
    } catch (error) {
      this.logger.error('[Kite] getLTPByPairs upstream failed', error as any);
      for (const p of pairs) {
        const k = `${String(p.exchange).toUpperCase()}-${String(p.token)}`;
        out[k] = { last_price: null };
      }
      return out;
    }
    for (const p of pairs) {
      const k = `${String(p.exchange).toUpperCase()}-${String(p.token)}`;
      const tok = String(p.token);
      const row = ltpMap[tok] ?? ltpMap[p.token as any];
      const lp = row?.last_price;
      out[k] = {
        last_price:
          Number.isFinite(Number(lp)) && Number(lp) > 0 ? Number(lp) : null,
      };
    }
    return out;
  }

  async getInstruments(exchange?: string): Promise<any[]> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getInstruments: client not initialized (degraded). Returning [].',
        );
        return [];
      }
      const instruments = await this.kite.getInstruments(exchange);
      this.logger.log(
        `[Kite] Fetched ${Object.keys(instruments).length} instruments`,
      );
      return Object.values(instruments);
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch instruments', error as any);
      throw error;
    }
  }

  async getQuote(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getQuote: client not initialized (degraded). Returning {}.',
        );
        return {};
      }
      const quotes = await this.kite.getQuote(instrumentTokens);
      return quotes;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch quotes', error as any);
      throw error;
    }
  }

  async getHistoricalData(
    instrumentToken: number,
    fromDate: string,
    toDate: string,
    interval: string,
    continuous = false,
    oi = false,
  ): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getHistoricalData: client not initialized (degraded). Returning null.',
        );
        return null;
      }
      // SDK signature: (instrument_token, interval, from_date, to_date, continuous, oi)
      const historicalData = await this.kite.getHistoricalData(
        instrumentToken,
        interval,
        fromDate,
        toDate,
        continuous,
        oi,
      );
      return historicalData;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch historical data', error as any);
      throw error;
    }
  }

  async getProfile(): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getProfile: client not initialized (degraded). Returning null.',
        );
        return null;
      }
      return await (this.kite as any).getProfile();
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch profile', error as any);
      throw error;
    }
  }

  async getMargins(segment?: 'equity' | 'commodity'): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getMargins: client not initialized (degraded). Returning null.',
        );
        return null;
      }
      return await (this.kite as any).getMargins(segment);
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch margins', error as any);
      throw error;
    }
  }

  async getLTP(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getLTP: client not initialized (degraded). Returning {}.',
        );
        return {};
      }
      const ltp = await this.kite.getLTP(instrumentTokens);
      return ltp;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch LTP', error as any);
      throw error;
    }
  }

  async getOHLC(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        this.logger.warn(
          '[Kite] getOHLC: client not initialized (degraded). Returning {}.',
        );
        return {};
      }
      const ohlc = await this.kite.getOHLC(instrumentTokens);
      return ohlc;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch OHLC', error as any);
      throw error;
    }
  }

  /**
   * Resolve numeric instrument tokens to Vortex-style exchange labels.
   * Uses falcon_instruments DB with a 24-hour Redis cache per token.
   * Falls back to 'NSE_EQ' for tokens not found in DB.
   */
  async resolveExchanges(tokens: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!tokens?.length) return result;

    const uncached: string[] = [];
    // Check Redis cache first
    for (const tok of tokens) {
      try {
        const cached = await this.redisService.get<string>(`falcon:tok:exchange:${tok}`);
        if (cached) {
          result.set(tok, cached);
        } else {
          uncached.push(tok);
        }
      } catch {
        uncached.push(tok);
      }
    }

    if (!uncached.length) return result;

    // DB lookup for uncached tokens
    try {
      const numericTokens = uncached.map(Number).filter((n) => Number.isFinite(n));
      if (numericTokens.length) {
        const rows = await this.falconInstrumentRepo.find({
          where: { instrument_token: In(numericTokens) },
          select: ['instrument_token', 'segment', 'exchange'],
        });
        for (const row of rows) {
          const tok = String(row.instrument_token);
          const exchange =
            SEGMENT_TO_EXCHANGE[row.segment] ??
            SEGMENT_TO_EXCHANGE[row.exchange] ??
            'NSE_EQ';
          result.set(tok, exchange);
          // Cache in Redis
          this.redisService
            .set(`falcon:tok:exchange:${tok}`, exchange, 86400)
            .catch(() => {});
        }
      }
    } catch (err) {
      this.logger.warn('[Kite] resolveExchanges DB lookup failed', err as any);
    }

    // Default fallback for anything still unresolved
    for (const tok of uncached) {
      if (!result.has(tok)) {
        result.set(tok, 'NSE_EQ');
      }
    }

    return result;
  }

  private refreshDegradedMetric() {
    try {
      const degraded = this.kite ? 0 : 1;
      this.metrics.providerDegradedMode.labels('kite').set(degraded);
    } catch {
      /* non-fatal */
    }
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    const apiKey = this.currentApiKey || this.configService.get('KITE_API_KEY');
    const accessToken =
      this.currentAccessToken || this.configService.get('KITE_ACCESS_TOKEN');
    if (!apiKey || !accessToken) {
      this.logger.warn('[Kite] Credentials missing; ticker not initialized');
      return undefined as any;
    }

    const maxShards = Math.max(1, Number(this.configService.get('KITE_WS_MAX_SHARDS') || 1));
    this.maxShards = maxShards;

    const shardedTicker = new KiteShardedTicker({
      apiKey,
      accessToken,
      maxShards,
      maxReconnectAttempts: this.maxReconnectAttempts,
      logger: this.logger,
      onTick: (ticks) => {
        this.logger.debug?.(`[Kite] Received ${ticks?.length || 0} ticks (shards=${maxShards})`);
      },
      onConnect: (shardIndex) => {
        if (!this.isConnected) {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.disableReconnect = false;
          this.metrics.marketDataStreamTickerConnected.labels('kite').set(1);
          this.publishStreamStatus('connect');
          this.logger.log(`[Kite] Shard ${shardIndex} connected (first connection)`);
        } else {
          this.logger.log(`[Kite] Shard ${shardIndex} reconnected`);
        }
        void this.redisService.lpushTrim('admin:events', JSON.stringify({
          type: 'connect', shardIndex, ts: Date.now(), message: `Shard ${shardIndex} connected`,
        }));
      },
      onDisconnect: (shardIndex, _args) => {
        const allDisconnected = shardedTicker.getShardStatus().every((s) => !s.isConnected);
        if (allDisconnected) {
          this.isConnected = false;
          this.metrics.marketDataStreamTickerConnected.labels('kite').set(0);
          this.publishStreamStatus('disconnect');
        }
        this.reconnectCount++;
        this.metrics.kiteTickerReconnectTotal.labels('reconnecting').inc();
        this.logger.warn(`[Kite] Shard ${shardIndex} disconnected (allDisconnected=${allDisconnected})`);
        void this.redisService.lpushTrim('admin:events', JSON.stringify({
          type: 'disconnect', shardIndex, ts: Date.now(), message: `Shard ${shardIndex} disconnected`,
        }));
      },
      onAuthError: (_shardIndex, error) => {
        const pretty = this.formatError(error);
        this.lastTickerError = {
          message: pretty,
          code: (error && (error.code || error?.data?.code)) || undefined,
          status: (error && (error.status || error?.data?.status)) || undefined,
          time: new Date().toISOString(),
        };
        this.disableReconnect = true;
        this.isConnected = false;
        this.metrics.kiteTickerReconnectTotal.labels('auth_error').inc();
        this.metrics.marketDataStreamTickerConnected.labels('kite').set(0);
        this.publishStreamStatus('auth_error');
        this.logger.warn('[Kite] Disabling reconnect due to authentication error. Visit /api/auth/falcon/login to re-authenticate.');
        void this.redisService.lpushTrim('admin:events', JSON.stringify({
          type: 'auth_error', shardIndex: _shardIndex, ts: Date.now(), message: pretty || 'Auth error — re-authenticate',
        }));
      },
      onMaxReconnect: (_shardIndex) => {
        this.metrics.kiteTickerReconnectTotal.labels('max_attempts').inc();
        this.publishStreamStatus('provider_halted');
        void this.redisService.lpushTrim('admin:events', JSON.stringify({
          type: 'max_reconnect', shardIndex: _shardIndex, ts: Date.now(), message: 'Max reconnect attempts reached — provider halted',
        }));
      },
      onError: (_shardIndex, error) => {
        const pretty = this.formatError(error);
        this.lastTickerError = {
          message: pretty,
          code: (error && (error.code || error?.data?.code)) || undefined,
          status: (error && (error.status || error?.data?.status)) || undefined,
          time: new Date().toISOString(),
        };
        this.logger.error('[Kite] Ticker error: ' + pretty);
      },
    });

    this.ticker = shardedTicker;
    return this.ticker;
  }

  /** Total upstream instrument capacity across all shards (3000 × numShards). */
  getSubscriptionLimit(): number {
    return (this.ticker as KiteShardedTicker)?.getSubscriptionLimit?.() ?? 3000;
  }

  /** Per-shard status for admin monitoring. */
  getShardStatus(): KiteShardStatus[] {
    return (this.ticker as KiteShardedTicker)?.getShardStatus?.() ?? [];
  }

  async restartTicker(): Promise<void> {
    try {
      if (this.ticker) {
        try {
          this.ticker.disconnect?.();
        } catch {}
      }
      this.ticker = undefined as any;
      // Reset aggregate state so fresh connection starts cleanly
      this.reconnectAttempts = 0;
      this.disableReconnect = false;
      this.isConnected = false;
      const ticker = this.initializeTicker();
      try {
        ticker?.connect?.();
      } catch (e) {
        this.logger.error(
          '[Kite] Failed to connect ticker after restart',
          e as any,
        );
      }
      this.logger.log('[Kite] Ticker restarted');
    } catch (error) {
      this.logger.error('[Kite] Error restarting ticker', error as any);
    }
  }

  getTicker(): TickerLike {
    return this.ticker;
  }

  isKiteConnected(): boolean {
    return this.isConnected;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  private isAuthError(error: any): boolean {
    const msg = (error?.message || error?.toString?.() || '')
      .toString()
      .toLowerCase();
    if (!msg) return false;
    return (
      msg.includes('token') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('expired') ||
      msg.includes('invalid') ||
      msg.includes('401') ||
      msg.includes('403')
    );
  }

  private publishStreamStatus(event: string): void {
    try {
      this.redisService
        .publish('stream:status', {
          event,
          provider: 'kite',
          ts: new Date().toISOString(),
        })
        .catch(() => {});
    } catch {}
  }

  private formatError(error: any): string {
    try {
      if (!error) return 'unknown';
      if (typeof error === 'string') return error;
      const msg =
        error.message || error.reason || error.error || error.toString?.();
      const details: any = {};
      ['code', 'status', 'type'].forEach((k) => {
        if (error[k] !== undefined) details[k] = error[k];
      });
      if (error.data && typeof error.data === 'object') {
        const d: any = {};
        ['error_type', 'message', 'status', 'code'].forEach((k) => {
          if (error.data[k] !== undefined) d[k] = error.data[k];
        });
        if (Object.keys(d).length) details.data = d;
      }
      const parts = [] as string[];
      if (msg) parts.push(String(msg));
      if (Object.keys(details).length) parts.push(JSON.stringify(details));
      return parts.join(' | ');
    } catch {
      return '[unserializable error]';
    }
  }

  private stringifyArgs(args: any[]): string {
    try {
      if (!args || !args.length) return '';
      const safe = args.map((a) => {
        if (a === undefined || a === null) return a;
        if (
          typeof a === 'string' ||
          typeof a === 'number' ||
          typeof a === 'boolean'
        )
          return a;
        return JSON.stringify(a);
      });
      return safe.join(' ');
    } catch {
      return '';
    }
  }

  /**
   * Persist a new API key (and optional secret) to Redis so they survive restarts.
   * Immediately re-initializes the KiteConnect client with the new key.
   */
  async updateApiCredentials(apiKey: string, apiSecret?: string): Promise<void> {
    if (!apiKey?.trim()) throw new Error('API key cannot be empty');
    try {
      await this.appConfig.set(KiteProviderService.REDIS_API_KEY, apiKey.trim());
      if (apiSecret?.trim()) {
        await this.appConfig.set(KiteProviderService.REDIS_API_SECRET, apiSecret.trim());
      }
      this.currentApiKey = apiKey.trim();
      if (this.currentAccessToken) {
        this.kite = new KiteConnect({ api_key: this.currentApiKey, access_token: this.currentAccessToken });
      } else {
        // no access token yet — leave kite undefined until OAuth completes
        this.kite = undefined;
      }
      this.logger.log('[Kite] API credentials updated via admin endpoint');
      this.refreshDegradedMetric();
    } catch (error) {
      this.logger.error('[Kite] Failed to update API credentials', error as any);
      throw error;
    }
  }

  /** Return masked config status for the admin dashboard. */
  async getConfigStatus() {
    let hasDbApiKey = false;
    let hasDbApiSecret = false;
    try {
      hasDbApiKey = !!(await this.appConfig.get(KiteProviderService.REDIS_API_KEY));
      hasDbApiSecret = !!(await this.appConfig.get(KiteProviderService.REDIS_API_SECRET));
    } catch {}
    const envApiKey = this.configService.get<string>('KITE_API_KEY');
    const envApiSecret = this.configService.get<string>('KITE_API_SECRET');
    return {
      apiKey: {
        masked: this.mask(this.currentApiKey),
        hasValue: !!this.currentApiKey,
        source: hasDbApiKey ? 'db' : (envApiKey ? 'env' : 'none'),
      },
      apiSecret: {
        hasValue: hasDbApiSecret || !!envApiSecret,
        source: hasDbApiSecret ? 'db' : (envApiSecret ? 'env' : 'none'),
      },
      accessToken: {
        masked: this.mask(this.currentAccessToken),
        hasValue: !!this.currentAccessToken,
      },
      initialized: !!this.kite,
    };
  }

  /**
   * Re-load credentials from env/Redis and rebuild the HTTP client.
   * Call before scheduled work so a fresh OAuth token in Redis is picked up.
   */
  async refreshSession(): Promise<void> {
    await this.initialize();
  }

  /** True when Kite Connect HTTP client is ready (instruments/quotes APIs). */
  isClientInitialized(): boolean {
    return !!this.kite;
  }

  // Exposed for debugging via controller
  getDebugStatus() {
    const shards = this.getShardStatus();
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      reconnectCount: this.reconnectCount,
      disableReconnect: this.disableReconnect,
      hasApiKey: !!this.currentApiKey,
      hasAccessToken: !!this.currentAccessToken,
      httpClientReady: !!this.kite,
      degraded: !this.kite,
      maskedApiKey: this.mask(this.currentApiKey),
      maskedAccessToken: this.mask(this.currentAccessToken),
      lastTickerError: this.lastTickerError,
      shardCount: shards.length || this.maxShards,
      subscriptionLimit: this.getSubscriptionLimit(),
      shards,
    };
  }

  private mask(v: string | null): string | null {
    if (!v) return null;
    const s = String(v);
    if (s.length <= 6) return '****';
    return `${s.slice(0, 2)}****${s.slice(-4)}`;
  }
}
