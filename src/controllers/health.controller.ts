import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StockService } from '../modules/stock/stock.service';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';
import { KiteProviderService } from '../providers/kite-provider.service';
import { RedisService } from '../services/redis.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { MetricsService } from '../services/metrics.service';
import { VortexProviderService } from '../providers/vortex-provider.service';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(
    private stockService: StockService,
    private resolver: MarketDataProviderResolverService,
    private kiteProvider: KiteProviderService,
    private redisService: RedisService,
    private marketDataStreamService: MarketDataStreamService,
    private metricsService: MetricsService,
    private vortexProvider: VortexProviderService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Basic health' })
  async getHealth() {
    try {
      const [systemStats, streamingStatus, vortexPing] = await Promise.all([
        this.stockService.getSystemStats(),
        this.marketDataStreamService.getStreamingStatus(),
        this.vortexProvider.ping?.(),
      ]);

      const globalProvider = await this.resolver.getGlobalProviderName();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          redis: 'connected',
          provider: globalProvider || 'env',
          streaming: streamingStatus.isStreaming ? 'active' : 'inactive',
          vortexHttp: vortexPing?.httpOk ? 'reachable' : 'unreachable',
        },
        stats: systemStats,
        streaming: streamingStatus,
        debug: {
          kite: this.kiteProvider.getDebugStatus?.(),
          vortex: this.vortexProvider.getDebugStatus?.(),
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message,
      };
    }
  }

  @Get('market-data')
  @ApiOperation({ summary: 'Market data provider and streaming health' })
  async getMarketDataHealth() {
    try {
      const [streamingStatus, vortexPing] = await Promise.all([
        this.marketDataStreamService.getStreamingStatus(),
        this.vortexProvider.ping?.(),
      ]);

      const healthData = {
        provider: (await this.resolver.getGlobalProviderName()) || 'env',
        streaming: streamingStatus,
        vortex: vortexPing,
        timestamp: new Date().toISOString(),
      };

      // Log health check for monitoring
      console.log(
        `[Health] Market data health check: provider=${healthData.provider}, streaming=${streamingStatus.isStreaming}, vortex=${vortexPing?.httpOk}`,
      );

      return healthData;
    } catch (error) {
      console.error('[Health] Market data health check failed:', error);
      return { error: error.message };
    }
  }

  @Get('detailed')
  @ApiOperation({ summary: 'Detailed health' })
  async getDetailedHealth() {
    try {
      const [systemStats, streamingStatus, vortexPing] = await Promise.all([
        this.stockService.getSystemStats(),
        this.marketDataStreamService.getStreamingStatus(),
        this.vortexProvider.ping?.(),
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

      const globalProvider = await this.resolver.getGlobalProviderName();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        services: {
          database: 'connected',
          redis: redisStatus,
          provider: globalProvider || 'env',
          streaming: streamingStatus.isStreaming ? 'active' : 'inactive',
          vortexHttp: vortexPing?.httpOk ? 'reachable' : 'unreachable',
        },
        stats: systemStats,
        streaming: streamingStatus,
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        debug: {
          kite: this.kiteProvider.getDebugStatus?.(),
          vortex: this.vortexProvider.getDebugStatus?.(),
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
  @ApiOperation({ summary: 'Prometheus metrics' })
  async getMetrics() {
    const reg = this.metricsService.getMetricsRegister();
    return reg.metrics();
  }
}
