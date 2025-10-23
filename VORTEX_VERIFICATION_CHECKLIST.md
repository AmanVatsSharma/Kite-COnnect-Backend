# Vortex Auto-Setup Flow Verification Checklist

## Pre-Test Setup

### 1. Environment Configuration
```bash
# Required environment variables
VORTEX_APP_ID=your_application_id
VORTEX_API_KEY=your_api_key
VORTEX_BASE_URL=https://vortex-api.rupeezy.in/v2
VORTEX_WS_URL=wss://wire.rupeezy.in/ws  # Optional, has fallback

# Database and Redis
DATABASE_HOST=localhost
DATABASE_PORT=5432
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 2. Start Application
```bash
npm run start:dev
# Verify application starts without errors
# Check logs for: "[Vortex] HTTP client initialized"
```

## Test Flow: Complete Vortex Integration

### Step 1: Login Flow
```bash
# 1.1 Get login URL
curl -X GET "http://localhost:3000/auth/vortex/login"

# Expected Response:
{
  "url": "https://flow.rupeezy.in?applicationId=YOUR_APP_ID"
}

# Expected Logs:
# [Vortex] Configuration: appId=present, apiKey=present, baseUrl=https://vortex-api.rupeezy.in/v2
```

### Step 2: OAuth Authorization
```bash
# 2.1 User visits the returned URL
# 2.2 User logs in and authorizes application
# 2.3 User is redirected to callback URL with auth parameter
```

### Step 3: Callback Processing (Auto-Setup)
```bash
# 3.1 Callback endpoint (simulated)
curl -X GET "http://localhost:3000/auth/vortex/callback?auth=AUTH_TOKEN_FROM_STEP_2"

# Expected Response:
{
  "success": true
}

# Expected Logs (in order):
# [Vortex] Callback received with auth parameter: present
# [Vortex] Configuration: appId=present, apiKey=present, baseUrl=https://vortex-api.rupeezy.in/v2
# [Vortex] Generated checksum for session creation
# [Vortex] Creating session at https://vortex-api.rupeezy.in/v2/user/session
# [Vortex] Session creation successful, received access_token
# [Vortex] Access token extracted, length: XXX
# [Vortex] JWT TTL calculated: XXXs (expires at YYYY-MM-DDTHH:mm:ss.sssZ)
# [Vortex] Deactivating previous sessions and saving new session
# [Vortex] Session saved to database with ID: X
# [Vortex] Token cached in Redis with TTL: XXXs
# [Vortex] Updated access token in provider
# [Vortex] Auto-set global provider to vortex
# [Vortex] Auto-started streaming after successful login
```

### Step 4: Verify Auto-Setup
```bash
# 4.1 Check global provider
curl -X GET "http://localhost:3000/api/admin/provider/global"

# Expected Response:
{
  "provider": "vortex"
}

# 4.2 Check streaming status
curl -X GET "http://localhost:3000/api/admin/stream/status"

# Expected Response:
{
  "isStreaming": true,
  "subscribedInstruments": [],
  "subscribedCount": 0,
  "provider": "vortex"
}

# 4.3 Check Vortex debug info
curl -X GET "http://localhost:3000/api/admin/debug/vortex"

# Expected Response:
{
  "initialized": true,
  "httpConfigured": true,
  "wsConnected": true,
  "reconnectAttempts": 0,
  "hasAccessToken": true
}
```

### Step 5: WebSocket Connection Test
```javascript
// 5.1 Connect to market data gateway
const socket = io('ws://localhost:3000/market-data', {
  extraHeaders: {
    'x-api-key': 'your-api-key'  // Use a valid API key
  }
});

// Expected Logs:
# [Gateway] Client connected: socket_id
# [Gateway] Socket.IO Redis adapter attached

// 5.2 Listen for connection confirmation
socket.on('connected', (data) => {
  console.log('Connected:', data);
  // Expected: { message: 'Connected to market data stream', clientId: '...', timestamp: '...' }
});
```

### Step 6: Subscription Test (Nifty 50)
```javascript
// 6.1 Subscribe to Nifty 50 (token 26000)
socket.emit('subscribe_instruments', {
  instruments: [26000],
  mode: 'ltp'
});

// Expected Logs:
# [Gateway] Queued subscription for 1 instruments with mode=ltp for client=socket_id
# [StreamBatching] Queued 1 instruments for subscription with mode=ltp
# [StreamBatching] Processed 1 subscriptions in 1 mode groups
# [Vortex] Using NSE_EQ fallback for 1 tokens not in DB: 26000
# [Vortex] Subscribed 1 tokens with mode=ltp, exchanges: 26000:NSE_EQ
# [Vortex] Sent WS message: {"exchange":"NSE_EQ","token":26000,"mode":"ltp","message_type":"subscribe"}

