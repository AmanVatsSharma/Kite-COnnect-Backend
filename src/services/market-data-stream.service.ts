import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KiteConnectService } from './kite-connect.service';
import { StockService } from '../modules/stock/stock.service';
import { RedisService } from './redis.service';

@Injectable()
export class MarketDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataStreamService.name);
  private isStreaming = false;
  private subscribedInstruments: Set<number> = new Set();
  private streamInterval: NodeJS.Timeout | null = null;

  constructor(
    private kiteConnectService: KiteConnectService,
    private stockService: StockService,
    private redisService: RedisService,
  ) {}

  async onModuleInit() {
    await this.initializeStreaming();
  }

  async onModuleDestroy() {
    await this.stopStreaming();
  }

  private async initializeStreaming() {
    try {
      // Initialize Kite ticker
      const ticker = this.kiteConnectService.initializeTicker();
      
      // Set up ticker event handlers
      ticker.on('ticks', (ticks: any[]) => {
        this.handleTicks(ticks);
      });

      ticker.on('connect', () => {
        this.logger.log('Kite ticker connected');
        this.isStreaming = true;
      });

      ticker.on('disconnect', () => {
        this.logger.log('Kite ticker disconnected');
        this.isStreaming = false;
      });

      ticker.on('error', (error: any) => {
        this.logger.error('Kite ticker error', error);
        this.isStreaming = false;
      });

      // Connect to ticker with safe guard
      try {
        ticker.connect();
      } catch (e) {
        this.logger.error('Error connecting Kite ticker', e);
      }

      this.logger.log('Market data streaming service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize market data streaming', error);
    }
  }

  private async handleTicks(ticks: any[]) {
    try {
      for (const tick of ticks) {
        const instrumentToken = tick.instrument_token;
        
        // Store market data in database
        await this.stockService.storeMarketData(instrumentToken, tick);
        
        // Update subscribed instruments set
        this.subscribedInstruments.add(instrumentToken);
      }
    } catch (error) {
      this.logger.error('Error handling ticks', error);
    }
  }

  async subscribeToInstruments(instrumentTokens: number[]) {
    try {
      const ticker = this.kiteConnectService.getTicker();
      if (ticker && this.isStreaming) {
        ticker.subscribe(instrumentTokens);
        
        // Add to subscribed instruments
        instrumentTokens.forEach(token => this.subscribedInstruments.add(token));
        
        this.logger.log(`Subscribed to ${instrumentTokens.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error subscribing to instruments', error);
      throw error;
    }
  }

  async unsubscribeFromInstruments(instrumentTokens: number[]) {
    try {
      const ticker = this.kiteConnectService.getTicker();
      if (ticker && this.isStreaming) {
        ticker.unsubscribe(instrumentTokens);
        
        // Remove from subscribed instruments
        instrumentTokens.forEach(token => this.subscribedInstruments.delete(token));
        
        this.logger.log(`Unsubscribed from ${instrumentTokens.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error unsubscribing from instruments', error);
      throw error;
    }
  }

  async setMode(mode: string, instrumentTokens: number[]) {
    try {
      const ticker = this.kiteConnectService.getTicker();
      if (ticker && this.isStreaming) {
        ticker.setMode(mode, instrumentTokens);
        this.logger.log(`Set mode ${mode} for ${instrumentTokens.length} instruments`);
      }
    } catch (error) {
      this.logger.error('Error setting ticker mode', error);
      throw error;
    }
  }

  // Cron job to sync instruments daily
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async syncInstrumentsDaily() {
    try {
      this.logger.log('Starting daily instrument sync');
      const result = await this.stockService.syncInstruments();
      this.logger.log(`Daily sync completed: ${result.synced} synced, ${result.updated} updated`);
    } catch (error) {
      this.logger.error('Error in daily instrument sync', error);
    }
  }

  // Cron job to clean old market data
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanOldMarketData() {
    try {
      this.logger.log('Starting cleanup of old market data');
      // Implement cleanup logic here
      // For example, delete market data older than 30 days
      this.logger.log('Old market data cleanup completed');
    } catch (error) {
      this.logger.error('Error cleaning old market data', error);
    }
  }

  // Health check method
  async getStreamingStatus() {
    return {
      isStreaming: this.isStreaming,
      subscribedInstruments: Array.from(this.subscribedInstruments),
      subscribedCount: this.subscribedInstruments.size,
      kiteConnected: this.kiteConnectService.isKiteConnected(),
    };
  }

  private async stopStreaming() {
    try {
      if (this.streamInterval) {
        clearInterval(this.streamInterval);
        this.streamInterval = null;
      }

      const ticker = this.kiteConnectService.getTicker();
      if (ticker) {
        ticker.disconnect();
      }

      this.isStreaming = false;
      this.logger.log('Market data streaming stopped');
    } catch (error) {
      this.logger.error('Error stopping streaming', error);
    }
  }

  // Method to restart streaming
  async restartStreaming() {
    try {
      await this.stopStreaming();
      await this.initializeStreaming();
      this.logger.log('Market data streaming restarted');
    } catch (error) {
      this.logger.error('Error restarting streaming', error);
      throw error;
    }
  }
}
