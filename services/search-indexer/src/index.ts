import axios from 'axios';
import { Client } from 'pg';

type InstrumentRow = {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  expiry: string | null;
  strike: number | null;
  lot_size: number | null;
  is_active: boolean;
  updated_at: string;
};

function env(key: string, def?: string) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v;
}

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
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

function toDoc(r: InstrumentRow) {
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
    lotSize: r.lot_size ?? undefined,
    isTradable: !!r.is_active,
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
        'searchKeywords',
      ],
      filterableAttributes: [
        'exchange',
        'segment',
        'instrumentType',
        'expiryDate',
        'strike',
        'lotSize',
        'isTradable',
      ],
      sortableAttributes: ['symbol', 'companyName', 'segment', 'exchange'],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'exactness',
      ],
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

  const total = await withPg(async (pg) => {
    const res = await pg.query('SELECT COUNT(*)::int AS n FROM instruments WHERE is_active = true');
    return res.rows[0].n as number;
  });
  // eslint-disable-next-line no-console
  console.log(`[indexer] active instruments=${total}`);

  let offset = 0;
  while (offset < total) {
    const rows = await withPg(async (pg) => {
      const res = await pg.query<InstrumentRow>(
        `SELECT instrument_token, tradingsymbol, name, exchange, segment, instrument_type, expiry, strike, lot_size, is_active, updated_at
         FROM instruments WHERE is_active = true ORDER BY instrument_token ASC OFFSET $1 LIMIT $2`,
        [offset, batchSize],
      );
      return res.rows;
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
  console.log('[indexer] backfill complete');
}

async function incremental() {
  const meiliBase = env('MEILI_HOST', 'http://meilisearch:7700')!;
  const meiliKey = env('MEILI_MASTER_KEY', '')!;
  const headers = meiliKey ? { Authorization: `Bearer ${meiliKey}` } : {};
  const index = env('MEILI_INDEX', 'instruments_v1')!;
  const pollSec = Number(env('INDEXER_POLL_SEC', '300'));
  let sinceIso = env('INDEXER_SINCE');

  // eslint-disable-next-line no-console
  console.log(`[indexer] incremental watcher poll=${pollSec}s since=${sinceIso || 'auto'}`);

  for (;;) {
    const since = sinceIso || new Date(Date.now() - pollSec * 1000).toISOString();
    const rows = await withPg(async (pg) => {
      const res = await pg.query<InstrumentRow>(
        `SELECT instrument_token, tradingsymbol, name, exchange, segment, instrument_type, expiry, strike, lot_size, is_active, updated_at
         FROM instruments WHERE updated_at >= $1 ORDER BY updated_at ASC LIMIT 5000`,
        [since],
      );
      return res.rows;
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
      console.log(`[indexer] incrementally upserted ${rows.length}, since=${sinceIso}`);
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


