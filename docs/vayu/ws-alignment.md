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
  - market_data (server push), subscription_confirmed, unsubscription_confirmed, error

### Limits
- Max 1000 subscriptions per upstream provider socket; enforced during subscribe batching.


