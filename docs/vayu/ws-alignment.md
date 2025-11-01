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
  - market_data (server push), subscription_confirmed, unsubscription_confirmed, welcome, error

### Limits
- Max 1000 subscriptions per upstream provider socket; enforced during subscribe batching.


### Welcome payload

On connection, the server emits a `welcome` event to guide the client:

```json
{
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
  E -->|prime mapping| F[Provider ticker]
  F -->|subscribe only resolved| G[Upstream WS subscriptions]
  E --> H[unresolved list]
  H --> I[Emit error exchange_unresolved]
  G --> J[Emit subscription_confirmed]
```


