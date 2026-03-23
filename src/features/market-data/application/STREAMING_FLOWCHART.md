# Streaming Flow (WS)

```
Client → MarketDataGateway (Socket.IO) or NativeWsService (/ws)
      → MarketDataStreamService → MarketDataProviderResolverService
      → Provider ticker (KiteTicker or VortexTicker) → upstream exchange WS
                         ↑                        │
                         └ Redis last_tick + LTP memory cache ─┘
```

## Steps

1. Client subscribes (numeric tokens and/or `EXCHANGE-TOKEN` pairs via Socket.IO).
2. Gateway validates API key, resolves exchanges (explicit pair wins), applies exchange entitlements from the API key record.
3. `MarketDataStreamService.subscribePairs` / `subscribeToInstruments` queues work; **500ms** `setInterval` flushes subscribe/unsubscribe batches (chunk size **500** tokens per `ticker.subscribe` call).
4. Provider ticker emits `ticks` → stream service updates memory + Redis `last_tick:{token}` → `StockService.storeMarketData` broadcasts via gateway.
5. Gateway targets Socket.IO rooms `instrument:{token}`.

## Degraded mode (no ticker / no credentials)

- Provider `initializeTicker()` may return no ticker (Kite/Vortex missing auth). Stream service publishes Redis `stream:status` with `event: 'degraded'`, `reason: 'no_ticker'`, and `provider` label.
- Ticker connect/disconnect/error also publishes `stream:status` with `event` in `connected` | `disconnected` | `error` and `provider`.
- Hot-path logs use Nest `Logger` (debug/warn) with rate limiting for repeated conditions (e.g. batch skipped while ticker disconnected).

## Backpressure

- Subscribe queue capped at **50_000** entries; oldest entries are evicted with counter `market_data_stream_queue_dropped_total{reason="subscribe_evict"}`.
- Unsubscribe `Set` capped at **50_000**; evictions use `reason="unsubscribe_evict"`.
- `provider_queue_depth{endpoint="ws_subscribe|ws_unsubscribe"}` updated from `getQueueStatus()`.

## Metrics (Prometheus)

- `market_data_stream_ticks_ingested_total{provider}` — tick count ingested in stream service.
- `market_data_stream_batch_seconds{provider}` — histogram for one batch flush.
- `market_data_stream_ticker_connected{provider}` — gauge `1` when ticker connected.
- `market_data_stream_queue_dropped_total{reason}` — queue evictions.
- Existing: `ltp_cache_hit_total`, `ltp_cache_miss_total`, `provider_queue_depth`.

## LTP hot path (HTTP batching)

- Memory cache → Redis `last_tick:{token}` → provider fallback via `RequestBatchingService` / `ProviderQueueService` (1 req/s distributed gate, in-memory fallback if Redis lock unavailable).
