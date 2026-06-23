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
var SearchService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchService = exports.INTERNAL_ONLY_FIELDS = exports.PUBLIC_ALWAYS_INCLUDED = exports.PUBLIC_FIELD_ALLOWLIST = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("axios");
const ioredis_1 = require("ioredis");
exports.PUBLIC_FIELD_ALLOWLIST = [
    'symbol',
    'name',
    'exchange',
    'segment',
    'instrumentType',
    'assetClass',
    'optionType',
    'expiry',
    'strike',
    'lotSize',
    'tickSize',
    'isDerivative',
    'underlyingSymbol',
];
exports.PUBLIC_ALWAYS_INCLUDED = [
    'id',
    'canonicalSymbol',
    'wsSubscribeUirId',
    'last_price',
    'priceStatus',
    'streamProvider',
    'logo_url',
];
exports.INTERNAL_ONLY_FIELDS = [
    'kiteToken',
    'vortexToken',
    'vortexExchange',
    'massiveToken',
    'binanceToken',
    '_internalProvider',
];
class MeiliClientPool {
    constructor(hosts, apiKey, timeoutMs) {
        this.logger = new common_1.Logger('MeiliClientPool');
        this.clients = hosts.map((h) => axios_1.default.create({
            baseURL: h,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: timeoutMs,
        }));
        this.openUntil = hosts.map(() => 0);
        this.failureCount = hosts.map(() => 0);
    }
    async search(index, body) {
        var _a;
        for (let i = 0; i < this.clients.length; i++) {
            if (Date.now() < this.openUntil[i])
                continue;
            try {
                const resp = await this.clients[i].post(`/indexes/${index}/search`, body);
                this.failureCount[i] = 0;
                return resp.data || { hits: [] };
            }
            catch (err) {
                const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
                if (status === 404) {
                    this.logger.warn(`Meili server[${i}] index not found: ${index}`);
                    return { hits: [] };
                }
                this.failureCount[i]++;
                if (this.failureCount[i] >= 3) {
                    this.openUntil[i] = Date.now() + 10000;
                    this.failureCount[i] = 0;
                    this.logger.warn(`Meili server[${i}] circuit opened (3 failures in a row)`);
                }
            }
        }
        return { hits: [] };
    }
}
let SearchService = SearchService_1 = class SearchService {
    constructor() {
        this.logger = new common_1.Logger('SearchService');
        this.hydrationFailures = 0;
        this.hydrationBreakerUntil = 0;
        const primaryHost = process.env.MEILI_HOST_PRIMARY ||
            process.env.MEILI_HOST ||
            'http://meilisearch:7700';
        const secondaryHost = process.env.MEILI_HOST_SECONDARY || '';
        const meiliKey = process.env.MEILI_MASTER_KEY || '';
        const meiliTimeout = Number(process.env.MEILI_TIMEOUT_MS || 1200);
        const hosts = [primaryHost, secondaryHost].filter(Boolean);
        this.meili = new MeiliClientPool(hosts, meiliKey, meiliTimeout);
        const hydrateBase = process.env.HYDRATION_BASE_URL || 'http://trading-app:3000';
        const hydrateApiKey = process.env.HYDRATION_API_KEY || '';
        const hydratorHeaders = {};
        if (hydrateApiKey)
            hydratorHeaders['x-api-key'] = hydrateApiKey;
        hydratorHeaders['x-provider'] = 'vayu';
        this.hydrator = axios_1.default.create({
            baseURL: hydrateBase,
            timeout: Number(process.env.HYDRATE_TIMEOUT_MS || 1500),
            headers: hydratorHeaders,
        });
        try {
            this.redis = new ioredis_1.default({
                host: process.env.REDIS_HOST || 'redis',
                port: Number(process.env.REDIS_PORT || 6379),
                lazyConnect: true,
            });
        }
        catch {
            this.logger.warn('Redis init failed — continuing without cache');
        }
    }
    async searchInstruments(q, limit = 10, filters = {}, attributesToRetrieve) {
        const index = process.env.MEILI_INDEX || 'instruments_v1';
        const attrs = attributesToRetrieve && attributesToRetrieve.length > 0
            ? Array.from(attributesToRetrieve)
            : Array.from(SearchService_1.DEFAULT_ATTRS_TO_RETRIEVE);
        const filterExpr = this.buildFilter(filters);
        const brokerSort = [
            'rankOrder:asc',
            'exchangeRank:asc',
            'expiry:asc',
            'strike:asc',
            'optionType:asc',
        ];
        const precise = await this.meili.search(index, {
            q,
            limit,
            attributesToRetrieve: attrs,
            filter: filterExpr,
            matchingStrategy: 'all',
            sort: brokerSort,
        });
        const primary = precise.hits || [];
        if (primary.length >= limit)
            return primary.slice(0, limit);
        const broad = await this.meili.search(index, {
            q,
            limit,
            attributesToRetrieve: attrs,
            filter: filterExpr,
            matchingStrategy: 'last',
            sort: brokerSort,
        });
        return this.dedupeById([...primary, ...(broad.hits || [])]).slice(0, limit);
    }
    async facetCounts(filters = {}) {
        const index = process.env.MEILI_INDEX || 'instruments_v1';
        const filterExpr = this.buildFilter(filters);
        const resp = await this.meili.search(index, {
            q: '',
            limit: 0,
            filter: filterExpr,
            facets: [
                'exchange',
                'segment',
                'instrumentType',
                'optionType',
                'assetClass',
                'streamProvider',
            ],
        });
        return (resp === null || resp === void 0 ? void 0 : resp.facetDistribution) || {};
    }
    async hydrateQuotes(tokens, mode = 'ltp') {
        var _a;
        if (!tokens.length)
            return {};
        if (Date.now() < this.hydrationBreakerUntil)
            return {};
        const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
        const cacheKey = (t) => `q:${mode}:${t}`;
        const result = {};
        const toFetch = [];
        if (this.redis) {
            for (const t of tokens) {
                const v = await this.redis.get(cacheKey(t));
                if (v)
                    result[String(t)] = JSON.parse(v);
                else
                    toFetch.push(t);
            }
        }
        else {
            toFetch.push(...tokens);
        }
        if (!toFetch.length)
            return result;
        try {
            const url = mode === 'ltp'
                ? '/api/stock/vayu/ltp'
                : `/api/stock/quotes?mode=${mode}&ltp_only=true`;
            const resp = await this.hydrator.post(url, { instruments: toFetch });
            const data = ((_a = resp.data) === null || _a === void 0 ? void 0 : _a.data) || {};
            Object.assign(result, data);
            if (this.redis) {
                const ttlSec = Math.ceil(cacheTTL / 1000);
                for (const [k, v] of Object.entries(data)) {
                    await this.redis.setex(cacheKey(Number(k)), ttlSec, JSON.stringify(v));
                }
            }
            this.hydrationFailures = 0;
            this.hydrationBreakerUntil = 0;
        }
        catch (err) {
            this.hydrationFailures++;
            const threshold = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
            const openMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
            if (this.hydrationFailures >= threshold) {
                this.hydrationBreakerUntil = Date.now() + openMs;
                this.hydrationFailures = 0;
                this.logger.warn(`Hydration circuit opened for ${openMs}ms`);
            }
        }
        return result;
    }
    async hydrateLtpByItems(items) {
        var _a;
        if (!items.length)
            return {};
        if (Date.now() < this.hydrationBreakerUntil)
            return {};
        const cacheTTL = Number(process.env.HYDRATE_TTL_MS || 800);
        const ttlSec = Math.ceil(cacheTTL / 1000);
        const cacheKey = (id) => `q:ltp:uid:${id}`;
        const result = {};
        const toFetch = [];
        if (this.redis) {
            for (const item of items) {
                const cached = await this.redis.get(cacheKey(item.id));
                if (cached)
                    result[String(item.id)] = JSON.parse(cached);
                else
                    toFetch.push(item.id);
            }
        }
        else {
            toFetch.push(...items.map((i) => i.id));
        }
        if (!toFetch.length)
            return result;
        try {
            const resp = await this.hydrator.post('/api/stock/universal/ltp', {
                ids: toFetch,
            });
            const data = ((_a = resp.data) === null || _a === void 0 ? void 0 : _a.data) || {};
            Object.assign(result, data);
            if (this.redis) {
                for (const [k, v] of Object.entries(data)) {
                    await this.redis.setex(cacheKey(Number(k)), ttlSec, JSON.stringify(v));
                }
            }
            this.hydrationFailures = 0;
            this.hydrationBreakerUntil = 0;
        }
        catch (err) {
            this.hydrationFailures++;
            const threshold = Number(process.env.HYDRATE_CB_THRESHOLD || 3);
            const openMs = Number(process.env.HYDRATE_CB_OPEN_MS || 2000);
            if (this.hydrationFailures >= threshold) {
                this.hydrationBreakerUntil = Date.now() + openMs;
                this.hydrationFailures = 0;
                this.logger.warn(`Hydration circuit opened for ${openMs}ms`);
            }
        }
        return result;
    }
    async logSelectionTelemetry(q, symbol, universalId) {
        try {
            if (!this.redis)
                return;
            const normQ = String(q || '')
                .trim()
                .toLowerCase();
            const normSym = String(symbol || '')
                .trim()
                .toUpperCase();
            if (!normQ || !normSym)
                return;
            const ttlSec = Number(process.env.SYNONYMS_TTL_DAYS || 14) * 86400;
            const keys = [
                `syn:q:${normQ}:sym:${normSym}`,
                `syn:sym:${normSym}`,
                ...(Number.isFinite(universalId)
                    ? [`syn:uid:${universalId}:q:${normQ}`]
                    : []),
            ];
            for (const k of keys) {
                await this.redis.incrby(k, 1);
                if (ttlSec > 0)
                    await this.redis.expire(k, ttlSec);
            }
        }
        catch {
        }
    }
    buildFilter(filters) {
        var _a, _b;
        const parts = [];
        if (!filters)
            return undefined;
        if (filters.exchange)
            parts.push(`exchange = ${JSON.stringify(filters.exchange)}`);
        if (filters.segment)
            parts.push(`segment = ${JSON.stringify(filters.segment)}`);
        if (filters.instrumentType)
            parts.push(`instrumentType = ${JSON.stringify(filters.instrumentType)}`);
        if (filters.vortexExchange)
            parts.push(`vortexExchange = ${JSON.stringify(filters.vortexExchange)}`);
        if (filters.optionType)
            parts.push(`optionType = ${JSON.stringify(filters.optionType)}`);
        if (filters.assetClass)
            parts.push(`assetClass = ${JSON.stringify(filters.assetClass)}`);
        if (filters.streamProvider)
            parts.push(`streamProvider = ${JSON.stringify(filters.streamProvider)}`);
        if (filters.isDerivative !== undefined)
            parts.push(`isDerivative = ${!!filters.isDerivative}`);
        const expFrom = filters.expiry_from || filters.parsedExpiryFrom;
        const expTo = filters.expiry_to || filters.parsedExpiryTo;
        const expFromTs = expFrom ? this.dateStringToExpiryTs(expFrom) : null;
        const expToTs = expTo ? this.dateStringToExpiryTs(expTo) : null;
        if (expFromTs !== null)
            parts.push(`expiryTs >= ${expFromTs}`);
        if (expToTs !== null)
            parts.push(`expiryTs <= ${expToTs}`);
        if (filters.isMonthly === true) {
            parts.push('(isMonthly = true AND (optionType = "CE" OR optionType = "PE"))');
        }
        if (filters.isWeekly === true) {
            parts.push('(isWeekly = true AND (optionType = "CE" OR optionType = "PE"))');
        }
        if (Number.isFinite(Number(filters.strike_min)))
            parts.push(`strike >= ${Number(filters.strike_min)}`);
        if (Number.isFinite(Number(filters.strike_max)))
            parts.push(`strike <= ${Number(filters.strike_max)}`);
        const filterExpr = parts.length ? parts.join(' AND ') : undefined;
        (_b = (_a = this.logger).debug) === null || _b === void 0 ? void 0 : _b.call(_a, `[SearchService] buildFilter q=${filters['q']} -> ${filterExpr !== null && filterExpr !== void 0 ? filterExpr : '(none)'}`);
        return filterExpr;
    }
    dateStringToExpiryTs(dateStr) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
        if (!m)
            return null;
        const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 15, 0);
        return Math.floor(ts / 1000);
    }
    dedupeById(items) {
        const seen = new Set();
        const out = [];
        for (const item of items) {
            if (!seen.has(item.id)) {
                seen.add(item.id);
                out.push(item);
            }
        }
        return out;
    }
    fetchPrimaryUir(q) {
        const norm = String(q || '')
            .trim()
            .toUpperCase();
        const PRIMARY_INDEX_MAP = {
            NIFTY: { symbol: 'NIFTY', canonicalSymbol: 'NSE:NIFTY' },
            NIFTY50: { symbol: 'NIFTY', canonicalSymbol: 'NSE:NIFTY' },
            BANKNIFTY: { symbol: 'BANKNIFTY', canonicalSymbol: 'NSE:BANKNIFTY' },
            SENSEX: { symbol: 'SENSEX', canonicalSymbol: 'BSE:SENSEX' },
            FINNIFTY: { symbol: 'FINNIFTY', canonicalSymbol: 'NSE:FINNIFTY' },
            MIDCPNIFTY: { symbol: 'MIDCPNIFTY', canonicalSymbol: 'NSE:MIDCPNIFTY' },
        };
        const hit = PRIMARY_INDEX_MAP[norm];
        if (!hit)
            return undefined;
        return {
            id: 0,
            canonicalSymbol: hit.canonicalSymbol,
            symbol: hit.symbol,
            name: hit.symbol,
            exchange: hit.canonicalSymbol.split(':')[0],
            instrumentType: 'IDX',
            assetClass: 'equity',
            isDerivative: false,
            streamProvider: 'kite',
        };
    }
};
exports.SearchService = SearchService;
SearchService.DEFAULT_ATTRS_TO_RETRIEVE = [
    'id',
    'canonicalSymbol',
    'symbol',
    'name',
    'exchange',
    'segment',
    'instrumentType',
    'assetClass',
    'optionType',
    'expiry',
    'strike',
    'lotSize',
    'tickSize',
    'isDerivative',
    'underlyingSymbol',
    'kiteToken',
    'vortexToken',
    'vortexExchange',
    'massiveToken',
    'binanceToken',
    'streamProvider',
];
exports.SearchService = SearchService = SearchService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], SearchService);
