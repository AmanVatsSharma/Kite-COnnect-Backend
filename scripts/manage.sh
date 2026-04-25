#!/usr/bin/env bash
# File:        scripts/manage.sh
# Module:      DevOps · EC2 Management
# Purpose:     One-stop management script for the trading-app Docker stack on EC2.
#              Handles fresh install, update, clean rebuild, status checks, nginx
#              auto-patching, re-indexing MeiliSearch, backups, and log tailing.
#
# Usage:
#   ./scripts/manage.sh                 — interactive menu
#   ./scripts/manage.sh install         — fresh EC2 setup (Docker, env, nginx)
#   ./scripts/manage.sh update          — git pull + rebuild + rolling restart
#   ./scripts/manage.sh clean           — nuclear reset (removes all data volumes)
#   ./scripts/manage.sh status          — health overview + MeiliSearch sync delta
#   ./scripts/manage.sh logs [service]  — tail logs (service menu if omitted)
#   ./scripts/manage.sh reindex         — restart indexer to force full backfill
#   ./scripts/manage.sh nginx           — auto-patch nginx config + reload
#   ./scripts/manage.sh backup          — backup postgres dump + meili data
#   ./scripts/manage.sh stop            — docker compose down (no volume removal)
#
# Side-effects:
#   - install/clean: writes /etc/nginx, installs packages (requires sudo for nginx/Docker)
#   - backup: creates files under ./backups/
#   - reindex: restarts the search-indexer container
#   - update/stop/clean: restarts or stops running containers
#
# Key invariants:
#   - Must be run from the project root (docker-compose.yml must be present)
#   - nginx auto-patch copies docker/nginx/nginx.conf to the system nginx path
#   - All destructive operations require explicit "YES" confirmation
#   - Docker Compose v2 plugin required (docker compose, not docker-compose)
#
# Author:      BharatERP
# Last-updated: 2026-04-25

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
err()  { echo -e "${RED}✗ $*${NC}" >&2; }
info() { echo -e "${YELLOW}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { err "$*"; exit 1; }
sep()  { echo -e "${BLUE}────────────────────────────────────────────────${NC}"; }
hdr()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; sep; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
NGINX_CONF_SRC="$PROJECT_ROOT/docker/nginx/nginx.conf"
BACKUP_DIR="$PROJECT_ROOT/backups"
DOMAIN="${DOMAIN:-marketdata.vedpragya.com}"

# ─── Helpers ─────────────────────────────────────────────────────────────────

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

ensure_project_root() {
  [[ -f "$COMPOSE_FILE" ]] || die "docker-compose.yml not found. Run from project root or check SCRIPT_DIR."
  cd "$PROJECT_ROOT"
}

confirm() {
  local msg="$1"
  local expected="${2:-YES}"
  echo -e "${RED}${msg}${NC}"
  printf "Type %s to confirm: " "$expected"
  read -r answer
  [[ "$answer" == "$expected" ]] || { info "Aborted."; exit 0; }
}

wait_for_http() {
  local url="$1"
  local max="${2:-30}"
  local delay="${3:-3}"
  local i=0
  info "Waiting for $url ..."
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$(( i + 1 ))
    [[ $i -ge $max ]] && { err "Timeout waiting for $url"; return 1; }
    printf "  attempt %d/%d ...\n" "$i" "$max"
    sleep "$delay"
  done
  ok "$url is reachable"
}

# Run a command as root (use sudo if not already root)
sudo_run() { [[ "$(id -u)" == "0" ]] && "$@" || sudo "$@"; }

# ─── Docker install ───────────────────────────────────────────────────────────

ensure_docker() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    ok "Docker is already installed and running"
    return
  fi

  hdr "Installing Docker"
  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect OS (/etc/os-release missing). Install Docker manually."
  fi
  # shellcheck source=/dev/null
  . /etc/os-release

  case "${ID:-}" in
    amzn)
      info "Detected Amazon Linux"
      if [[ "${VERSION_ID:-}" == "2" ]]; then
        sudo_run amazon-linux-extras install docker -y
      else
        # Amazon Linux 2023
        sudo_run dnf install -y docker
      fi
      sudo_run systemctl start docker
      sudo_run systemctl enable docker
      sudo_run usermod -aG docker "${SUDO_USER:-$USER}" || true
      ok "Docker installed (Amazon Linux). You may need to log out and back in for group membership."
      ;;
    ubuntu|debian|linuxmint|pop)
      info "Detected Ubuntu/Debian"
      sudo_run apt-get update -qq
      sudo_run apt-get install -y -qq ca-certificates curl gnupg
      curl -fsSL https://get.docker.com | sudo_run sh
      sudo_run systemctl start docker
      sudo_run systemctl enable docker
      sudo_run usermod -aG docker "${SUDO_USER:-$USER}" || true
      ok "Docker installed (Ubuntu/Debian)"
      ;;
    rhel|centos|fedora|rocky|almalinux)
      info "Detected RHEL/CentOS/Fedora"
      sudo_run dnf install -y dnf-plugins-core
      sudo_run dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      sudo_run dnf install -y docker-ce docker-ce-cli containerd.io
      sudo_run systemctl start docker
      sudo_run systemctl enable docker
      sudo_run usermod -aG docker "${SUDO_USER:-$USER}" || true
      ok "Docker installed (RHEL/CentOS)"
      ;;
    *)
      die "Unsupported OS: ${ID:-unknown}. Install Docker manually: https://docs.docker.com/engine/install/"
      ;;
  esac
}

