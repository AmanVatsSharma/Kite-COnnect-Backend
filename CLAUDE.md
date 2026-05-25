# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (NestJS)

```bash
npm install                  # Install dependencies
npm run start:dev            # Dev server with hot reload (port 3000)
npm run start:debug          # Debug mode with hot reload
npm run start:prod           # Run compiled dist
npm run build                # Build admin dashboard then nest build
npm run test                 # Run all unit tests (jest)
npm run test:watch           # Watch mode
npm run test:cov             # Coverage report
npm run test:e2e             # E2E tests (test/jest-e2e.json)
npm run lint                 # ESLint --fix on src/apps/libs/test
npm run check:cycles         # Madge circular import check (exits non-zero)
npm run check:cycles:warn    # Print cycles but exit 0 (used in verify:pr)
npm run verify:pr            # build + test + check:cycles:warn (run before any PR)
```

To run a single test file:
```bash
npx jest src/features/falcon/application/falcon-instrument.service.spec.ts --no-coverage
```

### Admin Dashboard (React / Vite)

```bash
npm run admin:dev            # Start Vite dev server for dashboard only
npm run admin:build          # Build dashboard into src/public/dashboard
npm run dev:full             # Run NestJS + Vite concurrently (blue/green output)
```

The dashboard is built into `src/public/dashboard/` and served by NestJS at `/dashboard`.

### Cycle detection

```bash
npm run check:cycles         # Fail on any circular imports
npm run check:cycles:warn    # Print cycles but exit 0 (used in verify:pr)
```

Known module cycles (MarketDataModule ↔ StockModule ↔ AdminModule via `forwardRef`) are acceptable; new cycles should not be introduced.

## Architecture

### Monorepo layout

```
src/                   NestJS backend
  app.module.ts        Root module; imports all feature modules
  config/              Database config
  features/            Vertical feature slices (see below)
  infra/               Cross-cutting infra: redis, observability, providers contract, adapters
  shared/              Guards, interceptors, utils shared across features
  migrations/          TypeORM migrations
  public/dashboard/    Built admin dashboard (served statically)
apps/
  admin-dashboard/     React 19 + Vite SPA (TanStack Query, React Router)
  search-api/          Standalone NestJS microservice — instrument search over MeiliSearch
  search-indexer/      One-shot / watch-mode worker syncing UIR rows → MeiliSearch index
```

The two `apps/search-*` services run as separate Docker containers (see `docker-compose.yml`) and are **not** imported into the main NestJS bundle. They communicate with the trading-app over HTTP and share the Postgres + Redis instances.

### Feature module layout (hexagonal)

Every feature under `src/features/<name>/` follows this layout:

| Layer | Purpose |
|-------|---------|
| `application/` | Orchestration services, cron jobs, application logic |
| `domain/` | TypeORM entities, enums, domain types (no HTTP imports) |
| `infra/` | Outbound adapters: provider HTTP/WS clients, external API wrappers |
| `interface/` | NestJS controllers, WebSocket gateways, `dto/` subdirectory |
| `<name>.module.ts` | Nest module wiring |
| `MODULE_DOC.md` | Required per-feature doc: purpose, env vars, changelog |

Cross-feature imports are forbidden; share code only through `src/shared/` or `src/infra/`.

### Feature modules

