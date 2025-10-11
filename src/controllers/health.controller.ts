import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StockService } from '../modules/stock/stock.service';
import { KiteConnectService } from '../services/kite-connect.service';
import { RedisService } from '../services/redis.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { MetricsService } from '../services/metrics.service';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(
    private stockService: StockService,
    private kiteConnectService: KiteConnectService,
    private redisService: RedisService,
    private marketDataStreamService: MarketDataStreamService,
    private metricsService: MetricsService,
  ) {}

  @Get()
  async getHealth() {
    try {
      const [systemStats, streamingStatus] = await Promise.all([
        this.stockService.getSystemStats(),
        this.marketDataStreamService.getStreamingStatus(),
      ]);

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          redis: 'connected',
          kiteConnect: this.kiteConnectService.isKiteConnected() ? 'connected' : 'disconnected',
          streaming: streamingStatus.isStreaming ? 'active' : 'inactive',
        },
        stats: systemStats,
        streaming: streamingStatus,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message,
      };
    }
  }

  @Get('detailed')
  async getDetailedHealth() {
    try {
      const [systemStats, streamingStatus] = await Promise.all([
        this.stockService.getSystemStats(),
        this.marketDataStreamService.getStreamingStatus(),
      ]);

      // Test Redis connection
      let redisStatus = 'disconnected';
      try {
        await this.redisService.set('health_check', 'ok', 10);
        const testValue = await this.redisService.get('health_check');
        redisStatus = testValue === 'ok' ? 'connected' : 'error';
        await this.redisService.del('health_check');
      } catch (error) {
        redisStatus = 'error';
      }

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        services: {
          database: 'connected',
          redis: redisStatus,
          kiteConnect: this.kiteConnectService.isKiteConnected() ? 'connected' : 'disconnected',
          streaming: streamingStatus.isStreaming ? 'active' : 'inactive',
        },
        stats: systemStats,
        streaming: streamingStatus,
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      };
    }
  }

  @Get('metrics')
  async getMetrics() {
    const registry = this.metricsService.getRegistry();
    return registry.metrics();
  }
}