ensure_compose() {
  if docker compose version &>/dev/null 2>&1; then
    ok "Docker Compose v2 plugin available"
    return
  fi
  # Try installing compose plugin
  info "Docker Compose v2 plugin not found, attempting install ..."
  if command -v apt-get &>/dev/null; then
    sudo_run apt-get install -y -qq docker-compose-plugin
  elif command -v dnf &>/dev/null; then
    sudo_run dnf install -y docker-compose-plugin
  elif command -v yum &>/dev/null; then
    sudo_run yum install -y docker-compose-plugin
  fi
  docker compose version &>/dev/null || die "Docker Compose v2 plugin still not available. See: https://docs.docker.com/compose/install/"
  ok "Docker Compose v2 installed"
}

# ─── Environment setup ────────────────────────────────────────────────────────

setup_env() {
  hdr "Environment Setup"
  if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    if [[ -f "$PROJECT_ROOT/env.production.example" ]]; then
      cp "$PROJECT_ROOT/env.production.example" "$PROJECT_ROOT/.env"
      ok "Created .env from env.production.example"
    else
      touch "$PROJECT_ROOT/.env"
      warn "No env.production.example found; created empty .env"
    fi
  else
    ok ".env already exists"
  fi

  local env_file="$PROJECT_ROOT/.env"

  # Auto-generate secrets if placeholders or missing
  _fill_secret() {
    local key="$1"; local generator="$2"; local placeholder="${3:-CHANGE_ME}"
    if ! grep -qE "^${key}=" "$env_file" || grep -qE "^${key}=${placeholder}" "$env_file" || grep -qE "^${key}=CHANGE_ME" "$env_file"; then
      local val
      val=$(eval "$generator")
      # Remove any existing line with this key, then append
      sed -i "/^${key}=/d" "$env_file"
      echo "${key}=${val}" >> "$env_file"
      ok "Auto-generated ${key}"
    else
      ok "${key} already set"
    fi
  }

  _fill_secret "MEILI_MASTER_KEY"  "openssl rand -base64 32 | tr -d '\\n'"  "CHANGE_ME_GENERATE_STRONG_MEILI_MASTER_KEY"
  _fill_secret "JWT_SECRET"        "openssl rand -base64 48 | tr -d '\\n'"  "CHANGE_ME_GENERATE_STRONG_JWT_SECRET_HERE"
  _fill_secret "ADMIN_TOKEN"       "openssl rand -hex 20"                    "CHANGE_ME_GENERATE_STRONG_ADMIN_TOKEN_HERE"
}

