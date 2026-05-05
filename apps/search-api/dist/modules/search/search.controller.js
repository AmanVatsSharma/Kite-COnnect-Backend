"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchController = void 0;
const common_1 = require("@nestjs/common");
const search_service_1 = require("./search.service");
const provider_aliases_1 = require("./provider-aliases");
function buildResponseRow(raw, last_price, selectedFields, includeInternal) {
    const live = Number.isFinite(last_price) && (last_price !== null && last_price !== void 0 ? last_price : 0) > 0;
    const out = {
        id: raw.id,
        canonicalSymbol: raw.canonicalSymbol,
        wsSubscribeUirId: raw.id,
        last_price,
        priceStatus: live ? 'live' : 'stale',
        streamProvider: raw.streamProvider
            ? (0, provider_aliases_1.internalToPublicProvider)(raw.streamProvider)
            : undefined,
    };
    for (const k of search_service_1.PUBLIC_FIELD_ALLOWLIST) {
        if (selectedFields && !selectedFields.has(k))
            continue;
        const v = raw[k];
        if (v !== undefined)
            out[k] = v;
    }
    if (includeInternal) {
        out._internalProvider = raw.streamProvider;
        if (raw.kiteToken !== undefined)
            out.kiteToken = raw.kiteToken;
        if (raw.vortexToken !== undefined)
            out.vortexToken = raw.vortexToken;
        if (raw.vortexExchange !== undefined)
            out.vortexExchange = raw.vortexExchange;
        if (raw.massiveToken !== undefined)
            out.massiveToken = raw.massiveToken;
        if (raw.binanceToken !== undefined)
            out.binanceToken = raw.binanceToken;
    }
    return out;
}
function parseFieldsParam(raw) {
    if (!raw || !String(raw).trim())
        return null;
    const requested = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!requested.length)
        return null;
    const allow = new Set(search_service_1.PUBLIC_FIELD_ALLOWLIST);
    return new Set(requested.filter((f) => allow.has(f)));
}
function buildMeiliAttrs(selectedFields, includeInternal) {
    if (!selectedFields && !includeInternal)
        return undefined;
    const attrs = new Set([
        'id',
        'canonicalSymbol',
        'streamProvider',
    ]);
    if (selectedFields) {
        for (const f of selectedFields)
            attrs.add(f);
    }
    else {
        for (const f of search_service_1.PUBLIC_FIELD_ALLOWLIST)
            attrs.add(f);
    }
    if (includeInternal) {
        for (const f of search_service_1.INTERNAL_ONLY_FIELDS) {
            if (f !== '_internalProvider')
                attrs.add(f);
        }
    }
    return Array.from(attrs);
}
function isInternalIncludeAuthorized(includeRaw, adminTokenHeader) {
    if (!includeRaw || String(includeRaw).toLowerCase() !== 'internal')
        return false;
    const expected = process.env.ADMIN_TOKEN || '';
    if (!expected)
        return false;
    return String(adminTokenHeader || '').trim() === expected;
}
function normalizeStreamProvider(raw) {
    var _a;
    return (_a = (0, provider_aliases_1.normalizeProviderAlias)(raw)) !== null && _a !== void 0 ? _a : undefined;
}
const MODE_TO_VORTEX_EXCHANGE = {
    eq: 'NSE_EQ',
    fno: 'NSE_FO',
    curr: 'NSE_CUR',
    commodities: 'MCX_FO',
};
let SearchController = class SearchController {
    constructor(searchService) {
        this.searchService = searchService;
        this.logger = new common_1.Logger('SearchController');
    }
    async search(q, limitRaw, exchange, segment, instrumentType, vortexExchange, optionType, assetClass, streamProvider, mode, expiry_from, expiry_to, strike_min, strike_max, ltpOnlyRaw, fieldsRaw, includeRaw, adminTokenHeader) {
        if (!q || q.trim().length === 0) {
            throw new common_1.HttpException({ success: false, message: 'q is required' }, common_1.HttpStatus.BAD_REQUEST);
        }
        const limit = Math.min(Number(limitRaw || 10), 50);
        const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
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
        const enriched = items.map((it) => { var _a, _b; return buildResponseRow(it, (_b = (_a = quotes === null || quotes === void 0 ? void 0 : quotes[String(it.id)]) === null || _a === void 0 ? void 0 : _a.last_price) !== null && _b !== void 0 ? _b : null, selectedFields, includeInternal); });
        const data = (ltpOnly
            ? enriched.filter((v) => v.priceStatus === 'live')
            : enriched).slice(0, limit);
        this.logger.log(`[Search] q="${q}" limit=${limit} probe=${probeLimit} ltp_only=${ltpOnly} ` +
            `fields=${selectedFields ? Array.from(selectedFields).join('|') : '*'} ` +
            `include_internal=${includeInternal} returned=${data.length}`);
        return { success: true, data, timestamp: new Date().toISOString() };
    }
    async suggest(q, limitRaw, exchange, segment, instrumentType, vortexExchange, optionType, streamProvider, mode, expiry_from, expiry_to, strike_min, strike_max, ltpOnlyRaw, fieldsRaw, includeRaw, adminTokenHeader) {
        const limit = Math.min(Number(limitRaw || 5), 20);
        if (!q || q.trim().length === 0) {
            return { success: true, data: [], timestamp: new Date().toISOString() };
        }
        const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
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
        const enriched = items.map((it) => { var _a, _b; return buildResponseRow(it, (_b = (_a = quotes === null || quotes === void 0 ? void 0 : quotes[String(it.id)]) === null || _a === void 0 ? void 0 : _a.last_price) !== null && _b !== void 0 ? _b : null, selectedFields, includeInternal); });
        const data = (ltpOnly
            ? enriched.filter((v) => v.priceStatus === 'live')
            : enriched).slice(0, limit);
        this.logger.log(`[Suggest] q="${q}" limit=${limit} ltp_only=${ltpOnly} ` +
            `fields=${selectedFields ? Array.from(selectedFields).join('|') : '*'} ` +
            `include_internal=${includeInternal} returned=${data.length}`);
        return { success: true, data, timestamp: new Date().toISOString() };
    }
    async filters(exchange, segment, instrumentType, assetClass) {
        const raw = await this.searchService.facetCounts({ exchange, segment, instrumentType, assetClass });
        if (raw.streamProvider) {
            const mapped = {};
            for (const [k, v] of Object.entries(raw.streamProvider)) {
                mapped[(0, provider_aliases_1.internalToPublicProvider)(k)] = v;
            }
            raw.streamProvider = mapped;
        }
        return { success: true, data: raw, timestamp: new Date().toISOString() };
    }
    schema() {
        return {
            success: true,
            data: {
                endpoints: {
                    search: 'GET /api/search',
                    suggest: 'GET /api/search/suggest',
                    filters: 'GET /api/search/filters  — live facet counts per field value',
                    schema: 'GET /api/search/schema   — this endpoint',
                    stream: 'GET /api/search/stream   — SSE live-price ticker',
                },
                params: {
                    q: { type: 'string', required: true, note: 'Ticker symbol, company name, or synonym (e.g. SBI, NIFTY50, Bitcoin)' },
                    limit: { type: 'integer', default: 10, max: 50 },
                    exchange: { type: 'string', filterable: true, enums: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'BINANCE', 'CRYPTO', 'US', 'FX', 'IDX', 'GLOBAL', 'NCO', 'NSEIX'] },
                    segment: { type: 'string', filterable: true, enums: ['NSE', 'BSE', 'NFO-FUT', 'NFO-OPT', 'BFO-FUT', 'BFO-OPT', 'MCX-FUT', 'MCX-OPT', 'CDS-FUT', 'CDS-OPT', 'NCO', 'NCO-FUT', 'NCO-OPT', 'spot', 'stocks', 'crypto', 'INDICES'] },
                    instrumentType: { type: 'string', filterable: true, enums: ['EQ', 'FUT', 'CE', 'PE', 'ETF', 'IDX', 'CS', 'ADRC', 'ETN', 'ETS', 'ETV', 'FUND', 'SP', 'PFD', 'WARRANT', 'UNIT', 'RIGHT'] },
                    assetClass: { type: 'string', filterable: true, enums: ['equity', 'crypto', 'currency', 'commodity'], note: 'Top-level asset category; use this for broad filtering (e.g. all crypto)' },
                    streamProvider: { type: 'string', filterable: true, enums: ['falcon', 'vayu', 'atlas', 'drift'],
                        note: 'Public brand name of the live-data provider. falcon=Indian equity (NSE/BSE), vayu=F&O/currency/commodities, atlas=US stocks/forex, drift=Global crypto Spot' },
                    optionType: { type: 'string', filterable: true, enums: ['CE', 'PE'], note: 'Only relevant for options instruments' },
                    isDerivative: { type: 'boolean', filterable: true, note: 'true = futures/options; false = equity/spot' },
                    mode: { type: 'string', note: 'Shorthand for vortexExchange filter. eq=NSE_EQ, fno=NSE_FO, curr=NSE_CUR, commodities=MCX_FO' },
                    expiry_from: { type: 'date', format: 'YYYY-MM-DD', note: 'Filter derivatives by expiry >= date' },
                    expiry_to: { type: 'date', format: 'YYYY-MM-DD', note: 'Filter derivatives by expiry <= date' },
                    strike_min: { type: 'number', note: 'Filter options by strike >= value' },
                    strike_max: { type: 'number', note: 'Filter options by strike <= value' },
                    ltp_only: { type: 'boolean', default: false, note: 'When true, returns only instruments with a live price right now' },
                    fields: { type: 'string', note: 'Comma-separated projection. Always includes: id, canonicalSymbol, wsSubscribeUirId, last_price, priceStatus, streamProvider. Allowed extras: symbol,name,exchange,segment,instrumentType,assetClass,optionType,expiry,strike,lotSize,tickSize,isDerivative,underlyingSymbol' },
                },
                responseFields: {
                    id: 'Universal instrument ID — use this to subscribe to live prices via WebSocket',
                    wsSubscribeUirId: 'Same as id — convenience alias for WebSocket subscribe payloads',
                    canonicalSymbol: 'Human-readable unique key, e.g. NSE:RELIANCE or BINANCE:BTCUSDT',
                    last_price: 'Latest known price (null if no live price available)',
                    priceStatus: '"live" = price arrived within cache TTL; "stale" = no recent tick',
                    streamProvider: 'Public brand name of the provider streaming this instrument (falcon/vayu/atlas/drift)',
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
    async popular(limitRaw) {
        const limit = Math.min(Number(limitRaw || 10), 50);
        this.logger.log(`popular requested, limit=${limit}`);
        return { success: true, data: [], timestamp: new Date().toISOString() };
    }
    async selection(body) {
        var _a;
        const q = String((body === null || body === void 0 ? void 0 : body.q) || '').trim();
        const symbol = String((body === null || body === void 0 ? void 0 : body.symbol) || '').trim();
        const uid = (_a = body === null || body === void 0 ? void 0 : body.universalId) !== null && _a !== void 0 ? _a : body === null || body === void 0 ? void 0 : body.instrumentToken;
        if (!q || !symbol) {
            throw new common_1.HttpException({ success: false, message: 'q and symbol are required' }, common_1.HttpStatus.BAD_REQUEST);
        }
        await this.searchService.logSelectionTelemetry(q, symbol, Number.isFinite(uid) ? Number(uid) : undefined);
        return { success: true };
    }
    async stream(res, req, idsRaw, tokensRaw, q, ltpOnlyRaw) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
        const parseIds = (s) => String(s || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
        let ids = parseIds(idsRaw || tokensRaw).slice(0, 100);
        const ttlMs = Number(process.env.SSE_DEFAULT_TTL_MS || 30000);
        const started = Date.now();
        const send = (data) => {
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
                if (!ids.length && q) {
                    const items = await this.searchService.searchInstruments(q.trim(), 10, {});
                    ids = items.map((i) => i.id).slice(0, 100);
                }
                if (!ids.length)
                    return;
                const stubs = ids.map((id) => ({ id }));
                const quotes = await this.searchService.hydrateLtpByItems(stubs);
                const payload = ltpOnly
                    ? Object.fromEntries(Object.entries(quotes).filter(([, v]) => { var _a; return Number.isFinite(v === null || v === void 0 ? void 0 : v.last_price) && ((_a = v === null || v === void 0 ? void 0 : v.last_price) !== null && _a !== void 0 ? _a : 0) > 0; }))
                    : quotes;
                send({ quotes: payload, ts: new Date().toISOString() });
            }
            catch {
            }
        }, 1000);
        req.on('close', () => clearInterval(timer));
    }
};
exports.SearchController = SearchController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('exchange')),
    __param(3, (0, common_1.Query)('segment')),
    __param(4, (0, common_1.Query)('instrumentType')),
    __param(5, (0, common_1.Query)('vortexExchange')),
    __param(6, (0, common_1.Query)('optionType')),
    __param(7, (0, common_1.Query)('assetClass')),
    __param(8, (0, common_1.Query)('streamProvider')),
    __param(9, (0, common_1.Query)('mode')),
    __param(10, (0, common_1.Query)('expiry_from')),
    __param(11, (0, common_1.Query)('expiry_to')),
    __param(12, (0, common_1.Query)('strike_min')),
    __param(13, (0, common_1.Query)('strike_max')),
    __param(14, (0, common_1.Query)('ltp_only')),
    __param(15, (0, common_1.Query)('fields')),
    __param(16, (0, common_1.Query)('include')),
    __param(17, (0, common_1.Headers)('x-admin-token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, String, String, String, String, String, String, String, String, Object, String, String, String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "search", null);
__decorate([
    (0, common_1.Get)('suggest'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('exchange')),
    __param(3, (0, common_1.Query)('segment')),
    __param(4, (0, common_1.Query)('instrumentType')),
    __param(5, (0, common_1.Query)('vortexExchange')),
    __param(6, (0, common_1.Query)('optionType')),
    __param(7, (0, common_1.Query)('streamProvider')),
    __param(8, (0, common_1.Query)('mode')),
    __param(9, (0, common_1.Query)('expiry_from')),
    __param(10, (0, common_1.Query)('expiry_to')),
    __param(11, (0, common_1.Query)('strike_min')),
    __param(12, (0, common_1.Query)('strike_max')),
    __param(13, (0, common_1.Query)('ltp_only')),
    __param(14, (0, common_1.Query)('fields')),
    __param(15, (0, common_1.Query)('include')),
    __param(16, (0, common_1.Headers)('x-admin-token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, String, String, String, String, String, String, String, Object, String, String, String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "suggest", null);
__decorate([
    (0, common_1.Get)('filters'),
    __param(0, (0, common_1.Query)('exchange')),
    __param(1, (0, common_1.Query)('segment')),
    __param(2, (0, common_1.Query)('instrumentType')),
    __param(3, (0, common_1.Query)('assetClass')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "filters", null);
__decorate([
    (0, common_1.Get)('schema'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SearchController.prototype, "schema", null);
__decorate([
    (0, common_1.Get)('popular'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "popular", null);
__decorate([
    (0, common_1.Post)('telemetry/selection'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "selection", null);
__decorate([
    (0, common_1.Get)('stream'),
    __param(0, (0, common_1.Res)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Query)('ids')),
    __param(3, (0, common_1.Query)('tokens')),
    __param(4, (0, common_1.Query)('q')),
    __param(5, (0, common_1.Query)('ltp_only')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], SearchController.prototype, "stream", null);
exports.SearchController = SearchController = __decorate([
    (0, common_1.Controller)('search'),
    __metadata("design:paramtypes", [search_service_1.SearchService])
], SearchController);
