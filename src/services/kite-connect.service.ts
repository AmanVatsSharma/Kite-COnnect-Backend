import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KiteConnect } from 'kiteconnect';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KiteTicker } = require('kiteconnect');

export type KiteTickerType = any;

@Injectable()
export class KiteConnectService implements OnModuleInit {
  private readonly logger = new Logger(KiteConnectService.name);
  private kite: KiteConnect;
  private ticker: KiteTickerType;
  private isConnected = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initializeKiteConnect();
  }

  private async initializeKiteConnect() {
    try {
      const apiKey = this.configService.get('KITE_API_KEY');
      // Prefer dynamic token from Redis/env var set by OAuth
      const accessToken = this.configService.get('KITE_ACCESS_TOKEN');

      if (!apiKey || !accessToken) {
        this.logger.warn('Kite Connect credentials not found. Starting without Kite.');
        this.logger.warn('Use /api/auth/kite/login to authenticate and enable ticker.');
        return;
      }

      this.kite = new KiteConnect({
        api_key: apiKey,
        access_token: accessToken,
      });

      this.logger.log('Kite Connect initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Kite Connect', error);
    }
  }

  async updateAccessToken(accessToken: string): Promise<void> {
    try {
      if (!this.kite) {
        const apiKey = this.configService.get('KITE_API_KEY');
        if (!apiKey) throw new Error('Kite API key not configured');
        this.kite = new KiteConnect({ api_key: apiKey, access_token: accessToken });
      } else if (typeof (this.kite as any).setAccessToken === 'function') {
        (this.kite as any).setAccessToken(accessToken);
      } else {
        const apiKey = this.configService.get('KITE_API_KEY');
        this.kite = new KiteConnect({ api_key: apiKey, access_token: accessToken });
      }
      this.logger.log('Kite access token updated');
    } catch (error) {
      this.logger.error('Failed to update Kite access token', error);
      throw error;
    }
  }

  async getInstruments(exchange?: string): Promise<any[]> {
    try {
      if (!this.kite) {
        throw new Error('Kite Connect not initialized');
      }

      const instruments = await this.kite.getInstruments(exchange);
      this.logger.log(`Fetched ${Object.keys(instruments).length} instruments`);
      return Object.values(instruments);
    } catch (error) {
      this.logger.error('Failed to fetch instruments', error);
      throw error;
    }
  }

  async getQuote(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite Connect not initialized');
      }

      const quotes = await this.kite.getQuote(instrumentTokens);
      return quotes;
    } catch (error) {
      this.logger.error('Failed to fetch quotes', error);
      throw error;
    }
  }

  async getHistoricalData(
    instrumentToken: number,
    fromDate: string,
    toDate: string,
    interval: string,
    continuous: boolean = false,
    oi: boolean = false,
  ): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite Connect not initialized');
      }

      const historicalData = await this.kite.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
        continuous,
        oi,
      );

      return historicalData;
    } catch (error) {
      this.logger.error('Failed to fetch historical data', error);
      throw error;
    }
  }

  async getLTP(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite Connect not initialized');
      }

      const ltp = await this.kite.getLTP(instrumentTokens);
      return ltp;
    } catch (error) {
      this.logger.error('Failed to fetch LTP', error);
      throw error;
    }
  }

  async getOHLC(instrumentTokens: string[]): Promise<any> {
    try {
      if (!this.kite) {
        throw new Error('Kite Connect not initialized');
      }

      const ohlc = await this.kite.getOHLC(instrumentTokens);
      return ohlc;
    } catch (error) {
      this.logger.error('Failed to fetch OHLC', error);
      throw error;
    }
  }

  initializeTicker(): KiteTickerType {
    if (this.ticker) {
      return this.ticker;
    }

    const apiKey = this.configService.get('KITE_API_KEY');
    const accessToken = this.configService.get('KITE_ACCESS_TOKEN');

    if (!apiKey || !accessToken) {
      // Do not throw; allow app to run without ticker
      this.logger.warn('Kite credentials missing; ticker not initialized');
      return undefined as any;
    }

    const ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

    ticker.on('connect', () => {
      this.isConnected = true;
      this.logger.log('Kite ticker connected');
    });

    ticker.on('ticks', (ticks: any[]) => {
      // ticks handled in MarketDataStreamService
      this.logger.debug?.(`Received ${ticks?.length || 0} ticks`);
    });

    ticker.on('disconnect', () => {
      this.isConnected = false;
      this.logger.warn('Kite ticker disconnected');
      // basic reconnect with jitter
      const delayMs = 1000 + Math.floor(Math.random() * 2000);
      setTimeout(() => {
        try {
          ticker.connect();
        } catch (e) {
          this.logger.error('Kite ticker reconnect failed', e);
        }
      }, delayMs);
    });

    ticker.on('error', (error: any) => {
      this.logger.error('Kite ticker error', error);
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
        ticker.connect();
      } catch (e) {
        this.logger.error('Failed to connect ticker after restart', e);
      }
      this.logger.log('Kite ticker restarted');
    } catch (error) {
      this.logger.error('Error restarting ticker', error);
    }
  }

  getTicker(): KiteTickerType {
    return this.ticker;
  }

  isKiteConnected(): boolean {
    return this.isConnected;
  }
}
