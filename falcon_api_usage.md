# Version and API endpoint

The current major stable version of the API is 3. All requests go to it by default. It is recommended that a specific version be requested explicitly for production applications as major releases may break older implementations.

> **Note:**  
> This version is a KiteConnect backend API version and should not be confused with the specific library release version.

## Root API endpoint

```
https://api.kite.trade
```

## Requesting a particular version

To request a particular version of the API, set the HTTP header `X-Kite-version: v` where `v` is the version number, major or full (eg: `1` or `1.3` or `3`)

## Response structure

All GET and DELETE request parameters go as query parameters, and POST and PUT parameters as form-encoded (`application/x-www-form-urlencoded`) parameters, responses from the API are always JSON.

### Successful request

```
HTTP/1.1 200 OK
Content-Type: application/json

{
    "status": "success",
    "data": {}
}
```

All responses from the API server are JSON with the content-type application/json unless explicitly stated otherwise. A successful 200 OK response always has a JSON response body with a `status` key with the value `success`. The `data` key contains the full response payload.

### Failed request

```
HTTP/1.1 500 Server error
Content-Type: application/json

{
    "status": "error",
    "message": "Error message",
    "error_type": "GeneralException"
}
```

A failure response is preceded by the corresponding 40x or 50x HTTP header. The `status` key in the response envelope contains the value `error`. The `message` key contains a textual description of the error and `error_type` contains the name of the exception. There may be an optional `data` key with additional payload.

## Data types

Values in JSON responses are of types string, int, float, or bool.

Timestamp (datetime) strings in the responses are represented in the form `yyyy-mm-dd hh:mm:ss`, set under the Indian timezone (IST) — UTC+5.5 hours.

A date string is represented in the form `yyyy-mm-dd`.

## Exceptions and errors

In addition to the 40x and 50x headers, error responses come with the name of the exception generated internally by the API server. You can define corresponding exceptions in your language or library, and raise them by doing a switch on the returned exception name.

### Example

```
HTTP/1.1 500 Server error
Content-Type: application/json

{
    "status": "error",
    "message": "Error message",
    "error_type": "GeneralException"
}
```

| exception         | Description                                                                                                                                   |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| TokenException    | Preceded by a 403 header, this indicates the expiry or invalidation of an authenticated session. This can be caused by the user logging out, a natural expiry, or the user logging into another Kite instance. When you encounter this error, you should clear the user's session and re-initiate a login. |
| UserException     | Represents user account related errors                                                                                                        |
| OrderException    | Represents order related errors such placement failures, a corrupt fetch etc                                                                 |
| InputException    | Represents missing required fields, bad values for parameters etc.                                                                            |
| MarginException   | Represents insufficient funds, required for the order placement                                                                              |
| HoldingException  | Represents insufficient holdings, available to place sell order for specified instrument                                                     |
| NetworkException  | Represents a network error where the API was unable to communicate with the OMS (Order Management System)                                   |
| DataException     | Represents an internal system error where the API was unable to understand the response from the OMS to in turn respond to a request         |
| GeneralException  | Represents an unclassified error. This should only happen rarely                                                                             |

## Common HTTP error codes

| Code | Description                                                         |
|------|---------------------------------------------------------------------|
| 400  | Missing or bad request parameters or values                         |
| 403  | Session expired or invalidate. Must relogin                         |
| 404  | Request resource was not found                                      |
| 405  | Request method (GET, POST etc.) is not allowed on the requested endpoint |
| 410  | The requested resource is gone permanently                          |
| 429  | Too many requests to the API (rate limiting)                        |
| 500  | Something unexpected went wrong                                     |
| 502  | The backend OMS is down and the API is unable to communicate with it|
| 503  | Service unavailable; the API is down                                |
| 504  | Gateway timeout; the API is unreachable                             |

## API rate limit

| End-point         | Rate-limit     |
|-------------------|---------------|
| Quote             | 1 req/second  |
| Historical candle | 3 req/second  |
| Order placement   | 10 req/second |
| All other endpoints| 10 req/second|

> **Note:**  
> - There are limitations at 200 orders per minute and 10 orders per second.  
> - As a risk management measure, at Zerodha, a single user/API key will not be able to place more than 3000 orders per day. This restriction is across all segments and varieties.  
> - Rate limitations also apply for order modification where a maximum of 25 modifications are allowed per order. Post that, user has to cancel the order and place it again.

<br/>

# User

## Login flow

The login flow starts by navigating to the public Kite login endpoint.

```
https://kite.zerodha.com/connect/login?v=3&api_key=xxx
```

A successful login comes back with a `request_token` as a URL query parameter to the redirect URL registered on the developer console for that `api_key`. This `request_token`, along with a checksum (SHA-256 of api_key + request_token + api_secret) is POSTed to the token API to obtain an `access_token`, which is then used for signing all subsequent requests. In summary:

