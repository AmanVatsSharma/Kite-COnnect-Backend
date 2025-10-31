import axios from 'axios';
// Use require to avoid @types dependency in build image
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

type InstrumentRow = {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  expiry: string | null;
  strike: number | null;
  tick_size: number | null;
  lot_size: number | null;
  is_active: boolean;
  updated_at: string;
};

type VortexRow = {
  token: number;
  exchange: string;
  symbol: string;
  instrument_name?: string | null;
  expiry_date?: string | null;
  option_type?: string | null;
  strike_price?: number | null;
  tick?: number | null;
  lot_size?: number | null;
  updated_at: string;
};

// Lightweight CSV parser (header-based) with quoted field support and escaped quotes
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map((s) => s.trim());
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Remove UTF-8 BOM if present
  if (lines[0].charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0].slice(1);
  }
  const header = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = parts[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function env(key: string, def?: string) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v;
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

function normalizeVortexExchange(exchange?: string, segment?: string, instrumentType?: string): 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' {
  const ex = String(exchange || '').toUpperCase();
  const seg = String(segment || '').toUpperCase();
  const it = String(instrumentType || '').toUpperCase();
  if (ex.includes('MCX') || seg.includes('MCX')) return 'MCX_FO';
  if (seg.includes('CDS') || ex.includes('CDS') || seg.includes('CUR') || it.includes('CUR')) return 'NSE_CUR';
  if (seg.includes('FO') || seg.includes('FNO') || it.includes('FUT') || it.includes('OPT') || it.includes('IDX') || it.includes('STK')) return 'NSE_FO';
  return 'NSE_EQ';
}

function extractUnderlyingSymbol(tradingSymbol: string): string | undefined {
  const s = String(tradingSymbol || '').toUpperCase();
  // Take leading letters until first digit or delimiter
  const m = s.match(/^[A-Z]+/);
  return m?.[0] || undefined;
}

function toDoc(r: InstrumentRow) {
  const vortexExchange = normalizeVortexExchange(r.exchange, r.segment, r.instrument_type);
  const ticker = `${vortexExchange}_${r.tradingsymbol}`;
  const isDerivative = /FUT|OPT/i.test(String(r.instrument_type || ''));
  const underlyingSymbol = isDerivative ? extractUnderlyingSymbol(r.tradingsymbol) : undefined;
  return {
    instrumentToken: r.instrument_token,
    symbol: r.tradingsymbol,
    tradingSymbol: r.tradingsymbol,
    companyName: r.name,
    exchange: r.exchange,
    segment: r.segment,
    instrumentType: r.instrument_type,
    expiryDate: r.expiry || undefined,
    strike: r.strike ?? undefined,
    tick: r.tick_size ?? undefined,
    lotSize: r.lot_size ?? undefined,
    isTradable: !!r.is_active,
    vortexExchange,
    ticker,
    isDerivative,
    underlyingSymbol,
    searchKeywords: [r.tradingsymbol, r.name].filter(Boolean),
  };
}

async function applyIndexSettings(meiliBase: string, apiKey: string, index: string) {
  const h = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  // searchable, filterable, ranking rules, typo settings
  await axios.patch(
    `${meiliBase}/indexes/${index}/settings`,
    {
      searchableAttributes: [
        'symbol',
        'tradingSymbol',
        'companyName',
        'isin',
        'ticker',
        'underlyingSymbol',
        'searchKeywords',
      ],
      filterableAttributes: [
        'exchange',
        'segment',
        'instrumentType',
        'expiryDate',
        'strike',
        'tick',
        'lotSize',
        'isTradable',
        'vortexExchange',
        'isDerivative',
      ],
      sortableAttributes: ['symbol', 'companyName', 'segment', 'exchange'],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'exactness',
      ],
      synonyms: {
        NIFTY: ['NIFTY50', 'NIFTY 50'],
        BANKNIFTY: ['BANK NIFTY', 'BANK-NIFTY'],
        RELIANCE: ['RELI'],
        SBIN: ['STATE BANK', 'STATE BANK OF INDIA'],
        INFY: ['INFOSYS'],
        TCS: ['TATA CONSULTANCY', 'TATA CONSULTANCY SERVICES'],
        HDFCBANK: ['HDFC BANK'],
        ICICIBANK: ['ICICI BANK'],
        LT: ['LARSEN & TOUBRO', 'LARSEN AND TOUBRO'],
      },
      // Note: synonyms can be extended later by writing to /settings/synonyms
    },
    { headers: h },
  );
}

