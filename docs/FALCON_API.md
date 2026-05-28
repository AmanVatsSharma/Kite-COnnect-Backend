# Falcon API — Complete Developer Reference

> **Version:** 2.0 · **Provider:** Kite Connect (Zerodha) · **Base URL:** `https://your-domain.com`

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Base Response Format](#2-base-response-format)
3. [Health & System](#3-health--system)
4. [Instruments](#4-instruments)
5. [Market Data — LTP, Quote, OHLC](#5-market-data--ltp-quote-ohlc)
6. [Historical Candles](#6-historical-candles)
7. [Options Chain](#7-options-chain)
8. [Underlyings & Derivatives](#8-underlyings--derivatives)
9. [F&O Autocomplete](#9-fno-autocomplete)
10. [Equity, Futures, Options, Commodity Lists](#10-equity-futures-options-commodity-lists)
11. [Symbol Resolution & Search](#11-symbol-resolution--search)
12. [Instrument Validation](#12-instrument-validation)
13. [Instrument Sync](#13-instrument-sync)
14. [Cache Management](#14-cache-management)
15. [Error Codes](#15-error-codes)
16. [Rate Limits](#16-rate-limits)

---

## 1. Authentication

All client endpoints are protected by API key authentication. Pass your API key in every request header:

```
x-api-key: YOUR_API_KEY
```

### 1.1 OAuth Login (One-time setup)

Before making any API calls, you must authenticate with Kite using OAuth.

**`GET /api/auth/falcon/login`**

Initiates the Kite OAuth flow. Returns a login URL to redirect the user to Kite's authorization page.

*Response*

```json
{
  "url": "https://kite.trade/connect/login?v=3&api_key=...",
  "state": "abc123xyz"
}
```

Redirect the user to the returned `url`. After they authorize, Kite redirects to your callback URL with `request_token` and `state` parameters.

---

**`GET /api/auth/falcon/callback`**

OAuth callback handler. Called automatically by Kite after user authorization.

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `request_token` | string | ✅ | Token from Kite OAuth redirect |
| `state` | string | ✅ | CSRF state from `/login` step |

*Response*

```json
{
  "success": true,
  "access_token": "eyJhbGci...",
  "message": "Kite session established successfully"
}
```

The access token is stored securely in Redis and survives server restarts.

---

## 2. Base Response Format

All API responses follow a consistent envelope:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

On error:

```json
{
  "success": false,
  "message": "Human-readable error message",
  "error": "Optional technical detail"
}
```

---

## 3. Health & System

### `GET /api/stock/falcon/health`

Health probe with sample LTP check. Use this to verify your API key is valid and the provider connection is alive.

*Headers:* `x-api-key`

*Response*

```json
{
  "success": true,
  "provider": "falcon",
  "httpOk": true,
  "sample_ok": true,
  "sample_token": "738561"
}
```

---

### `GET /api/stock/falcon/instruments/stats`

Returns instrument counts broken down by exchange and type.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| — | — | — | No parameters |

*Response*

```json
{
  "success": true,
  "data": {
    "total": 124500,
    "by_exchange": {
      "NSE": 2500,
      "BSE": 1800,
      "NFO": 85000,
      "MCX": 2500,
      "BFO": 500,
      "CDS": 200
    },
    "by_type": {
      "EQ": 4300,
      "FUT": 1200,
      "CE": 42000,
      "PE": 42000,
      "IDX": 2
    },
    "active": 124000,
    "inactive": 500,
    "uir_coverage": {
      "total_active": 124000,
      "mapped_count": 123500,
      "unmapped_count": 500,
      "coverage_pct": 99.6
    }
  }
}
```

---

### `GET /api/stock/falcon/instruments/cached-stats`

Cached version of instrument stats (refreshes every 60 seconds). Faster than `/instruments/stats`.

*Headers:* `x-api-key`

---

## 4. Instruments

### `GET /api/stock/falcon/instruments`

List instruments with optional filters. Supports pagination.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `exchange` | string | ❌ | — | Filter by exchange: `NSE`, `BSE`, `NFO`, `MCX`, `BFO`, `CDS` |
| `instrument_type` | string | ❌ | — | Filter by type: `EQ`, `FUT`, `CE`, `PE` |
| `segment` | string | ❌ | — | Filter by segment: `NSE`, `BSE`, `NFO-FUT`, `NFO-OPT`, `MCX` |
| `is_active` | boolean | ❌ | — | `true` / `false` |
| `limit` | integer | ❌ | 100 | Rows per page (max 1000) |
| `offset` | integer | ❌ | 0 | Pagination offset |

*Response*

```json
{
  "success": true,
  "instruments": [
    {
      "instrument_token": 738561,
      "exchange_token": 512,
      "tradingsymbol": "RELIANCE",
      "name": "RELIANCE INDUSTRIES",
      "last_price": 2850.00,
      "expiry": "",
      "strike": 0,
      "tick_size": 0.05,
      "lot_size": 1,
      "instrument_type": "EQ",
      "segment": "NSE",
      "exchange": "NSE",
      "isin": "INE002A01018",
      "is_active": true,
      "description": "NSE RELIANCE EQ",
      "uir_id": 1001,
      "canonical_symbol": "NSE:RELIANCE:EQ",
      "logo_url": "https://financialmodelingprep.com/image-stock/RELIANCE.NS.png"
    }
  ],
  "total": 2500,
  "limit": 100,
  "offset": 0
}
```

---

### `GET /api/stock/falcon/instruments/{token}`

Fetch a single instrument by its numeric token.

*Headers:* `x-api-key`

*Path Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | integer | ✅ | Instrument token (e.g., `738561`) |

*Response*

```json
{
  "success": true,
  "data": {
    "instrument_token": 738561,
    "tradingsymbol": "RELIANCE",
    "name": "RELIANCE INDUSTRIES",
    "exchange": "NSE",
    "instrument_type": "EQ",
    "last_price": 2850.00,
    "uir_id": 1001,
    "canonical_symbol": "NSE:RELIANCE:EQ"
  }
}
```

---

### `GET /api/stock/falcon/instruments/export`

Stream all instruments as NDJSON (newline-delimited JSON). Useful for bulk exports.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | Filter by exchange |
| `instrument_type` | string | ❌ | Filter by type |
| `is_active` | boolean | ❌ | Filter active/inactive |

*Response:* Stream of JSON objects, one per line:

```
{"instrument_token":738561,"tradingsymbol":"RELIANCE",...}
{"instrument_token":738562,"tradingsymbol":"INFY",...}
...
```

---

### `POST /api/stock/falcon/instruments/batch`

Batch lookup instruments by a list of tokens. Up to 1000 tokens per request.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "tokens": [738561, 5633, 256265]
}
```

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "instrument_token": 738561,
      "tradingsymbol": "RELIANCE",
      "name": "RELIANCE INDUSTRIES",
      "exchange": "NSE",
      "instrument_type": "EQ",
      "uir_id": 1001
    },
    "5633": {
      "instrument_token": 5633,
      "tradingsymbol": "SBIN",
      "name": "STATE BANK OF INDIA",
      "exchange": "NSE",
      "instrument_type": "EQ",
      "uir_id": 1042
    }
  }
}
```

---

## 5. Market Data — LTP, Quote, OHLC

All market data endpoints use the `FalconTokensDto` input format. Pass token arrays in the request body.

### `POST /api/stock/falcon/ltp`

Get Last Traded Price for one or more instruments.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "tokens": ["738561", "5633", "256265"]
}
```

> **Token Format:** Accepts numeric strings (`"738561"`) or exchange:symbol format (`"NSE:RELIANCE"`).

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "last_price": 2850.50,
      "uir_id": 1001,
      "canonical_symbol": "NSE:RELIANCE:EQ"
    },
    "5633": {
      "last_price": 820.30,
      "uir_id": 1042,
      "canonical_symbol": "NSE:SBIN:EQ"
    }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

---

### `GET /api/stock/falcon/ltp`

Alternative LTP endpoint using query parameters instead of body. Useful for quick single-token checks.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tokens` | string | ✅ | Comma-separated tokens: `738561,5633,256265` |

*Response:* Same format as `POST /ltp`

---

### `POST /api/stock/falcon/quote`

Get full quote data including OHLC, depth (order book), OI, volume, and more.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "tokens": ["738561", "256265"]
}
```

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "last_price": 2850.50,
      "last_quantity": 10,
      "last_time": "2026-05-28T10:29:55",
      "ohlc": {
        "open": 2845.00,
        "high": 2862.00,
        "low": 2840.00,
        "close": 2845.50
      },
      "bid": 2850.00,
      "ask": 2851.00,
      "bq": 500,
      "aq": 300,
      "volume": 8500000,
      "oi": 12000000,
      "oi_day_high": 12500000,
      "oi_day_low": 11800000,
      "instrument_token": 738561,
      "exchange_token": 512,
      "tradingsymbol": "RELIANCE",
      "name": "RELIANCE INDUSTRIES",
      "segment": "NSE",
      "exchange": "NSE",
      "depth": {
        "buy": [
          { "price": 2850.00, "quantity": 500, "orders": 12 },
          { "price": 2849.50, "quantity": 1200, "orders": 25 }
        ],
        "sell": [
          { "price": 2851.00, "quantity": 300, "orders": 8 },
          { "price": 2851.50, "quantity": 800, "orders": 18 }
        ]
      },
      "uir_id": 1001,
      "canonical_symbol": "NSE:RELIANCE:EQ"
    }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

**Quote fields explained:**

| Field | Type | Description |
|-------|------|-------------|
| `last_price` | number | Most recent traded price |
| `last_quantity` | number | Quantity of last trade |
| `last_time` | string | Timestamp of last trade |
| `ohlc` | object | Open, High, Low, Close |
| `bid` / `ask` | number | Best bid and ask price |
| `bq` / `aq` | number | Bid/Ask quantity |
| `volume` | number | Day volume |
| `oi` | number | Open Interest |
| `oi_day_high` | number | Highest OI today |
| `oi_day_low` | number | Lowest OI today |
| `depth` | object | Top 5 levels of order book |

---

### `POST /api/stock/falcon/ohlc`

Get OHLC (Open-High-Low-Close) summary for instruments.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "tokens": ["738561", "5633", "256265"]
}
```

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "open": 2845.00,
      "high": 2862.00,
      "low": 2840.00,
      "close": 2845.50,
      "uir_id": 1001,
      "canonical_symbol": "NSE:RELIANCE:EQ"
    },
    "5633": {
      "open": 815.00,
      "high": 825.00,
      "low": 812.00,
      "close": 820.30,
      "uir_id": 1042,
      "canonical_symbol": "NSE:SBIN:EQ"
    }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

---

## 6. Historical Candles

Historical OHLCV (Open-High-Low-Close-Volume) data for charting and analysis.

### `GET /api/stock/falcon/historical/{token}`

Fetch historical candles for a single instrument.

*Headers:* `x-api-key`

*Path Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | integer | ✅ | Instrument token (e.g., `738561`) |

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | ✅ | Start date: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss` |
| `to` | string | ✅ | End date: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss` |
| `interval` | string | ✅ | Candle interval (see table below) |
| `continuous` | boolean | ❌ | `true` to include expiry contract data for F&O (default: `false`) |
| `oi` | boolean | ❌ | `true` to include Open Interest in candles for F&O (default: `false`) |

**Supported intervals:**

| Interval | Description |
|----------|-------------|
| `minute` | 1-minute candles |
| `3minute` | 3-minute candles |
| `5minute` | 5-minute candles |
| `10minute` | 10-minute candles |
| `15minute` | 15-minute candles |
| `30minute` | 30-minute candles |
| `60minute` | 1-hour candles |
| `day` | Daily candles |

*Example: Daily candles for RELIANCE*

```bash
GET /api/stock/falcon/historical/738561?from=2026-04-01&to=2026-04-30&interval=day
```

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "instrument_token": 738561,
      "candles": [
        ["2026-04-01T09:15:00+05:30", 2840.00, 2865.00, 2835.00, 2855.50, 8500000],
        ["2026-04-02T09:15:00+05:30", 2855.00, 2880.00, 2850.00, 2872.30, 9200000],
        ["2026-04-03T09:15:00+05:30", 2872.00, 2900.00, 2868.00, 2895.00, 7800000]
      ]
    }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

> **Candle format:** Each candle is an array: `[timestamp, open, high, low, close, volume]`
> - Timestamp is in ISO format with IST offset
> - Volume is the total traded quantity for the period

*Example: Intraday 5-minute candles with OI*

```bash
GET /api/stock/falcon/historical/127795793?from=2026-05-27&to=2026-05-28&interval=5minute&oi=true
```

*Response (F&O with OI)*

```json
{
  "success": true,
  "data": {
    "127795793": {
      "instrument_token": 127795793,
      "candles": [
        ["2026-05-27T09:15:00+05:30", 24500.00, 24650.00, 24480.00, 24620.00, 250000, 1500000],
        ["2026-05-27T09:20:00+05:30", 24620.00, 24700.00, 24590.00, 24680.00, 180000, 1520000]
      ]
    }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

> **With OI:** Candles include a 6th element: `[timestamp, open, high, low, close, volume, open_interest]`

---

### `POST /api/stock/falcon/historical/batch`

Fetch historical candles for up to **10 instruments** in a single request. Much more efficient than multiple individual calls.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "requests": [
    {
      "token": 738561,
      "from": "2026-04-01",
      "to": "2026-04-30",
      "interval": "day"
    },
    {
      "token": 256265,
      "from": "2026-04-01",
      "to": "2026-04-30",
      "interval": "day"
    },
    {
      "token": 5633,
      "from": "2026-05-01",
      "to": "2026-05-28",
      "interval": "5minute",
      "continuous": true,
      "oi": false
    }
  ]
}
```

*Constraints:*
- Maximum **10 requests** per call
- Concurrency-limited to 3 parallel requests (~3 RPS rate limit)
- Smart Redis caching with TTL based on interval and date range

*Response*

```json
{
  "success": true,
  "data": {
    "738561": {
      "instrument_token": 738561,
      "candles": [
        ["2026-04-01T09:15:00+05:30", 2840.00, 2865.00, 2835.00, 2855.50, 8500000],
        ["2026-04-02T09:15:00+05:30", 2855.00, 2880.00, 2850.00, 2872.30, 9200000]
      ]
    },
    "256265": {
      "instrument_token": 256265,
      "candles": [
        ["2026-04-01T09:15:00+05:30", 21800.00, 21950.00, 21780.00, 21920.00, 120000]
      ]
    },
    "5633": {
      "instrument_token": 5633,
      "candles": [
        ["2026-05-01T09:15:00+05:30", 815.00, 825.00, 812.00, 820.30, 500000]
      ]
    }
  },
  "count": 3,
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

**Smart Cache TTL:** Results are cached with intelligent TTL:
| Interval | Today | Historical |
|----------|-------|------------|
| `minute` | 60s | 1 hour |
| `3minute` / `5minute` | 60s | 1 hour |
| `10minute` / `15minute` | 300s | 2 hours |
| `60minute` | 900s | 6 hours |
| `day` | 1800s | 24 hours |

---

## 7. Options Chain

Full options market data with strike-by-strike pricing, OI, volume, and Greeks.

### `GET /api/stock/falcon/options/chain/{symbol}`

Standard options chain — tokens and basic LTP for all strikes grouped by expiry.

*Headers:* `x-api-key`

*Path Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✅ | Underlying symbol (e.g., `NIFTY`, `BANKNIFTY`, `RELIANCE`) |

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ltp_only` | boolean | ❌ | `false` | If `true`, only return strikes with valid last prices |

*Example:* `GET /api/stock/falcon/options/chain/NIFTY`

*Response*

```json
{
  "success": true,
  "data": {
    "symbol": "NIFTY",
    "expiry": ["2026-05-29", "2026-06-05", "2026-06-26", "2026-07-31"],
    "strikes": [23500, 23550, 23600, 23650, 23700, 23750, 23800, 23850, 23900, 23950, 24000, 24050, 24100],
    "options": {
      "2026-05-29": {
        "23600": {
          "CE": {
            "instrument_token": 127795793,
            "tradingsymbol": "NIFTY26MAY23600CE",
            "name": "NIFTY",
            "exchange": "NFO",
            "segment": "NFO-OPT",
            "expiry": "2026-05-29",
            "strike": 23600,
            "lot_size": 50,
            "tick_size": 0.05,
            "last_price_live": 245.50,
            "uir_id": 50001,
            "canonical_symbol": "NFO:NIFTY:CE:2026-05-29:23600"
          },
          "PE": {
            "instrument_token": 127795848,
            "tradingsymbol": "NIFTY26MAY23600PE",
            "name": "NIFTY",
            "exchange": "NFO",
            "expiry": "2026-05-29",
            "strike": 23600,
            "last_price_live": 210.30,
            "uir_id": 50002,
            "canonical_symbol": "NFO:NIFTY:PE:2026-05-29:23600"
          }
        }
      }
    },
    "ltp_only": false
  }
}
```

**Cache TTL:** 60 seconds during market hours (9:15–15:30 IST Mon–Fri), 300 seconds otherwise.

---

### `GET /api/stock/falcon/options/chain/{symbol}/deep`

**Sensibull-style deep options chain** — full market snapshot per strike including:
- Live LTP, OI, volume
- Day high/low OI
- OHLC and average price
- Bid/ask depth
- Per-expiry **PCR** (Put-Call Ratio)
- **Greeks**: Delta, Gamma, Theta, Vega, IV
- **ATM** and **ITM** flags per strike

*Headers:* `x-api-key`

*Path Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✅ | Underlying symbol (e.g., `NIFTY`, `BANKNIFTY`) |

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `expiry` | string | ❌ | — | Filter to a single expiry (`YYYY-MM-DD`). Omit for all expiries |
| `strikes_around_atm` | integer | ❌ | `0` (all) | Return only N strikes above and below ATM. E.g., `10` returns 21 strikes total |

*Example:* `GET /api/stock/falcon/options/chain/NIFTY/deep?strikes_around_atm=10`

*Response*

```json
{
  "success": true,
  "symbol": "NIFTY",
  "underlying_ltp": 23850.0,
  "atm_strike": 23850,
  "fetched_at": "2026-05-28T10:30:00.000Z",
  "expiry": [
    {
      "expiry": "2026-05-29",
      "pcr": 0.9450,
      "total_ce_oi": 1500000,
      "total_pe_oi": 1417500,
      "avg_iv": 16.2,
      "max_pain": 23800,
      "strikes": [
        {
          "strike": 23600,
          "itm": "PE",
          "CE": {
            "instrument_token": 127795793,
            "tradingsymbol": "NIFTY26MAY23600CE",
            "expiry": "2026-05-29",
            "strike": 23600,
            "ltp": 345.50,
            "oi": 125000,
            "volume": 85000,
            "open": 340.00,
            "high": 355.00,
            "low": 338.00,
            "close": 342.00,
            "bid": 345.00,
            "ask": 346.00,
            "bq": 100,
            "aq": 50,
            "iv": 14.5,
            "delta": 0.72,
            "gamma": 0.028,
            "theta": -8.5,
            "vega": 18.2,
            "theoretical_price": 345.00,
            "depth": {
              "buy": [{ "price": 345.00, "quantity": 100, "orders": 3 }],
              "sell": [{ "price": 346.00, "quantity": 50, "orders": 2 }]
            }
          },
          "PE": {
            "instrument_token": 127795848,
            "tradingsymbol": "NIFTY26MAY23600PE",
            "expiry": "2026-05-29",
            "strike": 23600,
            "ltp": 55.20,
            "oi": 98000,
            "volume": 45000,
            "open": 52.00,
            "high": 58.00,
            "low": 51.50,
            "close": 53.00,
            "bid": 55.00,
            "ask": 55.50,
            "bq": 200,
            "aq": 150,
            "iv": 18.2,
            "delta": -0.28,
            "gamma": 0.025,
            "theta": -5.2,
            "vega": 15.8,
            "theoretical_price": 55.00
          }
        },
        {
          "strike": 23650,
          "itm": "PE",
          "CE": {
            "instrument_token": 127795799,
            "ltp": 305.00,
            "oi": 110000,
            "volume": 72000,
            "iv": 15.0,
            "delta": 0.65,
            "gamma": 0.032,
            "theta": -9.8,
            "vega": 19.5
          },
          "PE": {
            "instrument_token": 127795853,
            "ltp": 72.50,
            "oi": 115000,
            "volume": 58000,
            "iv": 17.5,
            "delta": -0.35,
            "gamma": 0.030,
            "theta": -7.1,
            "vega": 17.2
          }
        },
        {
          "strike": 23850,
          "itm": "ATM",
          "CE": {
            "instrument_token": 127795812,
            "ltp": 185.00,
            "oi": 250000,
            "volume": 180000,
            "iv": 16.0,
            "delta": 0.50,
            "gamma": 0.038,
            "theta": -12.5,
            "vega": 22.0
          },
          "PE": {
            "instrument_token": 127795867,
            "ltp": 178.00,
            "oi": 265000,
            "volume": 195000,
            "iv": 16.0,
            "delta": -0.50,
            "gamma": 0.038,
            "theta": -12.8,
            "vega": 22.5
          }
        }
      ]
    }
  ]
}
```

**Greeks fields explained:**

| Field | Description |
|-------|-------------|
| `iv` | Implied Volatility (%) |
| `delta` | Rate of change of option price vs underlying price |
| `gamma` | Rate of change of delta |
| `theta` | Time decay per day (negative = losing value daily) |
| `vega` | Sensitivity to 1% change in IV |
| `theoretical_price` | Black-Scholes theoretical price |

**ITM flags:**
- `ATM` — At-the-money (strike closest to underlying LTP)
- `CE` — Call is ITM (strike < underlying for calls)
- `PE` — Put is ITM (strike > underlying for puts)

**Cache TTL:** 15 seconds during market hours, 300 seconds otherwise.

---

## 8. Underlyings & Derivatives

### `GET /api/stock/falcon/underlyings/{symbol}/futures`

Get all active futures contracts for a specific underlying symbol.

*Headers:* `x-api-key`

*Path Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ✅ | Underlying symbol (e.g., `NIFTY`, `RELIANCE`) |

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `exchange` | string | ❌ | `NFO` | Exchange filter |
| `ltp_only` | boolean | ❌ | `false` | Only contracts with live price |
| `limit` | integer | ❌ | 100 | Max results (max 1000) |
| `offset` | integer | ❌ | 0 | Pagination offset |

*Example:* `GET /api/stock/falcon/underlyings/NIFTY/futures`

*Response*

```json
{
  "success": true,
  "items": [
    {
      "instrument_token": 128123456,
      "tradingsymbol": "NIFTY26MAY",
      "name": "NIFTY",
      "expiry": "2026-05-29",
      "strike": 0,
      "instrument_type": "FUT",
      "segment": "NFO-FUT",
      "exchange": "NFO",
      "lot_size": 75,
      "tick_size": 0.05,
      "last_price_live": 23820.50,
      "uir_id": 60001,
      "canonical_symbol": "NFO:NIFTY:FUT:2026-05-29",
      "description": "NFO NIFTY 29MAY FUT"
    },
    {
      "instrument_token": 128123457,
      "tradingsymbol": "NIFTY26JUN",
      "name": "NIFTY",
      "expiry": "2026-06-26",
      "strike": 0,
      "instrument_type": "FUT",
      "segment": "NFO-FUT",
      "exchange": "NFO",
      "lot_size": 75,
      "tick_size": 0.05,
      "last_price_live": 23950.00,
      "uir_id": 60002,
      "canonical_symbol": "NFO:NIFTY:FUT:2026-06-26"
    }
  ],
  "total": 4
}
```

---

### `GET /api/stock/falcon/underlyings/{symbol}/options`

Options chain for an underlying. Alias for `/options/chain/{symbol}`.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ltp_only` | boolean | ❌ | `false` | Only strikes with live prices |

---

## 9. F&O Autocomplete

### `GET /api/stock/falcon/fno/autocomplete`

Autocomplete for F&O underlying symbols — returns only symbols that have active futures or options contracts.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | ✅ | — | Search prefix (e.g., `NIF`, `BANK`) |
| `scope` | string | ❌ | `all` | Filter: `nse`, `mcx`, `all` |
| `limit` | integer | ❌ | 10 | Max suggestions (max 50) |

*Example:* `GET /api/stock/falcon/fno/autocomplete?q=NIF&scope=nse`

*Response*

```json
{
  "success": true,
  "data": {
    "suggestions": [
      { "symbol": "NIFTY", "exchange": "NSE" },
      { "symbol": "NIFTY FIN SERVICE", "exchange": "NSE" }
    ]
  }
}
```

---

## 10. Equity, Futures, Options, Commodity Lists

### `GET /api/stock/falcon/equities`

List equity (EQ) instruments with optional text search and LTP enrichment.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | `NSE` or `BSE` |
| `q` | string | ❌ | Text search (matches symbol or name) |
| `is_active` | boolean | ❌ | Filter active instruments |
| `ltp_only` | boolean | ❌ | Only instruments with live prices |
| `limit` | integer | ❌ | Max 1000 |
| `offset` | integer | ❌ | Pagination offset |

---

### `GET /api/stock/falcon/futures`

List futures contracts with expiry date filtering.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ❌ | Underlying symbol |
| `exchange` | string | ❌ | Exchange (`NFO`, `MCX`) |
| `expiry_from` | string | ❌ | Minimum expiry (`YYYY-MM-DD`) |
| `expiry_to` | string | ❌ | Maximum expiry (`YYYY-MM-DD`) |
| `is_active` | boolean | ❌ | Filter active |
| `ltp_only` | boolean | ❌ | Only with live price |
| `limit` | integer | ❌ | Max 1000 |
| `offset` | integer | ❌ | Pagination |

---

### `GET /api/stock/falcon/options`

List options contracts with comprehensive filtering.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ❌ | Underlying symbol |
| `exchange` | string | ❌ | Exchange (`NFO`) |
| `expiry_from` | string | ❌ | Min expiry |
| `expiry_to` | string | ❌ | Max expiry |
| `strike_min` | number | ❌ | Minimum strike price |
| `strike_max` | number | ❌ | Maximum strike price |
| `option_type` | string | ❌ | `CE` or `PE` |
| `is_active` | boolean | ❌ | Filter active |
| `ltp_only` | boolean | ❌ | Only with live price |
| `limit` | integer | ❌ | Max 1000 |
| `offset` | integer | ❌ | Pagination |

---

### `GET /api/stock/falcon/commodities`

List MCX commodity instruments.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ❌ | Commodity symbol (`GOLD`, `SILVER`, `CRUDEOIL`) |
| `exchange` | string | ❌ | `MCX` |
| `instrument_type` | string | ❌ | `FUT`, `CE`, `PE` |
| `is_active` | boolean | ❌ | Filter active |
| `ltp_only` | boolean | ❌ | Only with live price |
| `limit` | integer | ❌ | Max 1000 |
| `offset` | integer | ❌ | Pagination |

---

### `GET /api/stock/falcon/mcx-options`

MCX options with strike and expiry filtering.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | ❌ | Underlying (GOLD, SILVER, etc.) |
| `option_type` | string | ❌ | `CE` or `PE` |
| `expiry_from` | string | ❌ | Min expiry |
| `expiry_to` | string | ❌ | Max expiry |
| `strike_min` | number | ❌ | Min strike |
| `strike_max` | number | ❌ | Max strike |
| `is_active` | boolean | ❌ | Filter |
| `ltp_only` | boolean | ❌ | Only with live price |
| `limit` | integer | ❌ | Max 1000 |
| `offset` | integer | ❌ | Pagination |

---

## 11. Symbol Resolution & Search

### `GET /api/stock/falcon/instruments/resolve`

Convert trading symbols to instrument tokens. Uses Redis cache for fast resolution.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbols` | string | ✅ | Comma-separated: `RELIANCE,NIFTY,SBIN` |
| `exchange` | string | ❌ | Exchange filter (`NSE`, `NFO`) |

*Example:* `GET /api/stock/falcon/instruments/resolve?symbols=RELIANCE,NIFTY,SBIN`

*Response*

```json
{
  "success": true,
  "data": {
    "RELIANCE": 738561,
    "NIFTY": 256265,
    "SBIN": 5633
  }
}
```

---

### `GET /api/stock/falcon/instruments/search`

Full-text search across instruments.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | ✅ | — | Search query |
| `limit` | integer | ❌ | 20 | Max results (max 200) |

*Response*

```json
{
  "success": true,
  "data": [
    {
      "instrument_token": 738561,
      "tradingsymbol": "RELIANCE",
      "name": "RELIANCE INDUSTRIES",
      "exchange": "NSE",
      "instrument_type": "EQ",
      "segment": "NSE",
      "is_active": true,
      "uir_id": 1001
    }
  ]
}
```

---

### `GET /api/stock/falcon/tickers/search`

Search with live price enrichment.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | ✅ | — | Query (supports `EXCHANGE:SYMBOL` format) |
| `limit` | integer | ❌ | 20 | Max results |
| `ltp_only` | boolean | ❌ | `false` | Only instruments with live price |

---

### `GET /api/stock/falcon/tickers/{symbol}`

Get full ticker data by symbol with live LTP.

*Headers:* `x-api-key`

*Example:* `GET /api/stock/falcon/tickers/RELIANCE`

*Response*

```json
{
  "success": true,
  "data": {
    "instrument_token": 738561,
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "instrument_type": "EQ",
    "description": "NSE RELIANCE EQ",
    "last_price": 2850.50,
    "uir_id": 1001,
    "canonical_symbol": "NSE:RELIANCE:EQ",
    "logo_url": "https://financialmodelingprep.com/image-stock/RELIANCE.NS.png"
  }
}
```

---

### `GET /api/stock/falcon/instruments/popular`

Popular instruments with live LTP — hardcoded list of the most-traded symbols.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | integer | ❌ | 50 | Max results (max 200) |

*Includes:* NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, RELIANCE, INFY, TCS, HDFCBANK, ICICIBANK, SBIN, WIPRO, HCLTECH, AXISBANK, KOTAKBANK, LT, BAJFINANCE, MARUTI, TATAMOTORS, ADANIENT, GOLD, SILVER, CRUDEOIL, NATURALGAS

---

## 12. Instrument Validation

### `POST /api/stock/falcon/validate-instruments`

Validate instruments via live LTP — finds instruments with stale or invalid prices.

*Headers:* `x-api-key`

*Request Body*

```json
{
  "limit": 2000,
  "offset": 0,
  "batchSize": 200,
  "dry_run": false,
  "auto_cleanup": false
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 2000 | Max instruments to check (max 10000) |
| `offset` | integer | 0 | Starting offset |
| `batchSize` | integer | 200 | Batch size per LTP call |
| `dry_run` | boolean | `false` | If `true`, only returns results without deactivating |
| `auto_cleanup` | boolean | `false` | If `true` + `dry_run=false`, sets `is_active=false` on invalid instruments |

*Response*

```json
{
  "success": true,
  "tested": 2000,
  "invalid_instruments": [127800001, 127800015, 128000042],
  "deactivated": 0
}
```

---

### `GET /api/stock/falcon/validate-instruments/status`

Poll validation job status.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | string | ✅ | Job ID from validation request |

---

### `POST /api/stock/falcon/validate-instruments/stream`

Stream live validation progress via Server-Sent Events (SSE).

*Headers:* `x-api-key`

*Request Body* — Same as `/validate-instruments`

*Response:* SSE stream

```
data: {"event":"started","jobId":"uuid-xxx","ts":...}
data: {"event":"progress","tested":500,"invalid":2,"ts":...}
data: {"event":"progress","tested":1000,"invalid":5,"ts":...}
data: {"event":"completed","result":{...},"ts":...}
```

---

### `POST /api/stock/falcon/validate-instruments/export`

Export invalid instruments as CSV.

*Headers:* `x-api-key`

*Response:* CSV download

```csv
token,reason
127800001,invalid_ltp
127800015,invalid_ltp
```

---

## 13. Instrument Sync

### `POST /api/stock/falcon/instruments/sync`

Trigger a manual instrument sync from Kite. Blocking call — waits for completion.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | Sync only a specific exchange |

*Response*

```json
{
  "success": true,
  "synced": 1200,
  "updated": 4500,
  "reconciled": 50
}
```

---

### `GET /api/stock/falcon/instruments/sync/status`

Poll sync job status.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | string | ✅ | Job ID |

*Response (in progress)*

```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": {
    "status": "running",
    "progress": {
      "processed": 50000,
      "created": 1200,
      "updated": 4500
    },
    "ts": 1748419200000
  }
}
```

*Response (completed)*

```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": {
    "status": "completed",
    "summary": {
      "synced": 1200,
      "updated": 4500,
      "reconciled": 50
    },
    "ts": 1748420000000
  }
}
```

---

### `POST /api/stock/falcon/instruments/sync/start`

Start a sync in the background and return immediately with a jobId.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | Sync only specific exchange |

*Response*

```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Sync job started",
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

Poll status via `GET /instruments/sync/status?jobId=<jobId>`

---

### `POST /api/stock/falcon/instruments/sync/stream`

Stream live sync progress via SSE.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | Exchange to sync |

*Response:* SSE stream of progress events

```
data: {"event":"started","jobId":"uuid","exchange":"all","ts":...}
data: {"event":"progress","processed":1000,"created":50,"updated":150,"ts":...}
data: {"event":"completed","summary":{"synced":1200,"updated":4500},"ts":...}
```

---

### `DELETE /api/stock/falcon/instruments/inactive`

Permanently delete all inactive instruments from the database.

*Headers:* `x-api-key`

*Response*

```json
{
  "success": true,
  "message": "Inactive instruments deleted",
  "deleted": 512
}
```

---

### `DELETE /api/stock/falcon/instruments`

Delete instruments by exchange and/or type filter.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exchange` | string | ❌ | Exchange to delete |
| `instrument_type` | string | ❌ | Type to delete (`EQ`, `FUT`, `CE`, `PE`) |

> ⚠️ At least one filter (`exchange` or `instrument_type`) is required.

*Response*

```json
{
  "success": true,
  "message": "Delete completed",
  "deleted": 2500,
  "filters": { "exchange": "BFO", "instrument_type": null }
}
```

---

## 14. Cache Management

### `POST /api/stock/falcon/cache/clear`

Clear Falcon Redis cache (profile, margins, stats keys).

*Headers:* `x-api-key`

*Response*

```json
{
  "success": true,
  "message": "Falcon cache cleared"
}
```

---

## 15. Error Codes

| HTTP Status | Success | Message | Likely Cause |
|-------------|---------|---------|-------------|
| 200 | `true` | — | Request succeeded |
| 400 | `false` | `tokens array is required` | Empty request body |
| 400 | `false` | `Invalid token` | Non-numeric token in path |
| 400 | `false` | `symbols query param is required` | Missing required query param |
| 400 | `false` | `At least one filter required` | Delete without filters |
| 401 | `false` | `Invalid API key` | Bad `x-api-key` header |
| 404 | `false` | `Instrument not found` | Token doesn't exist |
| 404 | `false` | `Symbol not found` | Symbol not in database |
| 500 | `false` | `Falcon LTP failed` | Provider API error |
| 500 | `false` | `Falcon historical data failed` | Historical data API error |
| 500 | `false` | `Batch historical failed` | Rate limit or provider error |

---

## 16. Rate Limits

| Endpoint Pattern | Limit | Window |
|-----------------|-------|--------|
| `/ltp` | 1 req | per second |
| `/quote` | 1 req | per second |
| `/ohlc` | 1 req | per second |
| `/historical` | 3 req | per second |
| `/options/chain/**` | 2 req | per second |
| `/instruments/*` | 10 req | per second |

All limits are enforced via Redis distributed locks, making them accurate even in multi-instance deployments.

**Caching:** Most responses are cached in Redis with short TTLs:
- LTP: 10 seconds
- Quote/OHLC: 5 seconds
- Historical: 60s (intraday) to 24h (day interval historical)
- Options Chain: 15–300 seconds
- Profile: 5 minutes
- Margins: 60 seconds
- Stats: 60 seconds

---

## Appendix A: FalconInstrument Entity

The complete instrument schema as stored in the database:

| Field | Type | Description |
|-------|------|-------------|
| `instrument_token` | integer | Primary key. Numeric token from Kite |
| `exchange_token` | integer | Exchange-level token |
| `tradingsymbol` | varchar(64) | Trading symbol (e.g., `RELIANCE`) |
| `name` | varchar(128) | Company/instrument name |
| `last_price` | decimal(14,4) | Stale price from last CSV sync |
| `expiry` | varchar(16) | Expiry date `YYYY-MM-DD` (empty for EQ) |
| `strike` | decimal(14,4) | Strike price (0 for non-options) |
| `tick_size` | decimal(10,4) | Minimum price step (default 0.05) |
| `lot_size` | integer | Contract lot size |
| `instrument_type` | varchar(16) | `EQ`, `FUT`, `CE`, `PE`, `IDX` |
| `segment` | varchar(32) | Full segment: `NSE`, `NFO-OPT`, `MCX`, etc. |
| `exchange` | varchar(16) | Exchange: `NSE`, `BSE`, `NFO`, `MCX`, `BFO`, `CDS` |
| `isin` | varchar(16) | ISIN for EQ instruments |
| `is_active` | boolean | Whether the instrument is tradeable |
| `description` | text | Human-readable description |
| `uir_id` | integer | Universal Instrument Registry ID |
| `canonical_symbol` | varchar(128) | Normalized canonical symbol |
| `logo_url` | varchar(512) | Stock logo URL (Financial Modeling Prep) |

---

## Appendix B: Canonical Symbol Format

Falcon uses a canonical symbol format for cross-provider compatibility:

```
{EXCHANGE}:{UNDERLYING}:{TYPE}:{EXPIRY}:{STRIKE}
```

Examples:

| Instrument | Canonical Symbol |
|-----------|----------------|
| NSE RELIANCE EQ | `NSE:RELIANCE:EQ` |
| NFO NIFTY 29MAY FUT | `NFO:NIFTY:FUT:2026-05-29` |
| NFO NIFTY 29MAY 23800 CE | `NFO:NIFTY:CE:2026-05-29:23800` |
| MCX GOLD FUT | `MCX:GOLD:FUT` |
| MCX CRUDEOIL 29MAY FUT | `MCX:CRUDEOIL:FUT:2026-05-29` |

---

## Appendix C: Kite Token Reference

Common instrument tokens (verify via API — these may change):

| Symbol | Exchange | Token |
|--------|----------|-------|
| RELIANCE | NSE | 738561 |
| NIFTY | NSE | 256265 |
| BANKNIFTY | NSE | 260105 |
| SBIN | NSE | 5633 |
| INFY | NSE | 408065 |
| TCS | NSE | 295321 |

---

*Document generated: May 2026 · API Version: 2.0*
