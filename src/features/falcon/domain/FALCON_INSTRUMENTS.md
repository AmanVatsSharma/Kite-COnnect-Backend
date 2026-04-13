# Falcon Instruments Table

The `falcon_instruments` table stores instruments fetched from Kite (Falcon) instruments API.

## Entity

- Primary key: `instrument_token`
- Indexed columns: `tradingsymbol`, `exchange`, `instrument_type`, `segment`
- Fields mirror Kite CSV headers for lossless import

## Migration

- `1700000000003-create-falcon-instruments.ts` creates the table and indexes
- `1700000000004-add-description-to-falcon-instruments.ts` adds `description`

## Sync

### Automated (Vortex-style)

- A **daily cron** runs in `FalconInstrumentService` (registered in `onModuleInit` via `SchedulerRegistry`).
- **Schedule:** `FALCON_INSTRUMENTS_CRON` (default `45 9 * * *` — 09:45) in timezone `FALCON_INSTRUMENTS_CRON_TZ` (default `Asia/Kolkata`).
- **Disable:** set `FALCON_INSTRUMENT_SYNC_ENABLED=false`.
- **Retries:** up to 3 attempts with exponential backoff on failures (missing Kite credentials → no retry).
- **Preflight:** `KiteProviderService.refreshSession()` so Redis/env tokens are loaded before `getInstruments`.
- **Bulk write:** batched TypeORM `upsert` into `falcon_instruments` and `instrument_mappings` (`provider: kite`).
- **Reconciliation:** when `FALCON_INSTRUMENT_RECONCILE` is not `false`, rows that stay `is_active=true` but are **not** in the latest Kite dump are set to `is_active=false`. If sync uses `?exchange=NSE`, only rows with that `exchange` are scanned.

### Manual / SSE

- `POST /api/stock/falcon/instruments/sync` — optional `exchange` query param
- `POST /api/stock/falcon/instruments/sync/stream` (SSE) — progress every 1000 rows
- `GET /api/stock/falcon/instruments/sync/status?jobId=...` — Redis key `falcon:sync:job:{id}`

### Kite requirement

Unlike Vortex’s public CSV, Kite’s instruments list requires a valid **OAuth access token** (`KITE_ACCESS_TOKEN` or Redis `kite:access_token`). Without it, sync returns `skipped` / logs warning.

## Search & Stats

- `GET /api/stock/falcon/instruments/search?q=&limit=`
- `GET /api/stock/falcon/instruments/stats`

## Module changelog

See [MODULE_DOC.md](../MODULE_DOC.md).
