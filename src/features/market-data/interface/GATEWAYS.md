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

## Entitlements (exchange allow-list)

- On **subscribe**, resolved exchanges are compared to the API key allowed exchange set. Pairs outside the set appear in `forbidden` on `subscription_confirmed` and emit `error` with `code: forbidden_exchange`.
- On **API key entitlement hot-reload** (`api_key_updates` Redis channel), the gateway re-resolves tokens. **Fail-open for unresolved exchange**: if the resolver cannot map a token to an exchange, the token is **not** revoked (only tokens with a **resolved** exchange **not** in the allow-list are revoked). See `handleApiKeyUpdate` in `market-data.gateway.ts`.

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
