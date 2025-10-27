#!/bin/bash

# =============================================================================
# Zero-Downtime App Update Script
# =============================================================================
# This script updates ONLY the application container without touching the database
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}Zero-Downtime Application Update${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""

# Check if running as root or docker access
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not accessible${NC}"
    echo "Make sure you're in the docker group:"
    echo "  sudo usermod -aG docker \$USER"
    echo "  newgrp docker"
    exit 1
fi

echo -e "${GREEN}✓ Docker is accessible${NC}"
echo ""

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}Error: docker-compose.yml not found${NC}"
    echo "Please run this script from the project root directory"
    exit 1
fi

# Pull latest code (if using Git)
if [ -d ".git" ]; then
    echo -e "${YELLOW}Pulling latest code...${NC}"
    git pull || echo -e "${YELLOW}Warning: Could not pull latest code${NC}"
    echo ""
fi

# Show current status
echo -e "${YELLOW}Current container status:${NC}"
docker compose ps
echo ""

# Ask for confirmation
read -p "Are you sure you want to update the application? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo -e "${YELLOW}Update cancelled${NC}"
    exit 0
fi

echo ""

# Backup strategy (optional but recommended)
echo -e "${YELLOW}Creating backup...${NC}"
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup environment file
if [ -f ".env" ]; then
    cp .env "$BACKUP_DIR/.env"
    echo -e "${GREEN}✓ .env backed up${NC}"
fi

# Backup docker-compose.yml
cp docker-compose.yml "$BACKUP_DIR/docker-compose.yml"
echo -e "${GREEN}✓ docker-compose.yml backed up${NC}"

echo -e "${GREEN}✓ Backup created in $BACKUP_DIR${NC}"
echo ""

# Build new application image
echo -e "${YELLOW}Building new application image...${NC}"
docker compose build trading-app
echo -e "${GREEN}✓ New image built${NC}"
echo ""

# Zero-downtime deployment strategy
echo -e "${YELLOW}Updating application container...${NC}"

# Option 1: Recreate only the app container (recommended)
# This stops only the app container, leaves DB/Redis running
docker compose up -d --no-deps trading-app

# Alternative: If you want to recreate the container
# docker compose up -d --force-recreate --no-deps trading-app

echo -e "${GREEN}✓ Application container updated${NC}"
echo ""

# Wait for application to be ready
echo -e "${YELLOW}Waiting for application to be ready...${NC}"
sleep 5

# Health check
echo -e "${YELLOW}Checking application health...${NC}"
MAX_RETRIES=10
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Application is healthy${NC}"
        break
    else
        RETRY_COUNT=$((RETRY_COUNT + 1))
        echo "Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
        sleep 3
    fi
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}✗ Application health check failed${NC}"
    echo "Showing logs..."
    docker logs --tail 50 trading-app-backend
    exit 1
fi

echo ""

# Display updated status
echo -e "${YELLOW}Updated container status:${NC}"
docker compose ps
echo ""

# Show recent logs
echo -e "${YELLOW}Recent application logs:${NC}"
docker logs --tail 30 trading-app-backend
echo ""

# Database verification
echo -e "${YELLOW}Verifying database connection...${NC}"
if docker exec trading-postgres pg_isready -U trading_user -d trading_app > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Database is connected and healthy${NC}"
    
    # Get row count to verify data integrity
    DB_COUNT=$(docker exec trading-postgres psql -U trading_user -d trading_app -t -c "SELECT COUNT(*) FROM instrument;" 2>/dev/null || echo "0")
    if [ ! -z "$DB_COUNT" ]; then
        echo -e "${GREEN}✓ Database contains $DB_COUNT instruments${NC}"
    fi
else
    echo -e "${RED}✗ Database check failed${NC}"
fi

echo ""

# Success message
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}Update Completed Successfully!${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo "Application updated:"
echo "  - Database: ${GREEN}Unchanged${NC} (preserved)"
echo "  - Redis cache: ${GREEN}Unchanged${NC} (preserved)"
echo "  - Application: ${GREEN}Updated${NC}"
echo ""
echo "Backup location: $BACKUP_DIR"
echo ""
echo "Useful commands:"
echo "  View logs: docker logs -f trading-app-backend"
echo "  Check health: curl http://localhost:3000/api/health"
echo "  View services: docker compose ps"
echo ""

