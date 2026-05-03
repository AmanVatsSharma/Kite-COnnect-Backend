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
| GET | /api/search/stream | SSE stream of LTP ticks (UIR ids — provider-agnostic) |
| GET | /api/search/admin/overview | **Admin** — Meili stats + synonym signals + popular queries (gated by `x-admin-token`) |
| GET | /api/health | Health check |

## Public vs admin response

By default `/api/search` and `/api/search/suggest` return a **public** payload — internal token fields stripped, `streamProvider` mapped to public brand names. Pass `?include=internal` together with the `x-admin-token` header to receive the admin payload (adds `_internalProvider`, `kiteToken`, `vortexToken`, `vortexExchange`, `massiveToken`, `binanceToken`).

| Internal name | Public brand (in `streamProvider`) | Coverage |
|---------------|------------------------------------|----------|
| `kite` | `falcon` | Indian equity (NSE/BSE) |
| `vortex` | `vayu` | F&O / currency / commodities |
| `massive` | `atlas` | US stocks / forex / options / indices |
| `binance` | `drift` | Global crypto Spot |

`?streamProvider=` accepts both internal canonicals and public brand names, so admin tools can keep filtering by `kite`/`vortex`/etc. while public clients filter by `falcon`/`vayu`/`atlas`/`drift`.

## Field projection (`?fields=`)

Pass `?fields=symbol,exchange,last_price` to narrow the response to just those public fields. Allow-list only — unknown field names are silently dropped. Anchor fields (`id`, `canonicalSymbol`, `wsSubscribeUirId`, `last_price`, `priceStatus`, `streamProvider`) are always returned regardless of `?fields`. The same list is forwarded to MeiliSearch's `attributesToRetrieve` so payload size shrinks at the source.

## Key Query Parameters (search / suggest)

| Param | Type | Notes |
|-------|------|-------|
| q | string | Required. Min 1 char for search, 2+ for suggest. |
| limit | number | Max 50 (search), max 20 (suggest) |
| exchange | string | NSE / BSE / MCX / BINANCE / NASDAQ / NYSE |
| segment | string | EQ / FO / CUR / COM / spot / forex / crypto |
| instrumentType | string | EQ / FUT / CE / PE / ETF |
| vortexExchange | string | NSE_EQ / NSE_FO / NSE_CUR / MCX_FO |
| streamProvider | string | Public: `falcon` / `vayu` / `atlas` / `drift` (also accepts internal `kite` / `vortex` / `massive` / `binance` for backward-compat) |
| fields | string | Comma-separated allow-list of fields to return (anchors always included) — see Field projection |
| include | string | `internal` (admin-only, requires `x-admin-token`) — adds `_internalProvider` + raw `*Token` fields |
| mode | string | eq / fno / curr / commodities (shorthand for vortexExchange) |
| ltp_only | boolean | When true, only return instruments with a live LTP > 0 |
| expiry_from / expiry_to | string | ISO date range for derivatives |
| strike_min / strike_max | number | Strike price range |

## Result Shape (per row)

### Public response (default)

```json
{
  "id": 355010,
  "canonicalSymbol": "BINANCE:BTCUSDT",
  "symbol": "BTCUSDT",
  "exchange": "BINANCE",
  "segment": "spot",
  "instrumentType": "EQ",
  "assetClass": "crypto",
  "streamProvider": "drift",
  "wsSubscribeUirId": 355010,
  "last_price": 50123.45,
  "priceStatus": "live"
}
```

- Internal token fields (`kiteToken`, `vortexToken`, `vortexExchange`, `massiveToken`, `binanceToken`) are **not** present in the public response. They are not actionable for clients (everyone subscribes by UIR id) and would expose the underlying broker stack.
- `streamProvider` is the **public brand name** (`falcon` / `vayu` / `atlas` / `drift`) — never the internal canonical (`kite` / `vortex` / `massive` / `binance`).

### Admin response (`?include=internal` + `x-admin-token`)

Adds the internal token fields and the synthetic `_internalProvider` (raw internal name pre-mapping). Used by the admin dashboard's Search page to render the VIA badge tooltip and copy raw tokens during debugging.

