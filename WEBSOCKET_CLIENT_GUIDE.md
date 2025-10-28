# WebSocket Client Connection Guide

## Connection Details

- **Server**: `https://marketdata.vedpragya.com/market-data`
- **Protocol**: WSS (WebSocket Secure over HTTPS)
- **Transport**: Socket.IO
- **Authentication**: API Key via header or query parameter

## JavaScript/Node.js (Browser or Node.js)

### Using Socket.IO Client

```javascript
const io = require('socket.io-client');

const socket = io('https://marketdata.vedpragya.com/market-data', {
  extraHeaders: {
    'x-api-key': 'demo-key-1'
  },
  transports: ['websocket']
});

socket.on('connect', () => {
  console.log('✅ Connected!', socket.id);
  
  // Subscribe to market data
  socket.emit('subscribe', {
    instruments: [26000], // Nifty 50
    mode: 'ltp'
  });
});

socket.on('market_data', (data) => {
  console.log('Market data:', data);
});

socket.on('error', (error) => {
  console.error('❌ Error:', error);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});
```

### Browser (with CDN)

```html
<script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
<script>
const socket = io('https://marketdata.vedpragya.com/market-data', {
  extraHeaders: {
    'x-api-key': 'demo-key-1'
  }
});

socket.on('connect', () => console.log('Connected!'));
socket.on('market_data', (data) => console.log(data));
</script>
```

## Python

Install requirements:
```bash
pip install python-socketio
```

### Python Client

```python
import socketio

# Create Socket.IO client
sio = socketio.Client()

# Connect with API key
sio.connect(
    'https://marketdata.vedpragya.com/market-data',
    headers={'x-api-key': 'demo-key-1'},
    transports=['websocket']
)

@sio.event
def connect():
    print('✅ Connected!')
    
    # Subscribe to market data
    sio.emit('subscribe', {
        'instruments': [26000],  # Nifty 50
        'mode': 'ltp'
    })

@sio.event
def market_data(data):
    print('Market data:', data)

@sio.event
def error(error_msg):
    print('❌ Error:', error_msg)

@sio.event
def disconnect():
    print('Disconnected')

# Keep the connection alive
sio.wait()
```

### Alternative: Using `websockets` library (if using raw WebSocket)

```python
import websockets
import ssl
import json

async def connect_market_data():
    uri = 'wss://marketdata.vedpragya.com/market-data'
    
    # For HTTPS/WSS connections
    ssl_context = ssl.create_default_context()
    
    async with websockets.connect(
        uri,
        extra_headers={'x-api-key': 'demo-key-1'},
        ssl=ssl_context
    ) as websocket:
        print('✅ Connected!')
        
        # Send subscription
        await websocket.send(json.dumps({
            'type': 'subscribe',
            'instruments': [26000],
            'mode': 'ltp'
        }))
        
        # Listen for messages
        async for message in websocket:
            data = json.loads(message)
            print('Market data:', data)

# Run
import asyncio
asyncio.run(connect_market_data())
```

## PHP (Laravel)

### Using `ratchet/pawl` (Async WebSocket Client)

Install:
```bash
composer require ratchet/pawl
```

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use Ratchet\Client\WebSocket;
use React\Socket\Connector;

$connector = new \Ratchet\Client\Connector(
    new \React\EventLoop\Factory()
);

$apiKey = 'demo-key-1';
$url = 'wss://marketdata.vedpragya.com/market-data';

$connector($url, [], ['x-api-key' => $apiKey])
    ->then(function (WebSocket $conn) {
        echo "✅ Connected!\n";
        
        // Subscribe to market data
        $conn->send(json_encode([
            'type' => 'subscribe',
            'instruments' => [26000], // Nifty 50
            'mode' => 'ltp'
        ]));
        
        $conn->on('message', function ($msg) use ($conn) {
            echo "Market data: " . $msg . "\n";
        });
        
        $conn->on('close', function ($code = null, $reason = null) {
            echo "Connection closed ({$code} - {$reason})\n";
        });
        
        $conn->on('error', function ($error) {
            echo "Error: {$error}\n";
        });
        
    }, function (\Exception $e) {
        echo "Could not connect: {$e->getMessage()}\n";
    });

// Keep running
$loop->run();
?>
```

### Using Socket.IO Client for PHP

Install:
```bash
composer require elephantly/php-socketio-client
```

```php
<?php
require 'vendor/autoload.php';

use SocketIOClient\SocketIOClient;

$client = new SocketIOClient('https://marketdata.vedpragya.com', [
    'path' => '/market-data/socket.io',
    'extraHeaders' => ['x-api-key' => 'demo-key-1']
]);

$client->connect();

$client->on('connect', function() use ($client) {
    echo "✅ Connected!\n";
    
    $client->emit('subscribe', [
        'instruments' => [26000],
        'mode' => 'ltp'
    ]);
});

$client->on('market_data', function($data) {
    echo "Market data: " . json_encode($data) . "\n";
});

