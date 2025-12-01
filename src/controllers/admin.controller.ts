import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  Query,
  Param,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiQuery,
  ApiBody,
  ApiParam,
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
import { InjectRepository } from '@nestjs/typeorm';
import { ApiKeyAbuseFlag } from '../entities/api-key-abuse-flag.entity';
import { AbuseDetectionService } from '../services/abuse-detection.service';

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
    private redis: RedisService,
    private gateway: MarketDataGateway,
    private abuseDetection: AbuseDetectionService,
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
    },
  ) {
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
      },
    });
    return saved;
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

    if (Object.keys(patch).length === 0) {
      return {
        success: true,
        message: 'No limit fields provided – nothing to update',
        key: body.key,
      };
    }

    const result = await this.apiKeyRepo.update({ key: body.key }, patch);
    if (!result.affected) {
      throw new NotFoundException(`API key not found: ${body.key}`);
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
        }
      : patch;

    // eslint-disable-next-line no-console
    console.log('[AdminController] Updated API key limits', {
      key: body.key,
      limits,
    });

    return {
      success: true,
      key: body.key,
      limits,
    };
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
    const pageSizeNum = Math.min(
      200,
      Math.max(1, Number(pageSize) || 50),
    );

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
      byApiKey: stats?.byApiKey ?? [],
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
    const pageSizeNum = Math.min(
      200,
      Math.max(1, Number(pageSize) || 50),
    );

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