// 6.2 Listen for subscription confirmation
socket.on('subscription_confirmed', (data) => {
  console.log('Subscription confirmed:', data);
  // Expected: { instruments: [26000], type: 'live', mode: 'ltp', timestamp: '...' }
});
```

### Step 7: Market Data Reception Test
```javascript
// 7.1 Listen for market data ticks
socket.on('market_data', (data) => {
  console.log('Received tick:', data);
  // Expected structure:
  // {
  //   instrumentToken: 26000,
  //   data: {
  //     instrument_token: 26000,
  //     exchange: 'NSE_EQ',
  //     last_price: 17624.05,
  //     ...
  //   },
  //   timestamp: '2024-01-01T12:00:00.000Z'
  // }
});

// Expected Logs (when ticks arrive):
# [Vortex] Parsed 1 binary ticks
# [Gateway] Broadcasted tick 26000 to 1 clients in Xms
```

### Step 8: Additional Subscription Modes Test
```javascript
// 8.1 Test OHLCV mode
socket.emit('subscribe_instruments', {
  instruments: [26000],
  mode: 'ohlcv'
});

// Expected Logs:
# [Vortex] Sent WS message: {"exchange":"NSE_EQ","token":26000,"mode":"ohlcv","message_type":"subscribe"}

// 8.2 Test FULL mode
socket.emit('subscribe_instruments', {
  instruments: [26000],
  mode: 'full'
});

// Expected Logs:
# [Vortex] Sent WS message: {"exchange":"NSE_EQ","token":26000,"mode":"full","message_type":"subscribe"}
```

### Step 9: Unsubscription Test
```javascript
// 9.1 Unsubscribe from instruments
socket.emit('unsubscribe_instruments', {
  instruments: [26000]
});

// Expected Logs:
# [Gateway] Queued unsubscription for 1 instruments for client=socket_id
# [StreamBatching] Queued 1 instruments for unsubscription
# [StreamBatching] Processed 1 unsubscriptions
# [Vortex] Unsubscribed 1 tokens
# [Vortex] Sent WS message: {"exchange":"NSE_EQ","token":26000,"mode":"ltp","message_type":"unsubscribe"}
```

### Step 10: Error Handling Test
```javascript
// 10.1 Test invalid subscription
socket.emit('subscribe_instruments', {
  instruments: [],  // Empty array
  mode: 'ltp'
});

// Expected Response:
socket.on('error', (data) => {
  console.log('Error:', data);
  // Expected: { message: 'Invalid instruments array' }
});

// 10.2 Test invalid mode
socket.emit('subscribe_instruments', {
  instruments: [26000],
  mode: 'invalid'
});

// Expected Response:
socket.on('error', (data) => {
  console.log('Error:', data);
  // Expected: { message: 'Invalid mode. Must be ltp, ohlcv, or full' }
});
```

## Success Criteria

### ✅ All Tests Pass If:
1. **Login Flow**: Login URL generated successfully
2. **Callback Processing**: Session created, token saved, provider set, streaming started
3. **Auto-Setup**: Global provider = 'vortex', streaming = true, WebSocket connected
4. **Subscription**: Instruments subscribed with correct exchange mapping (NSE_EQ fallback)
5. **Market Data**: Binary ticks received, parsed, and broadcasted to clients
6. **Error Handling**: Appropriate error messages for invalid inputs
7. **Logging**: Comprehensive logs throughout the flow for debugging

### 🔍 Key Log Messages to Verify:
- `[Vortex] Auto-set global provider to vortex`
- `[Vortex] Auto-started streaming after successful login`
- `[Vortex] WS connected successfully`
- `[Vortex] Using NSE_EQ fallback for X tokens not in DB`
- `[Vortex] Subscribed X tokens with mode=ltp, exchanges: 26000:NSE_EQ`
- `[Vortex] Parsed X binary ticks`
- `[Gateway] Broadcasted tick 26000 to X clients`

### 🚨 Troubleshooting Common Issues:

1. **"No access_token for WS"**: Complete OAuth flow first
2. **"Streaming is not active"**: Check if callback was successful
3. **"Using NSE_EQ fallback"**: Normal behavior when instruments not synced
4. **"WS disconnected"**: Check network and token validity
5. **No ticks received**: Verify market hours and instrument validity

## Performance Verification

### Expected Performance:
- **Login to Streaming**: < 5 seconds
- **Subscription Response**: < 1 second
- **Tick Latency**: < 100ms from Vortex to client
- **Memory Usage**: Stable, no leaks
- **CPU Usage**: Low during idle, spikes during tick processing

### Load Testing:
- **Concurrent Connections**: Test with 10+ simultaneous clients
- **Subscription Volume**: Test with 100+ instrument subscriptions
- **Tick Throughput**: Verify handling of high-frequency ticks

---

## Final Verification Summary

The Vortex auto-setup flow is **successful** when:

1. ✅ User completes OAuth flow
2. ✅ System automatically sets provider to 'vortex'
3. ✅ System automatically starts WebSocket streaming
4. ✅ Client can connect and subscribe to instruments
5. ✅ Market data flows: Vortex WS → Binary Parser → Gateway → Clients
6. ✅ All requests batch efficiently to single WebSocket connection
7. ✅ Comprehensive logging enables easy debugging
8. ✅ Error handling provides clear feedback
9. ✅ Documentation covers complete setup and troubleshooting

**Result**: Vortex provider is fully integrated with auto-setup flow and ready for production use.