| Module | Description |
|--------|-------------|
| `market-data` | Real-time streaming core: Socket.IO gateway (`/market-data`), native WS gateway (`/ws`), provider resolver, LTP cache, request batching, synthetic tick pulse |
| `stock` | Vortex (Rupeezy) broker integration: REST + WS ticker, instrument sync/cache/search services, Vayu surface (equity/F&O/options) under `stock/vayu` |
| `falcon` | Kite broker instrument catalog: daily sync cron, `falcon_instruments` table, `FalconProviderAdapter` |
| `kite-connect` | Kite Connect HTTP + WebSocket ticker; implements `MarketDataProvider`; wraps `KiteTicker` via `kite-ticker.facade.ts` |
| `massive` | Massive (formerly Polygon.io) provider for US stocks/forex/crypto/options/indices: REST + WS client, daily ticker sync into `massive_instruments`, multi-stream WS sharding |
| `binance` | Binance.com global Spot crypto provider: public unauthenticated REST + combined-stream WebSocket (JSON-RPC SUBSCRIBE/UNSUBSCRIBE on a single connection, 1024-stream cap), daily sync into `binance_instruments` filtered by `BINANCE_QUOTES` |
| `market-movers` | NSE/BSE top gainers, losers, most active stocks: Alpha Vantage API with Yahoo Finance fallback, 1-hour Redis cache, hourly cron pre-warm |
| `news` | Finnhub financial news aggregator: 5-min polling across general/forex/crypto/commodity, persistence in `news_items`, Redis ring buffer (latest 100), real-time WS push at `/news-ws` namespace |
| `admin` | Admin endpoints (guarded by `ADMIN_TOKEN`), origin audit, abuse detection dashboard |
| `auth` | JWT auth, API key management, abuse detection service |
| `health` | `/api/health` and `/api/health/metrics` (Prometheus) |

### Provider abstraction

`src/features/market-data/infra/market-data.provider.ts` defines `MarketDataProvider` — the contract `KiteProviderService`, `VortexProviderService`, `MassiveProviderService`, and `BinanceProviderService` all implement.

- `DATA_PROVIDER=kite|vortex|massive|binance` sets the default (`polygon` is accepted as an alias for `massive`).
- HTTP endpoints accept `x-provider: kite|vortex|falcon|vayu|massive|polygon|binance` to override per-request. `falcon` and `vayu` are aliases for `kite` and `vortex` respectively; `polygon` is an alias for `massive`; `binance` is canonical.
- The WebSocket provider is set globally by the admin via `POST /api/admin/provider/global`.
- `MarketDataProviderResolverService` handles resolution for both HTTP and WS paths.

### Universal Instrument Registry (UIR)

`universal_instruments` (migration `1713340800000-CreateUniversalInstruments.ts`) is the canonical instrument table that decouples streaming and search from per-provider catalogs. Each row has a stable UIR `id`; per-provider mappings live in `instrument_mappings` (`provider`, `provider_token`, `instrument_token`, `uir_id`).

- `InstrumentRegistryService` (`market-data/application/instrument-registry.service.ts`) is the in-process resolver. It is `refresh()`-ed after every provider's instrument-sync cron (Falcon for Kite, Vortex CSV, Massive `/v3/reference/tickers`).
- The streaming layer subscribes by **UIR id**; the resolver maps it to the active provider's token before passing to the upstream WS.
- The `apps/search-indexer` worker reads UIR + mappings into the MeiliSearch `instruments_v1` index. The `apps/search-api` queries that index and (optionally) hydrates LTP via `POST /api/stock/universal/ltp` on the trading-app.

When adding a new provider: implement `MarketDataProvider`, write an instrument-sync that upserts into `universal_instruments` + `instrument_mappings`, then call `InstrumentRegistryService.refresh()`.

### Streaming architecture

```
Client (Socket.IO /market-data or WS /ws)
  → MarketDataGateway / NativeWsService
  → MarketDataStreamService
  → MarketDataProviderResolverService → Kite | Vortex | Massive | Binance ProviderService
  → Upstream ticker WS (Kite single | Vortex shards | Massive multi-stream | Binance combined-stream)
  → tick → Redis last_tick:{token} + LTP memory cache → broadcast to rooms
```

- **Vortex** supports up to `VORTEX_WS_MAX_SHARDS` (default 3) × 1000 instruments per shard. Subscribe/unsubscribe are batched via a 500ms interval (chunk size 500). Queue cap: 50,000 entries.
- **Massive** uses string symbols (e.g. `AAPL`, `BTC-USD`) as provider tokens; the multi-stream client (`massive-multi-stream.client.ts`) shards across asset classes (`stocks`, `forex`, `crypto`, `options`, `indices`) and re-subscribes on reconnect.
- **Binance** uses uppercase symbol strings (e.g. `BTCUSDT`) as provider tokens; a single combined-stream WS connection (cap 1024 streams) sends `{"method":"SUBSCRIBE","params":["btcusdt@trade"],"id":N}` JSON-RPC frames on an open socket. No auth. Reconnects with exponential backoff and re-subscribes all tracked symbols. Routes via `EXCHANGE_TO_PROVIDER['BINANCE'] = 'binance'`.