validate_env() {
  hdr "Validating Environment Variables"
  local env_file="$PROJECT_ROOT/.env"
  [[ -f "$env_file" ]] || die ".env file not found. Run: ./scripts/manage.sh install"

  # shellcheck source=/dev/null
  set -a; source "$env_file"; set +a

  local missing=()
  _check_var() {
    local key="$1"; local val="${!key:-}"
    if [[ -z "$val" || "$val" == *"CHANGE_ME"* ]]; then
      missing+=("$key")
    fi
  }
  _check_var "DB_PASSWORD"
  _check_var "JWT_SECRET"
  _check_var "ADMIN_TOKEN"
  _check_var "MEILI_MASTER_KEY"

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "The following env vars need real values (not CHANGE_ME placeholders):"
    for v in "${missing[@]}"; do echo "    $v"; done
    die "Fix .env then retry: nano $env_file"
  fi
  ok "All critical env vars are set"
}

# ─── Port check ───────────────────────────────────────────────────────────────

check_ports() {
  info "Checking required ports ..."
  local blocked=()
  for port in 3000 3002; do
    if ss -ltnp 2>/dev/null | grep -q ":${port} "; then
      # Allow if it's our own container
      if docker compose ps 2>/dev/null | grep -qE "0\.0\.0\.0:${port}->"; then
        ok "Port $port in use by our containers (expected)"
      else
        blocked+=("$port")
      fi
    fi
  done
  if [[ ${#blocked[@]} -gt 0 ]]; then
    warn "Ports already in use by another process: ${blocked[*]}"
    warn "Free them or update port mappings in docker-compose.yml before continuing."
  fi
}

# ─── Nginx ────────────────────────────────────────────────────────────────────

nginx_patch() {
  hdr "Nginx Configuration"
  if ! command -v nginx &>/dev/null; then
    warn "nginx not installed or not in PATH — skipping nginx config"
    return
  fi

  ok "nginx found: $(nginx -v 2>&1 | head -1)"

  # Check if search block is already present in system nginx configs
  if grep -rl "location /api/search" /etc/nginx/ 2>/dev/null | grep -q .; then
    ok "location /api/search already present in system nginx config"
    nginx_reload
    return
  fi

  info "location /api/search not found — installing nginx config from repo ..."
  [[ -f "$NGINX_CONF_SRC" ]] || die "Repo nginx config not found at $NGINX_CONF_SRC"

  # The repo nginx.conf has SSL cert paths hardcoded. If certs are absent, copying it
  # will cause nginx -t to fail — warn loudly and bail rather than break nginx entirely.
  local ssl_cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  if [[ ! -f "$ssl_cert" ]]; then
    warn "SSL certificate not found: $ssl_cert"
    warn "The repo nginx.conf requires a Let's Encrypt cert for ${DOMAIN}."
    warn "Obtain one first, then re-run nginx setup:"
    warn "  sudo certbot --nginx -d ${DOMAIN}"
    warn "  ./scripts/manage.sh nginx"
    warn ""
    warn "Skipping nginx config install — all other services are running."
    return
  fi

  # Detect nginx config layout
  if [[ -d /etc/nginx/sites-available ]]; then
    # Ubuntu/Debian layout
    sudo_run cp "$NGINX_CONF_SRC" /etc/nginx/sites-available/trading-app.conf
    sudo_run ln -sf /etc/nginx/sites-available/trading-app.conf /etc/nginx/sites-enabled/trading-app.conf
    # Remove the default site if it conflicts on port 80/443
    if [[ -L /etc/nginx/sites-enabled/default ]]; then
      sudo_run rm -f /etc/nginx/sites-enabled/default
      info "Removed nginx default site"
    fi
    ok "Installed: /etc/nginx/sites-available/trading-app.conf → sites-enabled"
  elif [[ -d /etc/nginx/conf.d ]]; then
    # Amazon Linux / CentOS layout
    sudo_run cp "$NGINX_CONF_SRC" /etc/nginx/conf.d/trading-app.conf
    ok "Installed: /etc/nginx/conf.d/trading-app.conf"
  else
    # Fallback: copy to nginx.conf directly
    warn "Unknown nginx layout — copying to /etc/nginx/nginx.conf (backup first)"
    sudo_run cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak 2>/dev/null || true
    sudo_run cp "$NGINX_CONF_SRC" /etc/nginx/nginx.conf
    ok "Installed: /etc/nginx/nginx.conf (backup at nginx.conf.bak)"
  fi

  nginx_reload
  echo ""
  ok "Search API is now accessible at: https://${DOMAIN}/api/search"
}

nginx_reload() {
  info "Testing nginx configuration ..."
  if sudo_run nginx -t 2>&1; then
    ok "nginx config is valid"
    if command -v systemctl &>/dev/null && sudo_run systemctl is-active nginx &>/dev/null; then
      sudo_run systemctl reload nginx && ok "nginx reloaded" || warn "Could not reload nginx"
    else
      sudo_run nginx -s reload 2>/dev/null && ok "nginx reloaded" || warn "Could not send reload signal to nginx"
    fi
  else
    err "nginx config test failed — not reloading"
    err "Fix the config then run: sudo nginx -t && sudo systemctl reload nginx"
  fi
}

# ─── Health checks ────────────────────────────────────────────────────────────

wait_services_healthy() {
  echo ""
  wait_for_http "http://localhost:3000/api/health" 40 3
  wait_for_http "http://localhost:3002/api/health" 40 3
}

# ─── Sub-commands ─────────────────────────────────────────────────────────────

do_install() {
  hdr "Fresh Install"
  ensure_project_root
  ensure_docker
  ensure_compose
  setup_env
  validate_env
  check_ports

  hdr "Building & Starting Services"
  docker compose build
  docker compose up -d
  ok "All containers started"

  wait_services_healthy

  nginx_patch

  hdr "Install Complete"
  do_status
  echo ""
  ok "Deployment ready. Indexer is backfilling MeiliSearch in the background."
  info "Watch indexer progress: ./scripts/manage.sh logs search-indexer"
  info "Check sync health:      ./scripts/manage.sh status"
  info "Search API:             https://${DOMAIN}/api/search?q=RELIANCE&limit=5"
}

do_update() {
  hdr "Update & Redeploy"
  ensure_project_root
  validate_env

  if [[ -d "$PROJECT_ROOT/.git" ]]; then
    printf "Pull latest code from git? [y/N] "
    read -r pull_ans
    if [[ "${pull_ans,,}" == "y" ]]; then
      info "Pulling latest ..."
      git -C "$PROJECT_ROOT" pull && ok "git pull done" || warn "git pull failed (continuing)"
    fi
  fi

  info "Rebuilding images (using layer cache) ..."
  docker compose build
  info "Applying updates (Compose restarts only changed containers) ..."
  docker compose up -d
  ok "Update applied"

  wait_services_healthy
  do_status
}

do_clean() {
  hdr "Clean Install (Nuclear Reset)"
  ensure_project_root
  confirm "⚠  WARNING: This will DELETE ALL DATA (postgres, redis, meilisearch volumes) and rebuild from scratch."
  confirm "Are you absolutely sure? This cannot be undone." "YES"

  info "Stopping and removing all containers and volumes ..."
  docker compose down -v || true
  info "Pruning dangling images ..."
  docker system prune -f || true
  ok "Clean complete — all data removed"

  echo ""
  info "Proceeding with fresh install ..."
  do_install
}

do_status() {
  hdr "Service Status"
  ensure_project_root

  echo ""
  docker compose ps
  echo ""

  # Trading app health
  if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then
    ok "trading-app:     http://localhost:3000/api/health  ✓"
  else
    err "trading-app:     http://localhost:3000/api/health  ✗ (not reachable)"
  fi

  # Search API health
  if curl -fsS http://localhost:3002/api/health >/dev/null 2>&1; then
    ok "search-api:      http://localhost:3002/api/health  ✓"
  else
    err "search-api:      http://localhost:3002/api/health  ✗ (not reachable)"
  fi

  # MeiliSearch via container
  MEILI_HEALTH=$(docker compose exec -T search-api sh -lc \
    'curl -sS -m 3 http://meilisearch:7700/health 2>/dev/null || echo "UNREACHABLE"')
  if echo "$MEILI_HEALTH" | grep -q '"status":"available"'; then
    ok "meilisearch:     internal:7700  ✓"
  else
    err "meilisearch:     internal:7700  ✗ ($MEILI_HEALTH)"
  fi

  echo ""
  hdr "Sync Health (Meili ↔ Postgres)"

  # MeiliSearch document count
  INDEX="${MEILI_INDEX:-instruments_v1}"
  STATS_JSON=$(docker compose exec -T search-api sh -lc \
    'curl -sS -m 5 -H "Authorization: Bearer $MEILI_MASTER_KEY" "http://meilisearch:7700/indexes/'"$INDEX"'/stats" 2>/dev/null || echo "{}"')
  MEILI_DOCS=$(echo "$STATS_JSON" | sed -n 's/.*"numberOfDocuments"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' | head -n1)
  MEILI_DOCS="${MEILI_DOCS:-0}"

  # Postgres count
  DB_COUNT=$(docker compose exec -T postgres psql -U trading_user -d trading_app -At \
    -c "SELECT COUNT(*) FROM universal_instruments WHERE is_active = true;" 2>/dev/null \
    | tr -d '\r' | head -n1 || echo "0")

  info "Postgres universal_instruments (active): $DB_COUNT"
  info "MeiliSearch instruments_v1 documents:    $MEILI_DOCS"

  if [[ "$DB_COUNT" -gt 0 && "$MEILI_DOCS" -gt 0 ]]; then
    DELTA=$(( DB_COUNT - MEILI_DOCS ))
    ABS_DELTA="${DELTA#-}"
    if [[ "$ABS_DELTA" -le 10 ]]; then
      ok "Sync healthy (Δ=$DELTA)"
    elif [[ "$ABS_DELTA" -le 1000 ]]; then
      warn "Sync slightly behind (Δ=$DELTA) — indexer may still be catching up"
    else
      err "Sync diverged (Δ=$DELTA) — run: ./scripts/manage.sh reindex"
    fi
  elif [[ "$MEILI_DOCS" -eq 0 ]]; then
    warn "MeiliSearch index empty — indexer may still be running initial backfill"
    info "Watch progress: ./scripts/manage.sh logs search-indexer"
  fi
}

do_logs() {
  ensure_project_root
  local service="${1:-}"

  if [[ -z "$service" ]]; then
    hdr "Select Service"
    echo "  1) trading-app"
    echo "  2) search-api"
    echo "  3) search-indexer"
    echo "  4) meilisearch"
    echo "  5) postgres"
    echo "  6) redis"
    echo "  7) all"
    printf "Choice [1-7]: "
    read -r choice
    case "$choice" in
      1) service="trading-app" ;;
      2) service="search-api" ;;
      3) service="search-indexer" ;;
      4) service="meilisearch" ;;
      5) service="postgres" ;;
      6) service="redis" ;;
      7) service="" ;;
      *) die "Invalid choice" ;;
    esac
  fi

  if [[ -z "$service" ]]; then
    docker compose logs -f --tail=100
  else
    docker compose logs -f --tail=100 "$service"
  fi
}

