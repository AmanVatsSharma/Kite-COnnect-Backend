/**
 * @file admin-instruments.controller.ts
 * @module admin
 * @description Admin endpoints for Universal Instrument Registry (UIR) inspection, resolution, and refresh.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */

import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';

@Controller('admin/instruments/uir')
@ApiTags('admin-uir')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
export class AdminInstrumentsController {
  constructor(
    private readonly registry: InstrumentRegistryService,
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Paginated UIR instrument list with provider token coverage' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  @ApiQuery({ name: 'type', required: false, example: 'EQ' })
  async listUir(
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('type') type?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw || '1') || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeRaw || '50') || 50));

    const qb = this.uirRepo.createQueryBuilder('u').where('u.is_active = :active', { active: true });
    if (exchange) qb.andWhere('u.exchange = :exchange', { exchange: exchange.toUpperCase() });
    if (type) qb.andWhere('u.instrument_type = :type', { type: type.toUpperCase() });

    const [rows, total] = await qb
      .orderBy('u.canonical_symbol', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const data = rows.map((row) => {
      const uirId = Number(row.id);
      const cross = this.registry.resolveCrossProvider(row.canonical_symbol);
      return {
        uir_id: uirId,
        canonical_symbol: row.canonical_symbol,
        exchange: row.exchange,
        instrument_type: row.instrument_type,
        expiry: row.expiry,
        strike: row.strike,
        option_type: row.option_type,
        name: row.name,
        kiteToken: cross.kiteToken ?? null,
        vortexToken: cross.vortexToken ?? null,
        massiveToken: cross.massiveToken ?? null,
        binanceToken: cross.binanceToken ?? null,
        hasKite: cross.kiteToken != null,
        hasVortex: cross.vortexToken != null,
        hasMassive: cross.massiveToken != null,
        hasBinance: cross.binanceToken != null,
      };
    });

    return {
      success: true,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      data,
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'UIR registry stats and provider coverage breakdown' })
  async stats() {
    const registryStats = this.registry.getStats();
    return {
      success: true,
      registryStats,
      coverage: registryStats.coverage,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Resolve a canonical symbol to its UIR ID and provider tokens' })
  @ApiQuery({ name: 'symbol', required: true, example: 'NSE:RELIANCE' })
  async resolve(@Query('symbol') symbol?: string) {
    if (!symbol) throw new BadRequestException('symbol query param is required');
    const cross = this.registry.resolveCrossProvider(symbol);
    return {
      success: true,
      canonical: symbol,
      uirId: cross.uirId ?? null,
      kiteToken: cross.kiteToken ?? null,
      vortexToken: cross.vortexToken ?? null,
      massiveToken: cross.massiveToken ?? null,
      binanceToken: cross.binanceToken ?? null,
      found: cross.uirId != null,
    };
  }

  @Get('unmapped')
  @ApiOperation({ summary: 'Paginated list of instrument mappings with no UIR link' })
  @ApiQuery({ name: 'provider', required: false, example: 'kite' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  async unmapped(
    @Query('provider') provider?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const page = Math.max(1, parseInt(pageRaw || '1') || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeRaw || '50') || 50));

    const where: Record<string, any> = { uir_id: IsNull() };
    if (provider) where['provider'] = provider.toLowerCase();

    const [rows, total] = await this.mappingRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { provider: 'ASC', provider_token: 'ASC' },
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

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh the in-memory UIR registry from the database' })
  async refresh() {
    await this.registry.refresh();
    const registryStats = this.registry.getStats();
    return {
      success: true,
      registryStats,
      coverage: registryStats.coverage,
      timestamp: new Date().toISOString(),
    };
  }
}