### Search service (apps/search-api + search-indexer)

```
search-indexer  ──reads──► Postgres (universal_instruments + instrument_mappings)
                ──writes─► MeiliSearch instruments_v1

Client ──GET /api/search──► search-api ──query──► MeiliSearch
                                       ──POST /api/stock/universal/ltp──► trading-app (LTP hydration)
                                       ──cache──► Redis (q:ltp:uid:{id}, TTL HYDRATE_TTL_MS)
```

`INDEXER_MODE` controls indexer behavior: `backfill` (one-shot), `incremental` (poll), `backfill-and-watch` (default), `synonyms-apply`. See `apps/search-indexer/MODULE_DOC.md` and `apps/search-api/MODULE_DOC.md`.

### Path aliases (tsconfig + jest)

```
@infra/*    → src/infra/*
@shared/*   → src/shared/*
@features/* → src/features/*
@config/*   → src/config/*
```

Use these aliases for all cross-area imports in backend `src/`.

### Admin dashboard

React 19 SPA under `apps/admin-dashboard/`. Pages: Overview, Workspace, ApiKeys, Provider, WsAdmin, Abuse, AuditDebug, Auth, Console, Settings. Wrapped in `TerminalLayout` shell. Uses TanStack Query for data fetching; `RefreshIntervalProvider` controls polling intervals. Served at `/dashboard` by NestJS after `admin:build`.

## Required conventions

### Every PR must pass `npm run verify:pr`

This runs: `build` → `test` → `check:cycles:warn` (madge). New circular imports should not be introduced.

### File headers

All new or substantially edited `.ts` / `.tsx` files require this JSDoc header at the **top** (before any imports):

```ts
/**
 * @file <filename>
 * @module <feature-name>
 * @description <one-line purpose>
 * @author BharatERP
 * @created YYYY-MM-DD
 * @updated YYYY-MM-DD
 *
 * Notes:
 * - <optional: behavior, side-effects, or read-order guidance>
 */
```

For **React components** in `apps/`, `@description` should mention the UI role and main props/data source in one line. The `@updated` tag is included only when behavior or the public API changes.

### PR checklist

- [ ] Plan confirmed with SonuRam ji (the primary developer)
- [ ] Module docs updated (`MODULE_DOC.md` changelog)
- [ ] Top-of-file headers present on all edited files
- [ ] Madge cycle check passed
- [ ] Duplicate-file check passed
- [ ] Changelog entry included

### MODULE_DOC.md

Every `src/features/<name>/` directory must contain `MODULE_DOC.md`. After every meaningful edit to a feature, append a changelog entry (date + summary) to it.

### Logging

- Backend `src/`: use `private readonly logger = new Logger(MyService.name);` — never `console.log`.
- Log levels: `debug` for hot-path tracing, `log`/`warn`/`error` for operational signals.
- Frontend `apps/`: use the small `lib/logger.ts` wrapper (no-ops in production). Never use raw `console.log` in production code paths.
- TODOs: mark with `[SonuRamTODO]` for grep-ability.
- **RequestId/correlation**: attach `requestId` to all HTTP and WebSocket flows via interceptors/guards.

### Error handling

Use Nest **`HttpException`** (and subclasses like `BadRequestException`, `UnauthorizedException`) with appropriate `HttpStatus` for both HTTP and WebSocket surfaces. User-safe messages go to the client; full detail (stack, upstream body if safe) logs at `error` level with `requestId` when available. Extend or add an `ExceptionFilter` to normalize error shape — Sentry/metrics hooks live in `src/infra/observability/`. Do not introduce `AppError` from `src/common/errors/` unless that layer is explicitly adopted.

### DTOs and validation

All inbound controller/gateway payloads go through DTOs with **class-validator** (and `ValidationPipe` where configured). Avoid raw untyped objects in service public APIs — use DTOs or explicit interfaces. Prefer **Zod** in tests to assert DTO/runtime shapes where useful.