async function backfill() {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const index = env('MEILI_INDEX', 'instruments_v1')!;

  const headers = meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {};

  // Ensure index exists with primary key (POST /indexes)
  await axios
    .post(
      `${meiliBase}/indexes`,
      { uid: index, primaryKey: 'instrumentToken' },
      { headers },
    )
    .catch((e) => {
      // 409 if already exists; ignore
      if (!(e?.response?.status === 409)) throw e;
    });

  await applyIndexSettings(meiliBase, meiliKey, index);

  const batchSize = Number(env('INDEXER_BATCH_SIZE', '1000'));
  // Console logs for visibility
  // eslint-disable-next-line no-console
  console.log(`[indexer] starting backfill, batchSize=${batchSize}`);

  let usedSource: 'postgres' | 'csv' | 'none' = 'none';
  let total = 0;
  try {
    total = await withPg(async (pg) => {
      const res = await pg.query('SELECT COUNT(*)::int AS n FROM instruments');
      return res.rows[0].n as number;
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.log(`[indexer] Postgres not reachable (${e?.message}). Will try CSV if available.`);
    total = 0;
  }
  // eslint-disable-next-line no-console
  console.log(`[indexer] active instruments=${total}`);

  if (total > 0) {
    usedSource = 'postgres';
    let offset = 0;
    while (offset < total) {
      const rows = await withPg(async (pg) => {
        const res = await pg.query(
          `SELECT instrument_token, tradingsymbol, name, exchange, segment, instrument_type, expiry, strike, tick_size, lot_size, is_active, updated_at
           FROM instruments ORDER BY instrument_token ASC OFFSET $1 LIMIT $2`,
          [offset, batchSize],
        );
        return (res.rows || []) as InstrumentRow[];
      });
      if (!rows.length) break;
      const docs = rows.map(toDoc);
      await axios.post(
        `${meiliBase}/indexes/${index}/documents?primaryKey=instrumentToken`,
        docs,
        { headers },
      );
      offset += rows.length;
      // eslint-disable-next-line no-console
      console.log(`[indexer] upserted ${offset}/${total}`);
    }
    // eslint-disable-next-line no-console
    console.log('[indexer] backfill base complete (postgres). Proceeding with vortex enrichment...');

    // === Vortex enrichment pass: upsert minimal documents with authoritative vortexExchange and optional fields ===
    try {
      const resCount = await withPg(async (pg) => {
        const c = await pg.query('SELECT COUNT(*)::int AS n FROM vortex_instruments');
        return (c.rows?.[0]?.n as number) || 0;
      });
      // eslint-disable-next-line no-console
      console.log(`[indexer] vortex_instruments total=${resCount}`);
      let voffset = 0;
      const vbatch = batchSize;

      const toVortexDocMinimal = (r: VortexRow) => {
        const vex = normalizeVortexExchange(r.exchange, undefined, r.instrument_name || undefined);
        const isDerivative = /FUT|OPT/i.test(String(r.instrument_name || ''));
        const underlyingSymbol = isDerivative ? extractUnderlyingSymbol(r.symbol) : undefined;
        return {
          instrumentToken: r.token,
          // Only authoritative or additive fields here to avoid clobbering symbol/name
          vortexExchange: vex,
          isDerivative,
          underlyingSymbol,
          // include optional numeric details when present
          expiryDate: r.expiry_date || undefined,
          strike: r.strike_price ?? undefined,
          tick: r.tick ?? undefined,
          lotSize: r.lot_size ?? undefined,
        } as any;
      };

      while (voffset < resCount) {
        const vrows = await withPg(async (pg) => {
          const res = await pg.query(
            `SELECT token, exchange, symbol, instrument_name, expiry_date, option_type, strike_price, tick, lot_size, updated_at
             FROM vortex_instruments ORDER BY token ASC OFFSET $1 LIMIT $2`,
            [voffset, vbatch],
          );
          return (res.rows || []) as VortexRow[];
        });
        if (!vrows.length) break;
        const docs = vrows.map(toVortexDocMinimal);
        await axios.post(
          `${meiliBase}/indexes/${index}/documents?primaryKey=instrumentToken`,
          docs,
          { headers },
        );
        voffset += vrows.length;
        // eslint-disable-next-line no-console
        console.log(`[indexer] vortex enrich upserted ${voffset}/${resCount}`);
      }
      // eslint-disable-next-line no-console
      console.log('[indexer] backfill enrichment complete (vortex)');
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.log('[indexer] vortex enrichment skipped/failed:', e?.message || 'unknown');
    }
    return;
  }

  // Fallback: CSV-based backfill
  const csvUrl = env('INDEXER_CSV_URL') || env('VORTEX_INSTRUMENTS_CSV_URL') || 'https://static.rupeezy.in/master.csv';
  if (!csvUrl) {
    // eslint-disable-next-line no-console
    console.log('[indexer] No Postgres data and no CSV URL provided. Skipping backfill.');
    return;
  }
  usedSource = 'csv';
  // eslint-disable-next-line no-console
  console.log(`[indexer] Falling back to CSV source: ${csvUrl}`);
  const resp = await axios.get(csvUrl, { responseType: 'arraybuffer' });
  const csv = resp.data instanceof Buffer ? resp.data.toString('utf8') : String(resp.data);
  const records: any[] = parseCsv(csv);

  const toDocFromAny = (r: any) => {
    const pick = (keys: string[], def: any = undefined) => {
      for (const k of keys) {
        if (r[k] !== undefined && r[k] !== '') return r[k];
      }
      return def;
    };
    const toNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const token = toNum(pick(['instrument_token', 'instrumentToken', 'token']));
    if (!token) return null;
    const exchange = String(pick(['exchange'], ''));
    const segment = String(pick(['segment'], ''));
    const instrumentType = String(pick(['instrument_type', 'instrumentName', 'instrumentType'], ''));
    const vortexExchange = normalizeVortexExchange(exchange, segment, instrumentType);
    const symbol = String(pick(['symbol', 'tradingsymbol', 'tradingSymbol'], ''));
    const ticker = `${vortexExchange}_${symbol}`;
    const isDerivative = /FUT|OPT/i.test(instrumentType);
    const underlyingSymbol = isDerivative ? extractUnderlyingSymbol(symbol) : undefined;
    return {
      instrumentToken: token,
      symbol,
      tradingSymbol: symbol,
      companyName: pick(['name', 'companyName'], ''),
      exchange,
      segment,
      instrumentType,
      expiryDate: pick(['expiry', 'expiryDate'], undefined),
      strike: toNum(pick(['strike'])),
      tick: toNum(pick(['tick'])),
      lotSize: toNum(pick(['lot_size', 'lotSize'])),
      isTradable: true,
      vortexExchange,
      ticker,
      isDerivative,
      underlyingSymbol,
      searchKeywords: [
        symbol,
        pick(['name', 'companyName'], ''),
      ].filter(Boolean),
    };
  };

  const docs: any[] = [];
  for (const r of records) {
    const d = toDocFromAny(r);
    if (d) docs.push(d);
  }
  // chunked upserts
  const chunkSize = 2000;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const chunk = docs.slice(i, i + chunkSize);
    await axios.post(
      `${meiliBase}/indexes/${index}/documents?primaryKey=instrumentToken`,
      chunk,
      { headers },
    );
    // eslint-disable-next-line no-console
    console.log(`[indexer] csv upserted ${Math.min(i + chunk.length, docs.length)}/${docs.length}`);
  }
  // eslint-disable-next-line no-console
  console.log('[indexer] backfill complete (csv)');
}

// === Synonyms compiler from Redis counters ===
async function applySynonymsFromRedis() {
  // eslint-disable-next-line no-console
  console.log('[synonyms] starting apply from Redis counters');
  // Lazy require to avoid type deps
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = require('ioredis');
  const redisHost = env('REDIS_HOST', 'redis');
  const redisPort = Number(env('REDIS_PORT', '6379'));
  const redis = new IORedis({ host: redisHost, port: redisPort, lazyConnect: false });
  try {
    // Scan syn:q:* keys and aggregate q→symbol counts
    const qSymCounts: Record<string, Record<string, number>> = {};
    let cursor = '0';
    const pattern = 'syn:q:*';
    do {
      const resp = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = resp[0];
      const keys: string[] = resp[1] || [];
      if (keys.length) {
        const pipe = redis.pipeline();
        keys.forEach((k) => pipe.get(k));
        const results = await pipe.exec();
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const val = Number((results?.[i]?.[1] as any) || 0);
          if (!Number.isFinite(val) || val <= 0) continue;
          // key format: syn:q:<q>:sym:<symbol>
          const m = key.match(/^syn:q:(.+):sym:(.+)$/);
          if (!m) continue;
          const q = m[1];
          const sym = m[2];
          if (!qSymCounts[sym]) qSymCounts[sym] = {};
          qSymCounts[sym][q] = (qSymCounts[sym][q] || 0) + val;
        }
      }
    } while (cursor !== '0');

    // Build synonyms map
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
        dynamicSyn[sym] = Array.from(new Set([...(dynamicSyn[sym] || []), ...pairs]));
        pairs.forEach((q) => {
          dynamicSyn[q] = Array.from(new Set([...(dynamicSyn[q] || []), sym]));
        });
      }
    }

    const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
    const meiliKey = env('MEILI_MASTER_KEY', '')!;
    const index = env('MEILI_INDEX', 'instruments_v1')!;
    const headers = meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {};

    // Fetch current settings to merge
    let current: any = {};
    try {
      const s = await axios.get(`${meiliBase}/indexes/${index}/settings`, { headers });
      current = s?.data || {};
    } catch (e) {
      // ignore
    }
    const mergedSyn = { ...(current?.synonyms || {}), ...dynamicSyn };
    await axios.patch(
      `${meiliBase}/indexes/${index}/settings`,
      { synonyms: mergedSyn },
      { headers },
    );
    // eslint-disable-next-line no-console
    console.log(
      `[synonyms] applied: symbols=${Object.keys(qSymCounts).length}, entries=${Object.keys(dynamicSyn).length}`,
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[synonyms] apply failed', e);
  } finally {
    try {
      await redis.quit();
    } catch {}
  }
}