do_reindex() {
  hdr "Trigger Full MeiliSearch Re-index"
  ensure_project_root
  info "Restarting search-indexer (will run backfill-and-watch) ..."
  docker compose restart search-indexer
  ok "search-indexer restarted"
  echo ""
  info "Tailing indexer logs (press Ctrl+C to stop watching) ..."
  sleep 2
  docker compose logs -f --tail=80 search-indexer
}

do_nginx() {
  ensure_project_root
  nginx_patch
}

do_backup() {
  hdr "Backup"
  ensure_project_root
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d-%H%M)

  # Postgres dump
  local PG_BACKUP="$BACKUP_DIR/postgres-${TIMESTAMP}.sql.gz"
  info "Dumping Postgres → $PG_BACKUP ..."
  docker compose exec -T postgres pg_dump -U trading_user trading_app \
    | gzip > "$PG_BACKUP"
  ok "Postgres backup: $PG_BACKUP ($(du -sh "$PG_BACKUP" | cut -f1))"

  # MeiliSearch data volume
  local MEILI_BACKUP="$BACKUP_DIR/meili-${TIMESTAMP}.tar.gz"
  info "Archiving MeiliSearch data → $MEILI_BACKUP ..."
  # Detect compose project volume name — query docker directly so COMPOSE_PROJECT_NAME
  # overrides and unusual directory names don't break the heuristic.
  VOL_NAME=$(docker volume ls --format '{{.Name}}' | grep '_meili_data' | head -1)
  [[ -n "$VOL_NAME" ]] || die "MeiliSearch volume not found — is the stack running? Start with: docker compose up -d"
  docker run --rm \
    -v "${VOL_NAME}:/meili_data" \
    alpine \
    tar czf - /meili_data \
    > "$MEILI_BACKUP" 2>/dev/null
  ok "MeiliSearch backup: $MEILI_BACKUP ($(du -sh "$MEILI_BACKUP" | cut -f1))"

  echo ""
  ok "Backups saved to $BACKUP_DIR/"
  ls -lh "$BACKUP_DIR/" | tail -10
}

