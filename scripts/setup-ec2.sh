#!/bin/bash

# =============================================================================
# EC2 Setup Script for Trading App Backend
# =============================================================================
# This script sets up your EC2 instance with all necessary dependencies
# Run this script once after provisioning your EC2 instance
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="marketdata.vedpragya.com"
NGINX_CONFIG_SOURCE="./docker/nginx/nginx.conf"
NGINX_CONFIG_DEST="/etc/nginx/sites-available/trading.conf"

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}EC2 Setup Script for Trading App Backend${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root or with sudo${NC}"
    exit 1
fi

# Step 1: Update system packages
echo -e "${YELLOW}[1/8] Updating system packages...${NC}"
apt update && apt upgrade -y
echo -e "${GREEN}✓ System packages updated${NC}"
echo ""

# Step 2: Install Docker
echo -e "${YELLOW}[2/8] Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    # Remove old versions
    apt remove -y docker docker-engine docker.io containerd runc || true
    
    # Install prerequisites
    apt install -y ca-certificates curl gnupg lsb-release
    
    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    # Set up the repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker Engine
    apt update
    apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    # Add current user to docker group
    usermod -aG docker $SUDO_USER
    
    echo -e "${GREEN}✓ Docker installed successfully${NC}"
else
    echo -e "${GREEN}✓ Docker already installed${NC}"
fi
echo ""

# Step 3: Install Docker Compose
echo -e "${YELLOW}[3/8] Installing Docker Compose...${NC}"
if ! command -v docker compose &> /dev/null; then
    # Docker Compose V2 is now part of Docker installation above
    # But let's ensure it's working
    docker compose version
    echo -e "${GREEN}✓ Docker Compose installed successfully${NC}"
else
    echo -e "${GREEN}✓ Docker Compose already installed${NC}"
fi
echo ""

# Step 4: Install Nginx
echo -e "${YELLOW}[4/8] Installing Nginx...${NC}"
if ! command -v nginx &> /dev/null; then
    apt install -y nginx
    systemctl enable nginx
    echo -e "${GREEN}✓ Nginx installed successfully${NC}"
else
    echo -e "${GREEN}✓ Nginx already installed${NC}"
fi
echo ""

# Step 5: Install Certbot for SSL
echo -e "${YELLOW}[5/8] Installing Certbot for SSL certificates...${NC}"
if ! command -v certbot &> /dev/null; then
    apt install -y certbot python3-certbot-nginx
    echo -e "${GREEN}✓ Certbot installed successfully${NC}"
else
    echo -e "${GREEN}✓ Certbot already installed${NC}"
fi
echo ""

# Step 6: Configure firewall
echo -e "${YELLOW}[6/8] Configuring firewall (UFW)...${NC}"
ufw --force enable
ufw allow 22/tcp    # SSH
ufw allow 80/tcp     # HTTP
ufw allow 443/tcp    # HTTPS
ufw status
echo -e "${GREEN}✓ Firewall configured${NC}"
echo ""

# Step 7: Set up Nginx directories
echo -e "${YELLOW}[7/8] Setting up Nginx directories...${NC}"
mkdir -p /var/www/certbot
mkdir -p /var/log/nginx
chown -R www-data:www-data /var/www/certbot
chown -R www-data:www-data /var/log/nginx
echo -e "${GREEN}✓ Nginx directories created${NC}"
echo ""

# Step 8: Copy Nginx configuration
echo -e "${YELLOW}[8/8] Copying Nginx configuration...${NC}"
if [ -f "$NGINX_CONFIG_SOURCE" ]; then
    cp "$NGINX_CONFIG_SOURCE" "$NGINX_CONFIG_DEST"
    
    # Create symlink to enable the site
    ln -sf "$NGINX_CONFIG_DEST" /etc/nginx/sites-enabled/trading.conf
    
    # Remove default nginx site if it exists
    rm -f /etc/nginx/sites-enabled/default
    
    # Test Nginx configuration
    nginx -t
    echo -e "${GREEN}✓ Nginx configuration installed${NC}"
else
    echo -e "${RED}Warning: Nginx config file not found at $NGINX_CONFIG_SOURCE${NC}"
    echo -e "${YELLOW}You will need to manually copy the Nginx configuration${NC}"
fi
echo ""

# Summary
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo "Next steps:"
echo "1. Restart your shell session to apply Docker group changes:"
echo "   ${YELLOW}exit${NC}  (then SSH back in)"
echo ""
echo "2. Configure your environment variables:"
echo "   ${YELLOW}cp env.production.example .env${NC}"
echo "   ${YELLOW}nano .env${NC}  (fill in your credentials)"
echo ""
echo "3. Set up SSL certificate:"
echo "   ${YELLOW}./scripts/setup-ssl.sh${NC}"
echo ""
echo "4. Deploy the application:"
echo "   ${YELLOW}./scripts/deploy.sh${NC}"
echo ""
echo -e "${GREEN}Your application will be available at: https://${DOMAIN}${NC}"
echo ""