$client->loop();
?>
```

## C# / .NET

Using Socket.IO Client for .NET:

```csharp
using SocketIOClient;
using System.Threading.Tasks;

class Program
{
    static async Task Main()
    {
        var client = new SocketIO("https://marketdata.vedpragya.com/market-data", new SocketIOOptions
        {
            ExtraHeaders = new Dictionary<string, string>
            {
                { "x-api-key", "demo-key-1" }
            },
            Transport = SocketIOClient.Transport.WebSocket
        });

        client.OnConnected += (sender, e) =>
        {
            Console.WriteLine("✅ Connected!");
            
            client.EmitAsync("subscribe", new
            {
                instruments = new[] { 26000 },
                mode = "ltp"
            });
        };

        client.On("market_data", response =>
        {
            var data = response.GetValue<string>();
            Console.WriteLine($"Market data: {data}");
        });

        await client.ConnectAsync();
        
        // Keep connection alive
        Console.ReadKey();
    }
}
```

## Go

```go
package main

import (
    "fmt"
    "net/http"
    "github.com/googollee/go-socket.io/client"
)

func main() {
    opts := &client.Options{
        Transport: "websocket",
    }
    
    header := http.Header{}
    header.Set("x-api-key", "demo-key-1")
    opts.Header = header
    
    client, err := client.New("https://marketdata.vedpragya.com/market-data", opts)
    if err != nil {
        panic(err)
    }
    
    client.On("connect", func() {
        fmt.Println("✅ Connected!")
        
        client.Emit("subscribe", map[string]interface{}{
            "instruments": []int{26000},
            "mode": "ltp",
        })
    })
    
    client.On("market_data", func(data map[string]interface{}) {
        fmt.Println("Market data:", data)
    })
    
    client.On("error", func(data interface{}) {
        fmt.Println("Error:", data)
    })
    
    client.Connect()
    
    // Keep connection alive
    select {}
}
```

## Quick Test

### Browser Console (Easiest)

Open browser console on https://marketdata.vedpragya.com and run:

```javascript
const io = require('socket.io-client') || window.io;
const socket = io('https://marketdata.vedpragya.com/market-data', {
  extraHeaders: { 'x-api-key': 'demo-key-1' },
  transports: ['websocket']
});

socket.on('connect', () => {
  console.log('✅ Connected!', socket.id);
  socket.emit('subscribe', { instruments: [26000], mode: 'ltp' });
});

socket.on('market_data', (data) => console.log('Data:', data));
socket.on('error', (error) => console.error('Error:', error));
```

## Authentication Options

You can pass the API key in two ways:

### 1. Header (Recommended)
```javascript
extraHeaders: { 'x-api-key': 'your-api-key' }
```

### 2. Query Parameter
```javascript
query: { 'api_key': 'your-api-key' }
```

## Events

### Listen For:
- `connect` - Connection established
- `market_data` - Market data received
- `subscription_confirmed` - Subscription confirmed
- `error` - Error occurred
- `disconnect` - Connection closed

### Emit:
- `subscribe` - Subscribe to instruments
  ```javascript
  socket.emit('subscribe', {
    instruments: [26000, 256265],
    mode: 'ltp' // or 'ohlcv' or 'full'
  });
  ```
- `unsubscribe` - Unsubscribe from instruments
- `disconnect` - Disconnect from server

## Connection URL Formats

✅ **CORRECT:**
- `https://marketdata.vedpragya.com/market-data` (for Socket.IO)
- `wss://marketdata.vedpragya.com/market-data` (auto-converted)

❌ **WRONG:**
- `ws://marketdata.vedpragya.com:3000/market-data` (old format, won't work)
- `https://marketdata.vedpragya.com/market-data/socket.io` (incorrect path)

## Troubleshooting

### Connection fails?
1. Check SSL certificate: https://marketdata.vedpragya.com
2. Check API key is valid
3. Check network allows WSS connections
4. Check browser console for detailed errors

### No data received?
1. Emit `subscribe` event after connection
2. Check instrument tokens are valid
3. Check provider is initialized (use /api/health)

### Python connection issues?
```bash
# Install required packages
pip install python-socketio websockets

# Try with verbose logging
import logging
logging.basicConfig(level=logging.DEBUG)
```

### PHP connection issues?
```bash
# Ensure extensions are enabled
php -m | grep openssl
php -m | grep sockets
```

## Testing

Test your connection:
```bash
# 1. Test HTTPS endpoint
curl https://marketdata.vedpragya.com/api/health

# 2. Test with wscat (Node.js)
npm install -g wscat
wscat -c wss://marketdata.vedpragya.com/market-data

# 3. Use the test HTML file
open test-wss-simple.html
```

## Support

For issues:
1. Check server logs: `docker logs trading-app-backend`
2. Check Nginx logs: `sudo tail -f /var/log/nginx/error.log`
3. Test health endpoint: https://marketdata.vedpragya.com/api/health
4. Run SSL health check: `./scripts/check-ssl-health.sh`

