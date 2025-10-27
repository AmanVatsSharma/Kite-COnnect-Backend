#!/bin/bash

# =============================================================================
# Logs Script
# =============================================================================
# View logs from various services
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SERVICE="${1:-all}"
LINES="${2:-50}"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Logs Viewer - Trading App Backend${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

case "$SERVICE" in
    app|trading-app)
        echo -e "${YELLOW}Application logs (last $LINES lines):${NC}"
        docker logs --tail $LINES trading-app-backend
        ;;
    postgres|db)
        echo -e "${YELLOW}PostgreSQL logs (last $LINES lines):${NC}"
        docker logs --tail $LINES trading-postgres
        ;;
    redis)
        echo -e "${YELLOW}Redis logs (last $LINES lines):${NC}"
        docker logs --tail $LINES trading-redis
        ;;
    nginx)
        echo -e "${YELLOW}Nginx logs (last $LINES lines):${NC}"
        tail -n $LINES /var/log/nginx/trading_app_error.log
        ;;
    all)
        echo -e "${YELLOW}All containers logs (last $LINES lines):${NC}"
        docker compose logs --tail $LINES
        ;;
    follow|f)
        echo -e "${YELLOW}Following all logs (Ctrl+C to exit):${NC}"
        docker compose logs -f
        ;;
    *)
        echo "Usage: $0 [service] [lines]"
        echo ""
        echo "Services:"
        echo "  app, trading-app  - Application logs"
        echo "  postgres, db       - PostgreSQL logs"
        echo "  redis              - Redis logs"
        echo "  nginx              - Nginx logs"
        echo "  all                - All containers (default)"
        echo "  follow, f          - Follow all logs"
        echo ""
        echo "Examples:"
        echo "  $0                  # View last 50 lines from all services"
        echo "  $0 app 100         # View last 100 lines from application"
        echo "  $0 follow          # Follow all logs"
        ;;
esac

echo ""


