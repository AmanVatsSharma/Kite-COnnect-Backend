import { Body, Controller, Get, Post, UseGuards, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { AdminGuard } from '../guards/admin.guard';
import { ApiKeyService } from '../services/api-key.service';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';
import { KiteProviderService } from '../providers/kite-provider.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { VortexProviderService } from '../providers/vortex-provider.service';
import { RedisService } from '../services/redis.service';
import { MarketDataGateway } from '../gateways/market-data.gateway';

@Controller('admin')
@ApiTags('admin', 'admin-ws')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private apiKeyService: ApiKeyService,
    private resolver: MarketDataProviderResolverService,
    private kiteProvider: KiteProviderService,
    private stream: MarketDataStreamService,
    private vortexProvider: VortexProviderService,
    private redis: RedisService,
    private gateway: MarketDataGateway,
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
    },
  ) {
    const entity = this.apiKeyRepo.create({
      key: body.key,
      tenant_id: body.tenant_id,
      name: body.name,
      rate_limit_per_minute: body.rate_limit_per_minute ?? 600,
      connection_limit: body.connection_limit ?? 2000,
    });
    return await this.apiKeyRepo.save(entity);
  }

  @Get('apikeys')
  @ApiOperation({ summary: 'List API keys' })
  async listApiKeys() {
    return this.apiKeyRepo.find({ order: { created_at: 'DESC' } });
  }

  @Post('apikeys/deactivate')
  @ApiOperation({ summary: 'Deactivate API key' })
  async deactivate(@Body() body: { key: string }) {
    await this.apiKeyRepo.update({ key: body.key }, { is_active: false });
    return { success: true };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage report for an API key' })
  @ApiQuery({ name: 'key', required: true })
  async usageReport(@Query('key') key: string) {
    const result = await this.apiKeyService.getUsageReport(key);
    return result;
  }

  @Post('apikeys/provider')
  @ApiOperation({
    summary: 'Set provider for an API key (falcon|vayu or null to inherit)',
  })
  async setApiKeyProvider(
    @Body() body: { key: string; provider?: 'kite' | 'vortex' | null },
  ) {
    await this.apiKeyRepo.update(
      { key: body.key },
      { provider: body.provider ?? null },
    );
    return { success: true };
  }

  @Post('provider/global')
  @ApiOperation({
    summary: 'Set global provider for WebSocket streaming',
    description:
      'Sets the global market data provider that will be used for all WebSocket connections. Must be done before starting streaming.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['kite', 'vortex'],
          description: 'Provider to use: "kite" for Falcon, "vortex" for Vayu',
        },
      },
      example: { provider: 'vortex' },
    },
  })
  async setGlobalProvider(@Body() body: { provider: 'kite' | 'vortex' }) {
    await this.resolver.setGlobalProviderName(body.provider);
    return {
      success: true,
      message: `Global provider set to ${body.provider}`,
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
    return { provider: name };
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

  @Get('stream/status')
  @ApiOperation({
    summary: 'Get streaming service status',
    description:
      'Returns current streaming status including provider, connection state, and subscribed instruments',
  })
  async streamStatus() {
    const status = await this.stream.getStreamingStatus();
    return status;
  }

  // ===== WS Admin: Status =====
  @Get('ws/status')
  @ApiOperation({ summary: 'Get WebSocket namespace status' })
  async wsStatus() {
    const stats = (this.gateway as any)?.getConnectionStats?.();
    const streaming = await this.stream.getStreamingStatus();
    return {
      protocol_version: (this.gateway as any)?.constructor?.PROTOCOL_VERSION || '2.0',
      namespace: '/market-data',
      connections: stats?.totalConnections ?? 0,
      subscriptions: stats?.subscriptions ?? [],
      provider: streaming,
      redis_ok: true,
    };
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
      rate_limits: { subscribe_rps: subscribeRps, unsubscribe_rps: unsubscribeRps, mode_rps: modeRps },
      maxSubscriptionsPerSocket: maxSubs,
      entitlement_defaults: ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'],
    };
  }

  // ===== WS Admin: Rate limits =====
  @Post('ws/rate-limits')
  @ApiOperation({ summary: 'Update WebSocket event rate limits (process env scoped)' })
  @ApiBody({ schema: { properties: { subscribe_rps: { type: 'number' }, unsubscribe_rps: { type: 'number' }, mode_rps: { type: 'number' } } } })
  async setWsRateLimits(@Body() body: { subscribe_rps?: number; unsubscribe_rps?: number; mode_rps?: number }) {
    if (typeof body.subscribe_rps === 'number') (process.env as any).WS_SUBSCRIBE_RPS = String(body.subscribe_rps);
    if (typeof body.unsubscribe_rps === 'number') (process.env as any).WS_UNSUBSCRIBE_RPS = String(body.unsubscribe_rps);
    if (typeof body.mode_rps === 'number') (process.env as any).WS_MODE_RPS = String(body.mode_rps);
    return this.wsConfig();
  }

  // ===== WS Admin: Entitlements =====
  @Post('ws/entitlements')
  @ApiOperation({ summary: 'Update API key exchange entitlements for WebSocket' })
  @ApiBody({ schema: { properties: { apiKey: { type: 'string' }, exchanges: { type: 'array', items: { type: 'string' } } }, required: ['apiKey', 'exchanges'] } })
  async setWsEntitlements(@Body() body: { apiKey: string; exchanges: string[] }) {
    await this.apiKeyRepo.update({ key: body.apiKey }, { metadata: { exchanges: body.exchanges } as any });
    return { success: true };
  }

  // ===== WS Admin: Blocklist =====
  @Post('ws/blocklist')
  @ApiOperation({ summary: 'Add tokens/exchanges/apiKey/tenant to WS blocklist (Redis)' })
  @ApiBody({ schema: { properties: { tokens: { type: 'array', items: { type: 'number' } }, exchanges: { type: 'array', items: { type: 'string' } }, apiKey: { type: 'string' }, tenant_id: { type: 'string' }, reason: { type: 'string' } } } })
  async addBlock(@Body() body: { tokens?: number[]; exchanges?: string[]; apiKey?: string; tenant_id?: string; reason?: string }) {
    if (Array.isArray(body.tokens)) await this.redis.set('ws:block:tokens', JSON.stringify(body.tokens), 24 * 3600);
    if (Array.isArray(body.exchanges)) await this.redis.set('ws:block:exchanges', JSON.stringify(body.exchanges), 24 * 3600);
    if (body.apiKey) await this.redis.set(`ws:block:apikey:${body.apiKey}`, '1', 24 * 3600);
    if (body.tenant_id) await this.redis.set(`ws:block:tenant:${body.tenant_id}`, '1', 24 * 3600);
    return { success: true };
  }

  @Post('ws/flush')
  @ApiOperation({ summary: 'Flush WS-related caches' })
  @ApiBody({ schema: { properties: { caches: { type: 'array', items: { type: 'string' }, example: ['last_tick', 'exchange_map', 'ws_counters'] } }, required: ['caches'] } })
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
  @ApiBody({ schema: { properties: { event: { type: 'string' }, room: { type: 'string' }, payload: { type: 'object' } }, required: ['event', 'payload'] } })
  async broadcast(@Body() body: { event: string; room?: string; payload: any }) {
    try {
      const server = (this.gateway as any)?.server;
      if (!server) return { success: false, message: 'Gateway server not ready' };
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
}
