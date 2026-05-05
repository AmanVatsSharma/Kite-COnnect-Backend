/**
 * @file massive-rest.client.ts
 * @module massive
 * @description Axios-based REST client for the Massive (formerly Polygon.io) API.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { MassiveAggsResponse, MassiveAggResult } from '../dto/massive-aggs.dto';
import {
  MassiveSnapshotResponse,
  MassiveTicker,
  MassiveReferenceTickersResponse,
} from '../dto/massive-snapshot.dto';
import { MASSIVE_REST_BASE, MASSIVE_INTERVALS } from '../massive.constants';

@Injectable()
export class MassiveRestClient {
  private readonly logger = new Logger(MassiveRestClient.name);
  private http: AxiosInstance | null = null;
  private apiKey: string | null = null;

  init(apiKey: string): void {
    this.apiKey = apiKey;
    this.http = axios.create({
      baseURL: MASSIVE_REST_BASE,
      timeout: 10_000,
    });
    this.logger.log('[Massive REST] Client initialized');
  }

  isReady(): boolean {
    return !!this.http && !!this.apiKey;
  }

  /**
   * Snapshot for a single ticker (stocks, locale=us by default).
   */
  async getSnapshot(
    ticker: string,
    locale = 'us',
    market = 'stocks',
  ): Promise<MassiveTicker | null> {
    if (!this.http) {
      this.logger.warn('[Massive REST] getSnapshot: client not initialized');
      return null;
    }
    try {
      const { data } = await this.http.get<MassiveSnapshotResponse>(
        `/v2/snapshot/locale/${locale}/markets/${market}/tickers/${encodeURIComponent(ticker)}`,
        { params: { apiKey: this.apiKey } },
      );
      return data?.ticker ?? null;
    } catch (err) {
      this.logger.error(
        `[Massive REST] getSnapshot(${ticker}) failed`,
        err as any,
      );
      return null;
    }
  }

  /**
   * Snapshots for multiple tickers in one request.
   */
  async getSnapshots(
    tickers: string[],
    locale = 'us',
    market = 'stocks',
  ): Promise<Record<string, MassiveTicker>> {
    const result: Record<string, MassiveTicker> = {};
    if (!this.http || !tickers.length) return result;
    try {
      const { data } = await this.http.get<MassiveSnapshotResponse>(
        `/v2/snapshot/locale/${locale}/markets/${market}/tickers`,
        { params: { apiKey: this.apiKey, tickers: tickers.join(',') } },
      );
      for (const t of data?.tickers ?? []) {
        result[t.ticker] = t;
      }
    } catch (err) {
      this.logger.error(
        `[Massive REST] getSnapshots(${tickers.slice(0, 5).join(',')}) failed`,
        err as any,
      );
    }
    return result;
  }

  /**
   * OHLCV aggregate bars for a ticker.
   * interval maps to known Massive timespan/multiplier pairs (e.g. "day", "minute", "5minute").
   */
  async getAggregates(
    ticker: string,
    from: string,
    to: string,
    interval = 'day',
    adjusted = true,
  ): Promise<MassiveAggResult[]> {
    if (!this.http) {
      this.logger.warn('[Massive REST] getAggregates: client not initialized');
      return [];
    }
    const span = MASSIVE_INTERVALS[interval] ?? MASSIVE_INTERVALS['day'];
    try {
      const { data } = await this.http.get<MassiveAggsResponse>(
        `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${span.multiplier}/${span.timespan}/${from}/${to}`,
        {
          params: { apiKey: this.apiKey, adjusted, sort: 'asc', limit: 50000 },
        },
      );
      return data?.results ?? [];
    } catch (err) {
      this.logger.error(
        `[Massive REST] getAggregates(${ticker}) failed`,
        err as any,
      );
      return [];
    }
  }

  /**
   * Reference ticker search — maps to getInstruments().
   */
  async getReferenceTickers(
    search?: string,
    market = 'stocks',
    limit = 1000,
    cursor?: string,
  ): Promise<MassiveReferenceTickersResponse | null> {
    if (!this.http) return null;
    try {
      // Massive API uses 'fx' for forex (not 'forex')
      const apiMarket = market === 'forex' ? 'fx' : market;
      const params: Record<string, any> = {
        apiKey: this.apiKey,
        market: apiMarket,
        active: true,
        limit,
      };
      if (search) params.search = search;
      if (cursor) params.cursor = cursor;
      const { data } = await this.http.get<MassiveReferenceTickersResponse>(
        '/v3/reference/tickers',
        { params },
      );
      return data;
    } catch (err) {
      this.logger.error(
        '[Massive REST] getReferenceTickers failed',
        err as any,
      );
      return null;
    }
  }

  /**
   * Market status — useful for degraded-mode checks.
   */
  async getMarketStatus(): Promise<any | null> {
    if (!this.http) return null;
    try {
      const { data } = await this.http.get('/v1/marketstatus/now', {
        params: { apiKey: this.apiKey },
      });
      return data;
    } catch (err) {
      this.logger.error('[Massive REST] getMarketStatus failed', err as any);
      return null;
    }
  }
}
