#!/bin/bash

# =============================================================================
# SSL Issues Fix Script
# =============================================================================
# Automated diagnosis and repair for common SSL/TLS issues on EC2
# Comprehensive error handling and recovery procedures
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

# Helper functions
log() {
    local LEVEL=$1
    shift
    local MESSAGE="$@"
    
    case $LEVEL in
        INFO)
            echo -e "${GREEN}[INFO]${NC} $MESSAGE" ;;
        WARN)
            echo -e "${YELLOW}[WARN]${NC} $MESSAGE" ;;
        ERROR)
            echo -e "${RED}[ERROR]${NC} $MESSAGE" 1>&2 ;;
        DEBUG)
            echo -e "${BLUE}[DEBUG]${NC} $MESSAGE" ;;
        *)
            echo "$MESSAGE" ;;
    esac
}

# Diagnostic function
diagnose() {
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}Diagnosing SSL Issues${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    
    ISSUES_FOUND=0
    
    # Check 1: Certificate files
    log INFO "Checking certificate files..."
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo -e "${GREEN}✓${NC} Certificate files exist"
    else
        echo -e "${RED}✗${NC} Certificate files not found"
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
    echo ""
    
    # Check 2: Certificate validity
    log INFO "Checking certificate validity..."
    if [ -f "$CERT_FILE" ]; then
        if openssl x509 -in "$CERT_FILE" -noout -checkend 0 2>/dev/null; then
            echo -e "${GREEN}✓${NC} Certificate is valid"
        else
            echo -e "${RED}✗${NC} Certificate is expired or invalid"
            ISSUES_FOUND=$((ISSUES_FOUND + 1))
        fi
    fi
    echo ""
    
    # Check 3: Nginx configuration
    log INFO "Checking Nginx configuration..."
    if nginx -t 2>/dev/null; then
        echo -e "${GREEN}✓${NC} Nginx configuration is valid"
    else
        echo -e "${RED}✗${NC} Nginx configuration has errors"
        nginx -t
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
    echo ""
    
    # Check 4: Nginx service status
    log INFO "Checking Nginx service status..."
    if systemctl is-active --quiet nginx; then
        echo -e "${GREEN}✓${NC} Nginx is running"
    else
        echo -e "${RED}✗${NC} Nginx is not running"
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
    echo ""
    
    # Check 5: Port 443 accessibility
    log INFO "Checking port 443..."
    if netstat -tuln | grep -q ":443 "; then
        echo -e "${GREEN}✓${NC} Port 443 is listening"
    else
        echo -e "${RED}✗${NC} Port 443 is not listening"
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
    echo ""
    
    # Check 6: SSL certificate permissions
    log INFO "Checking certificate permissions..."
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        CERT_PERMS=$(stat -c "%a" "$KEY_FILE")
        if [ "$CERT_PERMS" = "600" ] || [ "$CERT_PERMS" = "640" ]; then
            echo -e "${GREEN}✓${NC} Certificate permissions are secure"
        else
            echo -e "${YELLOW}⚠${NC} Certificate permissions may be too open ($CERT_PERMS)"
        fi
    fi
    echo ""
    
    # Summary
    if [ $ISSUES_FOUND -eq 0 ]; then
        echo -e "${GREEN}✓${NC} No issues found in basic diagnostics"
    else
        echo -e "${RED}✗${NC} Found $ISSUES_FOUND issue(s)"
    fi
    
    return $ISSUES_FOUND
}

