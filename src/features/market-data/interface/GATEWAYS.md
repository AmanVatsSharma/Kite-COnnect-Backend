# WebSocket Gateway Architecture

## Overview

Market data is exposed over:

- **Socket.IO** — `MarketDataGateway` on namespace `/market-data` (primary SaaS path).
- **Native WebSocket** — `NativeWsService` on path `/ws` (manual upgrade, same stream backend).

Both validate API keys, respect rate limits, and delegate to `MarketDataStreamService`.

## Architecture Flow

```mermaid
sequenceDiagram
    participant Client as WebSocket Client
    participant Gateway as MarketDataGateway
    participant StreamService as MarketDataStreamService
    participant Resolver as MarketDataProviderResolverService
    participant Provider as KiteOrVortexProvider
    participant Upstream as ExchangeTickerWS

    Client->>Gateway: connect with api_key
    Gateway->>Gateway: validate API key
    Gateway->>Gateway: create ClientSubscription
    Gateway-->>Client: connected event

    Client->>Gateway: subscribe instruments mode
    Gateway->>Gateway: validate mode resolve exchanges entitlements
    Gateway->>StreamService: subscribePairs subscribeToInstruments
    StreamService->>StreamService: queue subscription 500ms batching
    StreamService->>Provider: ticker.subscribe chunked
    Provider->>Upstream: subscribe frames

    Upstream-->>Provider: ticks
    Provider->>StreamService: ticks event
    StreamService->>Gateway: broadcast to rooms
    Gateway-->>Client: market_data
```

## Provider-prefixed subscriptions (`Provider:identifier`)

Both surfaces accept a per-instrument prefix that pins the subscription to a specific provider's data feed and bypasses cross-provider routing.

| Form | Resolves to | Routes via |
|---|---|---|
| `Falcon:reliance` / `Kite:reliance` | RELIANCE in Kite mappings (exact underlying or canonical) | Kite ticker only |
| `Vayu:26000` / `Vortex:NSE_EQ-26000` | Vortex token (numeric or pair-form) | Vortex ticker only |
| `Massive:AAPL` / `Polygon:AAPL` | Massive symbol | Massive ticker only |
| `Binance:BTCUSDT` | Binance Spot symbol | Binance combined-stream only |

**Resolution rules** (provider-scoped, O(1)):
1. Numeric / pair-form input → direct `provider:token` key in `InstrumentRegistryService`.
2. Exact canonical (`NSE:RELIANCE`) — only if the requested provider has a mapping for that UIR.
3. Underlying name (`RELIANCE`) — case-insensitive; EQ preferred over IDX; NSE preferred for India. FUT/CE/PE never auto-resolve.

The prefix splits on the **first colon**, so `Falcon:NSE:RELIANCE` is `provider=kite, identifier="NSE:RELIANCE"`. Strings whose prefix is not a recognized alias (e.g. `NSE:RELIANCE`, `BSE:TCS`) fall through to existing canonical resolution unchanged.

**Errors:**
- `forced_provider_unavailable` — emitted per-token when the requested provider has no active upstream connection. No silent fallback.
- Unresolved / ambiguous identifiers within the requested provider's catalog appear in `subscription_confirmed.unresolvedSymbols` with provider context.

**Confirmation:** `subscription_confirmed.forced` lists each pinned subscription as `{ symbol, uirId, provider, canonical }`.

**Pinning lifecycle:** the pin lives in `MarketDataStreamService.forcedProviderByUir` for the lifetime of any subscriber. `getBestProviderForUirId` and the kite↔vortex dual-subscribe path are skipped for pinned UIRs. The pin clears automatically when the last client unsubscribes from that UIR.

`unsubscribe` accepts the same `Provider:identifier` syntax — useful when the client's own bookkeeping is keyed by the prefixed form.

## Entitlements (exchange allow-list)

- On **subscribe**, resolved exchanges are compared to the API key allowed exchange set. Pairs outside the set appear in `forbidden` on `subscription_confirmed` and emit `error` with `code: forbidden_exchange`.
- On **API key entitlement hot-reload** (`api_key_updates` Redis channel), the gateway re-resolves tokens. **Fail-open for unresolved exchange**: if the resolver cannot map a token to an exchange, the token is **not** revoked (only tokens with a **resolved** exchange **not** in the allow-list are revoked). See `handleApiKeyUpdate` in `market-data.gateway.ts`.

## Modes and outbound tick shape

- Subscribe with `mode`: `ltp` | `ohlcv` | `full`. Upstream (Vortex) receives the same mode on JSON subscribe frames; if a token is already subscribed at a lower mode, the Vortex layer **upgrades** mode by re-sending subscribe with the higher mode.
- **`market_data`** to each client is filtered to match that client’s `modeByInstrument` for the token (LTP-only clients do not receive full depth in the payload).

## Native WebSocket (`/ws`)

- Message: `{ "event": "set_mode", "data": { "instruments": [26000], "mode": "full" } }` — same semantics as Socket.IO `set_mode` (only tokens already subscribed are updated).
- `subscription_confirmed` includes `limits` when available (`maxUpstreamInstruments`, Vortex `maxVortexShards`, etc.).

## Socket.IO limits ack

- `subscription_confirmed.limits` includes `maxUpstreamInstruments` (total across Vortex shards when using Vortex), plus `maxSubscriptionsPerSocket`, `maxVortexShards`, `maxVortexInstruments` when `getVortexWsLimits()` is available.

## Batching

- Subscriptions are queued and flushed every **500ms**.
- Chunk size **500** instruments per provider subscribe call.
- Queue depth surfaces in `subscription_confirmed.queues` and Prometheus `provider_queue_depth`.

## Stream status (Redis)

- `MarketDataStreamService` publishes `stream:status` for `connected`, `disconnected`, `error`, and `degraded` (no ticker). Gateway can forward as `stream_status` to clients where implemented.

## Error handling

- Rate limits: `rate_limited` errors with `retry_after_ms`.
- Streaming inactive: `stream_inactive` if admin has not started the provider stream (`isStreaming` false).
- Provider errors: Nest `Logger`; degraded HTTP paths return empty objects from providers where configured (Kite when REST client missing).
