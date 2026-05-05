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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminSearchService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("axios");
const ioredis_1 = require("ioredis");
let AdminSearchService = class AdminSearchService {
    constructor() {
        this.logger = new common_1.Logger('AdminSearchService');
        const host = process.env.MEILI_HOST_PRIMARY
            || process.env.MEILI_HOST
            || 'http://meilisearch:7700';
        const apiKey = process.env.MEILI_MASTER_KEY || '';
        this.meili = axios_1.default.create({
            baseURL: host,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: Number(process.env.MEILI_TIMEOUT_MS || 1500),
        });
        try {
            this.redis = new ioredis_1.default({
                host: process.env.REDIS_HOST || 'redis',
                port: Number(process.env.REDIS_PORT || 6379),
                lazyConnect: true,
            });
        }
        catch {
            this.logger.warn('Redis init failed — admin panel will skip synonym signals');
        }
    }
    async getOverview(topN = 30) {
        var _a;
        const indexName = process.env.MEILI_INDEX || 'instruments_v1';
        const errors = [];
        const [meili, signals] = await Promise.all([
            this.fetchMeiliBlock(indexName).catch((e) => {
                var _a;
                errors.push(`meili: ${(_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : 'unknown'}`);
                return this.emptyMeiliBlock(indexName);
            }),
            this.fetchSelectionSignals(topN).catch((e) => {
                var _a;
                errors.push(`redis: ${(_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : 'unknown'}`);
                return { scanned: 0, top: [] };
            }),
        ]);
        const queryAgg = new Map();
        for (const sig of signals.top) {
            const cur = (_a = queryAgg.get(sig.q)) !== null && _a !== void 0 ? _a : { totalSelections: 0, symbols: new Set() };
            cur.totalSelections += sig.count;
            cur.symbols.add(sig.symbol);
            queryAgg.set(sig.q, cur);
        }
        const popularQueries = Array.from(queryAgg.entries())
            .map(([q, v]) => ({ q, totalSelections: v.totalSelections, uniqueSymbols: v.symbols.size }))
            .sort((a, b) => b.totalSelections - a.totalSelections)
            .slice(0, topN);
        return {
            meili,
            selectionSignals: signals,
            popularQueries,
            errors,
            generatedAt: new Date().toISOString(),
        };
    }
    async fetchMeiliBlock(indexName) {
        var _a;
        const [statsResp, settingsResp] = await Promise.all([
            this.meili.get(`/indexes/${indexName}/stats`),
            this.meili.get(`/indexes/${indexName}/settings`),
        ]);
        const stats = statsResp.data || {};
        const settings = settingsResp.data || {};
        return {
            indexName,
            numberOfDocuments: typeof stats.numberOfDocuments === 'number' ? stats.numberOfDocuments : null,
            isIndexing: typeof stats.isIndexing === 'boolean' ? stats.isIndexing : null,
            fieldDistribution: (_a = stats.fieldDistribution) !== null && _a !== void 0 ? _a : null,
            settings: {
                searchableAttributes: Array.isArray(settings.searchableAttributes) ? settings.searchableAttributes : null,
                filterableAttributes: Array.isArray(settings.filterableAttributes) ? settings.filterableAttributes : null,
                sortableAttributes: Array.isArray(settings.sortableAttributes) ? settings.sortableAttributes : null,
                synonymCount: settings.synonyms && typeof settings.synonyms === 'object'
                    ? Object.keys(settings.synonyms).length
                    : null,
            },
        };
    }
    emptyMeiliBlock(indexName) {
        return {
            indexName,
            numberOfDocuments: null,
            isIndexing: null,
            fieldDistribution: null,
            settings: {
                searchableAttributes: null,
                filterableAttributes: null,
                sortableAttributes: null,
                synonymCount: null,
            },
        };
    }
    async fetchSelectionSignals(topN) {
        var _a;
        if (!this.redis)
            return { scanned: 0, top: [] };
        const SCAN_LIMIT = Number(process.env.ADMIN_SYNONYM_SCAN_LIMIT || 5000);
        const all = [];
        let cursor = '0';
        let scanned = 0;
        do {
            const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'syn:q:*:sym:*', 'COUNT', 500);
            cursor = next;
            if (keys.length) {
                const counts = await this.redis.mget(...keys);
                for (let i = 0; i < keys.length; i++) {
                    const m = keys[i].match(/^syn:q:(.+):sym:(.+)$/);
                    if (!m)
                        continue;
                    const c = Number((_a = counts[i]) !== null && _a !== void 0 ? _a : 0);
                    if (!Number.isFinite(c) || c <= 0)
                        continue;
                    all.push({ q: m[1], symbol: m[2], count: c });
                    scanned++;
                    if (scanned >= SCAN_LIMIT) {
                        cursor = '0';
                        break;
                    }
                }
            }
        } while (cursor !== '0');
        all.sort((a, b) => b.count - a.count);
        return { scanned, top: all.slice(0, topN) };
    }
};
exports.AdminSearchService = AdminSearchService;
exports.AdminSearchService = AdminSearchService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], AdminSearchService);
