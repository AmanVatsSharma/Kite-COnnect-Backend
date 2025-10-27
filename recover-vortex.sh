#!/bin/bash

# Vortex Post-Restart Recovery Script
# This script automatically restores Vortex provider and streaming after system restart

ADMIN_TOKEN="${ADMIN_TOKEN:-admin}"
BASE_URL="http://localhost:3000"
MAX_RETRIES=5
RETRY_DELAY=2

echo "🔄 Vortex Post-Restart Recovery Script"
echo "======================================"

# Function to make API calls with retries
api_call() {
  local method="$1"
  local endpoint="$2"
  local data="$3"
  local retries=0
  
  while [ $retries -lt $MAX_RETRIES ]; do
    if [ -n "$data" ]; then
      response=$(curl -s -X "$method" "$BASE_URL$endpoint" \
        -H "Content-Type: application/json" \
        -H "x-admin-token: $ADMIN_TOKEN" \
        -d "$data" 2>/dev/null)
    else
      response=$(curl -s -X "$method" "$BASE_URL$endpoint" \
        -H "x-admin-token: $ADMIN_TOKEN" 2>/dev/null)
    fi
    
    if echo "$response" | grep -q "success\|provider\|isStreaming"; then
      echo "✅ $endpoint: $response"
      return 0
    else
      echo "⏳ $endpoint: Retry $((retries + 1))/$MAX_RETRIES"
      sleep $RETRY_DELAY
      retries=$((retries + 1))
    fi
  done
  
  echo "❌ $endpoint: Failed after $MAX_RETRIES retries"
  return 1
}

# Step 1: Check if Vortex token exists in database
echo "🔍 Checking for existing Vortex session..."
vortex_status=$(api_call "GET" "/api/admin/debug/vortex")
if echo "$vortex_status" | grep -q "hasAccessToken.*true"; then
  echo "✅ Vortex access token found in database"
else
  echo "❌ No Vortex access token found. Please login first:"
  echo "   GET $BASE_URL/auth/vortex/login"
  exit 1
fi

# Step 2: Set global provider to vortex
echo "🔧 Setting global provider to vortex..."
api_call "POST" "/api/admin/provider/global" '{"provider": "vortex"}'

# Step 3: Start streaming
echo "🚀 Starting market data streaming..."
api_call "POST" "/api/admin/provider/stream/start" ""

# Step 4: Verify streaming status
echo "📊 Checking streaming status..."
api_call "GET" "/api/admin/stream/status" ""

# Step 5: Check Vortex debug info
echo "🔍 Checking Vortex provider status..."
api_call "GET" "/api/admin/debug/vortex" ""

echo ""
echo "🎉 Vortex recovery completed!"
echo "📡 WebSocket should now be connected and ready for client connections"
echo ""
echo "Test with:"
echo "  curl -X GET '$BASE_URL/api/admin/stream/status' -H 'x-admin-token: $ADMIN_TOKEN'"


