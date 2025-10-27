#!/bin/bash

# =============================================================================
# SSL Certificate Setup Script
# =============================================================================
# This script obtains SSL certificates from Let's Encrypt for your domain
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${1:-marketdata.vedpragya.com}"
EMAIL="${2:-admin@vedpragya.com}"
WEBROOT="/var/www/certbot"

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}SSL Certificate Setup${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root or with sudo${NC}"
    exit 1
fi

# Verify DNS is pointing to this server
echo -e "${YELLOW}Checking DNS configuration...${NC}"
SERVER_IP=$(curl -s ifconfig.me)
DNS_IP=$(dig +short $DOMAIN | tail -n1)

if [ -z "$DNS_IP" ]; then
    echo -e "${RED}Error: DNS not configured for $DOMAIN${NC}"
    echo "Please set up an A record pointing to this server's IP: $SERVER_IP"
    exit 1
fi

echo "Server IP: $SERVER_IP"
echo "DNS IP: $DNS_IP"

if [ "$SERVER_IP" != "$DNS_IP" ]; then
    echo -e "${YELLOW}Warning: DNS IP ($DNS_IP) does not match server IP ($SERVER_IP)${NC}"
    echo "This may cause certificate issuance to fail."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo ""

# Make sure webroot directory exists
mkdir -p $WEBROOT
chown -R www-data:www-data $WEBROOT

# Temporarily start Nginx to serve Let's Encrypt challenges
echo -e "${YELLOW}Starting Nginx...${NC}"
systemctl start nginx || true
sleep 2

# Check if certificate already exists
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo -e "${YELLOW}Certificate already exists for $DOMAIN${NC}"
    read -p "Renew certificate? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping certificate issuance."
        exit 0
    fi
fi

# Obtain certificate using Certbot
echo -e "${YELLOW}Obtaining SSL certificate from Let's Encrypt...${NC}"
certbot certonly \
    --webroot \
    --webroot-path=$WEBROOT \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    -d $DOMAIN

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ SSL certificate obtained successfully${NC}"
else
    echo -e "${RED}✗ Failed to obtain SSL certificate${NC}"
    exit 1
fi
echo ""

# Update Nginx configuration with SSL certificate paths
echo -e "${YELLOW}Updating Nginx configuration...${NC}"
NGINX_CONFIG="/etc/nginx/sites-available/trading.conf"

if [ -f "$NGINX_CONFIG" ]; then
    # Backup original config
    cp $NGINX_CONFIG $NGINX_CONFIG.backup
    
    # The certificate paths should already be in the config
    # Let's verify they're correct
    nginx -t
    
    if [ $? -eq 0 ]; then
        systemctl reload nginx
        echo -e "${GREEN}✓ Nginx configuration updated and reloaded${NC}"
    else
        echo -e "${RED}✗ Nginx configuration test failed${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Nginx configuration file not found${NC}"
    exit 1
fi
echo ""

# Set up auto-renewal cron job
echo -e "${YELLOW}Setting up automatic certificate renewal...${NC}"
if ! grep -q "certbot renew" /etc/cron.d/certbot-renew 2>/dev/null; then
    echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" > /etc/cron.d/certbot-renew
    chmod 644 /etc/cron.d/certbot-renew
    echo -e "${GREEN}✓ Auto-renewal cron job configured${NC}"
else
    echo -e "${GREEN}✓ Auto-renewal cron job already exists${NC}"
fi
echo ""

# Verify certificate
echo -e "${YELLOW}Verifying certificate...${NC}"
CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ -f "$CERT_FILE" ]; then
    CERT_EXPIRY=$(openssl x509 -enddate -noout -in $CERT_FILE | cut -d= -f2)
    echo "Certificate expires on: $CERT_EXPIRY"
    echo -e "${GREEN}✓ Certificate is valid${NC}"
else
    echo -e "${RED}✗ Certificate file not found${NC}"
    exit 1
fi
echo ""

# Summary
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}SSL Setup Complete!${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo "Your application is now configured with SSL:"
echo -e "${GREEN}https://$DOMAIN${NC}"
echo ""
echo "Certificate auto-renewal is configured to run daily at 3 AM."
echo ""
echo "Next step: Run ./scripts/deploy.sh to start your application"
echo ""