do_stop() {
  hdr "Stop All Services"
  ensure_project_root
  printf "Stop all containers? Data volumes will NOT be removed. [y/N] "
  read -r ans
  [[ "${ans,,}" == "y" ]] || { info "Aborted."; return; }
  docker compose down
  ok "All containers stopped"
}

# ─── Interactive menu ─────────────────────────────────────────────────────────

show_menu() {
  while true; do
    echo ""
    echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║   Trading App · EC2 Management Console       ║${NC}"
    echo -e "${BOLD}${CYAN}║   Project: $(basename "$PROJECT_ROOT")$(printf '%*s' $((34 - ${#PROJECT_ROOT})) '')║${NC}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo "  1) install   — Fresh EC2 setup (Docker, env, nginx, backfill)"
    echo "  2) update    — Pull latest code, rebuild images, rolling restart"
    echo "  3) clean     — ⚠  Nuclear reset (removes ALL data volumes)"
    echo "  4) status    — Health overview + MeiliSearch sync delta"
    echo "  5) logs      — Tail service logs"
    echo "  6) reindex   — Force full MeiliSearch backfill"
    echo "  7) nginx     — Auto-patch nginx config + reload"
    echo "  8) backup    — Backup Postgres + MeiliSearch data"
    echo "  9) stop      — Stop all containers (keep data)"
    echo "  0) quit"
    echo ""
    printf "Choose [0-9]: "
    read -r choice
    case "$choice" in
      1) do_install ;;
      2) do_update ;;
      3) do_clean ;;
      4) do_status ;;
      5) do_logs ;;
      6) do_reindex ;;
      7) do_nginx ;;
      8) do_backup ;;
      9) do_stop ;;
      0) echo "Goodbye."; exit 0 ;;
      *) warn "Invalid choice: $choice" ;;
    esac
  done
}

