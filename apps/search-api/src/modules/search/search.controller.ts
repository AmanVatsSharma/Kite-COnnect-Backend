/**
 * @file apps/search-api/src/modules/search/search.controller.ts
 * @module search-api
 * @description REST controller for instrument search, suggest, facets, SSE streaming,
 *              and selection telemetry. All search results are keyed by universal
 *              instrument `id` + `canonicalSymbol`.
 *
 * Exports:
 *   - SearchController — NestJS controller mounted at /api/search
 *
 * Endpoints:
 *   GET  /api/search               — full search with optional LTP hydration
 *   GET  /api/search/suggest       — lightweight autocomplete (smaller limit)
 *   GET  /api/search/filters       — live facet counts (exchange, segment, type, assetClass, streamProvider)
 *   GET  /api/search/schema        — machine-readable filter param docs (no auth needed)
 *   GET  /api/search/popular       — placeholder for trending tickers
 *   POST /api/search/telemetry/selection — synonym learning signal
 *   GET  /api/search/stream        — SSE stream of LTP ticks for given UIR ids
 *
 * Side-effects:
 *   - Writes Redis synonym telemetry keys on POST /telemetry/selection
 *   - Emits SSE ticks until 30s TTL or client disconnect
 *
 * Key invariants:
 *   - Results use `id` (universal_instruments.id) as primary identifier
 *   - Each enriched row carries `priceStatus` ('live' | 'stale') and `wsSubscribeUirId`
 *     (alias of `id`) so frontends can render a clear "subscribe with this id via /ws" hint
 *   - `mode=eq|fno|curr|commodities` maps to `vortexExchange` filter shorthand
 *   - ltp_only=true probes a wider set, then filters to instruments with live prices
 *   - SSE poll uses UIR ids (provider-agnostic) — works for kite/vortex/massive/binance equally
 *   - Default response uses **public brand names** (falcon/vayu/atlas/drift) for
 *     streamProvider; internal token fields (kiteToken/vortexToken/...) are stripped
 *     unless the caller passes ?include=internal with a valid x-admin-token header
 *   - ?fields=symbol,exchange,last_price projects the response shape (allow-list only);
 *     anchor fields (id, canonicalSymbol, wsSubscribeUirId, last_price, priceStatus,
 *     streamProvider) are always returned regardless of ?fields=
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-04
 */

import {
  Controller,
  Get,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  Res,
  Req,
  Headers,
} from '@nestjs/common';
import { Response, Request } from 'express';
import {
  SearchService,
  SearchResultItem,
  StreamProviderName,
  PUBLIC_FIELD_ALLOWLIST,
  PUBLIC_ALWAYS_INCLUDED,
  INTERNAL_ONLY_FIELDS,
} from './search.service';
import {
  normalizeProviderAlias,
  internalToPublicProvider,
  type InternalProviderName,
} from './provider-aliases';

/**
 * Public response shape — internal tokens stripped, streamProvider mapped to public brand.
 * The shape is open-ended (`[k: string]: unknown`) because PUBLIC_FIELD_ALLOWLIST entries
 * are added dynamically from the source row.
 */
type PublicSearchResultItem = {
  id: number;
  canonicalSymbol: string;
  wsSubscribeUirId: number;
  last_price: number | null;
  priceStatus: 'live' | 'stale';
  /** Public brand name: 'falcon' | 'vayu' | 'atlas' | 'drift' (mapped from internal). */
  streamProvider?: 'falcon' | 'vayu' | 'atlas' | 'drift';
  // …plus any fields whitelisted via PUBLIC_FIELD_ALLOWLIST and selected by ?fields=
  [k: string]: unknown;
};

/**
 * Build the final response row. Strips internal token fields by default; includes them
 * (plus the raw _internalProvider name) when `includeInternal` is true (admin-only path).
 */
