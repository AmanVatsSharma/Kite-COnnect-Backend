#!/bin/bash

# =============================================================================
# Native WebSocket (WSS) Connection Test for /ws
# =============================================================================
# Usage:
#   scripts/test-native-ws.sh marketdata.vedpragya.com YOUR_API_KEY
# =============================================================================

set -e

DOMAIN="${1:-marketdata.vedpragya.com}"
API_KEY="${2:-}"  # Required for auth

if [ -z "$API_KEY" ]; then
  echo "API key required. Usage: scripts/test-native-ws.sh <domain> <api_key>"
  exit 1
fi

WSS_URL="wss://$DOMAIN/ws?api_key=$API_KEY"

echo "Testing native WSS: $WSS_URL"

if ! command -v wscat &>/dev/null; then
  echo "wscat not installed. Install with: npm i -g wscat"
  exit 1
fi

set +e
timeout 10 wscat -c "$WSS_URL" --no-check <<'EOF'
{"event":"ping"}
EOF
RC=$?
set -e

if [ "$RC" -eq 0 ]; then
  echo "✓ Native WSS connection OK"
else
  echo "✗ Native WSS connection failed (exit $RC)"
  exit $RC
fi


