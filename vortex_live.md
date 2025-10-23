## WebSocket Connection for Market Data

Implementing an asynchronous WebSocket client with a binary parser for market data can be complex. We recommend using one of our official pre-built client libraries if available.

---

### WebSocket Endpoint

```
wss://wire.rupeezy.in/ws?auth_token={{access_token}}
```

---

### Connection & Subscription Limits

- **Maximum concurrent connections per access token:** `3`
- **Maximum instrument subscriptions per WebSocket:** `1000`

---

### Subscribing & Unsubscribing to Instruments

To **subscribe** or **unsubscribe** from an instrument, send a JSON-formatted message over the WebSocket (in **text mode**, not binary).

**Subscription Payload**
```json
{
  "exchange": "NSE_EQ",
  "token": 26000,
  "mode": "ltp",
  "message_type": "subscribe"
}
```

**Unsubscription Payload**
```json
{
  "exchange": "NSE_EQ",
  "token": 26000,
  "mode": "ltp",
  "message_type": "unsubscribe"
}
```

| Field         | Required | Description                                                                            |
|---------------|:--------:|----------------------------------------------------------------------------------------|
| `exchange`    | Yes      | Possible values: `NSE_EQ`, `NSE_FO`, `NSE_CUR`, `MCX_FO`                               |
| `token`       | Yes      | Security token of the scrip (can be found in the scripmaster file)                     |
| `mode`        | Yes      | Subscription mode. Possible values: `ltp`, `ohlcv`, `full`                            |
| `message_type`| Yes      | Type of message. Possible values: `subscribe`, `unsubscribe`                          |

---

### Decoding WebSocket Packets

The WebSocket sends data in **binary** (for price feeds) and **text** (for updates/postbacks) modes. Always verify the packet mode before decoding.

**Text mode:** Messages are JSON.

**Binary mode:** Price feed. Messages use **little endian** encoding and may contain multiple price quotes.

---

#### Binary Message Structure

Each binary message structure:

- A packet header.
- Indicates the number of price ticks.
- Multiple tick packets (one per instrument update).

Each price quote in binary is **preceded by 2 bytes** (int16) specifying that quote’s length.
- **Possible quote lengths:**
  - `22` bytes for `ltp` mode
  - `62` bytes for `ohlcv` mode
  - `266` bytes for `full` mode

The structure you should use to decode depends on this length.

---

### Packet Structure

| Field Name           | Data Type | Size (bytes) | Description                                                |
|----------------------|-----------|--------------|------------------------------------------------------------|
| Exchange             | string    | 10           | The exchange name                                          |
| Token                | int32     | 4            | Token representing the stock                               |
| LastTradePrice       | float64   | 8            | Last trade price                                           |
| LastTradeTime        | int32     | 4            | Time of the last trade *(optional)*                        |
| OpenPrice            | float64   | 8            | Opening price *(optional)*                                 |
| HighPrice            | float64   | 8            | Highest price today *(optional)*                           |
| LowPrice             | float64   | 8            | Lowest price today *(optional)*                            |
| ClosePrice           | float64   | 8            | Previous day's closing price *(optional)*                  |
| Volume               | int32     | 4            | Total volume traded *(optional)*                           |
| LastUpdateTime       | int32     | 4            | Time of last update *(optional)*                           |
| LastTradeQuantity    | int32     | 4            | Quantity of the last trade *(optional)*                    |
| AverageTradePrice    | float64   | 8            | Average trade price *(optional)*                           |
| TotalBuyQuantity     | int64     | 8            | Total quantity bought *(optional)*                         |
| TotalSellQuantity    | int64     | 8            | Total quantity sold *(optional)*                           |
| OpenInterest         | int32     | 4            | Open interest *(optional)*                                 |
| Depth.Buy            | object    | varies       | Buy depth (see below)                                      |
| Depth.Sell           | object    | varies       | Sell depth (see below)                                     |
| DPRHigh              | int32     | 4            | Daily price range high *(optional)*                        |
| DPRLow               | int32     | 4            | Daily price range low *(optional)*                         |

---

#### Nested Depth Structure

**Buy/Sell Depth Entry**

| Field Name | Data Type | Size (bytes) | Description               |
|------------|-----------|--------------|---------------------------|
| Price      | float64   | 8            | Price of the order        |
| Quantity   | int32     | 4            | Quantity of the order     |
| Orders     | int32     | 4            | Number of orders          |

---

### Order & Postback Messages

WebSocket delivers postbacks and other updates in **text** mode as JSON messages. For order postbacks, the message structure follows the specification in the postbacks section.


