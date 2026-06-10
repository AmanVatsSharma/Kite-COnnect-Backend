import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  Query,
  Param,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiQuery,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { ApiKey } from '@features/auth/domain/api-key.entity';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { ApiKeyService } from '@features/auth/application/api-key.service';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { MarketDataStreamService } from '@features/market-data/application/market-data-stream.service';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { MassiveProviderService } from '@features/massive/infra/massive-provider.service';
import { RedisService } from '@infra/redis/redis.service';
import { MarketDataGateway } from '@features/market-data/interface/market-data.gateway';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiKeyAbuseFlag } from '@features/auth/domain/api-key-abuse-flag.entity';
import { AbuseDetectionService } from '@features/auth/application/abuse-detection.service';
import { ConfigService } from '@nestjs/config';
import {
  normalizeProviderAlias,
  internalToClientProviderName,
} from '@shared/utils/provider-label.util';
import { MarketDataWsInterestService } from '@features/market-data/application/market-data-ws-interest.service';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { OriginAuditService } from '@features/admin/application/origin-audit.service';
import { BinanceProviderService } from '@features/binance/infra/binance-provider.service';

interface ProviderHealthEntry {
  name: string;
  isConnected: boolean;
  reconnectAttempts: number;
  reconnectCount: number;
  maxReconnectAttempts: number;
  isDead: boolean;
  lastConnectAt: string | null;
  lastDisconnectAt: string | null;
}

