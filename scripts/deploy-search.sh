#!/bin/bash

# =============================================================================
# Deploy Meilisearch + Search API + Indexer (Local EC2, no external deps)
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}Deploying Search Stack (Meilisearch + Search API + Indexer)${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""

err() { echo -e "${RED}✗ $*${NC}" 1>&2; }
ok()  { echo -e "${GREEN}✓ $*${NC}"; }
info(){ echo -e "${YELLOW}$*${NC}"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Command not found: $1"; exit 1; fi
}

port_in_use() {
  local port=$1
  if ss -ltnp 2>/dev/null | grep -q ":${port} "; then return 0; fi
  return 1
}

ensure_meili_key() {
  # Ensure .env exists and MEILI_MASTER_KEY is set; if missing, generate
  if [ ! -f .env ]; then
    info ".env not found, creating one from env.production.example (if present)"
    if [ -f env.production.example ]; then
      cp env.production.example .env
    else
      touch .env
    fi
  fi

  if ! grep -qE '^MEILI_MASTER_KEY=' .env; then
    info "Generating MEILI_MASTER_KEY ..."
    local key
    key=$(openssl rand -base64 32 | tr -d '\n')
    echo "MEILI_MASTER_KEY=${key}" >> .env
    ok "MEILI_MASTER_KEY added to .env"
  else
    ok "MEILI_MASTER_KEY found in .env"
  fi
}

show_compose_ps() {
  echo ""; info "Current container status:"; docker compose ps; echo ""
}

wait_for_http() {
  local url=$1
  local max=${2:-20}
  local delay=${3:-3}
  local i=0
  info "Waiting for ${url} ..."
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i+1))
    if [ $i -ge $max ]; then
      err "Timeout waiting for ${url}"; return 1
    fi
    echo "  attempt ${i}/${max} ..."; sleep "$delay"
  done
  ok "${url} is reachable"
}

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------
require_cmd docker
require_cmd curl
require_cmd openssl
if command -v nginx >/dev/null 2>&1; then HAS_NGINX=1; else HAS_NGINX=0; fi

if ! docker info >/dev/null 2>&1; then
  err "Docker is not accessible (run as root or in docker group)"; exit 1
fi
ok "Docker is accessible"

if [ ! -f docker-compose.yml ]; then
  err "docker-compose.yml not found. Run from project root"; exit 1
fi

# Check host port usage (allow if it's our search-api service)
if port_in_use 3002; then
  if docker compose ps search-api 2>/dev/null | grep -q "0.0.0.0:3002->3000"; then
    ok "Host port 3002 is in use by search-api (expected)"
  else
    err "Host port 3002 is already in use by another process. Free it or change mapping in docker-compose.yml"
    exit 1
  fi
else
  ok "Host port 3002 is free"
fi

# Nginx config presence hint (we don't overwrite; only test/reload)
if [ $HAS_NGINX -eq 1 ]; then
  if ! grep -q "upstream search_api" docker/nginx/nginx.conf; then
    info "Note: repo nginx.conf does not contain search_api upstream (unexpected)"
  fi
fi

# -----------------------------------------------------------------------------
# Environment and build
# -----------------------------------------------------------------------------
ensure_meili_key

info "Building images (meilisearch, search-indexer, search-api) ..."
docker compose build meilisearch search-indexer search-api
ok "Images built"

# -----------------------------------------------------------------------------
# Bring up services
# -----------------------------------------------------------------------------
info "Starting Meilisearch ..."
docker compose up -d meilisearch
ok "Meilisearch started"

info "Starting Search Indexer (backfill-and-watch) ..."
docker compose up -d search-indexer
ok "Search Indexer started"

info "Starting Search API ..."
docker compose up -d search-api
ok "Search API started"

show_compose_ps

# -----------------------------------------------------------------------------
# Health checks
# -----------------------------------------------------------------------------
wait_for_http http://localhost:3002/api/health 30 2

info "Checking Meilisearch health from inside search-api container ..."
if ! docker compose exec -T search-api sh -lc "curl -fsS http://meilisearch:7700/health >/dev/null"; then
  err "Meilisearch health failed from search-api"
  docker compose logs --tail 200 search-api meilisearch | sed 's/^/  /'
  exit 1
fi
ok "Meilisearch is healthy"

info "Verifying index presence (instruments_v1) ..."
if ! docker compose exec -T trading-search-api sh -lc "curl -fsS -H 'Authorization: Bearer '"$(printenv MEILI_MASTER_KEY || true)" http://meilisearch:7700/indexes | grep -q instruments_v1"; then
  info "Index not visible yet; the indexer may still be backfilling. This is OK."
fi

# -----------------------------------------------------------------------------
# Nginx test and reload
# -----------------------------------------------------------------------------
if [ $HAS_NGINX -eq 1 ]; then
  info "Testing Nginx configuration ..."
  if sudo nginx -t; then
    ok "Nginx config is valid"
    info "Reloading Nginx ..." && sudo systemctl reload nginx && ok "Nginx reloaded" || info "Could not reload Nginx"
  else
    err "Nginx configuration test failed. Please fix /etc/nginx configs."
  fi
else
  info "Nginx not installed or not in PATH; skipping Nginx reload"
fi

# -----------------------------------------------------------------------------
# Smoke tests
# -----------------------------------------------------------------------------
SERVER_NAME=$(grep -m1 -E 'server_name\s+' docker/nginx/nginx.conf | awk '{print $2}' | sed 's/;//' || true)
[ -z "$SERVER_NAME" ] && SERVER_NAME="marketdata.vedpragya.com"

info "Smoke test: Direct container port"
curl -fsS http://localhost:3002/api/search?q=SBIN\&limit=1 >/dev/null || info "Search may be empty until indexer completes"
ok "Search API reachable on localhost:3002"

if [ $HAS_NGINX -eq 1 ]; then
  info "Smoke test: Through Nginx https://${SERVER_NAME}/api/search?q=SBIN&limit=1"
  HTTP_CODE=$(curl -ksS -o /dev/null -w "%{http_code}" "https://${SERVER_NAME}/api/search?q=SBIN&limit=1" || true)
  if [ "$HTTP_CODE" = "200" ]; then ok "Nginx route OK (HTTP 200)"; else info "Nginx route responded ${HTTP_CODE}"; fi
fi

# -----------------------------------------------------------------------------
# Logs and summary
# -----------------------------------------------------------------------------
echo ""
info "Tail logs (Ctrl+C to stop):"
echo "  docker compose logs -f search-indexer search-api"
echo ""
ok "Deployment completed"
echo -e "${GREEN}Components:${NC}"
echo "  - Meilisearch:    internal only (no host port)"
echo "  - Search API:     https://${SERVER_NAME}/api/search (host 3002)"
echo "  - Search Indexer: backfill + incremental sync from Postgres (read-only)"
echo ""
echo "If search returns 0 results initially, wait for indexer to finish backfill."


