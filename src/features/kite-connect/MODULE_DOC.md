# kite-connect feature

Kite Connect HTTP client + WebSocket ticker provider. Implements the `MarketDataProvider` interface so the market-data gateway can use Kite/Falcon as a streaming source.

## Changelog

- **2026-04-14** — Added `getProfile()` and `getMargins(segment?)` to `KiteProviderService` to expose Kite account info. Fixed `getHistoricalData()` parameter order in both `KiteProviderService` and `KiteConnectService` (SDK signature is `(token, interval, from, to, continuous, oi)` — was incorrectly called as `(token, from, to, interval)`). Added `continuous` and `oi` params to `KiteProviderService.getHistoricalData()`.

## Key files

- `application/kite-connect.service.ts` — Legacy REST wrapper (maintained for backward compatibility)
- `infra/kite-provider.service.ts` — Primary `MarketDataProvider` implementation
- `infra/kite-ticker.facade.ts` — Wraps `KiteTicker` for streaming mode parity with Vortex

## Environment

| Variable | Description |
|----------|-------------|
| `KITE_API_KEY` | Kite Connect API key (required) |
| `KITE_ACCESS_TOKEN` | OAuth access token; falls back to Redis `kite:access_token` |