1. Navigate to the Kite Connect login page with the api_key
2. A successful login comes back with a request_token to the registered redirect URL
3. POST the request_token and checksum (SHA-256 of api_key + request_token + api_secret) to `/session/token`
4. Obtain the access_token and use that with all subsequent requests

An optional `redirect_params` param can be appended to public Kite login endpoint, that will be sent back to the redirect URL. The value is URL encoded query params string, eg: `some=X&more=Y` (eg: `https://kite.zerodha.com/connect/login?v=3&api_key=xxx&redirect_params=some%3DX%26more%3DY`).

Here's a webinar that shows the login flow and other interactions:  
**Kite Connect handshake flow**

> **Warning:**  
> Never expose your `api_secret` by embedding it in a mobile app or a client side application. Do not expose the `access_token` you obtain for a session to the public either.

| type | endpoint        | Description                               |
|------|----------------|-------------------------------------------|
| POST | /session/token | Authenticate and obtain the access_token after the login flow |
| GET  | /user/profile  | Retrieve the user profile                 |
| GET  | /user/margins/:segment | Retrieve detailed funds and margin information |
| DELETE | /session/token | Logout and invalidate the API session and access_token |

## Authentication and token exchange

Once the request_token is obtained from the login flow, it should be POSTed to `/session/token` to complete the token exchange and retrieve the access_token.

```bash
curl https://api.kite.trade/session/token \
   -H "X-Kite-Version: 3" \
   -d "api_key=xxx" \
   -d "request_token=yyy" \
   -d "checksum=zzz"
```
```json
{
    "status": "success",
    "data": {
        "user_type": "individual",
        "email": "XXXXXX",
        "user_name": "Kite Connect",
        "user_shortname": "Connect",
        "broker": "ZERODHA",
        "exchanges": [
            "NSE",
            "NFO",
            "BFO",
            "CDS",
            "BSE",
            "MCX",
            "BCD",
            "MF"
        ],
        "products": [
            "CNC",
            "NRML",
            "MIS",
            "BO",
            "CO"
        ],
        "order_types": [
            "MARKET",
            "LIMIT",
            "SL",
            "SL-M"
        ],
        "avatar_url": "abc",
        "user_id": "XX0000",
        "api_key": "XXXXXX",
        "access_token": "XXXXXX",
        "public_token": "XXXXXXXX",
        "enctoken": "XXXXXX",
        "refresh_token": "",
        "silo": "",
        "login_time": "2021-01-01 16:15:14",
        "meta": {
            "demat_consent": "physical"
        }
    }
}
```

### Request parameters

| parameter       | Description   |
|-----------------|------------------------------------|
| api_key         | The public API key                  |
| request_token   | The one-time token obtained after the login flow. This token's lifetime is only a few minutes and it is meant to be exchanged for an access_token immediately after being obtained |
| checksum        | SHA-256 hash of (api_key + request_token + api_secret) |

### Response attributes

| attribute      | Type    | Description |
|----------------|---------|-------------|
| user_id        | string  | The unique, permanent user id registered with the broker and the exchanges |
| user_name      | string  | User's real name |
| user_shortname | string  | Shortened version of the user's real name |
| email          | string  | User's email |
| user_type      | string  | User's registered role at the broker. This will be individual for all retail users |
| broker         | string  | The broker ID |
| exchanges      | string[]| Exchanges enabled for trading on the user's account |
| products       | string[]| Margin product types enabled for the user |
| order_types    | string[]| Order types enabled for the user |
| api_key        | string  | The API key for which the authentication was performed |
| access_token   | string  | The authentication token that's used with every subsequent request. Unless this is invalidated using the API, or invalidated by a master-logout from the Kite Web trading terminal, it'll expire at 6 AM on the next day (regulatory requirement) |
| public_token   | string  | A token for public session validation where requests may be exposed to the public |
| refresh_token  | string  | A token for getting long standing read permissions. This is only available to certain approved platforms |
| login_time     | string  | User's last login time |
| meta           | map     | demat_consent: empty, consent or physical |
| avatar_url     | string  | Full URL to the user's avatar (PNG image) if there's one |

## Signing requests

Once the authentication is complete, all requests should be signed with the HTTP Authorization header with `token` as the authorisation scheme, followed by a space, and then the `api_key:access_token` combination. For example:

```bash
curl -H "Authorization: token api_key:access_token"
curl -H "Authorization: token xxx:yyy"
```

## User profile

While a successful token exchange returns the full user profile, it's possible to retrieve it any point of time with the `/user/profile` API. Do note that the profile API does not return any of the tokens.

