"use strict";
/**
 * @file apps/search-indexer/src/index.ts
 * @module search-indexer
 * @description Batch and incremental sync of universal_instruments into MeiliSearch.
 *              Joins instrument_mappings to embed kite/vortex/massive/binance provider tokens
 *              per document and precomputes streamProvider via the canonical exchange→provider map.
 *              Supports modes: backfill | incremental | backfill-and-watch | synonyms-apply | settings-apply.
 * @author BharatERP
 * @created 2025-12-01
 * @updated 2026-05-04
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');
/**
 * Canonical exchange → streaming provider map. **Mirror of**
 * `src/shared/utils/exchange-to-provider.util.ts` — duplicated here because the
 * search-indexer is a separate Docker container with no `src/` import path.
 * Keep these two literals in sync when adding new providers/exchanges.
 */
const EXCHANGE_TO_PROVIDER = {
    NSE: 'kite',
    BSE: 'kite',
    NFO: 'kite',
    BFO: 'kite',
    MCX: 'kite',
    CDS: 'kite',
    BCD: 'kite',
    US: 'massive',
    FX: 'massive',
    CRYPTO: 'massive',
    IDX: 'massive',
    BINANCE: 'binance',
};
// ─── Crypto full-name lookup ─────────────────────────────────────────────────
// Maps base coin (first part of BTCUSDT → BTC) to its human-readable full name.
// Enables broker-style search: "bitcoin" → BTCUSDT, "ethereum" → ETHUSDT.
// The name is injected into searchKeywords so relevance ranking works naturally.
const CRYPTO_BASE_NAMES = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    BNB: 'BNB Binance Coin',
    SOL: 'Solana',
    ADA: 'Cardano',
    XRP: 'Ripple',
    DOGE: 'Dogecoin',
    DOT: 'Polkadot',
    MATIC: 'Polygon Matic',
    AVAX: 'Avalanche',
    LINK: 'Chainlink',
    LTC: 'Litecoin',
    UNI: 'Uniswap',
    ATOM: 'Cosmos',
    TRX: 'TRON',
    SHIB: 'Shiba Inu',
    FIL: 'Filecoin',
    NEAR: 'NEAR Protocol',
    APT: 'Aptos',
    ARB: 'Arbitrum',
    OP: 'Optimism',
    SUI: 'Sui',
    ICP: 'Internet Computer',
    VET: 'VeChain',
    ALGO: 'Algorand',
    HBAR: 'Hedera',
    GRT: 'The Graph',
    AAVE: 'Aave',
    SAND: 'The Sandbox',
    MANA: 'Decentraland',
    CRO: 'Cronos',
    FTM: 'Fantom',
    FLOW: 'Flow',
    EGLD: 'MultiversX Elrond',
    THETA: 'Theta Network',
    EOS: 'EOS',
    XLM: 'Stellar Lumens',
    XMR: 'Monero',
    CAKE: 'PancakeSwap',
    ENS: 'Ethereum Name Service',
    LDO: 'Lido DAO',
    MKR: 'Maker',
    SNX: 'Synthetix',
    CRV: 'Curve Finance',
    COMP: 'Compound',
    YFI: 'Yearn Finance',
    SUSHI: 'SushiSwap',
    ZEC: 'Zcash',
    DASH: 'Dash',
    NEO: 'NEO',
    IOTA: 'IOTA',
    BCH: 'Bitcoin Cash',
    ETC: 'Ethereum Classic',
    BSV: 'Bitcoin SV',
};
/** Extract the base coin from a Binance symbol like BTCUSDT → BTC, ETHBTC → ETH */
function extractCoinBase(symbol) {
    // Common quote assets — strip the longest matching suffix
    const quotes = ['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'BTC', 'ETH', 'BNB'];
    for (const q of quotes) {
        if (symbol.endsWith(q) && symbol.length > q.length) {
            return symbol.slice(0, symbol.length - q.length);
        }
    }
    return symbol;
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function env(key, def) {
    const v = process.env[key];
    return v !== undefined && v !== '' ? v : def;
}
async function withPg(fn) {
    const client = new Client({
        host: env('DB_HOST', 'postgres'),
        port: Number(env('DB_PORT', '5432')),
        user: env('DB_USERNAME', 'trading_user'),
        password: env('DB_PASSWORD', 'trading_password'),
        database: env('DB_DATABASE', 'trading_app'),
    });
    await client.connect();
    try {
        return await fn(client);
    }
    finally {
        await client.end();
    }
}
function toVortexExchange(exchange, segment, instrumentType) {
    const ex = exchange.toUpperCase();
    const seg = (segment || '').toUpperCase();
    const it = (instrumentType || '').toUpperCase();
    if (ex === 'MCX' || seg.includes('MCX'))
        return 'MCX_FO';
    if (seg.includes('CDS') || seg.includes('CUR') || it.includes('CUR'))
        return 'NSE_CUR';
    if (it === 'FUT' ||
        it === 'CE' ||
        it === 'PE' ||
        seg.includes('FO') ||
        seg.includes('FNO'))
        return 'NSE_FO';
    return 'NSE_EQ';
}
function toDoc(r) {
    var _a, _b;
    const symbol = (r.underlying || '').toUpperCase();
    const it = (r.instrument_type || '').toUpperCase();
    const isDerivative = it === 'FUT' || it === 'CE' || it === 'PE';
    const rankOrder = !isDerivative ? 0 : it === 'FUT' ? 1 : 2; // 0=equity 1=futures 2=options
    const ex = (r.exchange || '').toUpperCase();
    const exchangeRank = ex === 'NSE'
        ? 0
        : ex === 'BSE'
            ? 1
            : ex === 'NFO' ||
                ex === 'BFO' ||
                ex === 'MCX' ||
                ex === 'CDS' ||
                ex === 'BCD'
                ? 2
                : 9;
    const underlyingSymbol = isDerivative
        ? ((_b = (_a = symbol.match(/^[A-Z]+/)) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : undefined)
        : undefined;
    const vortexExchange = toVortexExchange(r.exchange, r.segment, r.instrument_type);
    // Vortex provider_token is "NSE_EQ-22" — split on last '-' and take the numeric tail for vortexToken.
    // (Older indexer code just pulled m.instrument_token; we now share the same string-pivot column the
    // other providers use, so do the parse here.)
    let vortexToken;
    if (r.vortex_token) {
        const dash = r.vortex_token.lastIndexOf('-');
        const tail = dash >= 0 ? r.vortex_token.slice(dash + 1) : r.vortex_token;
        const n = Number(tail);
        if (Number.isFinite(n))
            vortexToken = n;
    }
    const kiteToken = r.kite_token ? Number(r.kite_token) : undefined;
    const massiveToken = r.massive_token
        ? r.massive_token.toUpperCase()
        : undefined;
    const binanceToken = r.binance_token
        ? r.binance_token.toUpperCase()
        : undefined;
    // Routing: prefer the exchange→provider table (canonical fact). Fall back to whichever
    // mapping exists when an exchange isn't in the table (defensive — shouldn't happen for
    // active rows, but keeps us from emitting docs with an undefined streamProvider).
    let streamProvider = EXCHANGE_TO_PROVIDER[r.exchange];
    if (!streamProvider) {
        if (vortexToken !== undefined)
            streamProvider = 'vortex';
        else if (kiteToken !== undefined)
            streamProvider = 'kite';
        else if (binanceToken)
            streamProvider = 'binance';
        else if (massiveToken)
            streamProvider = 'massive';
    }
    return {
        id: Number(r.id),
        canonicalSymbol: r.canonical_symbol,
        symbol,
        name: r.name || '',
        exchange: r.exchange,
        segment: r.segment || '',
        instrumentType: it,
        assetClass: r.asset_class || 'equity',
        optionType: r.option_type || null,
        expiry: r.expiry ? String(r.expiry).slice(0, 10) : null,
        strike: r.strike !== null ? Number(r.strike) : null,
        lotSize: r.lot_size || 1,
        tickSize: Number(r.tick_size) || 0.05,
        isActive: r.is_active,
        isDerivative,
        rankOrder,
        exchangeRank,
        vortexExchange,
        underlyingSymbol,
        kiteToken,
        vortexToken,
        massiveToken,
        binanceToken,
        streamProvider,
        ...(() => {
            const isCrypto = r.exchange === 'BINANCE' || (r.asset_class || '') === 'crypto';
            if (!isCrypto)
                return { searchKeywords: [symbol, r.name].filter(Boolean) };
            const base = extractCoinBase(symbol);
            const fullName = CRYPTO_BASE_NAMES[base];
            const kw = [symbol, r.name].filter(Boolean);
            if (fullName)
                kw.push(fullName);
            if (symbol.length > 4 &&
                (symbol.endsWith('USDT') ||
                    symbol.endsWith('USDC') ||
                    symbol.endsWith('BTC'))) {
                kw.push(`${base}/${symbol.slice(-4)}`);
            }
            // Only USDT-quoted pairs get coinFullName so "ethereum" → ETHUSDT, not ETHBTC.
            // Both are equally relevant on coinFullName otherwise; USDT is the canonical USD price.
            const isUsdtQuoted = symbol.endsWith('USDT') || symbol.endsWith('USDC');
            return {
                searchKeywords: kw,
                coinFullName: fullName && isUsdtQuoted ? fullName : undefined,
            };
        })(),
    };
}
// ─── MeiliSearch index settings ──────────────────────────────────────────────
async function applySettings(meiliBase, apiKey, index) {
    const h = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    await axios_1.default.patch(`${meiliBase}/indexes/${index}/settings`, {
        searchableAttributes: [
            'coinFullName', // P0: crypto full name (Bitcoin/Ethereum/Solana) — only Binance docs have this;
            // ranks crypto tickers above US equity funds that happen to mention the coin
            'symbol', // P1: direct ticker (RELIANCE, NIFTY, BTCUSDT)
            'canonicalSymbol', // P2: "NSE:RELIANCE"
            'name', // P3: company/pair name
            'underlyingSymbol', // P4: for F&O: "NIFTY" extracted from "NIFTY24JAN22000CE"
            'searchKeywords', // P5: combined fallback bag
        ],
        filterableAttributes: [
            'exchange',
            'segment',
            'instrumentType',
            'optionType',
            'assetClass',
            'isDerivative',
            'isActive',
            'expiry',
            'strike',
            'vortexExchange',
            'lotSize',
            // New routing/coverage facets — let clients filter "all binance pairs", "all massive crypto", etc.
            'streamProvider',
        ],
        sortableAttributes: [
            'symbol',
            'name',
            'rankOrder',
            'exchangeRank',
            'expiry',
            'strike',
            'optionType',
        ],
        rankingRules: [
            'typo', // P0: typo-tolerant (makes "nifty" match "NIFTY 50")
            'proximity',
            'words', // P2: all words must be present (fallback)
            'attribute', // respects searchableAttributes priority order
            'exactness', // exact symbol match must beat partial name matches (e.g. "RELIANCE" beats "RELIANCE COMMS")
            'sort', // broker sort: rankOrder(equity→fut→options) → exchangeRank(NSE→BSE) → expiry → strike → CE/PE
        ],
        typoTolerance: {
            enabled: true,
            minWordSizeForTypos: {
                oneTypo: 4, // protects short symbols like TCS, SBI, LT
                twoTypos: 8,
            },
            disableOnAttributes: ['instrumentType', 'exchange', 'optionType'],
        },
        pagination: { maxTotalHits: 2000 },
        stopWords: [
            'limited',
            'ltd',
            'pvt',
            'private',
            'industries',
            'india',
            'and',
        ],
        synonyms: {
            NIFTY: ['NIFTY50', 'NIFTY 50', 'CNX NIFTY', 'NIFTY INDEX'],
            BANKNIFTY: ['BANK NIFTY', 'BANK-NIFTY', 'CNX BANK', 'BANKEX'],
            MIDCPNIFTY: ['MIDCAP NIFTY', 'MIDCAP50'],
            FINNIFTY: ['FIN NIFTY', 'NIFTY FIN SERVICE'],
            SENSEX: ['BSE SENSEX'],
            RELIANCE: ['RIL'],
            SBIN: ['STATE BANK', 'STATE BANK OF INDIA', 'SBI'],
            INFY: ['INFOSYS'],
            TCS: ['TATA CONSULTANCY SERVICES'],
            HDFCBANK: ['HDFC BANK'],
            ICICIBANK: ['ICICI BANK'],
            LT: ['LARSEN AND TOUBRO', 'LARSEN TOUBRO'],
            BAJFINANCE: ['BAJAJ FINANCE'],
            KOTAKBANK: ['KOTAK BANK', 'KOTAK MAHINDRA BANK'],
            AXISBANK: ['AXIS BANK'],
            TATAMOTORS: ['TATA MOTORS'],
            MARUTI: ['MARUTI SUZUKI', 'MSIL'],
            HINDUNILVR: ['HUL', 'HINDUSTAN UNILEVER'],
            ADANIENT: ['ADANI ENTERPRISES'],
            ADANIPORTS: ['ADANI PORTS'],
            SUNPHARMA: ['SUN PHARMACEUTICAL'],
            ULTRACEMCO: ['ULTRATECH CEMENT'],
            ASIANPAINT: ['ASIAN PAINTS'],
            BAJAJFINSV: ['BAJAJ FINSERV'],
            TITAN: ['TITAN COMPANY'],
            POWERGRID: ['POWER GRID CORP'],
            COALINDIA: ['COAL INDIA'],
            JSWSTEEL: ['JSW STEEL'],
            TATASTEEL: ['TATA STEEL'],
            NESTLEIND: ['NESTLE INDIA'],
            BRITANNIA: ['BRITANNIA INDUSTRIES'],
            DRREDDY: ['DR REDDYS LABORATORIES'],
            CIPLA: ['CIPLA LIMITED'],
            DIVISLAB: ['DIVIS LABORATORIES'],
            APOLLOHOSP: ['APOLLO HOSPITALS'],
            BHARTIARTL: ['AIRTEL', 'BHARTI AIRTEL'],
            TECHM: ['TECH MAHINDRA'],
            WIPRO: ['WIPRO LIMITED'],
            HCLTECH: ['HCL TECHNOLOGIES'],
            INDUSINDBK: ['INDUSIND BANK'],
            ONGC: ['OIL AND NATURAL GAS'],
            BPCL: ['BHARAT PETROLEUM'],
            IOC: ['INDIAN OIL CORPORATION'],
            HEROMOTOCO: ['HERO MOTOCORP'],
            EICHERMOT: ['EICHER MOTORS'],
            MM: ['MAHINDRA AND MAHINDRA'],
            BAJAJ_AUTO: ['BAJAJ AUTO'],
            NTPC: ['NTPC LIMITED'],
            GRASIM: ['GRASIM INDUSTRIES'],
            // Crypto instruments use CRYPTO_BASE_NAMES injected into searchKeywords (bidirectional,
            // ranking-aware). Synonyms here would only be one-directional and are not needed.
        },
    }, { headers: h });
}
// ─── SQL template (pivot kite + vortex tokens in one query) ──────────────────
const SELECT_COLS = `
  u.id,
  u.canonical_symbol,
  u.exchange,
  u.underlying,
  u.instrument_type,
  u.expiry::text,
  u.strike::text,
  u.option_type,
  u.lot_size,
  u.tick_size::text,
  u.name,
  u.segment,
  u.is_active,
  u.asset_class,
  u.updated_at::text,
  MAX(CASE WHEN m.provider = 'kite'    THEN m.provider_token ELSE NULL END) AS kite_token,
  MAX(CASE WHEN m.provider = 'vortex'  THEN m.provider_token ELSE NULL END) AS vortex_token,
  MAX(CASE WHEN m.provider = 'massive' THEN m.provider_token ELSE NULL END) AS massive_token,
  MAX(CASE WHEN m.provider = 'binance' THEN m.provider_token ELSE NULL END) AS binance_token
`;
const FROM_JOIN = `
  FROM universal_instruments u
  LEFT JOIN instrument_mappings m ON m.uir_id = u.id
`;
async function upsertBatch(meiliBase, headers, index, docs) {
    await axios_1.default.post(`${meiliBase}/indexes/${index}/documents?primaryKey=id`, docs, { headers });
}
// ─── Modes ───────────────────────────────────────────────────────────────────
async function backfill() {
    const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700');
    const meiliKey = env('MEILI_MASTER_KEY', '');
    const index = env('MEILI_INDEX', 'instruments_v1');
    const headers = meiliKey
        ? { Authorization: `Bearer ${meiliKey}` }
        : {};
    const batchSize = Number(env('INDEXER_BATCH_SIZE', '2000'));
    await axios_1.default
        .post(`${meiliBase}/indexes`, { uid: index, primaryKey: 'id' }, { headers })
        .catch((e) => {
        var _a;
        if (((_a = e === null || e === void 0 ? void 0 : e.response) === null || _a === void 0 ? void 0 : _a.status) !== 409)
            throw e;
    });
    await applySettings(meiliBase, meiliKey, index);
    const exchangeFilter = env('INDEXER_EXCHANGE_FILTER');
    const filterClause = exchangeFilter
        ? `AND u.exchange = '${exchangeFilter.toUpperCase()}'`
        : '';
    const total = await withPg(async (pg) => {
        const r = await pg.query(`SELECT COUNT(*)::int AS n FROM universal_instruments u WHERE u.is_active = true ${filterClause}`);
        return r.rows[0].n;
    });
    // eslint-disable-next-line no-console
    console.log(`[indexer] backfill start: total=${total}, batchSize=${batchSize}${exchangeFilter ? `, exchange=${exchangeFilter}` : ''}`);
    let offset = 0;
    while (offset < total) {
        const rows = await withPg(async (pg) => {
            const r = await pg.query(`SELECT ${SELECT_COLS} ${FROM_JOIN}
         WHERE u.is_active = true ${filterClause}
         GROUP BY u.id
         ORDER BY u.id ASC
         OFFSET $1 LIMIT $2`, [offset, batchSize]);
            return r.rows;
        });
        if (!rows.length)
            break;
        await upsertBatch(meiliBase, headers, index, rows.map(toDoc));
        offset += rows.length;
        // eslint-disable-next-line no-console
        console.log(`[indexer] upserted ${offset}/${total}`);
    }
    // eslint-disable-next-line no-console
    console.log('[indexer] backfill complete');
}
async function incremental() {
    var _a;
    const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700');
    const meiliKey = env('MEILI_MASTER_KEY', '');
    const headers = meiliKey
        ? { Authorization: `Bearer ${meiliKey}` }
        : {};
    const index = env('MEILI_INDEX', 'instruments_v1');
    const pollSec = Number(env('INDEXER_POLL_SEC', '300'));
    let since = (_a = env('INDEXER_SINCE')) !== null && _a !== void 0 ? _a : new Date(Date.now() - pollSec * 1000).toISOString();
    // eslint-disable-next-line no-console
    console.log(`[indexer] incremental watcher poll=${pollSec}s`);
    for (;;) {
        const rows = await withPg(async (pg) => {
            const r = await pg.query(`SELECT ${SELECT_COLS} ${FROM_JOIN}
         WHERE u.updated_at >= $1
         GROUP BY u.id
         ORDER BY u.updated_at ASC
         LIMIT 5000`, [since]);
            return r.rows;
        });
        if (rows.length) {
            await upsertBatch(meiliBase, headers, index, rows.map(toDoc));
            since = rows[rows.length - 1].updated_at;
            // eslint-disable-next-line no-console
            console.log(`[indexer] incremental upserted ${rows.length}, since=${since}`);
        }
        await new Promise((r) => setTimeout(r, pollSec * 1000));
    }
}
async function applySynonymsFromRedis() {
    // eslint-disable-next-line no-console
    console.log('[synonyms] reading from Redis counters');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require('ioredis');
    const redis = new IORedis({
        host: env('REDIS_HOST', 'redis'),
        port: Number(env('REDIS_PORT', '6379')),
        lazyConnect: false,
    });
    try {
        const qSymCounts = {};
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'syn:q:*', 'COUNT', 500);
            cursor = nextCursor;
            if (keys.length) {
                // Use mget instead of pipeline to avoid blocked exec() pattern
                const values = await redis.mget(...keys);
                for (let i = 0; i < keys.length; i++) {
                    const val = Number(values[i] || 0);
                    if (!val)
                        continue;
                    const match = keys[i].match(/^syn:q:(.+):sym:(.+)$/);
                    if (!match)
                        continue;
                    const [, q, sym] = match;
                    if (!qSymCounts[sym])
                        qSymCounts[sym] = {};
                    qSymCounts[sym][q] = (qSymCounts[sym][q] || 0) + val;
                }
            }
        } while (cursor !== '0');
        const MIN_COUNT = Number(env('SYN_MIN_COUNT', '3'));
        const MAX_PER_SYMBOL = Number(env('SYN_MAX_PER_SYMBOL', '10'));
        const dynamicSyn = {};
        for (const [sym, counts] of Object.entries(qSymCounts)) {
            const pairs = Object.entries(counts)
                .filter(([, n]) => n >= MIN_COUNT)
                .sort((a, b) => b[1] - a[1])
                .slice(0, MAX_PER_SYMBOL)
                .map(([q]) => q);
            if (pairs.length) {
                dynamicSyn[sym] = Array.from(new Set([...(dynamicSyn[sym] || []), ...pairs]));
                pairs.forEach((q) => {
                    dynamicSyn[q] = Array.from(new Set([...(dynamicSyn[q] || []), sym]));
                });
            }
        }
        const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700');
        const meiliKey = env('MEILI_MASTER_KEY', '');
        const index = env('MEILI_INDEX', 'instruments_v1');
        const h = meiliKey
            ? { Authorization: `Bearer ${meiliKey}` }
            : {};
        const existing = await axios_1.default
            .get(`${meiliBase}/indexes/${index}/settings`, { headers: h })
            .then((r) => r.data || {})
            .catch(() => ({}));
        await axios_1.default.patch(`${meiliBase}/indexes/${index}/settings`, { synonyms: { ...((existing === null || existing === void 0 ? void 0 : existing.synonyms) || {}), ...dynamicSyn } }, { headers: h });
        // eslint-disable-next-line no-console
        console.log(`[synonyms] applied ${Object.keys(dynamicSyn).length} dynamic synonym entries`);
    }
    finally {
        await redis.quit().catch(() => { });
    }
}
// ─── Entry ───────────────────────────────────────────────────────────────────
async function main() {
    const mode = env('INDEXER_MODE', 'backfill');
    // eslint-disable-next-line no-console
    console.log(`[indexer] mode=${mode}`);
    if (mode === 'backfill') {
        await backfill();
    }
    else if (mode === 'incremental') {
        await incremental();
    }
    else if (mode === 'backfill-and-watch') {
        await backfill();
        await incremental();
    }
    else if (mode === 'synonyms-apply') {
        await applySynonymsFromRedis();
    }
    else if (mode === 'settings-apply') {
        const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700');
        const meiliKey = env('MEILI_MASTER_KEY', '');
        const index = env('MEILI_INDEX', 'instruments_v1');
        await applySettings(meiliBase, meiliKey, index);
        // eslint-disable-next-line no-console
        console.log('[indexer] settings-apply complete');
    }
    else {
        // eslint-disable-next-line no-console
        console.error(`[indexer] unknown INDEXER_MODE=${mode}`);
        process.exit(2);
    }
}
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[indexer] fatal', (e === null || e === void 0 ? void 0 : e.stack) || e);
    process.exit(1);
});
