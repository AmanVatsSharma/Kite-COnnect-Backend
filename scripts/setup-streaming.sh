#!/bin/bash

# =============================================================================
# Quick Streaming Setup Script
# =============================================================================

set -e

# Get variables from environment or use defaults
ADMIN_TOKEN=${ADMIN_TOKEN:-"${ADMIN_TOKEN}"}
BASE_URL=${BASE_URL:-"http://localhost:3000"}
PROVIDER=${PROVIDER:-"vortex"}

echo "======================================"
echo "Streaming Setup Script"
echo "======================================"
echo ""

if [ -z "$ADMIN_TOKEN" ]; then
    echo "❌ ERROR: ADMIN_TOKEN not set"
    echo "Set it with: export ADMIN_TOKEN=your-token"
    exit 1
fi

echo "Configuration:"
echo "  Base URL: $BASE_URL"
echo "  Provider: $PROVIDER"
echo ""

# Step 1: Set Provider
echo "📡 Step 1: Setting global provider to $PROVIDER..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/admin/provider/global" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d "{\"provider\": \"$PROVIDER\"}")

if echo "$RESPONSE" | grep -q "success"; then
    echo "✅ Provider set successfully"
else
    echo "❌ Failed to set provider: $RESPONSE"
    exit 1
fi

echo ""

# Step 2: Start Streaming
echo "🚀 Step 2: Starting streaming..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/admin/provider/stream/start" \
  -H "x-admin-token: $ADMIN_TOKEN")

if echo "$RESPONSE" | grep -q "success"; then
    echo "✅ Streaming started successfully"
else
    echo "❌ Failed to start streaming: $RESPONSE"
    exit 1
fi

echo ""

# Step 3: Check Status
echo "📊 Step 3: Checking streaming status..."
STATUS=$(curl -s "$BASE_URL/api/admin/stream/status" \
  -H "x-admin-token: $ADMIN_TOKEN")

echo "$STATUS" | jq '.' 2>/dev/null || echo "$STATUS"

echo ""
echo "======================================"
echo "✅ Streaming setup complete!"
echo "======================================"
echo ""
echo "You can now connect WebSocket clients to receive market data."
echo ""