```bash
curl https://api.kite.trade/user/profile \
   -H "X-Kite-Version: 3" \
   -H "Authorization: token api_key:access_token"
```
```json
{
  "status": "success",
  "data": {
    "user_id": "AB1234",
    "user_type": "individual",
    "email": "xxxyyy@gmail.com",
    "user_name": "AxAx Bxx",
    "user_shortname": "AxAx",
    "broker": "ZERODHA",
    "exchanges": [
      "BFO",
      "MCX",
      "NSE",
      "CDS",
      "BSE",
      "BCD",
      "MF",
      "NFO"
    ],
    "products": [
      "CNC",
      "NRML",
      "MIS",
      "BO",
      "CO"
    ],
    "order_types": [
      "MARKET",
      "LIMIT",
      "SL",
      "SL-M"
    ],
    "avatar_url": null,
    "meta": {
      "demat_consent": "physical"
    }
  }
}
```

### Response attributes

| attribute      | Type    | Description |
|----------------|---------|-------------|
| user_id        | string  | The unique, permanent user id registered with the broker and the exchanges |
| user_name      | string  | User's real name |
| user_shortname | string  | Shortened version of the user's real name |
| email          | string  | User's email |
| user_type      | string  | User's registered role at the broker. This will be individual for all retail users |
| broker         | string  | The broker ID |
| exchanges      | string[]| Exchanges enabled for trading on the user's account |
| products       | string[]| Margin product types enabled for the user |
| order_types    | string[]| Order types enabled for the user |
| meta           | map     | demat_consent: empty, consent or physical |
| avatar_url     | string  | Full URL to the user's avatar (PNG image) if there's one |

## Funds and margins

A GET request to `/user/margins` returns funds, cash, and margin information for the user for equity and commodity segments.

A GET request to `/user/margins/:segment` returns funds, cash, and margin information for the user. `segment` in the URI can be either `equity` or `commodity`.

```bash
curl "https://api.kite.trade/user/margins" \
    -H "X-Kite-Version: 3" \
    -H "Authorization: token api_key:access_token"
```
```json
{
    "status": "success",
    "data": {
      "equity": {
        "enabled": true,
        "net": 99725.05000000002,
        "available": {
          "adhoc_margin": 0,
          "cash": 245431.6,
          "opening_balance": 245431.6,
          "live_balance": 99725.05000000002,
          "collateral": 0,
          "intraday_payin": 0
        },
        "utilised": {
          "debits": 145706.55,
          "exposure": 38981.25,
          "m2m_realised": 761.7,
          "m2m_unrealised": 0,
          "option_premium": 0,
          "payout": 0,
          "span": 101989,
          "holding_sales": 0,
          "turnover": 0,
          "liquid_collateral": 0,
          "stock_collateral": 0,
          "delivery": 0
        }
      },
      "commodity": {
        "enabled": true,
        "net": 100661.7,
        "available": {
          "adhoc_margin": 0,
          "cash": 100661.7,
          "opening_balance": 100661.7,
          "live_balance": 100661.7,
          "collateral": 0,
          "intraday_payin": 0
        },
        "utilised": {
          "debits": 0,
          "exposure": 0,
          "m2m_realised": 0,
          "m2m_unrealised": 0,
          "option_premium": 0,
          "payout": 0,
          "span": 0,
          "holding_sales": 0,
          "turnover": 0,
          "liquid_collateral": 0,
          "stock_collateral": 0,
          "delivery": 0
        }
      }
    }
  }
```

### Response attributes

| attribute                | Type      | Description                                                                                           |
|--------------------------|-----------|-------------------------------------------------------------------------------------------------------|
| enabled                  | bool      | Indicates whether the segment is enabled for the user                                                 |
| net                      | float64   | Net cash balance available for trading (intraday_payin + adhoc_margin + collateral)                   |
| available.cash           | float64   | Raw cash balance in the account available for trading (also includes intraday_payin)                  |
| available.opening_balance| float64   | Opening balance at the day start                                                                      |
| available.live_balance   | float64   | Current available balance                                                                             |
| available.intraday_payin | float64   | Amount that was deposited during the day                                                              |
| available.adhoc_margin   | float64   | Additional margin provided by the broker                                                              |
| available.collateral     | float64   | Margin derived from pledged stocks                                                                    |
| utilised.m2m_unrealised  | float64   | Un-booked (open) intraday profits and losses                                                          |
| utilised.m2m_realised    | float64   | Booked intraday profits and losses                                                                    |
| utilised.debits          | float64   | Sum of all utilised margins (unrealised M2M + realised M2M + SPAN + Exposure + Premium + Holding sales)|
| utilised.span            | float64   | SPAN margin blocked for all open F&O positions                                                        |
| utilised.option_premium  | float64   | Value of options premium received by shorting                                                         |
| utilised.holding_sales   | float64   | Value of holdings sold during the day                                                                 |
| utilised.exposure        | float64   | Exposure margin blocked for all open F&O positions                                                    |
| utilised.liquid_collateral | float64 | Margin utilised against pledged liquidbees ETFs and liquid mutual funds                               |
| utilised.delivery        | float64   | Margin blocked when you sell securities (20% of the value of stocks sold) from your demat or T1 holdings|
| utilised.stock_collateral| float64   | Margin utilised against pledged stocks/ETFs                                                           |
| utilised.turnover        | float64   | Utilised portion of the maximum turnover limit (only applicable to certain clients)                   |
| utilised.payout          | float64   | Funds paid out or withdrawn to bank account during the day                                            |

