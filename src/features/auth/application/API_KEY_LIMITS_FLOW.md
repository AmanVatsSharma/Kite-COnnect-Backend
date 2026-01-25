# API Key Limits & Monitoring Flow

## Overview

This document explains how **HTTP** and **WebSocket** limits are enforced **per API key**, how usage is tracked in Redis, and how admin endpoints can be used to monitor and adjust these limits at runtime.

---

## 1. HTTP Request Flow (Per-API-Key)

### High-Level Flow

```mermaid
flowchart TD
  A[Client HTTP Request] --> B[Global Interceptors<br/>Metrics + RateLimitInterceptor]
  B --> C[ApiKeyGuard]
  C --> D[ApiKeyService.incrementHttpUsage()]
  D --> E[Redis minute bucket<br/>http:ratelimit:{key}:{minute}]
  E --> F{Exceeded per-minute limit?}
  F -- No --> G[Controller Handler<br/>(e.g., StockController)]
  F -- Yes --> H[429 JSON Error<br/>code=rate_limit_exceeded]
```

### Detailed Steps

1. **Client sends request** with `x-api-key` header or `api_key` query parameter.
2. **Global interceptors** run first (metrics, request-id, response formatting, optional global `RateLimitInterceptor` based on env).
3. **`ApiKeyGuard`**:
   - Validates the API key from header/query.
   - Loads `ApiKey` entity (per-tenant) from Postgres.
   - Calls `ApiKeyService.incrementHttpUsage(key, rate_limit_per_minute)`.
4. **`ApiKeyService.incrementHttpUsage`**:
   - Computes a **minute bucket key**: `http:ratelimit:{key}:{minute}`.
   - Uses `RedisService.get` / `set` to increment a per-minute counter.
   - If current count exceeds `rate_limit_per_minute`, throws `Error('Rate limit exceeded')`.
   - On Redis failure, logs + `console.error` but **does not block** the request (fail-open).
5. **Guard behavior on error**:
   - If limit exceeded → returns structured `400` with:
     - `code: "rate_limit_exceeded"`
     - `limit_per_minute`
   - For Redis / infra errors → logs warning and lets the request through.
6. **Controller executes** and normal business logic runs when not rate-limited.

---

## 2. WebSocket Flow (Per-API-Key Limits)

### Connection & Concurrency Limits

```mermaid
flowchart TD
  A[Socket.IO connect<br/>/market-data] --> B[MarketDataGateway.handleConnection]
  B --> C[ApiKeyService.validateApiKey()]
  C --> D[ApiKeyService.trackWsConnection()]
  D --> E[Redis key ws:connections:{key}]
  E --> F{> connection_limit?}
  F -- No --> G[Connection accepted<br/>ClientSubscription created]
  F -- Yes --> H[Connection rejected<br/>error: connection_limit_exceeded]
```

### Per-Event RPS Limits (Subscribe / Unsubscribe / Set Mode)

```mermaid
flowchart TD
  A[Client WS event<br/>subscribe/unsubscribe/set_mode] --> B[MarketDataGateway]
  B --> C[Resolve apiKey + ApiKey entity]
  C --> D[Determine RPS limit<br/>per-key override OR env default]
  D --> E[ApiKeyService.checkWsRateLimit(apiKey,event,limit)]
  E --> F[Redis second bucket<br/>ws:rate:{apiKey}:{event}:{second}]
  F --> G{Within RPS limit?}
  G -- Yes --> H[Process event<br/>subscriptions / mode change]
  G -- No --> I[WS error event<br/>code=rate_limited,<br/>retry_after_ms]
```

### Key Points

- **Connection count** per API key is tracked via:
  - `ApiKeyService.trackWsConnection(key, connection_limit)`
  - `ApiKeyService.untrackWsConnection(key)`
  - Redis key: `ws:connections:{key}`
- **Event RPS limits**:
  - Fields on `ApiKey`:
    - `ws_subscribe_rps`
    - `ws_unsubscribe_rps`
    - `ws_mode_rps`
  - When `null`, gateway falls back to env vars:
    - `WS_SUBSCRIBE_RPS`, `WS_UNSUBSCRIBE_RPS`, `WS_MODE_RPS`.
  - `ApiKeyService.checkWsRateLimit(scopeId=apiKey, event, limit)`:
    - Uses Redis second buckets `ws:rate:{apiKey}:{event}:{second}`.
    - Returns `{ retry_after_ms }` on limit exceed, **or null** when allowed.
    - On Redis failure, logs + `console.error` and **does not block** the event.
