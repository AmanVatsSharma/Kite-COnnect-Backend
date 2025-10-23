import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../services/redis.service';
import { MarketDataProvider, TickerLike } from './market-data.provider';
import { KiteConnect } from 'kiteconnect';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KiteTicker } = require('kiteconnect');

@Injectable()
export class KiteProviderService implements OnModuleInit, MarketDataProvider {
  private readonly logger = new Logger(KiteProviderService.name);
  private kite: KiteConnect;
  private ticker: TickerLike;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private disableReconnect = false;
  private currentApiKey: string | null = null;
  private currentAccessToken: string | null = null;
  private lastTickerError: { message: string; code?: any; status?: any; time: string } | null = null;

  constructor(private configService: ConfigService, private redisService: RedisService) {}

  async onModuleInit() {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    try {
      const apiKey = this.configService.get('KITE_API_KEY');
      // Prefer dynamic token from Redis, then env var set by OAuth
      let accessToken = this.configService.get('KITE_ACCESS_TOKEN');
      if (!accessToken && this.redisService?.isRedisAvailable?.()) {
        try {
          accessToken = await this.redisService.get<string>('kite:access_token') || undefined;
          if (accessToken) this.logger.log('[Kite] Loaded access token from Redis cache');
        } catch {}
      }

      if (!apiKey || !accessToken) {
        this.logger.warn('[Kite] Credentials not found. Provider will operate in degraded mode.');
        this.logger.warn('[Kite] Visit /api/auth/kite/login to authenticate and enable ticker.');
        return;
      }

      this.currentApiKey = apiKey;
      this.currentAccessToken = accessToken;
      this.kite = new KiteConnect({ api_key: apiKey, access_token: accessToken });
      this.logger.log('[Kite] Client initialized successfully');
    } catch (error) {
      this.logger.error('[Kite] Failed to initialize client', error as any);
    }
  }

  async updateAccessToken(accessToken: string): Promise<void> {
    try {
      this.currentAccessToken = accessToken;
      if (!this.kite) {
        const apiKey = this.currentApiKey || this.configService.get('KITE_API_KEY');
        if (!apiKey) throw new Error('Kite API key not configured');
        this.currentApiKey = apiKey;
        this.kite = new KiteConnect({ api_key: apiKey, access_token: accessToken });
      } else if (typeof (this.kite as any).setAccessToken === 'function') {
        (this.kite as any).setAccessToken(accessToken);
      } else {
        const apiKey = this.currentApiKey || this.configService.get('KITE_API_KEY');
        this.currentApiKey = apiKey;
        this.kite = new KiteConnect({ api_key: apiKey, access_token: accessToken });
      }
      this.logger.log('[Kite] Access token updated');
    } catch (error) {
      this.logger.error('[Kite] Failed to update access token', error as any);
      throw error;
    }
  }

  async getInstruments(exchange?: string): Promise<any[]> {
    try {
      if (!this.kite) {
        throw new Error('Kite provider not initialized');
      }
      const instruments = await this.kite.getInstruments(exchange);
      this.logger.log(`[Kite] Fetched ${Object.keys(instruments).length} instruments`);
      return Object.values(instruments);
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch instruments', error as any);
      throw error;
    }
  }