## Logout

This call invalidates the access_token and destroys the API session. After this, the user should be sent through a new login flow before further interactions. This does not log the user out of the official Kite web or mobile applications.

```bash
curl --request DELETE \
  -H "X-Kite-Version: 3" \
  "https://api.kite.trade/session/token?api_key=xxx&access_token=yyy"
```
```json
{
  "status": "success",
  "data": true
}
```

# Market quotes and instruments

| type | endpoint               | Description                                      |
|------|-----------------------|--------------------------------------------------|
| GET  | /instruments          | Retrieve the CSV dump of all tradable instruments|
| GET  | /instruments/:exchange| Retrieve the CSV dump of instruments in the particular exchange |
| GET  | /quote                | Retrieve full market quotes for one or more instruments          |
| GET  | /quote/ohlc           | Retrieve OHLC quotes for one or more instruments |
| GET  | /quote/ltp            | Retrieve LTP quotes for one or more instruments  |

## Instruments

Between multiple exchanges and segments, there are tens of thousands of different kinds of instruments that trade. Any application that facilitates trading needs to have a master list of these instruments. The instruments API provides a consolidated, import-ready CSV list of instruments available for trading.

### Retrieving the full instrument list

Unlike the rest of the calls that return JSON, the instrument list API returns a gzipped CSV dump of instruments across all exchanges that can be imported into a database. The dump is generated once everyday and hence last_price is not real time.

```bash
curl "https://api.kite.trade/instruments" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token api_key:access_token"
```

```
instrument_token, exchange_token, tradingsymbol, name, last_price, expiry, strike, tick_size, lot_size, instrument_type, segment, exchange
408065,1594,INFY,INFOSYS,0,,,0.05,1,EQ,NSE,NSE
5720322,22345,NIFTY15DECFUT,,78.0,2015-12-31,,0.05,75,FUT,NFO-FUT,NFO
5720578,22346,NIFTY159500CE,,23.0,2015-12-31,9500,0.05,75,CE,NFO-OPT,NFO
645639,SILVER15DECFUT,,7800.0,2015-12-31,,1,1,FUT,MCX,MCX
```

#### CSV response columns

| column           | Type    | Description                                                               |
|------------------|---------|---------------------------------------------------------------------------|
| instrument_token | string  | Numerical identifier used for subscribing to live market quotes with the WebSocket API.|
| exchange_token   | string  | The numerical identifier issued by the exchange representing the instrument.|
| tradingsymbol    | string  | Exchange tradingsymbol of the instrument                                 |
| name             | string  | Name of the company (for equity instruments)                             |
| last_price       | float64 | Last traded market price                                                  |
| expiry           | string  | Expiry date (for derivatives)                                             |
| strike           | float64 | Strike (for options)                                                      |
| tick_size        | float64 | Value of a single price tick                                              |
| lot_size         | int64   | Quantity of a single lot                                                  |
| instrument_type  | string  | EQ, FUT, CE, PE                                                           |
| segment          | string  | Segment the instrument belongs to                                         |
| exchange         | string  | Exchange                                                                 |

> **Warning:**  
> The instrument list API returns large amounts of data. It's best to request it once a day (ideally at around 08:30 AM) and store in a database at your end.

> **Note:**  
> For storage, it is recommended to use a combination of exchange and tradingsymbol as the unique key, not the numeric instrument token. Exchanges may reuse instrument tokens for different derivative instruments after each expiry.

## Market quotes

The market quotes APIs enable you to retrieve market data snapshots of various instruments. These are snapshots gathered from the exchanges at the time of the request. For realtime streaming market quotes, use the WebSocket API.

### Retrieving full market quotes

This API returns the complete market data snapshot of up to 500 instruments in one go. It includes the quantity, OHLC, and Open Interest fields, and the complete bid/ask market depth amongst others.