function buildResponseRow(
  raw: SearchResultItem,
  last_price: number | null,
  selectedFields: ReadonlySet<string> | null,
  includeInternal: boolean,
): PublicSearchResultItem {
  const live = Number.isFinite(last_price) && (last_price ?? 0) > 0;

  // Anchor fields — always present regardless of ?fields=
  const out: PublicSearchResultItem = {
    id: raw.id,
    canonicalSymbol: raw.canonicalSymbol,
    wsSubscribeUirId: raw.id,
    last_price,
    priceStatus: live ? 'live' : 'stale',
    streamProvider: raw.streamProvider
      ? internalToPublicProvider(raw.streamProvider)
      : undefined,
  };

  // Public allow-listed fields — included when no ?fields= filter, or when the
  // caller named them. Anchors above are already included unconditionally.
  for (const k of PUBLIC_FIELD_ALLOWLIST) {
    if (selectedFields && !selectedFields.has(k)) continue;
    const v = (raw as any)[k];
    if (v !== undefined) (out as any)[k] = v;
  }

  // Internal fields — only when admin opts in. The admin dashboard uses these
  // to show the "VIA" badge with the real provider name and copy raw tokens.
  if (includeInternal) {
    out._internalProvider = raw.streamProvider;
    if (raw.kiteToken !== undefined) out.kiteToken = raw.kiteToken;
    if (raw.vortexToken !== undefined) out.vortexToken = raw.vortexToken;
    if (raw.vortexExchange !== undefined) out.vortexExchange = raw.vortexExchange;
    if (raw.massiveToken !== undefined) out.massiveToken = raw.massiveToken;
    if (raw.binanceToken !== undefined) out.binanceToken = raw.binanceToken;
  }

  return out;
}

/**
 * Parse the public ?fields= comma-separated list into a Set, filtered to the allow-list.
 * Returns null when no ?fields= was provided (= "give me everything in the public default").
 * Anchor fields (PUBLIC_ALWAYS_INCLUDED) are not validated here — they're added
 * unconditionally by buildResponseRow.
 */
function parseFieldsParam(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw || !String(raw).trim()) return null;
  const requested = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!requested.length) return null;
  const allow = new Set<string>(PUBLIC_FIELD_ALLOWLIST);
  return new Set(requested.filter((f) => allow.has(f)));
}

/**
 * Build the Meili `attributesToRetrieve` list given the requested public fields.
 * Always pulls anchors + the internal `streamProvider` (needed to map to public brand)
 * and, when `includeInternal` is true, the internal token fields too.
 *
 * Returning `undefined` when no projection is requested lets the service use its default.
 */
function buildMeiliAttrs(
  selectedFields: ReadonlySet<string> | null,
  includeInternal: boolean,
): string[] | undefined {
  if (!selectedFields && !includeInternal) return undefined;
  const attrs = new Set<string>([
    'id',
    'canonicalSymbol',
    'streamProvider', // needed for brand mapping even if client didn't request it
  ]);
  if (selectedFields) {
    for (const f of selectedFields) attrs.add(f);
  } else {
    for (const f of PUBLIC_FIELD_ALLOWLIST) attrs.add(f);
  }
  if (includeInternal) {
    for (const f of INTERNAL_ONLY_FIELDS) {
      // _internalProvider is synthetic — derived from streamProvider, not a Meili field
      if (f !== '_internalProvider') attrs.add(f);
    }
  }
  return Array.from(attrs);
}

/**
 * Gate ?include=internal behind the admin token. The search-api shares the same
 * ADMIN_TOKEN env var as the trading-app's admin endpoints, set on both containers
 * via docker-compose. Returning `false` quietly (instead of 403) preserves the
 * default public response — clients without the token simply don't see internals.
 */
function isInternalIncludeAuthorized(
  includeRaw: string | undefined,
  adminTokenHeader: string | undefined,
): boolean {
  if (!includeRaw || String(includeRaw).toLowerCase() !== 'internal') return false;
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return false;
  return String(adminTokenHeader || '').trim() === expected;
}