@Controller('admin')
@ApiTags('admin', 'admin-ws')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(ApiKeyAbuseFlag)
    private abuseRepo: Repository<ApiKeyAbuseFlag>,
    private apiKeyService: ApiKeyService,
    private resolver: MarketDataProviderResolverService,
    private kiteProvider: KiteProviderService,
    private stream: MarketDataStreamService,
    private vortexProvider: VortexProviderService,
    private massiveProvider: MassiveProviderService,
    private redis: RedisService,
    private gateway: MarketDataGateway,
    private abuseDetection: AbuseDetectionService,
    private configService: ConfigService,
    private wsInterest: MarketDataWsInterestService,
    private instrumentRegistry: InstrumentRegistryService,
    private originAudit: OriginAuditService,
    private binanceProvider: BinanceProviderService,
  ) {}

  @Post('apikeys')
  @ApiOperation({ summary: 'Create API key' })
  @ApiBody({
    schema: {
      properties: {
        key: { type: 'string', example: 'demo-key-1' },
        tenant_id: { type: 'string', example: 'tenant-1' },
        rate_limit_per_minute: { type: 'number', example: 600 },
        connection_limit: { type: 'number', example: 2000 },
        ws_subscribe_rps: {
          type: 'number',
          example: 10,
          description:
            'Optional per-API-key subscribe RPS limit (falls back to WS_SUBSCRIBE_RPS when omitted)',
        },
        ws_unsubscribe_rps: {
          type: 'number',
          example: 10,
          description:
            'Optional per-API-key unsubscribe RPS limit (falls back to WS_UNSUBSCRIBE_RPS when omitted)',
        },
        ws_mode_rps: {
          type: 'number',
          example: 20,
          description:
            'Optional per-API-key set_mode RPS limit (falls back to WS_MODE_RPS when omitted)',
        },
        ws_max_instruments: {
          type: 'number',
          example: 500,
          description:
            'Optional max instruments per WebSocket connection for this key (null = global default of 3000)',
        },
        allowed_exchanges: {
          type: 'array',
          items: { type: 'string' },
          example: ['NSE_EQ', 'NSE_FO'],
          description: 'List of allowed exchanges for this API key',
        },
      },
    },
  })
  async createApiKey(
    @Body()
    body: {
      key: string;
      tenant_id: string;
      name?: string;
      rate_limit_per_minute?: number;
      connection_limit?: number;
      ws_subscribe_rps?: number;
      ws_unsubscribe_rps?: number;
      ws_mode_rps?: number;
      ws_max_instruments?: number;
      allowed_exchanges?: string[];
      is_test?: boolean;
    },
  ) {
    const metadata: any = {};
    if (body.allowed_exchanges && Array.isArray(body.allowed_exchanges)) {
      metadata.exchanges = body.allowed_exchanges;
    }

    const expires_at = body.is_test
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : null;

    const entity = this.apiKeyRepo.create({
      key: body.key,
      tenant_id: body.tenant_id,
      name: body.name,
      rate_limit_per_minute: body.rate_limit_per_minute ?? 600,
      connection_limit: body.connection_limit ?? 2000,
      ws_subscribe_rps:
        typeof body.ws_subscribe_rps === 'number'
          ? body.ws_subscribe_rps
          : null,
      ws_unsubscribe_rps:
        typeof body.ws_unsubscribe_rps === 'number'
          ? body.ws_unsubscribe_rps
          : null,
      ws_mode_rps:
        typeof body.ws_mode_rps === 'number' ? body.ws_mode_rps : null,
      ws_max_instruments:
        typeof body.ws_max_instruments === 'number'
          ? body.ws_max_instruments
          : null,
      is_test: body.is_test ?? false,
      expires_at,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    });
    const saved = await this.apiKeyRepo.save(entity);
    // Console for easy later debugging of admin-created keys
    // eslint-disable-next-line no-console
    console.log('[AdminController] Created API key', {
      key: saved.key,
      tenant_id: saved.tenant_id,
      limits: {
        rate_limit_per_minute: saved.rate_limit_per_minute,
        connection_limit: saved.connection_limit,
        ws_subscribe_rps: saved.ws_subscribe_rps,
        ws_unsubscribe_rps: saved.ws_unsubscribe_rps,
        ws_mode_rps: saved.ws_mode_rps,
        ws_max_instruments: saved.ws_max_instruments,
      },
      metadata: saved.metadata,
    });
    return saved;
  }

  @Get('apikeys')
  @ApiOperation({ summary: 'List API keys' })
  async listApiKeys() {
    return this.apiKeyRepo.find({ order: { created_at: 'DESC' } });
  }

  @Post('apikeys/activate')
  @ApiOperation({ summary: 'Activate API key' })
  async activate(@Body() body: { key: string }) {
    await this.apiKeyRepo.update({ key: body.key }, { is_active: true });
    await this.redis.publish(
      'api_key_updates',
      JSON.stringify({ key: body.key }),
    );
    return { success: true };
  }

  @Post('apikeys/deactivate')
  @ApiOperation({ summary: 'Deactivate API key' })
  async deactivate(@Body() body: { key: string }) {
    await this.apiKeyRepo.update({ key: body.key }, { is_active: false });
    return { success: true };
  }

  @Post('apikeys/limits')
  @ApiOperation({
    summary: 'Update API key limits (HTTP per-minute + WebSocket limits)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        rate_limit_per_minute: { type: 'number' },
        connection_limit: { type: 'number' },
        ws_subscribe_rps: { type: 'number' },
        ws_unsubscribe_rps: { type: 'number' },
        ws_mode_rps: { type: 'number' },
        ws_max_instruments: {
          type: 'number',
          description:
            'Max instruments per WS connection (null = global default)',
        },
        live_tick_throttle_ms: {
          type: 'number',
          description:
            'Per-key WS tick delivery interval in ms (null = global setting, 0 = no throttle)',
        },
        allowed_exchanges: { type: 'array', items: { type: 'string' } },
      },
      required: ['key'],
    },
  })
  async updateApiKeyLimits(
    @Body()
    body: {
      key: string;
      rate_limit_per_minute?: number;
      connection_limit?: number;
      ws_subscribe_rps?: number | null;
      ws_unsubscribe_rps?: number | null;
      ws_mode_rps?: number | null;
      ws_max_instruments?: number | null;
      live_tick_throttle_ms?: number | null;
      allowed_exchanges?: string[];
    },
  ) {
    const patch: Partial<ApiKey> = {};
    if (body.rate_limit_per_minute !== undefined) {
      patch.rate_limit_per_minute = body.rate_limit_per_minute;
    }
    if (body.connection_limit !== undefined) {
      patch.connection_limit = body.connection_limit;
    }
    if (body.ws_subscribe_rps !== undefined) {
      patch.ws_subscribe_rps = body.ws_subscribe_rps;
    }
    if (body.ws_unsubscribe_rps !== undefined) {
      patch.ws_unsubscribe_rps = body.ws_unsubscribe_rps;
    }
    if (body.ws_mode_rps !== undefined) {
      patch.ws_mode_rps = body.ws_mode_rps;
    }
    if (body.ws_max_instruments !== undefined) {
      patch.ws_max_instruments = body.ws_max_instruments;
    }
    if (body.live_tick_throttle_ms !== undefined) {
      patch.live_tick_throttle_ms = body.live_tick_throttle_ms;
    }

    // Handle allowed_exchanges update via metadata
    let metadataUpdated = false;
    if (body.allowed_exchanges !== undefined) {
      const currentEntity = await this.apiKeyRepo.findOne({
        where: { key: body.key },
      });
      if (!currentEntity) {
        throw new NotFoundException(`API key not found: ${body.key}`);
      }
      const currentMeta = currentEntity.metadata || {};
      const newMeta = { ...currentMeta, exchanges: body.allowed_exchanges };
      patch.metadata = newMeta;
      metadataUpdated = true;
    }

    if (Object.keys(patch).length === 0) {
      return {
        success: true,
        message: 'No limit fields provided – nothing to update',
        key: body.key,
      };
    }

    const result = await this.apiKeyRepo.update({ key: body.key }, patch);
    if (!result.affected) {
      // This might happen if key was deleted concurrently, but we checked existence above for metadata
      // If only simple limits were updated without metadata read, we might hit this.
      if (!metadataUpdated) {
        // Double check if we didn't just do a findOne
        const exists = await this.apiKeyRepo.count({
          where: { key: body.key },
        });
        if (!exists)
          throw new NotFoundException(`API key not found: ${body.key}`);
      }
    }

    const entity = await this.apiKeyRepo.findOne({
      where: { key: body.key },
    });
    const limits = entity
      ? {
          rate_limit_per_minute: entity.rate_limit_per_minute,
          connection_limit: entity.connection_limit,
          ws_subscribe_rps: entity.ws_subscribe_rps,
          ws_unsubscribe_rps: entity.ws_unsubscribe_rps,
          ws_mode_rps: entity.ws_mode_rps,
          ws_max_instruments: entity.ws_max_instruments,
          live_tick_throttle_ms: entity.live_tick_throttle_ms,
          allowed_exchanges: entity.metadata?.exchanges,
        }
      : patch;

    // eslint-disable-next-line no-console
    console.log('[AdminController] Updated API key limits', {
      key: body.key,
      limits,
    });

    // Notify gateways of update
    await this.apiKeyService.notifyApiKeyUpdate(body.key);

    return {
      success: true,
      key: body.key,
      limits,
    };
  }

  @Get('tick-throttle')
  @ApiOperation({ summary: 'Get global WS tick broadcast throttle (ms)' })
  async getTickThrottle() {
    return { ms: this.stream.getGlobalTickThrottle() };
  }

  @Post('tick-throttle')
  @ApiOperation({
    summary: 'Set global WS tick broadcast throttle (ms). 0 = off.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
    },
  })
  async setTickThrottle(@Body() body: { ms: number }) {
    const ms = Number(body.ms);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new BadRequestException('ms must be a non-negative number');
    }
    await this.stream.setGlobalTickThrottle(ms);
    return { ms: this.stream.getGlobalTickThrottle() };
  }

  @Get('apikeys/:key/limits')
  @ApiOperation({
    summary: 'Get configured limits for a single API key',
  })
  @ApiParam({ name: 'key', required: true })
  async getApiKeyLimits(@Param('key') key: string) {
    const entity = await this.apiKeyRepo.findOne({ where: { key } });
    if (!entity) {
      throw new NotFoundException(`API key not found: ${key}`);
    }

    const limits = {
      rate_limit_per_minute: entity.rate_limit_per_minute,
      connection_limit: entity.connection_limit,
      ws_subscribe_rps: entity.ws_subscribe_rps,
      ws_unsubscribe_rps: entity.ws_unsubscribe_rps,
      ws_mode_rps: entity.ws_mode_rps,
      ws_max_instruments: entity.ws_max_instruments,
      live_tick_throttle_ms: entity.live_tick_throttle_ms,
      allowed_exchanges: entity.metadata?.exchanges,
    };

    // eslint-disable-next-line no-console
    console.log('[AdminController] Read API key limits', {
      key,
      limits,
    });

    return {
      key: entity.key,
      tenant_id: entity.tenant_id,
      is_active: entity.is_active,
      limits,
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage report for an API key' })
  @ApiQuery({ name: 'key', required: true })
  async usageReport(@Query('key') key: string) {
    const result = await this.apiKeyService.getUsageReport(key);
    return result;
  }

  @Get('apikeys/:key/usage')
  @ApiOperation({
    summary: 'Get usage metrics and limits for a single API key',
  })
  @ApiParam({ name: 'key', required: true })
  async apiKeyUsage(@Param('key') key: string) {
    const entity = await this.apiKeyRepo.findOne({ where: { key } });
    if (!entity) {
      throw new NotFoundException(`API key not found: ${key}`);
    }
    const usage = await this.apiKeyService.getUsageReport(key);
    const limits = {
      rate_limit_per_minute: entity.rate_limit_per_minute,
      connection_limit: entity.connection_limit,
      ws_subscribe_rps: entity.ws_subscribe_rps,
      ws_unsubscribe_rps: entity.ws_unsubscribe_rps,
      ws_mode_rps: entity.ws_mode_rps,
      ws_max_instruments: entity.ws_max_instruments,
      live_tick_throttle_ms: entity.live_tick_throttle_ms,
      allowed_exchanges: entity.metadata?.exchanges,
    };

    // eslint-disable-next-line no-console
    console.log('[AdminController] Read API key usage', {
      key,
      usage,
      limits,
    });

    return {
      key: entity.key,
      tenant_id: entity.tenant_id,
      is_active: entity.is_active,
      limits,
      usage,
    };
  }

  @Get('apikeys/usage')
  @ApiOperation({
    summary: 'List usage metrics and limits for all API keys (paginated)',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  async listApiKeysUsage(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));

    const [entities, total] = await this.apiKeyRepo.findAndCount({
      order: { created_at: 'DESC' },
      skip: (pageNum - 1) * pageSizeNum,
      take: pageSizeNum,
    });

    const items = await Promise.all(
      entities.map(async (entity) => {
        const usage = await this.apiKeyService.getUsageReport(entity.key);
        return {
          key: entity.key,
          tenant_id: entity.tenant_id,
          is_active: entity.is_active,
          limits: {
            rate_limit_per_minute: entity.rate_limit_per_minute,
            connection_limit: entity.connection_limit,
            ws_subscribe_rps: entity.ws_subscribe_rps,
            ws_unsubscribe_rps: entity.ws_unsubscribe_rps,
            ws_mode_rps: entity.ws_mode_rps,
            ws_max_instruments: entity.ws_max_instruments,
            allowed_exchanges: entity.metadata?.exchanges,
          },
          usage,
        };
      }),
    );

    // eslint-disable-next-line no-console
    console.log('[AdminController] Listed API key usage', {
      page: pageNum,
      pageSize: pageSizeNum,
      count: items.length,
      total,
    });

    return {
      page: pageNum,
      pageSize: pageSizeNum,
      total,
      items,
    };
  }

  @Get('apikeys/live-stats')
  @ApiOperation({
    summary: 'Batch live metrics for all API keys (Redis + gateway, no DB)',
    description:
      'Returns live connections, subscriptions, and bytes/24h for every key. Fast endpoint — safe to poll every 5s.',
  })
  async listApiKeysLiveStats() {
    const gatewayStats = this.gateway.getConnectionStats();
    const byApiKeyMap = new Map<
      string,
      { liveConnections: number; liveSubscriptions: number }
    >();
    for (const entry of gatewayStats.byApiKey as Array<{
      apiKey: string;
      connections: number;
      totalSubscribedInstruments: number;
    }>) {
      byApiKeyMap.set(entry.apiKey, {
        liveConnections: entry.connections,
        liveSubscriptions: entry.totalSubscribedInstruments,
      });
    }

    const allKeys = await this.apiKeyRepo.find({
      select: ['key', 'is_active'],
    });
    const keysArr = allKeys.map((k) => k.key);
    const bytesMap = await this.apiKeyService.getMultiBytesLast24h(keysArr);

    const items = allKeys.map((k) => {
      const live = byApiKeyMap.get(k.key) ?? {
        liveConnections: 0,
        liveSubscriptions: 0,
      };
      return {
        key: k.key,
        is_active: k.is_active,
        liveConnections: live.liveConnections,
        liveSubscriptions: live.liveSubscriptions,
        bytesLast24h: bytesMap.get(k.key) ?? 0,
      };
    });

    return { items, totalLiveConnections: gatewayStats.totalConnections };
  }

  @Get('apikeys/:key/live')
  @ApiOperation({
    summary: 'Deep live stats for a single API key — sockets, origins, bytes',
  })
  @ApiParam({ name: 'key', required: true })
  async getApiKeyLive(@Param('key') key: string) {
    const entity = await this.apiKeyRepo.findOne({ where: { key } });
    if (!entity) throw new NotFoundException(`API key not found: ${key}`);

    const liveDetail = this.gateway.getApiKeyLiveDetail(key);
    const [topOrigins, bytesLast24h, usageReport] = await Promise.all([
      this.originAudit.getTopOriginsForKey(key, 24, 20),
      this.apiKeyService.getBytesLast24h(key),
      this.apiKeyService.getUsageReport(key),
    ]);

    return {
      key: entity.key,
      tenant_id: entity.tenant_id,
      is_active: entity.is_active,
      liveConnections: liveDetail.liveConnections,
      liveSubscriptions: liveDetail.liveSubscriptions,
      sockets: liveDetail.sockets,
      topOrigins: topOrigins.map((o) => ({
        origin: o.origin,
        hitCount: o.hitCount,
        lastSeen: o.lastSeen.toISOString(),
        kind: o.kind,
      })),
      bytesLast24h,
      httpRequestsThisMinute: usageReport.httpRequestsThisMinute,
      currentWsConnections: usageReport.currentWsConnections,
    };
  }

  @Post('apikeys/provider')
  @ApiOperation({
    summary: 'Set provider for an API key (falcon|vayu or null to inherit)',
  })
  async setApiKeyProvider(
    @Body() body: { key: string; provider?: string | null },
  ) {
    let normalized: ReturnType<typeof normalizeProviderAlias> = null;
    if (body.provider != null && String(body.provider).trim() !== '') {
      const n = normalizeProviderAlias(body.provider);
      if (!n) {
        throw new BadRequestException(
          'provider must be kite, vortex, falcon, vayu, massive, or polygon',
        );
      }
      normalized = n;
    }
    await this.apiKeyRepo.update({ key: body.key }, { provider: normalized });
    return { success: true };
  }

  @Post('provider/global')
  @ApiOperation({
    summary: 'Set global provider for HTTP REST queries',
    description:
      'Sets the default provider used for HTTP REST quote requests (x-provider header overrides per-request). WebSocket streaming uses automatic per-exchange routing and ignores this setting.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: [
            'kite',
            'vortex',
            'falcon',
            'vayu',
            'massive',
            'polygon',
            'binance',
          ],
          description:
            'Internal or alias: kite/falcon (Falcon), vortex/vayu (Vayu), massive/polygon (Massive), binance (Binance)',
        },
      },
      example: { provider: 'vortex' },
    },
  })
  async setGlobalProvider(@Body() body: { provider: string }) {
    const internal = normalizeProviderAlias(body.provider);
    if (!internal) {
      throw new BadRequestException(
        'provider must be kite, vortex, falcon, vayu, massive, polygon, or binance',
      );
    }
    await this.resolver.setGlobalProviderName(internal);
    return {
      success: true,
      message: `Global provider set to ${internal}`,
      clientProvider: internalToClientProviderName(internal),
    };
  }

  @Get('provider/global')
  @ApiOperation({
    summary: 'Get current global provider',
    description:
      'Returns the currently configured global provider for WebSocket streaming',
  })
  async getGlobalProvider() {
    const name = await this.resolver.getGlobalProviderName();
    return {
      provider: name,
      clientProvider: name ? internalToClientProviderName(name) : null,
    };
  }

  @Post('provider/stream/start')
  @ApiOperation({
    summary: 'Start market data streaming',
    description:
      'Starts real-time market data streaming using the current global provider. Ensure provider is set first with POST /api/admin/provider/global',
  })
  async startStream() {
    await this.stream.startStreaming();
    const status = await this.stream.getStreamingStatus();
    return {
      success: true,
      message: 'Streaming started',
      status: status,
    };
  }

  @Post('provider/stream/stop')
  @ApiOperation({
    summary: 'Stop market data streaming',
    description:
      'Stops all real-time market data streaming. Does not reset the provider.',
  })
  async stopStream() {
    // Stop without re-initializing
    // Using the existing private method through public wrapper
    await (this.stream as any).stopStreaming?.();
    return {
      success: true,
      message: 'Streaming stopped',
    };
  }

  @Get('queues')
  @ApiOperation({
    summary: 'Get streaming queue depths and eviction metrics',
    description:
      'Returns current size, max capacity, percent-used, and eviction counters for the subscribe and unsubscribe queues.',
  })
  async getQueues() {
    return this.stream.getQueueStatus();
  }

  @Get('provider-capacity')
  @ApiOperation({
    summary:
      'Get per-provider upstream capacity: used/limit/percent, and per-shard breakdown for Vortex',
    description:
      'Returns a map of provider name to capacity snapshot. Vortex includes per-shard used counts and connection state.',
  })
  async getProviderCapacity() {
    return this.stream.getProviderCapacitySnapshot();
  }

  @Get('provider-health')
  @ApiOperation({
    summary: 'Get per-provider health including dead status from exhausted reconnects',
    description:
      'Returns an array of providers with their connection state, reconnect counts, and a dead flag when reconnect attempts have exceeded the maximum.',
  })
  async getProviderHealth() {
    const providers: ProviderHealthEntry[] = [];

    // Kite / Falcon
    try {
      const kiteStatus = (this.kiteProvider.getDebugStatus?.() ?? {}) as Record<string, unknown>;
      const isConnected = Boolean(kiteStatus.connected);
      const reconnectAttempts = (kiteStatus.reconnectAttempts as number) ?? 0;
      const maxAttempts = (kiteStatus.maxReconnectAttempts as number) ?? 10;
      providers.push({
        name: 'kite',
        isConnected,
        reconnectAttempts,
        reconnectCount: (kiteStatus.reconnectCount as number) ?? 0,
        maxReconnectAttempts: maxAttempts,
        isDead: reconnectAttempts >= maxAttempts,
        lastConnectAt: null,
        lastDisconnectAt: null,
      });
    } catch {}

    // Vortex / Vayu
    try {
      const vortexStatus = (this.vortexProvider.getDebugStatus?.() ?? {}) as Record<string, unknown>;
      const isConnected = Boolean(vortexStatus.connected);
      const reconnectAttempts = (vortexStatus.reconnectAttempts as number) ?? 0;
      const maxAttempts = (vortexStatus.maxReconnectAttempts as number) ?? 8;
      providers.push({
        name: 'vortex',
        isConnected,
        reconnectAttempts,
        reconnectCount: (vortexStatus.reconnectCount as number) ?? 0,
        maxReconnectAttempts: maxAttempts,
        isDead: reconnectAttempts >= maxAttempts,
        lastConnectAt: null,
        lastDisconnectAt: null,
      });
    } catch {}

    // Massive / Polygon
    try {
      const massiveStatus = this.massiveProvider.getShardStatus?.() ?? [];
      for (const shard of massiveStatus) {
        const reconnectAttempts = (shard as any).reconnectAttempts ?? 0;
        const maxAttempts = (shard as any).maxReconnectAttempts ?? 10;
        providers.push({
          name: `massive:${shard.name ?? 'unknown'}`,
          isConnected: Boolean(shard.isConnected),
          reconnectAttempts,
          reconnectCount: (shard as any).reconnectCount ?? 0,
          maxReconnectAttempts: maxAttempts,
          isDead: reconnectAttempts >= maxAttempts,
          lastConnectAt: null,
          lastDisconnectAt: null,
        });
      }
    } catch {}

    // Binance
    try {
      const binanceShards = this.binanceProvider.getShardStatus?.() ?? [];
      for (const shard of binanceShards) {
        const reconnectAttempts = (shard as any).reconnectAttempts ?? 0;
        const maxAttempts = (shard as any).maxReconnectAttempts ?? 10;
        providers.push({
          name: 'binance',
          isConnected: Boolean(shard.isConnected),
          reconnectAttempts,
          reconnectCount: (shard as any).reconnectCount ?? 0,
          maxReconnectAttempts: maxAttempts,
          isDead: reconnectAttempts >= maxAttempts,
          lastConnectAt: null,
          lastDisconnectAt: null,
        });
      }
    } catch {}

    return { providers };
  }

  @Get('stream/status')
  @ApiOperation({
    summary: 'Get streaming service status',
    description:
      'Returns current streaming status including provider, connection state, and subscribed instruments',
  })
  async streamStatus() {
    const status = await this.stream.getStreamingStatus();
    const kiteSubscribedInstruments =
      status.providers?.['falcon']?.subscribedCount ?? null;
    const registryStats = this.instrumentRegistry.getStats();
    return {
      ...status,
      kiteSubscribedInstruments,
      kiteUpstreamLimit: 3000,
      kiteUtilizationPct:
        kiteSubscribedInstruments != null
          ? Math.round((kiteSubscribedInstruments / 3000) * 100)
          : null,
      providerHealth: status.providers,
      registry: registryStats,
    };
  }

  // ===== WS Admin: Status =====
  @Get('ws/status')
  @ApiOperation({ summary: 'Get WebSocket namespace status' })
  async wsStatus() {
    const stats = (this.gateway as any)?.getConnectionStats?.();
    const streaming = await this.stream.getStreamingStatus();
    return {
      protocol_version:
        (this.gateway as any)?.constructor?.PROTOCOL_VERSION || '2.0',
      namespace: '/market-data',
      connections: stats?.totalConnections ?? 0,
      subscriptions: stats?.subscriptions ?? [],
      byApiKey: stats?.byApiKey ?? [],
      provider: streaming,
      redis_ok: true,
    };
  }

  @Get('ws/watch')
  @ApiOperation({
    summary: 'Consolidated real-time monitoring for all WS connections',
    description:
      'Returns all active sockets with their API keys, origins, and subscription counts.',
  })
  async wsWatch() {
    const watchStats = (this.gateway as any)?.getAllWatchStats?.() || {
      totalConnections: 0,
      sockets: [],
    };
    const topInstruments = this.wsInterest
      .getTopInstruments(20)
      .map((entry) => ({
        ...entry,
        symbol: this.instrumentRegistry.getCanonicalSymbol(entry.token) ?? null,
      }));

    return {
      success: true,
      totalConnections: watchStats.totalConnections,
      sockets: watchStats.sockets,
      topInstruments,
      timestamp: new Date().toISOString(),
    };
  }

  @Post('ws/sockets/:id/disconnect')
  @ApiOperation({ summary: 'Forcefully disconnect a specific WS socket' })
  @ApiParam({ name: 'id', required: true, description: 'Socket ID' })
  async disconnectSocket(@Param('id') id: string) {
    const success = await (this.gateway as any)?.disconnectSocket?.(id);
    if (!success)
      throw new NotFoundException(
        `Socket ${id} not found or gateway not ready`,
      );
    return { success: true, message: `Socket ${id} disconnected` };
  }

  @Get('ws/instruments/top')
  @ApiOperation({
    summary: 'Top N most-subscribed instruments by WS client ref count',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async topInstruments(@Query('limit') limitRaw?: string) {
    const limit = Math.max(
      1,
      Math.min(200, parseInt(String(limitRaw || '50')) || 50),
    );
    const raw = this.wsInterest.getTopInstruments(limit);
    const data = raw.map((entry: { token: number; subscribers: number }) => ({
      ...entry,
      symbol: this.instrumentRegistry.getCanonicalSymbol(entry.token) ?? null,
    }));
    return { success: true, data };
  }

  // ===== WS Admin: Config =====
  @Get('ws/config')
  @ApiOperation({ summary: 'Get WebSocket configuration' })
  async wsConfig() {
    const subscribeRps = Number(process.env.WS_SUBSCRIBE_RPS || 10);
    const unsubscribeRps = Number(process.env.WS_UNSUBSCRIBE_RPS || 10);
    const modeRps = Number(process.env.WS_MODE_RPS || 20);
    let maxSubs = 1000;
    try {
      const provider = await this.resolver.resolveForWebsocket();
      const lim = (provider as any)?.getSubscriptionLimit?.();
      if (Number.isFinite(lim) && lim > 0) maxSubs = lim;
    } catch {}
    return {
      rate_limits: {
        subscribe_rps: subscribeRps,
        unsubscribe_rps: unsubscribeRps,
        mode_rps: modeRps,
      },
      maxSubscriptionsPerSocket: maxSubs,
      entitlement_defaults: ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'],
    };
  }

  // ===== WS Admin: Rate limits =====
  @Post('ws/rate-limits')
  @ApiOperation({
    summary: 'Update WebSocket event rate limits (process env scoped)',
  })
  @ApiBody({
    schema: {
      properties: {
        subscribe_rps: { type: 'number' },
        unsubscribe_rps: { type: 'number' },
        mode_rps: { type: 'number' },
      },
    },
  })
  async setWsRateLimits(
    @Body()
    body: {
      subscribe_rps?: number;
      unsubscribe_rps?: number;
      mode_rps?: number;
    },
  ) {
    if (typeof body.subscribe_rps === 'number')
      (process.env as any).WS_SUBSCRIBE_RPS = String(body.subscribe_rps);
    if (typeof body.unsubscribe_rps === 'number')
      (process.env as any).WS_UNSUBSCRIBE_RPS = String(body.unsubscribe_rps);
    if (typeof body.mode_rps === 'number')
      (process.env as any).WS_MODE_RPS = String(body.mode_rps);
    return this.wsConfig();
  }

  // ===== WS Admin: Entitlements =====
  @Post('ws/entitlements')
  @ApiOperation({
    summary: 'Update API key exchange entitlements for WebSocket',
  })
  @ApiBody({
    schema: {
      properties: {
        apiKey: { type: 'string' },
        exchanges: { type: 'array', items: { type: 'string' } },
      },
      required: ['apiKey', 'exchanges'],
    },
  })
  async setWsEntitlements(
    @Body() body: { apiKey: string; exchanges: string[] },
  ) {
    await this.apiKeyRepo.update(
      { key: body.apiKey },
      { metadata: { exchanges: body.exchanges } as any },
    );
    // Notify gateways of update
    await this.apiKeyService.notifyApiKeyUpdate(body.apiKey);
    return { success: true };
  }

  // ===== WS Admin: Blocklist =====
  @Post('ws/blocklist')
  @ApiOperation({
    summary: 'Add tokens/exchanges/apiKey/tenant to WS blocklist (Redis)',
  })
  @ApiBody({
    schema: {
      properties: {
        tokens: { type: 'array', items: { type: 'number' } },
        exchanges: { type: 'array', items: { type: 'string' } },
        apiKey: { type: 'string' },
        tenant_id: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  })
  async addBlock(
    @Body()
    body: {
      tokens?: number[];
      exchanges?: string[];
      apiKey?: string;
      tenant_id?: string;
      reason?: string;
    },
  ) {
    if (Array.isArray(body.tokens))
      await this.redis.set(
        'ws:block:tokens',
        JSON.stringify(body.tokens),
        24 * 3600,
      );
    if (Array.isArray(body.exchanges))
      await this.redis.set(
        'ws:block:exchanges',
        JSON.stringify(body.exchanges),
        24 * 3600,
      );
    if (body.apiKey)
      await this.redis.set(`ws:block:apikey:${body.apiKey}`, '1', 24 * 3600);
    if (body.tenant_id)
      await this.redis.set(`ws:block:tenant:${body.tenant_id}`, '1', 24 * 3600);
    return { success: true };
  }

  @Post('ws/flush')
  @ApiOperation({ summary: 'Flush WS-related caches' })
  @ApiBody({
    schema: {
      properties: {
        caches: {
          type: 'array',
          items: { type: 'string' },
          example: ['last_tick', 'exchange_map', 'ws_counters'],
        },
      },
      required: ['caches'],
    },
  })
  async flushCaches(@Body() body: { caches: string[] }) {
    // Best-effort demo implementation (targets may differ by Redis keys used in services)
    for (const c of body.caches || []) {
      if (c === 'ws_counters') {
        // Not enumerating keys here (avoids KEYS *). In production, use prefix scans.
        // Placeholder response only.
      }
    }
    return { success: true };
  }

  @Post('ws/namespace/broadcast')
  @ApiOperation({ summary: 'Broadcast an event to WS namespace or room' })
  @ApiBody({
    schema: {
      properties: {
        event: { type: 'string' },
        room: { type: 'string' },
        payload: { type: 'object' },
      },
      required: ['event', 'payload'],
    },
  })
  async broadcast(
    @Body() body: { event: string; room?: string; payload: any },
  ) {
    try {
      const server = (this.gateway as any)?.server;
      if (!server)
        return { success: false, message: 'Gateway server not ready' };
      if (body.room) server.to(body.room).emit(body.event, body.payload);
      else server.emit(body.event, body.payload);
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as any)?.message };
    }
  }

  @Get('debug/falcon')
  @ApiOperation({ summary: 'Get debug status for Falcon provider/ticker' })
  async kiteDebug() {
    return this.kiteProvider.getDebugStatus?.() || {};
  }

  @Get('debug/vayu')
  @ApiOperation({ summary: 'Get debug status for Vayu provider/ticker' })
  async vortexDebug() {
    return this.vortexProvider.getDebugStatus?.() || {};
  }

  @Get('debug/uir/:id')
  @ApiOperation({
    summary:
      'Dump in-memory registry state for a UIR id (exchange, canonical, provider tokens, best provider)',
  })
  async uirDebug(@Param('id') id: string) {
    const uirId = Number(id);
    if (!Number.isFinite(uirId)) {
      throw new BadRequestException('Invalid UIR id');
    }
    const exchange = this.instrumentRegistry.getExchange(uirId);
    const canonical = this.instrumentRegistry.getCanonicalSymbol(uirId);
    const providerMap = this.instrumentRegistry.getProviderTokens(uirId);
    const bestProvider = this.instrumentRegistry.getBestProviderForUirId(uirId);
    const providerTokens: Record<string, string | undefined> = {};
    if (providerMap) {
      for (const [k, v] of providerMap.entries()) {
        providerTokens[k] = v;
      }
    }
    return {
      uirId,
      exchange,
      canonical,
      bestProvider,
      providerTokens,
    };
  }

  @Get('debug/uir/resolve')
  @ApiOperation({
    summary:
      'Test derivative/flex symbol resolution against the in-memory registry',
  })
  @ApiQuery({ name: 'symbol', required: true, example: 'MCX:GOLD:FUT' })
  async uirResolveDebug(@Query('symbol') symbol: string) {
    if (!symbol) {
      throw new BadRequestException('symbol query param is required');
    }
    const derivative = this.instrumentRegistry.resolveDerivativeSymbol(symbol);
    const flex = this.instrumentRegistry.resolveFlexSymbol(symbol);
    return {
      symbol,
      derivativeResolution: derivative ?? null,
      flexResolution: flex ?? null,
    };
  }

  // ===== Provider Credential Management =====

  @Get('provider/kite/config')
  @ApiOperation({
    summary: 'Get Falcon (Kite) credential status — values are masked',
  })
  async getKiteConfig() {
    return this.kiteProvider.getConfigStatus?.() || {};
  }

  @Post('provider/kite/credentials')
  @ApiOperation({
    summary:
      'Set Falcon (Kite) API key + secret — persisted to DB, survives restart',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'Kite Connect API key' },
        apiSecret: { type: 'string', description: 'Kite Connect API secret' },
      },
    },
  })
  async setKiteCredentials(
    @Body() body: { apiKey?: string; apiSecret?: string },
  ) {
    await this.kiteProvider.updateApiCredentials?.(body.apiKey, body.apiSecret);
    return { success: true };
  }

  @Get('provider/vortex/config')
  @ApiOperation({
    summary: 'Get Vayu (Vortex) credential status — values are masked',
  })
  async getVortexConfig() {
    return this.vortexProvider.getConfigStatus?.() || {};
  }

  @Post('provider/vortex/credentials')
  @ApiOperation({
    summary:
      'Set Vayu (Vortex) credentials — persisted to DB, survives restart',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'Vortex API key' },
        appId: { type: 'string', description: 'Vortex App ID' },
        baseUrl: { type: 'string', description: 'Vortex REST base URL' },
        wsUrl: { type: 'string', description: 'Vortex WebSocket URL' },
      },
    },
  })
  async setVortexCredentials(
    @Body()
    body: {
      apiKey?: string;
      appId?: string;
      baseUrl?: string;
      wsUrl?: string;
    },
  ) {
    await this.vortexProvider.updateApiCredentials?.(body);
    return { success: true };
  }

  @Get('provider/massive/config')
  @ApiOperation({
    summary: 'Get Massive (Polygon) credential status — values are masked',
  })
  async getMassiveConfig() {
    return this.massiveProvider.getConfigStatus();
  }

  @Post('provider/massive/credentials')
  @ApiOperation({
    summary:
      'Set Massive (Polygon) API key + options — persisted to DB, survives restart',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'Polygon.io API key' },
        realtime: {
          type: 'boolean',
          description: 'true = realtime feed, false = delayed (default)',
        },
        assetClass: {
          type: 'string',
          enum: ['stocks', 'crypto', 'forex', 'options'],
          description: 'WebSocket asset class (default: stocks)',
        },
      },
    },
  })
  async setMassiveCredentials(
    @Body() body: { apiKey?: string; realtime?: boolean; assetClass?: string },
  ) {
    await this.massiveProvider.updateApiCredentials(body);
    return { success: true };
  }

  @Get('events')
  @ApiOperation({
    summary:
      'Recent admin stream events (connect, disconnect, auth_error, max_reconnect)',
    description:
      'Ring buffer of last 50 events published by KiteProviderService. Useful for the admin dashboard events feed.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max events to return (1–50, default 20)',
  })
  async recentEvents(@Query('limit') limitRaw?: string) {
    const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));
    const raw = await this.redis.lrangeRaw('admin:events', 0, limit - 1);
    const events = raw.map((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return { raw: s };
      }
    });
    return { success: true, data: events, total: events.length };
  }

  // ===== Audit / Sampling Config =====

  @Get('audit/config')
  @ApiOperation({
    summary: 'Get current audit log sampling configuration',
  })
  async getAuditConfig() {
    const httpSampleRate = Number(
      this.configService.get('AUDIT_HTTP_SAMPLE_RATE', '0.01'),
    );
    const httpAlwaysLogErrors =
      this.configService.get('AUDIT_HTTP_ALWAYS_LOG_ERRORS', 'true') === 'true';
    const wsSubSampleRate = Number(
      this.configService.get('AUDIT_WS_SUB_SAMPLE_RATE', '0'),
    );

    return {
      http_sample_rate: Number.isFinite(httpSampleRate) ? httpSampleRate : 0.01,
      http_always_log_errors: httpAlwaysLogErrors,
      ws_sub_sample_rate: Number.isFinite(wsSubSampleRate)
        ? wsSubSampleRate
        : 0,
    };
  }

  // ===== Abuse / Resell Monitoring =====

  @Get('abuse/flags')
  @ApiOperation({
    summary: 'List abuse flags for API keys (potential resell/abuse detection)',
  })
  @ApiQuery({ name: 'blocked', required: false, example: true })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  async listAbuseFlags(
    @Query('blocked') blocked?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));

    const where: any = {};
    if (blocked === 'true') where.blocked = true;
    if (blocked === 'false') where.blocked = false;

    const [items, total] = await this.abuseRepo.findAndCount({
      where,
      order: { risk_score: 'DESC', detected_at: 'DESC' },
      skip: (pageNum - 1) * pageSizeNum,
      take: pageSizeNum,
    });

    // eslint-disable-next-line no-console
    console.log('[AdminController] Listed abuse flags', {
      page: pageNum,
      pageSize: pageSizeNum,
      count: items.length,
      total,
      blockedFilter: blocked,
    });

    return {
      page: pageNum,
      pageSize: pageSizeNum,
      total,
      items,
    };
  }

  @Get('abuse/flags/:key')
  @ApiOperation({
    summary: 'Get abuse flag status for a specific API key',
  })
  @ApiParam({ name: 'key', required: true })
  async getAbuseFlag(@Param('key') key: string) {
    const flag = await this.abuseRepo.findOne({
      where: { api_key: key },
    });
    if (!flag) {
      throw new NotFoundException(`No abuse flag found for API key: ${key}`);
    }
    const status = await this.abuseDetection.getStatusForApiKey(key);
    // eslint-disable-next-line no-console
    console.log('[AdminController] Read abuse flag', { key, flag });
    return {
      flag,
      status,
    };
  }

  @Post('abuse/flags/block')
  @ApiOperation({
    summary:
      'Manually block an API key for abuse (strict resell / misuse enforcement)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        api_key: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['api_key'],
    },
  })
  async manualBlock(@Body() body: { api_key: string; reason?: string }) {
    const apiKey = body.api_key;
    const existing =
      (await this.abuseRepo.findOne({ where: { api_key: apiKey } })) ||
      this.abuseRepo.create({
        api_key: apiKey,
        tenant_id: null,
        risk_score: this.abuseDetection.getBlockScoreThreshold(),
        reason_codes: [],
        blocked: true,
        last_seen_at: new Date(),
      });

    const reasons = Array.isArray(existing.reason_codes)
      ? [...existing.reason_codes]
      : [];
    reasons.push('manual_block');
    if (body.reason) reasons.push(body.reason);

    existing.blocked = true;
    existing.risk_score = Math.max(
      existing.risk_score,
      this.abuseDetection.getBlockScoreThreshold(),
    );
    existing.reason_codes = reasons;
    existing.last_seen_at = new Date();

    const saved = await this.abuseRepo.save(existing);
    // eslint-disable-next-line no-console
    console.log('[AdminController] Manually blocked API key', {
      api_key: apiKey,
      reason: body.reason,
    });
    return {
      success: true,
      flag: saved,
    };
  }

  @Post('abuse/flags/unblock')
  @ApiOperation({
    summary: 'Manually unblock an API key that was previously blocked',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        api_key: { type: 'string' },
      },
      required: ['api_key'],
    },
  })
  async manualUnblock(@Body() body: { api_key: string }) {
    const apiKey = body.api_key;
    const existing = await this.abuseRepo.findOne({
      where: { api_key: apiKey },
    });
    if (!existing) {
      throw new NotFoundException(`No abuse flag found for API key: ${apiKey}`);
    }
    existing.blocked = false;
    existing.risk_score = 0;
    existing.reason_codes = [
      ...(existing.reason_codes || []),
      'manual_unblock',
    ];
    existing.last_seen_at = new Date();

    const saved = await this.abuseRepo.save(existing);
    // eslint-disable-next-line no-console
    console.log('[AdminController] Manually unblocked API key', {
      api_key: apiKey,
    });
    return {
      success: true,
      flag: saved,
    };
  }
}
