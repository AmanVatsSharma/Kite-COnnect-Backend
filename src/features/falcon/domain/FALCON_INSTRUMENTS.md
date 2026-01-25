# Falcon Instruments Table

The `falcon_instruments` table stores instruments fetched from Kite (Falcon) instruments API.

## Entity
- Primary key: `instrument_token`
- Indexed columns: `tradingsymbol`, `exchange`, `instrument_type`, `segment`
- Fields mirror Kite CSV headers for lossless import

## Migration
- `1700000000003-create-falcon-instruments.ts` creates the table and indexes

## Sync Job
- Entry: `POST /api/stock/falcon/instruments/sync`
- Stream: `POST /api/stock/falcon/instruments/sync/stream` (SSE)
- Status: `GET /api/stock/falcon/instruments/sync/status?jobId=...`
- Progress is kept under Redis key `falcon:sync:job:{id}`

## Search & Stats
- `GET /api/stock/falcon/instruments/search?q=&limit=`
- `GET /api/stock/falcon/instruments/stats`


