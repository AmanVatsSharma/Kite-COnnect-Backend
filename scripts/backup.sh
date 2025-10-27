#!/bin/bash

# =============================================================================
# Backup Script
# =============================================================================
# Backup PostgreSQL database, Redis data, and environment configuration
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${TIMESTAMP}"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Backup Script - Trading App Backend${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup PostgreSQL
echo -e "${YELLOW}Backing up PostgreSQL database...${NC}"
PG_BACKUP_FILE="$BACKUP_DIR/${BACKUP_NAME}_postgres.sql"
docker exec trading-postgres pg_dump -U trading_user trading_app > "$PG_BACKUP_FILE"
if [ $? -eq 0 ]; then
    # Compress the backup
    gzip "$PG_BACKUP_FILE"
    echo -e "${GREEN}✓ PostgreSQL backup created: ${PG_BACKUP_FILE}.gz${NC}"
else
    echo -e "${RED}✗ PostgreSQL backup failed${NC}"
fi
echo ""

# Backup Redis
echo -e "${YELLOW}Backing up Redis data...${NC}"
REDIS_BACKUP_FILE="$BACKUP_DIR/${BACKUP_NAME}_redis.rdb"
docker exec trading-redis redis-cli SAVE
docker cp trading-redis:/data/dump.rdb "$REDIS_BACKUP_FILE"
if [ $? -eq 0 ]; then
    # Compress the backup
    gzip "$REDIS_BACKUP_FILE"
    echo -e "${GREEN}✓ Redis backup created: ${REDIS_BACKUP_FILE}.gz${NC}"
else
    echo -e "${RED}✗ Redis backup failed${NC}"
fi
echo ""

# Backup environment configuration
echo -e "${YELLOW}Backing up environment configuration...${NC}"
if [ -f ".env" ]; then
    ENV_BACKUP_FILE="$BACKUP_DIR/${BACKUP_NAME}_env.txt"
    cp .env "$ENV_BACKUP_FILE"
    # Encrypt the backup (optional)
    # gpg -c "$ENV_BACKUP_FILE"
    echo -e "${GREEN}✓ Environment backup created: ${ENV_BACKUP_FILE}${NC}"
else
    echo -e "${YELLOW}⚠ .env file not found${NC}"
fi
echo ""

# Backup SSL certificates (if exists)
echo -e "${YELLOW}Backing up SSL certificates...${NC}"
SSL_DIR="/etc/letsencrypt"
if [ -d "$SSL_DIR" ]; then
    SSL_BACKUP_FILE="$BACKUP_DIR/${BACKUP_NAME}_ssl.tar.gz"
    tar -czf "$SSL_BACKUP_FILE" -C /etc letsencrypt
    echo -e "${GREEN}✓ SSL certificates backup created: ${SSL_BACKUP_FILE}${NC}"
else
    echo -e "${YELLOW}⚠ SSL certificates not found${NC}"
fi
echo ""

# List recent backups
echo -e "${YELLOW}Recent backups:${NC}"
ls -lh "$BACKUP_DIR" | tail -n 10
echo ""

# Clean up old backups (keep last 7 days)
echo -e "${YELLOW}Cleaning up old backups (keeping last 7 days)...${NC}"
find "$BACKUP_DIR" -name "backup_*.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "backup_*.txt" -mtime +7 -delete
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +7 -delete
echo -e "${GREEN}✓ Old backups cleaned up${NC}"
echo ""

# Summary
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Backup Complete${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""
echo "Backup files saved to: $BACKUP_DIR"
echo ""
echo "To restore from backup:"
echo "  # Restore PostgreSQL"
echo "  gunzip < ${PG_BACKUP_FILE}.gz | docker exec -i trading-postgres psql -U trading_user trading_app"
echo ""
echo "  # Restore Redis"
echo "  gunzip ${REDIS_BACKUP_FILE}.gz"
echo "  docker cp ${REDIS_BACKUP_FILE} trading-redis:/data/dump.rdb"
echo "  docker restart trading-redis"
echo ""