Instruments are identified by the exchange:tradingsymbol combination and are passed as values to the query parameter `i` which is repeated for every instrument. If there is no data available for a given key, the key will be absent from the response. The existence of all the instrument keys in the response map should be checked before to accessing them.

```bash
curl "https://api.kite.trade/quote?i=NSE:INFY" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token api_key:access_token"
```
```json
{
    "status": "success",
    "data": {
      "NSE:INFY": {
        "instrument_token": 408065,
        "timestamp": "2021-06-08 15:45:56",
        "last_trade_time": "2021-06-08 15:45:52",
        "last_price": 1412.95,
        "last_quantity": 5,
        "buy_quantity": 0,
        "sell_quantity": 5191,
        "volume": 7360198,
        "average_price": 1412.47,
        "oi": 0,
        "oi_day_high": 0,
        "oi_day_low": 0,
        "net_change": 0,
        "lower_circuit_limit": 1250.7,
        "upper_circuit_limit": 1528.6,
        "ohlc": {
          "open": 1396,
          "high": 1421.75,
          "low": 1395.55,
          "close": 1389.65
        },
        "depth": {
          "buy": [
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            }
          ],
          "sell": [
            {
              "price": 1412.95,
              "quantity": 5191,
              "orders": 13
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            },
            {
              "price": 0,
              "quantity": 0,
              "orders": 0
            }
          ]
        }
      }
    }
  }
```

#### Response attributes

| attribute                      | Type      | Description                                                         |
|--------------------------------|-----------|---------------------------------------------------------------------|
| instrument_token               | uint32    | The numerical identifier issued by the exchange representing the instrument.|
| timestamp                      | string    | The exchange timestamp of the quote packet                           |
| last_trade_time                | null, string | Last trade timestamp                                             |
| last_price                     | float64   | Last traded market price                                            |
| volume                         | int64     | Volume traded today                                                 |
| average_price                  | float64   | The volume weighted average price of a stock at a given time during the day?|
| buy_quantity                   | int64     | Total quantity of buy orders pending at the exchange                |
| sell_quantity                  | int64     | Total quantity of sell orders pending at the exchange               |
| open_interest                  | float64   | Total number of outstanding contracts held by market participants exchange-wide (only F&O)|
| last_quantity                  | int64     | Last traded quantity                                                |
| ohlc.open                      | float64   | Price at market opening                                             |
| ohlc.high                      | float64   | Highest price today                                                 |
| ohlc.low                       | float64   | Lowest price today                                                  |
| ohlc.close                     | float64   | Closing price of the instrument from the last trading day            |
| net_change                     | float64   | The absolute change from yesterday's close to last traded price     |
| lower_circuit_limit            | float64   | The current lower circuit limit                                     |
| upper_circuit_limit            | float64   | The current upper circuit limit                                     |
| oi                             | float64   | The Open Interest for a futures or options contract                 |
| oi_day_high                    | float64   | The highest Open Interest recorded during the day                    |
| oi_day_low                     | float64   | The lowest Open Interest recorded during the day                     |
| depth.buy[].price              | float64   | Price at which the depth stands                                     |
| depth.buy[].orders             | int64     | Number of open BUY (bid) orders at the price                         |
| depth.buy[].quantity           | int64     | Net quantity from the pending orders                                 |
| depth.sell[].price             | float64   | Price at which the depth stands                                     |
| depth.sell[].orders            | int64     | Number of open SELL (ask) orders at the price                        |
| depth.sell[].quantity          | int64     | Net quantity from the pending orders                                 |

### Retrieving OHLC quotes

This API returns the OHLC + LTP snapshots of up to 1000 instruments in one go.

Instruments are identified by the exchange:tradingsymbol combination and are passed as values to the query parameter `i` which is repeated for every instrument. If there is no data available for a given key, the key will be absent from the response. The existence of all the instrument keys in the response map should be checked before to accessing them.

```bash
curl "https://api.kite.trade/quote/ohlc?i=NSE:INFY&i=BSE:SENSEX&i=NSE:NIFTY+50" \
    -H "X-Kite-Version: 3" \
    -H "Authorization: token api_key:access_token"
```
```json
{
    "status": "success",
    "data": {
        "NSE:INFY": {
            "instrument_token": 408065,
            "last_price": 1075,
            "ohlc": {
                "open": 1085.8,
                "high": 1085.9,
                "low": 1070.9,
                "close": 1075.8
            }
        }
    }
}
```

#### Response attributes

| attribute                      | Type      | Description                     |
|--------------------------------|-----------|---------------------------------|
| instrument_token               | uint32    | The numerical identifier issued by the exchange representing the instrument.|
| last_price                     | float64   | Last traded market price        |
| ohlc.open                      | float64   | Price at market opening         |
| ohlc.high                      | float64   | Highest price today             |
| ohlc.low                       | float64   | Lowest price today              |
| ohlc.close                     | float64   | Closing price of the instrument from the last trading day |

