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

## WebSocket subscription syntax

Both WS surfaces (`/market-data` Socket.IO and `/ws` native) accept the following identifier forms in `instruments[]` and `symbols[]`:

| Form | Example | Behavior |
|---|---|---|
| Numeric provider token | `26000`, `738561` | Resolved against the active provider; multi-provider lookup fallback. |
| Vortex `EXCHANGE-TOKEN` | `"NSE_EQ-26000"` | Vortex-specific full pair key. |
| Canonical symbol | `"NSE:RELIANCE"`, `"BINANCE:BTCUSDT"` | Routed via `getBestProviderForUirId` (best provider for that exchange). |
| Underlying name | `"RELIANCE"` | Flex resolved → EQ preferred over IDX, NSE preferred for India. |
| **Provider prefix** | `"Falcon:reliance"`, `"Vayu:26000"`, `"Massive:AAPL"`, `"Binance:BTCUSDT"` | **Forces routing to that specific provider.** Resolved only within that provider's mappings. Skips kite↔vortex dual-subscribe. |

**Provider prefix aliases** (case-insensitive):

| Prefix | Routes to |
|---|---|
| `Falcon:` / `Kite:` | Kite |
| `Vayu:` / `Vortex:` | Vortex |
| `Massive:` / `Polygon:` | Massive |
| `Binance:` | Binance |

**Errors:**
- `forced_provider_unavailable` — emitted when the requested provider has no active upstream connection (e.g. `KITE_ACCESS_TOKEN` missing). The subscription for that token is rejected with no fallback.
- `unresolvedSymbols` — items not found in the requested provider's catalog or ambiguous within the provider scope are returned in this array on `subscription_confirmed`.

**Confirmation enrichment:** `subscription_confirmed.forced` lists each pinned subscription as `{ symbol, uirId, provider, canonical }`.

## Changelog

