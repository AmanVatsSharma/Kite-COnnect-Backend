## Vayu REST Alignment with Vortex

### Headers
- x-api-key: Required
- Authorization: Bearer <access_token> (Vayu provider flows only)

### Endpoints
- POST /api/stock/quotes?mode=ltp|ohlc|full&ltp_only=true|false
  - Body: { instruments: number[] }
  - Behavior: Batches provider calls; ensures 1/sec per endpoint; fills missing LTP via memory → Redis → provider LTP.

- POST /api/stock/ltp
- POST /api/stock/ohlc
- GET /api/stock/historical/:token?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=day|minute|…

### Query Mapping to Vortex
- Quotes: GET /data/quotes?q=EXCHANGE-TOKEN&mode=mode
- History: GET /data/history?exchange=EXCHANGE&token=TOKEN&from=UNIX&to=UNIX&resolution=RES

### ltp_only
- When true, instruments without a finite last_price (>0) are filtered out from the response.

### Error Handling
- 401/403 → Auth error; check Vayu session and Authorization header
- 429 → Rate limit; queued internally and retried after 1s + jitter
- 5xx/timeout → 502/504 to clients with structured message


