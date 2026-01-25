# Streaming Flow (WS)

```
Client → MarketDataGateway (Socket.IO) → MarketDataStreamService → VortexProviderService.ticker → Vortex WS
                         ↑                        │                       │
                         └──────────── Redis last_tick + LTP cache ───────┘
```

1) Client subscribes (tokens or EXCHANGE-TOKEN pairs)
2) Gateway validates, resolves exchanges (explicit wins), enforces entitlements
3) StreamService batches and chunks subscribe/unsubscribe to provider ticker
4) Provider ticker emits ticks → StreamService updates memory/Redis → broadcasts
5) Gateway sends to room `instrument:{token}`

Backpressure & Alerts
- Chunk size: 500 per send
- Queue gauges: `provider_queue_depth{endpoint=ws_*}`
- Redis pub/sub `stream:status` → gateway `stream_status` broadcast

LTP Hot Path
- Memory cache (5s) → Redis `last_tick:{token}` → Provider fallback

