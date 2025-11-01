#!/usr/bin/env bash

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[info]${NC} $*"; }
ok() { echo -e "${GREEN}[ok]${NC} $*"; }
err() { echo -e "${RED}[err]${NC} $*" >&2; }

# Config
INDEX="${MEILI_INDEX:-instruments_v1}"

section() {
  echo -e "\n${YELLOW}==> $*${NC}\n"
}

die() {
  err "$*"
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "Missing dependency: $1"
}

require docker
require sed

# Helper: run curl to Meili from inside search-api (has MEILI_MASTER_KEY)
mget() {
  local path="$1"
  docker compose exec -T search-api sh -lc \
    'curl -sS -m 5 -H "Authorization: Bearer $MEILI_MASTER_KEY" "http://meilisearch:7700'"$path"'"'
}

mpost() {
  local path="$1"; shift
  local data="$1"
  docker compose exec -T search-api sh -lc \
    'curl -sS -m 8 -H "Authorization: Bearer $MEILI_MASTER_KEY" -H "Content-Type: application/json" -X POST "http://meilisearch:7700'"$path"'" -d '"$data"''
}

# Helper: run SQL on Postgres service and return single integer result
psql_val() {
  local sql="$1"
  docker compose exec -T trading-postgres psql -U trading_user -d trading_app -At -c "$sql" 2>/dev/null | tr -d '\r' | head -n1
}

section "Check Meilisearch health"
if ! mget "/health" >/dev/null; then
  die "Meilisearch health check failed"
fi
ok "Meilisearch is healthy"

section "Get index stats ($INDEX)"
STATS_JSON="$(mget "/indexes/$INDEX/stats" || true)"
if [[ -z "$STATS_JSON" ]]; then
  die "Failed to fetch index stats for $INDEX"
fi
NUM_DOCS="$(echo "$STATS_JSON" | sed -n 's/.*"numberOfDocuments"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' | head -n1)"
NUM_DOCS="${NUM_DOCS:-0}"
info "Meili numberOfDocuments = $NUM_DOCS"

section "Facet coverage (instrumentType, segment, vortexExchange)"
FACET_REQ='{ "q": "", "limit": 0, "facets": ["instrumentType","segment","vortexExchange"] }'
FACETS_JSON="$(mpost "/indexes/$INDEX/search" "$FACET_REQ" || true)"
if [[ -z "$FACETS_JSON" ]]; then
  die "Failed to fetch facet distributions"
fi
has_non_empty() {
  local key="$1"
  echo "$FACETS_JSON" | grep -q '"'"$key"'":{[^}]' || return 1
}

missing_facets=()
for key in instrumentType segment vortexExchange; do
  if has_non_empty "$key"; then
    ok "Facet $key has values"
  else
    missing_facets+=("$key")
    err "Facet $key is empty"
  fi
done

section "Postgres counts"
DB_TOTAL=$(psql_val "SELECT COUNT(*) FROM instruments;")
DB_IT_NONEMPTY=$(psql_val "SELECT COUNT(*) FROM instruments WHERE instrument_type IS NOT NULL AND LENGTH(TRIM(instrument_type)) > 0;")
DB_SEG_NONEMPTY=$(psql_val "SELECT COUNT(*) FROM instruments WHERE segment IS NOT NULL AND LENGTH(TRIM(segment)) > 0;")
VORTEX_TOTAL=$(psql_val "SELECT COUNT(*) FROM vortex_instruments;")

info "DB instruments total = $DB_TOTAL"
info "DB instrument_type non-empty = $DB_IT_NONEMPTY"
info "DB segment non-empty = $DB_SEG_NONEMPTY"
info "DB vortex_instruments total = $VORTEX_TOTAL"

section "Compare DB vs Meili document count"
if [[ "$NUM_DOCS" -lt 1 || "$DB_TOTAL" -lt 1 ]]; then
  die "Counts look invalid: Meili=$NUM_DOCS DB=$DB_TOTAL"
fi

DELTA=$(( DB_TOTAL - NUM_DOCS ))
if [[ ${DELTA#-} -le 10 ]]; then
  ok "Counts close: DB=$DB_TOTAL Meili=$NUM_DOCS (Δ=$DELTA)"
else
  err "Counts diverge: DB=$DB_TOTAL Meili=$NUM_DOCS (Δ=$DELTA)"
fi

section "Sample 50 instrument tokens and validate presence + fields"
TOKENS=$(docker compose exec -T trading-postgres psql -U trading_user -d trading_app -At -c "SELECT instrument_token FROM instruments ORDER BY random() LIMIT 50;" 2>/dev/null | tr -d '\r')
if [[ -z "$TOKENS" ]]; then
  die "Failed to sample tokens from Postgres"
fi
LIST=$(echo "$TOKENS" | paste -sd, -)
SAMPLE_REQ='{ "q": "", "limit": 1000, "filter": "instrumentToken IN ['"$LIST"']", "attributesToRetrieve": ["instrumentToken","instrumentType","segment","vortexExchange"] }'
SAMPLE_JSON="$(mpost "/indexes/$INDEX/search" "$SAMPLE_REQ" || true)"

HIT_COUNT=$(echo "$SAMPLE_JSON" | grep -o '"instrumentToken"' | wc -l | tr -d ' ')
EXPECTED=$(echo "$TOKENS" | wc -l | tr -d ' ')
if [[ "$HIT_COUNT" -lt "$EXPECTED" ]]; then
  err "Missing docs in Meili for sampled tokens: got $HIT_COUNT / expected $EXPECTED"
else
  ok "All sampled docs present: $HIT_COUNT/$EXPECTED"
fi

MISS_IT=$(echo "$SAMPLE_JSON" | grep -o '"instrumentType":null' | wc -l | tr -d ' ')
MISS_SEG=$(echo "$SAMPLE_JSON" | grep -o '"segment":null' | wc -l | tr -d ' ')
MISS_VEX=$(echo "$SAMPLE_JSON" | grep -o '"vortexExchange":null' | wc -l | tr -d ' ')

if [[ "$MISS_IT" -eq 0 && "$MISS_SEG" -eq 0 && "$MISS_VEX" -eq 0 ]]; then
  ok "Sampled docs have instrumentType/segment/vortexExchange populated"
else
  err "Sampled docs missing fields: instrumentType=$MISS_IT segment=$MISS_SEG vortexExchange=$MISS_VEX"
fi

echo
if [[ ${#missing_facets[@]} -eq 0 && ${DELTA#-} -le 10 && "$HIT_COUNT" -ge "$EXPECTED" && "$MISS_IT" -eq 0 && "$MISS_SEG" -eq 0 ]]; then
  ok "Meili ↔ Postgres sync looks healthy"
  exit 0
else
  err "Meili ↔ Postgres sync has issues (see above)"
  exit 1
fi


