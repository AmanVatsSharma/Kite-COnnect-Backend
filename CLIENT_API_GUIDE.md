# Vedpragya — Complete API Integration Guide

## Overview

This comprehensive guide covers everything you need to integrate with Vedpragya's unified NSE/MCX market data streaming API. Connect using either **Socket.IO** (recommended) or **Native WebSocket** protocols based on your application needs.

---

## Quick Start (5 Minutes)

### 1. Get Your API Key

Contact your Vedpragya account manager to obtain your production API key.

### 2. Connect (Socket.IO — Recommended)

```javascript
const io = require('socket.io-client');

const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': '<your_api_key>' }
});

socket.on('connect', () => {
  console.log('✅ Connected!', socket.id);
  
  // Subscribe to instruments
  socket.emit('subscribe', {
    instruments: [26000, 11536], // Nifty 50, Bank Nifty
    mode: 'ltp' // Options: 'ltp', 'ohlcv', 'full'
  });
});

socket.on('market_data', (data) => {
  console.log('Market Data:', {
    instrument: data.instrumentToken,
    price: data.data.last_price,
    timestamp: data.timestamp
  });
});
```

### 3. Connect (Native WebSocket — Lightweight)

```javascript
const ws = new WebSocket('wss://marketdata.vedpragya.com/ws?api_key=<your_api_key>');

ws.onopen = () => {
  // Subscribe
  ws.send(JSON.stringify({
    event: 'subscribe',
    data: { instruments: [26000], mode: 'ltp' }
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.event === 'market_data') {
    console.log('Data:', message.data);
  }
};
```

---

## Protocol Comparison

| Feature | Socket.IO | Native WebSocket |
|---------|-----------|------------------|
| **Endpoint** | `/market-data` | `/ws` |
| **URL** | `https://.../market-data` | `wss://.../ws` |
| **Overhead** | ~20KB library | 0 bytes (browser native) |
| **Fallback** | Yes (polling) | No |
| **Auto-Reconnect** | Yes | No (manual) |
| **Best For** | Most applications | Lightweight, embedded clients |
| **Compatibility** | Cross-platform | Standard WebSocket |

**Recommendation**: Use **Socket.IO** for most applications. Use **Native WebSocket** for minimal overhead or embedded clients.

---

## Connection URLs & Authentication

### Socket.IO

```javascript
// Production (HTTPS/WSS)
const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'YOUR_API_KEY' },
  transports: ['websocket', 'polling']
});

// Alternative: Header authentication
const socket = io('https://marketdata.vedpragya.com/market-data', {
  extraHeaders: { 'x-api-key': 'YOUR_API_KEY' }
});
```

### Native WebSocket

```javascript
// Production (WSS)
const ws = new WebSocket('wss://marketdata.vedpragya.com/ws?api_key=YOUR_API_KEY');

// With header (if using library that supports it)
const ws = new WebSocket('wss://marketdata.vedpragya.com/ws', {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
});
```

**Important**: Use `https://` in Socket.IO URL (not `http://`). Socket.IO handles the SSL upgrade automatically.

---

## API Reference

### Client → Server Events

#### Subscribe to Instruments

```javascript
socket.emit('subscribe', {
  instruments: [26000, 11536], // Array of instrument tokens
  mode: 'ltp' // 'ltp', 'ohlcv', or 'full'
});
```

**Parameters**:
- `instruments` (array): Array of instrument tokens
- `mode` (string): Data mode — `'ltp'`, `'ohlcv'`, or `'full'`
- `type` (optional): `'live'`, `'historical'`, or `'both'` (default: `'live'`)

**Response**: `subscription_confirmed` event

#### Unsubscribe from Instruments

```javascript
socket.emit('unsubscribe', {
  instruments: [26000] // Instruments to unsubscribe
});
```

#### Get Quote (Real-Time Snapshot)

```javascript
socket.emit('get_quote', {
  instruments: [26000, 11536]
});

// Listen for response
socket.on('quote_data', (data) => {
  console.log('Quote:', data.data);
});
```

#### Get Historical Data

```javascript
socket.emit('get_historical_data', {
  instrumentToken: 26000,
  fromDate: '2024-01-01',
  toDate: '2024-01-31',
  interval: 'day' // 'minute', 'hour', 'day'
});

socket.on('historical_data', (data) => {
  console.log('Historical:', data.data);
});
```

---

### Server → Client Events

#### Connection Confirmation

```javascript
socket.on('connected', (data) => {
  console.log('Connected:', data.message);
  console.log('Client ID:', data.clientId);
  console.log('Timestamp:', data.timestamp);
});
```

#### Subscription Confirmed

```javascript
socket.on('subscription_confirmed', (data) => {
  console.log('Subscribed to:', data.instruments);
  console.log('Mode:', data.mode);
  console.log('Type:', data.type);
});
```

#### Market Data

