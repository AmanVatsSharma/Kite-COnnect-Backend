#!/bin/bash

# =============================================================================
# Robust SSL Certificate Setup Script
# =============================================================================
# This script provides comprehensive SSL setup with error handling, logging,
# and automatic recovery. It handles Let's Encrypt certificate acquisition
# for the NestJS trading app on EC2.
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${1:-marketdata.vedpragya.com}"
EMAIL="${2:-admin@vedpragya.com}"
WEBROOT="/var/www/certbot"
NGINX_CONFIG_SOURCE="./docker/nginx/nginx-http-only.conf"
NGINX_CONFIG_DEST="/etc/nginx/sites-available/trading-ssl-setup.conf"
BACKUP_DIR="./ssl-backups"

# Logging function
log() {
    local LEVEL=$1
    shift
    local MESSAGE="$@"
    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    
    case $LEVEL in
        INFO)
            echo -e "${GREEN}[$TIMESTAMP] INFO:${NC} $MESSAGE" ;;
        WARN)
            echo -e "${YELLOW}[$TIMESTAMP] WARN:${NC} $MESSAGE" ;;
        ERROR)
            echo -e "${RED}[$TIMESTAMP] ERROR:${NC} $MESSAGE" 1>&2 ;;
        DEBUG)
            echo -e "${BLUE}[$TIMESTAMP] DEBUG:${NC} $MESSAGE" ;;
        *)
            echo -e "[$TIMESTAMP] $MESSAGE" ;;
    esac
}

# Function to check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then 
        log ERROR "This script must be run as root or with sudo"
        exit 1
    fi
}

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to create backup
create_backup() {
    log INFO "Creating backup directory: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    
    # Backup Nginx config if it exists
    if [ -f "/etc/nginx/sites-available/trading.conf" ]; then
        cp /etc/nginx/sites-available/trading.conf "$BACKUP_DIR/trading.conf.backup.$(date +%Y%m%d_%H%M%S)"
        log INFO "Backed up existing Nginx configuration"
    fi
}

