/**
 * @file apps/search-indexer/src/index.ts
 * @module search-indexer
 * @description Batch and incremental sync of universal_instruments into MeiliSearch.
 *              Joins instrument_mappings to embed kite/vortex/massive/binance provider tokens
 *              per document and precomputes streamProvider via the canonical exchange→provider map.
 *              Supports modes: backfill | incremental | backfill-and-watch | synonyms-apply | settings-apply.
 * @author BharatERP
 * @created 2025-12-01
 * @updated 2026-06-23
 */

import axios from 'axios';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

import { lastThursdayOfMonth, weekOfMonth } from './index-helpers';

// ─── Types ───────────────────────────────────────────────────────────────────

type UniversalRow = {
  id: string; // bigint comes as string from pg
  canonical_symbol: string; // e.g. "NSE:RELIANCE"
  exchange: string;
  underlying: string;
  instrument_type: string;
  expiry: string | null;
  strike: string | null;
  option_type: string | null;
  lot_size: number;
  tick_size: string;
  name: string;
  segment: string;
  is_active: boolean;
  asset_class: string;
  updated_at: string;
  kite_token: string | null; // pivoted from instrument_mappings (provider='kite', provider_token)
  vortex_token: string | null; // pivoted from instrument_mappings (provider='vortex', provider_token like "NSE_EQ-22")
  massive_token: string | null; // pivoted from instrument_mappings (provider='massive', symbol string e.g. "AAPL")
  binance_token: string | null; // pivoted from instrument_mappings (provider='binance', symbol string e.g. "BTCUSDT")
};

/** Internal provider name a frontend can display / filter by. Mirrors InternalProviderName in src/. */
type StreamProviderName = 'kite' | 'vortex' | 'massive' | 'binance';

type MeiliDoc = {
  id: number;
  canonicalSymbol: string;
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrumentType: string;
  assetClass: string;
  optionType: string | null;
  expiry: string | null;
  strike: number | null;
  lotSize: number;
  tickSize: number;
  isActive: boolean;
  isDerivative: boolean;
  vortexExchange: string;
  underlyingSymbol?: string;
  kiteToken?: number;
  vortexToken?: number;
  /** Massive symbol (e.g. "AAPL", "EURUSD"). Strings — Massive has no numeric instrument tokens. */
  massiveToken?: string;
  /** Binance Spot symbol (e.g. "BTCUSDT"). Strings — Binance has no numeric instrument tokens. */
  binanceToken?: string;
  /**
   * Which provider streams this instrument (canonical routing fact derived from `exchange`).
   * Lets the search-api / frontend show "Live via Binance" without an extra registry lookup,
   * and lets clients filter `?streamProvider=binance` for crypto-only views.
   */
  streamProvider?: StreamProviderName;
  /** True if the expiry is the last Thursday of its calendar month AND the instrument is an F&O derivative. Null for non-derivatives. */
  isMonthly?: boolean;
  /** True if the expiry falls on a Thursday AND the instrument is an F&O derivative. Null for non-derivatives. */
  isWeekly?: boolean;
  /** Week-of-month (1-5) for the expiry date. Null for non-derivatives. */
  expiryWeek?: number;
  /** Calendar month (1-12) for the expiry date. Null for non-derivatives. */
  expiryMonth?: number;
  /** Calendar year for the expiry date. Null for non-derivatives. */
  expiryYear?: number;
  /** Unix seconds (UTC, 09:15 IST) of the expiry — used for sort when isMonthly=true. Null for non-derivatives. */
  monthlyExpiryDate?: number;
  /** Alias tokens for symbol-name lookups (e.g. ['RELIANCE', 'RIL', ...]). Additive to existing searchKeywords. */
  tokenKeywords?: string[];
  searchKeywords: string[];
  /** Full human name of the coin (e.g. "Bitcoin" for BTCUSDT). Only set for crypto instruments.
   *  Placed first in searchableAttributes so crypto name searches rank above US equity funds. */
  coinFullName?: string;
  /**
   * Broker-style sort order within a relevance tier:
   *   0 = equity / spot / ETF / index (non-derivative)
   *   1 = futures
   *   2 = options (CE + PE, sorted further by expiry → strike → optionType)
   */
  rankOrder: number;
  /**
   * Exchange preference within a relevance + rankOrder tier:
   *   0 = NSE (primary Indian equity exchange)
   *   1 = BSE
   *   2 = NFO / BFO / MCX / CDS / BCD (derivative segments)
   *   9 = everything else (US, CRYPTO, BINANCE, etc.)
   * Ensures NSE:RELIANCE sorts before BSE:RELIANCE when relevance is equal.
   */
  exchangeRank: number;
  /** Unix timestamp of expiry — enables numeric sort for nearest-expiry first.
   *  Non-derivatives get 9999999999 (sorts last). */
  expiryTs: number;
};

