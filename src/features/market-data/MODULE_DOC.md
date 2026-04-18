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

- **2026-04-18** — Universal Symbol Architecture (Phase 3): UIR-primary internal state. All internal Maps (`subscribedInstruments`, `ltpCache`, `lastTickPayload`, `lastUpstreamAt`, `subscriptionQueue`, `modeByInstrument`, `wsInterest` refCounts) now keyed by UIR ID. `handleTicks` resolves provider tokens to UIR IDs via `InstrumentRegistryService`; unmapped tokens are skipped with rate-limited debug log. `processSubscriptionBatch` translates UIR IDs back to provider tokens for upstream `ticker.subscribe()`. Redis writes use `last_tick:{uirId}`. Socket.IO rooms use `instrument:{uirId}`. `broadcastMarketData` emits both `instrumentToken` and `uirId` fields. `doUnsubscribe`, `handleSetMode`, and `handleUnsubscribeAll` resolve provider tokens to UIR IDs. NativeWsService injects `InstrumentRegistryService` and resolves tokens in subscribe/unsubscribe/setMode. `MarketDataProvider.providerName` added to interface; `MarketDataExchangeToken.exchange` widened to `string`. Removed dual-key artifacts from Phase 2.
- **2026-04-17** — Universal Symbol Architecture (Phase 1+2): Added `UniversalInstrument` entity (`universal_instruments` table) as canonical instrument registry across all providers. Added `InstrumentRegistryService` with warm in-memory Maps for O(1) provider token / UIR ID / canonical symbol resolution. Added exchange normalizer (`@shared/utils/exchange-normalizer.ts`) and canonical symbol generator (`@shared/utils/canonical-symbol.ts`). Wired UIR enrichment into `handleTicks()` tick hot path. Added dual-key Redis writes (`last_tick:{token}` + `last_tick:uir:{uirId}`). Gateway now accepts `symbols?: string[]` in subscribe events alongside legacy `instruments`. Subscription confirmations include `resolved` symbol data and `unresolvedSymbols`. Clients join dual-key rooms. Falcon + Vortex sync pipelines now upsert into `universal_instruments` and link `instrument_mappings.uir_id`.
- **2026-03-28 (structure)** — `MarketDataGatewaySubscriptionRegistry` holds Socket.IO client subscription map; gateway delegates to it (behavior unchanged). ESLint **`max-lines`** / **`max-lines-per-function`** are **warnings** in root `.eslintrc.js`. `npm run verify:pr` runs build + tests + **`check:cycles:warn`** (madge report; known module cycles may still print — see script). **`check:cycles`** exits non-zero if circular imports are found.
- **2026-03-28 (Falcon parity)** — Kite ticker wrapped (`kite-ticker.facade.ts`): `subscribe(tokens, mode)` calls `setMode` with `ohlcv`→`quote` for upstream. Client payloads use **Falcon** / **Vayu**: Socket.IO `welcome` / `whoami`, Redis `stream:status`, `getStreamingStatus` / health `provider` field. Prometheus labels unchanged (`kite`/`vortex`). `x-provider` and admin global/API-key accept **falcon** / **vayu** aliases. Resolver: `getResolvedInternalProviderNameForWebsocket()`.
- **2026-03-24** — Tick **hot path**: `forwardRealtimeTick` (Redis `last_tick` + WS broadcast) runs before **async** DB + `cacheMarketData` (`enqueuePersistMarketData` / `setImmediate`) so batches are not serialized on inserts. Per-tick `logger.log` demoted to `debug` on gateways/native WS; Redis `cacheMarketData` / `getCachedMarketData` use `Logger.debug` instead of `console.log`. Optional **`MARKET_DATA_SYNTHETIC_INTERVAL_MS`**: `MarketDataStreamService` pulses last payload with `syntheticLast: true`; metric `market_data_synthetic_tick_total`. `MarketDataWsInterestService` tracks subscriber ref-counts on subscribe/unsubscribe/disconnect (Socket.IO + native `/ws`).
- **2025-03-23 (Vortex sync)** — Vortex upstream uses up to **3** WebSocket shards × **1000** instruments each (`VORTEX_WS_MAX_SHARDS`, default 3); per-shard mode upgrade on `subscribe` when already subscribed; `getSubscriptionLimit()` returns total upstream capacity. Client `market_data` payloads are **shaped** by subscribed mode (`ltp` / `ohlcv` / `full`) via `tick-shape.util.ts`. Native `/ws` supports **`set_mode`** (parity with Socket.IO). New metrics: `vortex_subscribe_dropped_total`, `vortex_ws_shards_connected`. See `GATEWAYS.md` and `stock/infra/VORTEX_IMPLEMENTATION.md`.
- **2025-03-23** — Enterprise hardening: cleared subscription batch interval on stream stop; `RequestBatchingService` metrics interval lifecycle; Kite degraded empty returns + `getLTPByPairs` / `primeExchangeMapping`; idempotent ticker handler attachment (`WeakMap`); subscribe/unsub queue caps + drop metrics; structured logging (removed hot-path `console.*`); extended `stream:status` and Prometheus metrics; health snapshot `getMarketDataHealthSnapshot`; docs refreshed (`STREAMING_FLOWCHART.md`, `GATEWAYS.md`, `MARKET_DATA_ARCHITECTURE.md`).
- **2026-04-18 (UIR enhancement)** — Added `InstrumentRegistryService.resolveCrossProvider()` and `getCoverage()` for cross-provider symbol admin queries. `getStats()` now includes coverage breakdown. Fixed `tick-shape.util.ts` full-mode internal field leak: `_uirId`/`_canonicalSymbol` are now stripped and re-exposed as `uir_id`/`symbol`. `NativeWsService.handleSubscribe` now accepts `symbols[]` (canonical strings like `"NSE:RELIANCE"`) alongside existing numeric `instruments[]`. `MarketDataGateway.doSubscribe` enforces admin WS blocklist (`ws:block:apikey:*`, `ws:block:exchanges`) from Redis before processing subscriptions.
- **2026-04-19 (per-exchange routing)** — Replaced single global WS provider model with automatic per-exchange routing. `exchange-to-provider.util.ts` maps NSE/BSE/NFO/BFO/MCX/CDS/BCD → Kite; US/FX/CRYPTO/IDX → Massive. `InstrumentRegistryService` gains `uirIdToExchange` map and `getBestProviderForUirId()` (3-tier: exchange table → Indian fallback → first available). `MarketDataStreamService.activeProviderState` replaces `subscribedInstruments`/`streamMetricsProvider`/`streamClientProviderLabel`; all enabled providers initialize and stream concurrently. `processSubscriptionBatch` groups UIR IDs by provider, primes Vortex exchange mappings per batch, enforces per-provider capacity limits. `handleTicks` signature adds `providerName` param. `setMode`/`stopStreaming`/`reconnectIfStreaming` iterate all active providers. Admin `GET /admin/stream/status` now returns `providers` and `providerHealth` per-provider breakdown. Admin `POST /admin/provider/global` clarified as HTTP-only.
