# File:        scripts/run-search-podman.sh
# Module:      Search Stack · Podman Deployment
# Purpose:     Deploy MeiliSearch + search-indexer + search-api via Podman for local dev.
#              Indexer reads universal_instruments from the EC2 Postgres DB in .env,
#              NOT from the docker-compose default (internal postgres container).
#
# Usage:
#   ./scripts/run-search-podman.sh [stop|logs|status|clean]
#
# Side-effects:
#   - Creates podman network kite-search-net
#   - Creates podman volume meili_data
#   - Starts containers: kite-meilisearch, kite-search-indexer, kite-search-api
#   - Builds images kite-search-indexer and kite-search-api from source
#
# Key invariants:
#   - MEILI_MASTER_KEY must exist in .env (this script checks and aborts if missing)
#   - DB_HOST in .env must be the EC2 host — indexer reads universal_instruments from there
#   - NestJS backend must be running on localhost:3000 for LTP hydration
#   - host.containers.internal resolves to the host machine from within Podman containers
#
# Author:      AmanVatsSharma
# Last-updated: 2026-04-30

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
info() { echo -e "${YELLOW}▶ $*${NC}"; }
err()  { echo -e "${RED}✗ $*${NC}" >&2; }
hdr()  { echo -e "${BLUE}════════════════════════════════════════${NC}"; echo -e "${BLUE}  $*${NC}"; echo -e "${BLUE}════════════════════════════════════════${NC}"; }

# ─── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ROOT_DIR}/.env"

NETWORK="kite-search-net"
MEILI_CONTAINER="kite-meilisearch"
INDEXER_CONTAINER="kite-search-indexer"
SEARCHAPI_CONTAINER="kite-search-api"
REDIS_CONTAINER="kite-redis"
MEILI_IMAGE="docker.io/getmeili/meilisearch:v1.8"
INDEXER_IMAGE="kite-search-indexer"
SEARCHAPI_IMAGE="kite-search-api"
MEILI_VOLUME="meili_data"

# ─── Subcommands ──────────────────────────────────────────────────────────────
case "${1:-up}" in
  stop)
    info "Stopping containers..."
    podman stop "$MEILI_CONTAINER" "$INDEXER_CONTAINER" "$SEARCHAPI_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null || true
    ok "Containers stopped"
    exit 0
    ;;
  logs)
    TARGET="${2:-$SEARCHAPI_CONTAINER}"
    info "Streaming logs for $TARGET (Ctrl+C to stop)"
    exec podman logs -f "$TARGET"
    ;;
  status)
    echo ""; info "Container status:"
    podman ps -a --filter "name=kite-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""; info "MeiliSearch index stats (if running):"
    source "$ENV_FILE" 2>/dev/null || true
    curl -fsS -H "Authorization: Bearer ${MEILI_MASTER_KEY:-}" \
      http://localhost:7700/indexes/instruments_v1/stats 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  documents: {d.get(\"numberOfDocuments\",\"?\")}')" || echo "  (index not yet available)"
    exit 0
    ;;
  clean)
    info "Removing all kite search containers and volume..."
    podman stop "$MEILI_CONTAINER" "$INDEXER_CONTAINER" "$SEARCHAPI_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null || true
    podman rm   "$MEILI_CONTAINER" "$INDEXER_CONTAINER" "$SEARCHAPI_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null || true
    podman volume rm "$MEILI_VOLUME" 2>/dev/null || true
    podman network rm "$NETWORK" 2>/dev/null || true
    ok "Clean done"
    exit 0
    ;;
  up)
    ;;  # fall through to main deploy
  *)
    echo "Usage: $0 [up|stop|logs [container]|status|clean]"
    exit 1
    ;;
esac

# ─── Load .env ────────────────────────────────────────────────────────────────
hdr "Search Stack · Podman Deploy"
if [[ ! -f "$ENV_FILE" ]]; then
  err ".env not found at $ENV_FILE"; exit 1
fi

# Source only key=value lines (skip comments and empty lines)
set -o allexport
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | grep -v '^#')
set +o allexport
ok ".env loaded"