# ─── Entry point ─────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $(basename "$0") [command] [args]

Commands:
  install         Fresh EC2 setup: Docker, env, services, nginx
  update          Pull + rebuild + rolling restart
  clean           Nuclear reset: removes all data volumes + reinstalls
  status          Health overview + MeiliSearch sync delta
  logs [service]  Tail logs (prompts for service if not specified)
  reindex         Restart indexer to force full MeiliSearch backfill
  nginx           Auto-patch nginx config + reload
  backup          Backup Postgres dump + MeiliSearch data archive
  stop            Stop all containers (data volumes preserved)

No arguments: interactive menu

Environment:
  DOMAIN          Override domain for nginx config (default: ${DOMAIN})
  MEILI_INDEX     MeiliSearch index name (default: instruments_v1)
EOF
}

main() {
  ensure_project_root

  local cmd="${1:-}"
  case "$cmd" in
    install)   do_install ;;
    update)    do_update ;;
    clean)     do_clean ;;
    status)    do_status ;;
    logs)      do_logs "${2:-}" ;;
    reindex)   do_reindex ;;
    nginx)     do_nginx ;;
    backup)    do_backup ;;
    stop)      do_stop ;;
    help|-h|--help) usage ;;
    "")        show_menu ;;
    *)         err "Unknown command: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
