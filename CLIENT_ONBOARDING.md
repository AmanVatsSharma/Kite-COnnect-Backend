# Client Onboarding Guide

Welcome to the Vayu Market Data Provider. This guide walks your team through getting production access, authenticating, and integrating with our REST and WebSocket APIs for NSE/MCX market data powered by Vayu (Rupeezy Vortex).

## 1) Credentials
Your account manager will provide:
- API base URL: https://marketdata.vedpragya.com
- API Key: <your_api_key>
- WebSocket namespace: https://marketdata.vedpragya.com/market-data (uses WSS over HTTPS)
- Swagger docs: https://marketdata.vedpragya.com/api/docs (HTTP Basic Auth required)
  - Username: `support@vedpragya.com`, Password: `aman1sharma`

**Important**: All endpoints use the Vayu (Rupeezy Vortex) data provider. Keep your API key secret and rotate if compromised.

## 2) Network and Latency
- Hosted in AWS (region-specific). Expect ~50–150ms E2E latency depending on region.
- Use persistent WebSocket connections for streaming; reuse HTTP/1.1 keep-alive for REST.
- Data provider: **Vayu (Rupeezy Vortex)**

## 3) Authentication
- All REST endpoints (except health/docs) require header: `x-api-key: <your_api_key>`
- WebSocket: include query parameter `?api_key=<your_api_key>` during connection (recommended)
- Alternative: include header `x-api-key` in extraHeaders

## 4) Quick Tests
- Health: `GET https://marketdata.vedpragya.com/api/health`
- Swagger: `GET https://marketdata.vedpragya.com/api/docs` (prompts for Basic Auth)
- Stats: `GET https://marketdata.vedpragya.com/api/stock/stats` (requires `x-api-key`)

## 5) REST Endpoints
Refer to Swagger for full details. Common ones:

- **Get Instruments**: `GET /api/stock/instruments?exchange=NSE&instrument_type=EQ`
- **Search Instruments**: `GET /api/stock/instruments/search?q=RELIANCE&limit=20`
- **Get Quotes**: `POST /api/stock/quotes` with body `{ "instruments": [26000, 11536] }`
- **Get LTP**: `POST /api/stock/ltp` with body `{ "instruments": [26000] }`
- **Get OHLC**: `POST /api/stock/ohlc` with body `{ "instruments": [26000] }`
- **Historical Data**: `GET /api/stock/historical/:token?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=day`
- **Last Tick**: `GET /api/stock/market-data/:token/last`

Example curl:
```bash
curl -X POST "https://marketdata.vedpragya.com/api/stock/quotes" \
  -H "x-api-key: <your_api_key>" \
  -H "Content-Type: application/json" \
  -d '{"instruments":[26000,11536]}'
```

## 6) WebSocket Streaming
- Connect: `https://marketdata.vedpragya.com/market-data` (automatically uses WSS over HTTPS)
- **Important**: Use HTTPS (not WS/WSS in Socket.IO URL - it handles that automatically)
- Client events:
  - `subscribe`: `{ instruments: number[], mode: 'ltp'|'ohlcv'|'full' }`
  - `unsubscribe`: `{ instruments: number[] }`
- Server events:
  - `connected`, `market_data`, `subscription_confirmed`, `error`

JavaScript example:
```js
const io = require('socket.io-client');

const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'your_api_key_here' }  // Query parameter
});

socket.on('connect', () => {
  console.log('Connected!', socket.id);
  
  // Subscribe to instruments
  socket.emit('subscribe', { 
    instruments: [26000], // Nifty 50
    mode: 'ltp' 
  });
});

socket.on('market_data', (msg) => console.log(msg));
```

## 7) Symbols and Instruments
All instruments are available via Vayu (Rupeezy Vortex) data. As a client:
- **List instruments**: `GET /api/stock/instruments?exchange=NSE&instrument_type=EQ&limit=100`
- **Search instruments**: `GET /api/stock/instruments/search?q=RELIANCE&limit=20`
- **Sync instruments** (admin): `POST /api/stock/instruments/sync?provider=vayu`

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
