# search-api

## Purpose

NestJS microservice that provides instrument search over a MeiliSearch index. Clients (broker app, admin dashboard) query `/api/search` to find instruments by symbol, name, or partial text — with optional LTP hydration from the trading-app.

## Docker Compose

- Service name: `search-api`
- Container: `trading-search-api`
- Internal port: `3000` (mapped to host `3002`)
- Nginx proxy: `upstream search_api { server localhost:3002; }` → `location /api/search`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/search | Full instrument search with LTP hydration |
| GET | /api/search/suggest | Lightweight typeahead (smaller default limit) |
| GET | /api/search/filters | Facet distributions for filter UIs |
| GET | /api/search/popular | Placeholder for trending instruments |
| POST | /api/search/telemetry/selection | Synonym learning signal |
| GET | /api/search/stream | SSE stream of LTP ticks for given tokens |
| GET | /api/health | Health check |

## Key Query Parameters (search / suggest)

| Param | Type | Notes |
|-------|------|-------|
| q | string | Required. Min 1 char for search, 2+ for suggest. |
| limit | number | Max 50 (search), max 20 (suggest) |
| exchange | string | NSE / BSE / MCX |
| segment | string | EQ / FO / CUR / COM |
| instrumentType | string | EQ / FUT / CE / PE / ETF |
| vortexExchange | string | NSE_EQ / NSE_FO / NSE_CUR / MCX_FO |
| mode | string | eq / fno / curr / commodities (shorthand for vortexExchange) |
| ltp_only | boolean | When true, only return instruments with a live LTP > 0 |
| expiry_from / expiry_to | string | ISO date range for derivatives |
| strike_min / strike_max | number | Strike price range |

## LTP Hydration

`hydrateLtpByItems()` calls `POST /api/stock/universal/ltp` on the trading-app with universal instrument IDs. The trading-app resolves the correct provider (vortex or kite) internally and returns prices keyed by universal ID. Results are cached in Redis (key: `q:ltp:uid:{id}`, TTL from `HYDRATE_TTL_MS`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MEILI_HOST_PRIMARY | http://meilisearch:7700 | Primary MeiliSearch server |
| MEILI_HOST_SECONDARY | (empty) | Optional failover MeiliSearch server |
| MEILI_MASTER_KEY | — | Required. MeiliSearch authentication key |
| MEILI_INDEX | instruments_v1 | Index name |
| MEILI_TIMEOUT_MS | 1200 | Per-request timeout to MeiliSearch |
| HYDRATION_BASE_URL | http://trading-app:3000 | Trading-app base URL for LTP hydration |
| HYDRATION_API_KEY | — | x-api-key header sent to trading-app |
| HYDRATE_TTL_MS | 800 | Redis cache TTL for LTP prices |
| HYDRATE_TIMEOUT_MS | 1500 | Timeout for hydration HTTP calls |
| HYDRATE_CB_THRESHOLD | 3 | Failures before hydration circuit breaker opens |
| HYDRATE_CB_OPEN_MS | 2000 | Circuit breaker open duration |
| REDIS_HOST | redis | Redis host for LTP cache + synonym telemetry |
| REDIS_PORT | 6379 | Redis port |
| LTP_ONLY_PROBE_MULTIPLIER | 5 | Multiplier for probe set when ltp_only=true |
| SEARCH_LTP_ONLY_HYDRATE_CAP | 200 | Max probe size for ltp_only search |
| SSE_DEFAULT_TTL_MS | 30000 | SSE stream lifetime |

## Changelog

- **2026-04-25** — `hydrateLtpByItems()` refactored: replaced two-path vortex-pairs + kite-fallback with single call to `POST /api/stock/universal/ltp`. Cache key changed from `q:ltp:{providerToken}` to `q:ltp:uid:{universalId}`.
- **2026-04-22** — Initial implementation: search, suggest, filters, popular, telemetry, SSE stream endpoints. 2-server MeiliSearch failover pool with per-server circuit breaker. Redis LTP cache.
