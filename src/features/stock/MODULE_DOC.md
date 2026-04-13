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

- **2026-03-28** — **Vortex instruments**: monolithic `vortex-instrument.service.ts` split into `vortex-instrument-sync`, `-cleanup`, `-cache`, `-ltp`, `-search`, `-read` services with **unchanged** `VortexInstrumentService` facade API. Helpers in `vortex-instrument-helpers.ts`. **Stock REST**: `stock.controller.ts` split into `stock-instruments`, `stock-quotes`, `stock-subscriptions` controllers (same `stock` prefix). **Vortex provider**: CSV + binary tick parsing moved to `vortex-csv.util.ts`, `vortex-ws-binary-tick.parser.ts`. Unit test `stock.controller.spec` retargeted to `VayuController` LTP; Falcon spec `Repository` import fixed.
- **2025+** — See git history for Vayu and Vortex streaming work.
