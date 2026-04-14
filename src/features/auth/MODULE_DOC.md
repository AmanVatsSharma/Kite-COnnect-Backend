# Auth feature

JWT authentication, API key management, abuse detection service, and provider OAuth flows (Kite Connect + Vortex).

## Changelog

- **2026-04-14** — Phase 3: Manual Kite token exchange endpoint:
  - `auth.controller.ts`: `GET /auth/falcon/callback` now also stores `kite:access_token_created_at = Date.now()` (24h TTL) in Redis alongside the access token, enabling session age tracking.
  - `auth.controller.ts`: `POST /auth/falcon/exchange` — admin-guarded endpoint that accepts `{ requestToken }` in the body, bypasses CSRF state validation, reuses the same token exchange logic as the callback (generates session via KiteConnect SDK, persists `KiteSession` entity, sets Redis keys). Enables manual re-authentication when the OAuth popup flow is blocked.

## Key files

- `interface/auth.controller.ts` — HTTP endpoints: Kite OAuth login/callback/exchange, Vortex OAuth login/callback, API key lifecycle
- `application/` — Business logic: abuse detection, JWT issuing
- `domain/` — TypeORM entities: `KiteSession`, `ApiKey`, `AbuseFlagEntity`

## Environment

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Bearer token required for `POST /auth/falcon/exchange` |
| `KITE_API_KEY`, `KITE_API_SECRET` | Kite Connect credentials for OAuth exchange |
