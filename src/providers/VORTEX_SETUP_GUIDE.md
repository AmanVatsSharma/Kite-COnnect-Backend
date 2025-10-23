# Vortex Provider Setup Guide

## Overview

This guide covers the complete setup and usage of the Vortex provider for market data streaming. The Vortex provider integrates with Rupeezy's Vortex API to provide real-time market data via WebSocket connections.

## Environment Variables

### Required Variables

```bash
# Vortex API Configuration
VORTEX_APP_ID=your_application_id          # Your Rupeezy application ID
VORTEX_API_KEY=your_api_key               # Your Rupeezy API key
VORTEX_BASE_URL=https://vortex-api.rupeezy.in/v2  # Vortex API base URL

# Optional Variables (with fallbacks)
VORTEX_WS_URL=wss://wire.rupeezy.in/ws    # WebSocket URL (fallback: wss://wire.rupeezy.in/ws)
VORTEX_INSTRUMENTS_CSV_URL=https://static.rupeezy.in/master.csv  # Instruments CSV URL
```

### Optional Variables

```bash
# Database Configuration
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=your_username
DATABASE_PASSWORD=your_password
DATABASE_NAME=kite_connect

# Redis Configuration (for caching and session management)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
```

## Auto-Setup Flow

After successful Vortex login, the system automatically:

1. **Sets Global Provider**: Automatically sets the global provider to 'vortex'
2. **Starts Streaming**: Automatically initializes and connects the WebSocket stream
3. **Updates Token**: Updates the provider with the new access token

### Manual Control (Admin APIs)

If you need manual control, use these admin endpoints:

```bash
# Set global provider
POST /api/admin/provider/global
{
  "provider": "vortex"
}

# Start streaming
POST /api/admin/provider/stream/start

# Stop streaming
POST /api/admin/provider/stream/stop

# Check streaming status
GET /api/admin/stream/status

# Check provider debug info
GET /api/admin/debug/vortex
```

## Complete Setup Process

### 1. Initial Setup

1. **Configure Environment Variables**:
   ```bash
   cp env.example .env
   # Edit .env with your Vortex credentials
   ```

2. **Start the Application**:
   ```bash
   npm run start:dev
   ```

### 2. Authentication Flow

1. **Get Login URL**:
   ```bash
   GET /auth/vortex/login
   # Returns: { "url": "https://flow.rupeezy.in?applicationId=YOUR_APP_ID" }
   ```

2. **User Authorization**:
   - User visits the returned URL
   - User logs in and authorizes the application
   - User is redirected to your callback URL with `auth` parameter

3. **Callback Processing** (Automatic):
   ```bash
   GET /auth/vortex/callback?auth=AUTH_TOKEN
   # System automatically:
   # - Exchanges auth token for access token
   # - Saves session to database
   # - Sets global provider to 'vortex'
   # - Starts WebSocket streaming
   ```

### 3. WebSocket Streaming

Once the callback is processed, the WebSocket stream is automatically active and ready for subscriptions.

#### Client Connection

```javascript
// Connect to market data gateway
const socket = io('ws://localhost:3000/market-data', {
  extraHeaders: {
    'x-api-key': 'your-api-key'
  }
});

// Subscribe to instruments
socket.emit('subscribe_instruments', {
  instruments: [26000],  // Nifty 50 token
  mode: 'ltp'           // ltp, ohlcv, or full
});

// Listen for market data
socket.on('market_data', (data) => {
  console.log('Received tick:', data);
  // data.instrumentToken = 26000
  // data.data = { last_price: 17624.05, ... }
});
```

#### Subscription Modes

- **`ltp`**: Last Traded Price (22 bytes per tick)
- **`ohlcv`**: OHLC + Volume (62 bytes per tick)  
- **`full`**: Complete market depth (266 bytes per tick)

### 4. Testing with Nifty 50

Use token `26000` for Nifty 50 testing:

```javascript
// Subscribe to Nifty 50
socket.emit('subscribe_instruments', {
  instruments: [26000],
  mode: 'ltp'
});

// Expected WebSocket message sent to Vortex:
{
  "exchange": "NSE_EQ",
  "token": 26000,
  "mode": "ltp", 
  "message_type": "subscribe"
}
```

## Exchange Mapping

The system automatically maps instrument tokens to exchanges:

- **NSE_EQ**: Equity instruments (default fallback)
- **NSE_FO**: Futures & Options
- **NSE_CUR**: Currency derivatives
- **MCX_FO**: Commodity futures

### Fallback Behavior

When instruments are not synced in the database:
- All tokens default to `NSE_EQ` exchange
- Logs indicate when fallback is used
- System continues to function normally

## Troubleshooting

### Common Issues

1. **"No access_token for WS"**
   - **Cause**: Login callback not completed
   - **Solution**: Complete the OAuth flow first

2. **"Streaming is not active"**
   - **Cause**: WebSocket not connected
   - **Solution**: Check if callback was successful, restart streaming

3. **"Using NSE_EQ fallback"**
   - **Cause**: Instruments not synced in database
   - **Solution**: This is normal behavior, system will work with fallback

4. **"WS disconnected"**
   - **Cause**: Network issues or token expiry
   - **Solution**: System auto-reconnects, check token validity

### Debug Commands

```bash
# Check streaming status
GET /api/admin/stream/status

# Check Vortex provider debug info
GET /api/admin/debug/vortex

# Check global provider setting
GET /api/admin/provider/global
```

### Log Monitoring

Key log messages to monitor:

```
[Vortex] Callback received with auth parameter: present
[Vortex] Session creation successful, received access_token
[Vortex] Auto-set global provider to vortex
[Vortex] Auto-started streaming after successful login
[Vortex] WS connected successfully
[Vortex] Subscribed 1 tokens with mode=ltp, exchanges: 26000:NSE_EQ
[Vortex] Parsed 1 binary ticks
```

## API Rate Limits

- **REST API**: 1 request per second per endpoint
- **WebSocket**: 3 concurrent connections per access token
- **Subscriptions**: 1000 instruments per WebSocket connection
- **Daily Limit**: 50,000 API requests per day

## Security Notes

- Access tokens are JWT-based with automatic expiry handling
- Tokens are cached in Redis with appropriate TTL
- WebSocket connections require valid API keys
- All sensitive data is logged with sanitization

## Performance Optimization

- **Request Batching**: Multiple requests are batched to single API calls
- **Subscription Batching**: WebSocket subscriptions are batched every 500ms
- **Redis Caching**: Quotes are cached for 30 seconds
- **Connection Pooling**: Database connections are pooled for efficiency

## Support

For issues related to:
- **Vortex API**: Contact Rupeezy support
- **Integration**: Check logs and debug endpoints
- **Configuration**: Verify environment variables and database setup
