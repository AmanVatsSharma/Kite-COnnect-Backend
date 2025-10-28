# WebSocket Client Quick Start - For Your Clients

## Connection Details

- **WebSocket URL**: `https://marketdata.vedpragya.com/market-data`
- **Protocol**: HTTPS/WSS (Secure WebSocket over HTTPS)
- **Authentication**: API Key via query parameter
- **Framework**: Socket.IO

## Quick Examples

### JavaScript (Browser/Node.js)

```javascript
const io = require('socket.io-client');

const socket = io('https://marketdata.vedpragya.com/market-data', {
  query: { 'api_key': 'demo-key-1' },
  transports: ['websocket', 'polling']
});

socket.on('connect', () => {
  console.log('✅ Connected!', socket.id);
  
  // Subscribe to Nifty 50
  socket.emit('subscribe', {
    instruments: [26000],
    mode: 'ltp'
  });
});

socket.on('market_data', (data) => {
  console.log('Market data:', data);
});

socket.on('subscription_confirmed', (data) => {
  console.log('Subscription confirmed:', data);
});

socket.on('error', (error) => {
  console.error('Error:', error);
});
```

### Python

```python
import socketio

sio = socketio.Client()

sio.connect(
    'https://marketdata.vedpragya.com/market-data',
    params={'api_key': 'demo-key-1'}
)

@sio.event
def connect():
    print('✅ Connected!')
    
    # Subscribe to Nifty
    sio.emit('subscribe', {
        'instruments': [26000],
        'mode': 'ltp'
    })

@sio.event
def market_data(data):
    print('Market data:', data)

sio.wait()
```

### PHP/Laravel

```php
<?php
use SocketIOClient\SocketIOClient;

$client = new SocketIOClient('https://marketdata.vedpragya.com', [
    'path' => '/market-data',
    'query' => ['api_key' => 'demo-key-1']
]);

$client->connect();

$client->on('connect', function() use ($client) {
    $client->emit('subscribe', [
        'instruments' => [26000],
        'mode' => 'ltp'
    ]);
});

$client->on('market_data', function($data) {
    echo json_encode($data) . "\n";
});

$client->loop();
?>
```

## Important Notes

1. **Use HTTPS, not WS/WSS** in your Socket.IO URL
   - Correct: `https://marketdata.vedpragya.com/market-data`
   - Wrong: `ws://marketdata.vedpragya.com:3000/market-data`

2. **API Key Authentication**
   - Pass API key in `query` parameter: `query: { 'api_key': 'your-key' }`
   - This is the most reliable method

3. **Connection Events**
   - `connect` - Connected to server
   - `connected` - Server confirmation with client ID
   - `market_data` - Real-time market data
   - `subscription_confirmed` - Subscription successful
   - `error` - Error occurred

4. **Subscribe Event**
   - Event name: `subscribe` (not `subscribe_instruments`)
   - Payload: `{ instruments: [numbers], mode: 'ltp'|'ohlcv'|'full' }`

## Testing

Test your connection at: `https://marketdata.vedpragya.com/test-wss-simple.html`

Or use the test HTML file in your browser with your API key.

## Support

- Swagger Docs: https://marketdata.vedpragya.com/api/docs
- Health Check: https://marketdata.vedpragya.com/api/health
- Email: admin@vedpragya.com

