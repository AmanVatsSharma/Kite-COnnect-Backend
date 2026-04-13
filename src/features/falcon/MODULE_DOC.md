# Falcon feature

Provider-facing **Kite (Falcon)** instrument catalog: `falcon_instruments`, sync from Kite instruments API, optional LTP enrichment via `FalconProviderAdapter`.

## Changelog

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
