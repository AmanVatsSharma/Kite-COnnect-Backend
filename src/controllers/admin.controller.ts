import { Body, Controller, Get, Post, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity, ApiQuery, ApiBody } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { AdminGuard } from '../guards/admin.guard';
import { ApiKeyService } from '../services/api-key.service';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';
import { KiteProviderService } from '../providers/kite-provider.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { VortexProviderService } from '../providers/vortex-provider.service';

@Controller('api/admin')
@ApiTags('admin')
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
  ) {}

  @Post('apikeys')
  @ApiOperation({ summary: 'Create API key' })
  @ApiBody({ schema: { properties: { key: { type: 'string', example: 'demo-key-1' }, tenant_id: { type: 'string', example: 'tenant-1' }, rate_limit_per_minute: { type: 'number', example: 600 }, connection_limit: { type: 'number', example: 2000 } } } })
  async createApiKey(@Body() body: { key: string; tenant_id: string; name?: string; rate_limit_per_minute?: number; connection_limit?: number }) {
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
  @ApiOperation({ summary: 'Set provider for an API key (kite|vortex or null to inherit)' })
  async setApiKeyProvider(@Body() body: { key: string; provider?: 'kite' | 'vortex' | null }) {
    await this.apiKeyRepo.update({ key: body.key }, { provider: body.provider ?? null });
    return { success: true };
  }

  @Post('provider/global')
  @ApiOperation({ summary: 'Set global provider for WebSocket streaming (kite|vortex)' })
  async setGlobalProvider(@Body() body: { provider: 'kite' | 'vortex' }) {
    await this.resolver.setGlobalProviderName(body.provider);
    return { success: true };
  }

  @Get('provider/global')
  @ApiOperation({ summary: 'Get current global provider for WebSocket streaming' })
  async getGlobalProvider() {
    const name = await this.resolver.getGlobalProviderName();
    return { provider: name };
  }

  @Post('provider/stream/start')
  @ApiOperation({ summary: 'Start market data streaming for the current global provider' })
  async startStream() {
    await this.stream.startStreaming();
    return { success: true };
  }

  @Post('provider/stream/stop')
  @ApiOperation({ summary: 'Stop market data streaming' })
  async stopStream() {
    // Stop without re-initializing
    // Using the existing private method through public wrapper
    await (this.stream as any).stopStreaming?.();
    return { success: true };
  }

  @Get('stream/status')
  @ApiOperation({ summary: 'Get streaming service status' })
  async streamStatus() {
    return this.stream.getStreamingStatus();
  }

  @Get('debug/kite')
  @ApiOperation({ summary: 'Get debug status for Kite provider/ticker' })
  async kiteDebug() {
    return this.kiteProvider.getDebugStatus?.() || {};
  }

  @Get('debug/vortex')
  @ApiOperation({ summary: 'Get debug status for Vortex provider/ticker' })
  async vortexDebug() {
    return this.vortexProvider.getDebugStatus?.() || {};
  }
}