> **Note:**  
> Always check for the existence of a particular key you've requested (eg: NSE:INFY) in the response. If there's no data for the particular instrument or if it has expired, the key will be missing from the response.

### Retrieving LTP quotes

This API returns the LTPs of up to 1000 instruments in one go.

Instruments are identified by the exchange:tradingsymbol combination and are passed as values to the query parameter `i` which is repeated for every instrument. If there is no data available for a given key, the key will be absent from the response. The existence of all the instrument keys in the response map should be checked before to accessing them.

```bash
curl "https://api.kite.trade/quote/ltp?i=NSE:INFY&i=BSE:SENSEX&i=NSE:NIFTY+50" \
    -H "X-Kite-Version: 3" \
    -H "Authorization: token api_key:access_token"
```
```json
{
    "status": "success",
    "data": {
        "NSE:INFY": {
            "instrument_token": 408065,
            "last_price": 1074.35
        }
    }
}
```

#### Response attributes

| attribute          | Type      | Description                     |
|--------------------|-----------|---------------------------------|
| instrument_token   | uint32    | The numerical identifier issued by the exchange representing the instrument.|
| last_price         | float64   | Last traded market price        |

> **Note:**  
> Always check for the existence of a particular key you've requested (eg: NSE:INFY) in the response. If there's no data for the particular instrument or if it has expired, the key will be absent from the response.

### Limits

| attribute           | number of instruments |
|---------------------|----------------------|
| /quote              | 500                  |
| /quote/ohlc         | 1000                 |
| /quote/ltp          | 1000                 |

# WebSocket streaming

The WebSocket API is the most efficient (speed, latency, resource consumption, and bandwidth) way to receive quotes for instruments across all exchanges during live market hours. A quote consists of fields such as open, high, low, close, last traded price, 5 levels of bid/offer market depth data etc.

In addition, the text messages, alerts, and order updates (the same as the ones available as Postbacks) are also streamed. As the name suggests, the API uses WebSocket protocol to establish a single long standing TCP connection after an HTTP handshake to receive streaming quotes. To connect to the Kite WebSocket API, you will need a WebSocket client library in your choice of programming language.

You can subscribe for up to 3000 instruments on a single WebSocket connection and receive live quotes for them. Single API key can have up to 3 websocket connections.

> **Note:**  
> Implementing an asynchronous WebSocket client with a binary parser for the market data structure may be a complex task. We recommend using one of our pre-built client libraries.

## Connecting to the WebSocket endpoint

```js
// Javascript example.
var ws = new WebSocket("wss://ws.kite.trade?api_key=xxx&access_token=xxxx");
```

The WebSocket endpoint is `wss://ws.kite.trade`. To establish a connection, you have to pass two query parameters, `api_key` and `access_token`.

## Request structure

```js
// Subscribe to quotes for INFY (408065) and TATAMOTORS (884737)
var message = { a: "subscribe", v: [408065, 884737] };
ws.send(JSON.stringify(message));
```

Requests are simple JSON messages with two parameters, `a` (action) and `v` (value). Following are the available actions and possible values. Many values are arrays, for instance, array of `instrument_token` that can be passed to subscribe to multiple instruments at once.

| a         | v                                 |
|-----------|-----------------------------------|
| subscribe | [instrument_token ... ]           |
| unsubscribe | [instrument_token ... ]         |
| mode      | [mode, [instrument_token ... ]]   |

```js
// Set INFY (408065) to 'full' mode to receive market depth as well.
message = { a: "mode", v: ["full", [408065]] };
ws.send(JSON.stringify(message));

// Set TATAMOTORS (884737) to 'ltp' to only receive the LTP.
message = { a: "mode", v: ["ltp", [884737]] };
ws.send(JSON.stringify(message));
```

## Modes

There are three different modes in which quote packets are streamed.

| mode  | Description                             |
|-------|-----------------------------------------|
| ltp   | LTP. Packet contains only the last traded price (8 bytes). |
| quote | Quote. Packet contains several fields excluding market depth (44 bytes). |
| full  | Full. Packet contains several fields including market depth (184 bytes). |

> **Note:**  
> Always check the type of an incoming WebSocket messages. Market data is always binary and Postbacks and other updates are always text.

If there is no data to be streamed over an open WebSocket connection, the API will send a 1 byte "heartbeat" every couple seconds to keep the connection alive. This can be safely ignored.

## Binary market data

WebSocket supports two types of messages, binary and text.

Quotes delivered via the API are always binary messages. These have to be read as bytes and then type-casted into appropriate quote data structures. On the other hand, all requests you send to the API are JSON messages, and the API may also respond with non-quote, non-binary JSON messages, which are described in the next section.

