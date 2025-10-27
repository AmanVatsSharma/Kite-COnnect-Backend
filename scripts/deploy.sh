#!/bin/bash

# =============================================================================
# Deployment Script for Trading App Backend
# =============================================================================
# This script builds and deploys the application using Docker Compose
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

DOMAIN="marketdata.vedpragya.com"

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}Trading App Backend - Deployment Script${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Please create a .env file from env.production.example:"
    echo "  cp env.production.example .env"
    echo "  nano .env"
    exit 1
fi

# Load environment variables
source .env

# Check critical environment variables
echo -e "${YELLOW}Checking environment variables...${NC}"
MISSING_VARS=()

if [ -z "$DB_PASSWORD" ] || [ "$DB_PASSWORD" == "CHANGE_ME_STRONG_PASSWORD_HERE" ]; then
    MISSING_VARS+=("DB_PASSWORD")
fi

if [ -z "$JWT_SECRET" ] || [ "$JWT_SECRET" == "CHANGE_ME_GENERATE_STRONG_JWT_SECRET_HERE" ]; then
    MISSING_VARS+=("JWT_SECRET")
fi

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" == "CHANGE_ME_GENERATE_STRONG_ADMIN_TOKEN_HERE" ]; then
    MISSING_VARS+=("ADMIN_TOKEN")
fi

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo -e "${RED}Error: The following environment variables need to be configured:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Edit your .env file:"
    echo "  nano .env"
    exit 1
fi

echo -e "${GREEN}✓ Environment variables validated${NC}"
echo ""

# Check if Docker is running
echo -e "${YELLOW}Checking Docker...${NC}"
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running${NC}"
    echo "Please start Docker or run the setup script:"
    echo "  sudo ./scripts/setup-ec2.sh"
    exit 1
fi
echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

# Pull latest code (if running from Git)
echo -e "${YELLOW}Checking for updates...${NC}"
if [ -d ".git" ]; then
    git pull || echo -e "${YELLOW}Warning: Could not pull latest code${NC}"
fi
echo ""

# Stop existing containers
echo -e "${YELLOW}Stopping existing containers...${NC}"
docker compose down || true
echo -e "${GREEN}✓ Containers stopped${NC}"
echo ""

# Build Docker images
echo -e "${YELLOW}Building Docker images...${NC}"
docker compose build --no-cache
echo -e "${GREEN}✓ Images built successfully${NC}"
echo ""

# Start services
echo -e "${YELLOW}Starting services...${NC}"
docker compose up -d
echo -e "${GREEN}✓ Services started${NC}"
echo ""

# Wait for services to be healthy
echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
sleep 10

# Check service health
HEALTHY=true

# Check PostgreSQL
if docker exec trading-postgres pg_isready -U trading_user -d trading_app > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL is healthy${NC}"
else
    echo -e "${RED}✗ PostgreSQL is not healthy${NC}"
    HEALTHY=false
fi

# Check Redis
if docker exec trading-redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Redis is healthy${NC}"
else
    echo -e "${RED}✗ Redis is not healthy${NC}"
    HEALTHY=false
fi

# Check Application
sleep 10
if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Application is healthy${NC}"
else
    echo -e "${RED}✗ Application is not responding${NC}"
    HEALTHY=false
fi

echo ""

# Run database migrations (if needed)
echo -e "${YELLOW}Checking database migrations...${NC}"
if [ "$HEALTHY" = true ]; then
    # TypeORM migrations are typically handled automatically
    # But you can run them manually if needed
    echo -e "${GREEN}✓ Database ready${NC}"
else
    echo -e "${YELLOW}⚠ Skipping migrations due to health check failures${NC}"
fi
echo ""

# Display service status
echo -e "${YELLOW}Service Status:${NC}"
docker compose ps
echo ""

# Display logs
echo -e "${YELLOW}Recent logs from application:${NC}"
docker logs --tail 20 trading-app-backend
echo ""

# Summary
if [ "$HEALTHY" = true ]; then
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}Deployment Successful!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo "Your application is now running:"
    echo -e "${BLUE}  API: https://$DOMAIN/api${NC}"
    echo -e "${BLUE}  Health: https://$DOMAIN/api/health${NC}"
    echo -e "${BLUE}  Swagger: https://$DOMAIN/api/docs${NC}"
    echo -e "${BLUE}  Dashboard: https://$DOMAIN/dashboard${NC}"
    echo ""
    echo "Useful commands:"
    echo "  View logs: ./scripts/logs.sh"
    echo "  Check health: ./scripts/health-check.sh"
    echo "  View services: docker compose ps"
    echo "  Stop services: docker compose down"
    echo ""
else
    echo -e "${RED}================================================${NC}"
    echo -e "${RED}Deployment completed with errors${NC}"
    echo -e "${RED}================================================${NC}"
    echo ""
    echo "Please check the logs for more information:"
    echo "  ./scripts/logs.sh"
    echo "  docker logs trading-app-backend"
    echo ""
    exit 1
fi


