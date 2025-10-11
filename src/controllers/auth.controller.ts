import { Controller, Get, Query, Res, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { KiteConnect } from 'kiteconnect';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { KiteSession } from '../entities/kite-session.entity';
import { RedisService } from '../services/redis.service';
import { ApiOperation, ApiQuery, ApiTags, ApiResponse } from '@nestjs/swagger';
import { KiteConnectService } from '../services/kite-connect.service';

@Controller('api/auth/kite')
@ApiTags('auth')
export class AuthController {
  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private kiteConnectService: KiteConnectService,
    @InjectRepository(KiteSession) private kiteSessionRepo: Repository<KiteSession>,
  ) {}

  @Get('login')
  @ApiOperation({ summary: 'Get Kite login URL with CSRF state' })
  @ApiResponse({ status: 200, description: 'Kite login URL', schema: { properties: { url: { type: 'string', example: 'https://kite.trade/connect/login?...' }, state: { type: 'string' } } } })
  async login(@Res() res: Response) {
    const apiKey = this.configService.get<string>('KITE_API_KEY');
    const apiSecret = this.configService.get<string>('KITE_API_SECRET');
    if (!apiKey || !apiSecret) throw new BadRequestException('Kite API creds not configured');

    const kite = new KiteConnect({ api_key: apiKey });
    const state = Math.random().toString(36).slice(2);
    await this.redisService.set(`kite_oauth_state:${state}`, { createdAt: Date.now() }, 300);
    const url = kite.getLoginURL({ state });
    return res.json({ url, state });
  }

  @Get('callback')
  @ApiOperation({ summary: 'Kite OAuth callback handler' })
  @ApiQuery({ name: 'request_token', required: true })
  @ApiQuery({ name: 'state', required: true })
  @ApiResponse({ status: 200, description: 'OAuth success', schema: { properties: { success: { type: 'boolean', example: true } } } })
  async callback(@Query('request_token') requestToken: string, @Query('state') state: string) {
    const apiKey = this.configService.get<string>('KITE_API_KEY');
    const apiSecret = this.configService.get<string>('KITE_API_SECRET');
    if (!apiKey || !apiSecret) throw new BadRequestException('Kite API creds not configured');

    const expected = await this.redisService.get(`kite_oauth_state:${state}`);
    if (!expected) throw new BadRequestException('Invalid or expired state');

    const kite = new KiteConnect({ api_key: apiKey });
    const session = await kite.generateSession(requestToken, apiSecret);
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
    await this.kiteConnectService.updateAccessToken(session.access_token);
    await this.kiteConnectService.restartTicker();

    return { success: true };
  }
}