- **Gateway error events**:
  - Emits consistent `error` payloads:
    - `code: 'rate_limited'`
    - `message: '<event> rate limit exceeded for this API key'`
    - `limit`
    - `retry_after_ms`

---

## 3. Admin Monitoring & Control Flow

### Key Entities

- **Database**: `api_keys` table (TypeORM `ApiKey` entity)
  - `rate_limit_per_minute`
  - `connection_limit`
  - `ws_subscribe_rps`, `ws_unsubscribe_rps`, `ws_mode_rps`
- **Redis**:
  - HTTP per-minute buckets: `http:ratelimit:{key}:{minute}`
  - WS connection count: `ws:connections:{key}`
  - WS event RPS buckets: `ws:rate:{key}:{event}:{second}`

### HTTP Admin Endpoints (all behind `AdminGuard`)

```text
POST   /api/admin/apikeys
POST   /api/admin/apikeys/limits
GET    /api/admin/apikeys
GET    /api/admin/apikeys/:key/limits
GET    /api/admin/apikeys/:key/usage
GET    /api/admin/apikeys/usage
GET    /api/admin/ws/status
GET    /api/admin/ws/config
POST   /api/admin/ws/rate-limits
```

#### Create / Update Limits

- `POST /api/admin/apikeys`
  - Creates an API key with:
    - `rate_limit_per_minute`
    - `connection_limit`
    - optional WS RPS overrides (`ws_subscribe_rps`, `ws_unsubscribe_rps`, `ws_mode_rps`).
- `POST /api/admin/apikeys/limits`
  - Partially updates any of the above limit fields for an existing key.
  - Returns the **effective limits** after update.

#### Inspect Limits & Usage

- `GET /api/admin/apikeys/:key/limits`
  - Returns static configuration limits for the given API key.
- `GET /api/admin/apikeys/:key/usage`
  - Combines **limits** + live **usage** from Redis:
    - `httpRequestsThisMinute`
    - `currentWsConnections`
- `GET /api/admin/apikeys/usage?page=&pageSize=`
  - Paginates over all API keys and returns:
    - Basic key info (`key`, `tenant_id`, `is_active`)
    - Configured limits
    - Live usage snapshot per key (same counters as above).

#### WebSocket Status

- `GET /api/admin/ws/status`
  - Uses `MarketDataGateway.getConnectionStats()` to return:
    - `totalConnections`
    - `subscriptions` (per-socket summary)
    - `byApiKey`:
      - `apiKey`
      - `connections`
      - `totalSubscribedInstruments`
  - Also includes streaming provider status from `MarketDataStreamService`.

---

## 4. Resilience & Error Handling

### Redis Failures

- All limit and usage paths go through `RedisService`, which is **optional**.
- On Redis errors:
  - Methods log via Nest `Logger` (where applicable) and `console.error`.
  - HTTP and WebSocket traffic **continues** (fail-open), avoiding outages.

### Client-Facing Errors

- HTTP:
  - When per-API-key HTTP limit is exceeded:
    - `400` JSON body with:
      - `success: false`
      - `code: 'rate_limit_exceeded'`
      - `limit_per_minute`
- WebSocket:
  - When WS RPS limit is exceeded:
    - `error` event with:
      - `code: 'rate_limited'`
      - `message`
      - `limit`
      - `retry_after_ms`

---

## 5. Quick Debugging Cheatsheet

- **Check a single API key limits**:
  - `GET /api/admin/apikeys/{key}/limits`
- **Check a single API key live usage**:
  - `GET /api/admin/apikeys/{key}/usage`
- **See all keys and who is hot**:
  - `GET /api/admin/apikeys/usage?page=1&pageSize=50`
- **See WebSocket pressure per API key**:
  - `GET /api/admin/ws/status` → `byApiKey` section.

Watch server logs / console for:

- `[ApiKeyService] HTTP rate limit exceeded`
- `[ApiKeyService] WS rate limit exceeded`
- `[ApiKeyGuard] HTTP rate limit exceeded`
- `[AdminController] Created API key`
- `[AdminController] Updated API key limits`
- `[AdminController] Read API key usage`
- `[AdminController] Listed API key usage`


