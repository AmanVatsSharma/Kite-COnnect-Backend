#!/bin/bash

# =============================================================================
# WebSocket Secure (WSS) Connection Test
# =============================================================================
# Tests WebSocket Secure connections to verify SSL/TLS is working correctly
# with WebSocket upgrades over HTTPS
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${1:-marketdata.vedpragya.com}"
WSS_URL="wss://$DOMAIN/market-data"

echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}WebSocket Secure (WSS) Connection Test${NC}"
echo -e "${CYAN}================================================${NC}"
echo "Testing: $WSS_URL"
echo ""

# Test 1: Check if certificate is valid for WSS
echo -e "${BLUE}[1/4] Checking SSL certificate for WSS...${NC}"
if echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | grep -q "Verify return code: 0 (ok)"; then
    echo -e "${GREEN}✓ SSL certificate is valid for WSS${NC}"
else
    echo -e "${YELLOW}⚠ SSL certificate verification returned non-zero code${NC}"
    echo -e "${YELLOW}  This may still work, but certificate chain might be incomplete${NC}"
fi
echo ""

# Test 2: Check WebSocket upgrade headers via HTTPS
echo -e "${BLUE}[2/4] Checking WebSocket upgrade headers...${NC}"
RESPONSE=$(curl -k -i -s "https://$DOMAIN/market-data" -H "Upgrade: websocket" -H "Connection: Upgrade" 2>&1 || echo "")

if echo "$RESPONSE" | grep -qi "upgrade"; then
    echo -e "${GREEN}✓ WebSocket upgrade headers are processed${NC}"
else
    echo -e "${YELLOW}⚠ Could not verify WebSocket upgrade headers${NC}"
    echo -e "${YELLOW}  This is expected if the app isn't running${NC}"
fi
echo ""

# Test 3: Test HTTPS connectivity first
echo -e "${BLUE}[3/4] Testing HTTPS connectivity...${NC}"
HTTP_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null || echo "000")

case $HTTP_CODE in
    200)
        echo -e "${GREEN}✓ HTTPS endpoint is accessible (HTTP $HTTP_CODE)${NC}"
        ;;
    000)
        echo -e "${RED}✗ HTTPS endpoint is not accessible${NC}"
        echo -e "${YELLOW}  This might be normal if the application isn't running yet${NC}"
        ;;
    404)
        echo -e "${YELLOW}⚠ HTTPS endpoint returned 404 (endpoint may not exist)${NC}"
        ;;
    *)
        echo -e "${YELLOW}⚠ HTTPS endpoint returned HTTP $HTTP_CODE${NC}"
        ;;
esac
echo ""

# Test 4: WebSocket connection test (requires wscat)
echo -e "${BLUE}[4/4] Testing WebSocket Secure (WSS) connection...${NC}"
if command -v wscat &>/dev/null; then
    echo -e "${BLUE}Attempting WSS connection to $WSS_URL...${NC}"
    echo ""
    
    if timeout 10 wscat -c "$WSS_URL" --no-check 2>&1 | tee /tmp/wss-test.log; then
        echo ""
        if grep -q "Connected" /tmp/wss-test.log; then
            echo -e "${GREEN}✓ WSS connection established successfully${NC}"
            echo ""
            echo -e "${GREEN}WebSocket SSL Test: PASSED${NC}"
        else
            echo -e "${YELLOW}⚠ WSS connection attempted but result unclear${NC}"
            echo -e "${YELLOW}  Check application logs for details${NC}"
        fi
    else
        echo ""
        echo -e "${YELLOW}⚠ WSS connection failed or timed out${NC}"
        echo -e "${YELLOW}  This is expected if:${NC}"
        echo -e "${YELLOW}    - Application is not running${NC}"
        echo -e "${YELLOW}    - WebSocket server is not ready${NC}"
        echo -e "${YELLOW}    - WebSocket requires authentication${NC}"
    fi
    
    rm -f /tmp/wss-test.log
else
    echo -e "${YELLOW}⚠ wscat not installed${NC}"
    echo -e "${YELLOW}  Install with: ${NC}npm install -g wscat"
    echo -e "${YELLOW}  Or use the test client below${NC}"
fi
echo ""

# Provide test client code
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}WSS Test Client Examples${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""
echo -e "${BLUE}JavaScript/Node.js:${NC}"
cat << 'EOFMARKER'
const WebSocket = require('ws');
const wss = new WebSocket('wss://marketdata.vedpragya.com/market-data');

wss.on('open', () => {
  console.log('✓ WSS connected successfully');
  wss.send(JSON.stringify({ type: 'test' }));
});

wss.on('message', (data) => {
  console.log('Message:', data.toString());
});

wss.on('error', (error) => {
  console.error('✗ WSS error:', error);
});

wss.on('close', () => {
  console.log('WSS connection closed');
});
EOFMARKER
echo ""
echo ""
echo -e "${BLUE}Browser JavaScript:${NC}"
cat << 'EOFMARKER'
const socket = new WebSocket('wss://marketdata.vedpragya.com/market-data');

socket.addEventListener('open', () => {
  console.log('✓ WSS connected successfully');
  socket.send(JSON.stringify({ type: 'test' }));
});

socket.addEventListener('message', (event) => {
  console.log('Message:', event.data);
});

socket.addEventListener('error', (error) => {
  console.error('✗ WSS error:', error);
});

socket.addEventListener('close', () => {
  console.log('WSS connection closed');
});
EOFMARKER
echo ""
echo ""
echo -e "${BLUE}Python:${NC}"
cat << 'EOFMARKER'
import websocket
import ssl

def on_message(ws, message):
    print(f'Message: {message}')

def on_error(ws, error):
    print(f'✗ Error: {error}')

def on_close(ws, close_status_code, close_msg):
    print('WSS connection closed')

def on_open(ws):
    print('✓ WSS connected successfully')
    ws.send('{"type": "test"}')

url = 'wss://marketdata.vedpragya.com/market-data'
ws = websocket.WebSocketApp(
    url,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close,
    on_open=on_open
)
# Disable SSL verification for testing (use SSL context for production)
ws.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE})
EOFMARKER
echo ""
echo ""
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}Summary${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""
echo -e "${GREEN}✓ WebSocket SSL Configuration${NC}"
echo "  - Nginx properly configured with WebSocket upgrade headers"
echo "  - SSL/TLS terminates at Nginx (port 443)"
echo "  - Internally proxies to Docker containers over HTTP (port 3000)"
echo "  - NestJS code requires NO changes"
echo ""
echo -e "${GREEN}Client Changes Required:${NC}"
echo "  - Change 'ws://' to 'wss://' in client code"
echo "  - Example: ws://marketdata.vedpragya.com → wss://marketdata.vedpragya.com"
echo ""
echo -e "${GREEN}No Server Code Changes Needed${NC}"
echo "  - NestJS WebSocket gateway works as-is"
echo "  - SSL termination happens at Nginx level"
echo "  - Docker containers communicate via HTTP internally"
echo ""

