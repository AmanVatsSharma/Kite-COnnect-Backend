# Admin Module

## Purpose

Admin-only endpoints secured by `ADMIN_TOKEN` bearer header. Provides provider control (start/stop streaming, global provider selection), API key management, WebSocket status and configuration, abuse detection, origin audit, and Universal Instrument Registry (UIR) inspection.

## Layout

- `application/` — `OriginAuditService`, `AbuseDetectionService` wrappers, `AuditCleanupCronService`.
- `domain/` — `RequestAuditLog` TypeORM entity.
- `guards/` — `AdminGuard` (validates `Authorization: Bearer <ADMIN_TOKEN>`).
- `interface/` — `AdminController` (main endpoints), `AdminInstrumentsController` (UIR endpoints).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Bearer token required for all `/api/admin/*` endpoints |

## Key Endpoints

### Provider Control
- `POST /api/admin/provider/global` — Set active provider (kite/vortex)
- `POST /api/admin/provider/stream/start` — Start streaming
- `POST /api/admin/provider/stream/stop` — Stop streaming
- `GET  /api/admin/stream/status` — Streaming status + registry stats

### API Key Management
- `POST /api/admin/apikeys` — Create API key
- `GET  /api/admin/apikeys` — List API keys
- `DELETE /api/admin/apikeys/:key` — Revoke API key

### WebSocket Admin
- `GET  /api/admin/ws/status` — WS namespace status
- `GET  /api/admin/ws/instruments/top` — Top subscribed instruments (enriched with canonical symbols)
- `GET  /api/admin/ws/config` — WS rate limit config
- `POST /api/admin/ws/rate-limits` — Update WS rate limits
- `POST /api/admin/ws/blocklist` — Block API keys, tenants, or exchanges from WS subscriptions

### UIR Registry (AdminInstrumentsController)
- `GET  /api/admin/instruments/uir` — Paginated UIR list with provider token coverage
- `GET  /api/admin/instruments/uir/stats` — Coverage breakdown and registry counts
- `GET  /api/admin/instruments/uir/resolve?symbol=NSE:RELIANCE` — Resolve symbol to UIR ID + tokens
- `GET  /api/admin/instruments/uir/unmapped` — Orphaned mappings with no UIR link
- `POST /api/admin/instruments/uir/refresh` — Rebuild in-memory registry from DB

## Changelog

- **2026-04-18** — Added `AdminInstrumentsController` with 5 UIR endpoints (`/api/admin/instruments/uir/*`). Injected `InstrumentRegistryService` into `AdminController`; `GET /api/admin/stream/status` now includes `registry` stats; `GET /api/admin/ws/instruments/top` now enriches each entry with `symbol` (canonical name from registry). `AdminModule` registers `UniversalInstrument` and `InstrumentMapping` entities via `TypeOrmModule.forFeature`.
- **2026-04-19 (credential endpoints)** — Added 6 new admin endpoints for runtime provider credential management: `GET/POST /admin/provider/kite/config|credentials`, `GET/POST /admin/provider/vortex/config|credentials`, `GET/POST /admin/provider/massive/config|credentials`. All persist to `app_configs` DB table, survive restarts, and return masked values with source badge (`db|env|none`). `MassiveProviderService` injected into `AdminController`.
