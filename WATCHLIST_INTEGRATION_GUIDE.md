# Vayu Market Data API - Watchlist Integration Guide

Complete API reference for building search boxes, watchlists, and market data integrations using Vayu endpoints.

**Base URL**: `https://marketdata.vedpragya.com`  
**Authentication**: All endpoints require `x-api-key` header

---

## Quick Start

### Authentication
```javascript
const headers = {
  'x-api-key': 'YOUR_API_KEY'
};
```

### Base Configuration
```javascript
const BASE_URL = 'https://marketdata.vedpragya.com';
const API_PREFIX = '/api/stock';
```

---

## Search & Discovery Endpoints

### 1. Search Equities

Search equity stocks by symbol (case-insensitive).

**Endpoint**: `GET /api/stock/vayu/equities`

**Query Parameters**:
- `q` (string, optional) - Search query (e.g., "RELIANCE", "rel")
- `exchange` (string, optional) - Filter by exchange (e.g., "NSE_EQ")
- `limit` (number, optional) - Max results (default: 50)
- `offset` (number, optional) - Pagination offset

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/equities?q=RELIANCE&limit=10`,
  { headers }
);
const { success, data } = await response.json();
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 738561,
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "last_price": 2580.50
      }
    ],
    "pagination": {
      "total": 1,
      "hasMore": false
    }
  }
}
```

**Use Case**: Search box autocomplete for equity stocks

---

### 2. Search Futures

Search futures contracts by symbol.

**Endpoint**: `GET /api/stock/vayu/futures`

**Query Parameters**:
- `q` (string, optional) - Symbol search
- `exchange` (string, optional) - Exchange filter
- `expiry_from` (string, optional) - Expiry date from (YYYYMMDD)
- `expiry_to` (string, optional) - Expiry date to (YYYYMMDD)
- `limit` (number, optional)
- `offset` (number, optional)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/futures?q=NIFTY&limit=10`,
  { headers }
);
```

**Response Structure**:
```json
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
    ],
    "pagination": { "total": 1, "hasMore": false }
  }
}
```

**Use Case**: Futures watchlist, expiry-based filtering

---

### 3. Search Options

Search options contracts with strike and expiry filters.

**Endpoint**: `GET /api/stock/vayu/options`

**Query Parameters**:
- `q` (string, optional) - Symbol search
- `exchange` (string, optional)
- `option_type` (string, optional) - "CE" or "PE"
- `expiry_from` (string, optional) - YYYYMMDD
- `expiry_to` (string, optional) - YYYYMMDD
- `strike_min` (number, optional)
- `strike_max` (number, optional)
- `limit` (number, optional)
- `offset` (number, optional)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/options?q=NIFTY&option_type=CE&strike_min=19200&strike_max=19300&limit=20`,
  { headers }
);
```

**Response Structure**:
```json
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
    ],
    "pagination": { "total": 1, "hasMore": false }
  }
}
```

**Use Case**: Options chain search, strike-based filtering

---

### 4. Search Commodities (MCX)

Search MCX commodity futures.

**Endpoint**: `GET /api/stock/vayu/commodities`

**Query Parameters**:
- `q` (string, optional) - Symbol search (e.g., "GOLD")
- `expiry_from` (string, optional) - YYYYMMDD
- `expiry_to` (string, optional) - YYYYMMDD
- `limit` (number, optional)
- `offset` (number, optional)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/commodities?q=GOLD&limit=10`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 234567,
        "symbol": "GOLDM",
        "exchange": "MCX_FO",
        "instrument_name": "GOLD",
        "expiry_date": "20241229",
        "last_price": 62580.00
      }
    ],
    "pagination": { "total": 1, "hasMore": false }
  }
}
```

**Use Case**: MCX watchlist, commodity trading

---

### 5. Universal Instrument Search

Search across all instrument types (equities, futures, options, commodities).

**Endpoint**: `GET /api/stock/vayu/instruments/search`

**Query Parameters**:
- `q` (string, required) - Search query (case-insensitive)
- `limit` (number, optional) - Max results (default: 50)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments/search?q=rel&limit=20`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 738561,
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "instrument_name": "EQ"
      }
    ]
  }
}
```

**Use Case**: Universal search box, multi-asset discovery

---

### 6. Search Tickers by Format

Search using Vayu ticker format (e.g., NSE_EQ_RELIANCE).

**Endpoint**: `GET /api/stock/vayu/tickers/search`

**Query Parameters**:
- `q` (string, required) - Ticker format query (e.g., "NSE_EQ_RELIANCE")

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/tickers/search?q=NSE_EQ_RELIANCE`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": [
    {
      "token": 738561,
      "symbol": "RELIANCE",
      "exchange": "NSE_EQ",
      "instrument_name": "EQ",
      "expiry_date": null,
      "option_type": null,
      "strike_price": null,
      "last_price": 2580.50
    }
  ]
}
```