```javascript
socket.on('market_data', (data) => {
  console.log('Instrument:', data.instrumentToken);
  console.log('Data:', data.data);
  console.log('Timestamp:', data.timestamp);
});
```

**Data Structure** (varies by mode):

**LTP Mode**:
```javascript
{
  last_price: 25870.35
}
```

**OHLCV Mode**:
```javascript
{
  last_price: 25870.35,
  ohlc: {
    open: 25900.00,
    high: 25950.00,
    low: 25850.00,
    close: 25870.35
  },
  volume: 12345678
}
```

**Full Mode**:
```javascript
{
  last_price: 25870.35,
  ohlc: { open, high, low, close },
  volume: 12345678,
  depth: {
    buy: [{ price: 25870.00, quantity: 100 }],
    sell: [{ price: 25870.50, quantity: 150 }]
  }
}
```

#### Error Event

```javascript
socket.on('error', (error) => {
  console.error('Error Code:', error.code);
  console.error('Error Message:', error.message);
});
```

**Error Codes**:
- `WS_AUTH_MISSING` — Missing API key
- `WS_AUTH_INVALID` — Invalid API key
- `WS_RATE_LIMIT` — Rate limit exceeded
- `WS_INVALID_MODE` — Invalid subscription mode
- `WS_STREAM_INACTIVE` — Streaming not active
- `WS_INVALID_INSTRUMENTS` — Invalid instruments array
- `WS_SUBSCRIPTION_NOT_FOUND` — Client subscription not found

---

## Data Modes

Choose the mode based on your needs:

| Mode | Size (per tick) | Data | Use Case |
|------|-----------------|------|----------|
| **LTP** | ~22 bytes | Last price only | Fast updates, simple price tracking |
| **OHLCV** | ~62 bytes | Open, High, Low, Close, Volume | Charting, technical analysis |
| **Full** | ~266 bytes | OHLCV + Market depth | Advanced trading, order book analysis |

**Recommendation**: Start with `ltp` mode for most applications. Upgrade to `ohlcv` for charts, `full` for advanced trading.

---

## Language Examples

### JavaScript/TypeScript (Browser)

**Socket.IO**:
```javascript
import io from 'socket.io-client';

const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'YOUR_KEY' }
});

socket.on('connect', () => {
  socket.emit('subscribe', { instruments: [26000], mode: 'ltp' });
});

socket.on('market_data', (data) => console.log(data));
```

**Native WebSocket**:
```javascript
const ws = new WebSocket('wss://marketdata.vedpragya.com/ws?api_key=YOUR_KEY');

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.event === 'market_data') console.log(msg.data);
};
```

### Node.js

```javascript
const io = require('socket.io-client');

const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'YOUR_KEY' }
});

socket.on('market_data', console.log);
```

### Python (Socket.IO)

```python
import socketio

sio = socketio.Client()

sio.connect(
    'https://marketdata.vedpragya.com/market-data',
    params={'api_key': 'YOUR_KEY'}
)

@sio.event
def connect():
    sio.emit('subscribe', {
        'instruments': [26000],
        'mode': 'ltp'
    })

@sio.event
def market_data(data):
    print(data)

sio.wait()
```

### Python (Native WebSocket)

```python
import asyncio
import websockets
import json

async def connect():
    uri = 'wss://marketdata.vedpragya.com/ws?api_key=YOUR_KEY'
    async with websockets.connect(uri) as ws:
        # Subscribe
        await ws.send(json.dumps({
            'event': 'subscribe',
            'data': {'instruments': [26000], 'mode': 'ltp'}
        }))
        
        # Receive data
        async for message in ws:
            data = json.loads(message)
            if data.get('event') == 'market_data':
                print(data['data'])

asyncio.run(connect())
```

### React Hook

```typescript
import { useEffect, useState } from 'react';
import io from 'socket.io-client';

function useMarketData(instruments: number[], apiKey: string) {
  const [data, setData] = useState({});
  
  useEffect(() => {
    const socket = io('https://marketdata.vedpragya.com/market-data', {
      query: { api_key: apiKey }
    });
    
    socket.on('connect', () => {
      socket.emit('subscribe', { instruments, mode: 'ltp' });
    });
    
    socket.on('market_data', (msg) => {
      setData(prev => ({ ...prev, [msg.instrumentToken]: msg.data }));
    });
    
    return () => socket.disconnect();
  }, [instruments, apiKey]);
  
  return data;
}

// Usage
function MyComponent() {
  const data = useMarketData([26000, 11536], 'YOUR_KEY');
  return <div>{JSON.stringify(data)}</div>;
}
```

### Vue.js Composable

