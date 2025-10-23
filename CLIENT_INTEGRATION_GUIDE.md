# Client Integration Guide

## Overview

This guide helps your clients integrate with your market data WebSocket API. Clients will never see provider names (Kite/Vortex) - they only interact with your unified API.

## Quick Start

### 1. Get Your API Key

Contact your account manager to receive your unique API key.

### 2. Connect to WebSocket

```javascript
// Load Socket.IO client
const io = require('socket.io-client');

// Connect to market data stream
const socket = io('ws://your-domain.com/market-data', {
  extraHeaders: {
    'x-api-key': 'your-api-key-here'
  }
});

// Handle connection
socket.on('connected', (data) => {
  console.log('Connected:', data.message);
});
```

### 3. Subscribe to Instruments

```javascript
// Subscribe to multiple instruments
socket.emit('subscribe_instruments', {
  instruments: [26000, 11536, 2881],  // Nifty, Bank Nifty, Reliance
  mode: 'ltp'  // ltp, ohlcv, or full
});

// Handle subscription confirmation
socket.on('subscription_confirmed', (data) => {
  console.log('Subscribed to:', data.instruments);
});
```

### 4. Receive Market Data

```javascript
// Listen for real-time market data
socket.on('market_data', (data) => {
  console.log('Market Data:', {
    instrumentToken: data.instrumentToken,
    price: data.data.last_price,
    timestamp: data.timestamp
  });
});
```

## API Reference

### WebSocket Events

#### Client → Server Events

**`subscribe_instruments`**
```javascript
socket.emit('subscribe_instruments', {
  instruments: number[],  // Array of instrument tokens
  mode: 'ltp' | 'ohlcv' | 'full'  // Data mode
});
```

**`unsubscribe_instruments`**
```javascript
socket.emit('unsubscribe_instruments', {
  instruments: number[]  // Array of instrument tokens to unsubscribe
});
```

**`get_quote`**
```javascript
socket.emit('get_quote', {
  instruments: number[]  // Get current quotes
});
```

**`get_historical_data`**
```javascript
socket.emit('get_historical_data', {
  instrumentToken: number,
  fromDate: '2024-01-01',
  toDate: '2024-01-31',
  interval: '1D'
});
```

#### Server → Client Events

**`connected`**
```javascript
{
  message: 'Connected to market data stream',
  clientId: 'socket-id',
  timestamp: '2024-01-01T12:00:00.000Z'
}
```

**`subscription_confirmed`**
```javascript
{
  instruments: [26000, 11536],
  type: 'live',
  mode: 'ltp',
  timestamp: '2024-01-01T12:00:00.000Z'
}
```

**`market_data`**
```javascript
{
  instrumentToken: 26000,
  data: {
    last_price: 25870.3,
    ohlc: {
      open: 25800.0,
      high: 25900.0,
      low: 25750.0,
      close: 25870.3
    },
    volume: 1234567
  },
  timestamp: '2024-01-01T12:00:00.000Z'
}
```

**`error`**
```javascript
{
  message: 'Error description'
}
```

## Data Modes

### `ltp` - Last Traded Price
- **Size**: 22 bytes per tick
- **Data**: Last price only
- **Use case**: Real-time price updates

### `ohlcv` - OHLC + Volume
- **Size**: 62 bytes per tick  
- **Data**: Open, High, Low, Close, Volume
- **Use case**: Charting and analysis

### `full` - Complete Market Depth
- **Size**: 266 bytes per tick
- **Data**: OHLCV + Market depth (buy/sell orders)
- **Use case**: Advanced trading strategies

## Rate Limits

- **WebSocket Connections**: Up to 100 concurrent connections per API key
- **API Requests**: 1000 requests per minute per API key
- **Subscriptions**: Up to 1000 instruments per WebSocket connection

## Error Handling

```javascript
socket.on('error', (error) => {
  console.error('WebSocket Error:', error.message);
  
  // Common error messages:
  // - "Missing x-api-key"
  // - "Invalid API key" 
  // - "Connection limit exceeded"
  // - "Invalid instruments array"
  // - "Invalid mode. Must be ltp, ohlcv, or full"
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
  // Implement reconnection logic if needed
});
```

## Reconnection Strategy

```javascript
function connectWithRetry() {
  const socket = io('ws://your-domain.com/market-data', {
    extraHeaders: { 'x-api-key': 'your-api-key' }
  });
  
  socket.on('connect', () => {
    console.log('Connected successfully');
    // Resubscribe to instruments
    socket.emit('subscribe_instruments', {
      instruments: [26000, 11536, 2881],
      mode: 'ltp'
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Disconnected, retrying in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  });
  
  return socket;
}

const socket = connectWithRetry();
```

## Popular Instrument Tokens

| Instrument | Token | Description |
|------------|-------|-------------|
| Nifty 50 | 26000 | NSE Nifty 50 Index |
| Bank Nifty | 11536 | NSE Bank Nifty Index |
| Reliance | 2881 | Reliance Industries Ltd |
| TCS | 2953217 | Tata Consultancy Services |
| HDFC Bank | 341249 | HDFC Bank Ltd |

## Support

For technical support or questions:
- Email: support@yourcompany.com
- Documentation: https://docs.yourcompany.com
- Status Page: https://status.yourcompany.com
