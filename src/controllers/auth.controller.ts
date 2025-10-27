import { Controller, Get, Query, Res, BadRequestException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { KiteConnect } from 'kiteconnect';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { KiteSession } from '../entities/kite-session.entity';
import { RedisService } from '../services/redis.service';
import { ApiOperation, ApiQuery, ApiTags, ApiResponse, ApiOkResponse, ApiBadRequestResponse } from '@nestjs/swagger';
import { KiteProviderService } from '../providers/kite-provider.service';
import axios from 'axios';
import { VortexProviderService } from '../providers/vortex-provider.service';
import { MarketDataStreamService } from '../services/market-data-stream.service';
import { VortexSession } from '../entities/vortex-session.entity';
import { MarketDataProviderResolverService } from '../services/market-data-provider-resolver.service';

// Fallback in-memory store for OAuth state when Redis is unavailable
const kiteStateMemory = new Map<string, number>(); // state -> createdAt (ms)

@Controller('auth/falcon')
@ApiTags('auth')
export class AuthController {
  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private kiteProvider: KiteProviderService,
    @InjectRepository(KiteSession) private kiteSessionRepo: Repository<KiteSession>,
  ) {}

  @Get('login')
  @ApiOperation({ summary: 'Get Falcon login URL with CSRF state' })
  @ApiResponse({ status: 200, description: 'Falcon login URL', schema: { properties: { url: { type: 'string', example: 'https://kite.trade/connect/login?...' }, state: { type: 'string' } } } })
  async login(@Res() res: Response) {
    const apiKey = this.configService.get<string>('KITE_API_KEY');
    const apiSecret = this.configService.get<string>('KITE_API_SECRET');
    if (!apiKey || !apiSecret) throw new BadRequestException('Falcon API creds not configured');

    const kite = new KiteConnect({ api_key: apiKey });
    const state = Math.random().toString(36).slice(2);
    if (this.redisService.isRedisAvailable()) {
      await this.redisService.set(`kite_oauth_state:${state}`, { createdAt: Date.now() }, 300);
    } else {
      // Memory fallback with 5 min TTL
      kiteStateMemory.set(state, Date.now());
    }
    // Ensure compatibility: append state param if SDK doesn't accept object arg
    const baseUrl = (kite as any).getLoginURL?.() || '';
    const url = baseUrl ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}state=${state}` : baseUrl;
    return res.json({ url, state });
  }

  @Get('callback')
  @ApiOperation({ summary: 'Falcon OAuth callback handler' })
  @ApiQuery({ name: 'request_token', required: true })
  @ApiQuery({ name: 'state', required: true })
  @ApiResponse({ status: 200, description: 'OAuth success', schema: { properties: { success: { type: 'boolean', example: true } } } })
  async callback(@Query('request_token') requestToken: string, @Query('state') state: string) {
    const apiKey = this.configService.get<string>('KITE_API_KEY');
    const apiSecret = this.configService.get<string>('KITE_API_SECRET');
    if (!apiKey || !apiSecret) throw new BadRequestException('Falcon API creds not configured');

    let stateValid = false;
    if (this.redisService.isRedisAvailable()) {
      const expected = await this.redisService.get(`kite_oauth_state:${state}`);
      stateValid = !!expected;
    } else {
      const createdAt = kiteStateMemory.get(state);
      if (createdAt && Date.now() - createdAt < 5 * 60 * 1000) stateValid = true;
    }
    if (!stateValid) throw new BadRequestException('Invalid or expired state');

    const kite = new KiteConnect({ api_key: apiKey });
    let session: any;
    try {
      session = await kite.generateSession(requestToken, apiSecret);
    } catch (e: any) {
      throw new BadRequestException(`Falcon OAuth failed: ${e?.message || 'unknown error'}`);
    }
    const entity = this.kiteSessionRepo.create({
      access_token: session.access_token,
      public_token: session.public_token,
      is_active: true,
      metadata: session,
    });
    // deactivate previous sessions
    await this.kiteSessionRepo.createQueryBuilder()
      .update(KiteSession)
      .set({ is_active: false })
      .where('is_active = :active', { active: true })
      .execute();
    await this.kiteSessionRepo.save(entity);

    // store in env-backed cache for ticker re-init
    await this.redisService.set('kite:access_token', session.access_token, 24 * 3600);

    // update in-memory client and restart ticker
    await this.kiteProvider.updateAccessToken(session.access_token);
    await this.kiteProvider.restartTicker();

    // Invalidate state after successful callback
    try {
      if (this.redisService.isRedisAvailable()) await this.redisService.del(`kite_oauth_state:${state}`);
      kiteStateMemory.delete(state);
    } catch {}

    return { success: true };
  }
}

@Controller('auth/vayu')
@ApiTags('auth')
export class VortexAuthController {
  private readonly logger = new Logger(VortexAuthController.name);

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private vortexProvider: VortexProviderService,
    private streamService: MarketDataStreamService,
    private resolver: MarketDataProviderResolverService,
    @InjectRepository(VortexSession) private vortexSessionRepo: Repository<VortexSession>,
  ) {}

  @Get('login')
  @ApiOperation({ summary: 'Get Vayu login URL', description: 'Returns the Rupeezy Vayu OAuth login URL generated from your VORTEX_APP_ID.' })
  @ApiOkResponse({ description: 'Vayu login URL', schema: { type: 'object', properties: { url: { type: 'string', example: 'https://flow.rupeezy.in?applicationId=YOUR_APP_ID' } } } })
  @ApiBadRequestResponse({ description: 'Missing configuration', schema: { type: 'object', properties: { statusCode: { type: 'number', example: 400 }, message: { type: 'string', example: 'Vayu applicationId (VORTEX_APP_ID) not configured' }, error: { type: 'string', example: 'Bad Request' } } } })
  async login(@Res() res: Response) {
    const appId = this.configService.get<string>('VORTEX_APP_ID');
    if (!appId) throw new BadRequestException('Vayu applicationId (VORTEX_APP_ID) not configured');
    const url = `https://flow.rupeezy.in?applicationId=${encodeURIComponent(appId)}`;
    return res.json({ url });
  }

  @Get('callback')
  @ApiOperation({ summary: 'Vayu callback handler (exchanges auth->access_token)', description: 'Handles redirect from Rupeezy Vayu. Reads the auth query param, computes checksum, calls Create Session API, and persists the access_token to the database.' })
  @ApiQuery({ name: 'auth', required: true })
  @ApiOkResponse({ description: 'Session created', schema: { type: 'object', properties: { success: { type: 'boolean', example: true } }, example: { success: true } } })
  @ApiBadRequestResponse({ description: 'Exchange failed or misconfigured', schema: { type: 'object', properties: { statusCode: { type: 'number', example: 400 }, message: { type: 'string', example: 'Vayu session creation failed: ...' }, error: { type: 'string', example: 'Bad Request' } } } })
  async callback(@Query('auth') auth: string) {
    try {
      this.logger.log(`[Vayu] Callback received with auth parameter: ${auth ? 'present' : 'missing'}`);
      
      const appId = this.configService.get<string>('VORTEX_APP_ID');
      const apiKey = this.configService.get<string>('VORTEX_API_KEY');
      const baseUrl = (this.configService.get<string>('VORTEX_BASE_URL') || 'https://vortex-api.rupeezy.in/v2').replace(/\/$/, '');
      const createSessionUrl = `${baseUrl}/user/session`;
      
      this.logger.log(`[Vayu] Configuration: appId=${appId ? 'present' : 'missing'}, apiKey=${apiKey ? 'present' : 'missing'}, baseUrl=${baseUrl}`);
      
      if (!appId || !apiKey) {
        throw new BadRequestException('Vayu envs missing: VORTEX_APP_ID, VORTEX_API_KEY');
      }
      if (!auth) throw new BadRequestException('Missing auth parameter');

      // checksum = sha256(appId + auth + apiKey) hex-lowercase
      const crypto = await import('crypto');
      const checksum = crypto.createHash('sha256').update(`${appId}${auth}${apiKey}`).digest('hex');
      this.logger.log(`[Vayu] Generated checksum for session creation`);

      let sessionResp: any;
      try {
        this.logger.log(`[Vayu] Creating session at ${createSessionUrl.replace(apiKey, '***')}`);
        sessionResp = await axios.post(createSessionUrl, {
          checksum,
          applicationId: appId,
          token: auth,
        }, {
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          timeout: 10000,
        });
        this.logger.log(`[Vayu] Session creation successful, received response`);
        
        // Log full response for debugging
        this.logger.log(`[Vayu] Response structure: ${JSON.stringify({ 
          status: sessionResp?.data?.status,
          hasData: !!sessionResp?.data?.data,
          hasAccessToken: !!sessionResp?.data?.data?.access_token 
        })}`);
        
      } catch (e: any) {
        const status = e?.response?.status;
        const body = e?.response?.data;
        const sanitizedUrl = createSessionUrl.replace(apiKey, '***');
        const msg = body || e?.message || 'unknown error';
        this.logger.error(`[Vayu] Session creation failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)} (status=${status || 'n/a'})`);
        throw new BadRequestException(`Vayu session creation failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)} (status=${status || 'n/a'} url=${sanitizedUrl})`);
      }

      // Check if response indicates success
      if (sessionResp?.data?.status !== 'success') {
        this.logger.error(`[Vayu] Session creation returned non-success status: ${JSON.stringify(sessionResp?.data)}`);
        throw new BadRequestException(`Vayu session creation failed: ${JSON.stringify(sessionResp?.data)}`);
      }

      const data = sessionResp?.data?.data || {};
      const accessToken: string | undefined = data?.access_token;
      
      // Additional debug logging
      if (!accessToken) {
        this.logger.error(`[Vayu] Response data structure: ${JSON.stringify(sessionResp?.data)}`);
        throw new BadRequestException(`Vayu session did not return access_token. Response: ${JSON.stringify(sessionResp?.data)}`);
      }
      
      this.logger.log(`[Vayu] Access token extracted, length: ${accessToken.length}`);

      // Determine TTL from JWT exp if present
      let ttl = 24 * 3600; // fallback 24h
      try {
        const parts = accessToken.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
          if (payload?.exp) {
            const nowSec = Math.floor(Date.now() / 1000);
            const remain = Math.max(60, payload.exp - nowSec);
            ttl = remain;
            this.logger.log(`[Vayu] JWT TTL calculated: ${remain}s (expires at ${new Date(payload.exp * 1000).toISOString()})`);
          }
        }
      } catch (e) {
        this.logger.warn(`[Vayu] Failed to parse JWT TTL, using fallback: ${ttl}s`);
      }

      // Persist session in DB; deactivate previous
      this.logger.log(`[Vayu] Deactivating previous sessions and saving new session`);
      await this.vortexSessionRepo.createQueryBuilder()
        .update(VortexSession)
        .set({ is_active: false })
        .where('is_active = :active', { active: true })
        .execute();
      const expiresAt = ((): Date | null => {
        try {
          const parts = accessToken.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            if (payload?.exp) return new Date(payload.exp * 1000);
          }
        } catch {}
        return null;
      })();
      const entity = this.vortexSessionRepo.create({ access_token: accessToken, is_active: true, expires_at: expiresAt, metadata: data });
      await this.vortexSessionRepo.save(entity);
      this.logger.log(`[Vayu] Session saved to database with ID: ${entity.id}`);

      // Cache token in Redis for cross-process readers with JWT-derived TTL
      try {
        if (this.redisService.isRedisAvailable?.()) {
          await this.redisService.set('vortex:access_token', accessToken, ttl);
          this.logger.log(`[Vayu] Token cached in Redis with TTL: ${ttl}s`);
        } else {
          this.logger.warn(`[Vayu] Redis not available, skipping token cache`);
        }
      } catch (e) {
        this.logger.error(`[Vayu] Failed to cache token in Redis`, e as any);
      }

      // Update in-memory provider to pick latest token
      try {
        if (typeof (this.vortexProvider as any).updateAccessToken === 'function') {
          await (this.vortexProvider as any).updateAccessToken(accessToken);
          this.logger.log('[Vayu] Updated access token in provider');
        }
      } catch (e) {
        this.logger.error('[Vayu] Failed to update access token in provider', e as any);
      }

      // Auto-set global provider to vortex after successful login
      try {
        await this.resolver.setGlobalProviderName('vortex');
        this.logger.log('[Vayu] Auto-set global provider to vortex');
      } catch (e) {
        this.logger.error('[Vayu] Failed to set global provider', e as any);
      }

      // Auto-start streaming if not already active
      try {
        const status = await this.streamService.getStreamingStatus();
        if (!status?.isStreaming) {
          await this.streamService.startStreaming();
          this.logger.log('[Vayu] Auto-started streaming after successful login');
        } else {
          this.logger.log('[Vayu] Streaming already active, reconnecting with new token');
          if (typeof (this.streamService as any).reconnectIfStreaming === 'function') {
            await (this.streamService as any).reconnectIfStreaming();
          }
        }
      } catch (e) {
        this.logger.error('[Vayu] Failed to start/reconnect streaming', e as any);
      }

      return { success: true };
    } catch (error) {
      this.logger.error(`[Vayu] Callback error: ${error.message}`, error.stack);
      throw new BadRequestException(`Vayu callback failed: ${error.message}`);
    }
  }
}