# Fix function - fix common issues
fix_issues() {
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}Fixing SSL Issues${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    
    FIXES_APPLIED=0
    
    # Fix 1: Restart Nginx if not running
    log INFO "Checking Nginx service..."
    if ! systemctl is-active --quiet nginx; then
        log WARN "Nginx is not running, starting it..."
        systemctl start nginx
        if systemctl is-active --quiet nginx; then
            echo -e "${GREEN}✓${NC} Nginx started successfully"
            FIXES_APPLIED=$((FIXES_APPLIED + 1))
        else
            echo -e "${RED}✗${NC} Failed to start Nginx"
        fi
    else
        echo -e "${GREEN}✓${NC} Nginx is already running"
    fi
    echo ""
    
    # Fix 2: Fix certificate permissions
    log INFO "Fixing certificate permissions..."
    if [ -f "$KEY_FILE" ]; then
        CURRENT_PERMS=$(stat -c "%a" "$KEY_FILE")
        if [ "$CURRENT_PERMS" != "600" ]; then
            chmod 600 "$KEY_FILE"
            chmod 644 "$CERT_FILE"
            echo -e "${GREEN}✓${NC} Certificate permissions fixed (now 600)"
            FIXES_APPLIED=$((FIXES_APPLIED + 1))
        else
            echo -e "${GREEN}✓${NC} Certificate permissions already correct"
        fi
    fi
    echo ""
    
    # Fix 3: Reload Nginx configuration
    log INFO "Reloading Nginx configuration..."
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        echo -e "${GREEN}✓${NC} Nginx configuration reloaded"
        FIXES_APPLIED=$((FIXES_APPLIED + 1))
    else
        echo -e "${RED}✗${NC} Cannot reload Nginx - configuration has errors"
        log ERROR "Run 'sudo nginx -t' to see the errors"
    fi
    echo ""
    
    # Fix 4: Verify Nginx is using SSL configuration
    log INFO "Verifying Nginx SSL configuration..."
    NGINX_CONFIG="/etc/nginx/sites-available/trading.conf"
    
    if [ -f "$NGINX_CONFIG" ]; then
        if grep -q "ssl_certificate.*$DOMAIN" "$NGINX_CONFIG"; then
            echo -e "${GREEN}✓${NC} Nginx SSL configuration looks correct"
        else
            echo -e "${YELLOW}⚠${NC} Nginx SSL configuration may need updating"
            log INFO "Run: sudo ./scripts/setup-ssl-robust.sh"
        fi
    fi
    echo ""
    
    # Fix 5: Check firewall
    log INFO "Checking firewall rules..."
    if command -v ufw &>/dev/null; then
        if ufw status | grep -q "443/tcp.*ALLOW"; then
            echo -e "${GREEN}✓${NC} Firewall allows HTTPS (port 443)"
        else
            echo -e "${YELLOW}⚠${NC} Firewall may block HTTPS"
            log INFO "Add rule: sudo ufw allow 443/tcp"
        fi
    fi
    echo ""
    
    # Summary
    echo -e "${CYAN}================================================${NC}"
    if [ $FIXES_APPLIED -gt 0 ]; then
        echo -e "${GREEN}Applied $FIXES_APPLIED fix(es)${NC}"
    else
        echo -e "${BLUE}No fixes needed${NC}"
    fi
    echo -e "${CYAN}================================================${NC}"
    echo ""
}

# Reset function - reset to safe state
reset_ssl() {
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}Resetting SSL Configuration${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    
    read -p "This will reset SSL configuration. Continue? (y/N) " -n 1 -r
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log INFO "Reset cancelled"
        exit 0
    fi
    
    # Backup current configuration
    log INFO "Creating backup..."
    BACKUP_DIR="./ssl-backups/reset_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    
    if [ -f "/etc/nginx/sites-available/trading.conf" ]; then
        cp /etc/nginx/sites-available/trading.conf "$BACKUP_DIR/"
        log INFO "Backed up Nginx configuration"
    fi
    
    # Switch to HTTP-only config
    log INFO "Switching to HTTP-only configuration..."
    cp ./docker/nginx/nginx-http-only.conf /etc/nginx/sites-available/trading.conf
    ln -sf /etc/nginx/sites-available/trading.conf /etc/nginx/sites-enabled/trading.conf
    rm -f /etc/nginx/sites-enabled/default
    
    # Test and reload
    if nginx -t; then
        systemctl reload nginx
        log INFO "Reset to HTTP-only configuration"
    else
        log ERROR "Failed to reset configuration"
        exit 1
    fi
    
    echo ""
    log INFO "SSL configuration has been reset"
    log INFO "Run './scripts/setup-ssl-robust.sh' to set up SSL again"
    echo ""
}

# Main menu
show_menu() {
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}SSL Troubleshooting and Fix Tool${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    echo "1. Diagnose SSL issues"
    echo "2. Fix common SSL issues"
    echo "3. Full diagnose and fix"
    echo "4. Reset SSL configuration (advanced)"
    echo "5. Exit"
    echo ""
    read -p "Choose an option (1-5): " choice
    
    case $choice in
        1)
            diagnose
            ;;
        2)
            fix_issues
            ;;
        3)
            diagnose
            echo ""
            fix_issues
            ;;
        4)
            reset_ssl
            ;;
        5)
            log INFO "Exiting..."
            exit 0
            ;;
        *)
            log ERROR "Invalid option"
            exit 1
            ;;
    esac
}

# Main execution
if [ "$1" = "--diagnose" ]; then
    diagnose
elif [ "$1" = "--fix" ]; then
    fix_issues
elif [ "$1" = "--reset" ]; then
    reset_ssl
elif [ "$1" = "--auto" ]; then
    diagnose
    echo ""
    fix_issues
else
    show_menu
fi

