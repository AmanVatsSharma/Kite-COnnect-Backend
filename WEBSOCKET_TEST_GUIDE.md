# WebSocket Market Data Test Guide

## Quick Test

This guide shows you how to test the WebSocket connection to receive real-time market data.

## Prerequisites

1. **Install socket.io-client**:
   ```bash
   npm install socket.io-client
   ```

2. **Get your API key** (create one via admin panel or database)

## Running the Test

### Basic Test

```bash
# Test with production server (HTTPS/WSS)
SERVER_URL=https://marketdata.vedpragya.com node test-websocket.js your-api-key-here

# Test locally (HTTP/WS) - only for development
node test-websocket.js your-api-key-here
```

### Expected Output

```
====================================
Market Data WebSocket Test Client
====================================
Server: https://marketdata.vedpragya.com/market-data
API Key: your-api-...

Connecting to WebSocket...
✅ Connected successfully!
Socket ID: AbC123

📡 Subscribing to instruments...
Subscribed to:
  - Nifty 50 (token: 26000)
  - Bank Nifty (token: 11536)
  - Reliance (token: 2881)

Waiting for market data...

📥 Server confirmation: Connected to market data stream

✅ Subscription confirmed!
   Instruments: 26000, 11536, 2881
   Mode: ltp

💰 Market Data Received:
   Token: 26000
   Price: 25870.3
   Time: 2024-01-01T12:00:00.000Z

💰 Market Data Received:
   Token: 11536
   Price: 46152.4
   Time: 2024-01-01T12:00:01.000Z
```

## Creating a Simple HTML Test Page

Create a file `test.html`:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Market Data Test</title>
    <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
</head>
<body>
    <h1>Market Data WebSocket Test</h1>
    
    <div>
        <input type="text" id="apiKey" placeholder="Enter API Key" />
        <button onclick="connect()">Connect</button>
        <button onclick="disconnect()">Disconnect</button>
    </div>
    
    <div id="status"></div>
    <div id="data"></div>
    
    <script>
        let socket;
        
        function connect() {
            const apiKey = document.getElementById('apiKey').value;
            if (!apiKey) {
                alert('Please enter API Key');
                return;
            }
            
            document.getElementById('status').innerHTML = 'Connecting...';
            
            socket = io('ws://localhost:3000/market-data', {
                extraHeaders: {
                    'x-api-key': apiKey
                }
            });
            
            socket.on('connect', () => {
                document.getElementById('status').innerHTML = '✅ Connected!';
                
                // Subscribe to instruments
                socket.emit('subscribe_instruments', {
                    instruments: [26000, 11536, 2881],
                    mode: 'ltp'
                });
            });
            
            socket.on('market_data', (data) => {
                const div = document.createElement('div');
                div.innerHTML = `Token: ${data.instrumentToken}, Price: ${data.data.last_price}`;
                document.getElementById('data').appendChild(div);
            });
            
            socket.on('error', (err) => {
                document.getElementById('status').innerHTML = '❌ Error: ' + err.message;
            });
            
            socket.on('connected', (data) => {
                console.log('Server confirmation:', data);
            });
        }
        
        function disconnect() {
            if (socket) {
                socket.disconnect();
                document.getElementById('status').innerHTML = 'Disconnected';
            }
        }
    </script>
</body>
</html>
```

## Testing with curl (for HTTP endpoint)

If you want to test the REST API instead:

```bash
# Get quotes
curl -X POST http://localhost:3000/api/stock/quotes \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"instruments": [26000, 11536]}'

# Get LTP
curl -X POST http://localhost:3000/api/stock/ltp \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"instruments": [26000]}'
```

## Testing on EC2

```bash
# On your local machine
node test-websocket.js your-api-key-here

# Or with custom server URL
SERVER_URL=https://marketdata.vedpragya.com \
  node test-websocket.js your-api-key-here
```

## Popular Instrument Tokens

| Instrument | Token | Description |
|------------|-------|-------------|
| Nifty 50 | 26000 | NSE Nifty 50 Index |
| Bank Nifty | 11536 | NSE Bank Nifty Index |
| Reliance | 2881 | Reliance Industries Ltd |
| TCS | 2953217 | Tata Consultancy Services |
| HDFC Bank | 341249 | HDFC Bank Ltd |

## Troubleshooting

### Connection Refused
- Check if server is running: `docker logs trading-app-backend`
- Verify port is exposed: `docker ps | grep 3000`

### Invalid API Key
- Create API key via admin panel: `POST /api/admin/apikeys`
- Or directly in database

### No Data Received
- Check if streaming is active: `GET /api/admin/stream/status`
- Verify provider is set: `GET /api/admin/provider/global`
- Check logs for errors

### Rate Limiting
- Default limit: 600 requests per minute
- Check: `GET /api/admin/usage?key=your-key`

