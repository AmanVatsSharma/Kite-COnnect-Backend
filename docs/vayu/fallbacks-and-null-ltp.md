## Missing/Null LTP Rules and Fallbacks

### When can LTP be null?
- Provider may omit last_trade_price for certain instruments at times (maintenance, illiquid, etc.).

### Server behavior
1) Snapshot (REST/WS get_quote):
   - Start with provider quotes (batched)
   - If last_price missing → try memory cache (last few seconds)
   - If still missing → try Redis last_tick (stream)
   - If still missing → single provider LTP batch for remaining

2) Streaming: Binary ticks always include last_price when present; the last tick is cached to Redis and memory.

### ltp_only filter
- If true, instruments with null/<=0 last_price are omitted from output.

### Token vs Pair semantics
- `/api/stock/vayu/ltp` supports:
  - `instruments` (token array) → response keyed by token (e.g., `{ "738561": { last_price: 123.45 } }`)
  - `pairs` (exchange-token array) → response keyed by `EXCHANGE-TOKEN` (e.g., `{ "NSE_EQ-738561": { last_price: 123.45 } }`)
- Milli-search uses `instruments`; other tools may use explicit `pairs` when exchange context is required.


