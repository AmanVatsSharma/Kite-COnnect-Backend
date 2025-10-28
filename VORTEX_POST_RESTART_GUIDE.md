# Vortex Post-Restart Recovery Guide

## Overview

After a system restart, the Vortex provider needs to be manually restored because:
- ✅ Vortex access token is saved in database
- ❌ Global provider setting is lost (stored in Redis/memory)
- ❌ WebSocket streaming is not active
- ❌ Provider needs to be re-initialized

## Recovery Methods

### Method 1: Automatic Recovery Script (Recommended)

Use the provided recovery script:

```bash
# Set admin token (one-time setup)
export ADMIN_TOKEN="your-secure-admin-token"

# Run recovery script
./recover-vortex.sh
```

**Expected Output:**
```
🔄 Vortex Post-Restart Recovery Script
======================================
✅ Vortex access token found in database
✅ /api/admin/provider/global: {"success":true}
✅ /api/admin/provider/stream/start: {"success":true}
✅ /api/admin/stream/status: {"isStreaming":true,"provider":"vortex"}
✅ /api/admin/debug/vortex: {"wsConnected":true,"hasAccessToken":true}
🎉 Vortex recovery completed!
```

### Method 2: Manual API Calls

If you prefer manual control:

```bash
# 1. Set global provider to vortex
curl -X POST "http://localhost:3000/api/admin/provider/global" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-admin-token" \
  -d '{"provider": "vortex"}'

# 2. Start streaming
curl -X POST "http://localhost:3000/api/admin/provider/stream/start" \
  -H "x-admin-token: your-admin-token"

# 3. Verify status
curl -X GET "http://localhost:3000/api/admin/stream/status" \
  -H "x-admin-token: your-admin-token"
```

### Method 3: Dashboard Recovery

1. Open `http://localhost:3000`
2. Navigate to Admin section
3. Set Provider to "Vortex"
4. Click "Start Streaming"
5. Verify connection status

## Verification Steps

After recovery, verify everything is working:

### 1. Check Streaming Status
```bash
curl -X GET "http://localhost:3000/api/admin/stream/status" \
  -H "x-admin-token: your-admin-token"
```

**Expected Response:**
```json
{
  "isStreaming": true,
  "subscribedInstruments": [],
  "subscribedCount": 0,
  "provider": "vortex"
}
```

### 2. Check Vortex Debug Info
```bash
curl -X GET "http://localhost:3000/api/admin/debug/vortex" \
  -H "x-admin-token: your-admin-token"
```

**Expected Response:**
```json
{
  "initialized": true,
  "httpConfigured": true,
  "wsConnected": true,
  "reconnectAttempts": 0,
  "hasAccessToken": true
}
```

### 3. Test WebSocket Connection

```javascript
// Test in browser console
const socket = io('ws://localhost:3000/market-data', {
  extraHeaders: { 'x-api-key': 'your-api-key' }
});

socket.on('connected', () => {
  console.log('✅ WebSocket connected');
  socket.emit('subscribe_instruments', {
    instruments: [26000],
    mode: 'ltp'
  });
});

socket.on('market_data', (data) => {
  console.log('📈 Received tick:', data);
});
```

## Troubleshooting

### Issue: "No active token found in DB"
**Solution:** Complete Vortex login flow first:
```bash
curl -X GET "http://localhost:3000/auth/vortex/login"
# Follow OAuth flow, then run recovery
```

### Issue: "Token is expired"
**Solution:** Re-login to get fresh token:
```bash
curl -X GET "http://localhost:3000/auth/vortex/login"
# Complete OAuth flow
```

### Issue: "WebSocket not connecting"
**Solution:** Check Vortex service status and network connectivity:
```bash
# Check if Vortex service is accessible
curl -X GET "https://vortex-api.rupeezy.in/v2/data/quotes?q=NSE_EQ-26000&mode=ltp" \
  -H "x-api-key: your-vortex-api-key"
```

### Issue: "Provider not set"
**Solution:** Ensure admin token is correct:
```bash
# Check if admin token is set
echo $ADMIN_TOKEN

# Or set it temporarily
export ADMIN_TOKEN="your-admin-token"
```

## Automation Options

### Option 1: Systemd Service (Linux)

Create a systemd service that runs recovery on startup:

```ini
# /etc/systemd/system/vortex-recovery.service
[Unit]
Description=Vortex Recovery Service
After=network.target

[Service]
Type=oneshot
User=your-user
WorkingDirectory=/path/to/your/app
ExecStart=/path/to/your/app/recover-vortex.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable vortex-recovery.service
sudo systemctl start vortex-recovery.service
```

### Option 2: Docker Compose

Add to your `docker-compose.yml`:

```yaml
services:
  app:
    # ... your app config
    environment:
      - ADMIN_TOKEN=your-admin-token
    command: >
      sh -c "
        npm run start:prod &
        sleep 10 &&
        ./recover-vortex.sh
      "
```

### Option 3: Cron Job

Add to crontab for periodic recovery checks:

```bash
# Check every 5 minutes and recover if needed
*/5 * * * * cd /path/to/your/app && ./recover-vortex.sh
```

## Monitoring

### Health Check Endpoint

Create a simple health check:

```bash
#!/bin/bash
# health-check.sh

status=$(curl -s -X GET "http://localhost:3000/api/admin/stream/status" \
  -H "x-admin-token: $ADMIN_TOKEN" | jq -r '.isStreaming')

if [ "$status" = "true" ]; then
  echo "✅ Vortex streaming is active"
  exit 0
else
  echo "❌ Vortex streaming is not active"
  exit 1
fi
```

### Log Monitoring

Monitor these log messages:
- `[Vortex] Auto-loaded access token from DB on startup`
- `[Vortex] WS connected successfully`
- `[MarketDataStreamService] Market data streaming started`

## Best Practices

1. **Always set ADMIN_TOKEN** in environment variables
2. **Run recovery script** after every restart
3. **Monitor logs** for connection issues
4. **Test WebSocket** after recovery
5. **Keep backup** of working configuration
6. **Document** your specific setup for team members

## Quick Reference

| Action | Command |
|--------|---------|
| Check Status | `curl -X GET "http://localhost:3000/api/admin/stream/status" -H "x-admin-token: $ADMIN_TOKEN"` |
| Set Provider | `curl -X POST "http://localhost:3000/api/admin/provider/global" -H "x-admin-token: $ADMIN_TOKEN" -d '{"provider":"vortex"}'` |
| Start Stream | `curl -X POST "http://localhost:3000/api/admin/provider/stream/start" -H "x-admin-token: $ADMIN_TOKEN"` |
| Auto Recovery | `./recover-vortex.sh` |
| Check Debug | `curl -X GET "http://localhost:3000/api/admin/debug/vortex" -H "x-admin-token: $ADMIN_TOKEN"` |