For quote subscriptions, instruments are identified with their corresponding numerical `instrument_token` obtained from the instrument list API.

### Message structure

Each binary message (array of 0 to n individual bytes) -- or frame in WebSocket terminology -- received via the WebSocket is a combination of one or more quote packets for one or more instruments. The message structure is as follows.

**WebSocket API message structure**

| Segment | Description                                                                                  |
|---------|---------------------------------------------------------------------------------------------|
| A       | The first two bytes ([0 - 2] -- SHORT or int16) represent the number of packets in the message. |
| B       | The next two bytes ([2 - 4] -- SHORT or int16) represent the length (number of bytes) of the first packet. |
| C       | The next series of bytes ([4 - 4+B]) is the quote packet.                                    |
| D       | The next two bytes ([4+B - 4+B+2] -- SHORT or int16) represent the length (number of bytes) of the second packet. |
| C       | The next series of bytes ([4+B+2 - 4+B+2+D]) is the next quote packet.                        |

### Quote packet structure

Each individual packet extracted from the message, based on the structure shown in the previous section, can be cast into a data structure as follows. All prices are in paise. For currencies, the int32 price values should be divided by 10000000 to obtain four decimal places. For everything else, the price values should be divided by 100.

| Bytes           | Type    | Field                         |
|-----------------|---------|-------------------------------|
| 0 - 4           | int32   | instrument_token              |
| 4 - 8           | int32   | Last traded price (If mode is ltp, the packet ends here)|
| 8 - 12          | int32   | Last traded quantity          |
| 12 - 16         | int32   | Average traded price          |
| 16 - 20         | int32   | Volume traded for the day     |
| 20 - 24         | int32   | Total buy quantity            |
| 24 - 28         | int32   | Total sell quantity           |
| 28 - 32         | int32   | Open price of the day         |
| 32 - 36         | int32   | High price of the day         |
| 36 - 40         | int32   | Low price of the day          |
| 40 - 44         | int32   | Close price (If mode is quote, the packet ends here)|
| 44 - 48         | int32   | Last traded timestamp         |
| 48 - 52         | int32   | Open Interest                 |
| 52 - 56         | int32   | Open Interest Day High        |
| 56 - 60         | int32   | Open Interest Day Low         |
| 60 - 64         | int32   | Exchange timestamp            |
| 64 - 184        | []byte  | Market depth entries          |

### Index packet structure

The packet structure for indices such as NIFTY 50 and SENSEX differ from that of tradeable instruments. They have fewer fields.

| Bytes   | Type    | Field           |
|---------|---------|-----------------|
| 0 - 4   | int32   | Token           |
| 4 - 8   | int32   | Last traded price|
| 8 - 12  | int32   | High of the day |
| 12 - 16 | int32   | Low of the day  |
| 16 - 20 | int32   | Open of the day |
| 20 - 24 | int32   | Close of the day|
| 24 - 28 | int32   | Price change (If mode is quote, the packet ends here)|
| 28 - 32 | int32   | Exchange timestamp|

### Market depth structure

Each market depth entry is a combination of 3 fields: `quantity` (int32), `price` (int32), `orders` (int16) and there is a 2 byte padding at the end (which should be skipped) totalling to 12 bytes. There are ten entries in succession—five [64 - 124] bid entries and five [124 - 184] offer entries.

## Postbacks and non-binary updates

Apart from binary market data, the WebSocket stream delivers postbacks and other updates in the text mode. These messages are JSON encoded and should be parsed on receipt. For order Postbacks, the payload is contained in the `data` key and has the same structure described in the Postbacks section.

### Message structure

```json
{
  "type": "order",
  "data": {}
}
```

### Message types

| type    | Description                                                                        |
|---------|------------------------------------------------------------------------------------|
| order   | Order Postback. The data field will contain the full order Postback payload         |
| error   | Error responses. The data field contain the error string                            |
| message | Messages and alerts from the broker. The data field will contain the message string |

# Historical candle data

The historical data API provides archived data (up to date as of the time of access) for instruments across various exchanges spanning back several years. A historical record is presented in the form of a candle (Timestamp, Open, High, Low, Close, Volume, OI), and the data is available in several intervals—minute, 3 minutes, 5 minutes, hourly ... daily.

| type | endpoint | Description                                                 |
|------|--------------------------------------------------------------|--------------------------------------|
| GET  | /instruments/historical/:instrument_token/:interval | Retrieve historical candle records for a given instrument.|

## URI parameters

