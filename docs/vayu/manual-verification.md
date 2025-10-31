## Vayu LTP – Manual Verification Guide

Use these steps to verify correct exchange handling for LTP across exchanges.

### Prerequisites
- Server running with Vayu credentials configured (`VORTEX_API_KEY`, `VORTEX_BASE_URL`, access token via `/auth/vayu/callback`).
- `vortex_instruments` synced (recommended) via `POST /api/stock/vayu/instruments/sync`.

### Verify explicit pairs (authoritative)

```bash
# Replace $BASE with your API origin
curl "$BASE/api/stock/vayu/ltp?q=NSE_EQ-22&q=NSE_FO-135938"
```

Expected:
- Keys in response are `EXCHANGE-TOKEN`, and FO price should be present when market is open.

### Verify JSON pairs

```bash
curl -X POST "$BASE/api/stock/vayu/ltp" \
  -H 'Content-Type: application/json' \
  -d '{
    "pairs": [
      { "exchange": "NSE_EQ", "token": "22" },
      { "exchange": "NSE_FO", "token": "135938" }
    ]
  }'
```

### Verify instruments mode (exchange resolution path)

```bash
curl -X POST "$BASE/api/stock/vayu/ltp" \
  -H 'Content-Type: application/json' \
  -d '{ "instruments": [22, 135938, 26000] }'
```

Expected:
- Exchange is resolved via: `vortex_instruments` → `instrument_mappings(vortex)` → legacy `instruments`.
- Tokens without a resolvable exchange return `{ last_price: null }` (not mislabeled as `NSE_EQ`).

### Logs to check
- `[Vortex] getLTP request: requested=..., querying=...`
- `[Vortex] getLTP: N tokens lack exchange mapping; skipping in request ...`
- `[Vortex] Exchange resolution summary: requested=..., resolved=..., via vi=..., map=...`

### Troubleshooting
- If FO/MCX tokens show null prices, ensure `vortex_instruments` are synced and provider session is valid.
- For guaranteed correctness, prefer `pairs` mode when you already know the exact `EXCHANGE-TOKEN`.