### Database

- TypeORM entities live in `domain/` of their feature.
- Schema changes require a migration under `src/migrations/`.
- New entities should use `@PrimaryGeneratedColumn('uuid')`.
- Relations must define **cascade** rules explicitly when ORM-managed deletes matter.

### Redis

`RedisService` (`src/infra/redis/`) is optional — all operations degrade gracefully to null/no-op when Redis is unavailable. Do not use Redis as primary storage; it is a cache and pub/sub layer only.

### Observability

- Prometheus metrics at `GET /api/health/metrics`.
- Sentry: set `SENTRY_DSN` to enable.
- OpenTelemetry: `OTEL_ENABLED=true` and `OTEL_SERVICE_NAME`.

### Naming conventions

| Context | Convention | Examples |
|---------|-----------|----------|
| Backend `src/` files | kebab-case | `stock.controller.ts`, `kite-ticker.facade.ts` |
| React pages/components | PascalCase | `OverviewPage.tsx`, `ProviderCard.tsx` |
| React hooks/utils | camelCase | `useMarketData.ts`, `api-client.ts` |
| Tests | `*.spec.ts` next to source | `stock.service.spec.ts` |

### REST vs GraphQL decision matrix

- **High-frequency transactional endpoints** (orders, modify, cancel, fills) → REST for minimal overhead and deterministic latency.
- **Flexible cross-entity reads** (admin dashboards, analytics, positions) → GraphQL or REST with aggregation endpoints.
- Both needed → separate REST gateway (`/api/rest`) and GraphQL admin gateway (`/api/graphql`) sharing the same services layer.

## Key environment variables

| Variable | Description |
|----------|-------------|
| `DATA_PROVIDER` | `kite` / `vortex` / `massive` / `binance` — default provider (`polygon` accepted as alias for `massive`) |
| `ADMIN_TOKEN` | Bearer token for all `/api/admin/*` endpoints |
| `KITE_API_KEY`, `KITE_ACCESS_TOKEN` | Kite Connect credentials |
| `VORTEX_APP_ID`, `VORTEX_API_KEY`, `VORTEX_BASE_URL` | Vortex REST credentials |
| `VORTEX_WS_URL`, `VORTEX_INSTRUMENTS_CSV_URL` | Vortex WS and instrument CSV |
| `VORTEX_WS_MAX_SHARDS` | Max Vortex WS shards (default 3) |
| `FALCON_INSTRUMENT_SYNC_ENABLED` | `true`/`false` to toggle Kite daily instrument cron |
| `FALCON_INSTRUMENTS_CRON` | Cron expression, default `45 9 * * *` (IST) |
| `MARKET_DATA_SYNTHETIC_INTERVAL_MS` | `0` = off; >0 = ms interval for synthetic tick re-emit |
| `MASSIVE_API_KEY` | Required for Massive/Polygon provider |
| `MASSIVE_REALTIME` | `true` = realtime feed (`socket.massive.com`); `false` (default) = delayed feed |
| `MASSIVE_WS_ASSET_CLASS` | `stocks` (default) / `forex` / `crypto` / `options` / `indices` |
| `MASSIVE_INSTRUMENT_SYNC_ENABLED`, `MASSIVE_INSTRUMENTS_CRON` | Toggle + schedule Massive ticker sync (default `15 10 * * *` America/New_York) |
| `MASSIVE_WS_REJECT_UNAUTHORIZED` | `false` to skip TLS verification for self-signed/proxy certs (dev only) |
| `MASSIVE_POLL_INTERVAL_MS` | REST polling interval when WS is unavailable (default `5000`; min `2000` to avoid rate limits) |
| `BINANCE_INSTRUMENT_SYNC_ENABLED` | `true`/`false` — daily Binance Spot exchangeInfo sync cron toggle |
| `BINANCE_INSTRUMENTS_CRON`, `BINANCE_INSTRUMENTS_CRON_TZ` | Cron expression + tz (default `30 0 * * *` UTC) |
| `BINANCE_QUOTES` | Comma-separated quote-asset whitelist for sync (default `USDT,USDC,BUSD,BTC,ETH`) |
| `BINANCE_WS_RECONNECT_MAX_ATTEMPTS` | Cap on WS exponential-backoff reconnects (default `10`) |
| `MEILI_HOST_PRIMARY`, `MEILI_MASTER_KEY`, `MEILI_INDEX` | MeiliSearch wiring for `apps/search-api` and `apps/search-indexer` |
| `INDEXER_MODE` | `backfill` / `incremental` / `backfill-and-watch` (default) / `synonyms-apply` |
| `FUNDAMENTALS_CACHE_TTL_HOURS` | Cache TTL in hours for fundamentals data (default `24`) |
| `YFINANCE_FALLBACK_ENABLED` | Enable Yahoo Finance free endpoints as fallback (default `true`) |
| `ALPHA_VANTAGE_API_KEY` | Free key from alphavantage.co for market movers (TOP_GAINERS/TOP_LOSERS/TOP_AGGRESSIVE_CAPITAL_GAINERS). Falls back to Yahoo Finance index-level data if absent. |
| `MARKET_MOVERS_CRON` | Cron expression for hourly cache warm (default `5 * * * *`) |
| `MARKET_MOVERS_PREWARM` | Set `false` to skip on-module-init cache warm |
| `FINNHUB_API_KEY` | Finnhub.io API key for news polling (free tier: 60 req/min) |
| `NEWS_POLL_INTERVAL_MS` | News scheduler poll interval in ms (default `300000` = 5 min) |
| `NEWS_CACHE_TTL_SECONDS` | Redis cache TTL for Finnhub responses (default `300`) |
| `NEWS_POLLING_ENABLED` | Set `false` to disable the news scheduler |
| `SENTRY_DSN`, `OTEL_ENABLED` | Observability (optional) |