/** Validate ?streamProvider= input — accept internal canonicals AND public brand names. */
function normalizeStreamProvider(raw?: string): StreamProviderName | undefined {
  return normalizeProviderAlias(raw) ?? undefined;
}

const MODE_TO_VORTEX_EXCHANGE: Record<string, string> = {
  eq: 'NSE_EQ',
  fno: 'NSE_FO',
  curr: 'NSE_CUR',
  commodities: 'MCX_FO',
};

@Controller('search')
export class SearchController {
  private readonly logger = new Logger('SearchController');
  constructor(private readonly searchService: SearchService) {}

  /**
   * GET /api/search
   * Universal instrument search. Supports all filter dimensions.
   *
   * Pass `ltp_only=true` to return only instruments with a live price.
   *
   * Public response shape (default):
   *   - Anchors: id, canonicalSymbol, wsSubscribeUirId, last_price, priceStatus, streamProvider
   *   - Plus all PUBLIC_FIELD_ALLOWLIST fields (symbol, name, exchange, segment, …)
   *
   * `?fields=symbol,exchange,last_price` — narrow the response to just those fields
   *   (anchors are always included). Field names not in the allow-list are silently
   *   dropped. The same allow-list flows into Meili's `attributesToRetrieve` so payload
   *   size shrinks at the source.
   *
   * `?include=internal` (with `x-admin-token`) — adds the internal token fields and
   *   the synthetic `_internalProvider` (raw streamProvider before brand mapping).
   *   Used by the admin dashboard's Search page; rejected silently for non-admin
   *   callers (so they get the public response, not a 403).
   *
   * Streaming brand names (default): `falcon` (kite), `vayu` (vortex), `atlas`
   * (massive), `drift` (binance). Internal names never leak to public callers.
   */
  @Get()
  async search(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('optionType') optionType?: string,
    @Query('assetClass') assetClass?: string,
    @Query('streamProvider') streamProvider?: string,
    @Query('mode') mode?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: string,
    @Query('strike_max') strike_max?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('live') liveRaw?: string | boolean,
    @Query('fields') fieldsRaw?: string,
    @Query('include') includeRaw?: string,
    @Headers('x-admin-token') adminTokenHeader?: string,
  ) {
    if (!q || q.trim().length === 0) {
      throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
    }

    const limit = Math.min(Number(limitRaw || 10), 50);
    const ltpOnly =
      String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true ||
      String(liveRaw || '').toLowerCase() === 'true' || liveRaw === true;
    const modeVe = mode ? MODE_TO_VORTEX_EXCHANGE[String(mode).toLowerCase()] : undefined;

    const includeInternal = isInternalIncludeAuthorized(includeRaw, adminTokenHeader);
    const selectedFields = parseFieldsParam(fieldsRaw);
    const meiliAttrs = buildMeiliAttrs(selectedFields, includeInternal);

    const filters = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      optionType,
      assetClass,
      streamProvider: normalizeStreamProvider(streamProvider),
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };

    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const searchCap = Number(process.env.SEARCH_LTP_ONLY_HYDRATE_CAP || 200);
    const probeLimit = ltpOnly ? Math.min(Math.max(limit * probeMult, limit), searchCap) : limit;

    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters, meiliAttrs);
    const quotes = await this.searchService.hydrateLtpByItems(items.slice(0, probeLimit));

    const enriched = items.map((it) =>
      buildResponseRow(it, quotes?.[String(it.id)]?.last_price ?? null, selectedFields, includeInternal),
    );

    const data = (ltpOnly
      ? enriched.filter((v) => v.priceStatus === 'live')
      : enriched
    ).slice(0, limit);

    this.logger.log(
      `[Search] q="${q}" limit=${limit} probe=${probeLimit} ltp_only=${ltpOnly} ` +
        `fields=${selectedFields ? Array.from(selectedFields).join('|') : '*'} ` +
        `include_internal=${includeInternal} returned=${data.length}`,
    );
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/suggest
   * Lightweight typeahead — smaller default limit, same filter + projection surface.
   * Accepts `?fields=` and `?include=internal` exactly like /api/search.
   */
  @Get('suggest')
  async suggest(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('optionType') optionType?: string,
    @Query('streamProvider') streamProvider?: string,
    @Query('mode') mode?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: string,
    @Query('strike_max') strike_max?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('live') liveRaw?: string | boolean,
    @Query('fields') fieldsRaw?: string,
    @Query('include') includeRaw?: string,
    @Headers('x-admin-token') adminTokenHeader?: string,
  ) {
    const limit = Math.min(Number(limitRaw || 5), 20);
    if (!q || q.trim().length === 0) {
      return { success: true, data: [], timestamp: new Date().toISOString() };
    }

    const ltpOnly =
      String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true ||
      String(liveRaw || '').toLowerCase() === 'true' || liveRaw === true;
    const modeVe = mode ? MODE_TO_VORTEX_EXCHANGE[String(mode).toLowerCase()] : undefined;

    const includeInternal = isInternalIncludeAuthorized(includeRaw, adminTokenHeader);
    const selectedFields = parseFieldsParam(fieldsRaw);
    const meiliAttrs = buildMeiliAttrs(selectedFields, includeInternal);

    const filters = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      optionType,
      streamProvider: normalizeStreamProvider(streamProvider),
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };

    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const suggestCap = Number(process.env.SUGGEST_LTP_ONLY_HYDRATE_CAP || 100);
    const probeLimit = ltpOnly ? Math.min(Math.max(limit * probeMult, limit), suggestCap) : limit;

    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters, meiliAttrs);
    const quotes = await this.searchService.hydrateLtpByItems(items.slice(0, probeLimit));

    const enriched = items.map((it) =>
      buildResponseRow(it, quotes?.[String(it.id)]?.last_price ?? null, selectedFields, includeInternal),
    );

    const data = (ltpOnly
      ? enriched.filter((v) => v.priceStatus === 'live')
      : enriched
    ).slice(0, limit);

    this.logger.log(
      `[Suggest] q="${q}" limit=${limit} ltp_only=${ltpOnly} ` +
        `fields=${selectedFields ? Array.from(selectedFields).join('|') : '*'} ` +
        `include_internal=${includeInternal} returned=${data.length}`,
    );
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/filters
   * Returns facet distributions for building filter UIs (exchange, segment, type, etc.)
   * The `streamProvider` facet values are remapped to public brand names so callers
   * can use the same values directly as `?streamProvider=` filter params.
   */
  @Get('filters')
  async filters(
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('assetClass') assetClass?: string,
  ) {
    const raw = await this.searchService.facetCounts({ exchange, segment, instrumentType, assetClass });
    // Remap internal streamProvider names → public brand names so the filter UI
    // can pass these values directly as ?streamProvider= without translation.
    if (raw.streamProvider) {
      const mapped: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw.streamProvider)) {
        mapped[internalToPublicProvider(k as InternalProviderName)] = v as number;
      }
      raw.streamProvider = mapped;
    }
    return { success: true, data: raw, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/schema
   * Machine-readable description of all available query parameters and their valid values.
   * Intended for frontend filter-UI builders and API integrators so they don't need to
   * read source code to know what filters exist.
   *
   * The `enums` section lists all known discrete values per filterable field.
   * The `facets` hint points to GET /api/search/filters for live per-value counts.
   */
  @Get('schema')
  schema() {
    return {
      success: true,
      data: {
        endpoints: {
          search:   'GET /api/search',
          suggest:  'GET /api/search/suggest',
          filters:  'GET /api/search/filters  — live facet counts per field value',
          schema:   'GET /api/search/schema   — this endpoint',
          stream:   'GET /api/search/stream   — SSE live-price ticker',
        },
        params: {
          q:              { type: 'string',  required: true,  note: 'Ticker symbol, company name, or synonym (e.g. SBI, NIFTY50, Bitcoin)' },
          limit:          { type: 'integer', default: 10, max: 50 },
          exchange:       { type: 'string',  filterable: true,  enums: ['NSE','BSE','NFO','BFO','MCX','CDS','BCD','BINANCE','CRYPTO','US','FX','IDX','GLOBAL','NCO','NSEIX'] },
          segment:        { type: 'string',  filterable: true,  enums: ['NSE','BSE','NFO-FUT','NFO-OPT','BFO-FUT','BFO-OPT','MCX-FUT','MCX-OPT','CDS-FUT','CDS-OPT','NCO','NCO-FUT','NCO-OPT','spot','stocks','crypto','INDICES'] },
          instrumentType: { type: 'string',  filterable: true,  enums: ['EQ','FUT','CE','PE','ETF','IDX','CS','ADRC','ETN','ETS','ETV','FUND','SP','PFD','WARRANT','UNIT','RIGHT'] },
          assetClass:     { type: 'string',  filterable: true,  enums: ['equity','crypto','currency','commodity'], note: 'Top-level asset category; use this for broad filtering (e.g. all crypto)' },
          streamProvider: { type: 'string',  filterable: true,  enums: ['falcon','vayu','atlas','drift'],
                            note: 'Public brand name of the live-data provider. falcon=Indian equity (NSE/BSE), vayu=F&O/currency/commodities, atlas=US stocks/forex, drift=Global crypto Spot' },
          optionType:     { type: 'string',  filterable: true,  enums: ['CE','PE'], note: 'Only relevant for options instruments' },
          isDerivative:   { type: 'boolean', filterable: true,  note: 'true = futures/options; false = equity/spot' },
          mode:           { type: 'string',  note: 'Shorthand for vortexExchange filter. eq=NSE_EQ, fno=NSE_FO, curr=NSE_CUR, commodities=MCX_FO' },
          expiry_from:    { type: 'date',    format: 'YYYY-MM-DD', note: 'Filter derivatives by expiry >= date' },
          expiry_to:      { type: 'date',    format: 'YYYY-MM-DD', note: 'Filter derivatives by expiry <= date' },
          strike_min:     { type: 'number',  note: 'Filter options by strike >= value' },
          strike_max:     { type: 'number',  note: 'Filter options by strike <= value' },
          ltp_only:       { type: 'boolean', default: false, note: 'When true, returns only instruments with a live price right now' },
          live:           { type: 'boolean', default: false, note: 'Alias for ltp_only — ?live=true returns only instruments with a live price' },
          fields:         { type: 'string',  note: 'Comma-separated projection. Always includes: id, canonicalSymbol, wsSubscribeUirId, last_price, priceStatus, streamProvider. Allowed extras: symbol,name,exchange,segment,instrumentType,assetClass,optionType,expiry,strike,lotSize,tickSize,isDerivative,underlyingSymbol' },
        },
        responseFields: {
          id:               'Universal instrument ID — use this to subscribe to live prices via WebSocket',
          wsSubscribeUirId: 'Same as id — convenience alias for WebSocket subscribe payloads',
          canonicalSymbol:  'Human-readable unique key, e.g. NSE:RELIANCE or BINANCE:BTCUSDT',
          last_price:       'Latest known price (null if no live price available)',
          priceStatus:      '"live" = price arrived within cache TTL; "stale" = no recent tick',
          streamProvider:   'Public brand name of the provider streaming this instrument (falcon/vayu/atlas/drift)',
        },
        wsSubscribe: {
          note: 'Subscribe to live prices by passing the instrument id as wsSubscribeUirId',
          example: { event: 'subscribe', data: { instruments: [355010], mode: 'ltp' } },
        },
        filterTip: 'Call GET /api/search/filters to get live counts per value for each filterable field.',
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/search/popular
   * Trending / popular instruments — wired to Redis counters in a future iteration.
   */
  @Get('popular')
  async popular(@Query('limit') limitRaw?: string) {
    const limit = Math.min(Number(limitRaw || 10), 50);
    this.logger.log(`popular requested, limit=${limit}`);
    return { success: true, data: [], timestamp: new Date().toISOString() };
  }

  /**
   * POST /api/search/telemetry/selection
   * Client signals which result was selected. Used to train dynamic synonyms.
   * Body: { q, symbol, universalId? }
   */
  @Post('telemetry/selection')
  async selection(
    @Body() body: { q?: string; symbol?: string; universalId?: number; instrumentToken?: number },
  ) {
    const q = String(body?.q || '').trim();
    const symbol = String(body?.symbol || '').trim();
    const uid = body?.universalId ?? body?.instrumentToken; // accept both for backward compat
    if (!q || !symbol) {
      throw new HttpException({ success: false, message: 'q and symbol are required' }, HttpStatus.BAD_REQUEST);
    }
    await this.searchService.logSelectionTelemetry(q, symbol, Number.isFinite(uid) ? Number(uid) : undefined);
    return { success: true };
  }

  /**
   * GET /api/search/stream
   * SSE stream pushing LTP ticks every ~1s for up to 30s (configurable via SSE_DEFAULT_TTL_MS).
   *
   * Inputs:
   *   ?ids=355010,738561  — comma-separated UIR ids (preferred — provider-agnostic, works for all 4 providers)
   *   ?q=NIFTY            — alternative: auto-resolve top-N matching UIR ids from a search query
   *   ?ltp_only=true      — drop entries with no live price from each tick payload
   *
   * Backwards-compat: ?tokens= is still accepted as an alias for ?ids= since older clients pass that.
   * It used to mean "vortex/kite numeric tokens" but is now treated as UIR ids — which is what those
   * legacy clients passed anyway (the trading-app's /api/stock/universal/ltp expects UIR ids).
   */
  @Get('stream')
  async stream(
    @Res() res: Response,
    @Req() req: Request,
    @Query('ids') idsRaw?: string,
    @Query('tokens') tokensRaw?: string, // legacy alias — see docblock
    @Query('q') q?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const parseIds = (s?: string): number[] =>
      String(s || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

    // Accept both ?ids and the legacy ?tokens. Cap at 100 to bound the per-tick LTP fan-out.
    let ids: number[] = parseIds(idsRaw || tokensRaw).slice(0, 100);
    const ttlMs = Number(process.env.SSE_DEFAULT_TTL_MS || 30_000);
    const started = Date.now();

    const send = (data: any) => {
      res.write(`event: ltp\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const timer = setInterval(async () => {
      try {
        if (Date.now() - started > ttlMs) {
          clearInterval(timer);
          res.end();
          return;
        }
        // Lazy-resolve from ?q on the first tick if no ids were given.
        if (!ids.length && q) {
          const items = await this.searchService.searchInstruments(q.trim(), 10, {});
          // Use UIR id directly — works for kite/vortex/massive/binance equally.
          // The trading-app's UniversalLtpService routes per-instrument across all 4 providers.
          ids = items.map((i: SearchResultItem) => i.id).slice(0, 100);
        }
        if (!ids.length) return;
        // hydrateLtpByItems takes SearchResultItem[]; build a lightweight stub list since we
        // only have ids in the SSE poll loop. The Redis cache key is `q:ltp:uid:{id}` and
        // /api/stock/universal/ltp accepts ids — both keyed by id, no extra fields needed.
        const stubs = ids.map((id) => ({ id } as SearchResultItem));
        const quotes = await this.searchService.hydrateLtpByItems(stubs);
        const payload = ltpOnly
          ? Object.fromEntries(
              Object.entries(quotes).filter(([, v]: any) => Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0),
            )
          : quotes;
        send({ quotes: payload, ts: new Date().toISOString() });
      } catch {
        // skip tick on error
      }
    }, 1000);

    req.on('close', () => clearInterval(timer));
  }
}
