# Vortex API Usage Guide

## Root Endpoint

```
https://vortex-api.rupeezy.in/v2
```

---

## Required Headers

| Header Name     | Value                                                                                           |
|-----------------|------------------------------------------------------------------------------------------------|
| `x-api-key`     | API key received after registration (required for all APIs).                                   |
| `Authorization` | Bearer Access token received after exchanging auth token. Example: `Bearer exjy........` (required for all APIs except login APIs). |

---

## Rate Limits

- Rate limits for individual endpoints are mentioned with each endpoint.
- **Hard limit:** 50,000 API requests per day.

---

## Common Error Codes

| HTTP Status | Meaning                                                                                                |
|-------------|---------------------------------------------------------------------------------------------------------|
| 401         | Either `x-api-key` or `Authorization` header have incorrect values, or you are not allowed access      |
| 404         | Invalid endpoint                                                                                       |
| 429         | Rate limit exceeded                                                                                    |
| 5xx         | Internal server error                                                                                  |

---

## Authentication Steps

### 1. Login Flow

Navigate to:  
```
https://flow.rupeezy.in?applicationId=<YOUR_APPLICATION_ID>
```
- The login screen appears for your user.
- Only the user(s) whitelisted during application setup can login.
- After verification and consent, the user is redirected to your application's callback URL.

### 2. Obtain Auth Parameter

- The callback URL will include an `auth` query parameter.
- Extract this `auth` value for the next step.

### 3. Create Session to Get Access Token

**Request Body:**
```json
{
  "checksum": "<checksum>",
  "applicationId": "<YOUR_APPLICATION_ID>",
  "token": "<auth_token>"
}
```

**Fields:**

| Key           | Description                                                    |
|---------------|----------------------------------------------------------------|
| `checksum`    | SHA-256 hash of string: `"application_id" + "auth_token" + "x-api-key"` |
| `applicationId`| Your application ID                                           |
| `token`        | The `auth` parameter from step 2                              |

**Example Successful Response:**
```json
{
  "status": "success",
  "data": {
    "access_token": "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAi.......",
    "user_name": "JOHN DOE",
    "login_time": "2023-Mar-29 13:10:50",
    "email": "JOHN.DOE@GMAIL.COM",
    "mobile": "9999999999",
    "exchanges": ["NSE_EQ", "NSE_FO", "MCX_FO", "NSE_CUR"],
    "product_types": ["INTRADAY", "DELIVERY", "MTF"],
    "others": { "userCode": "NXAAE", "POA": 2 },
    "user_id": "XX9999",
    "tradingActive": true
  }
}
```

- Use the `access_token` from above for all other API requests.  
  Example header:
  ```
  Authorization: Bearer eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAi....
  ```

---

## Instrument List

### Download Instrument List (CSV)

| Method        | Endpoint                                         | Use Case                                            | Rate Limit |
|---------------|--------------------------------------------------|-----------------------------------------------------|------------|
| File Download | https://static.rupeezy.in/master.csv             | Download CSV of all instruments in NSE & BSE        | N/A        |
| GET           | `{{base_url}}/data/instruments`                  | Fetch all instruments                               | 1/sec      |

- The CSV file is refreshed daily (available after 8:30 AM). Always download latest before each session.

#### CSV Fields

| Field             | Description                                                   |
|-------------------|--------------------------------------------------------------|
| `token`           | Token assigned to the scrip                                  |
| `exchange`        | Exchange (values: NSE_EQ, NSE_FO, NSE_CUR, MCX_FO)           |
| `symbol`          | Symbol of the scrip                                          |
| `instrument_name` | Type of instrument                                           |
| `expiry_date`     | Expiry date of the option (YYYYMMDD)                         |
| `option_type`     | Option type (CE/PE)                                          |
| `strike_price`    | Strike price (in rupees)                                     |
| `tick`            | Tick size                                                    |
| `lot_size`        | Lot size                                                     |

---

## Data APIs

### Quotes Endpoint

| Method | Endpoint                                                         | Use Case                        | Rate Limit |
|--------|------------------------------------------------------------------|----------------------------------|------------|
| GET    | `{{base_url}}/data/quotes?q=exchange-token&mode=mode`            | Fetch quotes of up to 1000 scrips| 1/sec      |
| GET    | `{{base_url}}/data/history?exchange={exchange}&token={token}&to={to}&from={from}&resolution={resolution}` | Fetch minute-level candles        | 1/sec      |

---

### Fetch Price Quotes

**Endpoint:**
```
{{base_url}}/data/quotes?q=exchange-token&mode=mode
```

**Query Parameters:**

| Param | Description                                                                                   |
|-------|----------------------------------------------------------------------------------------------|
| q     | List of instrument `exchange-token` pairs. Example: `q=NSE_EQ-22&q=NSE_FO-135938`            |
| mode  | Type of quote needed. Allowed: `full`, `ohlc`, `ltp`                                         |

**Note:**  
- Some instrument identifiers may have no data; missing in the response.
- Order of output may not match input.