### Production Server

**Instance:** AWS EC2 `i-050ba09433461c10f` (ap-south-2 / Mumbai)

| Detail | Value |
|--------|-------|
| Public DNS | `ec2-18-60-117-225.ap-south-2.compute.amazonaws.com` |
| SSH user | `ubuntu` |
| Key file | `~/Desktop/Key_Pairs/Ap-south-2.pem` (Mumbai key) |

**Services running:**

| Service | Manager | Details |
|---------|---------|---------|
| `trading-app` | **PM2** (`pm2 status`) | NestJS on port 3000, watch disabled |
| `trading-search-api` | **Docker** | `kite-connect-backend-search-api`, port 3002 |
| `trading-search-indexer` | **Docker** | `kite-connect-backend-search-indexer`, incremental mode |
| `trading-postgres` | **Docker** | `postgres:15-alpine`, port 5432 |
| `trading-meilisearch` | **Docker** | `meilisearch:v1.8`, port 7700 |
| `redis-server` | **systemd** | Local Redis 7.0, bind `0.0.0.0:6379` (required for Docker containers to reach host Redis via `host.docker.internal` or Docker bridge `172.17.0.1`) |

**Common operations:**

```bash
# SSH
ssh -i ~/Desktop/Key_Pairs/Ap-south-2.pem ubuntu@ec2-18-60-117-225.ap-south-2.compute.amazonaws.com

# PM2 (main NestJS app)
pm2 status              # list all processes
pm2 logs trading-app    # stream logs
pm2 restart trading-app # restart after code deploy

# Docker (search-api, search-indexer, postgres, meilisearch)
sudo docker ps -a
sudo docker logs trading-search-indexer --tail 50 -f  # watch indexer
sudo docker restart trading-search-api

# Redis
sudo systemctl status redis-server
sudo systemctl restart redis-server  # if Redis bind fails: check /etc/redis/redis.conf → bind 127.0.0.1

# Deploy (from local)
# 1. Build locally: npm run build
# 2. scp dist to server, or git pull on server
# 3. pm2 restart trading-app
```

**Known issue:** Redis must bind to `0.0.0.0` (not `127.0.0.1` or Docker bridge IP) for Docker containers to reach it. If containers can't connect: `sudo sed -i 's/^bind .*/bind 0.0.0.0/' /etc/redis/redis.conf && sudo systemctl restart redis-server`


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->