```json
{
  "id": 355010,
  "canonicalSymbol": "BINANCE:BTCUSDT",
  "symbol": "BTCUSDT",
  "exchange": "BINANCE",
  "streamProvider": "drift",
  "_internalProvider": "binance",
  "binanceToken": "BTCUSDT",
  "kiteToken": null,
  "vortexToken": null,
  "vortexExchange": null,
  "massiveToken": null,
  "wsSubscribeUirId": 355010,
  "last_price": 50123.45,
  "priceStatus": "live"
}
```

- `wsSubscribeUirId` is always `id` — explicit hint that clients should pass it in the `/ws` subscribe payload `{event:"subscribe", data:{instruments:[<id>], mode:"ltp"}}`.
- `priceStatus` is `"live"` when `last_price > 0`, otherwise `"stale"`. The default behavior is to return all rows and tag stale ones; pass `?ltp_only=true` to filter them out.
- `streamProvider` is the routing fact (which provider streams this instrument's ticks) as a public brand name. Useful for filtering and badging — clients should NOT derive subscribe routing from it (the backend's `UniversalLtpService` picks the right provider per-instrument).

## LTP Hydration

`hydrateLtpByItems()` calls `POST /api/stock/universal/ltp` on the trading-app with universal instrument IDs. The trading-app resolves the correct provider (kite / vortex / massive / binance) internally and returns prices keyed by universal ID. Results are cached in Redis (key: `q:ltp:uid:{id}`, TTL from `HYDRATE_TTL_MS`).

## SSE Stream (`GET /api/search/stream`)

| Param | Type | Notes |
|-------|------|-------|
| ids | string | Comma-separated UIR ids (preferred). Cap 100. |
| tokens | string | Legacy alias for `ids` (older clients passed UIR ids under this name). |
| q | string | Alternative: auto-resolve top-N matching UIR ids from a search query. |
| ltp_only | boolean | Drop entries with no live price from each tick payload. |

Polls every 1s for up to `SSE_DEFAULT_TTL_MS` (default 30s). Each frame is keyed by UIR id and routed through `/api/stock/universal/ltp` — works for kite / vortex / massive / binance instruments equally without per-provider branching in the SSE handler.

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

- **2026-05-01** — **Provider name masking + field projection + admin panel.**
  - Public response now uses brand names (`falcon`/`vayu`/`atlas`/`drift`) for `streamProvider`. Internal token fields (`kiteToken`, `vortexToken`, `vortexExchange`, `massiveToken`, `binanceToken`) are stripped from the default response.
  - `?include=internal` + `x-admin-token` opens up the admin payload (adds `_internalProvider` plus the raw token fields).
  - `?fields=...` (allow-list) projects the response shape and forwards to MeiliSearch's `attributesToRetrieve` for payload-size reduction.
  - New `GET /api/search/admin/overview` returns Meili index stats, top selection signals, and popular queries — backing the new SearchAdmin page in the admin dashboard.
  - New file: `provider-aliases.ts` (search-api-local copy of `src/shared/utils/provider-label.util.ts`; kept in sync manually because the search-api container doesn't share the main backend's tsconfig).
- **2026-04-28** — Multi-provider parity. `SearchResultItem` widened with `massiveToken`, `binanceToken`, `streamProvider`, `wsSubscribeUirId`, `priceStatus`. `?streamProvider=` query filter wired through to MeiliSearch. `/search` and `/suggest` enrich each row via `enrichRow()` so frontends receive a clear "subscribe with this id" hint and can mark stale prices without hiding them. SSE `/api/search/stream` rewritten to drive off UIR ids → `hydrateLtpByItems` (single, provider-agnostic poll). `?tokens=` preserved as a backwards-compat alias for `?ids=`. `attributesToRetrieve` extended to pull the new fields.
- **2026-04-25** — `hydrateLtpByItems()` refactored: replaced two-path vortex-pairs + kite-fallback with single call to `POST /api/stock/universal/ltp`. Cache key changed from `q:ltp:{providerToken}` to `q:ltp:uid:{universalId}`.
- **2026-04-22** — Initial implementation: search, suggest, filters, popular, telemetry, SSE stream endpoints. 2-server MeiliSearch failover pool with per-server circuit breaker. Redis LTP cache.