- **2026-04-28 (provider-prefixed WS subscriptions)** — Added `Provider:identifier` prefix syntax (`Falcon:reliance`, `Vayu:26000`, `Massive:AAPL`, `Binance:BTCUSDT`) to both Socket.IO `/market-data` and native `/ws` subscribe + unsubscribe handlers. New `parseProviderPrefix` util (`src/shared/utils/ws-provider-prefix.util.ts`) using `normalizeProviderAlias` (first-colon split — preserves nested canonical like `Falcon:NSE:RELIANCE`). New `InstrumentRegistryService.resolveProviderScopedSymbol(provider, identifier)` resolves only within that provider's mappings (numeric token → exact canonical → underlying with EQ-then-IDX preference). `MarketDataStreamService.subscribeToInstruments` accepts an optional `forcedProvider` param; `forcedProviderByUir` map pins routing per-UIR, bypassing `getBestProviderForUirId` and the kite↔vortex dual-subscribe path. Pin is cleared when the last client unsubscribes. Hard-fail with `forced_provider_unavailable` (no fallback) when the requested provider has no active upstream connection. `subscription_confirmed.forced` enriches the response with `{ symbol, uirId, provider, canonical }` per pinned subscription.
- **2026-04-18** — Universal Symbol Architecture (Phase 3): UIR-primary internal state. All internal Maps (`subscribedInstruments`, `ltpCache`, `lastTickPayload`, `lastUpstreamAt`, `subscriptionQueue`, `modeByInstrument`, `wsInterest` refCounts) now keyed by UIR ID. `handleTicks` resolves provider tokens to UIR IDs via `InstrumentRegistryService`; unmapped tokens are skipped with rate-limited debug log. `processSubscriptionBatch` translates UIR IDs back to provider tokens for upstream `ticker.subscribe()`. Redis writes use `last_tick:{uirId}`. Socket.IO rooms use `instrument:{uirId}`. `broadcastMarketData` emits both `instrumentToken` and `uirId` fields. `doUnsubscribe`, `handleSetMode`, and `handleUnsubscribeAll` resolve provider tokens to UIR IDs. NativeWsService injects `InstrumentRegistryService` and resolves tokens in subscribe/unsubscribe/setMode. `MarketDataProvider.providerName` added to interface; `MarketDataExchangeToken.exchange` widened to `string`. Removed dual-key artifacts from Phase 2.
- **2026-04-17** — Universal Symbol Architecture (Phase 1+2): Added `UniversalInstrument` entity (`universal_instruments` table) as canonical instrument registry across all providers. Added `InstrumentRegistryService` with warm in-memory Maps for O(1) provider token / UIR ID / canonical symbol resolution. Added exchange normalizer (`@shared/utils/exchange-normalizer.ts`) and canonical symbol generator (`@shared/utils/canonical-symbol.ts`). Wired UIR enrichment into `handleTicks()` tick hot path. Added dual-key Redis writes (`last_tick:{token}` + `last_tick:uir:{uirId}`). Gateway now accepts `symbols?: string[]` in subscribe events alongside legacy `instruments`. Subscription confirmations include `resolved` symbol data and `unresolvedSymbols`. Clients join dual-key rooms. Falcon + Vortex sync pipelines now upsert into `universal_instruments` and link `instrument_mappings.uir_id`.
- **2026-03-28 (structure)** — `MarketDataGatewaySubscriptionRegistry` holds Socket.IO client subscription map; gateway delegates to it (behavior unchanged). ESLint **`max-lines`** / **`max-lines-per-function`** are **warnings** in root `.eslintrc.js`. `npm run verify:pr` runs build + tests + **`check:cycles:warn`** (madge report; known module cycles may still print — see script). **`check:cycles`** exits non-zero if circular imports are found.
- **2026-03-28 (Falcon parity)** — Kite ticker wrapped (`kite-ticker.facade.ts`): `subscribe(tokens, mode)` calls `setMode` with `ohlcv`→`quote` for upstream. Client payloads use **Falcon** / **Vayu**: Socket.IO `welcome` / `whoami`, Redis `stream:status`, `getStreamingStatus` / health `provider` field. Prometheus labels unchanged (`kite`/`vortex`). `x-provider` and admin global/API-key accept **falcon** / **vayu** aliases. Resolver: `getResolvedInternalProviderNameForWebsocket()`.
- **2026-03-24** — Tick **hot path**: `forwardRealtimeTick` (Redis `last_tick` + WS broadcast) runs before **async** DB + `cacheMarketData` (`enqueuePersistMarketData` / `setImmediate`) so batches are not serialized on inserts. Per-tick `logger.log` demoted to `debug` on gateways/native WS; Redis `cacheMarketData` / `getCachedMarketData` use `Logger.debug` instead of `console.log`. Optional **`MARKET_DATA_SYNTHETIC_INTERVAL_MS`**: `MarketDataStreamService` pulses last payload with `syntheticLast: true`; metric `market_data_synthetic_tick_total`. `MarketDataWsInterestService` tracks subscriber ref-counts on subscribe/unsubscribe/disconnect (Socket.IO + native `/ws`).
- **2025-03-23 (Vortex sync)** — Vortex upstream uses up to **3** WebSocket shards × **1000** instruments each (`VORTEX_WS_MAX_SHARDS`, default 3); per-shard mode upgrade on `subscribe` when already subscribed; `getSubscriptionLimit()` returns total upstream capacity. Client `market_data` payloads are **shaped** by subscribed mode (`ltp` / `ohlcv` / `full`) via `tick-shape.util.ts`. Native `/ws` supports **`set_mode`** (parity with Socket.IO). New metrics: `vortex_subscribe_dropped_total`, `vortex_ws_shards_connected`. See `GATEWAYS.md` and `stock/infra/VORTEX_IMPLEMENTATION.md`.
- **2025-03-23** — Enterprise hardening: cleared subscription batch interval on stream stop; `RequestBatchingService` metrics interval lifecycle; Kite degraded empty returns + `getLTPByPairs` / `primeExchangeMapping`; idempotent ticker handler attachment (`WeakMap`); subscribe/unsub queue caps + drop metrics; structured logging (removed hot-path `console.*`); extended `stream:status` and Prometheus metrics; health snapshot `getMarketDataHealthSnapshot`; docs refreshed (`STREAMING_FLOWCHART.md`, `GATEWAYS.md`, `MARKET_DATA_ARCHITECTURE.md`).
- **2026-04-18 (UIR enhancement)** — Added `InstrumentRegistryService.resolveCrossProvider()` and `getCoverage()` for cross-provider symbol admin queries. `getStats()` now includes coverage breakdown. Fixed `tick-shape.util.ts` full-mode internal field leak: `_uirId`/`_canonicalSymbol` are now stripped and re-exposed as `uir_id`/`symbol`. `NativeWsService.handleSubscribe` now accepts `symbols[]` (canonical strings like `"NSE:RELIANCE"`) alongside existing numeric `instruments[]`. `MarketDataGateway.doSubscribe` enforces admin WS blocklist (`ws:block:apikey:*`, `ws:block:exchanges`) from Redis before processing subscriptions.
- **2026-04-22 (cross-provider fallback)** — `MarketDataStreamService` gains `perProviderTickCache` (`Map<provider, Map<uirId, tick>>`). `handleTicks` stores each valid-price tick per-provider; when a tick arrives with null/zero `last_price`, it patches `effectiveTick.last_price` from the peer provider's cache (kite→vortex or vortex→kite) and tags `_fallbackProvider`. `processSubscriptionBatch` now dual-subscribes: after routing each UIR to its primary provider, also routes it to the secondary provider (kite↔vortex) when the registry has a secondary token. This enables Vortex ticks to arrive even for Kite-primary instruments, populating the fallback cache.

