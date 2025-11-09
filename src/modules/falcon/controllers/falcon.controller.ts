import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpStatus,
  HttpException,
  Param,
} from '@nestjs/common';
import { Response } from 'express';
import { FalconInstrumentService } from '../services/falcon-instrument.service';
import { FalconProviderAdapter } from '../services/falcon-provider.adapter';
import { RedisService } from '../../../services/redis.service';
import { randomUUID } from 'crypto';

@Controller('stock/falcon')
export class FalconController {
  constructor(
    private readonly falconInstruments: FalconInstrumentService,
    private readonly falconAdapter: FalconProviderAdapter,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  async health() {
    try {
      const probe = await this.falconAdapter.getLTP(['26000']); // SBIN as a common example token
      const ok = Number.isFinite(probe?.['26000']?.last_price as any);
      return {
        success: true,
        provider: 'falcon',
        httpOk: true,
        sample_ok: ok,
        sample_token: '26000',
      };
    } catch (e: any) {
      return {
        success: false,
        provider: 'falcon',
        httpOk: false,
        error: e?.message || 'unknown',
      };
    }
  }

  @Post('instruments/sync')
  async syncInstruments(
    @Query('exchange') exchange?: string,
  ) {
    try {
      const res = await this.falconInstruments.syncFalconInstruments(exchange);
      return { success: true, ...res };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon sync failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments')
  async getInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
    @Query('segment') segment?: string,
    @Query('is_active') is_active_raw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(is_active_raw || '').toLowerCase() === 'true' ? true : String(is_active_raw || '').toLowerCase() === 'false' ? false : undefined;
      const limit = Math.max(1, Math.min(1000, parseInt(String(limitRaw || '100')) || 100));
      const offset = Math.max(0, parseInt(String(offsetRaw || '0')) || 0);
      const result = await this.falconInstruments.getFalconInstruments({
        exchange,
        instrument_type,
        segment,
        is_active,
        limit,
        offset,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon instruments', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/:token')
  async getInstrumentByToken(@Param('token') tokenRaw?: string) {
    try {
      const token = Number(tokenRaw);
      if (!Number.isFinite(token)) {
        throw new HttpException({ success: false, message: 'Invalid token' }, HttpStatus.BAD_REQUEST);
      }
      const instrument = await this.falconInstruments.getFalconInstrumentByToken(token);
      if (!instrument) {
        throw new HttpException({ success: false, message: 'Instrument not found' }, HttpStatus.NOT_FOUND);
      }
      return { success: true, data: instrument };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon instrument', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  async search(@Query('q') q?: string, @Query('limit') limitRaw?: string) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      const limit = Math.max(1, Math.min(200, parseInt(String(limitRaw || '20')) || 20));
      const data = await this.falconInstruments.searchFalconInstruments(q, limit);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon search failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/stats')
  async stats() {
    try {
      const data = await this.falconInstruments.getFalconInstrumentStats();
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon stats failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/sync/stream')
  async syncInstrumentsStream(
    @Res() res: Response,
    @Query('exchange') exchange?: string,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const jobId = randomUUID();
    const key = `falcon:sync:job:${jobId}`;
    const write = (data: any) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };
    write({ event: 'started', jobId, exchange: exchange || 'all', ts: Date.now() });
    setImmediate(async () => {
      try {
        await this.redis.set(key, { status: 'started', ts: Date.now() }, 3600);
      } catch {}
      try {
        const summary = await this.falconInstruments.syncFalconInstruments(exchange, undefined, async (p) => {
          write({ event: 'progress', ...p, ts: Date.now() });
          try {
            await this.redis.set(key, { status: 'running', progress: p, ts: Date.now() }, 3600);
          } catch {}
        });
        write({ event: 'completed', summary, ts: Date.now() });
        try {
          await this.redis.set(key, { status: 'completed', summary, ts: Date.now() }, 3600);
        } catch {}
      } catch (e: any) {
        write({ event: 'error', message: e?.message || 'unknown', ts: Date.now() });
        try {
          await this.redis.set(key, { status: 'failed', error: e?.message || 'unknown', ts: Date.now() }, 3600);
        } catch {}
      } finally {
        try {
          res.end();
        } catch {}
      }
    });
  }

  @Get('instruments/sync/status')
  async syncStatus(@Query('jobId') jobId?: string) {
    if (!jobId) {
      throw new HttpException({ success: false, message: 'jobId is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const key = `falcon:sync:job:${jobId}`;
      const v = await this.redis.get<any>(key);
      return { success: true, jobId, status: v || null };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to read sync status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ltp')
  async ltp(@Body() body: { instruments: number[] }) {
    try {
      const tokens = (body?.instruments || []).map((t) => String(t));
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'instruments array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.falconAdapter.getLTP(tokens);
      return { success: true, data: ltp, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon LTP failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('ltp')
  async getLtp(@Query('tokens') tokensRaw?: string) {
    try {
      const tokens = String(tokensRaw || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens query is required (comma-separated numeric tokens)' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.falconAdapter.getLTP(tokens);
      return { success: true, data: ltp, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon LTP failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/batch')
  async batch(@Body() body: { tokens: number[] }) {
    try {
      const tokens = Array.isArray(body?.tokens) ? body.tokens.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const data = await this.falconInstruments.getFalconInstrumentsBatch(tokens);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon batch failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('validate-instruments')
  async validate(@Body() body: { limit?: number; offset?: number; batchSize?: number; dry_run?: boolean; auto_cleanup?: boolean }) {
    try {
      const result = await this.falconInstruments.validateFalconInstruments({
        limit: body?.limit,
        offset: body?.offset,
        batchSize: body?.batchSize,
        dry_run: body?.dry_run,
        auto_cleanup: body?.auto_cleanup,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon validate failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}