# Function to restore backup on failure
restore_backup() {
    log WARN "Attempting to restore backup..."
    local BACKUP_FILE=$(ls -t "$BACKUP_DIR"/*.backup.* 2>/dev/null | head -1)
    if [ -n "$BACKUP_FILE" ]; then
        cp "$BACKUP_FILE" /etc/nginx/sites-available/trading.conf
        systemctl reload nginx 2>/dev/null || true
        log INFO "Backup restored"
    fi
}

# Function to verify DNS configuration
verify_dns() {
    log INFO "Verifying DNS configuration..."
    
    SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s https://ipinfo.io/ip 2>/dev/null)
    DNS_IP=$(dig +short "$DOMAIN" | tail -n1)
    
    log DEBUG "Server IP: $SERVER_IP"
    log DEBUG "DNS IP: $DNS_IP"
    
    if [ -z "$DNS_IP" ]; then
        log ERROR "DNS not configured for $DOMAIN"
        log INFO "Please set up an A record pointing to this server's IP: $SERVER_IP"
        exit 1
    fi
    
    if [ "$SERVER_IP" != "$DNS_IP" ]; then
        log WARN "DNS IP ($DNS_IP) does not match server IP ($SERVER_IP)"
        log WARN "Certificate issuance may fail"
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        log INFO "✓ DNS configured correctly"
    fi
}

# Function to check prerequisites
check_prerequisites() {
    log INFO "Checking prerequisites..."
    
    local MISSING=()
    
    if ! command_exists nginx; then
        MISSING+=("nginx")
    fi
    
    if ! command_exists certbot; then
        MISSING+=("certbot")
    fi
    
    if ! command_exists openssl; then
        MISSING+=("openssl")
    fi
    
    if [ ${#MISSING[@]} -gt 0 ]; then
        log ERROR "Missing required packages: ${MISSING[*]}"
        log INFO "Install with: sudo apt install -y ${MISSING[*]}"
        exit 1
    fi
    
    log INFO "✓ All prerequisites met"
}

# Function to check if port 80 is open
check_port_80() {
    log INFO "Checking if port 80 is accessible..."
    
    if ! command_exists netstat; then
        log WARN "netstat not available, skipping port check"
        return
    fi
    
    if netstat -tuln | grep -q ":80 "; then
        log INFO "✓ Port 80 is open"
    else
        log WARN "Port 80 may not be open. Ensure firewall allows HTTP traffic"
        log INFO "Try: sudo ufw allow 80/tcp"
    fi
}

# Function to set up temporary Nginx config for ACME challenge
setup_temporary_nginx() {
    log INFO "Setting up temporary Nginx configuration for ACME challenge..."
    
    # Create webroot directory
    mkdir -p "$WEBROOT"
    chown -R www-data:www-data "$WEBROOT"
    
    # Copy HTTP-only config
    if [ -f "$NGINX_CONFIG_SOURCE" ]; then
        cp "$NGINX_CONFIG_SOURCE" "$NGINX_CONFIG_DEST"
        log INFO "Temporary Nginx config installed"
    else
        log ERROR "Nginx config not found at $NGINX_CONFIG_SOURCE"
        exit 1
    fi
    
    # Enable the site
    ln -sf "$NGINX_CONFIG_DEST" /etc/nginx/sites-enabled/trading-ssl-setup.conf
    
    # Remove default site
    rm -f /etc/nginx/sites-enabled/default
    
    # Test configuration
    log INFO "Testing Nginx configuration..."
    if nginx -t; then
        log INFO "✓ Nginx configuration is valid"
    else
        log ERROR "Nginx configuration test failed"
        exit 1
    fi
    
    # Start/reload Nginx
    log INFO "Starting Nginx..."
    systemctl start nginx 2>/dev/null || systemctl reload nginx
    sleep 2
    
    if systemctl is-active --quiet nginx; then
        log INFO "✓ Nginx is running"
    else
        log ERROR "Failed to start Nginx"
        exit 1
    fi
}

# Function to obtain SSL certificate
obtain_certificate() {
    log INFO "Obtaining SSL certificate from Let's Encrypt..."
    
    # Check if certificate already exists
    if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
        log WARN "Certificate already exists for $DOMAIN"
        read -p "Renew certificate? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log INFO "Skipping certificate issuance"
            return 0
        fi
    fi
    
    # Run certbot
    log INFO "Running Certbot..."
    if certbot certonly \
        --webroot \
        --webroot-path="$WEBROOT" \
        --email "$EMAIL" \
        --agree-tos \
        --no-eff-email \
        --non-interactive \
        --verbose \
        -d "$DOMAIN"; then
        
        log INFO "✓ SSL certificate obtained successfully"
        return 0
    else
        log ERROR "Failed to obtain SSL certificate"
        return 1
    fi
}

# Function to update Nginx with SSL configuration
update_nginx_with_ssl() {
    log INFO "Updating Nginx with SSL configuration..."
    
    # Copy full SSL config
    if [ -f "./docker/nginx/nginx.conf" ]; then
        cp ./docker/nginx/nginx.conf /etc/nginx/sites-available/trading.conf
        log INFO "SSL Nginx config installed"
    else
        log ERROR "SSL Nginx config not found at ./docker/nginx/nginx.conf"
        exit 1
    fi
    
    # Enable SSL site
    ln -sf /etc/nginx/sites-available/trading.conf /etc/nginx/sites-enabled/trading.conf
    
    # Remove temporary SSL setup config
    rm -f /etc/nginx/sites-enabled/trading-ssl-setup.conf
    
    # Test configuration
    log INFO "Testing Nginx SSL configuration..."
    if nginx -t; then
        log INFO "✓ Nginx SSL configuration is valid"
    else
        log ERROR "Nginx SSL configuration test failed"
        log INFO "Restoring previous configuration..."
        restore_backup
        exit 1
    fi
    
    # Reload Nginx
    log INFO "Reloading Nginx..."
    systemctl reload nginx
    
    if systemctl is-active --quiet nginx; then
        log INFO "✓ Nginx SSL configuration applied successfully"
    else
        log ERROR "Failed to apply Nginx SSL configuration"
        restore_backup
        exit 1
    fi
}

# Function to set up auto-renewal
setup_auto_renewal() {
    log INFO "Setting up automatic certificate renewal..."
    
    if ! grep -q "certbot renew" /etc/cron.d/certbot-renew 2>/dev/null; then
        echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" | tee /etc/cron.d/certbot-renew > /dev/null
        chmod 644 /etc/cron.d/certbot-renew
        log INFO "✓ Auto-renewal cron job configured"
    else
        log INFO "✓ Auto-renewal cron job already exists"
    fi
    
    # Test renewal (dry run)
    log INFO "Testing certificate renewal (dry run)..."
    if certbot renew --dry-run --quiet; then
        log INFO "✓ Auto-renewal test passed"
    else
        log WARN "Auto-renewal test failed, but cron job is configured"
    fi
}

# Function to verify certificate
verify_certificate() {
    log INFO "Verifying SSL certificate..."
    
    CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    
    if [ -f "$CERT_FILE" ]; then
        CERT_EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_FILE" | cut -d= -f2)
        CERT_SUBJECT=$(openssl x509 -subject -noout -in "$CERT_FILE" | cut -d= -f2-)
        
        log INFO "Certificate Subject: $CERT_SUBJECT"
        log INFO "Certificate expires on: $CERT_EXPIRY"
        
        # Check expiration
        CERT_DAYS=$(echo "( $(date -d "$CERT_EXPIRY" +%s) - $(date +%s) ) / 86400" | bc)
        log INFO "Certificate valid for: $CERT_DAYS days"
        
        if [ "$CERT_DAYS" -lt 7 ]; then
            log WARN "Certificate expires in less than 7 days"
        fi
        
        log INFO "✓ Certificate is valid"
    else
        log ERROR "Certificate file not found"
        exit 1
    fi
}

# Function to test HTTPS connectivity
test_https() {
    log INFO "Testing HTTPS connectivity..."
    
    sleep 2
    
    if curl -k -s -o /dev/null -w "%{http_code}" "https://$DOMAIN/api/health" | grep -q "200"; then
        log INFO "✓ HTTPS endpoint is responding"
    else
        log WARN "HTTPS endpoint may not be responding correctly"
        log INFO "This might be normal if the application isn't running yet"
    fi
}

# Main execution
main() {
    log INFO "================================================"
    log INFO "Robust SSL Certificate Setup"
    log INFO "================================================"
    log INFO "Domain: $DOMAIN"
    log INFO "Email: $EMAIL"
    log INFO "================================================"
    echo ""
    
    # Pre-flight checks
    check_root
    check_prerequisites
    check_port_80
    verify_dns
    create_backup
    
    # Setup temporary Nginx for ACME
    setup_temporary_nginx
    
    # Obtain certificate
    if obtain_certificate; then
        log INFO "✓ Certificate obtained successfully"
    else
        log ERROR "Certificate acquisition failed"
        log INFO "Troubleshooting tips:"
        log INFO "  1. Verify DNS is pointing to this server"
        log INFO "  2. Check that port 80 is open and accessible"
        log INFO "  3. Check Nginx logs: sudo tail -f /var/log/nginx/ssl_setup_error.log"
        log INFO "  4. Verify domain ownership"
        restore_backup
        exit 1
    fi
    
    # Update Nginx with SSL config
    update_nginx_with_ssl
    
    # Setup auto-renewal
    setup_auto_renewal
    
    # Verify certificate
    verify_certificate
    
    # Test HTTPS
    test_https
    
    # Summary
    log INFO "================================================"
    log INFO "SSL Setup Complete!"
    log INFO "================================================"
    echo ""
    log INFO "Your application is now configured with SSL:"
    echo -e "${GREEN}  https://$DOMAIN${NC}"
    echo ""
    log INFO "Certificate auto-renewal is configured to run daily at 3 AM"
    echo ""
    log INFO "Useful commands:"
    echo "  Check SSL health:  ./scripts/check-ssl-health.sh"
    echo "  Test HTTPS:        curl -v https://$DOMAIN/api/health"
    echo "  View cert info:    sudo certbot certificates"
    echo "  Manual renewal:    sudo certbot renew"
    echo ""
}

# Run main function
main

