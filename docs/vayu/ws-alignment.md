## Vayu WebSocket Alignment with Vortex

### Upstream (Provider) WS
- URL: wss://wire.rupeezy.in/ws?auth_token={{access_token}}
- Subscribe/Unsubscribe frames (text JSON):
  - { "exchange": "NSE_EQ", "token": 26000, "mode": "ltp", "message_type": "subscribe" }
  - { "exchange": "NSE_EQ", "token": 26000, "mode": "ltp", "message_type": "unsubscribe" }
- Binary ticks: little endian, record-length-prefixed (22=ltp, 62=ohlcv, 266=full)

### Client WS (Socket.IO)
- Namespace: /market-data
- Auth: ?api_key=… or x-api-key header
- Events:
  - subscribe { instruments: number[], mode: 'ltp'|'ohlcv'|'full' }
  - unsubscribe { instruments: number[] }
  - get_quote { instruments: number[], ltp_only?: boolean }
  - market_data (server push), subscription_confirmed, unsubscription_confirmed, welcome, whoami, error

### Limits
- Max 1000 subscriptions per upstream provider socket; enforced during subscribe batching.


### Welcome payload

On connection, the server emits a `welcome` event to guide the client:

```json
{
  "protocol_version": "2.0",
  "message": "Welcome to Vedpragya MarketData Solutions",
  "provider": "Vayu",
  "exchanges": ["NSE_EQ", "NSE_FO", "NSE_CUR", "MCX_FO"],
  "limits": { "connection": 3, "maxSubscriptionsPerSocket": 1000 },
  "instructions": {
    "subscribe": "socket.emit('subscribe', { instruments: [26000, 'NSE_FO-135938'], mode: 'ltp' })"
  },
  "apiKey": {
    "tenant": "...",
    "currentWsConnections": 1,
    "httpRequestsThisMinute": 0,
    "note": "Your API key is enabled for Vayu provider. Exchanges reflect entitlements."
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### Subscribe input and resolution

- You may pass tokens-only (numeric) and the server auto-resolves exchanges using the same precedence as Vayu REST (`vortex_instruments → instrument_mappings(provider=vortex) → instruments`).
- You may also pass explicit pairs in the same array using `EXCHANGE-TOKEN` strings (e.g., `"NSE_FO-135938"`).
- Tokens whose exchanges cannot be resolved are NOT subscribed and are reported in `unresolved`.

`subscription_confirmed` ack example:

```json
{
  "requested": [26000, "NSE_FO-135938"],
  "pairs": ["NSE_EQ-26000", "NSE_FO-135938"],
  "included": [26000, 135938],
  "unresolved": [11536],
  "forbidden": [{ "token": 135938, "exchange": "MCX_FO" }],
  "snapshot": { "26000": { "last_price": 17624.05 } },
  "mode": "ltp",
  "limits": { "maxSubscriptionsPerSocket": 1000 },
  "timestamp": "2025-01-01T10:00:05.000Z"
}
```

For each unresolved token, an `error` event is also emitted:

```json
{ "code": "exchange_unresolved", "token": 11536, "message": "Cannot auto-resolve exchange; please subscribe using EXCHANGE-TOKEN (e.g., NSE_FO-<token>)" }
```

### Flowchart (resolution path)

```mermaid
flowchart TD
  A[Client instruments (numbers or EXCHANGE-TOKEN)] -->|parse| B{Explicit pair?}
  B -- yes --> C[Use provided exchange]
  B -- no --> D[Resolve via DB: vortex_instruments → instrument_mappings → instruments]
  C --> E[Build pairs]
  D --> E
  E -->|filter entitlements| X{allowed?}
  X -- no --> Y[forbidden]
  X -- yes --> Z[prime mapping]
  Z --> F[Provider ticker]
  F -->|subscribe only resolved| G[Upstream WS subscriptions]
  E --> H[unresolved list]
  H --> I[Emit error exchange_unresolved]
  Y --> J[Emit error forbidden_exchange]
  G --> J[Emit subscription_confirmed]
```

### Additional events

- `whoami` → returns protocol_version, provider, entitlements, limits, current subscriptions.
- `set_mode` → `{ instruments, mode }` → `mode_set` ack `{ updated, not_subscribed, unresolved }`.
- `list_subscriptions` → `{ tokens, pairs, modes, count }`.
- `unsubscribe_all` → `{ removed_count }`.
- `ping` → server emits `pong { t, protocol_version }`.
- `status` → streaming status + gateway stats.

### Admin REST endpoints (Swagger)

- `GET /api/admin/ws/status` → namespace stats + provider streaming status.
- `GET /api/admin/ws/config` → effective limits and defaults.
- `POST /api/admin/ws/rate-limits` → update event RPS thresholds.
- `POST /api/admin/ws/entitlements` → set API key exchange allowlist.
- `POST /api/admin/ws/blocklist` → add to WS blocklist (demo Redis-based).
- `POST /api/admin/ws/flush` → flush selected caches.
- `POST /api/admin/ws/namespace/broadcast` → emit a custom event for testing.

### Error codes

| code | meaning |
|------|---------|
| missing_api_key | x-api-key is required |
| invalid_api_key | API key not found/disabled |
| invalid_payload | payload shape is invalid |
| invalid_mode | mode must be ltp|ohlcv|full |
| stream_inactive | streaming not started by admin |
| exchange_unresolved | cannot auto-resolve exchange; send EXCHANGE-TOKEN |
| forbidden_exchange | API key not entitled for exchange |
| rate_limited | per-event rate limit exceeded |
| subscribe_failed | subscribe handler error |
| unsubscribe_failed | unsubscribe handler error |
| set_mode_failed | set_mode handler error |
| status_failed | status handler error |
| whoami_failed | whoami handler error |


