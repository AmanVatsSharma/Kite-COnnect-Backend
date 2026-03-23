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

## Changelog

- **2025-03-23 (Vortex sync)** — Vortex upstream uses up to **3** WebSocket shards × **1000** instruments each (`VORTEX_WS_MAX_SHARDS`, default 3); per-shard mode upgrade on `subscribe` when already subscribed; `getSubscriptionLimit()` returns total upstream capacity. Client `market_data` payloads are **shaped** by subscribed mode (`ltp` / `ohlcv` / `full`) via `tick-shape.util.ts`. Native `/ws` supports **`set_mode`** (parity with Socket.IO). New metrics: `vortex_subscribe_dropped_total`, `vortex_ws_shards_connected`. See `GATEWAYS.md` and `stock/infra/VORTEX_IMPLEMENTATION.md`.
- **2025-03-23** — Enterprise hardening: cleared subscription batch interval on stream stop; `RequestBatchingService` metrics interval lifecycle; Kite degraded empty returns + `getLTPByPairs` / `primeExchangeMapping`; idempotent ticker handler attachment (`WeakMap`); subscribe/unsub queue caps + drop metrics; structured logging (removed hot-path `console.*`); extended `stream:status` and Prometheus metrics; health snapshot `getMarketDataHealthSnapshot`; docs refreshed (`STREAMING_FLOWCHART.md`, `GATEWAYS.md`, `MARKET_DATA_ARCHITECTURE.md`).
