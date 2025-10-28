# WebSocket Quick Reference

## Connection URLs

| Protocol | Endpoint | URL |
|----------|----------|-----|
| Socket.IO | `/market-data` | `https://marketdata.vedpragya.com/market-data` |
| Native WS | `/ws` | `wss://marketdata.vedpragya.com/ws` |

## Authentication

```javascript
// Query parameter (recommended)
query: { 'api_key': 'YOUR_KEY' }

// Header (alternative)
extraHeaders: { 'x-api-key': 'YOUR_KEY' }
```

## Client → Server Events

```javascript
// Subscribe
socket.emit('subscribe', {
  instruments: [26000, 11536],
  mode: 'ltp' | 'ohlcv' | 'full'
});

// Unsubscribe
socket.emit('unsubscribe', {
  instruments: [26000]
});

// Get Quote
socket.emit('get_quote', {
  instruments: [26000, 11536]
});

// Historical Data
socket.emit('get_historical_data', {
  instrumentToken: 26000,
  fromDate: '2024-01-01',
  toDate: '2024-01-31',
  interval: 'day'
});
```

## Server → Client Events

```javascript
// Connection confirmation
socket.on('connected', (data) => {});

// Subscription confirmed
socket.on('subscription_confirmed', (data) => {});

// Market data
socket.on('market_data', (data) => {});

// Quote data
socket.on('quote_data', (data) => {});

// Historical data
socket.on('historical_data', (data) => {});

// Error
socket.on('error', (error) => {});

// Disconnect
socket.on('disconnect', (reason) => {});
```

## Data Modes

| Mode | Size | Use Case |
|------|------|----------|
| `ltp` | ~22 bytes | Fast price updates |
| `ohlcv` | ~62 bytes | Charts, analytics |
| `full` | ~266 bytes | Trading, order book |

## Error Codes

| Code | Message |
|------|---------|
| `WS_AUTH_MISSING` | Missing API key |
| `WS_AUTH_INVALID` | Invalid API key |
| `WS_RATE_LIMIT` | Rate limit exceeded |
| `WS_INVALID_MODE` | Invalid subscription mode |
| `WS_STREAM_INACTIVE` | Streaming not active |

## Popular Tokens

| Token | Instrument |
|-------|------------|
| 26000 | Nifty 50 |
| 11536 | Bank Nifty |
| 2881 | Reliance |
| 2953217 | TCS |
| 341249 | HDFC Bank |

## Quick Start

```javascript
// 1. Install
npm install socket.io-client

// 2. Connect
const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'YOUR_KEY' }
});

// 3. Subscribe
socket.on('connect', () => {
  socket.emit('subscribe', {
    instruments: [26000],
    mode: 'ltp'
  });
});

// 4. Receive data
socket.on('market_data', (data) => {
  console.log(data.data.last_price);
});
```

## Support

- **Email**: support@vedpragya.com
- **Docs**: /CLIENT_API_GUIDE.md
- **Health**: https://marketdata.vedpragya.com/api/health