**Use Case**: Ticker-based lookup, symbol resolution

---

### 7. Get Options Chain

Get complete options chain for a symbol with all expiries and strikes.

**Endpoint**: `GET /api/stock/vayu/options/chain/:symbol`

**Path Parameter**:
- `symbol` (string, required) - Symbol (e.g., "NIFTY")

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/options/chain/NIFTY`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "symbol": "NIFTY",
    "expiries": ["20241228", "20250102", "20250109"],
    "strikes": [19200, 19250, 19300],
    "options": {
      "20241228": {
        "19250": {
          "CE": {
            "token": 123,
            "last_price": 125.50
          },
          "PE": {
            "token": 124,
            "last_price": 115.20
          }
        }
      }
    },
    "performance": {
      "queryTime": 45
    }
  }
}
```

**Use Case**: Options chain display, OI analysis

---

## Lookup & Details Endpoints

### 8. List Instruments with Filters

Get instruments with advanced filtering options.

**Endpoint**: `GET /api/stock/vayu/instruments`

**Query Parameters**:
- `exchange` (string, optional) - e.g., "NSE_EQ"
- `instrument_name` (string, optional) - e.g., "EQ"
- `symbol` (string, optional) - e.g., "RELIANCE"
- `option_type` (string, optional) - "CE" or "PE"
- `is_active` (boolean, optional)
- `limit` (number, optional)
- `offset` (number, optional)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments?exchange=NSE_EQ&limit=50`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instruments": [...],
    "total": 1000,
    "pagination": { "hasMore": true }
  }
}
```

---

### 9. Get Instrument by Token

Retrieve specific instrument details by token.

**Endpoint**: `GET /api/stock/vayu/instruments/:token`

**Path Parameter**:
- `token` (number, required) - Instrument token

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments/738561`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instrument": {
      "token": 738561,
      "symbol": "RELIANCE",
      "exchange": "NSE_EQ",
      "instrument_name": "EQ",
      "tick": 0.05,
      "lot_size": 1
    }
  }
}
```

**Use Case**: Token-to-instrument resolution, watchlist details

---

### 10. Get Ticker by Symbol

Get live price and metadata by Vayu ticker symbol.

**Endpoint**: `GET /api/stock/vayu/tickers/:symbol`

**Path Parameter**:
- `symbol` (string, required) - Ticker format (e.g., "NSE_EQ_RELIANCE")

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/tickers/NSE_EQ_RELIANCE`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "token": 738561,
    "symbol": "RELIANCE",
    "exchange": "NSE_EQ",
    "instrument_name": "EQ",
    "last_price": 2580.50
  }
}
```

---

### 11. Batch Lookup

Get multiple instruments by token in single request (max 100 tokens).

**Endpoint**: `POST /api/stock/vayu/instruments/batch`

**Request Body**:
```json
{
  "tokens": [738561, 11536, 26000]
}
```

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments/batch`,
  {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tokens: [738561, 11536, 26000] })
  }
);
```

**Response Structure**:
```json
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
      "738561": { "last_price": 2580.50 },
      "11536": { "last_price": 44550.30 }
    },
    "performance": {
      "queryTime": 12
    }
  }
}
```

**Use Case**: Bulk watchlist refresh, efficient multi-instrument lookup

---

## Analytics & Stats Endpoints

### 12. Instrument Statistics

Get instrument database statistics.

**Endpoint**: `GET /api/stock/vayu/instruments/stats`

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments/stats`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "total": 50000,
    "byExchange": { "NSE_EQ": 2000, "NSE_FO": 15000 },
    "byInstrumentType": { "EQ": 2000, "FUTSTK": 5000 }
  }
}
```

---

### 13. Cached Statistics

Get cached instrument statistics (faster response).

**Endpoint**: `GET /api/stock/vayu/instruments/cached-stats`

**Response includes**: total, byExchange, byInstrumentType, lastSync, queryTime

---

### 14. Popular Instruments

Get popular/most-traded instruments with caching.

**Endpoint**: `GET /api/stock/vayu/instruments/popular`

**Query Parameters**:
- `limit` (number, optional) - Max instruments (default: 50)

