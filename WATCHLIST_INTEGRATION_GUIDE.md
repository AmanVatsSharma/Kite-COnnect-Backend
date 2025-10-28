# Watchlist Integration Guide for Trading Apps

Complete guide for integrating live market data, watchlists, and WebSocket streaming for Equities, Futures, Options, and MCX.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Search & Discovery](#search--discovery)
5. [Adding to Watchlist](#adding-to-watchlist)
6. [WebSocket Streaming](#websocket-streaming)
7. [Examples by Asset Type](#examples-by-asset-type)
8. [Error Handling](#error-handling)

---

## Overview

Your trading app will:

1. **Search** instruments (equity, futures, options, MCX)
2. **Get token** for each instrument
3. **Store** token + metadata in your watchlist
4. **Connect** to WebSocket with your API key
5. **Subscribe** to live prices using tokens
6. **Receive** real-time market data

---

## Architecture

```
Your Trading App
    ↓
1. Search instruments → GET /api/stock/vayu/equities?q=RELIANCE
2. Get instrument token (e.g., 738561)
3. Store {token: 738561, symbol: "RELIANCE"} in watchlist
4. Connect WebSocket → ws://api.yourdomain.com/market-data?api_key=YOUR_KEY
5. Subscribe to tokens → socket.emit('subscribe_instruments', {instruments: [738561], mode: 'ltp'})
6. Receive live prices → socket.on('market_data', (data) => {...})
```

---

## Quick Start

### Step 1: Get Your API Key

Contact support to receive your API key.

### Step 2: Search for Instruments

```javascript
// Search for equity stocks
const response = await fetch('https://api.yourdomain.com/api/stock/vayu/equities?q=RELIANCE', {
  headers: {
    'x-api-key': 'YOUR_API_KEY'
  }
});

const { data } = await response.json();
// data.instruments = [{ token: 738561, symbol: "RELIANCE", ... }]
```

### Step 3: Add to Watchlist

Store instrument details in your local storage/database:

```javascript
const watchlistItem = {
  token: data.instruments[0].token,
  symbol: data.instruments[0].symbol,
  exchange: 'NSE_EQ',
  last_price: null, // Will be updated via WebSocket
  added_at: new Date()
};

// Save to your database
await saveToWatchlist(watchlistItem);
```

### Step 4: Connect WebSocket

```javascript
const io = require('socket.io-client');

const socket = io('wss://api.yourdomain.com/market-data', {
  extraHeaders: {
    'x-api-key': 'YOUR_API_KEY'
  }
});

socket.on('connected', () => {
  console.log('WebSocket connected!');
});
```

### Step 5: Subscribe to Live Prices

```javascript
// Subscribe to all instruments in your watchlist
const tokens = watchlist.map(item => item.token);

socket.emit('subscribe_instruments', {
  instruments: tokens,
  mode: 'ltp' // ltp = Last Traded Price only (22 bytes)
});

socket.on('subscription_confirmed', (data) => {
  console.log('Subscribed to:', data.instruments);
});

// Receive live price updates
socket.on('market_data', (data) => {
  const token = data.instrumentToken;
  const price = data.data.last_price;
  
  // Update your watchlist UI
  updateWatchlistPrice(token, price);
});
```

---

## Search & Discovery

### 1. Search Equities (Stocks)

```javascript
// Search for any equity stock (case-insensitive)
// Example: Search for "rel" will find "RELIANCE", "RELTECH", etc.
GET /api/stock/vayu/equities?q=rel&limit=10

// Response
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 738561,
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "last_price": 2580.50
      },
      {
        "token": 123456,
        "symbol": "RELTECH",
        "exchange": "NSE_EQ",
        "last_price": 450.75
      }
    ],
    "pagination": {
      "total": 2,
      "hasMore": false
    }
  }
}
```

### 2. Search Futures

```javascript
// Search futures for a symbol
GET /api/stock/vayu/futures?q=NIFTY&limit=10

// Response
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 135938,
        "symbol": "NIFTY",
        "exchange": "NSE_FO",
        "expiry_date": "20241228",
        "last_price": 19250.30
      }
    ]
  }
}
```

### 3. Search Options

```javascript
// Search options chain
GET /api/stock/vayu/options?q=NIFTY&option_type=CE&strike_min=19200&strike_max=19300&limit=20

// Response
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 456789,
        "symbol": "NIFTY",
        "exchange": "NSE_FO",
        "expiry_date": "20241228",
        "strike_price": 19250.00,
        "option_type": "CE",
        "last_price": 125.50
      }
    ]
  }
}
```

### 4. Search MCX Commodities

```javascript
// Search commodities
GET /api/stock/vayu/commodities?q=GOLD&limit=10

// Response
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 234567,
        "symbol": "GOLDM",
        "exchange": "MCX_FO",
        "expiry_date": "20241229",
        "last_price": 62580.00
      }
    ]
  }
}
```

### 5. Get Options Chain

```javascript
// Get full options chain for a symbol
GET /api/stock/vayu/options/chain/NIFTY

// Response
{
  "success": true,
  "data": {
    "symbol": "NIFTY",
    "expiries": ["20241228", "20250102", "20250109"],
    "strikes": [19200, 19250, 19300, ...],
    "options": {
      "20241228": {
        "19250": {
          "CE": { token: 123, last_price: 125.50 },
          "PE": { token: 124, last_price: 115.20 }
        }
      }
    }
  }
}
```

### 6. Case-Insensitive Universal Search

```javascript
// Search across all instruments (equities, futures, options, commodities)
// Query is automatically converted to uppercase for case-insensitive search
GET /api/stock/instruments/search?q=rel&limit=20

// Response includes all instrument types starting with "rel"
{
  "success": true,
  "data": [
    {
      "instrument_token": 738561,
      "tradingsymbol": "RELIANCE",
      "name": "Reliance Industries Limited",
      "exchange": "NSE",
      "instrument_type": "EQ"
    },
    {
      "instrument_token": 123456,
      "tradingsymbol": "RELTECH",
      "name": "Religare Technologies",
      "exchange": "NSE",
      "instrument_type": "EQ"
    }
  ]
}
```

**Note:** The search is case-insensitive. "rel" will match "RELIANCE", "Reliance", "RELTECH", etc.

### 7. Batch Lookup

```javascript
// Get multiple instruments by token
POST /api/stock/vayu/instruments/batch
Content-Type: application/json
x-api-key: YOUR_API_KEY

{
  "tokens": [738561, 11536, 26000] // Multiple tokens
}

// Response
{
  "success": true,
  "data": {
    "instruments": {
      "738561": {
        "token": 738561,
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "last_price": 2580.50
      }
    },
    "ltp": {
      "738561": { last_price: 2580.50 },
      "11536": { last_price: 44550.30 },
      "26000": { last_price: 19245.60 }
    }
  }
}
```

---

## Adding to Watchlist

### Example: Build a Complete Watchlist

```javascript
class WatchlistManager {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.watchlist = [];
  }

  // Search and add equity
  async addEquity(query) {
    const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/equities?q=${query}`, {
      headers: { 'x-api-key': this.apiKey }
    });
    const { data } = await response.json();
    
    if (data.instruments.length > 0) {
      const instrument = data.instruments[0];
      this.watchlist.push({
        token: instrument.token,
        symbol: instrument.symbol,
        exchange: instrument.exchange,
        type: 'equity',
        last_price: null,
        change: null,
        added_at: new Date()
      });
    }
  }

  // Add future
  async addFuture(query) {
    const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/futures?q=${query}&limit=1`, {
      headers: { 'x-api-key': this.apiKey }
    });
    const { data } = await response.json();
    
    if (data.instruments.length > 0) {
      const instrument = data.instruments[0];
      this.watchlist.push({
        token: instrument.token,
        symbol: instrument.symbol,
        exchange: instrument.exchange,
        expiry_date: instrument.expiry_date,
        type: 'future',
        last_price: null,
        added_at: new Date()
      });
    }
  }

  // Add option
  async addOption(symbol, expiry, strike, optionType) {
    const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/options?q=${symbol}&expiry_from=${expiry}&expiry_to=${expiry}&strike_min=${strike}&strike_max=${strike}&option_type=${optionType}&limit=1`, {
      headers: { 'x-api-key': this.apiKey }
    });
    const { data } = await response.json();
    
    if (data.instruments.length > 0) {
      const instrument = data.instruments[0];
      this.watchlist.push({
        token: instrument.token,
        symbol: instrument.symbol,
        expiry_date: instrument.expiry_date,
        strike_price: instrument.strike_price,
        option_type: optionType,
        type: 'option',
        last_price: null,
        added_at: new Date()
      });
    }
  }

  // Get all tokens for WebSocket subscription
  getTokens() {
    return this.watchlist.map(item => item.token);
  }
}

// Usage
const watchlist = new WatchlistManager('YOUR_API_KEY');

// Add popular stocks
await watchlist.addEquity('RELIANCE');
await watchlist.addEquity('TCS');
await watchlist.addEquity('HDFC BANK');

// Add NIFTY future
await watchlist.addFuture('NIFTY');

// Add NIFTY 19250 CE option
await watchlist.addOption('NIFTY', '20241228', 19250, 'CE');

console.log('Watchlist tokens:', watchlist.getTokens());
```

---

## WebSocket Streaming

### Connection

```javascript
const socket = io('wss://api.yourdomain.com/market-data', {
  extraHeaders: {
    'x-api-key': 'YOUR_API_KEY'
  },
  reconnection: true,
  reconnectionDelay: 1000
});
```

### Events

#### Client → Server

**Subscribe to instruments**
```javascript
socket.emit('subscribe_instruments', {
  instruments: [738561, 11536, 26000],
  mode: 'ltp' // 'ltp' | 'ohlcv' | 'full'
});

socket.emit('unsubscribe_instruments', {
  instruments: [738561]
});

socket.emit('get_quote', {
  instruments: [738561] // Get current price (not streaming)
});
```

#### Server → Client

**Connected**
```javascript
socket.on('connected', (data) => {
  console.log('Connected:', data.message);
  console.log('Client ID:', data.clientId);
});
```

**Subscription Confirmed**
```javascript
socket.on('subscription_confirmed', (data) => {
  console.log('Subscribed to:', data.instruments);
  console.log('Mode:', data.mode);
});
```

**Market Data (Live Prices)**
```javascript
socket.on('market_data', (data) => {
  console.log('Token:', data.instrumentToken);
  console.log('Price:', data.data.last_price);
  console.log('Timestamp:', data.timestamp);
  
  // Update your UI
  updatePrice(data.instrumentToken, data.data.last_price);
});

// Data structure for each mode:
// 'ltp' mode: { instrumentToken, data: { last_price }, timestamp }
// 'ohlcv' mode: { instrumentToken, data: { last_price, ohlc, volume }, timestamp }
// 'full' mode: { instrumentToken, data: { last_price, ohlc, volume, depth }, timestamp }
```

**Error**
```javascript
socket.on('error', (error) => {
  console.error('WebSocket error:', error.message);
});
```

---

## Complete Example: Equity Watchlist

```javascript
const io = require('socket.io-client');

class EquityWatchlistApp {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.watchlist = [];
    this.socket = null;
  }

  // 1. Search and add equity
  async searchAndAddEquity(query) {
    try {
      const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/equities?q=${query}&limit=1`, {
        headers: { 'x-api-key': this.apiKey }
      });
      const result = await response.json();
      
      if (result.data.instruments.length > 0) {
        const instrument = result.data.instruments[0];
        this.watchlist.push({
          token: instrument.token,
          symbol: instrument.symbol,
          exchange: instrument.exchange,
          last_price: instrument.last_price,
          change: 0,
          change_percent: 0
        });
        this.renderWatchlist();
        return instrument;
      }
    } catch (error) {
      console.error('Failed to add equity:', error);
    }
  }

  // 2. Connect to WebSocket
  connectWebSocket() {
    this.socket = io('wss://api.yourdomain.com/market-data', {
      extraHeaders: { 'x-api-key': this.apiKey }
    });

    this.socket.on('connected', () => {
      console.log('✅ Connected to market data stream');
      this.subscribeToWatchlist();
    });

    this.socket.on('market_data', (data) => {
      this.updatePrice(data.instrumentToken, data.data.last_price);
    });

    this.socket.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
    });
  }

  // 3. Subscribe to all instruments in watchlist
  subscribeToWatchlist() {
    if (this.socket && this.watchlist.length > 0) {
      const tokens = this.watchlist.map(item => item.token);
      
      this.socket.emit('subscribe_instruments', {
        instruments: tokens,
        mode: 'ltp'
      });

      this.socket.on('subscription_confirmed', () => {
        console.log('✅ Subscribed to watchlist');
      });
    }
  }

  // 4. Update price in watchlist
  updatePrice(token, price) {
    const item = this.watchlist.find(i => i.token === token);
    if (item) {
      const previousPrice = item.last_price;
      item.last_price = price;
      item.change = price - previousPrice;
      item.change_percent = ((price - previousPrice) / previousPrice) * 100;
      this.renderWatchlist();
    }
  }

  // 5. Render watchlist UI (example)
  renderWatchlist() {
    console.log('\n📊 Watchlist:');
    this.watchlist.forEach(item => {
      const changeColor = item.change >= 0 ? '🟢' : '🔴';
      console.log(`${changeColor} ${item.symbol}: ₹${item.last_price} (${item.change_percent.toFixed(2)}%)`);
    });
  }
}

// Usage
const app = new EquityWatchlistApp('YOUR_API_KEY');

// Add stocks to watchlist (case-insensitive search)
// User types "rel" and sees "RELIANCE" in results
await app.searchAndAddEquity('rel');
await app.searchAndAddEquity('tcs');
await app.searchAndAddEquity('hdfc');
await app.searchAndAddEquity('infy');

// Connect and start receiving live prices
app.connectWebSocket();
```

---

## Examples by Asset Type

### Equities Watchlist

```javascript
// Popular stocks to add
const stocks = ['RELIANCE', 'TCS', 'HDFC BANK', 'ICICI BANK', 'INFY'];

for (const symbol of stocks) {
  const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/equities?q=${symbol}&limit=1`, {
    headers: { 'x-api-key': 'YOUR_API_KEY' }
  });
  const { data } = await response.json();
  if (data.instruments.length > 0) {
    watchlist.push(data.instruments[0]);
  }
}
```

### Futures Watchlist

```javascript
// Add NIFTY and BANK NIFTY futures
const response = await fetch('https://api.yourdomain.com/api/stock/vayu/futures?q=NIFTY&limit=5', {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
});
const { data } = await response.json();

// Get nearest expiry
const nearestFutures = data.instruments.sort((a, b) => 
  a.expiry_date.localeCompare(b.expiry_date)
)[0];
watchlist.push(nearestFutures);
```

### Options Watchlist

```javascript
// Add OTM and ATM options
const strike = 19250;
const expiry = '20241228';

// ATM call option
await fetch(`https://api.yourdomain.com/api/stock/vayu/options?q=NIFTY&expiry_from=${expiry}&expiry_to=${expiry}&strike_min=${strike}&strike_max=${strike}&option_type=CE&limit=1`, {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
});

// Add to watchlist...
```

### MCX Commodities

```javascript
// Add GOLD and SILVER futures
const goldResponse = await fetch('https://api.yourdomain.com/api/stock/vayu/commodities?q=GOLD&limit=1', {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
});
const { data } = await goldResponse.json();
watchlist.push(data.instruments[0]);
```

---

## Error Handling

```javascript
socket.on('error', (error) => {
  if (error.message.includes('Missing x-api-key')) {
    // Show login prompt
  } else if (error.message.includes('Invalid API key')) {
    // Refresh API key
  } else if (error.message.includes('Connection limit exceeded')) {
    // Show upgrade message
  } else {
    // Generic error handling
  }
});

socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') {
    // Server disconnected, reconnect manually
    socket.connect();
  }
});
```

---

## API Reference Quick Links

### Search Endpoints
- `GET /api/stock/instruments/search?q=QUERY` - Universal search (case-insensitive)
- `GET /api/stock/vayu/equities?q=QUERY` - Search equities (case-insensitive)
- `GET /api/stock/vayu/futures?q=QUERY` - Search futures (case-insensitive)
- `GET /api/stock/vayu/options?q=QUERY&option_type=CE` - Search options (case-insensitive)
- `GET /api/stock/vayu/commodities?q=QUERY` - Search MCX commodities (case-insensitive)
- `GET /api/stock/vayu/options/chain/SYMBOL` - Get options chain

### WebSocket Events
- Connect: `io('wss://api.yourdomain.com/market-data')`
- Subscribe: `socket.emit('subscribe_instruments', {instruments: [], mode: 'ltp'})`
- Unsubscribe: `socket.emit('unsubscribe_instruments', {instruments: []})`
- Listen: `socket.on('market_data', callback)`

---

## Complete Working Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>Live Watchlist</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
</head>
<body>
  <input type="text" id="searchInput" placeholder="Search stocks...">
  <button onclick="searchAndAdd()">Add to Watchlist</button>
  
  <div id="watchlist"></div>

  <script>
    const API_KEY = 'YOUR_API_KEY';
    const watchlist = [];
    let socket;

    // Connect WebSocket
    socket = io('wss://api.yourdomain.com/market-data', {
      extraHeaders: { 'x-api-key': API_KEY }
    });

    socket.on('connected', () => {
      console.log('✅ Connected');
      subscribeAll();
    });

    socket.on('market_data', (data) => {
      updatePrice(data.instrumentToken, data.data.last_price);
    });

    // Search and add
    async function searchAndAdd() {
      const query = document.getElementById('searchInput').value;
      const response = await fetch(`https://api.yourdomain.com/api/stock/vayu/equities?q=${query}&limit=1`, {
        headers: { 'x-api-key': API_KEY }
      });
      const result = await response.json();
      
      if (result.data.instruments.length > 0) {
        watchlist.push(result.data.instruments[0]);
        renderWatchlist();
        subscribeAll();
      }
    }

    // Subscribe to all
    function subscribeAll() {
      if (watchlist.length > 0) {
        socket.emit('subscribe_instruments', {
          instruments: watchlist.map(i => i.token),
          mode: 'ltp'
        });
      }
    }

    // Update price
    function updatePrice(token, price) {
      const item = watchlist.find(i => i.token === token);
      if (item) {
        item.last_price = price;
        renderWatchlist();
      }
    }

    // Render UI
    function renderWatchlist() {
      const div = document.getElementById('watchlist');
      div.innerHTML = watchlist.map(item => `
        <div style="padding: 10px; border: 1px solid #ccc; margin: 5px;">
          <strong>${item.symbol}</strong><br>
          ₹${item.last_price}
        </div>
      `).join('');
    }
  </script>
</body>
</html>
```

---

## Support

- Documentation: https://docs.yourdomain.com
- API Status: https://status.yourdomain.com
- Support: support@yourdomain.com

