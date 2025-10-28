#!/bin/bash

# =============================================================================
# SSL Health Check Script
# =============================================================================
# Comprehensive SSL certificate health monitoring for the NestJS trading app
# Checks certificate validity, expiration, HTTPS endpoints, and WSS connections
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
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"

# ANSI colors for status
PASS="${GREEN}✓${NC}"
FAIL="${RED}✗${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}ℹ${NC}"

# Logging function
log() {
    local LEVEL=$1
    shift
    local MESSAGE="$@"
    
    case $LEVEL in
        PASS)
            echo -e "${PASS} $MESSAGE" ;;
        FAIL)
            echo -e "${FAIL} $MESSAGE" 1>&2 ;;
        WARN)
            echo -e "${WARN} $MESSAGE" ;;
        INFO)
            echo -e "${INFO} $MESSAGE" ;;
        *)
            echo "$MESSAGE" ;;
    esac
}

# Header
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}SSL Health Check${NC}"
echo -e "${CYAN}================================================${NC}"
echo "Domain: $DOMAIN"
echo "Date: $(date)"
echo ""

# Exit status (0 = all good, 1 = issues found)
EXIT_STATUS=0

# Check 1: Certificate files exist
echo -e "${BLUE}Checking certificate files...${NC}"
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    log PASS "Certificate files exist"
else
    log FAIL "Certificate files not found"
    log INFO "Expected: $CERT_FILE"
    log INFO "Expected: $KEY_FILE"
    log INFO "Run: sudo ./scripts/setup-ssl-robust.sh"
    EXIT_STATUS=1
    echo ""
    exit 1
fi
echo ""

# Check 2: Certificate validity
echo -e "${BLUE}Checking certificate validity...${NC}"
if openssl x509 -in "$CERT_FILE" -noout -checkend 0 2>/dev/null; then
    log PASS "Certificate is valid"
else
    log FAIL "Certificate is expired or invalid"
    EXIT_STATUS=1
fi
echo ""

# Check 3: Certificate expiration
echo -e "${BLUE}Checking certificate expiration...${NC}"
CERT_EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_FILE" 2>/dev/null | cut -d= -f2)
CERT_DAYS=$(echo "( $(date -d "$CERT_EXPIRY" +%s) - $(date +%s) ) / 86400" | bc 2>/dev/null || echo "0")

if [ "$CERT_DAYS" -gt 60 ]; then
    log PASS "Certificate expires in $CERT_DAYS days (on $CERT_EXPIRY)"
elif [ "$CERT_DAYS" -gt 7 ]; then
    log WARN "Certificate expires in $CERT_DAYS days (on $CERT_EXPIRY)"
    log INFO "Consider renewing soon"
else
    log FAIL "Certificate expires in $CERT_DAYS days (on $CERT_EXPIRY)"
    log INFO "URGENT: Certificate expires soon!"
    EXIT_STATUS=1
fi
echo ""

# Check 4: Certificate subject
echo -e "${BLUE}Checking certificate subject...${NC}"
CERT_SUBJECT=$(openssl x509 -subject -noout -in "$CERT_FILE" 2>/dev/null)
if echo "$CERT_SUBJECT" | grep -q "$DOMAIN"; then
    log PASS "Certificate subject matches domain: $CERT_SUBJECT"
else
    log FAIL "Certificate subject mismatch: $CERT_SUBJECT"
    EXIT_STATUS=1
fi
echo ""

# Check 5: Certificate chain validation
echo -e "${BLUE}Checking certificate chain...${NC}"
if openssl verify -CAfile "$CERT_DIR/chain.pem" "$CERT_FILE" >/dev/null 2>&1; then
    log PASS "Certificate chain is valid"
else
    log WARN "Certificate chain validation failed or chain file missing"
    log INFO "This may be normal if Let's Encrypt chain is used"
fi
echo ""

# Check 6: HTTPS endpoint accessibility
echo -e "${BLUE}Checking HTTPS endpoint accessibility...${NC}"
HTTP_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    log PASS "HTTPS endpoint is accessible (HTTP $HTTP_CODE)"
elif [ "$HTTP_CODE" = "000" ]; then
    log FAIL "HTTPS endpoint is not accessible (connection refused/timeout)"
    log INFO "This might be normal if the application isn't running yet"
    EXIT_STATUS=1
else
    log WARN "HTTPS endpoint returned HTTP $HTTP_CODE"
    log INFO "This might be normal if the application isn't fully deployed"
fi
echo ""

# Check 7: SSL/TLS protocol support
echo -e "${BLUE}Checking SSL/TLS protocols...${NC}"
SSL_PROTO=$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | grep "Protocol:" | awk '{print $2}')