**Example Response:**
```json
{
  "status": "success",
  "data": {
    "NSE_EQ-22": {
      "last_trade_time": 1681122520,
      "last_update_time": 1681122520,
      "last_trade_price": 1740.95,
      "volume": 407043,
      "average_trade_price": 1736.52,
      "total_buy_quantity": 586,
      "open_price": 1718,
      "high_price": 1915,
      "low_price": 1566.85,
      "close_price": 1712,
      "depth": {
        "buy": [
          { "price": 1740.95, "quantity": 586 },
          {}, {}, {}, {}
        ],
        "sell": [{},{},{},{},{}]
      },
      "dpr_high": 188320,
      "dpr_low": 154080
    },
    "NSE_EQ-26000": {
      "last_trade_time": 316111421,
      "last_update_time": 1681120911,
      "last_trade_price": 17624.05,
      "total_buy_quantity": 7738434276633480,
      "open_price": 17634.9,
      "high_price": 17694.1,
      "low_price": 17597.95,
      "close_price": 17599.15,
      "depth": { "buy": [{},{},{},{},{}], "sell": [{},{},{},{},{}] }
    },
    "NSE_FO-135938": {
      "last_trade_time": 1681120758,
      "last_update_time": 1681120758,
      "last_trade_price": 104.1,
      "volume": 23700,
      "average_trade_price": 103.33,
      "total_buy_quantity": 19500,
      "total_sell_quantity": 12450,
      "open_interest": 15450,
      "open_price": 100.15,
      "high_price": 299.85,
      "low_price": 0.05,
      "close_price": 99.8,
      "depth": {
        "buy": [
          { "price": 102.15, "quantity": 150, "orders": 1 },
          { "price": 102.1,  "quantity": 150, "orders": 1 },
          { "price": 102.05, "quantity": 150, "orders": 1 },
          { "price": 96.5,   "quantity": 150, "orders": 1 },
          { "price": 87,     "quantity": 4500, "orders": 1 }
        ],
        "sell": [
          { "price": 106.55, "quantity": 150 },
          { "price": 106.6,  "quantity": 150, "orders": 1 },
          { "price": 106.65, "quantity": 300, "orders": 2 },
          { "price": 107.75, "quantity": 150, "orders": 1 },
          { "price": 111.8,  "quantity": 150, "orders": 1 }
        ]
      },
      "dpr_high": 28380,
      "dpr_low": 5
    }
  }
}
```

---

### Fetch Historical Candle Data

**Endpoint:**
```
{{base_url}}/data/history?exchange={exchange}&token={token}&to={to}&from={from}&resolution={resolution}
```

**Parameters:**

| Param      | Description                                                                      |
|------------|----------------------------------------------------------------------------------|
| exchange   | Exchange (NSE_EQ, NSE_FO, NSE_CUR, MCX_FO)                                       |
| token      | Token assigned to the instrument                                                 |
| from       | Unix timestamp (seconds) - starting time                                         |
| to         | Unix timestamp (seconds) - ending time                                           |
| resolution | Candle resolution. Minute: [1,2,3,4,5,10,15,30,45,60,120,180,240], or [1D,1W,1M] |

**Example Response:**
```json
{
  "s": "ok",
  "t": [1683540900, 1683537300, 1683299700, ...],
  "c": [1765.7, 1766.7, 1765.9, ...],
  "o": [1765.9, 1760.65, 1766.55, ...],
  "h": [1765.95, 1769.35, 1766.85, ...],
  "l": [1764.7, 1760.65, 1765, ...],
  "v": [850, 3625, 3910, ...]
}
```

| Field | Description                                             |
|-------|--------------------------------------------------------|
| `t`   | Array of timestamps (beginning of each candle, unix ts)|
| `o`   | Array of open prices                                   |
| `h`   | Array of high prices                                   |
| `l`   | Array of low prices                                    |
| `c`   | Array of close prices                                  |
| `v`   | Array of volumes                                       |

---

## Integration Debug & Verification Endpoints (Server)

These are server-side helper endpoints to verify your Vayu ↔ Vortex integration in development and during ops. They do not belong to the Vortex public API; they are provided by this service.

### Health

- Method: GET
- Endpoint: `/api/stock/vayu/health`
- Returns provider reachability and runtime status (auth, http, ws flags)

Example:
```bash
curl "$BASE/api/stock/vayu/health"
```

### Resolve Exchanges (Debug)

- Method: GET
- Endpoint: `/api/stock/vayu/debug/resolve?tokens=738561,135938`
- Returns per-token exchange with source attribution.

Example:
```bash
curl "$BASE/api/stock/vayu/debug/resolve?tokens=738561,135938"
```

Response shape:
```json
{
  "success": true,
  "data": [
    { "token": "738561", "exchange": "NSE_EQ", "source": "vortex_instruments" },
    { "token": "135938", "exchange": "NSE_FO", "source": "instrument_mappings" }
  ]
}
```

### Build Quotes Query (Debug)

- Method: GET
- Endpoint: `/api/stock/vayu/debug/build-q?tokens=738561,135938&mode=ltp|ohlc|full`
- Returns `pairs`, constructed quotes URL path, and summary stats.

Example:
```bash
curl "$BASE/api/stock/vayu/debug/build-q?tokens=738561,135938&mode=ltp"
```

Response shape:
```json
{
  "success": true,
  "pairs": ["NSE_EQ-738561", "NSE_FO-135938"],
  "url": "/data/quotes?q=NSE_EQ-738561&q=NSE_FO-135938&mode=ltp",
  "stats": { "requested": 2, "included": 2, "unresolved": 0 }
}
```

### LTP by Pairs (Authoritative)

- Method: GET
- Endpoint: `/api/stock/vayu/ltp?q=EXCHANGE-TOKEN`

Example:
```bash
curl "$BASE/api/stock/vayu/ltp?q=NSE_EQ-22&q=NSE_FO-135938"
```

### LTP by Instruments (Resolution Path)

- Method: POST
- Endpoint: `/api/stock/vayu/ltp`
- Body: `{ "instruments": [22, 135938, 26000] }`
- Exchange is resolved using: vortex_instruments → instrument_mappings(provider=vortex) → instruments.

Example:
```bash
curl -X POST "$BASE/api/stock/vayu/ltp" -H 'Content-Type: application/json' \
  -d '{ "instruments": [22, 135938, 26000] }'
```

Note:
- Tokens without a resolvable exchange are returned as `{ last_price: null }` (they are not defaulted to `NSE_EQ`).

