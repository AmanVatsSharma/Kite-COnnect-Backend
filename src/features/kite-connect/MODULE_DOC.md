# kite-connect feature

Kite Connect HTTP client + WebSocket ticker provider. Implements the `MarketDataProvider` interface so the market-data gateway can use Kite/Falcon as a streaming source.

## Changelog

- **2026-04-14** — Added `getProfile()` and `getMargins(segment?)` to `KiteProviderService` to expose Kite account info. Fixed `getHistoricalData()` parameter order in both `KiteProviderService` and `KiteConnectService` (SDK signature is `(token, interval, from, to, continuous, oi)` — was incorrectly called as `(token, from, to, interval)`). Added `continuous` and `oi` params to `KiteProviderService.getHistoricalData()`.

- **2026-04-14** — Robust Kite integration for B2B scalability:
  - Exponential backoff reconnect: `min(30 000, 1000 × 2^attempts) + rand(0–1000) ms`, max 10 attempts (up from 5).
  - `resolveExchanges(tokens)`: queries `falcon_instruments` (with Redis cache `falcon:tok:exchange:{token}`, TTL 86400 s) to map Kite segments to Vortex exchange labels (NSE→NSE_EQ, NFO→NSE_FO, MCX→MCX_FO, CDS→NSE_CUR).
  - Prometheus metrics: `kite_ticker_reconnect_total` (label: reason=reconnecting|auth_error|max_attempts) and `kite_ticker_subscribed_instruments` gauge.
  - Redis pub/sub events on `stream:status` channel: `connect`, `disconnect`, `auth_error`, `provider_halted`.
  - `getReconnectCount()` public accessor; `restartTicker()` now resets `reconnectAttempts` and `disableReconnect`.
  - `providerName = 'kite'` added to `MarketDataProvider` interface implementation.
  - `FalconInstrument` repository injected via `TypeOrmModule.forFeature([FalconInstrument])` in `kite-connect.module.ts`.

## Key files

- `application/kite-connect.service.ts` — Legacy REST wrapper (maintained for backward compatibility)
- `infra/kite-provider.service.ts` — Primary `MarketDataProvider` implementation
- `infra/kite-ticker.facade.ts` — Wraps `KiteTicker` for streaming mode parity with Vortex

## Environment

| Variable | Description |
|----------|-------------|
| `KITE_API_KEY` | Kite Connect API key (required) |
| `KITE_ACCESS_TOKEN` | OAuth access token; falls back to Redis `kite:access_token` |