# ─── Guards ───────────────────────────────────────────────────────────────────
if [[ -z "${MEILI_MASTER_KEY:-}" ]]; then
  err "MEILI_MASTER_KEY is not set in .env — run: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" then add to .env"
  exit 1
fi
if [[ -z "${DB_HOST:-}" ]]; then
  err "DB_HOST is not set in .env"; exit 1
fi
info "DB target: ${DB_HOST}:${DB_PORT:-5432}/${DB_DATABASE}"
info "MeiliSearch key prefix: ${MEILI_MASTER_KEY:0:8}..."

# ─── Podman network + volume ──────────────────────────────────────────────────
info "Creating network '${NETWORK}' (if not exists)..."
podman network exists "$NETWORK" 2>/dev/null || podman network create "$NETWORK"
ok "Network ready"

info "Creating volume '${MEILI_VOLUME}' (if not exists)..."
podman volume exists "$MEILI_VOLUME" 2>/dev/null || podman volume create "$MEILI_VOLUME"
ok "Volume ready"

# ─── Stop/remove stale containers ─────────────────────────────────────────────
for C in "$MEILI_CONTAINER" "$INDEXER_CONTAINER" "$SEARCHAPI_CONTAINER" "$REDIS_CONTAINER"; do
  if podman container exists "$C" 2>/dev/null; then
    info "Removing stale container: $C"
    podman rm -f "$C" 2>/dev/null || true
  fi
done

# ─── 0. Redis ─────────────────────────────────────────────────────────────────
hdr "0/3 · Redis (LTP cache)"
podman run -d \
  --name "$REDIS_CONTAINER" \
  --network "$NETWORK" \
  redis:7-alpine \
  redis-server --save "" --appendonly no
ok "Redis started (no persistence — cache only)"

# ─── 1. MeiliSearch ───────────────────────────────────────────────────────────
hdr "1/3 · MeiliSearch"
info "Pulling image ${MEILI_IMAGE}..."
podman pull "$MEILI_IMAGE"

podman run -d \
  --name "$MEILI_CONTAINER" \
  --network "$NETWORK" \
  -p 7700:7700 \
  -v "${MEILI_VOLUME}:/meili_data" \
  -e MEILI_ENV=production \
  -e MEILI_MASTER_KEY="${MEILI_MASTER_KEY}" \
  -e MEILI_NO_ANALYTICS=true \
  "$MEILI_IMAGE"
ok "MeiliSearch started on port 7700"

# Wait for MeiliSearch to be ready
info "Waiting for MeiliSearch to be ready..."
for i in $(seq 1 30); do
  if curl -fsS http://localhost:7700/health >/dev/null 2>&1; then
    ok "MeiliSearch is ready"
    break
  fi
  [[ $i -eq 30 ]] && { err "MeiliSearch didn't become ready in 30s"; podman logs "$MEILI_CONTAINER" | tail -20; exit 1; }
  sleep 1
done

# ─── 2. Search Indexer ────────────────────────────────────────────────────────
hdr "2/3 · Search Indexer (backfill from EC2 DB → MeiliSearch)"
info "Building search-indexer image..."
podman build -t "$INDEXER_IMAGE" "${ROOT_DIR}/apps/search-indexer"
ok "Image built"

podman run -d \
  --name "$INDEXER_CONTAINER" \
  --network "$NETWORK" \
  -e DB_HOST="${DB_HOST}" \
  -e DB_PORT="${DB_PORT:-5432}" \
  -e DB_USERNAME="${DB_USERNAME}" \
  -e DB_PASSWORD="${DB_PASSWORD}" \
  -e DB_DATABASE="${DB_DATABASE}" \
  -e MEILI_HOST="http://${MEILI_CONTAINER}:7700" \
  -e MEILI_MASTER_KEY="${MEILI_MASTER_KEY}" \
  -e MEILI_INDEX="instruments_v1" \
  -e INDEXER_MODE="backfill-and-watch" \
  -e INDEXER_BATCH_SIZE="2000" \
  -e INDEXER_POLL_SEC="300" \
  "$INDEXER_IMAGE"
ok "Search indexer started — backfilling universal_instruments from ${DB_HOST}/${DB_DATABASE}"

