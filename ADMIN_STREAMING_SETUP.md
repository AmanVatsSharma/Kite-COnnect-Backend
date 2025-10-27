# Admin Streaming Setup Guide

## Quick Start for WebSocket Streaming

After restarting the application, you need to configure the streaming provider and start the stream.

### Step 1: Set the Global Provider

**Endpoint:** `POST /api/admin/provider/global`

**Request:**
```bash
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/global \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-admin-token" \
  -d '{"provider": "vortex"}'
```

**Response:**
```json
{
  "success": true,
  "message": "Global provider set to vortex"
}
```

**Available Providers:**
- `kite` - Falcon (Zerodha Kite Connect)
- `vortex` - Vayu (Rupeezy Vortex API)

### Step 2: Check Provider Status

**Endpoint:** `GET /api/admin/provider/global`

**Request:**
```bash
curl https://marketdata.vedpragya.com/api/admin/provider/global \
  -H "x-admin-token: your-admin-token"
```

**Response:**
```json
{
  "provider": "vortex"
}
```

### Step 3: Start Streaming

**Endpoint:** `POST /api/admin/provider/stream/start`

**Request:**
```bash
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/stream/start \
  -H "x-admin-token: your-admin-token"
```

**Response:**
```json
{
  "success": true,
  "message": "Streaming started",
  "status": {
    "isStreaming": true,
    "provider": "vortex"
  }
}
```

### Step 4: Check Streaming Status

**Endpoint:** `GET /api/admin/stream/status`

**Request:**
```bash
curl https://marketdata.vedpragya.com/api/admin/stream/status \
  -H "x-admin-token: your-admin-token"
```

**Response:**
```json
{
  "isStreaming": true,
  "provider": "vortex",
  "subscribedInstruments": [],
  "connectionCount": 0
}
```

## Common Workflows

### Setup Vayu Streaming After Login

```bash
# After Vayu callback succeeds, verify provider is set
curl https://marketdata.vedpragya.com/api/admin/provider/global \
  -H "x-admin-token: your-admin-token"

# Start streaming
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/stream/start \
  -H "x-admin-token: your-admin-token"
```

### Restart Streaming After Service Restart

```bash
# 1. Set provider
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/global \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your-admin-token" \
  -d '{"provider": "vortex"}'

# 2. Start streaming
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/stream/start \
  -H "x-admin-token: your-admin-token"

# 3. Verify
curl https://marketdata.vedpragya.com/api/admin/stream/status \
  -H "x-admin-token: your-admin-token"
```

### Stop Streaming

```bash
curl -X POST https://marketdata.vedpragya.com/api/admin/provider/stream/stop \
  -H "x-admin-token: your-admin-token"
```

## Swagger UI

Access the full API documentation at:
```
https://marketdata.vedpragya.com/api/docs
```

Navigate to the **admin** section to see all endpoints with examples.

## Troubleshooting

### "Streaming is not active" Error

**Cause:** Stream was stopped or not started after restart.

**Solution:**
```bash
# Set provider
POST /api/admin/provider/global
Body: {"provider": "vortex"}

# Start streaming
POST /api/admin/provider/stream/start
```

### No Data on WebSocket

**Check:**
1. Is streaming active? `GET /api/admin/stream/status`
2. Is provider authenticated? `GET /api/health/detailed`
3. Are instruments subscribed? Check WebSocket subscription logs

### Provider Not Connected

```bash
# Check Vayu login status
curl https://marketdata.vedpragya.com/api/auth/vayu/login

# Check Falcon login status
curl https://marketdata.vedpragya.com/api/auth/falcon/login
```

## Automation Script

Create a script `setup-streaming.sh`:

```bash
#!/bin/bash

ADMIN_TOKEN="your-admin-token"
BASE_URL="https://marketdata.vedpragya.com"

echo "Setting provider to Vayu..."
curl -s -X POST "$BASE_URL/api/admin/provider/global" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"provider": "vortex"}'

echo ""
echo "Starting streaming..."
curl -s -X POST "$BASE_URL/api/admin/provider/stream/start" \
  -H "x-admin-token: $ADMIN_TOKEN"

echo ""
echo "Checking status..."
curl -s "$BASE_URL/api/admin/stream/status" \
  -H "x-admin-token: $ADMIN_TOKEN" | jq

echo ""
echo "✅ Streaming setup complete!"
```

Make it executable:
```bash
chmod +x setup-streaming.sh
./setup-streaming.sh
```

