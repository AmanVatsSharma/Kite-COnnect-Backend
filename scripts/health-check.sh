#!/bin/bash

# =============================================================================
# Health Check Script
# =============================================================================
# Check the health of all services
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

DOMAIN="marketdata.vedpragya.com"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Health Check - Trading App Backend${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Check Docker
echo -e "${YELLOW}Checking Docker...${NC}"
if docker info > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Docker is running${NC}"
else
    echo -e "${RED}✗ Docker is not running${NC}"
    exit 1
fi
echo ""

# Check containers
echo -e "${YELLOW}Checking containers...${NC}"
if docker ps | grep -q trading-app-backend; then
    echo -e "${GREEN}✓ Application container is running${NC}"
else
    echo -e "${RED}✗ Application container is not running${NC}"
fi

if docker ps | grep -q trading-postgres; then
    echo -e "${GREEN}✓ PostgreSQL container is running${NC}"
else
    echo -e "${RED}✗ PostgreSQL container is not running${NC}"
fi

if docker ps | grep -q trading-redis; then
    echo -e "${GREEN}✓ Redis container is running${NC}"
else
    echo -e "${RED}✗ Redis container is not running${NC}"
fi
echo ""

# Check PostgreSQL connectivity
echo -e "${YELLOW}Checking PostgreSQL...${NC}"
if docker exec trading-postgres pg_isready -U trading_user -d trading_app > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL is accepting connections${NC}"
else
    echo -e "${RED}✗ PostgreSQL is not accepting connections${NC}"
fi
echo ""

# Check Redis connectivity
echo -e "${YELLOW}Checking Redis...${NC}"
if docker exec trading-redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis is responding${NC}"
else
    echo -e "${RED}✗ Redis is not responding${NC}"
fi
echo ""

# Check application health endpoint
echo -e "${YELLOW}Checking application health...${NC}"
if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Application is responding${NC}"
    HEALTH_JSON=$(curl -s http://localhost:3000/api/health)
    echo "Health status: $HEALTH_JSON"
else
    echo -e "${RED}✗ Application is not responding${NC}"
fi
echo ""

# Check SSL certificate
echo -e "${YELLOW}Checking SSL certificate...${NC}"
CERT_FILE="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ -f "$CERT_FILE" ]; then
    CERT_EXPIRY=$(openssl x509 -enddate -noout -in $CERT_FILE | cut -d= -f2)
    echo -e "${GREEN}✓ SSL certificate exists${NC}"
    echo "Certificate expires: $CERT_EXPIRY"
else
    echo -e "${RED}✗ SSL certificate not found${NC}"
fi
echo ""

# Check Nginx
echo -e "${YELLOW}Checking Nginx...${NC}"
if systemctl is-active --quiet nginx; then
    echo -e "${GREEN}✓ Nginx is running${NC}"
else
    echo -e "${RED}✗ Nginx is not running${NC}"
fi
echo ""

# Check disk space
echo -e "${YELLOW}Checking disk space...${NC}"
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -lt 80 ]; then
    echo -e "${GREEN}✓ Disk usage: ${DISK_USAGE}%${NC}"
elif [ "$DISK_USAGE" -lt 90 ]; then
    echo -e "${YELLOW}⚠ Disk usage: ${DISK_USAGE}%${NC}"
else
    echo -e "${RED}✗ Disk usage: ${DISK_USAGE}%${NC}"
fi
echo ""

# Check memory
echo -e "${YELLOW}Checking memory...${NC}"
MEM_USAGE=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100}')
if [ "$MEM_USAGE" -lt 80 ]; then
    echo -e "${GREEN}✓ Memory usage: ${MEM_USAGE}%${NC}"
elif [ "$MEM_USAGE" -lt 90 ]; then
    echo -e "${YELLOW}⚠ Memory usage: ${MEM_USAGE}%${NC}"
else
    echo -e "${RED}✗ Memory usage: ${MEM_USAGE}%${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Health Check Complete${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""