| parameter          | Description                                         |
|--------------------|-----------------------------------------------------|
| :instrument_token  | Identifier for the instrument whose historical records you want to fetch. This is obtained with the instrument list API. |
| :interval          | The candle record interval. Possible values are:    |
|                    | · minute                                            |
|                    | · day                                               |
|                    | · 3minute                                           |
|                    | · 5minute                                           |
|                    | · 10minute                                          |
|                    | · 15minute                                          |
|                    | · 30minute                                          |
|                    | · 60minute                                          |

## Request parameters

| parameter   | Description                                                                              |
|-------------|------------------------------------------------------------------------------------------|
| from        | yyyy-mm-dd hh:mm:ss formatted date indicating the start date of records                  |
| to          | yyyy-mm-dd hh:mm:ss formatted date indicating the end date of records                    |
| continuous  | Accepts 0 or 1. Pass 1 to get continuous data                                            |
| oi          | Accepts 0 or 1. Pass 1 to get OI data                                                    |

## Response structure

The response is an array of records, where each record in turn is an array of the following values — `[timestamp, open, high, low, close, volume]`.

> **Note:**  
> It is possible to retrieve candles for small time intervals by making the from and to calls granular. For instance `from = 2017-01-01 09:15:00` and `to = 2017-01-01 09:30:00` to fetch candles for just 15 minutes between those timestamps.

## Continuous data

It's important to note that the exchanges flush the `instrument_token` for futures and options contracts for every expiry. For instance, NIFTYJAN18FUT and NIFTYFEB18FUT will have different instrument tokens although their underlying contract is the same. The instrument master API only returns instrument_tokens for contracts that are live. It is not possible to retrieve instrument_tokens for expired contracts from the API, unless you regularly download and cache them.

This is where continuous API comes in which works for NFO and MCX futures contracts. Given a live contract's instrument_token, the API will return day candle records for the same instrument's expired contracts. For instance, assuming the current month is January and you pass NIFTYJAN18FUT's instrument_token along with continuous=1, you can fetch day candles for December, November ... contracts by simply changing the from and to dates.

### Examples

```
# Fetch minute candles for NSE-ACC.
# This will return several days of minute data ending today.
# The time of request is assumed to be to be 01:30 PM, 1 Jan 2016,
# which is reflected in the latest (last) record.

# The data has been truncated with ... in the example responses.

curl "https://api.kite.trade/instruments/historical/5633/minute?from=2017-12-15+09:15:00&to=2017-12-15+09:20:00"
    -H "X-Kite-Version: 3" \
    -H "Authorization: token api_key:access_token" \
```

```json
{
  "status": "success",
  "data": {
    "candles": [
      [
        "2017-12-15T09:15:00+0530",
        1704.5,
        1705,
        1699.25,
        1702.8,
        2499
      ],
      [
        "2017-12-15T09:16:00+0530",
        1702,
        1702,
        1698.15,
        1698.15,
        1271
      ],
      [
        "2017-12-15T09:17:00+0530",
        1698.15,
        1700.25,
        1698,
        1699.25,
        831
      ],
      [
        "2017-12-15T09:18:00+0530",
        1700,
        1700,
        1698.3,
        1699,
        771
      ],
      [
        "2017-12-15T09:19:00+0530",
        1699,
        1700,
        1698.1,
        1699.8,
        543
      ],
      [
        "2017-12-15T09:20:00+0530",
        1699.8,
        1700,
        1696.55,
        1696.9,
        802
      ]
    ]
  }
}
```

### OI Data

```
# Fetch minute candles for NIFTY19DECFUT for five minutes with OI data
curl "https://api.kite.trade/instruments/historical/12517890/minute?from=2019-12-04%2009:15:00&to=2019-12-04%2009:20:00&oi=1" \
     -H 'X-Kite-Version: 3' \
     -H 'Authorization: token api_key:access_token'
```
```json
{
  "status": "success",
  "data": {
    "candles": [
      [
        "2019-12-04T09:15:00+0530",
        12009.9,
        12019.35,
        12001.25,
        12001.5,
        163275,
        13667775
      ],
      [
        "2019-12-04T09:16:00+0530",
        12001,
        12003,
        11998.25,
        12001,
        105750,
        13667775
      ],
      [
        "2019-12-04T09:17:00+0530",
        12001,
        12001,
        11995.1,
        11998.55,
        48450,
        13758000
      ],
      [
        "2019-12-04T09:18:00+0530",
        11997.8,
        12002,
        11996.25,
        12001.55,
        52875,
        13758000
      ],
      [
        "2019-12-04T09:19:00+0530",
        12002.35,
        12007,
        12001.45,
        12007,
        52200,
        13758000
      ],
      [
        "2019-12-04T09:20:00+0530",
        12006.95,
        12009.25,
        11999.6,
        11999.6,
        65325,
        13777050
      ]
    ]
  }
}
```

