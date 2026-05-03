/**
 * @file health.controller.ts
 * @module health
 * @description Health endpoints; streaming summary uses client-visible provider labels (Falcon|Vayu).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-19
 */
import { Controller, Get, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StockService } from '@features/stock/application/stock.service';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { RedisService } from '@infra/redis/redis.service';
import { RedisHealthIndicator } from '@infra/redis/redis-health.indicator';
import { MarketDataStreamService } from '@features/market-data/application/market-data-stream.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { internalToClientProviderName } from '@shared/utils/provider-label.util';

@Controller('health')
@ApiTags('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private stockService: StockService,
    private resolver: MarketDataProviderResolverService,
    private kiteProvider: KiteProviderService,
    private redisService: RedisService,
    private redisHealth: RedisHealthIndicator,
    private marketDataStreamService: MarketDataStreamService,
    private metricsService: MetricsService,
    private vortexProvider: VortexProviderService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Basic health' })
  async getHealth() {
    try {
      const [systemStats, streamingStatus, vortexPing, redisCheck] = await Promise.all([
        this.stockService.getSystemStats(),
        this.marketDataStreamService.getStreamingStatus(),
        this.vortexProvider.ping?.(),
        this.redisHealth.check(),
      ]);

      const resolved =
        await this.resolver.getResolvedInternalProviderNameForWebsocket();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          redis: redisCheck.healthy ? 'connected' : redisCheck.status,
          provider: internalToClientProviderName(resolved),
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
      const [streamingStatus, vortexPing, mdSnapshot] = await Promise.all([
        this.marketDataStreamService.getStreamingStatus(),
        this.vortexProvider.ping?.(),
        this.marketDataStreamService.getMarketDataHealthSnapshot(),
      ]);

      const internal = await this.resolver.getResolvedInternalProviderNameForWebsocket();
      const healthData = {
        provider: internalToClientProviderName(internal),
        streaming: streamingStatus,
        marketData: mdSnapshot,
        vortex: vortexPing,
        timestamp: new Date().toISOString(),
      };

      this.logger.debug(
        `[Health] Market data health provider=${healthData.provider} streaming=${streamingStatus.isStreaming} vortexHttp=${vortexPing?.httpOk} wsTickerReady=${mdSnapshot.wsTickerReady}`,
      );

      return healthData;
    } catch (error) {
      this.logger.warn(
        `[Health] Market data health check failed: ${(error as any)?.message || error}`,
      );
      return { error: (error as Error).message };
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

      const redisCheck = await this.redisHealth.check();
      const redisStatus = redisCheck.healthy
        ? 'connected'
        : `${redisCheck.status}(${redisCheck.latencyMs}ms)`;

      const resolvedDetailed =
        await this.resolver.getResolvedInternalProviderNameForWebsocket();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        services: {
          database: 'connected',
          redis: redisStatus,
          provider: internalToClientProviderName(resolvedDetailed),
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
  async getMetrics(@Res() res: any) {
    const reg = this.metricsService.getMetricsRegister();
    const metrics = await reg.metrics();
    res.setHeader('Content-Type', reg.contentType);
    return res.send(metrics);
  }
}
