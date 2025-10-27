#!/bin/bash

# =============================================================================
# Vayu Callback Debugging Script
# =============================================================================

set -e

echo "======================================"
echo "Vayu Callback Diagnostics"
echo "======================================"
echo ""

# 1. Check environment variables
echo "1. Checking environment variables..."
echo "-----------------------------------"

source .env 2>/dev/null || echo "Warning: .env file not found"

if [ -z "$VORTEX_APP_ID" ]; then
    echo "❌ VORTEX_APP_ID is not set"
else
    echo "✓ VORTEX_APP_ID is set (length: ${#VORTEX_APP_ID})"
fi

if [ -z "$VORTEX_API_KEY" ]; then
    echo "❌ VORTEX_API_KEY is not set"
else
    echo "✓ VORTEX_API_KEY is set (length: ${#VORTEX_API_KEY})"
fi

if [ -z "$VORTEX_BASE_URL" ]; then
    echo "⚠ VORTEX_BASE_URL is not set (will use default)"
else
    echo "✓ VORTEX_BASE_URL is set: $VORTEX_BASE_URL"
fi

echo ""
echo "2. Checking Docker setup..."
echo "-----------------------------------"

if ! docker ps | grep -q trading-app-backend; then
    echo "❌ Application container is not running"
    echo "Run: docker compose up -d"
else
    echo "✓ Application container is running"
fi

if ! docker ps | grep -q trading-postgres; then
    echo "❌ Database container is not running"
else
    echo "✓ Database container is running"
fi

echo ""
echo "3. Checking database connectivity..."
echo "-----------------------------------"

if docker exec trading-postgres psql -U trading_user -d trading_app -c "SELECT 1" > /dev/null 2>&1; then
    echo "✓ Database connection successful"
    
    # Check if vortex_sessions table exists
    if docker exec trading-postgres psql -U trading_user -d trading_app -c "\d vortex_sessions" > /dev/null 2>&1; then
        echo "✓ vortex_sessions table exists"
        
        # Count existing sessions
        COUNT=$(docker exec trading-postgres psql -U trading_user -d trading_app -t -c "SELECT COUNT(*) FROM vortex_sessions;" 2>/dev/null || echo "0")
        echo "  Existing sessions: $COUNT"
    else
        echo "❌ vortex_sessions table does not exist"
        echo "  Run migrations: docker exec trading-app-backend npm run migration:run"
    fi
else
    echo "❌ Database connection failed"
fi

echo ""
echo "4. Checking application health..."
echo "-----------------------------------"

if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✓ Application is responding"
else
    echo "❌ Application is not responding"
    echo "  Check logs: docker logs trading-app-backend"
fi

echo ""
echo "5. Checking logs for Vayu errors..."
echo "-----------------------------------"
echo "Recent Vayu-related logs:"
docker logs trading-app-backend 2>&1 | grep -i "vayu\|vortex" | tail -20 || echo "No Vayu logs found"

echo ""
echo "======================================"
echo "To view full logs:"
echo "  docker logs -f trading-app-backend"
echo ""
echo "To check database:"
echo "  docker exec -it trading-postgres psql -U trading_user -d trading_app"
echo ""
echo "To restart application:"
echo "  docker compose restart trading-app"
echo "======================================"

