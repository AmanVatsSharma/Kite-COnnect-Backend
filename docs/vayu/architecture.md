## Vayu Architecture

### Overview
- Provider-level distributed gate (1/sec per endpoint) with jitter using Redis locks
- Request batching (per-instance) → provider queue gate → Vortex HTTP
- Rolling in-memory LTP cache (5s TTL, LRU 10k)
- Instrument sync daily @08:45 with retry/backoff

### Flowcharts

```mermaid
sequenceDiagram
  participant Client
  participant Gateway as WS/REST Gateway
  participant Batch as RequestBatching
  participant Gate as ProviderQueue (Redis)
  participant Vortex as Vortex API

  Client->>Gateway: quotes/ltp/ohlc
  Gateway->>Batch: enqueue(tokens, type)
  Batch->>Gate: execute(endpoint, chunk)
  Gate->>Vortex: GET /data/quotes?...
  Vortex-->>Gate: data
  Gate-->>Batch: data
  Batch-->>Gateway: merged + fallback LTP
  Gateway-->>Client: response
```

```mermaid
sequenceDiagram
  participant Stream as MarketDataStream
  participant Provider as Vortex WS
  participant Mem as LTP Memory Cache
  participant Redis as Redis
  participant Broad as Gateways

  Provider-->>Stream: binary ticks
  Stream->>Mem: set(token, last_price)
  Stream->>Redis: set last_tick:token
  Stream->>Broad: broadcast market_data
```