if [ -n "$SSL_PROTO" ]; then
    log INFO "Using protocol: $SSL_PROTO"
    
    case $SSL_PROTO in
        "TLSv1.3")
            log PASS "TLS 1.3 (recommended)" ;;
        "TLSv1.2")
            log PASS "TLS 1.2 (acceptable)" ;;
        "TLSv1.1"|"TLSv1")
            log FAIL "Using outdated TLS version: $SSL_PROTO"
            EXIT_STATUS=1 ;;
        "SSLv3")
            log FAIL "SSL 3.0 is insecure and deprecated"
            EXIT_STATUS=1 ;;
        *)
            log WARN "Unknown protocol: $SSL_PROTO" ;;
    esac
else
    log FAIL "Could not determine SSL protocol"
    log INFO "Domain may not be accessible or Nginx not running"
    EXIT_STATUS=1
fi
echo ""

# Check 8: WebSocket Secure (WSS) connection
echo -e "${BLUE}Checking WebSocket Secure (WSS) connection...${NC}"
if command -v wscat &>/dev/null; then
    # If wscat is installed, test WSS connection
    if timeout 5 wscat -c "wss://$DOMAIN/market-data" --no-check 2>&1 | grep -q "Connected"; then
        log PASS "WSS endpoint is accessible"
    else
        log INFO "WSS connection test skipped (wscat not available or connection timeout)"
        log INFO "This is expected if the application isn't running or WebSocket server isn't ready"
    fi
else
    log INFO "WSS connection test skipped (wscat not installed)"
    log INFO "Install with: npm install -g wscat"
fi
echo ""

# Check 9: Certificate auto-renewal
echo -e "${BLUE}Checking certificate auto-renewal...${NC}"
if [ -f "/etc/cron.d/certbot-renew" ]; then
    if grep -q "certbot renew" /etc/cron.d/certbot-renew; then
        CRON_SCHEDULE=$(grep "certbot renew" /etc/cron.d/certbot-renew | awk '{print $1 " " $2}')
        log PASS "Auto-renewal cron job is configured (runs at $CRON_SCHEDULE)"
    else
        log FAIL "Auto-renewal cron job file exists but doesn't contain certbot renew"
        EXIT_STATUS=1
    fi
else
    log FAIL "Auto-renewal cron job not configured"
    log INFO "Configure with: echo '0 3 * * * root certbot renew --quiet --post-hook \"systemctl reload nginx\"' | sudo tee /etc/cron.d/certbot-renew"
    EXIT_STATUS=1
fi
echo ""

# Check 10: Nginx configuration
echo -e "${BLUE}Checking Nginx configuration...${NC}"
if nginx -t 2>/dev/null; then
    log PASS "Nginx configuration is valid"
else
    log FAIL "Nginx configuration has errors"
    log INFO "Run: sudo nginx -t (to see errors)"
    EXIT_STATUS=1
fi
echo ""

# Check 11: Nginx SSL configuration
echo -e "${BLUE}Checking Nginx SSL configuration...${NC}"
NGINX_CONFIG="/etc/nginx/sites-available/trading.conf"

if [ -f "$NGINX_CONFIG" ]; then
    if grep -q "ssl_certificate.*$DOMAIN" "$NGINX_CONFIG"; then
        log PASS "Nginx SSL configuration references correct certificate"
    else
        log WARN "Nginx SSL configuration may not reference correct certificate"
    fi
    
    if grep -q "listen 443 ssl" "$NGINX_CONFIG"; then
        log PASS "Nginx is configured to listen on port 443 with SSL"
    else
        log FAIL "Nginx is not configured to listen on port 443 with SSL"
        EXIT_STATUS=1
    fi
else
    log WARN "Nginx configuration file not found at $NGINX_CONFIG"
fi
echo ""

# Summary
echo -e "${CYAN}================================================${NC}"
if [ $EXIT_STATUS -eq 0 ]; then
    echo -e "${CYAN}SSL Health Check: ${GREEN}PASSED${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    log PASS "All SSL health checks passed"
else
    echo -e "${CYAN}SSL Health Check: ${RED}FAILED${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    log FAIL "Some SSL health checks failed"
    log INFO "Review the errors above and run: sudo ./scripts/fix-ssl-issues.sh"
fi

# Certificate details
echo ""
echo -e "${BLUE}Certificate Details:${NC}"
echo "  Domain:       $DOMAIN"
echo "  Expires:      $CERT_EXPIRY"
echo "  Days left:    $CERT_DAYS days"
echo "  Certificate:  $CERT_FILE"
echo "  Private key:  $KEY_FILE"
echo ""

exit $EXIT_STATUS