- **2026-04-22 (stream_inactive state-closure fix)** — Fixed stale-closure bug in `MarketDataStreamService.initializeStreaming()`: previously, every `startStreaming()` call created a new `state` object and overwrote `activeProviderState`, but the `WeakMap` guard prevented re-binding event handlers — leaving them referencing the orphaned S1 object whose `isConnected` was never set to `true`. Fix: (1) reuse the existing `activeProviderState` entry when the ticker instance is the same (new state only when ticker changes, e.g. after `restartTicker`); (2) event handlers now do live `this.activeProviderState.get(providerName)` lookups instead of closing over a local variable. This resolves the `stream_inactive` error on subscribe when OAuth auto-start + manual admin `/stream/start` both fired.
- **2026-04-22 (subscription queue key fix)** — Fixed silent subscription drop bug in `MarketDataGateway.doSubscribe` and `NativeWsService.handleSubscribe`. Both were passing raw provider tokens (e.g. Kite `738561`) to the stream service instead of UIR IDs. `processSubscriptionBatch` calls `getBestProviderForUirId()` on queue keys, so a provider token key always resolved to `undefined` provider and was silently skipped every 500ms flush — upstream ticker subscription never happened. Fix: gateway now calls `subscribeToInstruments(includedUirIds, ...)` (UIR IDs already resolved earlier in `doSubscribe`); native WS calls `subscribeToInstruments(uirIds, ...)` (already resolved in the same function). The now-dead `subscribePairs` method was removed from `MarketDataStreamService`.
- **2026-04-22 (auto-start + re-routing)** — Streaming is now self-healing for clients: (1) **Auto-start on subscribe** — `MarketDataStreamService.autoStartIfNeeded()` starts the ticker automatically when the first client subscribes (respects `adminStopped` flag; concurrent callers queue behind a mutex). Both Socket.IO gateway and native WS service emit a `stream_starting` notification then await auto-start before confirming subscriptions. (2) **Disconnect re-routing** — on provider `disconnect`, orphaned UIR IDs are immediately re-queued; the batch processor routes them to any still-connected peer provider. (3) **Reconnect re-subscription** — on provider `connect`, all entries in `subscribedUirModes` are re-queued to restore dual-coverage lost during the outage. `subscribedUirModes` is a persistent durable ledger (survives batch-queue clears) updated in `subscribeToInstruments()` and cleaned in `unsubscribeFromInstruments()`. Admin stop sets `adminStopped=true`; admin start clears it.
- **2026-04-19 (per-exchange routing)** — Replaced single global WS provider model with automatic per-exchange routing. `exchange-to-provider.util.ts` maps NSE/BSE/NFO/BFO/MCX/CDS/BCD → Kite; US/FX/CRYPTO/IDX → Massive. `InstrumentRegistryService` gains `uirIdToExchange` map and `getBestProviderForUirId()` (3-tier: exchange table → Indian fallback → first available). `MarketDataStreamService.activeProviderState` replaces `subscribedInstruments`/`streamMetricsProvider`/`streamClientProviderLabel`; all enabled providers initialize and stream concurrently. `processSubscriptionBatch` groups UIR IDs by provider, primes Vortex exchange mappings per batch, enforces per-provider capacity limits. `handleTicks` signature adds `providerName` param. `setMode`/`stopStreaming`/`reconnectIfStreaming` iterate all active providers. Admin `GET /admin/stream/status` now returns `providers` and `providerHealth` per-provider breakdown. Admin `POST /admin/provider/global` clarified as HTTP-only.
- **2026-04-27 (Vortex token UIR resolution fix)** — Fixed silent Vortex subscription failure caused by key-format mismatch: `InstrumentRegistryService.warmMaps()` stored Vortex mappings as `"vortex:NSE_EQ-213123"` (full format) but callers looked up `"vortex:213123"` (numeric only) → always missed → raw token used as fake UIR ID → upstream subscription never fired. Three-layer fix: (1) `instrument-registry.service.ts` — secondary numeric index: for each Vortex mapping where `instrument_token` is set, also register `"vortex:${instrument_token}"` → uirId with collision-detection guard (first writer wins, warn on conflict). (2) `market-data.gateway.ts` — new private `resolveUirForPair(provider, pair)` helper tries `"${exchange}-${token}"` full key first for Vortex (more precise), then falls back to numeric; replaces all 4 `resolveProviderToken(providerNameForResolve, p.token)` call sites in `doSubscribe()`. (3) `native-ws.service.ts` — `handleSubscribe()` now parses `NSE_EQ-213123` string format (same `^([A-Z_]+)-(\d+)$` regex as gateway) into `vortexPairs[]`, then resolves via full key first, then numeric fallback.
