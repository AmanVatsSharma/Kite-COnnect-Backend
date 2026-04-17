# Falcon feature

Provider-facing **Kite (Falcon)** instrument catalog: `falcon_instruments`, sync from Kite instruments API, optional LTP enrichment via `FalconProviderAdapter`.

## Changelog

- **2026-04-14** — Full Vayu-parity: added 14 new endpoints to `FalconController` (`/stock/falcon/*`) and 13 new service methods to `FalconInstrumentService`: `getOptionsChain`, `getUnderlyingFutures`, `autocompleteFno`, `getMcxOptions`, `getPopularInstruments`, `deleteInactiveInstruments`, `deleteByFilter`, `clearFalconCache`, `getCachedStats`, `startSyncAlwaysAsync`; controller adds `GET /options/chain/:symbol`, `GET /underlyings/:symbol/futures`, `GET /underlyings/:symbol/options`, `GET /fno/autocomplete`, `GET /mcx-options`, `GET /instruments/popular`, `GET /instruments/cached-stats`, `POST /instruments/sync/start`, `DELETE /instruments/inactive`, `DELETE /instruments`, `POST /cache/clear`, `GET /validate-instruments/status`, `POST /validate-instruments/stream`, `POST /validate-instruments/export`; injected `RedisService` into `FalconInstrumentService` for async-sync job tracking and stats caching; fixed spec to pass new constructor arg.

- **2026-03-28** — Daily scheduled sync (`SchedulerRegistry` + `cron`), configurable via `FALCON_INSTRUMENTS_*` env vars; `refreshSession` preflight on Kite; batched `upsert` for `falcon_instruments` and `instrument_mappings`; post-sync reconciliation (`is_active=false` for tokens missing from latest dump); `KiteProviderService.refreshSession` / `isClientInitialized` for cron safety; unit tests in `application/falcon-instrument.service.spec.ts`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `FALCON_INSTRUMENT_SYNC_ENABLED` | `true` | Set `false` to disable registering the daily cron |
| `FALCON_INSTRUMENTS_CRON` | `45 9 * * *` | Cron expression (minute hour dom month dow), evaluated in `FALCON_INSTRUMENTS_CRON_TZ` |
| `FALCON_INSTRUMENTS_CRON_TZ` | `Asia/Kolkata` | IANA timezone for the cron job |
| `FALCON_INSTRUMENT_RECONCILE` | `true` | After sync, deactivate rows not present in the latest Kite response (scoped by `exchange` when partial sync) |

Kite credentials: `KITE_API_KEY`, `KITE_ACCESS_TOKEN` or Redis `kite:access_token` (see `KiteProviderService`).

## Entry points

- HTTP: `src/features/falcon/interface/falcon.controller.ts` under `@Controller('stock/falcon')`
- Service: `src/features/falcon/application/falcon-instrument.service.ts`

## Related docs

- [domain/FALCON_INSTRUMENTS.md](./domain/FALCON_INSTRUMENTS.md)

- **2026-04-14** — Runtime credential management: added `GET /api/admin/falcon/config` + `PATCH /api/admin/falcon/config` endpoints to `AdminFalconController`; added `updateApiCredentials(apiKey, apiSecret?)` + `getConfigStatus()` to `KiteProviderService`; `AuthController` (Kite login/callback) now reads API key/secret from `app_configs` DB table before env vars; FalconPage.tsx gains "Falcon API Credentials" section (collapsible) for updating without SSH.

- **2026-04-17** — UIR integration: after Falcon instrument sync, upsert matching rows into `universal_instruments` via `upsertUniversalInstruments()` and set `uir_id` on `instrument_mappings`; call `InstrumentRegistryService.refresh()` to rewarm in-memory maps. New constructor deps: `UniversalInstrument` repo and `InstrumentRegistryService`. Non-fatal error handling preserves existing sync behaviour.

