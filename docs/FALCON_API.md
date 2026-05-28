# Falcon API — Complete Developer Reference

> **Version:** 2.0 · **Powered by Vedpragya** · **Base URL:** `https://marketdata.vedpragya.com`

---

## Table of Contents

1. [Base Response Format](#1-base-response-format)
2. [Health & System](#2-health--system)
3. [Instruments](#3-instruments)
4. [Market Data — LTP, Quote, OHLC](#4-market-data--ltp-quote-ohlc)
5. [Historical Candles](#5-historical-candles)
6. [Options Chain](#6-options-chain)
7. [Underlyings & Derivatives](#7-underlyings--derivatives)
8. [F&O Autocomplete](#8-fno-autocomplete)
9. [Equity, Futures, Options, Commodity Lists](#9-equity-futures-options-commodity-lists)
10. [Symbol Resolution & Search](#10-symbol-resolution--search)
11. [Universal Search](#11-universal-search)
12. [Error Codes](#12-error-codes)
13. [Rate Limits](#13-rate-limits)
14. [Appendix: Token Reference](#14-appendix-token-reference)

---

## 1. Base Response Format

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

## 2. Health & System

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

## 3. Instruments

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

## 4. Market Data — LTP, Quote, OHLC

All market data endpoints accept the same input format. Pass token arrays in the request body.

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

Alternative LTP endpoint using query parameters instead of body.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tokens` | string | ✅ | Comma-separated tokens: `738561,5633,256265` |

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

## 5. Historical Candles

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
| `continuous` | boolean | ❌ | `true` to include expiry contract data for F&O |
| `oi` | boolean | ❌ | `true` to include Open Interest in candles for F&O |

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

Fetch historical candles for up to **10 instruments** in a single request.

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

**Smart Cache TTL:**

| Interval | Today | Historical |
|----------|-------|------------|
| `minute` / `3minute` / `5minute` | 60s | 1 hour |
| `10minute` / `15minute` | 300s | 2 hours |
| `60minute` | 900s | 6 hours |
| `day` | 1800s | 24 hours |

---

## 6. Options Chain

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
| `expiry` | string | ❌ | — | Filter to a single expiry (`YYYY-MM-DD`) |
| `strikes_around_atm` | integer | ❌ | `0` (all) | Return only N strikes above and below ATM |

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
            "iv": 18.2,
            "delta": -0.28,
            "gamma": 0.025,
            "theta": -5.2,
            "vega": 15.8,
            "theoretical_price": 55.00
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
- `CE` — Call is ITM (strike < underlying)
- `PE` — Put is ITM (strike > underlying)

**Cache TTL:** 15 seconds during market hours, 300 seconds otherwise.

---

## 7. Underlyings & Derivatives

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

## 8. F&O Autocomplete

### `GET /api/stock/falcon/fno/autocomplete`

Autocomplete for F&O underlying symbols — returns only symbols that have active futures or options contracts.

*Headers:* `x-api-key`

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | ✅ | — | Search prefix (e.g., `NIF`, `BANK`) |
| `scope` | string | ❌ | `all` | Filter: `nse`, `mcx`, `all` |
| `limit` | integer | ❌ | 10 | Max suggestions (max 50) |

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

## 9. Equity, Futures, Options, Commodity Lists

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

## 10. Symbol Resolution & Search

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

## 11. Universal Search

> **Powered by MeiliSearch** · Cross-provider, cross-segment search in a single call.

All instruments from all providers (falcon, vayu, atlas, drift) are indexed in a unified search index. Use these endpoints for a unified, typeahead-friendly search experience across the entire market.

### `GET /api/search`

Universal instrument search across all providers and segments.

*Base URL:* `https://marketdata.vedpragya.com` *(no API key required for public fields)*

*Query Parameters*

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | ✅ | — | Search query (symbol, name, or partial match) |
| `limit` | integer | ❌ | 10 | Max results (max 50) |
| `exchange` | string | ❌ | — | Filter: `NSE`, `BSE`, `NFO`, `MCX`, `CDS`, `BINANCE`, etc. |
| `segment` | string | ❌ | — | Filter: `NSE`, `NFO-FUT`, `NFO-OPT`, `MCX-FUT`, `crypto`, etc. |
| `instrumentType` | string | ❌ | — | Filter: `EQ`, `FUT`, `CE`, `PE`, `ETF`, `IDX` |
| `assetClass` | string | ❌ | — | Top-level filter: `equity`, `crypto`, `currency`, `commodity` |
| `streamProvider` | string | ❌ | — | Filter by provider brand: `falcon`, `vayu`, `atlas`, `drift` |
| `optionType` | string | ❌ | — | Filter: `CE` or `PE` |
| `expiry_from` | string | ❌ | — | Min expiry (`YYYY-MM-DD`) |
| `expiry_to` | string | ❌ | — | Max expiry (`YYYY-MM-DD`) |
| `strike_min` | number | ❌ | — | Minimum strike price |
| `strike_max` | number | ❌ | — | Maximum strike price |
| `mode` | string | ❌ | — | Shorthand: `eq` (NSE_EQ), `fno` (NSE_FO), `curr` (NSE_CUR), `commodities` (MCX_FO) |
| `ltp_only` | boolean | ❌ | `false` | Return only instruments with a live price |
| `live` | boolean | ❌ | `false` | Alias for `ltp_only` |
| `fields` | string | ❌ | — | Comma-separated field projection (see Response fields) |
| `include` | string | ❌ | — | `internal` — add internal token fields (requires `x-admin-token` header) |

*Example:* `GET /api/search?q=nifty&limit=10&streamProvider=falcon&ltp_only=true`

*Response*

```json
{
  "success": true,
  "data": [
    {
      "id": 355010,
      "canonicalSymbol": "NSE:NIFTY:EQ",
      "wsSubscribeUirId": 355010,
      "last_price": 23850.00,
      "priceStatus": "live",
      "streamProvider": "falcon",
      "logo_url": "https://financialmodelingprep.com/image-stock/NIFTY.NS.png",
      "change": 125.50,
      "pchange": 0.53,
      "symbol": "NIFTY",
      "name": "NIFTY 50",
      "exchange": "NSE",
      "segment": "INDICES",
      "instrumentType": "IDX"
    },
    {
      "id": 127795793,
      "canonicalSymbol": "NFO:NIFTY:CE:2026-05-29:24000",
      "wsSubscribeUirId": 127795793,
      "last_price": 185.00,
      "priceStatus": "live",
      "streamProvider": "falcon",
      "symbol": "NIFTY26MAY24000CE",
      "name": "NIFTY",
      "exchange": "NFO",
      "segment": "NFO-OPT",
      "instrumentType": "CE",
      "expiry": "2026-05-29",
      "strike": 24000
    }
  ],
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

**Response fields (anchor fields — always returned):**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | **Universal instrument ID** — use this to subscribe via WebSocket |
| `wsSubscribeUirId` | integer | Same as `id` — convenience alias for WebSocket subscribe payloads |
| `canonicalSymbol` | string | Human-readable unique key (e.g., `NSE:RELIANCE`, `BINANCE:BTCUSDT`) |
| `last_price` | number | Latest known price (`null` if unavailable) |
| `priceStatus` | string | `"live"` = recent tick received; `"stale"` = no recent data |
| `streamProvider` | string | Provider brand: `falcon` (Indian equity), `vayu` (F&O/commodities), `atlas` (US/global), `drift` (crypto) |
| `change` | number | Price change from previous close |
| `pchange` | number | Price change percent from previous close |
| `logo_url` | string | Stock logo URL (Financial Modeling Prep for equities, CryptoIcons for crypto) |

**Allowed `fields=` projection extras:**

`symbol`, `name`, `exchange`, `segment`, `instrumentType`, `assetClass`, `optionType`, `expiry`, `strike`, `lotSize`, `tickSize`, `isDerivative`, `underlyingSymbol`

> **LTP enrichment:** When `ltp_only=true` or `live=true`, the API probes more results and filters to those with a live price. This means you can request 10 results and get fewer back if some don't have live data.

---

### `GET /api/search/suggest`

Lightweight typeahead. Same surface as `/search` but with a smaller default limit (5) and cap (20).

*Example:* `GET /api/search/suggest?q=rel&limit=5`

---

### `GET /api/search/filters`

Get live facet counts for building filter UIs. Returns how many instruments match each value.

*Example:* `GET /api/search/filters?exchange=NSE`

*Response*

```json
{
  "success": true,
  "data": {
    "exchange": { "NSE": 2500, "BSE": 1800, "NFO": 85000 },
    "segment": { "NSE": 2500, "NFO-FUT": 1200, "NFO-OPT": 84000 },
    "instrumentType": { "EQ": 4300, "FUT": 1200, "CE": 42000, "PE": 42000 },
    "assetClass": { "equity": 4300, "commodity": 2500 },
    "streamProvider": { "falcon": 85000, "vayu": 25000, "atlas": 5000, "drift": 200 }
  },
  "timestamp": "2026-05-28T10:30:00.000Z"
}
```

---

### `GET /api/search/schema`

Machine-readable description of all search parameters and their valid values. No auth required.

*Response:* Full parameter schema with enums, types, and response field documentation.

---

### `GET /api/search/stream`

SSE stream of live LTP ticks for a set of instruments. Pushes every ~1 second.

*Query Parameters*

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string | ✅* | Comma-separated UIR IDs (e.g., `355010,738561`) |
| `q` | string | ✅* | Alternative: auto-resolve top-10 from a search query |
| `ltp_only` | boolean | ❌ | Drop entries with no live price |

> \* Either `ids` or `q` is required.

*Example:* `GET /api/search/stream?ids=355010,738561&ltp_only=true`

*Response:* SSE stream

```
event: ltp
data: {"quotes":{"355010":{"last_price":23850.00,"change":125.50},"738561":{"last_price":2850.50,"change":-10.20}},"ts":"2026-05-28T10:30:01.000Z"}

event: ltp
data: {"quotes":{"355010":{"last_price":23852.00,"change":127.50},"738561":{"last_price":2851.00,"change":-9.70}},"ts":"2026-05-28T10:30:02.000Z"}
```

---

### `POST /api/search/telemetry/selection`

Signal which search result was selected. Used to improve search relevance over time.

*Request Body*

```json
{
  "q": "rel",
  "symbol": "RELIANCE",
  "universalId": 738561
}
```

*Response*

```json
{ "success": true }
```

---

## 12. Error Codes

| HTTP Status | Success | Message | Likely Cause |
|-------------|---------|---------|-------------|
| 200 | `true` | — | Request succeeded |
| 400 | `false` | `tokens array is required` | Empty request body |
| 400 | `false` | `Invalid token` | Non-numeric token in path |
| 400 | `false` | `symbols query param is required` | Missing required query param |
| 400 | `false` | `At least one filter required` | Delete without filters |
| 400 | `false` | `q is required` | Missing search query |
| 401 | `false` | `Invalid API key` | Bad `x-api-key` header |
| 404 | `false` | `Instrument not found` | Token doesn't exist |
| 404 | `false` | `Symbol not found` | Symbol not in database |
| 500 | `false` | `Falcon LTP failed` | Provider API error |
| 500 | `false` | `Falcon historical data failed` | Historical data API error |
| 500 | `false` | `Batch historical failed` | Rate limit or provider error |

---

## 13. Rate Limits

| Endpoint Pattern | Limit | Window |
|-----------------|-------|--------|
| `/ltp` | 1 req | per second |
| `/quote` | 1 req | per second |
| `/ohlc` | 1 req | per second |
| `/historical` | 3 req | per second |
| `/options/chain/**` | 2 req | per second |
| `/instruments/*` | 10 req | per second |

All limits are enforced via Redis distributed locks, accurate even in multi-instance deployments.

**Caching:** Most responses are cached in Redis with short TTLs:
- LTP: 10 seconds
- Quote/OHLC: 5 seconds
- Historical: 60s (intraday) to 24h (day interval historical)
- Options Chain: 15–300 seconds
- Profile: 5 minutes
- Margins: 60 seconds
- Stats: 60 seconds

---

## 14. Appendix: Token Reference

Common instrument tokens (verify via API — these may change):

| Symbol | Exchange | Token |
|--------|----------|-------|
| RELIANCE | NSE | 738561 |
| NIFTY | NSE | 256265 |
| BANKNIFTY | NSE | 260105 |
| SBIN | NSE | 5633 |
| INFY | NSE | 408065 |
| TCS | NSE | 295321 |

**Canonical Symbol Format:**

```
{EXCHANGE}:{UNDERLYING}:{TYPE}:{EXPIRY}:{STRIKE}
```

| Instrument | Canonical Symbol |
|-----------|----------------|
| NSE RELIANCE EQ | `NSE:RELIANCE:EQ` |
| NFO NIFTY 29MAY FUT | `NFO:NIFTY:FUT:2026-05-29` |
| NFO NIFTY 29MAY 23800 CE | `NFO:NIFTY:CE:2026-05-29:23800` |
| MCX GOLD FUT | `MCX:GOLD:FUT` |
| CRYPTO BTC/USDT | `BINANCE:BTCUSDT` |

**Provider Brands:**

| Brand | Coverage |
|-------|----------|
| `falcon` | Indian equity (NSE/BSE), indices |
| `vayu` | Indian F&O (NFO), currency (CDS), commodities (MCX) |
| `atlas` | US/global stocks, forex, indices |
| `drift` | Global crypto Spot (Binance) |

---

*Powered by Vedpragya Bharat Pvt. Ltd. · vedpragya.com · marketdata.vedpragya.com*
