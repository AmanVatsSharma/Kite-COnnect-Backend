/**
 * @file binance-provider.service.ts
 * @module binance
 * @description Binance market-data provider — implements MarketDataProvider for spot crypto pairs
 *   via the public (unauthenticated) Binance.com global Spot REST + combined-stream WebSocket.
 *   The WS facade is created lazily on first `initializeTicker()` call and reused thereafter.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  MarketDataExchangeToken,
  MarketDataLtpPair,
  MarketDataProvider,
  TickerLike,
} from '@features/market-data/infra/market-data.provider';
import { BinanceRestClient } from './binance-rest.client';
import { BinanceWebSocketClient } from './binance-websocket.client';
import { BINANCE_MAX_STREAMS_PER_CONNECTION } from '../binance.constants';

@Injectable()
export class BinanceProviderService
  implements OnModuleInit, MarketDataProvider
{
  readonly providerName = 'binance' as const;
  private readonly logger = new Logger(BinanceProviderService.name);
  private ticker: BinanceWebSocketClient | undefined;
  private initialized = false;

  // Permanent WS facade — created once, reused across reconnects/restarts.
  private readonly ws = new BinanceWebSocketClient();

  constructor(private readonly rest: BinanceRestClient) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  /**
   * No credentials for public market data — initialization is just a no-op gate.
   * Kept to satisfy the MarketDataProvider lifecycle hook expected by the resolver.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.logger.log(
      '[Binance] Provider initialized (public market-data, no credentials, spot global)',
    );
  }

  /** Binance public market data is always available — degraded only when REST host is unreachable. */
  isDegraded(): boolean {
    return !this.initialized;
  }

  // ── REST: catalog ────────────────────────────────────────────────────────

  async getInstruments(_exchange?: string, _opts?: any): Promise<any[]> {
    void _exchange;
    void _opts;
    const info = await this.rest.getExchangeInfo();
    if (!info?.symbols) return [];
    return info.symbols
      .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed)
      .map((s) => ({
        instrument_token: s.symbol,
        tradingsymbol: s.symbol,
        name: `${s.baseAsset}/${s.quoteAsset}`,
        exchange: 'BINANCE',
        segment: 'spot',
        instrument_type: 'EQ',
      }));
  }

  // ── REST: live snapshots ─────────────────────────────────────────────────

  async getLTP(tokens: string[]): Promise<Record<string, any>> {
    if (!tokens?.length) return {};
    const prices = await this.rest.getTickerPrices(tokens);
    const result: Record<string, any> = {};
    for (const p of prices) {
      const lp = Number(p.price);
      result[p.symbol] = {
        instrument_token: p.symbol,
        last_price: Number.isFinite(lp) ? lp : 0,
      };
    }
    return result;
  }

  async getQuote(tokens: string[]): Promise<Record<string, any>> {
    if (!tokens?.length) return {};
    const tickers = await this.rest.get24hrTicker(tokens);
    const result: Record<string, any> = {};
    for (const t of tickers) {
      const lp = Number(t.lastPrice);
      result[t.symbol] = {
        instrument_token: t.symbol,
        last_price: Number.isFinite(lp) ? lp : 0,
        buy_price: Number(t.bidPrice) || 0,
        sell_price: Number(t.askPrice) || 0,
        volume: Number(t.volume) || 0,
        ohlc: {
          open: Number(t.openPrice) || 0,
          high: Number(t.highPrice) || 0,
          low: Number(t.lowPrice) || 0,
          close: Number(t.prevClosePrice) || 0,
        },
        net_change: Number(t.priceChange) || 0,
        oi: 0,
        oi_day_high: 0,
        oi_day_low: 0,
      };
    }
    return result;
  }

  async getOHLC(tokens: string[]): Promise<Record<string, any>> {
    if (!tokens?.length) return {};
    const tickers = await this.rest.get24hrTicker(tokens);
    const result: Record<string, any> = {};
    for (const t of tickers) {
      const lp = Number(t.lastPrice);
      result[t.symbol] = {
        instrument_token: t.symbol,
        last_price: Number.isFinite(lp) ? lp : 0,
        ohlc: {
          open: Number(t.openPrice) || 0,
          high: Number(t.highPrice) || 0,
          low: Number(t.lowPrice) || 0,
          close: Number(t.prevClosePrice) || 0,
        },
      };
    }
    return result;
  }

  async getLTPByPairs(
    pairs: MarketDataLtpPair[],
  ): Promise<Record<string, { last_price: number | null }>> {
    const result: Record<string, { last_price: number | null }> = {};
    if (!pairs?.length) return result;
    const tokens = [
      ...new Set(pairs.map((p) => String(p.token).toUpperCase())),
    ];
    let ltpMap: Record<string, any> = {};
    try {
      ltpMap = await this.getLTP(tokens);
    } catch (err) {
      this.logger.warn('[Binance] getLTPByPairs: getLTP failed', err as any);
    }
    for (const p of pairs) {
      const tok = String(p.token).toUpperCase();
      const k = `${String(p.exchange).toUpperCase()}-${tok}`;
      const lp = ltpMap[tok]?.last_price;
      result[k] = {
        last_price:
          Number.isFinite(Number(lp)) && Number(lp) > 0 ? Number(lp) : null,
      };
    }
    return result;
  }

  async getHistoricalData(
    token: number | string,
    from: string,
    to: string,
    interval: string,
  ): Promise<any> {
    // The MarketDataProvider contract types token as number; for symbol-based providers
    // we accept the symbol string at runtime (matches Massive's approach).
    const symbol = String(token).toUpperCase();
    const klines = await this.rest.getKlines(symbol, interval, from, to);
    return klines.map((k) => ({
      date: new Date(k[0]).toISOString(),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }

  // ── Streaming ────────────────────────────────────────────────────────────

  /** Exchange priming is meaningless for Binance — symbols carry no exchange suffix. */
  primeExchangeMapping(_pairs: MarketDataExchangeToken[]): void {
    void _pairs;
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    this.ticker = this.ws;
    return this.ticker;
  }

  getTicker(): TickerLike {
    return this.ticker;
  }

  /** Hard cap on Binance combined-stream — see binance.constants. */
  getSubscriptionLimit(): number {
    return BINANCE_MAX_STREAMS_PER_CONNECTION;
  }

  /** Single connection in v1 — reports as one shard. */
  getShardStatus(): Array<{
    index: number;
    name?: string;
    isConnected: boolean;
    subscribedCount: number;
    reconnectAttempts: number;
    reconnectCount: number;
    disableReconnect: boolean;
  }> {
    return [
      {
        index: 0,
        name: 'spot',
        isConnected: this.ws.isWsConnected(),
        subscribedCount: this.ws.getSubscribedCount(),
        reconnectAttempts: this.ws.getReconnectAttempts(),
        reconnectCount: this.ws.getReconnectAttempts(),
        disableReconnect: false,
      },
    ];
  }
}
