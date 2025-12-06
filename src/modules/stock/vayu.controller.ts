import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Body,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiBody,
  ApiProduces,
  ApiSecurity,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../../guards/api-key.guard';
import { BatchTokensDto } from './dto/batch-tokens.dto';
import { ValidateInstrumentsDto } from './dto/validate-instruments.dto';
import { LtpRequestDto } from './dto/ltp.dto';
import { ClearCacheDto } from './dto/clear-cache.dto';
import { VayuEquityService } from './services/vayu-equity.service';
import { VayuFutureService } from './services/vayu-future.service';
import { VayuOptionService } from './services/vayu-option.service';
import { VayuSearchService } from './services/vayu-search.service';
import { VayuManagementService } from './services/vayu-management.service';
import { VayuMarketDataService } from './services/vayu-market-data.service';

@ApiTags('vayu')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('stock/vayu')
export class VayuController {
  constructor(
    private readonly vayuEquityService: VayuEquityService,
    private readonly vayuFutureService: VayuFutureService,
    private readonly vayuOptionService: VayuOptionService,
    private readonly vayuSearchService: VayuSearchService,
    private readonly vayuManagementService: VayuManagementService,
    private readonly vayuMarketDataService: VayuMarketDataService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Vayu provider health and debug status' })
  async getVayuHealth() {
    return this.vayuMarketDataService.getVortexHealth();
  }

  @Get('debug/resolve')
  @ApiOperation({
    summary: 'Resolve exchanges for tokens with source attribution',
  })
  @ApiQuery({ name: 'tokens', required: true, example: '738561,135938' })
  async debugResolve(@Query('tokens') tokens?: string) {
    return this.vayuMarketDataService.debugResolve(tokens);
  }

  @Get('debug/build-q')
  @ApiOperation({ summary: 'Build Vortex quotes query for tokens (debug)' })
  @ApiQuery({ name: 'tokens', required: true, example: '738561,135938' })
  @ApiQuery({
    name: 'mode',
    required: false,
    example: 'ltp',
    description: 'ltp|ohlc|full',
  })
  async debugBuildQ(
    @Query('tokens') tokens?: string,
    @Query('mode') mode?: 'ltp' | 'ohlc' | 'full',
  ) {
    return this.vayuMarketDataService.debugBuildQ(tokens, mode);
  }

  @Get('debug/batch-stats')
  @ApiOperation({ summary: 'Get internal batching stats' })
  async getBatchStats() {
    return this.vayuMarketDataService.debugBatchStats();
  }

  @Get('ltp')
  @ApiOperation({
    summary: 'Get Vayu LTP by EXCHANGE-TOKEN (q param)',
    description:
      'Fetches Last Traded Price (LTP) for one or more instruments using EXCHANGE-TOKEN format (e.g., NSE_EQ-22). Returns a map keyed by input pairs with enriched instrument metadata.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    example: 'NSE_EQ-22,NSE_FO-135938',
    description: 'Comma-separated list of EXCHANGE-TOKEN pairs',
  })
  async getVayuLtp(@Query('q') q: string) {
    return this.vayuMarketDataService.getVortexLtp({} as any, q);
  }

  @Post('ltp')
  @ApiOperation({
    summary: 'Get Vayu LTP with enriched instrument data',
    description:
      'Fetches Last Traded Price (LTP) for instruments. Supports two modes: 1) instruments array (token-keyed response), 2) pairs array (exchange-token keyed response). Response includes enriched instrument metadata (description, symbol, exchange, etc.) along with LTP data.',
  })
  @ApiBody({ type: LtpRequestDto })
  async postVayuLtp(@Body() body: LtpRequestDto) {
    return this.vayuMarketDataService.getVortexLtp(body);
  }

  @Post('validate-instruments')
  @ApiOperation({
    summary: 'Validate instruments and cleanup invalid ones',
    description:
      'Checks LTP availability for instruments. If auto_cleanup=true and dry_run=false, deactivates instruments that fail validation.',
  })
  @ApiBody({ type: ValidateInstrumentsDto })
  async validateInstruments(@Body() body: ValidateInstrumentsDto) {
    return this.vayuManagementService.validateInstruments(body);
  }

  @Post('validate-instruments/export')
  @ApiOperation({ summary: 'Export invalid instruments as CSV' })
  async validateInstrumentsExport(
    @Body() body: ValidateInstrumentsDto,
    @Request() req?: any,
  ) {
    const result = await this.vayuManagementService.validateInstrumentsExport(
      body,
    );
    const csv =
      'token,exchange,symbol,instrument_name,reason,desc\n' +
      result.rows
        .map((x) =>
          [
            x.token,
            x.exchange || '',
            x.symbol || '',
            x.reason || '',
            x.desc || '',
          ].join(','),
        )
        .join('\n');
    (req?.res || (req as any).res)?.setHeader?.('Content-Type', 'text/csv');
    (req?.res || (req as any).res)?.setHeader?.(
      'Content-Disposition',
      'attachment; filename="invalid_instruments.csv"',
    );
    return csv;
  }

  @Post('validate-instruments/stream')
  @ApiOperation({
    summary: 'Stream live status for Vayu validation/cleanup (SSE)',
    description:
      'Streams JSON events per batch. Emits: { event, total_instruments, batch_index, batches, valid_so_far, invalid_so_far, indeterminate_so_far }',
  })
  @ApiProduces('text/event-stream')
  @ApiBody({ type: ValidateInstrumentsDto })
  async streamValidateVortexInstruments(
    @Body() body: ValidateInstrumentsDto,
    @Res() res?: any,
  ) {
    return this.vayuManagementService.validateInstrumentsStream(body, res);
  }

  @Get('validate-instruments/status')
  @ApiOperation({ summary: 'Poll Vayu validation/cleanup status' })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'jobId', required: true })
  async getValidationStatus(@Query('jobId') jobId: string) {
    return this.vayuManagementService.getValidationStatus(jobId);
  }

  @Get('instruments')
  @ApiOperation({
    summary: 'Get Vayu instruments with filters and pagination',
  })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_name', required: false, example: 'EQ' })
  @ApiQuery({ name: 'symbol', required: false, example: 'RELIANCE' })
  @ApiQuery({
    name: 'option_type',
    required: false,
    example: 'CE',
    description: 'CE, PE, or null (for non-options)',
  })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_name') instrumentName?: string,
    @Query('symbol') symbol?: string,
    @Query('option_type') optionType?: string,
    @Query('is_active') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.vayuManagementService.getVortexInstruments(
      exchange,
      instrumentName,
      symbol,
      optionType,
      isActive,
      limit,
      offset,
    );
  }

  @Get('instruments/search')
  @ApiOperation({
    summary: 'Search Vayu instruments with advanced filters',
    description:
      'Search instruments by name/symbol with optional filters for exchange, type, validity, and LTP enrichment.',
  })
  @ApiQuery({ name: 'q', required: true, example: 'RELIANCE' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_type', required: false, example: 'EQUITIES' })
  @ApiQuery({ name: 'symbol', required: false, description: 'Exact symbol match' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({
    name: 'include_ltp',
    required: false,
    example: true,
    description:
      'If true (default), enrich each instrument with LTP using Vortex quotes (mode=ltp)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description: 'If true, only instruments with a valid last_price are returned',
  })
  async searchVortexInstruments(
    @Query('q') q: string,
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrumentType?: string,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('include_ltp') includeLtpRaw?: string | boolean,
  ) {
    return this.vayuSearchService.searchVortexInstruments(
      q,
      exchange,
      instrumentType,
      symbol,
      limit,
      offset,
      ltpOnlyRaw,
      includeLtpRaw,
    );
  }

  @Get('instruments/stats')
  @ApiOperation({ summary: 'Get Vayu instrument statistics' })
  async getVortexInstrumentStats() {
    return this.vayuManagementService.getVortexInstrumentStats();
  }

  @Get('instruments/cached-stats')
  @ApiOperation({ summary: 'Get cached Vayu instrument statistics (faster)' })
  async getVortexCachedStats() {
    return this.vayuManagementService.getVortexCachedStats();
  }

  @Get('instruments/:token')
  @ApiOperation({ summary: 'Get specific Vayu instrument by token' })
  @ApiResponse({ status: 200, description: 'Vayu instrument found' })
  @ApiResponse({ status: 404, description: 'Vayu instrument not found' })
  async getVortexInstrumentByToken(@Param('token') token: string) {
    try {
      const tokenNumber = parseInt(token);
      return this.vayuManagementService.getVortexInstrumentByToken(tokenNumber);
    } catch (error) {
      // Let service handle it or rethrow
      throw error;
    }
  }

  @Post('instruments/sync')
  @ApiOperation({
    summary: 'Start Vayu (Vortex) instruments sync (supports async polling)',
    description:
      'If async=true, starts a background sync job and returns jobId. Poll progress via GET /api/stock/vayu/instruments/sync/status?jobId=... Otherwise runs sync inline and returns summary.',
  })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({
    name: 'csv_url',
    required: false,
    description: 'Optional CSV URL override',
  })
  @ApiQuery({
    name: 'async',
    required: false,
    example: true,
    description: 'Run in background and poll status',
  })
  async syncVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
    @Query('async') asyncRaw?: string | boolean,
  ) {
    return this.vayuManagementService.startVayuSync(
      exchange,
      csvUrl,
      asyncRaw,
    );
  }

  @Post('instruments/sync/start')
  @ApiOperation({
    summary: 'Start Vayu (Vortex) instruments sync (always async)',
    description:
      'Starts a background sync job and immediately returns a jobId to poll or monitor.',
  })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({
    name: 'csv_url',
    required: false,
    description: 'Optional CSV URL override',
  })
  async startVayuSyncAlwaysAsync(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
  ) {
    return this.vayuManagementService.startVayuSyncAlwaysAsync(
      exchange,
      csvUrl,
    );
  }

  @Get('instruments/sync/status')
  @ApiOperation({ summary: 'Poll Vayu (Vortex) sync status' })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'jobId', required: true })
  async getVayuSyncStatus(@Query('jobId') jobId: string) {
    return this.vayuManagementService.getVayuSyncStatus(jobId);
  }

  @Post('instruments/sync/stream')
  @ApiOperation({
    summary: 'Stream live status while syncing Vayu (Vortex) instruments (SSE)',
    description:
      'Streams JSON events with progress of CSV fetch and upsert. Emits fields: { phase, total, processed, synced, updated, errors, lastMessage }.',
  })
  @ApiProduces('text/event-stream')
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({
    name: 'csv_url',
    required: false,
    description: 'Optional CSV URL override',
  })
  async streamVayuSync(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
    @Res() res?: any,
  ) {
    return this.vayuManagementService.streamVayuSync(exchange, csvUrl, res);
  }

  @Delete('instruments')
  @ApiOperation({ summary: 'Permanently delete Vayu instruments by filter' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_name', required: false, example: 'EQ' })
  @ApiQuery({
    name: 'instrument_type',
    required: false,
    example: 'EQUITIES',
    description:
      'High-level type (EQUITIES, FUTURES, OPTIONS, COMMODITIES, CURRENCY)',
  })
  async deleteVayuInstrumentsByFilter(
    @Query('exchange') exchange?: string,
    @Query('instrument_name') instrument_name?: string,
    @Query('instrument_type') instrument_type?: string,
  ) {
    return this.vayuManagementService.deleteVayuInstrumentsByFilter(
      exchange,
      instrument_name,
      instrument_type,
    );
  }

  @Get('options/chain/:symbol')
  @ApiOperation({ summary: 'Get options chain for a symbol' })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only options with valid last_price are returned',
  })
  async getVortexOptionsChain(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuOptionService.getVortexOptionsChain(symbol, ltpOnlyRaw);
  }

  @Post('instruments/batch')
  @ApiOperation({ summary: 'Batch lookup for multiple Vayu instruments' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tokens: {
          type: 'array',
          items: { type: 'number' },
          maxItems: 100,
          description: 'Array of instrument tokens (max 100)',
        },
      },
      required: ['tokens'],
    },
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  async getVortexInstrumentsBatch(
    @Body() body: BatchTokensDto,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuManagementService.getVortexInstrumentsBatch(
      body,
      ltpOnlyRaw,
    );
  }

  @Get('equities')
  @ApiOperation({ summary: 'Get Vayu equities with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Exchange filter',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  async getVortexEquities(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuEquityService.getVortexEquities(
      q,
      exchange,
      limit,
      offset,
      ltpOnlyRaw,
    );
  }

  @Get('futures')
  @ApiOperation({
    summary:
      'Get Vayu futures (FUTSTK, FUTIDX) with filters and smart sorting',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Search query' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_FO' })
  @ApiQuery({ name: 'expiry_from', required: false, example: '20250101' })
  @ApiQuery({ name: 'expiry_to', required: false, example: '20250331' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'expiry', 'strike'],
    description: 'Sort strategy',
  })
  async getVortexFutures(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiryFrom?: string,
    @Query('expiry_to') expiryTo?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('sort') sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    return this.vayuFutureService.getVortexFutures(
      q,
      exchange,
      expiryFrom,
      expiryTo,
      limit,
      offset,
      ltpOnlyRaw,
      sort,
    );
  }

  @Get('options')
  @ApiOperation({ summary: 'Get Vayu options (OPTSTK, OPTIDX) with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Search query' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_FO' })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({ name: 'expiry_from', required: false, example: '20250101' })
  @ApiQuery({ name: 'expiry_to', required: false, example: '20250331' })
  @ApiQuery({ name: 'strike_min', required: false, type: Number })
  @ApiQuery({ name: 'strike_max', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'expiry', 'strike'],
    description: 'Sort strategy',
  })
  async getVortexOptions(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('option_type') optionType?: 'CE' | 'PE',
    @Query('expiry_from') expiryFrom?: string,
    @Query('expiry_to') expiryTo?: string,
    @Query('strike_min') strikeMin?: number,
    @Query('strike_max') strikeMax?: number,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('sort') sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    return this.vayuOptionService.getVortexOptions(
      q,
      exchange,
      optionType,
      expiryFrom,
      expiryTo,
      strikeMin,
      strikeMax,
      limit,
      offset,
      ltpOnlyRaw,
      sort,
    );
  }

  @Get('mcx-options')
  @ApiOperation({ summary: 'Get Vayu MCX options with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Search query' })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({ name: 'expiry_from', required: false, example: '20250101' })
  @ApiQuery({ name: 'expiry_to', required: false, example: '20250331' })
  @ApiQuery({ name: 'strike_min', required: false, type: Number })
  @ApiQuery({ name: 'strike_max', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  async getVortexMcxOptions(
    @Query('q') q?: string,
    @Query('option_type') optionType?: 'CE' | 'PE',
    @Query('expiry_from') expiryFrom?: string,
    @Query('expiry_to') expiryTo?: string,
    @Query('strike_min') strikeMin?: number,
    @Query('strike_max') strikeMax?: number,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuOptionService.getVortexMcxOptions(
      q,
      optionType,
      expiryFrom,
      expiryTo,
      strikeMin,
      strikeMax,
      limit,
      offset,
      ltpOnlyRaw,
    );
  }

  @Get('fno/autocomplete')
  @ApiOperation({
    summary: 'Autocomplete for F&O underlying symbols (Vayu)',
    description:
      'Returns matching underlying symbols for F&O. Only includes symbols that have active derivatives.',
  })
  @ApiQuery({ name: 'q', required: true, example: 'NIF' })
  @ApiQuery({ name: 'scope', required: false, enum: ['nse', 'mcx', 'all'] })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  async getVortexAutocomplete(
    @Query('q') q: string,
    @Query('scope') scope?: 'nse' | 'mcx' | 'all',
    @Query('limit') limit?: number,
  ) {
    return this.vayuSearchService.autocompleteFo(q, scope, limit);
  }

  @Get('underlyings/:symbol/futures')
  @ApiOperation({
    summary: 'Get all futures for a specific underlying',
    description:
      'Returns all futures contracts for the given underlying symbol, grouped by expiry.',
  })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_FO' })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only contracts with valid last_price are returned',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getUnderlyingFutures(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('limit') limitRaw?: number,
    @Query('offset') offsetRaw?: number,
  ) {
    return this.vayuFutureService.getUnderlyingFutures(
      symbol,
      exchange,
      limitRaw,
      offsetRaw,
      ltpOnlyRaw,
    );
  }

  @Get('underlyings/:symbol/options')
  @ApiOperation({
    summary: 'Get all options for a specific underlying',
    description:
      'Returns options chain for the given underlying symbol (alias for options/chain)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only strikes with valid LTP are kept in the chain',
  })
  async getUnderlyingOptions(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuOptionService.getVortexOptionsChain(symbol, ltpOnlyRaw);
  }

  @Get('tickers/search')
  @ApiOperation({
    summary: 'Search Vayu tickers (like Kite search)',
    description:
      'Returns search results matching the query string. Designed for UI search bars.',
  })
  @ApiQuery({ name: 'q', required: true, example: 'RELIANCE' })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description: 'If true, only instruments with a valid last_price are returned',
  })
  @ApiQuery({
    name: 'include_ltp',
    required: false,
    example: true,
    description: 'If true, includes last_price in response',
  })
  async searchVortexTickers(
    @Query('q') q: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('include_ltp') includeLtpRaw?: string | boolean,
  ) {
    return this.vayuSearchService.searchVortexTickers(
      q,
      ltpOnlyRaw,
      includeLtpRaw,
    );
  }

  @Get('tickers/:symbol')
  @ApiOperation({
    summary:
      'Get live price and metadata by Vayu ticker (e.g., NSE_EQ_RELIANCE)',
    description:
      'Fetches complete instrument information including LTP, description, and all metadata for a given Vayu symbol. Supports ltp_only filter to return 404 if LTP is unavailable.',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, returns 404 when LTP is unavailable for the symbol',
  })
  async getVortexTickerBySymbol(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuSearchService.getVortexTickerBySymbol(symbol, ltpOnlyRaw);
  }

  @Get('instruments/popular')
  @ApiOperation({ summary: 'Get popular Vayu instruments' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getVortexPopularInstruments(@Query('limit') limit?: number) {
    return this.vayuManagementService.getVortexPopularInstruments(limit);
  }

  @Delete('instruments/inactive')
  @ApiOperation({
    summary: 'Delete all inactive Vortex instruments',
    description:
      'Permanently deletes all instruments from vortex_instruments table where is_active = false. Use with caution as this operation cannot be undone. Recommended workflow: 1) Use validate-instruments endpoint to identify invalid instruments, 2) Review the results, 3) Use this endpoint to clean up inactive instruments.',
  })
  async deleteInactiveInstruments() {
    return this.vayuManagementService.deleteInactiveInstruments();
  }

  @Post('cache/clear')
  @ApiOperation({ summary: 'Clear Vortex cache' })
  @ApiBody({ type: ClearCacheDto })
  async clearVortexCache(@Body() body: ClearCacheDto) {
    return this.vayuManagementService.clearVortexCache(body);
  }
}

