/**
 * @file massive-provider.service.ts
 * @module massive
 * @description Massive (formerly Polygon.io) market data provider — implements MarketDataProvider
 *   for US stocks, forex, crypto, indices, and options.
 *   Credentials: admin panel (app_configs table) preferred, MASSIVE_API_KEY env var as fallback.
 *   Realtime: MASSIVE_REALTIME=true (default: delayed).
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-19
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MarketDataProvider,
  MarketDataExchangeToken,
  MarketDataLtpPair,
  TickerLike,
} from '@features/market-data/infra/market-data.provider';
import { MassiveRestClient } from './massive-rest.client';
import { MassiveWebSocketClient } from './massive-websocket.client';
import { MassiveAssetClass } from '../massive.constants';
import { AppConfigService } from '@infra/app-config/app-config.service';

@Injectable()
export class MassiveProviderService implements OnModuleInit, MarketDataProvider {
  readonly providerName = 'massive' as const;
  private readonly logger = new Logger(MassiveProviderService.name);
  private ticker: MassiveWebSocketClient | undefined;
  private initialized = false;

  // DB-persisted overrides (win over env vars)
  private apiKeyOverride: string | null = null;
  private realtimeOverride: boolean | null = null;
  private assetClassOverride: MassiveAssetClass | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly rest: MassiveRestClient,
    private readonly ws: MassiveWebSocketClient,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadConfigOverrides();
    await this.initialize();
  }

  private async loadConfigOverrides(): Promise<void> {
    const [apiKey, realtime, assetClass] = await Promise.all([
      this.appConfig.get('config:massive:api_key').catch(() => null),
      this.appConfig.get('config:massive:realtime').catch(() => null),
      this.appConfig.get('config:massive:asset_class').catch(() => null),
    ]);
    if (apiKey) this.apiKeyOverride = apiKey;
    if (realtime != null) this.realtimeOverride = realtime === 'true';
    if (assetClass) this.assetClassOverride = assetClass as MassiveAssetClass;
  }

  async initialize(): Promise<void> {
    const apiKey = this.apiKeyOverride ?? this.config.get<string>('MASSIVE_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        '[Massive] No API key configured — provider operating in degraded mode. Set via admin panel or MASSIVE_API_KEY env var.',
      );
      this.initialized = false;
      return;
    }
    const realtime =
      this.realtimeOverride ?? (this.config.get<string>('MASSIVE_REALTIME') === 'true');
    const assetClass = (
      this.assetClassOverride ??
      this.config.get<string>('MASSIVE_WS_ASSET_CLASS') ??
      'stocks'
    ) as MassiveAssetClass;

    const wasConnected = this.ws.isWsConnected();
    this.rest.init(apiKey);
    this.ws.init(apiKey, realtime, assetClass);
    this.initialized = true;
    this.logger.log(`[Massive] Provider initialized (realtime=${realtime}, assetClass=${assetClass})`);
    // Reconnect WS if it was previously connected (credential hot-reload)
    if (wasConnected) {
      try { this.ws.disconnect?.(); } catch {}
      setTimeout(() => { try { this.ws.connect?.(); } catch {} }, 100);
    }
  }

  async updateApiCredentials(params: {
    apiKey?: string;
    realtime?: boolean;
    assetClass?: string;
  }): Promise<void> {
    if (params.apiKey?.trim()) {
      this.apiKeyOverride = params.apiKey.trim();
      await this.appConfig.set('config:massive:api_key', this.apiKeyOverride);
    }
    if (params.realtime != null) {
      this.realtimeOverride = params.realtime;
      await this.appConfig.set('config:massive:realtime', String(params.realtime));
    }
    if (params.assetClass?.trim()) {
      this.assetClassOverride = params.assetClass.trim() as MassiveAssetClass;
      await this.appConfig.set('config:massive:asset_class', this.assetClassOverride);
    }
    await this.initialize();
  }

  async getConfigStatus(): Promise<{
    apiKey: { masked: string | null; source: 'db' | 'env' | 'none'; configured: boolean };
    realtime: boolean;
    assetClass: string;
    initialized: boolean;
    degraded: boolean;
  }> {
    const envKey = this.config.get<string>('MASSIVE_API_KEY') ?? null;
    const effectiveKey = this.apiKeyOverride ?? envKey;
    return {
      apiKey: {
        masked: this.maskCred(effectiveKey),
        source: this.apiKeyOverride ? 'db' : (envKey ? 'env' : 'none'),
        configured: !!effectiveKey,
      },
      realtime: this.realtimeOverride ?? (this.config.get<string>('MASSIVE_REALTIME') === 'true'),
      assetClass:
        this.assetClassOverride ??
        this.config.get<string>('MASSIVE_WS_ASSET_CLASS') ??
        'stocks',
      initialized: this.initialized,
      degraded: this.isDegraded(),
    };
  }

  private maskCred(s: string | null): string | null {
    if (!s) return null;
    if (s.length < 8) return '***';
    return s.slice(0, 4) + '****' + s.slice(-4);
  }

  /** Exchange priming is a no-op for Massive (symbol-based, no exchange mapping needed). */
  primeExchangeMapping(_pairs: MarketDataExchangeToken[]): void {
    void _pairs;
  }

  async getInstruments(exchange?: string, opts?: any): Promise<any[]> {
    if (!this.rest.isReady()) {
      this.logger.warn('[Massive] getInstruments: client not initialized (degraded)');
      return [];
    }
    try {
      const market = exchange || opts?.market || 'stocks';
      const search = opts?.search as string | undefined;
      const data = await this.rest.getReferenceTickers(search, market);
      if (!data?.results) return [];
      return data.results.map((r) => ({
        instrument_token: r.ticker,
        tradingsymbol: r.ticker,
        name: r.name,
        exchange: r.market,
        segment: r.type ?? 'EQ',
        instrument_type: r.type ?? 'EQ',
      }));
    } catch (err) {
      this.logger.error('[Massive] getInstruments failed', err as any);
      return [];
    }
  }

  async getQuote(tokens: string[]): Promise<Record<string, any>> {
    if (!this.rest.isReady()) {
      this.logger.warn('[Massive] getQuote: client not initialized (degraded)');
      return {};
    }
    try {
      const snapshots = await this.rest.getSnapshots(tokens);
      const result: Record<string, any> = {};
      for (const [sym, snap] of Object.entries(snapshots)) {
        const lt = snap.lastTrade;
        const lq = snap.lastQuote;
        const day = snap.day;
        result[sym] = {
          instrument_token: sym,
          last_price: lt?.p ?? 0,
          buy_price: lq?.p ?? 0,
          sell_price: lq?.P ?? 0,
          volume: day?.v ?? 0,
          ohlc: day
            ? { open: day.o, high: day.h, low: day.l, close: day.c }
            : undefined,
          net_change: snap.todaysChange ?? 0,
          oi: 0,
          oi_day_high: 0,
          oi_day_low: 0,
        };
      }
      return result;
    } catch (err) {
      this.logger.error('[Massive] getQuote failed', err as any);
      return {};
    }
  }

  async getLTP(tokens: string[]): Promise<Record<string, any>> {
    if (!this.rest.isReady()) {
      this.logger.warn('[Massive] getLTP: client not initialized (degraded)');
      return {};
    }
    try {
      const snapshots = await this.rest.getSnapshots(tokens);
      const result: Record<string, any> = {};
      for (const [sym, snap] of Object.entries(snapshots)) {
        result[sym] = { instrument_token: sym, last_price: snap.lastTrade?.p ?? 0 };
      }
      return result;
    } catch (err) {
      this.logger.error('[Massive] getLTP failed', err as any);
      return {};
    }
  }

  async getOHLC(tokens: string[]): Promise<Record<string, any>> {
    if (!this.rest.isReady()) {
      this.logger.warn('[Massive] getOHLC: client not initialized (degraded)');
      return {};
    }
    try {
      const snapshots = await this.rest.getSnapshots(tokens);
      const result: Record<string, any> = {};
      for (const [sym, snap] of Object.entries(snapshots)) {
        const day = snap.day;
        result[sym] = {
          instrument_token: sym,
          last_price: snap.lastTrade?.p ?? 0,
          ohlc: day ? { open: day.o, high: day.h, low: day.l, close: day.c } : {},
        };
      }
      return result;
    } catch (err) {
      this.logger.error('[Massive] getOHLC failed', err as any);
      return {};
    }
  }

  async getLTPByPairs(
    pairs: MarketDataLtpPair[],
  ): Promise<Record<string, { last_price: number | null }>> {
    const result: Record<string, { last_price: number | null }> = {};
    if (!pairs?.length) return result;
    const tokens = [...new Set(pairs.map((p) => String(p.token)))];
    let ltpMap: Record<string, any> = {};
    try {
      ltpMap = await this.getLTP(tokens);
    } catch {}
    for (const p of pairs) {
      const k = `${String(p.exchange).toUpperCase()}-${String(p.token)}`;
      const lp = ltpMap[String(p.token)]?.last_price;
      result[k] = {
        last_price: Number.isFinite(Number(lp)) && Number(lp) > 0 ? Number(lp) : null,
      };
    }
    return result;
  }

  async getHistoricalData(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<any> {
    // token may be passed as the numeric UIR proxy; caller should pass symbol as string via opts
    const ticker = String(token);
    if (!this.rest.isReady()) {
      this.logger.warn('[Massive] getHistoricalData: client not initialized (degraded)');
      return null;
    }
    try {
      const bars = await this.rest.getAggregates(ticker, from, to, interval);
      return bars.map((b) => ({
        date: new Date(b.t).toISOString(),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      }));
    } catch (err) {
      this.logger.error('[Massive] getHistoricalData failed', err as any);
      return null;
    }
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    if (!this.ws.isReady()) {
      this.logger.warn('[Massive] initializeTicker: API key not set — ticker unavailable');
      return undefined as any;
    }
    this.ticker = this.ws;
    return this.ticker;
  }

  getTicker(): TickerLike {
    return this.ticker;
  }

  /** Massive has no hard subscription cap — return a large safe number. */
  getSubscriptionLimit(): number {
    return 100_000;
  }

  /** Massive uses a single WS connection per asset class — report as one shard. */
  getShardStatus(): Array<{
    index: number;
    isConnected: boolean;
    subscribedCount: number;
    reconnectAttempts: number;
    reconnectCount: number;
    disableReconnect: boolean;
  }> {
    return [
      {
        index: 0,
        isConnected: this.ws.isWsConnected(),
        subscribedCount: this.ws.getSubscribedCount(),
        reconnectAttempts: 0,
        reconnectCount: 0,
        disableReconnect: false,
      },
    ];
  }

  isDegraded(): boolean {
    return !this.initialized;
  }
}
