#!/bin/bash

# =============================================================================
# Import Instruments CSV into Postgres (instruments table) and trigger indexing
# - Accepts a local CSV path or an HTTP/HTTPS URL
# - Creates/uses instruments_stage for loading, then upserts into instruments
# - Sets is_active=true for all imported rows
# - Restarts search-indexer so Meilisearch gets updated immediately
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

err() { echo -e "${RED}✗ $*${NC}" 1>&2; }
ok()  { echo -e "${GREEN}✓ $*${NC}"; }
info(){ echo -e "${YELLOW}$*${NC}"; }

if [ $# -lt 1 ]; then
  err "Usage: $0 <csv_path_or_url>"
  echo "The CSV must have headers including at least: instrument_token, exchange_token, tradingsymbol, name, segment, exchange, instrument_type, lot_size, tick_size, expiry, strike"
  exit 1
fi

SRC="$1"
TMP="/tmp/instruments_$(date +%s).csv"

if [[ "$SRC" =~ ^https?:// ]]; then
  info "Downloading CSV from URL..."
  curl -fsSL "$SRC" -o "$TMP"
else
  if [ ! -f "$SRC" ]; then err "CSV file not found: $SRC"; exit 1; fi
  cp "$SRC" "$TMP"
fi

ok "CSV ready at $TMP"
info "CSV header preview:"
head -n 2 "$TMP" || true

if ! docker info >/dev/null 2>&1; then err "Docker not accessible"; exit 1; fi
if ! docker ps --format '{{.Names}}' | grep -q '^trading-postgres$'; then
  err "Postgres container 'trading-postgres' not found"; exit 1
fi
ok "Docker and trading-postgres available"

info "Copying CSV into Postgres container..."
docker cp "$TMP" trading-postgres:/tmp/instruments.csv

SQL_SETUP='
CREATE TABLE IF NOT EXISTS instruments_stage (
  instrument_token BIGINT,
  exchange_token BIGINT,
  tradingsymbol TEXT,
  name TEXT,
  last_price NUMERIC,
  expiry TEXT,
  strike NUMERIC,
  tick_size NUMERIC,
  lot_size NUMERIC,
  instrument_type TEXT,
  segment TEXT,
  exchange TEXT
);
TRUNCATE TABLE instruments_stage;
'

info "Preparing staging table..."
docker exec -i trading-postgres psql -U trading_user -d trading_app -v ON_ERROR_STOP=1 -c "$SQL_SETUP"

info "Loading CSV to staging via \copy ..."
docker exec -i trading-postgres psql -U trading_user -d trading_app -v ON_ERROR_STOP=1 -c "\\copy instruments_stage FROM '/tmp/instruments.csv' WITH (FORMAT csv, HEADER true)"

SQL_UPSERT='
INSERT INTO instruments (
  instrument_token, exchange_token, tradingsymbol, name, last_price, expiry, strike, tick_size, lot_size,
  instrument_type, segment, exchange, is_active
)
SELECT
  instrument_token,
  exchange_token,
  tradingsymbol,
  COALESCE(name, ''),
  COALESCE(last_price, 0),
  COALESCE(expiry, ''),
  COALESCE(strike, 0),
  COALESCE(tick_size, 0),
  COALESCE(lot_size, 0),
  COALESCE(instrument_type, ''),
  COALESCE(segment, ''),
  COALESCE(exchange, ''),
  true
FROM instruments_stage
WHERE instrument_token IS NOT NULL
ON CONFLICT (instrument_token) DO UPDATE SET
  exchange_token = EXCLUDED.exchange_token,
  tradingsymbol   = EXCLUDED.tradingsymbol,
  name            = EXCLUDED.name,
  last_price      = EXCLUDED.last_price,
  expiry          = EXCLUDED.expiry,
  strike          = EXCLUDED.strike,
  tick_size       = EXCLUDED.tick_size,
  lot_size        = EXCLUDED.lot_size,
  instrument_type = EXCLUDED.instrument_type,
  segment         = EXCLUDED.segment,
  exchange        = EXCLUDED.exchange,
  is_active       = true;
'

info "Upserting into instruments..."
docker exec -i trading-postgres psql -U trading_user -d trading_app -v ON_ERROR_STOP=1 -c "$SQL_UPSERT"

info "Counts after import:"
docker exec -it trading-postgres psql -U trading_user -d trading_app -c "SELECT COUNT(*) AS total FROM instruments;"
docker exec -it trading-postgres psql -U trading_user -d trading_app -c "SELECT COUNT(*) AS active FROM instruments WHERE is_active = true;"

info "Restarting search-indexer to trigger Meili upserts..."
docker compose restart search-indexer

ok "Done. Tail indexer logs to monitor progress:"
echo "  docker compose logs -f search-indexer"


