# First Client Onboarding Guide

Welcome to the Trading Data Provider. This guide walks your team through getting production access, authenticating, and integrating with our REST and WebSocket APIs for NSE/MCX market data.

## 1) Credentials
Your account manager will provide:
- API base URL: https://your-domain.com
- API Key: <your_api_key>
- WebSocket namespace: wss://your-domain.com/market-data
- Swagger docs: https://your-domain.com/api/docs

Keep the API key secret. Rotate if compromised.

## 2) Network and Latency
- Hosted in AWS (region-specific). Expect ~50–150ms E2E latency depending on region.
- Use persistent WebSocket connections for streaming; reuse HTTP/1.1 keep-alive for REST.

## 3) Authentication
- All REST endpoints (except health/docs) require header: `x-api-key: <your_api_key>`
- WebSocket: include header `x-api-key` or query `?api_key=<your_api_key>` during connection.

## 4) Quick Tests
- Health: `GET /api/health`
- Swagger: `GET /api/docs`
- Stats: `GET /api/stock/stats` (requires `x-api-key`)

## 5) REST Endpoints
Refer to Swagger for full details. Common ones:
- Quotes: `POST /api/stock/quotes` with body `{ "instruments": [738561, 5633] }`
- LTP: `POST /api/stock/ltp` with body `{ "instruments": [ ... ] }`
- OHLC: `POST /api/stock/ohlc` with body `{ "instruments": [ ... ] }`
- Historical: `GET /api/stock/historical/:token?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=minute|day|...`
- Last tick (cached): `GET /api/stock/market-data/:token/last`

Example curl:
```bash
curl -X POST "https://your-domain.com/api/stock/quotes" \
  -H "x-api-key: <your_api_key>" -H "Content-Type: application/json" \
  -d '{"instruments":[738561,5633]}'
```

## 6) WebSocket Streaming
- Connect: `wss://your-domain.com/market-data`
- Client events:
  - `subscribe_instruments`: `{ instruments: number[], type?: 'live'|'historical'|'both' }`
  - `unsubscribe_instruments`: `{ instruments: number[] }`
- Server events:
  - `connected`, `market_data`, `quote_data`, `historical_data`, `error`

JavaScript example:
```js
const socket = io('https://your-domain.com/market-data', {
  extraHeaders: { 'x-api-key': '<your_api_key>' }
});

socket.on('connected', () => {
  socket.emit('subscribe_instruments', { instruments: [738561], type: 'live' });
});

socket.on('market_data', (msg) => console.log(msg));
```

## 7) Symbols and Instruments
- Use `POST /api/stock/instruments/sync` (admin-internal) to sync; as a client use:
  - `GET /api/stock/instruments?exchange=NSE&instrument_type=EQ&limit=100`
  - `GET /api/stock/instruments/search?q=RELIANCE&limit=20`

## 8) Quotas and Limits
- Default rate limit: 600 requests/min per API key (configurable).
- Default WS concurrent connections: 2000 per API key (configurable).
- Contact support for burst/limit changes.

## 9) Reliability Practices
- Auto-reconnect WebSocket with backoff (1s, 2s, 4s ... capped).
- Batch REST requests up to 100 instruments to reduce overhead.
- Cache locally for 1–5s if your use-case permits.

## 10) Security
- Only share API keys with trusted systems.
- Consider proxying requests through your backend to avoid exposing keys in browsers.
- IP allowlisting available upon request.

## 11) Support & SLAs
- Email: support@your-domain.com
- Status: https://status.your-domain.com (optional)
- SLA: 99.9% uptime (if contracted). Maintenance windows communicated in advance.

## 12) Change Management
- Backward-compatible changes announced via email and changelog.
- Breaking changes require 30 days notice.

## 13) Troubleshooting
- 401/403: check `x-api-key` header.
- 429: rate limit exceeded; implement retries/backoff.
- WS disconnects: verify key validity; inspect server `error` events; reconnect with jitter.
- Contact support with request IDs/timestamps.

## 14) Roadmap (Client-visible)
- Candlestick streaming (on request)
- Replay API
- Advanced alerts & filters

Welcome aboard! If you need help, we’ll pair on your integration live.
