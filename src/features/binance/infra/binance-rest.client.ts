/**
 * @file binance-rest.client.ts
 * @module binance
 * @description Axios client for the public (unauthenticated) Binance Spot REST API.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 *
 * Public market-data endpoints — no API key, no signing. The class is always "ready"
 * (unlike Massive's REST client which gates on an API key); kept as `isReady()` for
 * symmetry with the MarketDataProvider lifecycle.
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { BINANCE_REST_BASE } from '../binance.constants';
import {
  BinanceExchangeInfoResponse,
  BinanceKline,
  BinanceTicker24hr,
  BinanceTickerPrice,
} from '../dto/binance-exchange-info.dto';

/** Map streaming-layer interval tags to Binance kline intervals. */
const INTERVAL_MAP: Record<string, string> = {
  '1minute': '1m',
  '3minute': '3m',
  '5minute': '5m',
  '15minute': '15m',
  '30minute': '30m',
  '1hour': '1h',
  '2hour': '2h',
  '4hour': '4h',
  '6hour': '6h',
  '8hour': '8h',
  '12hour': '12h',
  day: '1d',
  '1day': '1d',
  '3day': '3d',
  week: '1w',
  '1week': '1w',
  month: '1M',
  '1month': '1M',
};

@Injectable()
export class BinanceRestClient {
  private readonly logger = new Logger(BinanceRestClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BINANCE_REST_BASE,
      timeout: 10_000,
    });
  }

  /** Public endpoints have no credentials; always ready. */
  isReady(): boolean {
    return true;
  }

  /**
   * GET /api/v3/exchangeInfo — full Spot symbol catalog, ~2000 entries.
   * No filtering on the wire (the param list is large but optional).
   */
  async getExchangeInfo(): Promise<BinanceExchangeInfoResponse | null> {
    try {
      const { data } = await this.http.get<BinanceExchangeInfoResponse>(
        '/api/v3/exchangeInfo',
      );
      return data;
    } catch (err) {
      this.logger.error('[Binance REST] getExchangeInfo failed', err as any);
      return null;
    }
  }

  /**
   * GET /api/v3/ticker/price — last price for one or many symbols.
   * Without `symbols` it returns every spot pair (~2000 rows).
   */
  async getTickerPrices(
    symbols?: string[],
  ): Promise<BinanceTickerPrice[]> {
    try {
      const params: Record<string, string> = {};
      if (symbols?.length) {
        // Binance expects a JSON array literal as a single query-string param.
        params.symbols = JSON.stringify(symbols.map((s) => s.toUpperCase()));
      }
      const { data } = await this.http.get<BinanceTickerPrice | BinanceTickerPrice[]>(
        '/api/v3/ticker/price',
        { params },
      );
      return Array.isArray(data) ? data : [data];
    } catch (err) {
      this.logger.error(
        `[Binance REST] getTickerPrices(${symbols?.slice(0, 5).join(',') ?? '*'}) failed`,
        err as any,
      );
      return [];
    }
  }

  /**
   * GET /api/v3/ticker/24hr — 24-hour rolling stats including OHLC.
   */
  async get24hrTicker(symbols?: string[]): Promise<BinanceTicker24hr[]> {
    try {
      const params: Record<string, string> = {};
      if (symbols?.length) {
        params.symbols = JSON.stringify(symbols.map((s) => s.toUpperCase()));
      }
      const { data } = await this.http.get<BinanceTicker24hr | BinanceTicker24hr[]>(
        '/api/v3/ticker/24hr',
        { params },
      );
      return Array.isArray(data) ? data : [data];
    } catch (err) {
      this.logger.error(
        `[Binance REST] get24hrTicker(${symbols?.slice(0, 5).join(',') ?? '*'}) failed`,
        err as any,
      );
      return [];
    }
  }

  /**
   * GET /api/v3/klines — historical OHLCV bars. `startTime`/`endTime` accept ms epoch
   * or YYYY-MM-DD ISO date strings (we coerce). Limit defaults to 500 (max 1000).
   */
  async getKlines(
    symbol: string,
    interval: string,
    from: string | number,
    to: string | number,
    limit = 500,
  ): Promise<BinanceKline[]> {
    const binanceInterval = INTERVAL_MAP[interval] ?? interval;
    const startMs = this.toMs(from);
    const endMs = this.toMs(to);
    try {
      const { data } = await this.http.get<BinanceKline[]>('/api/v3/klines', {
        params: {
          symbol: symbol.toUpperCase(),
          interval: binanceInterval,
          startTime: startMs,
          endTime: endMs,
          limit: Math.min(1000, Math.max(1, limit)),
        },
      });
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.error(
        `[Binance REST] getKlines(${symbol}, ${binanceInterval}) failed`,
        err as any,
      );
      return [];
    }
  }

  /** Coerce date strings (`YYYY-MM-DD`) or numbers/ms to epoch milliseconds. */
  private toMs(v: string | number): number {
    if (typeof v === 'number') return v;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
}
