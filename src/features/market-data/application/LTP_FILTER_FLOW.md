# Vayu LTP Filter & Enrichment Flow

```mermaid
flowchart TD
  A[Client request\n(GET /vayu/instruments or /vayu/tickers/search)\ninclude_ltp=true, ltp_only?] --> B[DB query\nvortex_instruments with filters]
  B --> C{include_ltp?}
  C -- false --> D[Respond with instruments only\n(last_price=null)]
  C -- true --> E[Build pairs\nEXCHANGE-TOKEN from DB results]
  E --> F[Vortex quotes (mode=ltp)\nChunk <=1000, 1 req/sec]
  F --> G[Map LTP back to items\nlast_price or null]
  G --> H{ltp_only?}
  H -- true --> I[Filter out items with null/non-positive LTP]
  H -- false --> J[Keep all items]
  I --> K[Respond JSON\ninstruments[], pagination, include_ltp, ltp_only]
  J --> K[Respond JSON\ninstruments[], pagination, include_ltp, ltp_only]
```

Notes:
- No implicit NSE_EQ fallback. Exchange is taken from `vortex_instruments` rows included in the response.
- LTP source accepts either `last_trade_price` or `ltp` from Vortex quotes.
- Internal rate-limit: 1 request/second, chunk size: 1000 pairs.
- Cached LTP is used where available; provider is only called for misses.


