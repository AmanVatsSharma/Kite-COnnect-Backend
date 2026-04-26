# binance feature

Binance.com (global) Spot market-data provider. Implements the `MarketDataProvider` interface so the market-data gateway streams crypto pairs (BTCUSDT, ETHUSDT, …) through the same Socket.IO/native-WS surface used for Kite (Indian equities) and Vortex (Rupeezy) and Massive (US/FX/crypto).

Public market data is **free and unauthenticated**. There is no API key for streaming — Binance's `/api/v3/exchangeInfo`, `/api/v3/ticker/price`, `/api/v3/klines`, and `wss://stream.binance.com:9443/stream` all accept anonymous calls.

> **Geo-block warning:** `binance.com` (global) is blocked from US IP ranges. Deploy the backend on a non-US region (Asia/EU/etc.) — or switch the constants to `binance.us` if your servers must run from the US.

## Provider selection

- `DATA_PROVIDER=binance` — default for HTTP REST.
- `x-provider: binance` HTTP header — per-request override.
- `POST /api/admin/provider/global {"provider":"binance"}` — switch the global default.
- The streaming layer routes per-instrument via `EXCHANGE_TO_PROVIDER['BINANCE'] = 'binance'`, so any UIR row with `exchange='BINANCE'` always streams through Binance regardless of the global provider.

## Configuration

| Variable | Description |
|---|---|
| `BINANCE_INSTRUMENT_SYNC_ENABLED` | `true`/`false` — daily catalog sync cron toggle (default `true`). |
| `BINANCE_INSTRUMENTS_CRON` | Cron expression (default `30 0 * * *` UTC — daily 00:30 UTC). |
| `BINANCE_INSTRUMENTS_CRON_TZ` | Timezone for the cron (default `UTC`). |
| `BINANCE_QUOTES` | Comma-separated quote-asset filter (default `USDT,USDC,BUSD,BTC,ETH`). |
| `BINANCE_WS_RECONNECT_MAX_ATTEMPTS` | Cap on exponential-backoff reconnect attempts (default `10`). |

No API keys.

## Instrument tokens

Binance uses uppercase symbol strings as provider tokens (e.g. `BTCUSDT`, `ETHUSDT`). In the UIR `instrument_mappings` table:

```
provider:        'binance'
provider_token:  'BTCUSDT'
instrument_token: 0          (Binance has no numeric ids — sentinel like Massive)
uir_id:          → universal_instruments.id
```

Canonical symbols are formatted `BINANCE:<SYMBOL>`, e.g. `BINANCE:BTCUSDT`. The `BINANCE` exchange code is distinct from Massive's `CRYPTO` so the two providers can coexist if Massive ever quotes the same pair.

## REST endpoints used

| Method | Path | MarketDataProvider method |
|---|---|---|
| GET | `/api/v3/exchangeInfo` | `getInstruments`, sync cron |
| GET | `/api/v3/ticker/price` | `getLTP` |
| GET | `/api/v3/ticker/24hr` | `getQuote`, `getOHLC` |
| GET | `/api/v3/klines` | `getHistoricalData` |

## WebSocket protocol

```
wss://stream.binance.com:9443/stream

1. Open WS (no auth handshake)
2. Send: {"method":"SUBSCRIBE","params":["btcusdt@trade","ethusdt@trade"],"id":1}
3. Recv: {"result":null,"id":1}                            ← ack
4. Stream: {"stream":"btcusdt@trade","data":{"e":"trade","s":"BTCUSDT","p":"50000.0","T":...}}
5. Server sends ping every ~3 min; the `ws` lib auto-pongs.
6. Reconnect with exponential backoff (1s → 60s, capped at BINANCE_WS_RECONNECT_MAX_ATTEMPTS).
   On reopen, re-send SUBSCRIBE for all tracked symbols.
```

Hard limit: **1024 streams per connection**. With v1's `@trade`-only mode that's 1024 instruments. No sharding in v1.

## Instrument sync

Daily cron (default `30 0 * * *` UTC) pulls `/api/v3/exchangeInfo`, filters `status='TRADING'` AND `quoteAsset ∈ BINANCE_QUOTES`, upserts `binance_instruments`, creates `instrument_mappings` rows with `provider='binance'`, upserts matching `universal_instruments` rows, links `uir_id` back, then calls `InstrumentRegistryService.refresh()` so the warm map sees the new pairs immediately.

## Out of scope (v1)

- `binance.us` (US-compliant exchange — different host, smaller catalog)
- USD-M Perpetual Futures (`fapi.binance.com`)
- WS sharding (1024 limit ≫ realistic v1 demand)
- Per-symbol order books / depth streams
- Order placement / private API (no signed requests anywhere in this module)

## Changelog

- **2026-04-26** — Initial implementation: REST client, combined-stream WS facade with JSON-RPC subscribe, daily sync cron with quote-asset filter, admin sync trigger, wiring into resolver/registry/universal-LTP.