**Request Example**:
```javascript
const response = await fetch(
  `${BASE_URL}${API_PREFIX}/vayu/instruments/popular?limit=50`,
  { headers }
);
```

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "instruments": [
      {
        "token": 738561,
        "symbol": "RELIANCE",
        "exchange": "NSE_EQ",
        "last_price": 2580.50
      }
    ],
    "performance": { "queryTime": 5 }
  }
}
```

**Use Case**: Default watchlist suggestions, popular stocks display

---

## Admin/Utility Endpoints

### 15. Sync Instruments

Manually sync instruments from CSV (admin only).

**Endpoint**: `POST /api/stock/vayu/instruments/sync`

**Query Parameters**:
- `exchange` (string, optional)
- `csv_url` (string, optional) - Override CSV URL

---

### 16. Clear Cache

Clear Vayu cache (admin only).

**Endpoint**: `POST /api/stock/vayu/cache/clear`

**Request Body**:
```json
{
  "pattern": "vortex:*" // optional, defaults to vortex:*
}
```

---

## Usage Scenarios

### Building a Search Box

```javascript
// Debounced search function
async function searchInstruments(query, type = 'equities') {
  if (!query || query.length < 2) return [];
  
  const endpoint = `/api/stock/vayu/${type}`;
  const response = await fetch(
    `${BASE_URL}${endpoint}?q=${encodeURIComponent(query)}&limit=10`,
    { headers }
  );
  const { data } = await response.json();
  return data.instruments;
}

// Universal search
async function universalSearch(query) {
  const response = await fetch(
    `${BASE_URL}/api/stock/vayu/instruments/search?q=${encodeURIComponent(query)}&limit=20`,
    { headers }
  );
  const { data } = await response.json();
  return data.instruments;
}
```

### Creating a Watchlist

```javascript
class WatchlistManager {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.items = [];
  }

  async addFromSearch(query, type = 'equities') {
    const response = await fetch(
      `${BASE_URL}/api/stock/vayu/${type}?q=${query}&limit=1`,
      { headers: { 'x-api-key': this.apiKey } }
    );
    const { data } = await response.json();
    
    if (data.instruments.length > 0) {
      const inst = data.instruments[0];
      this.items.push({
        token: inst.token,
        symbol: inst.symbol,
        exchange: inst.exchange,
        last_price: inst.last_price,
        added_at: new Date()
      });
    }
  }

  async refreshBatch() {
    const tokens = this.items.map(i => i.token);
    if (tokens.length === 0) return;
    
    const response = await fetch(
      `${BASE_URL}/api/stock/vayu/instruments/batch`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tokens })
      }
    );
    const { data } = await response.json();
    
    // Update watchlist with fresh prices
    this.items.forEach(item => {
      if (data.ltp[item.token]) {
        item.last_price = data.ltp[item.token].last_price;
      }
    });
  }
}
```

### Options Chain Display

```javascript
async function loadOptionsChain(symbol) {
  const response = await fetch(
    `${BASE_URL}/api/stock/vayu/options/chain/${symbol}`,
    { headers }
  );
  const { data } = await response.json();
  
  // data.expiries - list of expiry dates
  // data.strikes - list of strike prices
  // data.options[expiry][strike] - CE/PE objects with tokens and prices
  return data;
}
```

---

## Error Handling

### Common HTTP Status Codes

- **200** - Success
- **400** - Bad Request (invalid parameters, missing required fields)
- **401** - Unauthorized (missing or invalid API key)
- **404** - Not Found (instrument/ticker not found)
- **429** - Rate limit exceeded
- **500** - Internal server error

### Error Response Format

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error message"
}
```

### Handling Errors

```javascript
try {
  const response = await fetch(url, { headers });
  const data = await response.json();
  
  if (!data.success) {
    console.error('API Error:', data.message);
    // Handle error
  }
  
  if (!response.ok) {
    if (response.status === 401) {
      // Handle authentication error
    } else if (response.status === 404) {
      // Handle not found
    }
  }
} catch (error) {
  console.error('Network error:', error);
}
```

---

## Best Practices

1. **Search Debouncing**: Debounce search queries (300-500ms) to reduce API calls
2. **Batch Operations**: Use batch endpoint for multiple instrument lookups
3. **Caching**: Cache popular instruments and search results client-side
4. **Pagination**: Use limit/offset for large result sets
5. **Error Retry**: Implement exponential backoff for failed requests
6. **Rate Limiting**: Respect rate limits, implement client-side throttling

---

## Quick Reference

| Endpoint | Method | Use Case |
|----------|--------|----------|
| `/api/stock/vayu/equities` | GET | Equity search box |
| `/api/stock/vayu/futures` | GET | Futures search |
| `/api/stock/vayu/options` | GET | Options search |
| `/api/stock/vayu/commodities` | GET | MCX search |
| `/api/stock/vayu/instruments/search` | GET | Universal search |
| `/api/stock/vayu/tickers/search` | GET | Ticker lookup |
| `/api/stock/vayu/options/chain/:symbol` | GET | Options chain |
| `/api/stock/vayu/instruments/:token` | GET | Token lookup |
| `/api/stock/vayu/instruments/batch` | POST | Bulk lookup |
| `/api/stock/vayu/instruments/popular` | GET | Popular stocks |

---

**Base URL**: `https://marketdata.vedpragya.com`  
**All endpoints require**: `x-api-key` header
