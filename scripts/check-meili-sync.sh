#!/usr/bin/env bash
# File:        scripts/check-meili-sync.sh
# Module:      Search · Observability
# Purpose:     Validate that the MeiliSearch instruments_v1 index is in sync with
#              the universal_instruments + instrument_mappings tables in Postgres.
#
# Usage:
#   ./scripts/check-meili-sync.sh
#   MEILI_INDEX=instruments_v2 ./scripts/check-meili-sync.sh
#
# Side-effects:
#   - Read-only: no writes to Meili or Postgres
#   - Exits 0 if sync is healthy, 1 if issues are detected
#
# Key invariants:
#   - Must be run from the project root (docker compose must resolve)
#   - Proxies all Meili calls through the search-api container (which holds MEILI_MASTER_KEY)
#   - Uses 'postgres' service name (not container name 'trading-postgres') for docker compose exec
#
# Author:      BharatERP
# Last-updated: 2026-04-25

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[info]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
err()  { echo -e "${RED}[err]${NC} $*" >&2; }

# Config
INDEX="${MEILI_INDEX:-instruments_v1}"

section() { echo -e "\n${YELLOW}==> $*${NC}\n"; }
die()     { err "$*"; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Missing dependency: $1"; }

require docker
require sed

# ─── Helpers ─────────────────────────────────────────────────────────────────

# Proxy Meili GET through search-api container (holds MEILI_MASTER_KEY in env)
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

# Run SQL on Postgres and return single scalar result
# Uses service name 'postgres', not container_name 'trading-postgres'
psql_val() {
  local sql="$1"
  docker compose exec -T postgres psql -U trading_user -d trading_app -At -c "$sql" 2>/dev/null \
    | tr -d '\r' | head -n1
}

# ─── 1. MeiliSearch health ────────────────────────────────────────────────────

section "Check MeiliSearch health"
if ! mget "/health" >/dev/null; then
  die "MeiliSearch health check failed"
fi
ok "MeiliSearch is healthy"

# ─── 2. Index stats ───────────────────────────────────────────────────────────

section "Get index stats ($INDEX)"
STATS_JSON="$(mget "/indexes/$INDEX/stats" || true)"
if [[ -z "$STATS_JSON" ]]; then
  die "Failed to fetch index stats for $INDEX"
fi
NUM_DOCS="$(echo "$STATS_JSON" | sed -n 's/.*"numberOfDocuments"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' | head -n1)"
NUM_DOCS="${NUM_DOCS:-0}"
info "Meili numberOfDocuments = $NUM_DOCS"

# ─── 3. Facet coverage ────────────────────────────────────────────────────────

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

# ─── 4. Postgres counts (universal_instruments schema) ────────────────────────

section "Postgres counts (universal_instruments)"
DB_TOTAL=$(psql_val "SELECT COUNT(*) FROM universal_instruments WHERE is_active = true;")
DB_IT_NONEMPTY=$(psql_val "SELECT COUNT(*) FROM universal_instruments WHERE is_active = true AND instrument_type IS NOT NULL AND LENGTH(TRIM(instrument_type)) > 0;")
DB_SEG_NONEMPTY=$(psql_val "SELECT COUNT(*) FROM universal_instruments WHERE is_active = true AND segment IS NOT NULL AND LENGTH(TRIM(segment)) > 0;")
VORTEX_MAPPINGS=$(psql_val "SELECT COUNT(*) FROM instrument_mappings WHERE provider = 'vortex';")

info "DB universal_instruments (active)   = $DB_TOTAL"
info "DB instrument_type non-empty        = $DB_IT_NONEMPTY"
info "DB segment non-empty                = $DB_SEG_NONEMPTY"
info "DB vortex mappings (instrument_mappings WHERE provider='vortex') = $VORTEX_MAPPINGS"

# ─── 5. DB vs Meili count delta ───────────────────────────────────────────────

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

# ─── 6. Sample 50 documents and validate field presence ──────────────────────

section "Sample 50 universal instrument IDs and validate presence + fields in Meili"
# IDs are bigint in Postgres but stored as numeric id in Meili (the indexer casts to Number)
SAMPLE_IDS=$(docker compose exec -T postgres psql -U trading_user -d trading_app -At \
  -c "SELECT id FROM universal_instruments WHERE is_active = true ORDER BY random() LIMIT 50;" \
  2>/dev/null | tr -d '\r')

if [[ -z "$SAMPLE_IDS" ]]; then
  die "Failed to sample IDs from universal_instruments"
fi
LIST=$(echo "$SAMPLE_IDS" | paste -sd, -)
# Filter by 'id' — the primary key stored as a number in Meili documents
SAMPLE_REQ='{ "q": "", "limit": 1000, "filter": "id IN ['"$LIST"']", "attributesToRetrieve": ["id","canonicalSymbol","instrumentType","segment","vortexExchange"] }'
SAMPLE_JSON="$(mpost "/indexes/$INDEX/search" "$SAMPLE_REQ" || true)"

HIT_COUNT=$(echo "$SAMPLE_JSON" | grep -o '"id"' | wc -l | tr -d ' ')
EXPECTED=$(echo "$SAMPLE_IDS" | wc -l | tr -d ' ')
if [[ "$HIT_COUNT" -lt "$EXPECTED" ]]; then
  err "Missing docs in Meili for sampled IDs: got $HIT_COUNT / expected $EXPECTED"
else
  ok "All sampled docs present: $HIT_COUNT/$EXPECTED"
fi

MISS_IT=$(echo "$SAMPLE_JSON" | grep -o '"instrumentType":""' | wc -l | tr -d ' ')
MISS_SEG=$(echo "$SAMPLE_JSON" | grep -o '"segment":""' | wc -l | tr -d ' ')
MISS_VEX=$(echo "$SAMPLE_JSON" | grep -o '"vortexExchange":""' | wc -l | tr -d ' ')

if [[ "$MISS_IT" -eq 0 && "$MISS_SEG" -eq 0 && "$MISS_VEX" -eq 0 ]]; then
  ok "Sampled docs have instrumentType/segment/vortexExchange populated"
else
  err "Sampled docs with empty fields: instrumentType=$MISS_IT segment=$MISS_SEG vortexExchange=$MISS_VEX"
fi

# ─── 7. Final verdict ─────────────────────────────────────────────────────────

echo
if [[ ${#missing_facets[@]} -eq 0 && ${DELTA#-} -le 10 && "$HIT_COUNT" -ge "$EXPECTED" && "$MISS_IT" -eq 0 && "$MISS_SEG" -eq 0 ]]; then
  ok "Meili ↔ Postgres sync looks healthy"
  exit 0
else
  err "Meili ↔ Postgres sync has issues (see above)"
  exit 1
fi