```typescript
import { ref, onMounted, onUnmounted } from 'vue';
import io from 'socket.io-client';

export function useMarketData(instruments: number[], apiKey: string) {
  const data = ref({});
  let socket: any = null;
  
  onMounted(() => {
    socket = io('https://marketdata.vedpragya.com/market-data', {
      query: { api_key: apiKey }
    });
    
    socket.on('connect', () => {
      socket.emit('subscribe', { instruments, mode: 'ltp' });
    });
    
    socket.on('market_data', (msg: any) => {
      data.value[msg.instrumentToken] = msg.data;
    });
  });
  
  onUnmounted(() => socket?.disconnect());
  
  return data;
}
```

### PHP

```php
<?php
use ElephantIO\Client;
use ElephantIO\Engine\SocketIO\Version4X;

$client = new Client(
    new Version4X('https://marketdata.vedpragya.com'),
    [
        'headers' => ['x-api-key' => 'YOUR_KEY'],
        'namespace' => '/market-data'
    ]
);

$client->initialize();
$client->emit('subscribe', [
    'instruments' => [26000],
    'mode' => 'ltp'
]);
```

---

## Limits & Quotas

| Resource | Limit |
|----------|-------|
| **WebSocket Connections** | 100 per API key |
| **API Rate** | 1000 requests/minute per API key |
| **Instrument Subscriptions** | 1000 per socket connection |
| **Concurrent Subscriptions** | Unlimited across all connections |

**Contact support to adjust limits for your account.**

---

## Best Practices

### 1. Reconnection Strategy

```javascript
let reconnectAttempts = 0;
const maxAttempts = 10;

function connectWithRetry() {
  const socket = io('https://marketdata.vedpragya.com/market-data', {
    query: { 'api_key': 'YOUR_KEY' },
    reconnection: true,
    reconnectionAttempts: maxAttempts,
    reconnectionDelay: 1000 * Math.pow(2, reconnectAttempts), // Exponential backoff
  });
  
  socket.on('connect', () => {
    reconnectAttempts = 0;
  });
  
  socket.on('disconnect', () => {
    reconnectAttempts++;
    if (reconnectAttempts >= maxAttempts) {
      console.error('Max reconnection attempts reached');
    }
  });
}
```

### 2. Error Handling

```javascript
socket.on('error', (error) => {
  switch(error.code) {
    case 'WS_AUTH_MISSING':
    case 'WS_AUTH_INVALID':
      // Prompt user to check API key
      break;
    case 'WS_RATE_LIMIT':
      // Implement rate limiting/backoff
      break;
    case 'WS_STREAM_INACTIVE':
      // Notify user streaming is down
      break;
    default:
      console.error('Unknown error:', error);
  }
});
```

### 3. Connection Health

```javascript
// Ping every 30 seconds
setInterval(() => {
  if (socket.connected) {
    socket.emit('ping', { timestamp: Date.now() });
  }
}, 30000);

socket.on('pong', (data) => {
  const latency = Date.now() - data.timestamp;
  console.log('Connection latency:', latency + 'ms');
});
```

---

## Troubleshooting

### Connection Fails

**Symptoms**: Cannot connect, connection refused

**Solutions**:
1. Check API key is valid
2. Verify server URL uses HTTPS
3. Check firewall/network allows WSS connections
4. Test with: `https://marketdata.vedpragya.com/api/health`

### No Data Received

**Symptoms**: Connected but no market data

**Solutions**:
1. Verify streaming is active: `GET /api/admin/stream/status`
2. Check subscription was sent: Confirm `subscription_confirmed` event received
3. Verify instrument tokens are correct
4. Check server logs for errors

### High Latency

**Symptoms**: Delayed data updates

**Solutions**:
1. Use LTP mode (lower bandwidth)
2. Reduce number of subscriptions
3. Check network connection quality
4. Use dedicated connection for time-sensitive data

### Rate Limit Exceeded

**Symptoms**: 429 errors, connection drops

**Solutions**:
1. Implement request throttling
2. Batch subscriptions together
3. Cache responses locally
4. Request limit increase from support

---

## Popular Instrument Tokens

| Instrument | Token | Description |
|------------|-------|-------------|
| Nifty 50 | 26000 | NSE Nifty 50 Index |
| Bank Nifty | 11536 | NSE Bank Nifty Index |
| Reliance | 2881 | Reliance Industries Ltd |
| TCS | 2953217 | Tata Consultancy Services |
| HDFC Bank | 341249 | HDFC Bank Ltd |
| HDFC | 11487777 | HDFC Ltd |
| ICICI Bank | 1270529 | ICICI Bank Ltd |
| Infosys | 408065 | Infosys Ltd |

---

## Support

- **Email**: support@vedpragya.com
- **Docs**: https://marketdata.vedpragya.com/api/docs
- **Health Check**: https://marketdata.vedpragya.com/api/health
- **Status**: https://status.vedpragya.com

---

**Version**: 1.0.0  
**Last Updated**: 2024-01-XX  
**Protocol Support**: Socket.IO 4.x, Native WebSocket

