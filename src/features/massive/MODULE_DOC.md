# massive feature

Massive (formerly Polygon.io, rebranded Oct 2025) market data provider for US stocks, forex, crypto, options, and indices. Implements the `MarketDataProvider` interface so the market-data gateway can use Massive as a streaming source alongside Kite (Indian equities) and Vortex (Rupeezy).

## Provider selection

- Set `DATA_PROVIDER=massive` (or `DATA_PROVIDER=polygon`) to use Massive as default.
- Pass `x-provider: massive` or `x-provider: polygon` HTTP header for per-request override.
- Call `POST /api/admin/provider/global {"provider":"massive"}` to switch the WebSocket stream globally.

## Configuration

| Variable | Description |
|---|---|
| `MASSIVE_API_KEY` | **Required.** Massive API key (same as Polygon.io key). |
| `MASSIVE_REALTIME` | `true` = realtime feed (`socket.massive.com`); `false` (default) = delayed feed (`delayed.socket.massive.com`). |
| `MASSIVE_WS_ASSET_CLASS` | WS asset class: `stocks` (default), `forex`, `crypto`, `options`, `indices`. |

## Instrument tokens

Massive uses string symbols as provider tokens (e.g. `AAPL`, `BTC-USD`, `EUR/USD`).
In the UIR instrument mapping table, store `provider = 'massive'` and `provider_token = 'AAPL'` (symbol string).
The streaming layer resolves UIR IDs → provider tokens and passes symbols to the WS ticker's `subscribe()`.

## REST endpoints used

| Method | Path | MarketDataProvider method |
|---|---|---|
| GET | `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | `getQuote`, `getLTP`, `getOHLC` |
| GET | `/v2/aggs/ticker/{ticker}/range/{mult}/{span}/{from}/{to}` | `getHistoricalData` |
| GET | `/v3/reference/tickers` | `getInstruments` |
| GET | `/v1/marketstatus/now` | health/degraded check |

## WebSocket protocol

```
wss://socket.massive.com/stocks   (realtime)
wss://delayed.socket.massive.com/stocks   (delayed)

1. Receive: [{"ev":"status","status":"connected","message":"..."}]
2. Send:    {"action":"auth","params":"<MASSIVE_API_KEY>"}
3. Receive: [{"ev":"status","status":"auth_success","message":"..."}]
4. Send:    {"action":"subscribe","params":"T.AAPL,AM.AAPL"}
5. Stream:  [{"ev":"T","sym":"AAPL","p":150.00,"s":100,"t":1234567890000,...}]
```

Subscriptions survive reconnect — the client re-subscribes all tracked symbols on `auth_success`.

## Instrument sync

Daily cron (`MASSIVE_INSTRUMENTS_CRON`, default `15 10 * * *` America/New_York) pulls all tickers
from `/v3/reference/tickers` (paginated by `next_url` cursor), upserts into `massive_instruments`,
creates `instrument_mappings` rows (`provider='massive'`), upserts `universal_instruments` (UIR),
then calls `InstrumentRegistryService.refresh()` so the streaming layer can immediately route
WS subscriptions to Massive symbols.

| Variable | Description |
|---|---|
| `MASSIVE_INSTRUMENT_SYNC_ENABLED` | `true`/`false` — enable/disable cron (default `true`) |
| `MASSIVE_INSTRUMENTS_CRON` | Cron expression (default `15 10 * * *`) |
| `MASSIVE_INSTRUMENTS_CRON_TZ` | Timezone (default `America/New_York`) |
| `MASSIVE_INSTRUMENT_MARKETS` | Comma-separated markets to sync (default `stocks,forex,crypto`) |

Admin endpoints: `POST /api/admin/massive/instruments/sync`, `GET /api/admin/massive/instruments/sync/status`,
`GET /api/admin/massive/instruments`, `GET /api/admin/massive/instruments/resolve`.

## Module files

| File | Purpose |
|---|---|
| `massive.constants.ts` | REST/WS base URLs, asset class types, interval map |
| `dto/massive-ws-event.dto.ts` | TypeScript shapes for all WS event types (T, Q, AM, XT, XA, C, CA) |
| `dto/massive-aggs.dto.ts` | REST OHLCV aggregate response shapes |
| `dto/massive-snapshot.dto.ts` | REST snapshot and reference ticker response shapes |
| `infra/massive-rest.client.ts` | Axios REST client; `init(apiKey)` must be called before use |
| `infra/massive-websocket.client.ts` | `ws`-based ticker facade; duck-typed to TickerLike |
| `infra/massive-provider.service.ts` | `MarketDataProvider` implementation wiring REST + WS |
| `domain/massive-instrument.entity.ts` | TypeORM entity for `massive_instruments` table |
| `application/massive-instrument-sync.service.ts` | Daily sync cron + UIR wiring |
| `interface/admin-massive.controller.ts` | Admin REST endpoints for sync control and inspection |
| `massive.module.ts` | NestJS `@Global()` module |

## Changelog

- **2026-04-18** — Initial implementation: REST client, WebSocket ticker, MarketDataProvider service, module registration. Provider aliases `massive` and `polygon` added to `normalizeProviderAlias`. Streaming layer updated to support string provider tokens (Massive symbols). `InternalProviderName` union extended with `'massive'`.
- **2026-04-19** — Instrument sync: `massive_instruments` table + migration, daily sync cron, UIR wiring, admin endpoints. `InstrumentMapping.provider` type extended with `'massive'`. `resolveCrossProvider()` now returns `massiveToken`.
- **2026-04-19 (admin credentials)** — `MassiveProviderService` now supports DB-backed credential overrides via `AppConfigService` (keys: `config:massive:api_key`, `config:massive:realtime`, `config:massive:asset_class`). DB values win over env vars; `onModuleInit` calls `loadConfigOverrides()` before `initialize()`. Added `updateApiCredentials()` and `getConfigStatus()` for admin endpoint use. Hot-reload: re-calls `initialize()` which reconnects WS if it was previously connected.
