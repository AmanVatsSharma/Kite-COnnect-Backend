# Vayu (Vortex) Instruments Sync - Live Status Flow

## Endpoints
- POST `/api/stock/vayu/instruments/sync/stream` (SSE)
  - Streams JSON events:
    - `{ event: "start", exchange }`
    - `{ event: "progress", phase, total, processed, synced, updated, errors, lastMessage, ts }`
    - `{ event: "complete", result, ts }`

- POST `/api/stock/vayu/instruments/sync?async=true`
  - Starts background job and returns `{ jobId }`
  - Poll: GET `/api/stock/vayu/instruments/sync/status?jobId=...`
  - Progress JSON structure (Redis):
    - `{ status: "started" | "running" | "completed" | "failed", progress?: { phase, total, processed, synced, updated, errors, lastMessage }, ts }`

## Phases
- `init`: Sync invocation received
- `fetch_csv`: CSV fetch and parse done
- `upsert`: Upserting rows (progress events every ~500 items)
- `complete`: Final result emitted

## Errors
- SSE stream emits `{ success: false, error }` before closing on failure
- Async job sets `status=failed` with `error` message

## Notes
- Exchange mapping remains authoritative from `vortex_instruments.exchange`; no implicit fallbacks.
- Rate limits: provider calls are internally throttled to 1 req/sec (quotes), per Vortex docs.