# ─── 3. Search API ────────────────────────────────────────────────────────────
hdr "3/3 · Search API"
info "Building search-api image..."
podman build -t "$SEARCHAPI_IMAGE" "${ROOT_DIR}/apps/search-api"
ok "Image built"

podman run -d \
  --name "$SEARCHAPI_CONTAINER" \
  --network "$NETWORK" \
  --add-host "host.containers.internal:host-gateway" \
  -p 3002:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e MEILI_HOST_PRIMARY="http://${MEILI_CONTAINER}:7700" \
  -e MEILI_MASTER_KEY="${MEILI_MASTER_KEY}" \
  -e MEILI_INDEX="instruments_v1" \
  -e HYDRATION_BASE_URL="http://host.containers.internal:3000" \
  -e HYDRATION_API_KEY="${HYDRATION_API_KEY:-}" \
  -e REDIS_HOST="${REDIS_CONTAINER}" \
  -e REDIS_PORT="6379" \
  "$SEARCHAPI_IMAGE"
ok "Search API started on port 3002"

# ─── Health checks ────────────────────────────────────────────────────────────
hdr "Health Checks"
info "Waiting for search-api to be ready (up to 30s)..."
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3002/api/health >/dev/null 2>&1; then
    ok "Search API is healthy at http://localhost:3002"
    break
  fi
  [[ $i -eq 30 ]] && { err "Search API didn't start in 30s"; podman logs "$SEARCHAPI_CONTAINER" | tail -30; exit 1; }
  sleep 1
done

# ─── Wait for index ───────────────────────────────────────────────────────────
hdr "Waiting for Index Backfill"
info "Polling MeiliSearch for instruments_v1 documents (max 5 min)..."
info "This takes time proportional to the number of rows in universal_instruments."
DEADLINE=$(($(date +%s) + 300))
while true; do
  DOC_COUNT=$(curl -fsS \
    -H "Authorization: Bearer ${MEILI_MASTER_KEY}" \
    "http://localhost:7700/indexes/instruments_v1/stats" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('numberOfDocuments',0))" 2>/dev/null || echo "0")

  if [[ "$DOC_COUNT" -gt 0 ]]; then
    ok "Index has ${DOC_COUNT} documents — ready!"
    break
  fi

  if [[ $(date +%s) -gt $DEADLINE ]]; then
    info "5 min elapsed. Index may still be building — check indexer logs:"
    echo "  podman logs -f $INDEXER_CONTAINER"
    break
  fi
  echo -ne "  documents: ${DOC_COUNT} (waiting...)  \r"
  sleep 3
done

# ─── Smoke test ───────────────────────────────────────────────────────────────
hdr "Smoke Test"
RESULT=$(curl -fsS "http://localhost:3002/api/search?q=NIFTY&limit=3" 2>/dev/null || echo '{"success":false}')
HITS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo "0")
if [[ "$HITS" -gt 0 ]]; then
  ok "Search returned ${HITS} results for 'NIFTY'"
  echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d.get('data',[]):
    print(f\"  {r.get('canonicalSymbol','?'):30s} ltp={r.get('last_price','null')} status={r.get('priceStatus','?')}\")
" 2>/dev/null || true
else
  info "Search returned 0 results — index may still be building (normal on first run)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
hdr "Deploy Complete"
echo ""
echo "  MeiliSearch:    http://localhost:7700"
echo "  Search API:     http://localhost:3002/api/search?q=SBIN"
echo "  Suggest:        http://localhost:3002/api/search/suggest?q=RELIANCE"
echo "  SSE stream:     curl -N 'http://localhost:3002/api/search/stream?ids=<uirId>'"
echo ""
echo "  Kite login:     GET  http://localhost:3000/api/auth/falcon/login"
echo "  Manual token:   POST http://localhost:3000/api/auth/falcon/exchange-token"
echo ""
echo "  Logs:           ./scripts/run-search-podman.sh logs [container]"
echo "  Status:         ./scripts/run-search-podman.sh status"
echo "  Stop:           ./scripts/run-search-podman.sh stop"
echo ""
ok "Done. Search stack is live."
