#!/bin/bash

# =============================================================================
# Database Fix Script for EC2
# =============================================================================
# This script fixes the missing tables issue on EC2
# =============================================================================

set -e

echo "======================================"
echo "Fixing Database Tables on EC2"
echo "======================================"
echo ""

# Check if containers are running
if ! docker ps | grep -q trading-app-backend; then
    echo "❌ Application container is not running"
    echo "Starting containers..."
    docker compose up -d
    echo "Waiting for containers to be ready..."
    sleep 10
fi

echo "✓ Containers are running"
echo ""

# Restart application to trigger auto-sync
echo "Restarting application to create missing tables..."
docker compose restart trading-app

echo ""
echo "Waiting for application to start..."
sleep 15

# Verify tables were created
echo ""
echo "Checking if tables were created..."
docker exec trading-postgres psql -U trading_user -d trading_app -c "\dt" || echo "⚠ Warning: Could not connect to database"

echo ""
echo "✅ Database fix complete!"
echo ""
echo "Check the application logs:"
echo "  docker logs -f trading-app-backend"
echo ""

