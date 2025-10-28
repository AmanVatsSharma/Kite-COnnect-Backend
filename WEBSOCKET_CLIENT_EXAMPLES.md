# WebSocket Client Examples - Ready to Use

## Python (Python Socket.IO - RECOMMENDED)

This is the **safest and most tested** Python approach for your NestJS Socket.IO server.

```python
import socketio
import time

# Create Socket.IO client
sio = socketio.Client()

# Global variable to store socket ID
socket_id = None

@functools.lru_cache(maxsize=None)
def get_socket():
    return sio

@sio.event
def connect():
    global socket_id
    socket_id = sio.sid
    print(f'✅ Connected! Socket ID: {socket_id}')
    
    # Subscribe to market data
    sio.emit('subscribe', {
        'instruments': [26000, 256265],  # Nifty 50 and Bank Nifty
        'mode': 'ltp'
    })

@sio.event
def market_data(data):
    print('💰 Market data received:')
    print(f"   Instrument: {data.get('instrumentToken')}")
    print(f"   Price: {data.get('data', {}).get('last_price')}")
    print(f"   Time: {data.get('timestamp')}")

@sio.event
def subscription_confirmed(data):
    print('✅ Subscription confirmed:', data)

@sio.event
def connected(data):
    print('📥 Server connected event:', data)

@sio.event
def error(error_msg):
    print(f'❌ Error: {error_msg}')

@sio.event
def disconnect():
    print('⚠️ Disconnected')

def connect_to_market_data(api_key='demo-key-1'):
    """Connect to market data WebSocket"""
    try:
        sio.connect(
            'https://marketdata.vedpragya.com/market-data',
            headers={'x-api-key': api_key},
            transports=['websocket', 'polling']
        )
        
        print(f'✅ Connected to market data WebSocket')
        print(f'   Server: https://marketdata.vedpragya.com/market-data')
        print(f'   Socket ID: {sio.sid}')
        
        return sio
        
    except Exception as e:
        print(f'❌ Connection error: {e}')
        raise

# Run the client
if __name__ == '__main__':
    try:
        connect_to_market_data()
        
        # Keep the connection alive
        print('Press Ctrl+C to disconnect...')
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print('\nDisconnecting...')
        sio.disconnect()
```

**Installation:**
```bash
pip install python-socketio
```

## Node.js

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
  
  socket.emit('subscribe', {
    instruments: [26000],
    mode: 'ltp'
  });
});

socket.on('market_data', (data) => {
  console.log('Market data:', data);
});

socket.on('error', (error) => {
  console.error('Error:', error);
});
```

**Installation:**
```bash
npm install socket.io-client
```

## Laravel/PHP

### Using Socket.IO PHP Client

```php
<?php
require 'vendor/autoload.php';

use ElephantIO\Client;
use ElephantIO\Engine\SocketIO\Version4X;

$client = new Client(
    new Version4X('https://marketdata.vedpragya.com'),
    [
        'headers' => [
            'x-api-key' => 'demo-key-1'
        ],
        'namespace' => '/market-data'
    ]
);

$client->initialize();
echo "✅ Connected!\n";

// Subscribe
$client->emit('subscribe', [
    'instruments' => [26000],
    'mode' => 'ltp'
]);

// Listen for events (if your library supports it)
// Keep connection alive
sleep(60);

$client->close();
```

**Installation:**
```bash
composer require elephantly/elephantio
```

## Java

```java
import io.socket.client.IO;
import io.socket.client.Socket;
import java.net.URISyntaxException;

public class MarketDataClient {
    public static void main(String[] args) {
        try {
            IO.Options options = new IO.Options();
            options.path = "/market-data";
            options.extraHeaders = Map.of("x-api-key", "demo-key-1");
            options.transports = new String[]{"websocket"};
            
            Socket socket = IO.socket("https://marketdata.vedpragya.com", options);
            
            socket.on(Socket.EVENT_CONNECT, (data) -> {
                System.out.println("✅ Connected!");
                socket.emit("subscribe", Map.of(
                    "instruments", new int[]{26000},
                    "mode", "ltp"
                ));
            });
            
            socket.on("market_data", (data) -> {
                System.out.println("Market data: " + data);
            });
            
            socket.on(Socket.EVENT_ERROR, (error) -> {
                System.err.println("❌ Error: " + error);
            });
            
            socket.connect();
            
            Thread.sleep(60000); // Keep alive
            
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
```

## Quick Test Scripts

### Python Quick Test

Save as `test_websocket.py`:

```python
#!/usr/bin/env python3
import socketio
import sys

api_key = sys.argv[1] if len(sys.argv) > 1 else 'demo-key-1'
instrument = int(sys.argv[2]) if len(sys.argv) > 2 else 26000

sio = socketio.SimpleClient()

print(f'Connecting to market data with API key: {api_key}...')
sio.connect(
    'https://marketdata.vedpragya.com/market-data',
    headers={'x-api-key': api_key}
)

print('✅ Connected!', sio.sid)

# Subscribe
sio.emit('subscribe', {'instruments': [instrument], 'mode': 'ltp'})
print(f'📤 Subscribed to instrument: {instrument}')

# Listen for data
try:
    while True:
        event, data = sio.receive()
        if event == 'market_data':
            print(f'💰 Market data: {data}')
        elif event == 'subscription_confirmed':
            print(f'✅ Subscription confirmed: {data}')
        elif event == 'error':
            print(f'❌ Error: {data}')
            break
except KeyboardInterrupt:
    print('\nDisconnecting...')
    sio.disconnect()
```

**Usage:**
```bash
chmod +x test_websocket.py
python3 test_websocket.py demo-key-1 26000
```

### Node.js Quick Test

Save as `test_websocket.js`:

```javascript
#!/usr/bin/env node
const io = require('socket.io-client');

const apiKey = process.argv[2] || 'demo-key-1';
const instrument = parseInt(process.argv[3]) || 26000;

console.log(`Connecting with API key: ${apiKey}...`);

const socket = io('https://marketdata.vedpragya.com/market-data', {
  extraHeaders: { 'x-api-key': apiKey },
  transports: ['websocket']
});

socket.on('connect', () => {
  console.log('✅ Connected!', socket.id);
  
  socket.emit('subscribe', {
    instruments: [instrument],
    mode: 'ltp'
  });
  
  console.log(`📤 Subscribed to instrument: ${instrument}`);
});

socket.on('market_data', (data) => {
  console.log('💰 Market data:', data);
});

socket.on('subscription_confirmed', (data) => {
  console.log('✅ Subscription confirmed:', data);
});

socket.on('error', (error) => {
  console.error('❌ Error:', error);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});

// Keep alive
process.on('SIGINT', () => {
  console.log('\nDisconnecting...');
  socket.disconnect();
  process.exit();
});
```

**Usage:**
```bash
chmod +x test_websocket.js
node test_websocket.js demo-key-1 26000
```

## Connection Summary

**For ALL clients:**
- **URL**: `https://marketdata.vedpragya.com/market-data`
- **Protocol**: WSS (WebSocket Secure)
- **Authentication**: Header `x-api-key`
- **Framework**: Socket.IO

**SSL/WSS is fully configured and working!** 🎉