async function incremental() {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const headers = meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {};
  const index = env('MEILI_INDEX', 'instruments_v1')!;
  const pollSec = Number(env('INDEXER_POLL_SEC', '300'));
  let sinceIso = env('INDEXER_SINCE');
  let sinceVortexIso = env('INDEXER_VORTEX_SINCE');

  // eslint-disable-next-line no-console
  console.log(`[indexer] incremental watcher poll=${pollSec}s since=${sinceIso || 'auto'}`);

  for (;;) {
    // === instruments table incremental ===
    const since = sinceIso || new Date(Date.now() - pollSec * 1000).toISOString();
    const rows = await withPg(async (pg) => {
      const res = await pg.query(
        `SELECT instrument_token, tradingsymbol, name, exchange, segment, instrument_type, expiry, strike, lot_size, is_active, updated_at
         FROM instruments WHERE updated_at >= $1 ORDER BY updated_at ASC LIMIT 5000`,
        [since],
      );
      return (res.rows || []) as InstrumentRow[];
    });
    if (rows.length) {
      const docs = rows.map(toDoc);
      await axios.post(
        `${meiliBase}/indexes/${index}/documents?primaryKey=instrumentToken`,
        docs,
        { headers },
      );
      sinceIso = rows[rows.length - 1].updated_at;
      // eslint-disable-next-line no-console
      console.log(`[indexer] incremental(instruments) upserted ${rows.length}, since=${sinceIso}`);
    }

    // === vortex_instruments table incremental (authoritative vortexExchange enrichment) ===
    const sinceV = sinceVortexIso || new Date(Date.now() - pollSec * 1000).toISOString();
    const vrows = await withPg(async (pg) => {
      const res = await pg.query(
        `SELECT token, exchange, symbol, instrument_name, expiry_date, option_type, strike_price, tick, lot_size, updated_at
         FROM vortex_instruments WHERE updated_at >= $1 ORDER BY updated_at ASC LIMIT 5000`,
        [sinceV],
      );
      return (res.rows || []) as VortexRow[];
    });
    if (vrows.length) {
      const toVortexDocMinimal = (r: VortexRow) => {
        const vex = normalizeVortexExchange(r.exchange, undefined, r.instrument_name || undefined);
        const isDerivative = /FUT|OPT/i.test(String(r.instrument_name || ''));
        const underlyingSymbol = isDerivative ? extractUnderlyingSymbol(r.symbol) : undefined;
        return {
          instrumentToken: r.token,
          vortexExchange: vex,
          isDerivative,
          underlyingSymbol,
          expiryDate: r.expiry_date || undefined,
          strike: r.strike_price ?? undefined,
          tick: r.tick ?? undefined,
          lotSize: r.lot_size ?? undefined,
        } as any;
      };
      const vdocs = vrows.map(toVortexDocMinimal);
      await axios.post(
        `${meiliBase}/indexes/${index}/documents?primaryKey=instrumentToken`,
        vdocs,
        { headers },
      );
      sinceVortexIso = vrows[vrows.length - 1].updated_at;
      // eslint-disable-next-line no-console
      console.log(`[indexer] incremental(vortex) upserted ${vrows.length}, since=${sinceVortexIso}`);
    }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

async function main() {
  const mode = env('INDEXER_MODE', 'backfill');
  if (mode === 'backfill') {
    await backfill();
  } else if (mode === 'incremental') {
    await incremental();
  } else if (mode === 'backfill-and-watch') {
    await backfill();
    await incremental();
  } else if (mode === 'synonyms-apply') {
    await applySynonymsFromRedis();
  } else {
    // eslint-disable-next-line no-console
    console.log(`unknown INDEXER_MODE=${mode}`);
    process.exit(2);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[indexer] fatal', e);
  process.exit(1);
});


