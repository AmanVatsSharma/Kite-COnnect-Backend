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

- **2025-03-23** — Enterprise hardening: cleared subscription batch interval on stream stop; `RequestBatchingService` metrics interval lifecycle; Kite degraded empty returns + `getLTPByPairs` / `primeExchangeMapping`; idempotent ticker handler attachment (`WeakMap`); subscribe/unsub queue caps + drop metrics; structured logging (removed hot-path `console.*`); extended `stream:status` and Prometheus metrics; health snapshot `getMarketDataHealthSnapshot`; docs refreshed (`STREAMING_FLOWCHART.md`, `GATEWAYS.md`, `MARKET_DATA_ARCHITECTURE.md`).
