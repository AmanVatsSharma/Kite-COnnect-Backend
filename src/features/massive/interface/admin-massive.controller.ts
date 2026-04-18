/**
 * @file admin-massive.controller.ts
 * @module massive
 * @description Admin endpoints for triggering Massive instrument sync and inspecting sync state.
 * @author BharatERP
 * @created 2026-04-19
 * @updated 2026-04-19
 */
import {
  Controller,
  Post,
  Get,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, ILike } from 'typeorm';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { MassiveInstrumentSyncService } from '../application/massive-instrument-sync.service';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { MassiveInstrument } from '../domain/massive-instrument.entity';

@Controller('admin/massive/instruments')
@ApiTags('admin-massive')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
export class AdminMassiveController {
  constructor(
    private readonly syncService: MassiveInstrumentSyncService,
    private readonly registry: InstrumentRegistryService,
    @InjectRepository(MassiveInstrument)
    private readonly massiveRepo: Repository<MassiveInstrument>,
  ) {}

  @Post('sync')
  @ApiOperation({ summary: 'Trigger Massive instrument sync (one market or all)' })
  async triggerSync(@Body() body: { market?: string } = {}) {
    const results = await this.syncService.syncMassiveInstruments(body.market);
    return { success: true, results };
  }

  @Get('sync/status')
  @ApiOperation({ summary: 'Get last Massive instrument sync result and timestamp' })
  getSyncStatus() {
    return { success: true, ...this.syncService.getSyncStatus() };
  }

  @Get()
  @ApiOperation({ summary: 'Paginated list of synced Massive instruments' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  @ApiQuery({ name: 'market', required: false, example: 'stocks' })
  @ApiQuery({ name: 'search', required: false, example: 'AAPL' })
  @ApiQuery({ name: 'activeOnly', required: false, example: 'true' })
  async list(
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('market') market?: string,
    @Query('search') search?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw || '1') || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeRaw || '50') || 50));

    const where: Record<string, any> = {};
    if (market) where.market = market.toLowerCase();
    if (activeOnly !== 'false') where.is_active = true;
    if (search) where.ticker = ILike(`%${search.toUpperCase()}%`);

    const [rows, total] = await this.massiveRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { market: 'ASC', ticker: 'ASC' },
    });

    return {
      success: true,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      data: rows,
    };
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Resolve a Massive ticker to its UIR ID and canonical symbol' })
  @ApiQuery({ name: 'ticker', required: true, example: 'AAPL' })
  async resolve(@Query('ticker') ticker?: string) {
    if (!ticker) throw new BadRequestException('ticker query param is required');

    const instrument = await this.massiveRepo.findOne({
      where: { ticker: ticker.toUpperCase() },
    });

    const exchange = instrument
      ? { stocks: 'US', forex: 'FX', crypto: 'CRYPTO', indices: 'IDX', options: 'US' }[instrument.market] ??
        instrument.market.toUpperCase()
      : 'US';

    const canonicalSymbol = `${exchange}:${ticker.toUpperCase()}`;
    const cross = this.registry.resolveCrossProvider(canonicalSymbol);

    return {
      success: true,
      ticker: ticker.toUpperCase(),
      canonical_symbol: canonicalSymbol,
      uir_id: cross.uirId ?? null,
      massiveToken: cross.massiveToken ?? null,
      kiteToken: cross.kiteToken ?? null,
      vortexToken: cross.vortexToken ?? null,
      found: cross.uirId != null,
      instrument: instrument ?? null,
    };
  }
}
