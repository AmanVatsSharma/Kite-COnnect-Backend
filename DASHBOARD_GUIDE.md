# Ultimate Trading Data Provider Dashboard Guide

## Overview

The Ultimate Trading Data Provider Dashboard is a comprehensive web interface for managing market data providers, authentication, real-time monitoring, and system administration.

## Features

### 1. Authentication Wizards

#### Kite Connect Authentication
1. **Step 1 - Login**: Enter API Key and Secret
2. **Step 2 - Authorize**: Redirect to Kite login page
3. **Step 3 - Test**: Verify connection and session status

#### Vortex Authentication
1. **Step 1 - Setup**: Enter Application ID and API Key
2. **Step 2 - Login**: Redirect to Rupeezy flow
3. **Step 3 - Verify**: Complete auth code submission and test

### 2. Real-time Monitoring

#### Connection Status
- **Kite Status**: Shows connection state, session info, expiry
- **Vortex Status**: HTTP/WebSocket status, session details
- **Live Indicators**: Pulsing status dots with color coding

#### Metrics Dashboard
- **Connection Trends**: Real-time chart of active connections
- **Tick Rate**: Ticks per second visualization
- **Provider Health**: HTTP/WS status indicators

### 3. Admin Controls

#### Provider Management
- **Global Provider**: Switch between Kite and Vortex
- **Stream Control**: Start/Stop/Restart streaming
- **Session Management**: View active sessions and expiry

#### API Key Management
- **Create Keys**: Generate new API keys with rate limits
- **List Keys**: View all keys with status and usage
- **Rate Limiting**: Set per-minute request limits

### 4. Testing & Development

#### WebSocket Testing
- **Connection**: Connect with API key
- **Subscription**: Subscribe to instruments with mode selection
- **Real-time Data**: View live market data feeds

#### REST API Testing
- **Quotes**: Test quote endpoints with different modes
- **Instruments**: Search and test instrument data
- **Historical**: Fetch historical candle data

## Usage Guide

### Getting Started

1. **Access Dashboard**: Navigate to `/dashboard.html`
2. **Authentication**: Complete provider authentication wizards
3. **Admin Setup**: Configure global provider and start streaming
4. **Testing**: Use testing tools to verify functionality

### Authentication Flow

#### Kite Connect
```
1. Enter API Key and Secret in wizard
2. Click "Start Kite Authentication"
3. Complete OAuth flow in popup window
4. Test connection to verify success
```

#### Vortex
```
1. Enter Application ID and API Key in wizard
2. Click "Start Vortex Authentication"
3. Complete login in popup window
4. Copy auth code from callback URL
5. Paste auth code and submit
6. Test HTTP and WebSocket connections
```

### Admin Operations

#### Setting Global Provider
```
1. Navigate to Admin Controls tab
2. Select provider from dropdown (Kite/Vortex)
3. Enter admin token
4. Click "Set Provider"
5. Start streaming if needed
```

#### API Key Management
```
1. Navigate to API Key Management section
2. Enter new key details (key, tenant, rate limit)
3. Enter admin token
4. Click "Create API Key"
5. Use "Refresh API Keys" to view all keys
```

### Testing & Monitoring

#### WebSocket Testing
```
1. Navigate to Testing tab
2. Enter API key and connect
3. Select mode (ltp/ohlcv/full)
4. Enter instrument tokens
5. Click "Subscribe" to start receiving data
```

#### REST API Testing
```
1. Navigate to REST API Testing section
2. Enter API key and provider
3. Select mode and enter tokens
4. Click "Fetch Quotes" to test
```

## Dashboard Sections

### 1. Overview Tab
- Real-time status indicators
- Connection trends chart
- Tick rate visualization
- Provider health metrics

### 2. Authentication Tab
- Kite Connect wizard
- Vortex authentication wizard
- Session status and testing

### 3. Admin Controls Tab
- Provider management
- Session overview
- API key management
- Stream controls

### 4. Monitoring Tab
- Real-time logs
- Performance metrics
- Error tracking
- System health

### 5. Testing Tab
- WebSocket testing tools
- REST API testing
- Instrument search
- Historical data testing

## Configuration

### Environment Setup
```bash
# Required environment variables
VORTEX_APP_ID=your_application_id
VORTEX_API_KEY=your_api_key
ADMIN_TOKEN=your_admin_token
```

### API Key Configuration
```javascript
// API Key structure
{
  key: "api-key-name",
  tenant_id: "tenant-1",
  rate_limit_per_minute: 600,
  connection_limit: 2000
}
```

## Troubleshooting

### Common Issues

1. **Authentication Failures**
   - Verify API credentials are correct
   - Check environment variables
   - Ensure admin token is valid

2. **Connection Issues**
   - Check network connectivity
   - Verify provider status
   - Review error logs in monitoring tab

3. **WebSocket Problems**
   - Ensure streaming is started
   - Check API key permissions
   - Verify mode selection is valid

4. **Rate Limiting**
   - Monitor request frequency
   - Check API key limits
   - Review rate limit warnings

### Debug Information

The dashboard provides comprehensive logging and monitoring:
- Real-time error logs
- Connection status indicators
- Performance metrics
- Health check results

### Support

For technical support:
1. Check the monitoring tab for error logs
2. Review health check endpoints
3. Verify configuration settings
4. Test with minimal setup first
