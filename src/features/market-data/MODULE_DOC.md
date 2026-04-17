# Market Data Module

## Purpose

Real-time market data streaming (Socket.IO + native WebSocket), provider abstraction (Kite / Vortex), HTTP request batching with a distributed 1/s gate, LTP memory cache, and Redis-backed last tick storage.

## Layout

- `application/` — stream orchestration, batching, provider queue, native WS server, parsers, caches.
- `interface/` — Socket.IO gateway, native WS gateway.
- `domain/` — entities for instruments, subscriptions, market data.
- `infra/` — `MarketDataProvider` contract.

## Key services

| Service | Role |
|---------|------|
| `MarketDataStreamService` | Ticker wiring (idempotent handlers), subscribe batching, tick ingest, `stream:status` pub |
| `MarketDataProviderResolverService` | Resolve active provider for HTTP vs WS |
| `RequestBatchingService` | Per-second batching + pair LTP + stale fill |
| `ProviderQueueService` | Redis lock 1/s per endpoint; in-memory fallback |
| `MarketDataGateway` | Socket.IO `/market-data` |
| `NativeWsService` | WS `/ws` |
| `MarketDataWsInterestService` | Ref-counts tokens with active WS subscribers (Socket.IO + native) for optional synthetic tick pulse |
| `InstrumentRegistryService` | Warm in-memory maps for O(1) provider token / UIR ID / canonical symbol resolution on tick hot path |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `MARKET_DATA_SYNTHETIC_INTERVAL_MS` | `0` (off) | When greater than 0, re-emits last known tick on this interval for subscribed tokens if upstream has been quiet for at least one interval; outbound frames include `syntheticLast: true`. |

## Changelog

- **2026-04-17** — Added `InstrumentRegistryService`: warm in-memory `Map`-based registry mapping provider tokens, UIR IDs, and canonical symbols for O(1) synchronous lookups on the tick hot path. Warmed on module init via `onModuleInit`; supports `refresh()` for daily re-sync. Registered in `market-data.module.ts` providers and exports. Unit tests in `application/__tests__/instrument-registry.service.spec.ts`.
- **2026-03-28 (structure)** — `MarketDataGatewaySubscriptionRegistry` holds Socket.IO client subscription map; gateway delegates to it (behavior unchanged). ESLint **`max-lines`** / **`max-lines-per-function`** are **warnings** in root `.eslintrc.js`. `npm run verify:pr` runs build + tests + **`check:cycles:warn`** (madge report; known module cycles may still print — see script). **`check:cycles`** exits non-zero if circular imports are found.
- **2026-03-28 (Falcon parity)** — Kite ticker wrapped (`kite-ticker.facade.ts`): `subscribe(tokens, mode)` calls `setMode` with `ohlcv`→`quote` for upstream. Client payloads use **Falcon** / **Vayu**: Socket.IO `welcome` / `whoami`, Redis `stream:status`, `getStreamingStatus` / health `provider` field. Prometheus labels unchanged (`kite`/`vortex`). `x-provider` and admin global/API-key accept **falcon** / **vayu** aliases. Resolver: `getResolvedInternalProviderNameForWebsocket()`.
- **2026-03-24** — Tick **hot path**: `forwardRealtimeTick` (Redis `last_tick` + WS broadcast) runs before **async** DB + `cacheMarketData` (`enqueuePersistMarketData` / `setImmediate`) so batches are not serialized on inserts. Per-tick `logger.log` demoted to `debug` on gateways/native WS; Redis `cacheMarketData` / `getCachedMarketData` use `Logger.debug` instead of `console.log`. Optional **`MARKET_DATA_SYNTHETIC_INTERVAL_MS`**: `MarketDataStreamService` pulses last payload with `syntheticLast: true`; metric `market_data_synthetic_tick_total`. `MarketDataWsInterestService` tracks subscriber ref-counts on subscribe/unsubscribe/disconnect (Socket.IO + native `/ws`).
- **2025-03-23 (Vortex sync)** — Vortex upstream uses up to **3** WebSocket shards × **1000** instruments each (`VORTEX_WS_MAX_SHARDS`, default 3); per-shard mode upgrade on `subscribe` when already subscribed; `getSubscriptionLimit()` returns total upstream capacity. Client `market_data` payloads are **shaped** by subscribed mode (`ltp` / `ohlcv` / `full`) via `tick-shape.util.ts`. Native `/ws` supports **`set_mode`** (parity with Socket.IO). New metrics: `vortex_subscribe_dropped_total`, `vortex_ws_shards_connected`. See `GATEWAYS.md` and `stock/infra/VORTEX_IMPLEMENTATION.md`.
- **2025-03-23** — Enterprise hardening: cleared subscription batch interval on stream stop; `RequestBatchingService` metrics interval lifecycle; Kite degraded empty returns + `getLTPByPairs` / `primeExchangeMapping`; idempotent ticker handler attachment (`WeakMap`); subscribe/unsub queue caps + drop metrics; structured logging (removed hot-path `console.*`); extended `stream:status` and Prometheus metrics; health snapshot `getMarketDataHealthSnapshot`; docs refreshed (`STREAMING_FLOWCHART.md`, `GATEWAYS.md`, `MARKET_DATA_ARCHITECTURE.md`).
