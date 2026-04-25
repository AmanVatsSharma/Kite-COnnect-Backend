# search-indexer

## Purpose

One-shot / watch-mode indexer that syncs the `universal_instruments` + `instrument_mappings` Postgres tables into a MeiliSearch `instruments_v1` index. Runs as a Docker service alongside the stack; restarts are the mechanism for triggering a full re-index.

## Docker Compose

- Service name: `search-indexer`
- Container: `trading-search-indexer`
- No exposed ports — outbound only (Postgres + MeiliSearch)
- Depends on: `postgres` (healthy) + `meilisearch` (started)

## Modes (`INDEXER_MODE`)

| Mode | Behavior |
|------|----------|
| `backfill` | One-shot: index all active instruments from Postgres then exit |
| `incremental` | Poll `updated_at > last_sync` every `INDEXER_POLL_SEC` seconds indefinitely |
| `backfill-and-watch` | (Default) Full backfill then switches to incremental polling |
| `synonyms-apply` | Push synonym rules from Postgres/config to MeiliSearch then exit |

## SQL Query

```sql
SELECT u.id, u.canonical_symbol, u.symbol, u.name, u.exchange, u.segment,
       u.instrument_type, u.asset_class, u.option_type, u.expiry, u.strike,
       u.lot_size, u.tick_size, u.is_derivative, u.underlying,
       MAX(CASE WHEN m.provider = 'kite'   THEN m.instrument_token END) AS kite_token,
       MAX(CASE WHEN m.provider = 'vortex' THEN m.instrument_token END) AS vortex_token,
       MAX(CASE WHEN m.provider = 'vortex' THEN m.provider_token  END) AS vortex_provider_token
FROM universal_instruments u
LEFT JOIN instrument_mappings m ON m.uir_id = u.id
WHERE u.is_active = true
GROUP BY u.id
```

The `vortex_provider_token` (format `"NSE_EQ-22"`) is split by the indexer into `vortexExchange` and `vortexToken` in the MeiliSearch document.

## MeiliSearch Document Shape

```json
{
  "id": 42,
  "canonicalSymbol": "NSE:RELIANCE",
  "symbol": "RELIANCE",
  "name": "RELIANCE INDUSTRIES LTD",
  "exchange": "NSE",
  "segment": "EQ",
  "instrumentType": "EQ",
  "assetClass": "EQUITY",
  "kiteToken": 738561,
  "vortexToken": 22,
  "vortexExchange": "NSE_EQ",
  "expiry": null,
  "strike": null,
  "optionType": null,
  "lotSize": 1,
  "tickSize": 0.05,
  "isDerivative": false,
  "underlyingSymbol": "RELIANCE"
}
```

## Index Settings Applied on Each Run

- **searchableAttributes**: `["symbol", "canonicalSymbol", "name", "underlyingSymbol"]`
- **filterableAttributes**: `["exchange", "segment", "instrumentType", "vortexExchange", "optionType", "assetClass", "isDerivative", "expiry", "strike"]`
- **typoTolerance**: `{ minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } }`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MEILI_HOST | http://meilisearch:7700 | MeiliSearch URL |
| MEILI_MASTER_KEY | — | Required. MeiliSearch authentication key |
| MEILI_INDEX | instruments_v1 | Index name to sync into |
| INDEXER_MODE | backfill-and-watch | See modes table above |
| INDEXER_BATCH_SIZE | 2000 | Rows per upsert batch to MeiliSearch |
| INDEXER_POLL_SEC | 300 | Seconds between incremental sync polls |
| DB_HOST | postgres | Postgres service name |
| DB_PORT | 5432 | Postgres port |
| DB_USERNAME | trading_user | Postgres user |
| DB_PASSWORD | — | Required |
| DB_DATABASE | trading_app | Postgres database |

## Triggering a Full Re-index

```bash
./scripts/manage.sh reindex
# or directly:
docker compose restart search-indexer
docker compose logs -f search-indexer
```

## Sync Health Check

```bash
./scripts/check-meili-sync.sh
# Compares Meili document count vs Postgres active instrument count
# Validates facet coverage and samples 50 random documents
```

## Changelog

- **2026-04-22** — Initial implementation. Migrated from old `instruments`/`vortex_instruments` table queries to `universal_instruments` + `instrument_mappings` JOIN with vortex token pivot.
