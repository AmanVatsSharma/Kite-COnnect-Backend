# Vedpragya — Client Integration Guide

## Overview

Welcome! This guide shows you how to quickly and securely connect to Vedpragya’s unified NSE/MCX market data streaming via our WebSocket API. The API abstracts all backend data sources—your integration is always with the Vedpragya platform.

---

## Quick Start

### 1. Obtain Your API Key

Reach out to your Vedpragya account manager for your production API key.

### 2. Connect to the Vedpragya WebSocket

```javascript
// Install Socket.IO Client if not already: npm install socket.io-client
const io = require('socket.io-client');

// Connect securely to Vedpragya’s stream gateway
const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': '<your_api_key>' }
});

// Connection event (always use 'connect', not 'connected')
socket.on('connect', () => {
  console.log('✅ Connected! Socket ID:', socket.id);
});
```

### 3. Subscribe to Market Instruments

```javascript
// Subscribe to instruments by token. Example: Nifty 50, Bank Nifty, Reliance
socket.emit('subscribe', {
  instruments: [26000, 11536, 2881], // Example tokens
  mode: 'ltp' // Modes: 'ltp', 'ohlcv', 'full'
});

## LTP-only filtering

All REST and WebSocket quote responses now include `last_price` when available. You can request only instruments with a valid LTP using the optional flag below:

- REST: `POST /api/stock/quotes?mode=full&ltp_only=true`
- WebSocket snapshot: `socket.emit('get_quote', { instruments: [...], ltp_only: true })`

Behavior:
- Instruments without a finite `last_price > 0` are omitted from the response when `ltp_only` is true.
- The system attempts to enrich missing LTPs via a fallback LTP fetch before filtering.

// Confirm subscription
socket.on('subscription_confirmed', (data) => {
  console.log('Subscription confirmed for:', data.instruments);
});
```

### 4. Receive Live Market Data

```javascript
// Receive real-time ticks
socket.on('market_data', (data) => {
  console.log('Market Data:', {
    instrument: data.instrumentToken,
    price: data.data.last_price,
    timestamp: data.timestamp
  });
});
```

---

## API Details

### WebSocket Events

#### Client ➔ Server

**`subscribe`**
```javascript
socket.emit('subscribe', {
  instruments: [/* array of tokens */],
  mode: 'ltp' | 'ohlcv' | 'full'
});
```

**`unsubscribe`**
```javascript
socket.emit('unsubscribe', {
  instruments: [/* array of tokens */]
});
```

**`get_quote`**
```javascript
socket.emit('get_quote', {
  instruments: [/* array of tokens */]
});
```

**`get_historical_data`**
```javascript
socket.emit('get_historical_data', {
  instrumentToken: 26000,
  fromDate: 'YYYY-MM-DD',
  toDate: 'YYYY-MM-DD',
  interval: '1D'
});
```

#### Server ➔ Client

**`connect`**
```javascript
// Fires when connected
// { message: 'Connected', clientId, timestamp }
```

**`subscription_confirmed`**
```javascript
// { instruments: [...], type: 'live', mode, timestamp }
```

**`market_data`**
```javascript
// {
//   instrumentToken: 26000,
//   data: { last_price, ohlc: { open, high, low, close }, volume },
//   timestamp: ...
// }
```

**`error`**
```javascript
// { message: 'Error message' }
```

---

## Data Modes

| Mode   | Size (approx/tick) | Data                                           | Use Case               |
|--------|--------------------|------------------------------------------------|------------------------|
| ltp    | 22 bytes           | Last price only                                | Fast updates           |
| ohlcv  | 62 bytes           | OHLC + Volume                                  | Charting/analytics     |
| full   | 266 bytes          | OHLCV + order book depth (top buy/sell levels) | Advanced trading       |

---

## Limits

- **WebSocket Connections**: Up to 100 per API key
- **API Rate**: 1000/minute per API key
- **Instrument Subscriptions**: Up to 1000 per socket

---

## Common Error Handling

```javascript
socket.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  // Possible: "Missing x-api-key", "Invalid API key", "Limit exceeded", etc.
});

socket.on('disconnect', (reason) => {
  console.warn('Disconnected:', reason);
  // You may choose to auto-reconnect here
});
```

---

## Example: Simple Reconnection

```javascript
function connectWithRetry() {
  const s = io('https://marketdata.vedpragya.com/market-data', {
    query: { 'api_key': '<your_api_key>' }
  });

  s.on('connect', () => {
    console.log('Connected!');
    s.emit('subscribe', { instruments: [26000], mode: 'ltp' });
  });

  s.on('disconnect', () => {
    console.log('Reconnect in 5s');
    setTimeout(connectWithRetry, 5000);
  });
}

connectWithRetry();
```

---

## Popular Instrument Tokens

| Instrument   | Token   | Description              |
|--------------|---------|-------------------------|
| Nifty 50     | 26000   | NSE Nifty 50 Index      |
| Bank Nifty   | 11536   | NSE Bank Nifty Index    |
| Reliance     | 2881    | Reliance Industries Ltd |
| TCS          | 2953217 | Tata Consultancy        |
| HDFC Bank    | 341249  | HDFC Bank Ltd           |

_Need more? Ask support or use the instruments API._

---

## Data Providers

Vedpragya abstracts multiple market data sources (e.g., Falcon, Vayu) for best uptime, with seamless backend failover. You always receive a unified market stream.

---

## Support

Have questions or need help?
- Email: support@vedpragya.com



We’re here to make your onboarding and integration smooth!
