# Vortex Integration Context and Design

Purpose: Enable pluggable market data providers so the app can fetch from either Kite Connect or Vortex, with minimal code churn and clean boundaries.

## Current Architecture Summary
- Provider today: Kite Connect.
- Layers:
  - REST: `StockController` → `StockService` → `RequestBatchingService`/`KiteConnectService`
  - WS: `MarketDataGateway` ↔ `MarketDataStreamService` ↔ `KiteTicker`
  - Persistence: Postgres entities (instruments, market_data, subscriptions), Redis cache
- Data types used: instruments list, quotes, LTP, OHLC, historical, and live ticks.

## Target Design: Pluggable Provider Interface
Create a provider abstraction that both Kite and Vortex implement.

```ts
export interface MarketDataProvider {
  initialize(): Promise<void>;
  getInstruments(exchange?: string): Promise<any[]>;
  getQuote(tokens: string[]): Promise<Record<string, any>>;
  getLTP(tokens: string[]): Promise<Record<string, any>>;
  getOHLC(tokens: string[]): Promise<Record<string, any>>;
  getHistoricalData(token: number, from: string, to: string, interval: string): Promise<any>;

  // Streaming
  initializeTicker(): any; // returns ticker-like instance
  getTicker(): any;
}
```

- `KiteProvider` refactors `KiteConnectService` to implement the interface.
- `VortexProvider` implements the same using Vortex SDK/HTTP/websocket.
- `MarketDataProviderResolver` selects provider based on:
  - Env `DATA_PROVIDER=kite|vortex` (simple global), or
  - Per-API-key setting (column `provider` in `api_keys`), or
  - Header `x-provider` override (optional for testing).

## Changes Needed by Area
- Request Batching: inject `MarketDataProvider` instead of directly using Kite.
- StockService: keep unchanged; it calls batching/historical through provider.
- MarketDataStreamService: call `provider.initializeTicker()` and subscribe/unsubscribe using provider ticker (normalized API: `subscribe`, `unsubscribe`, `setMode`, `on('ticks')`).
- MarketDataGateway: unchanged (already routes to service), except (optional) allow `x-provider` to route per-connection.

## Token Mapping and Normalization
- If Vortex uses different instrument identifiers:
  - Add `instrument_mappings` table: `{ provider: 'kite'|'vortex', provider_token: string, instrument_token: number }`.
  - During instrument sync, populate mapping for Vortex.
  - Normalization helpers map incoming provider tokens to internal `instrument_token`.
- Live ticks normalization shape:
  - Normalize to `{ instrument_token, last_price, ohlc: { open, high, low, close }, volume, timestamp }`.

## Configuration & Secrets
- Add Vortex envs: `VORTEX_API_KEY`, `VORTEX_SECRET`, and stream URL.
- Add `DATA_PROVIDER` (global) default `kite`.
- Optional per-API-key `provider` default null (inherit global).

## Swagger & Dashboard
- Swagger: document optional `x-provider` header for testing; default uses key-config/global.
- Dashboard: add a provider dropdown (optional) that sets `x-provider` header for REST and uses WS query `provider`.

## Incremental Rollout Plan
1. Extract `MarketDataProvider` interface and refactor `KiteConnectService` → `KiteProvider` implementing it.
2. Create resolver service that returns active provider per request/connection.
3. Update `RequestBatchingService` and `MarketDataStreamService` to use the provider abstraction.
4. Implement `VortexProvider` skeleton with stubs; wire configs.
5. Add token mapping table if necessary.
6. E2E test with feature flag `DATA_PROVIDER=vortex` in staging.

## Effort Estimate
- Provider abstraction + refactor Kite: ~6–8 hours.
- Vortex provider implementation (REST + WS) once SDK/docs are provided: ~1–2 days.
- Token mapping + normalization if needed: +0.5–1.5 days.
- Per-API-key provider selection: +0.5 day.

## Risks/Notes
- Rate limits and throttling differ: tune batching window and chunk sizes per provider.
- WS semantics may differ: reconnection/backoff and subscription model must be aligned.
- Data field alignment (OHLC arrays vs objects) needs careful normalization.

## Next Steps for the Implementer
- Obtain Vortex API docs/SDK and credentials.
- Add envs to `env.example`, create `VortexProviderService` file, implement methods.
- Add a resolver and replace direct Kite usages with the provider in services.
- Provide smoke tests: quotes, LTP, OHLC, historical, stream ticks.
- Update Swagger with provider notes and dashboard toggle if desired.
