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

- POST /api/stock/vayu/ltp
  - Body (either):
    - { instruments: number[] } → returns token-keyed map `{ [token]: { last_price } }`
    - { pairs: [{ exchange: 'NSE_EQ'|'NSE_FO'|'NSE_CUR'|'MCX_FO', token: string|number }] } → returns pair-keyed map `{ ['EXCHANGE-TOKEN']: { last_price } }`
  - Notes:
    - `instruments` path resolves exchange authoritatively:
      1) `vortex_instruments.exchange` → 2) `instrument_mappings(provider=vortex)` → 3) legacy `instruments.exchange/segment`.
      - Tokens without a resolvable exchange are skipped in the Vortex `q` construction and returned as `{ last_price: null }`.
      - This prevents mis-labeling all tokens as `NSE_EQ`.
    - Prefer the `pairs` path when you already know the exact `EXCHANGE-TOKEN` pairs (e.g., FO/MCX instruments).
    - Max 1000 tokens/pairs per request; internally batched and rate-limited (1 req/sec)

### Suggest endpoint filters
- `GET /api/search/suggest?q=&limit=&exchange=&segment=&instrumentType=&vortexExchange=&expiry_from=&expiry_to=&strike_min=&strike_max&ltp_only=`
  - `ltp_only=true` returns only items with valid last_price
  - Pair-based hydration is used when `vortexExchange` is present in the index documents

### Query Mapping to Vortex
- Quotes: GET /data/quotes?q=EXCHANGE-TOKEN&mode=mode
- History: GET /data/history?exchange=EXCHANGE&token=TOKEN&from=UNIX&to=UNIX&resolution=RES

### LTP Exchange Resolution Flow (instruments path)

```mermaid
flowchart TD
  A[Client tokens] --> B{Resolve exchange}

### Milli Search Hydration (pair-first + fallback)

```mermaid
sequenceDiagram
  participant UI as UI
  participant S as search-api
  participant H as trading-app (hydrator)
  participant V as Vortex REST

  UI->>S: GET /api/search?q=...
  S->>H: POST /api/stock/vayu/ltp { pairs }
  H->>V: GET /data/quotes?mode=ltp&q=EX-TOK...
  V-->>H: last_trade_price map
  H-->>S: pair-keyed LTP
  Note over S: Convert to token map and cache
  alt Any tokens without valid LTP
    S->>H: POST /api/stock/vayu/ltp { instruments }
    H->>V: GET /data/quotes?mode=ltp&q=EX-TOK (resolved)
    V-->>H: last_trade_price map
    H-->>S: token-keyed LTP
  end
  S-->>UI: Results with last_price
```

Notes:
- Hydrator sends headers `x-api-key` and `x-provider: vayu`.
- Pair path is preferred when `vortexExchange` is known in Meili docs; otherwise instruments path resolves exchanges.
  B -->|1) vortex_instruments| C[Map token → exchange]
  B -->|2) instrument_mappings(vortex)| C
  B -->|3) instruments(exchange/segment)| C
  C --> D{Has exchange?}
  D -->|Yes| E[Build q = EXCHANGE-TOKEN]
  D -->|No| F[Skip in request; output last_price=null]
  E --> G[Vortex /data/quotes?mode=ltp]
  G --> H[Map back to token → last_price]
  F --> H
```

### ltp_only
- When true, instruments without a finite last_price (>0) are filtered out from the response.

### Fast-path for vayu listings (equities/futures/options/commodities)
- For ltp_only=true the service uses a single-shot probe:
  - Fetch up to min(500, max(limit×4, limit+offset)) candidate instruments from DB with skip_count to avoid expensive COUNT(*)
  - Build authoritative EXCHANGE-TOKEN pairs from `vortex_instruments`
  - One provider call hydrates LTP via `/data/quotes?mode=ltp` (chunked <=1000)
  - Return the first N items with valid LTP
- Non-ltp_only paths hydrate using pair-based LTP (no NSE_EQ fallback).
- Responses include `performance.queryTime` in milliseconds.

### Error Handling
- 401/403 → Auth error; check Vayu session and Authorization header
- 429 → Rate limit; queued internally and retried after 1s + jitter
- 5xx/timeout → 502/504 to clients with structured message