/**
 * Canonical exchange → streaming provider map. **Mirror of**
 * `src/shared/utils/exchange-to-provider.util.ts` — duplicated here because the
 * search-indexer is a separate Docker container with no `src/` import path.
 * Keep these two literals in sync when adding new providers/exchanges.
 */
const EXCHANGE_TO_PROVIDER: Readonly<Record<string, StreamProviderName>> = {
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

const CRYPTO_BASE_NAMES: Record<string, string> = {
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
function extractCoinBase(symbol: string): string {
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

function env(key: string, def?: string): string | undefined {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : def;
}

async function withPg<T>(fn: (client: any) => Promise<T>): Promise<T> {
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
  } finally {
    await client.end();
  }
}

function toVortexExchange(
  exchange: string,
  segment: string,
  instrumentType: string,
): string {
  const ex = exchange.toUpperCase();
  const seg = (segment || '').toUpperCase();
  const it = (instrumentType || '').toUpperCase();
  if (ex === 'MCX' || seg.includes('MCX')) return 'MCX_FO';
  if (seg.includes('CDS') || seg.includes('CUR') || it.includes('CUR'))
    return 'NSE_CUR';
  if (
    it === 'FUT' ||
    it === 'CE' ||
    it === 'PE' ||
    seg.includes('FO') ||
    seg.includes('FNO')
  )
    return 'NSE_FO';
  return 'NSE_EQ';
}

function toDoc(r: UniversalRow): MeiliDoc {
  const symbol = (r.underlying || '').toUpperCase();
  const it = (r.instrument_type || '').toUpperCase();
  const isDerivative = it === 'FUT' || it === 'CE' || it === 'PE';
  const rankOrder = !isDerivative ? 0 : it === 'FUT' ? 1 : 2; // 0=equity 1=futures 2=options
  const ex = (r.exchange || '').toUpperCase();
  const exchangeRank =
    ex === 'NSE'
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
    ? (symbol.match(/^[A-Z]+/)?.[0] ?? undefined)
    : undefined;
  const vortexExchange = toVortexExchange(
    r.exchange,
    r.segment,
    r.instrument_type,
  );

  // Vortex provider_token is "NSE_EQ-22" — split on last '-' and take the numeric tail for vortexToken.
  // (Older indexer code just pulled m.instrument_token; we now share the same string-pivot column the
  // other providers use, so do the parse here.)
  let vortexToken: number | undefined;
  if (r.vortex_token) {
    const dash = r.vortex_token.lastIndexOf('-');
    const tail = dash >= 0 ? r.vortex_token.slice(dash + 1) : r.vortex_token;
    const n = Number(tail);
    if (Number.isFinite(n)) vortexToken = n;
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
  let streamProvider: StreamProviderName | undefined =
    EXCHANGE_TO_PROVIDER[r.exchange];
  if (!streamProvider) {
    if (vortexToken !== undefined) streamProvider = 'vortex';
    else if (kiteToken !== undefined) streamProvider = 'kite';
    else if (binanceToken) streamProvider = 'binance';
    else if (massiveToken) streamProvider = 'massive';
  }

  // Compute expiry-derived enrichment fields (only meaningful for F&O derivatives with non-null expiry).
  let isMonthly: boolean | undefined;
  let isWeekly: boolean | undefined;
  let expiryWeek: number | undefined;
  let expiryMonth: number | undefined;
  let expiryYear: number | undefined;
  let monthlyExpiryDate: number | undefined;
  if (isDerivative && r.expiry) {
    const expiryStr = String(r.expiry).slice(0, 10);
    const [yy, mm, dd] = expiryStr.split('-').map((s) => Number(s));
    if (Number.isFinite(yy) && Number.isFinite(mm) && Number.isFinite(dd)) {
      const expiryDate = new Date(yy, mm - 1, dd);
      const dow = expiryDate.getDay();
      isWeekly = dow === 4;
      isMonthly = dow === 4 && dd === lastThursdayOfMonth(yy, mm);
      expiryWeek = weekOfMonth(yy, mm, dd);
      expiryMonth = mm;
      expiryYear = yy;
      monthlyExpiryDate = isMonthly
        ? Math.floor(new Date(expiryStr + 'T09:15:00Z').getTime() / 1000)
        : undefined;
    }
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
    expiryTs: r.expiry
      ? Math.floor(
          new Date(String(r.expiry).slice(0, 10) + 'T09:15:00Z').getTime() /
            1000,
        )
      : 9999999999,
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
    isMonthly,
    isWeekly,
    expiryWeek,
    expiryMonth,
    expiryYear,
    monthlyExpiryDate,
    ...(() => {
      const isCrypto =
        r.exchange === 'BINANCE' || (r.asset_class || '') === 'crypto';
      if (!isCrypto) {
        const tk = [symbol, r.name].filter(Boolean) as string[];
        const strippedName = r.name
          ? r.name.toUpperCase().replace(/[^A-Z0-9]/g, '')
          : undefined;
        if (strippedName) tk.push(strippedName);
        return {
          searchKeywords: tk,
          exactName: strippedName,
          tokenKeywords: tk,
        };
      }
      const base = extractCoinBase(symbol);
      const fullName = CRYPTO_BASE_NAMES[base];
      const kw: string[] = [symbol, r.name].filter(Boolean) as string[];
      if (fullName) kw.push(fullName);
      if (
        symbol.length > 4 &&
        (symbol.endsWith('USDT') ||
          symbol.endsWith('USDC') ||
          symbol.endsWith('BTC'))
      ) {
        kw.push(`${base}/${symbol.slice(-4)}`);
      }
      // Only USDT-quoted pairs get coinFullName so "ethereum" → ETHUSDT, not ETHBTC.
      // Both are equally relevant on coinFullName otherwise; USDT is the canonical USD price.
      const isUsdtQuoted = symbol.endsWith('USDT') || symbol.endsWith('USDC');
      return {
        searchKeywords: kw,
        coinFullName: fullName && isUsdtQuoted ? fullName : undefined,
        exactName: r.name
          ? r.name.toUpperCase().replace(/\s+/g, '')
          : undefined,
        tokenKeywords: kw,
      };
    })(),
  };
}

// ─── Expired derivatives cleanup ─────────────────────────────────────────────

/**
 * Fetch IDs of expired FUT/CE/PE contracts from the DB.
 * Returns numeric UIR ids as number[] for MeiliSearch deletion.
 */
async function fetchExpiredDerivativeIds(): Promise<number[]> {
  return withPg(async (pg) => {
    const cutoff = new Date().toISOString().slice(0, 10);
    const r = await pg.query(
      `SELECT id::bigint AS id FROM universal_instruments
       WHERE expiry < $1
         AND instrument_type IN ('FUT', 'CE', 'PE')
         AND is_active = false`,
      [cutoff],
    );
    return r.rows.map((row: { id: { toString(): string } }) =>
      Number(row.id.toString()),
    );
  });
}

/**
 * Fetch every MeiliSearch document id (paginated). Used by `backfill()` to
 * detect stale rows — docs that exist in the index but no longer in the DB.
 * Meili's documents endpoint is paginated; we walk all pages with the
 * `offset`/`limit` cursor and only request the `id` field to keep payload
 * small on large indexes.
 */
async function fetchAllIndexedIds(
  meiliBase: string,
  headers: Record<string, string>,
  index: string,
): Promise<number[]> {
  const ids: number[] = [];
  let offset = 0;
  const pageSize = 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await axios.get(`${meiliBase}/indexes/${index}/documents`, {
      headers,
      params: { offset, limit: pageSize, fields: 'id' },
    });
    const results = (resp.data?.results || []) as Array<{
      id: number | string;
    }>;
    if (results.length === 0) break;
    for (const row of results) ids.push(Number(row.id));
    if (results.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

/**
 * Delete expired instruments from MeiliSearch by their UIR ids.
 * MeiliSearch deleteDocuments accepts an array of primary keys.
 */
async function deleteFromMeiliSearch(
  meiliBase: string,
  headers: Record<string, string>,
  index: string,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const batchSize = 1000;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await axios.delete(`${meiliBase}/indexes/${index}/documents`, {
      headers,
      data: batch,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[expired-cleanup] deleted batch ${Math.floor(i / batchSize) + 1} (${batch.length} docs)`,
    );
  }
}

/**
 * Standalone expired-cleanup mode: run once, delete expired instruments from MeiliSearch.
 * Called by the cron trigger HTTP endpoint AND when INDEXER_MODE=expired-cleanup.
 */
async function expiredCleanup(): Promise<{ deleted: number }> {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const index = env('MEILI_INDEX', 'instruments_v1')!;
  const headers: Record<string, string> = meiliKey
    ? { Authorization: `Bearer ${meiliKey}` }
    : {};

  const ids = await fetchExpiredDerivativeIds();
  if (ids.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[expired-cleanup] no expired derivatives to remove from MeiliSearch',
    );
    return { deleted: 0 };
  }

  await deleteFromMeiliSearch(meiliBase, headers, index, ids);
  // eslint-disable-next-line no-console
  console.log(
    `[expired-cleanup] deleted ${ids.length} expired instruments from MeiliSearch`,
  );
  return { deleted: ids.length };
}

/**
 * Tiny HTTP server that exposes POST /api/indexer/cleanup-expired
 * so the NestJS backend can trigger MeiliSearch cleanup after deactivating
 * expired rows in the DB. Runs alongside the normal indexer process when
 * INDEXER_HTTP_ENABLED=true.
 */
async function startHttpTriggerServer(): Promise<void> {
  const port = Number(env('INDEXER_HTTP_PORT', '3003'));
  const http = await import('http');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/api/indexer/cleanup-expired') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const result = await expiredCleanup();
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[expired-cleanup] HTTP trigger failed', e);
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((res) => server.listen(port, res));
  // eslint-disable-next-line no-console
  console.log(`[indexer-http] trigger server listening on port ${port}`);
}

// ─── MeiliSearch index settings ──────────────────────────────────────────────

async function applySettings(
  meiliBase: string,
  apiKey: string,
  index: string,
): Promise<void> {
  const h = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  await axios.patch(
    `${meiliBase}/indexes/${index}/settings`,
    {
      searchableAttributes: [
        'coinFullName', // P0: crypto full name (Bitcoin/Ethereum/Solana) — only Binance docs have this;
        // ranks crypto tickers above US equity funds that happen to mention the coin
        'symbol', // P1: direct ticker (RELIANCE, NIFTY, BTCUSDT)
        'exactName', // P2: normalized company name for exact match boost (e.g. "RELIANCEINDUSTRIES")
        'name', // P3: company/pair name (moved above canonicalSymbol)
        'canonicalSymbol', // P4: "NSE:RELIANCE"
        'underlyingSymbol', // P5: for F&O: "NIFTY" extracted from "NIFTY24JAN22000CE"
        'searchKeywords', // P6: combined fallback bag
        'tokenKeywords', // P7: alias tokens (e.g. RELIANCE+RIL); additive to existing fields
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
        // Natural-language expiry classification (only set on F&O derivatives)
        'isMonthly',
        'isWeekly',
        'expiryWeek',
        'expiryMonth',
        'expiryYear',
        'monthlyExpiryDate',
      ],
      sortableAttributes: [
        'symbol',
        'name',
        'rankOrder',
        'exchangeRank',
        'expiry',
        'expiryTs', // numeric sort = nearest expiry first
        'strike',
        'optionType',
        'monthlyExpiryDate', // numeric sort for nearest-monthly-expiry first
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
    },
    { headers: h },
  );
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

async function upsertBatch(
  meiliBase: string,
  headers: Record<string, string>,
  index: string,
  docs: MeiliDoc[],
): Promise<void> {
  await axios.post(
    `${meiliBase}/indexes/${index}/documents?primaryKey=id`,
    docs,
    { headers },
  );
}

// ─── Modes ───────────────────────────────────────────────────────────────────

async function backfill(): Promise<void> {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const index = env('MEILI_INDEX', 'instruments_v1')!;
  const headers: Record<string, string> = meiliKey
    ? { Authorization: `Bearer ${meiliKey}` }
    : {};
  const batchSize = Number(env('INDEXER_BATCH_SIZE', '2000'));

  await axios
    .post(`${meiliBase}/indexes`, { uid: index, primaryKey: 'id' }, { headers })
    .catch((e) => {
      if (e?.response?.status !== 409) throw e;
    });

  await applySettings(meiliBase, meiliKey, index);

  const exchangeFilter = env('INDEXER_EXCHANGE_FILTER');
  const filterClause = exchangeFilter
    ? `AND u.exchange = '${exchangeFilter.toUpperCase()}'`
    : '';

  const total: number = await withPg(async (pg) => {
    const r = await pg.query(
      `SELECT COUNT(*)::int AS n FROM universal_instruments u WHERE u.is_active = true ${filterClause}`,
    );
    return r.rows[0].n as number;
  });

  // eslint-disable-next-line no-console
  console.log(
    `[indexer] backfill start: total=${total}, batchSize=${batchSize}${exchangeFilter ? `, exchange=${exchangeFilter}` : ''}`,
  );

  let offset = 0;
  while (offset < total) {
    const rows: UniversalRow[] = await withPg(async (pg) => {
      const r = await pg.query(
        `SELECT ${SELECT_COLS} ${FROM_JOIN}
         WHERE u.is_active = true ${filterClause}
         GROUP BY u.id
         ORDER BY u.id ASC
         OFFSET $1 LIMIT $2`,
        [offset, batchSize],
      );
      return r.rows as UniversalRow[];
    });
    if (!rows.length) break;

    await upsertBatch(meiliBase, headers, index, rows.map(toDoc));
    offset += rows.length;
    // eslint-disable-next-line no-console
    console.log(`[indexer] upserted ${offset}/${total}`);
  }

  // After upserting all current DB rows, prune any docs that exist in Meili
  // but no longer exist in the DB. This prevents the index from accumulating
  // stale rows from previous indexer runs (e.g. when the schema/catalog
  // changes, when mappings are rebuilt, or when a provider stops streaming
  // an instrument). Without this, the index can balloon to 2x the DB size.
  const indexedIds = await fetchAllIndexedIds(meiliBase, headers, index);
  const dbIds = new Set<number>();
  await withPg(async (pg) => {
    const r = await pg.query(
      `SELECT id FROM universal_instruments WHERE is_active = true ${filterClause}`,
    );
    for (const row of r.rows) dbIds.add(Number(row.id));
  });
  const staleIds = indexedIds.filter((id) => !dbIds.has(id));
  if (staleIds.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[indexer] pruning ${staleIds.length} stale docs from Meili (not in DB)`,
    );
    await deleteFromMeiliSearch(meiliBase, headers, index, staleIds);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[indexer] no stale docs to prune`);
  }

  // eslint-disable-next-line no-console
  console.log('[indexer] backfill complete');
}

async function incremental(): Promise<void> {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const headers: Record<string, string> = meiliKey
    ? { Authorization: `Bearer ${meiliKey}` }
    : {};
  const index = env('MEILI_INDEX', 'instruments_v1')!;
  const pollSec = Number(env('INDEXER_POLL_SEC', '300'));

  let since =
    env('INDEXER_SINCE') ?? new Date(Date.now() - pollSec * 1000).toISOString();

  // eslint-disable-next-line no-console
  console.log(`[indexer] incremental watcher poll=${pollSec}s`);

  for (;;) {
    const rows: UniversalRow[] = await withPg(async (pg) => {
      const r = await pg.query(
        `SELECT ${SELECT_COLS} ${FROM_JOIN}
         WHERE u.updated_at >= $1
         GROUP BY u.id
         ORDER BY u.updated_at ASC
         LIMIT 5000`,
        [since],
      );
      return r.rows as UniversalRow[];
    });

    if (rows.length) {
      await upsertBatch(meiliBase, headers, index, rows.map(toDoc));
      since = rows[rows.length - 1].updated_at;
      // eslint-disable-next-line no-console
      console.log(
        `[indexer] incremental upserted ${rows.length}, since=${since}`,
      );
    }

    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

async function applySynonymsFromRedis(): Promise<void> {
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
    const qSymCounts: Record<string, Record<string, number>> = {};
    let cursor = '0';
    do {
      const [nextCursor, keys]: [string, string[]] = await redis.scan(
        cursor,
        'MATCH',
        'syn:q:*',
        'COUNT',
        500,
      );
      cursor = nextCursor;
      if (keys.length) {
        // Use mget instead of pipeline to avoid blocked exec() pattern
        const values: (string | null)[] = await redis.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          const val = Number(values[i] || 0);
          if (!val) continue;
          const match = keys[i].match(/^syn:q:(.+):sym:(.+)$/);
          if (!match) continue;
          const [, q, sym] = match;
          if (!qSymCounts[sym]) qSymCounts[sym] = {};
          qSymCounts[sym][q] = (qSymCounts[sym][q] || 0) + val;
        }
      }
    } while (cursor !== '0');

    const MIN_COUNT = Number(env('SYN_MIN_COUNT', '3'));
    const MAX_PER_SYMBOL = Number(env('SYN_MAX_PER_SYMBOL', '10'));
    const dynamicSyn: Record<string, string[]> = {};

    for (const [sym, counts] of Object.entries(qSymCounts)) {
      const pairs = Object.entries(counts)
        .filter(([, n]) => n >= MIN_COUNT)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PER_SYMBOL)
        .map(([q]) => q);
      if (pairs.length) {
        dynamicSyn[sym] = Array.from(
          new Set([...(dynamicSyn[sym] || []), ...pairs]),
        );
        pairs.forEach((q) => {
          dynamicSyn[q] = Array.from(new Set([...(dynamicSyn[q] || []), sym]));
        });
      }
    }

    const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
    const meiliKey = env('MEILI_MASTER_KEY', '')!;
    const index = env('MEILI_INDEX', 'instruments_v1')!;
    const h: Record<string, string> = meiliKey
      ? { Authorization: `Bearer ${meiliKey}` }
      : {};

    const existing = await axios
      .get(`${meiliBase}/indexes/${index}/settings`, { headers: h })
      .then((r) => r.data || {})
      .catch(() => ({}));

    await axios.patch(
      `${meiliBase}/indexes/${index}/settings`,
      { synonyms: { ...(existing?.synonyms || {}), ...dynamicSyn } },
      { headers: h },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[synonyms] applied ${Object.keys(dynamicSyn).length} dynamic synonym entries`,
    );
  } finally {
    await redis.quit().catch(() => {});
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = env('INDEXER_MODE', 'backfill');
  const httpEnabled = env('INDEXER_HTTP_ENABLED', 'false') === 'true';
  // eslint-disable-next-line no-console
  console.log(`[indexer] mode=${mode}, httpTrigger=${httpEnabled}`);

  if (mode === 'backfill') {
    await backfill();
  } else if (mode === 'incremental') {
    await incremental();
  } else if (mode === 'backfill-and-watch') {
    await backfill();
    await incremental();
  } else if (mode === 'synonyms-apply') {
    await applySynonymsFromRedis();
  } else if (mode === 'settings-apply') {
    const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
    const meiliKey = env('MEILI_MASTER_KEY', '')!;
    const index = env('MEILI_INDEX', 'instruments_v1')!;
    await applySettings(meiliBase, meiliKey, index);
    // eslint-disable-next-line no-console
    console.log('[indexer] settings-apply complete');
  } else if (mode === 'expired-cleanup') {
    // One-shot cleanup run (e.g. from a cron job in k8s/CI)
    const result = await expiredCleanup();
    // eslint-disable-next-line no-console
    console.log(`[indexer] expired-cleanup done: deleted=${result.deleted}`);
    return;
  }

  if (httpEnabled) {
    // Keep the HTTP trigger server alive alongside the main loop
    await startHttpTriggerServer();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[indexer] fatal', e?.stack || e);
  process.exit(1);
});