- **2026-04-14** — Enterprise-grade Falcon expansion:
  - `FalconProviderAdapter`: added `getQuote()` (5 s cache), `getOHLC()` (5 s cache), `getHistoricalData()` (1 hr cache, `continuous`+`oi` support), `getProfile()` (5 min cache), `getMargins()` (60 s cache) — all with rate limiting and exponential-backoff retries.
  - `FalconController`: added client-facing `POST /stock/falcon/quote`, `POST /stock/falcon/ohlc`, `GET /stock/falcon/historical/:token`.
  - `AdminFalconController` (`interface/admin-falcon.controller.ts`): 11 admin endpoints under `/admin/falcon/*` secured by `AdminGuard` for the operator dashboard — profile, margins, stats, instruments list/search/sync, LTP, quote, OHLC, historical.
  - `FalconModule`: wired `AdminFalconController`, exported `FalconProviderAdapter`, provided `AdminGuard`.
  - Bug fix: `KiteProviderService.getHistoricalData` and `KiteConnectService.getHistoricalData` were passing args in wrong order (SDK is `(token, interval, from, to, continuous, oi)`).
  - New DTO: `src/features/falcon/interface/dto/falcon-market-data.dto.ts`.

- **2026-04-14** — B2B scalability hardening:
  - `FalconInstrumentService`: `populateSymbolCache()` writes `falcon:sym2tok:{EXCHANGE}:{SYMBOL}` Redis keys (TTL 86400 s) after every sync; `resolveSymbolsToTokens(symbols, exchange?)` resolves symbol strings to numeric tokens via Redis cache → DB fallback.
  - `FalconController`: `GET /stock/falcon/instruments/export` streams all matching instruments as NDJSON (chunked transfer, 1000-row pages); `GET /stock/falcon/instruments/resolve` resolves comma-separated trading symbols to tokens.
  - `AdminFalconController`: `POST /admin/falcon/ticker/restart` and `GET /admin/falcon/ticker/status` (includes subscribedInstruments, upstreamLimit 3000, utilizationPct); `GET /admin/falcon/instruments/export` and `GET /admin/falcon/instruments/resolve` (admin-protected mirrors).
  - `FalconProviderAdapter`: replaced in-process `lastReqAt` rate limiter with Redis distributed lock (`falcon:rl:http:{key}` via `tryAcquireLock`) — works correctly under multi-instance horizontal scale; fail-open when Redis unavailable.

- **2026-04-14** — Phase 2: Smart historical caching, batch endpoint, options chain cache, admin controls:
  - `FalconProviderAdapter`: `historicalTtl(interval, to)` replaces flat 1 hr TTL — 60 s for 1-min interval today, up to 86400 s for day-interval historical past dates; `getBatchHistoricalData(requests)` fetches up to 10 tokens in parallel (3-at-a-time, ~3 RPS pacing).
  - `FalconInstrumentService`: Redis cache for `getOptionsChain()` — `falcon:options:chain:{SYM}[:ltp]`, TTL 60 s during market hours (9:15–15:30 IST Mon–Fri) or 300 s otherwise; `isMarketHours()` helper.
  - `FalconController` (`/stock/falcon/*`): `POST /stock/falcon/historical/batch` for batch candle fetch.
  - `AdminFalconController` additions: `GET /admin/falcon/ticker/shards` (per-shard WS capacity), `GET /admin/falcon/options/chain/:symbol` (admin options chain), `DELETE /admin/falcon/cache/flush` (options/ltp/historical cache flush via `RedisService.scanDelete`), `POST /admin/falcon/historical/batch`.
  - `RedisService`: added `scanDelete(pattern)` for wildcard key deletion (SCAN + DEL loop).
  - `MarketDataStreamService`: dynamic upstream limit via `provider.getSubscriptionLimit?.() ?? 3000` instead of hardcoded constant.
  - Admin dashboard: `FalconPage` gains multi-shard status panel (per-shard cards + capacity bar) and Options Chain Explorer; `WsAdminPage` shows Kite WS capacity bar; new functions in `falcon-api.ts`.

- **2026-04-14** — Phase 3: Kite session management endpoints:
  - `AdminFalconController`: `GET /admin/falcon/session` returns token age (`kite:access_token_created_at`), Redis TTL via `pttl()`, connected/degraded state, lastError; `DELETE /admin/falcon/session` revokes token from Redis and restarts ticker.
  - Admin dashboard: `AuthPage` rewritten as 3-step OAuth wizard with Session Status Card, manual `request_token` fallback; `FalconPage` gains session health banner + Quick Actions strip (Restart Ticker, Sync Instruments, Flush All Caches, Validate Session); `TerminalLayout` status bar gains Kite session health pill.
