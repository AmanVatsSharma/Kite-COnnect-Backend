#!/bin/bash

# =============================================================================
# Debug Script: Meilisearch + Search API + Indexer + Nginx
# Collects health, routes, env, ports, and last logs into a single report.
# Output is tee'd to a timestamped log file in ./logs.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

LOG_DIR="./logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="$LOG_DIR/search_debug_${STAMP}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

ok()    { echo -e "${GREEN}OK${NC}  $*"; }
warn()  { echo -e "${YELLOW}WARN${NC} $*"; }
fail()  { echo -e "${RED}FAIL${NC} $*"; }
section(){ echo -e "\n${BLUE}==== $* ====${NC}\n"; }

cmd(){ echo "+ $*"; eval "$*"; }

section "Host & Ports"
hostname -f || true
echo "Kernel: $(uname -a)"
echo "User: $(id)"
echo "Ports in use (3000/3002/80/443):"
ss -ltnp | grep -E ':(3000|3002|80|443)\b' || true

section "Docker Compose Status"
if ! docker info >/dev/null 2>&1; then
  fail "Docker not accessible"; exit 1
fi
ok "Docker is accessible"
docker compose ps

section "Container Health"
docker inspect -f '{{.Name}} -> {{range .State.Health.Log}}{{println .ExitCode}} {{end}}' trading-search-api 2>/dev/null || true
docker inspect -f '{{.Name}} -> {{.State.Status}}' trading-search-api 2>/dev/null || true
docker inspect -f '{{.Name}} -> {{.State.Status}}' trading-search-indexer 2>/dev/null || true
docker inspect -f '{{.Name}} -> {{.State.Status}}' trading-meilisearch 2>/dev/null || true

section "Direct HTTP checks (host)"
echo "search-api health:"
curl -sS -m 3 http://localhost:3002/api/health || true
echo
echo "search-api test query (may be 200/500 while indexing/auth in progress):"
CODE=$(curl -sS -m 5 -o /tmp/search_body.json -w "%{http_code}" "http://localhost:3002/api/search?q=SBIN&limit=2" || true)
echo "HTTP ${CODE}"
if [ -f /tmp/search_body.json ]; then
  head -n 80 /tmp/search_body.json || true
fi

section "Meilisearch from inside search-api"
if docker compose ps search-api >/dev/null 2>&1; then
  echo "Health:" && docker compose exec -T search-api sh -lc 'curl -sS -m 3 -w "\n%{http_code}\n" http://meilisearch:7700/health || true'
  echo "Indexes (masked key length only):"
  docker compose exec -T search-api sh -lc 'echo -n "MEILI_MASTER_KEY length: "; [ -z "$MEILI_MASTER_KEY" ] && echo 0 || echo ${#MEILI_MASTER_KEY}'
  docker compose exec -T search-api sh -lc 'curl -sS -H "Authorization: Bearer $MEILI_MASTER_KEY" http://meilisearch:7700/indexes || true'
fi

section "Indexer status (last 200 lines)"
docker compose logs --tail 200 search-indexer || true

section "search-api logs (last 200 lines)"
docker compose logs --tail 200 search-api || true

section "meilisearch logs (last 100 lines)"
docker compose logs --tail 100 meilisearch || true

section "Environment (masked)"
echo "From .env:"
if [ -f .env ]; then
  grep -E '^(MEILI_MASTER_KEY|DB_HOST|DB_PORT|DB_DATABASE|REDIS_HOST|REDIS_PORT)=' .env | sed -E 's/(MEILI_MASTER_KEY=).*/\1***MASKED***/'
else
  warn ".env not found"
fi
echo "search-api MEILI_MASTER_KEY length:"
docker compose exec -T search-api sh -lc 'echo ${#MEILI_MASTER_KEY} 2>/dev/null || echo 0' || true

section "Nginx"
if command -v nginx >/dev/null 2>&1; then
  echo "nginx -t:" && sudo nginx -t || true
  echo "Active upstream search_api block (from nginx -T):"
  sudo nginx -T 2>/dev/null | sed -n '/upstream search_api/,/}/p' || true
  echo "Active server block (443) with /api/search location (from nginx -T):"
  sudo nginx -T 2>/dev/null | sed -n '/server_name\s\+marketdata.vedpragya.com/,+220p' | sed -n '/listen 443/,/}/p' | sed -n '/location \/api\//,/}/p' || true
else
  warn "nginx not installed or not in PATH"
fi

section "Summary (possible causes)"
echo "- If search-api HTTP above is 500: likely Meilisearch index missing or auth mismatch; see logs and indexes output."
echo "- If nginx -t fails: fix syntax in upstream search_api and reload."
echo "- If /api/search via HTTPS is 404: Nginx location not active; ensure location /api/search exists in the 443 server block."
echo "- If indexes list is empty: wait for indexer backfill or check indexer errors."

echo
ok "Debug report saved to: $LOG_FILE"