  async getQuote(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite provider not initialized');
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
  ): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite provider not initialized');
      }
      const historicalData = await this.kite.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
      );
      return historicalData;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch historical data', error as any);
      throw error;
    }
  }

  async getLTP(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite provider not initialized');
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
        throw new Error('Kite provider not initialized');
      }
      const ohlc = await this.kite.getOHLC(instrumentTokens);
      return ohlc;
    } catch (error) {
      this.logger.error('[Kite] Failed to fetch OHLC', error as any);
      throw error;
    }
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    const apiKey = this.currentApiKey || this.configService.get('KITE_API_KEY');
    const accessToken = this.currentAccessToken || this.configService.get('KITE_ACCESS_TOKEN');
    if (!apiKey || !accessToken) {
      this.logger.warn('[Kite] Credentials missing; ticker not initialized');
      return undefined as any;
    }

    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    ticker.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.disableReconnect = false;
      this.logger.log('[Kite] Ticker connected');
    });
    ticker.on('ticks', (ticks: any[]) => {
      this.logger.debug?.(`[Kite] Received ${ticks?.length || 0} ticks`);
    });
    ticker.on('disconnect', (...args: any[]) => {
      this.isConnected = false;
      this.logger.warn('[Kite] Ticker disconnected ' + this.stringifyArgs(args));
      if (this.disableReconnect) {
        this.logger.warn('[Kite] Reconnect disabled due to previous auth errors');
        return;
      }
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.logger.warn(`[Kite] Max reconnect attempts (${this.maxReconnectAttempts}) reached; stopping`);
        return;
      }
      this.reconnectAttempts++;
      const delayMs = 1000 + Math.floor(Math.random() * 2000) + this.reconnectAttempts * 500;
      setTimeout(() => {
        try {
          ticker.connect();
        } catch (e) {
          this.logger.error('[Kite] Ticker reconnect failed', e as any);
        }
      }, delayMs);
    });

    // Optional events if exposed by SDK; safe to attach even if never emitted
    ticker.on('reconnect', (...args: any[]) => {
      this.logger.warn('[Kite] Ticker reconnect event ' + this.stringifyArgs(args));
    });
    ticker.on('noreconnect', (...args: any[]) => {
      this.logger.warn('[Kite] Ticker noreconnect event ' + this.stringifyArgs(args));
    });
    ticker.on('close', (...args: any[]) => {
      this.logger.warn('[Kite] Ticker close event ' + this.stringifyArgs(args));
    });
    ticker.on('error', (error: any) => {
      const pretty = this.formatError(error);
      this.lastTickerError = { message: pretty, code: (error && (error.code || error?.data?.code)) || undefined, status: (error && (error.status || error?.data?.status)) || undefined, time: new Date().toISOString() };
      this.logger.error('[Kite] Ticker error: ' + pretty);
      if (this.isAuthError(error)) {
        this.disableReconnect = true;
        this.logger.warn('[Kite] Disabling reconnect due to authentication error. Visit /api/auth/kite/login to re-authenticate.');
        try { ticker.disconnect?.(); } catch {}
      }
    });

    this.ticker = ticker;
    return this.ticker;
  }

  async restartTicker(): Promise<void> {
    try {
      if (this.ticker) {
        try {
          this.ticker.disconnect?.();
        } catch {}
      }
      this.ticker = undefined as any;
      const ticker = this.initializeTicker();
      try {
        ticker?.connect?.();
      } catch (e) {
        this.logger.error('[Kite] Failed to connect ticker after restart', e as any);
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

  private isAuthError(error: any): boolean {
    const msg = (error?.message || error?.toString?.() || '').toString().toLowerCase();
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

  private formatError(error: any): string {
    try {
      if (!error) return 'unknown';
      if (typeof error === 'string') return error;
      const msg = error.message || error.reason || error.error || error.toString?.();
      const details: any = {};
      ['code','status','type'].forEach(k => { if (error[k] !== undefined) details[k] = error[k]; });
      if (error.data && typeof error.data === 'object') {
        const d: any = {};
        ['error_type','message','status','code'].forEach(k => { if (error.data[k] !== undefined) d[k] = error.data[k]; });
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
      const safe = args.map(a => {
        if (a === undefined || a === null) return a;
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a;
        return JSON.stringify(a);
      });
      return safe.join(' ');
    } catch {
      return '';
    }
  }

  // Exposed for debugging via controller
  getDebugStatus() {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      disableReconnect: this.disableReconnect,
      hasApiKey: !!this.currentApiKey,
      hasAccessToken: !!this.currentAccessToken,
      maskedApiKey: this.mask(this.currentApiKey),
      maskedAccessToken: this.mask(this.currentAccessToken),
      lastTickerError: this.lastTickerError,
    };
  }

  private mask(v: string | null): string | null {
    if (!v) return null;
    const s = String(v);
    if (s.length <= 6) return '****';
    return `${s.slice(0,2)}****${s.slice(-4)}`;
  }
}


