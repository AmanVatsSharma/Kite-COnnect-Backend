# Kite Connect Backend - GEMINI Context

This file provides foundational guidance and architectural context for Gemini CLI when working in the **kite-connect-backend** workspace.

## Project Overview

The **kite-connect-backend** is an enterprise-grade trading application backend built with **NestJS**. It features a pluggable provider architecture for real-time market data (Kite, Vortex/Rupeezy, Massive/Polygon, Binance), intelligent request batching, Redis caching, and a dual-gateway WebSocket setup (Socket.io and Native WS).

### Core Technologies
- **Framework:** NestJS (Node.js)
- **Language:** TypeScript
- **Database:** PostgreSQL (TypeORM)
- **Caching/PubSub:** Redis (ioredis)
- **Real-time:** Socket.io (/market-data) & Native WebSocket (/ws)
- **Observability:** Prometheus, Sentry, OpenTelemetry
- **Frontend:** React 19 + Vite (Admin Dashboard)
- **Microservices:** MeiliSearch (Search API & Indexer)

## Architecture & Design Patterns

### Monorepo Structure
- `src/`: Core NestJS backend (REST API, WebSockets, Providers).
- `apps/admin-dashboard/`: React 19 Admin SPA (served at `/dashboard`).
- `apps/search-api/`: Standalone microservice for instrument search via MeiliSearch.
- `apps/search-indexer/`: Worker syncing database rows to MeiliSearch.
- `deploy/`: Helm charts and K8s configuration.
- `scripts/`: DevOps and maintenance scripts.

### Hexagonal Feature Slices
Each feature in `src/features/` follows a strict hexagonal layout:
- `application/`: Orchestration, cron jobs, logic.
- `domain/`: TypeORM entities and domain types.
- `infra/`: Outbound adapters (HTTP/WS clients).
- `interface/`: Controllers, Gateways, DTOs.
- `MODULE_DOC.md`: Mandatory documentation for each feature.

### Universal Instrument Registry (UIR)
The project uses a `universal_instruments` table to decouple provider-specific tokens from the internal streaming and search logic. The `InstrumentRegistryService` maps UIR IDs to provider tokens dynamically.

## Development Workflow

### Key Commands

#### Backend (NestJS)
- `npm run start:dev`: Start development server with hot-reload (Port 3000).
- `npm run verify:pr`: **Mandatory** before any PR (Build -> Test -> Circular Check).
- `npm run build`: Full build (Dashboard + NestJS).
- `npm run test`: Run unit tests via Jest.
- `npm run test:e2e`: Run end-to-end tests.
- `npm run check:cycles`: Detect circular imports via Madge.

#### Admin Dashboard (React)
- `npm run admin:dev`: Start Vite dev server.
- `npm run admin:build`: Build dashboard assets to `src/public/dashboard`.
- `npm run dev:full`: Run NestJS and Vite concurrently.

### Standards & Conventions
- **Logging:** Use `private readonly logger = new Logger(Service.name);`. Never use `console.log`.
- **File Headers:** Every `.ts` file must have a JSDoc header with `@file`, `@module`, `@description`, `@author`, `@created`, and `@updated`.
- **Circular Imports:** Avoid new circular imports. Known cycles (MarketData <-> Stock <-> Admin) are allowed via `forwardRef`.
- **Error Handling:** Use global `HttpExceptionFilter`.
- **TODOs:** Mark with `[SonuRamTODO]` for easy tracking.
- **Commits:** Follow the project's commit style (see `git log`).
- **Issue Tracking:** Use **bd (beads)** for task tracking. Run `bd prime` for commands.

## Key Configuration (Environment Variables)

- `DATA_PROVIDER`: Default provider (`kite`, `vortex`, `massive`, `binance`).
- `ADMIN_TOKEN`: Bearer token for `/api/admin/*`.
- `KITE_API_KEY` / `KITE_ACCESS_TOKEN`: Kite Connect credentials.
- `MEILI_HOST_PRIMARY` / `MEILI_MASTER_KEY`: MeiliSearch configuration.
- `CORS_ORIGIN`: Allowed origins (default `*`).

## Safety & Security
- **Credentials:** Never commit `.env` files or hardcode secrets (except where explicitly allowed like Swagger Basic Auth).
- **Git:** Never `git push` before running quality gates (`verify:pr`).
- **Database:** Always use migrations for schema changes.

## Troubleshooting & Health
- **Health Check:** `GET /api/health`
- **Detailed Health:** `GET /api/health/detailed`
- **Prometheus Metrics:** `GET /api/health/metrics`
- **Swagger Docs:** `GET /api/docs` (Protected by Basic Auth: `support@vedpragya.com` / `aman1sharma`)
