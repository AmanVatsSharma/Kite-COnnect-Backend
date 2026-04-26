/**
 * @file admin-binance.controller.ts
 * @module binance
 * @description Admin endpoints for triggering Binance instrument sync, inspecting sync state,
 *   listing synced spot pairs, and resolving a symbol to its UIR id.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { BinanceInstrument } from '../domain/binance-instrument.entity';
import { BinanceInstrumentSyncService } from '../application/binance-instrument-sync.service';
import { BinanceProviderService } from '../infra/binance-provider.service';
import { BINANCE_CANONICAL_EXCHANGE } from '../binance.constants';

@Controller('admin/binance')
@ApiTags('admin-binance')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
export class AdminBinanceController {
  constructor(
    private readonly syncService: BinanceInstrumentSyncService,
    private readonly registry: InstrumentRegistryService,
    private readonly provider: BinanceProviderService,
    @InjectRepository(BinanceInstrument)
    private readonly binanceRepo: Repository<BinanceInstrument>,
  ) {}

  @Post('instruments/sync')
  @ApiOperation({ summary: 'Trigger Binance Spot instrument sync from /api/v3/exchangeInfo' })
  async triggerSync() {
    const result = await this.syncService.syncBinanceInstruments();
    return { success: !result.error, result };
  }

  @Get('instruments/sync/status')
  @ApiOperation({ summary: 'Get last Binance instrument sync result and timestamp' })
  getSyncStatus() {
    return { success: true, ...this.syncService.getSyncStatus() };
  }

  @Get('status')
  @ApiOperation({ summary: 'Provider runtime status: WS connection, subscriptions, shard health' })
  status() {
    const shards = this.provider.getShardStatus();
    return {
      success: true,
      provider: 'binance',
      degraded: this.provider.isDegraded(),
      subscriptionLimit: this.provider.getSubscriptionLimit(),
      shards,
    };
  }

  @Get('instruments')
  @ApiOperation({ summary: 'Paginated list of synced Binance Spot instruments' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  @ApiQuery({ name: 'quote', required: false, example: 'USDT' })
  @ApiQuery({ name: 'search', required: false, example: 'BTC' })
  @ApiQuery({ name: 'activeOnly', required: false, example: 'true' })
  async list(
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('quote') quote?: string,
    @Query('search') search?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw || '1') || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeRaw || '50') || 50));

    const where: Record<string, any> = {};
    if (quote) where.quote_asset = quote.toUpperCase();
    if (activeOnly !== 'false') where.is_active = true;
    if (search) where.symbol = ILike(`%${search.toUpperCase()}%`);

    const [rows, total] = await this.binanceRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { quote_asset: 'ASC', symbol: 'ASC' },
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

  @Get('instruments/resolve')
  @ApiOperation({ summary: 'Resolve a Binance symbol (e.g. BTCUSDT) to its UIR id and canonical symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'BTCUSDT' })
  async resolve(@Query('symbol') symbol?: string) {
    if (!symbol) throw new BadRequestException('symbol query param is required');
    const sym = symbol.toUpperCase();

    const instrument = await this.binanceRepo.findOne({ where: { symbol: sym } });
    const canonical = `${BINANCE_CANONICAL_EXCHANGE}:${sym}`;
    const cross = this.registry.resolveCrossProvider(canonical);

    return {
      success: true,
      symbol: sym,
      canonical_symbol: canonical,
      uir_id: cross.uirId ?? null,
      found: cross.uirId != null,
      kiteToken: cross.kiteToken ?? null,
      vortexToken: cross.vortexToken ?? null,
      massiveToken: cross.massiveToken ?? null,
      instrument: instrument ?? null,
    };
  }
}
