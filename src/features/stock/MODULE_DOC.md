# Stock module

## Purpose

Broker/provider orchestration for instruments and market operations: **Kite Connect**, **Rupeezy Vortex** (REST + WS), and **Vayu** surface (equity / F\&O / options / search / management). Exposes REST under `stock` and `stock/vayu`.

## Layout

- `application/` — `stock.service`, Vayu domain services, **Vortex** split services (`vortex-instrument-*.service.ts`, facade `vortex-instrument.service.ts`), validation cron.
- `domain/` — `vortex-session`, `vortex-instrument` entities; docs under `VORTEX_INSTRUMENTS.md`.
- `infra/` — `vortex-provider.service` (REST + WS ticker), `vortex-ws-ticker`, CSV/binary tick utils.
- `interface/` — `stock-instruments.controller`, `stock-quotes.controller`, `stock-subscriptions.controller`, `vayu.controller`, DTOs.

## Key env (representative)

See root `env.example` / `env.production.example` for `VORTEX_*`, Kite, DB, Redis.

## Sub-feature boundaries (evaluation)

For future **Phase C** modularization (no routing changes):

| Sub-area   | Folders / classes today                         | Candidate Nest child module   |
|-----------|---------------------------------------------------|-------------------------------|
| Vortex    | `vortex-*` application + `vortex-provider` infra | `stock/vortex/vortex.module` |
| Vayu      | `vayu-*.service.ts`, `vayu.controller.ts`        | `stock/vayu/vayu.module`     |

Keep `StockModule` as the composition root re-exporting providers until cycle risk with `MarketDataModule` is addressed (shared `TypeOrmModule` entities).

## Changelog

- **2026-04-25** — Added `POST /api/stock/universal/ltp` endpoint (`UniversalLtpService` + wired in `StockQuotesController`). Accepts `{ ids: number[] }` (universal instrument IDs); resolves to vortex or kite provider via `InstrumentRegistryService` in-memory maps; returns `{ success, data: { "[uirId]": { last_price } } }`. Added `getProviderTokens()` and `getExchange()` public accessors to `InstrumentRegistryService`. Fixed `VayuMarketDataService.getVortexLtp()` to handle `body.pairs` (exchange-token pairs) before `body.instruments` — previously returned 400, silently breaking search-api vortex LTP hydration.

- **2026-04-22** — Added `crossLinkProviderMappings()` to `VortexInstrumentSyncService`: after UIR upsert and before `instrumentRegistry.refresh()`, runs two raw SQL UPDATEs that JOIN `instrument_mappings` on `instrument_token` to copy `uir_id` bidirectionally between kite and vortex rows. Enables the streaming service to dual-subscribe and use per-provider tick fallback.

- **2026-04-17** — UIR integration: during Vortex instrument sync, each instrument is upserted into `universal_instruments` via `upsertUniversalInstrument()` and its `instrument_mappings` row gets `uir_id` set; `InstrumentRegistryService.refresh()` called after sync completes. New constructor deps on `VortexInstrumentSyncService`: `UniversalInstrument` repo and `InstrumentRegistryService`. Non-fatal error handling preserves existing sync behaviour.

- **2026-04-14** — Runtime credential management: added `AdminVayuController` (`interface/admin-vayu.controller.ts`) with `GET /api/admin/vayu/config` + `PATCH /api/admin/vayu/config` endpoints; `VortexProviderService` gains `updateApiCredentials(params)` + `getConfigStatus()` + `loadConfigOverrides()` to load DB-persisted credential overrides on startup; `VortexAuthController` (Vayu login/callback) reads appId/apiKey/baseUrl from `app_configs` DB table before env vars; `StockModule` wires `AdminVayuController` + `AdminGuard`; ProviderPage.tsx gains "Vayu API Credentials" section for updating without SSH.

- **2026-03-28** — **Vortex instruments**: monolithic `vortex-instrument.service.ts` split into `vortex-instrument-sync`, `-cleanup`, `-cache`, `-ltp`, `-search`, `-read` services with **unchanged** `VortexInstrumentService` facade API. Helpers in `vortex-instrument-helpers.ts`. **Stock REST**: `stock.controller.ts` split into `stock-instruments`, `stock-quotes`, `stock-subscriptions` controllers (same `stock` prefix). **Vortex provider**: CSV + binary tick parsing moved to `vortex-csv.util.ts`, `vortex-ws-binary-tick.parser.ts`. Unit test `stock.controller.spec` retargeted to `VayuController` LTP; Falcon spec `Repository` import fixed.
- **2025+** — See git history for Vayu and Vortex streaming work.
