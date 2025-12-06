import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { VortexInstrumentService } from '../../../services/vortex-instrument.service';
import { StockService } from '../stock.service';
import { RequestBatchingService } from '../../../services/request-batching.service';
import { VortexProviderService } from '../../../providers/vortex-provider.service';
import { RedisService } from '../../../services/redis.service';
import { MetricsService } from '../../../services/metrics.service';
import { VortexValidationCronService } from '../../../services/vortex-validation.cron';
import { BatchTokensDto } from '../dto/batch-tokens.dto';
import { ValidateInstrumentsDto } from '../dto/validate-instruments.dto';
import { ClearCacheDto } from '../dto/clear-cache.dto';

@Injectable()
export class VayuManagementService {
  private readonly logger = new Logger(VayuManagementService.name);

  constructor(
    private readonly stockService: StockService,
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly vortexProvider: VortexProviderService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly redisService: RedisService,
    private readonly metrics: MetricsService,
    private readonly vortexValidationCronService: VortexValidationCronService,
  ) {}

  async syncInstruments(
    exchange?: string,
    provider?: 'kite' | 'vortex',
    csvUrl?: string,
    reqHeaders?: any,
    apiKey?: string,
  ) {
    try {
      const result = await this.stockService.syncInstruments(exchange, {
        provider,
        csv_url: csvUrl,
        headers: reqHeaders,
        apiKey: apiKey,
      });
      return {
        success: true,
        message: 'Instruments synced successfully',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to sync instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexInstruments(
    exchange?: string,
    instrument_name?: string,
    symbol?: string,
    option_type?: string,
    is_active?: boolean,
    limit?: number,
    offset?: number,
  ) {
    try {
      const result = await this.vortexInstrumentService.getVortexInstruments({
        exchange,
        instrument_name,
        symbol,
        option_type,
        is_active,
        limit: limit ? parseInt(limit.toString()) : 50,
        offset: offset ? parseInt(offset.toString()) : 0,
      });
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get Vortex instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexInstrumentsBatch(
    body: BatchTokensDto,
    ltpOnlyRaw?: string | boolean,
  ) {
    try {
      if (
        !body.tokens ||
        !Array.isArray(body.tokens) ||
        body.tokens.length === 0
      ) {
        throw new HttpException(
          { success: false, message: 'Tokens array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (body.tokens.length > 100) {
        throw new HttpException(
          { success: false, message: 'Maximum 100 tokens allowed' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result =
        await this.vortexInstrumentService.getVortexInstrumentsBatch(
          body.tokens,
        );

      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;

      // Build and optionally filter entries by LTP
      const entries = Object.entries(result.instruments).map(
        ([token, instrument]) =>
          [
            token,
            {
              token: instrument.token,
              symbol: instrument.symbol,
              exchange: instrument.exchange,
              instrument_name: instrument.instrument_name,
              expiry_date: instrument.expiry_date,
              option_type: instrument.option_type,
              strike_price: instrument.strike_price,
              tick: instrument.tick,
              lot_size: instrument.lot_size,
              last_price: result.ltp?.[instrument.token]?.last_price ?? null,
            },
          ] as const,
      );
      const filteredEntries = ltpOnly
        ? entries.filter(
            ([, v]) =>
              Number.isFinite((v as any)?.last_price) &&
              ((v as any)?.last_price ?? 0) > 0,
          )
        : entries;

      return {
        success: true,
        data: {
          instruments: Object.fromEntries(filteredEntries),
          ltp: result.ltp,
          performance: {
            queryTime: result.queryTime,
          },
          ltp_only: ltpOnly || false,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get batch instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexInstrumentStats() {
    try {
      const stats = await this.vortexInstrumentService.getVortexInstrumentStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get Vortex instrument stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexInstrumentByToken(token: number) {
    try {
      const { instrument, ltp } =
        await this.vortexInstrumentService.getVortexInstrumentByTokenCached(
          token,
        );

      if (!instrument) {
        throw new HttpException(
          {
            success: false,
            message: 'Instrument not found or inactive',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: {
          ...instrument,
          last_price: ltp?.last_price ?? null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexPopularInstruments(limit?: number) {
    try {
      const result =
        await this.vortexInstrumentService.getVortexPopularInstrumentsCached(
          limit,
        );
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get popular instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexCachedStats() {
    try {
      const result =
        await this.vortexInstrumentService.getVortexInstrumentStatsCached();
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get cached stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async clearVortexCache(body: ClearCacheDto) {
    try {
      await this.vortexInstrumentService.clearVortexCache(body.pattern);
      return {
        success: true,
        message: 'Cache cleared successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to clear cache',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateInstruments(body: ValidateInstrumentsDto) {
    try {
      this.logger.log('Starting instrument validation', body);
      const result =
        await this.vortexInstrumentService.validateAndCleanupInstruments(
          body,
          this.vortexProvider,
        );
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Validation failed',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateInstrumentsExport(body: ValidateInstrumentsDto) {
    try {
      // For export, force return invalid list and dry run
      const filters = { ...body, dry_run: true, include_invalid_list: true };
      const result =
        await this.vortexInstrumentService.validateAndCleanupInstruments(
          filters,
          this.vortexProvider,
        );

      // Transform to CSV-friendly flat structure
      const rows = result.invalid_instruments.map((i) => ({
        token: i.token,
        exchange: i.exchange,
        symbol: i.symbol,
        reason: i.reason,
        desc: i.description,
      }));

      return {
        success: true,
        summary: result.summary,
        rows,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Export failed', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateInstrumentsStream(body: ValidateInstrumentsDto, res: any) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result =
        await this.vortexInstrumentService.validateAndCleanupInstruments(
          body,
          this.vortexProvider,
          (progress) => send(progress),
        );
      send({ event: 'result', result });
      res.end();
    } catch (error) {
      send({ event: 'error', error: error.message });
      res.end();
    }
  }

  async getValidationStatus() {
    return this.vortexValidationCronService.getStatus();
  }

  async deleteInactiveInstruments() {
    try {
      const count =
        await this.vortexInstrumentService.deleteInactiveInstruments();
      return {
        success: true,
        message: `Deleted ${count} inactive instruments`,
        count,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to delete inactive instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

