#!/usr/bin/env bash
#
# Disk Analysis + Cleanup Utility
# - Generates a comprehensive disk/Docker usage report (saved to logs)
# - Optionally performs a safe cleanup after interactive confirmation (or --approve)
# - Designed for EC2 Docker hosts (e.g., Postgres, Redis, Meilisearch, app)
#
# Usage examples:
#   sudo ./scripts/maintenance/disk-analyze-clean.sh --analyze-only
#   sudo ./scripts/maintenance/disk-analyze-clean.sh                 # analyze -> prompt for cleanup
#   sudo ./scripts/maintenance/disk-analyze-clean.sh --approve       # analyze -> cleanup without prompt
#   sudo ./scripts/maintenance/disk-analyze-clean.sh --approve --threshold-mb=4096
#
# Notes:
# - The script prefers to write reports under ./logs/maintenance; if not writable, falls back to /tmp.
# - Cleanup is conservative and won't remove running containers or attached volumes.
# - Plenty of console logs are provided for later debugging; inline comments explain the flow.

set -Eeuo pipefail

############################################
# Global configuration and defaults
############################################
APPROVE=false
ANALYZE_ONLY=false
OUTPUT_JSON=false
THRESHOLD_MB=3072
LOG_DIR_DEFAULT="./logs/maintenance"
LOG_DIR="$LOG_DIR_DEFAULT"
DOCKER_ENABLED=true
APT_ENABLED=true
JOURNAL_ENABLED=true
PRUNE_VOLUMES=false
LOG_TRUNCATE_THRESHOLD_MB=50

SCRIPT_NAME="$(basename "$0")"
START_TS="$(date +'%Y-%m-%d_%H-%M-%S')"
REPORT_BASENAME="disk-report-${START_TS}.txt"
REPORT_FILE=""
SUDO=sudo
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  SUDO=""
fi

############################################
# Colors and logging helpers
############################################
if [[ -t 1 ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_BOLD=$'\033[1m'
  COLOR_DIM=$'\033[2m'
  COLOR_RED=$'\033[31m'
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_BLUE=$'\033[34m'
else
  COLOR_RESET=""
  COLOR_BOLD=""
  COLOR_DIM=""
  COLOR_RED=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_BLUE=""
fi

ts() { date +'%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }
info() { echo "${COLOR_BLUE}[$(ts)] [INFO]${COLOR_RESET} $*"; }
ok() { echo "${COLOR_GREEN}[$(ts)] [OK]${COLOR_RESET} $*"; }
warn() { echo "${COLOR_YELLOW}[$(ts)] [WARN]${COLOR_RESET} $*"; }
err() { echo "${COLOR_RED}[$(ts)] [ERROR]${COLOR_RESET} $*" >&2; }

############################################
# Error traps
############################################
on_error() {
  local exit_code=$?
  err "Script failed with exit code ${exit_code}"
  if [[ -n "${REPORT_FILE}" && -f "${REPORT_FILE}" ]]; then
    err "Partial report saved to: ${REPORT_FILE}"
  fi
  exit "${exit_code}"
}
trap on_error ERR

############################################
# CLI parsing (long flags)
############################################
print_help() {
  cat <<EOF
${SCRIPT_NAME} - Analyze disk usage and optionally clean up safely

Flags:
  --analyze-only            Perform analysis and save report; no cleanup
  --approve                 Perform cleanup without interactive prompt
  --json                    Print minimal JSON summary to STDOUT
  --threshold-mb=N          Minimum free MB required (default: ${THRESHOLD_MB})
  --log-dir=PATH            Directory for saved reports (default: ${LOG_DIR_DEFAULT}, fallback: /tmp)
  --no-docker               Skip Docker analysis/cleanup
  --no-apt                  Skip apt cache checks/cleanup
  --no-journal              Skip journald checks/cleanup
  --no-volumes              Do not prune Docker volumes (default behavior)
  --prune-volumes           Prune unused Docker volumes during cleanup
  --log-truncate-mb=N       Truncate container logs larger than N MB (default: ${LOG_TRUNCATE_THRESHOLD_MB})
  -h, --help                Show help

Examples:
  sudo ${SCRIPT_NAME} --analyze-only
  sudo ${SCRIPT_NAME} --approve --threshold-mb=4096
EOF
}

for arg in "$@"; do
  case "$arg" in
    --analyze-only) ANALYZE_ONLY=true ;;
    --approve) APPROVE=true ;;
    --json) OUTPUT_JSON=true ;;
    --threshold-mb=*) THRESHOLD_MB="${arg#*=}" ;;
    --log-dir=*) LOG_DIR="${arg#*=}" ;;
    --no-docker) DOCKER_ENABLED=false ;;
    --no-apt) APT_ENABLED=false ;;
    --no-journal) JOURNAL_ENABLED=false ;;
    --no-volumes) PRUNE_VOLUMES=false ;;
    --prune-volumes) PRUNE_VOLUMES=true ;;
    --log-truncate-mb=*) LOG_TRUNCATE_THRESHOLD_MB="${arg#*=}" ;;
    -h|--help) print_help; exit 0 ;;
    *) err "Unknown argument: $arg"; print_help; exit 2 ;;
  esac
done

############################################
# Resolve report path (prefer repo logs/, fallback to /tmp)
############################################
prepare_report_path() {
  local chosen_dir="${LOG_DIR}"
  if ! mkdir -p "${chosen_dir}" 2>/dev/null; then
    warn "Could not create log dir at ${chosen_dir}; falling back to /tmp"
    chosen_dir="/tmp"
    mkdir -p "${chosen_dir}" 2>/dev/null || true
  fi
  REPORT_FILE="${chosen_dir%/}/${REPORT_BASENAME}"
  : > "${REPORT_FILE}" || REPORT_FILE="/tmp/${REPORT_BASENAME}"
  : > "${REPORT_FILE}" || true
  info "Report will be saved to: ${REPORT_FILE}"
}

############################################
# Utility: run and tee to report
############################################
section() {
  local title="$1"
  echo ""
  echo "===== ${title} ====="
}

run_and_capture() {
  # Runs a command and captures both the command and its output into the report.
  # Usage: run_and_capture "Description" -- cmd args...
  local desc="$1"; shift
  local marker=">> $*"
  echo "" | tee -a "${REPORT_FILE}" >/dev/null 2>&1 || true
  echo "### ${desc}" | tee -a "${REPORT_FILE}" >/dev/null 2>&1 || true
  echo "${COLOR_DIM}${marker}${COLOR_RESET}"
  {
    echo ""
    echo "### ${desc}"
    echo "\$ $*"
    "$@"
  } >> "${REPORT_FILE}" 2>&1 || true
}

############################################
# Analysis
############################################
analyze() {
  info "Starting analysis..."
  {
    echo "# Disk Analysis Report"
    echo "- Timestamp: $(ts)"
    echo "- Hostname: $(hostname)"
    echo "- Script: ${SCRIPT_NAME}"
    echo ""
  } >> "${REPORT_FILE}" 2>&1 || true

  section "Disk usage (df -h)"; run_and_capture "Disk usage (df -h)" df -h
  section "Inodes usage (df -i)"; run_and_capture "Inodes usage (df -i)" df -i

  section "Filesystem type and root device"
  run_and_capture "Filesystem types" df -Th
  run_and_capture "Root mount source" findmnt -no SOURCE,FSTYPE /
  run_and_capture "Block devices" lsblk -o NAME,FSTYPE,SIZE,MOUNTPOINT -e7

  section "Top-level disk consumers"
  run_and_capture "Top-level /" bash -lc "du -xhd1 / | sort -h | tail -n 20"
  run_and_capture "Top-level /var" bash -lc "du -xhd1 /var | sort -h | tail -n 20"
  run_and_capture "Top-level /var/lib" bash -lc "du -xhd1 /var/lib | sort -h | tail -n 20"
  run_and_capture "Top-level /usr" bash -lc "du -xhd1 /usr | sort -h | tail -n 20"

  if $DOCKER_ENABLED && command -v docker >/dev/null 2>&1; then
    section "Docker footprint"
    run_and_capture "docker system df" docker system df
    run_and_capture "docker ps (summary)" bash -lc "docker ps --format 'table {{.ID}}\\t{{.Names}}\\t{{.Size}}\\t{{.Status}}'"
    run_and_capture "docker images (top 50)" bash -lc "docker images --format 'table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.ID}}' | head -n 50"
    run_and_capture "docker volumes count" bash -lc "docker volume ls | wc -l"
    run_and_capture "Largest container logs" bash -lc "find /var/lib/docker/containers -name '*-json.log' -printf '%s %p\\n' 2>/dev/null | sort -nr | head -n 20"
  else
    warn "Docker analysis skipped (--no-docker or docker not found)"
  fi

  if $JOURNAL_ENABLED && command -v journalctl >/dev/null 2>&1; then
    section "journald disk usage"
    run_and_capture "journalctl --disk-usage" journalctl --disk-usage
  else
    warn "journald analysis skipped (--no-journal or journalctl not found)"
  fi

  if $APT_ENABLED; then
    section "APT caches"
    run_and_capture "APT cache sizes" bash -lc "du -sh /var/cache/apt 2>/dev/null || true; du -sh /var/lib/apt/lists 2>/dev/null || true"
  else
    warn "APT cache analysis skipped (--no-apt)"
  fi

  section "Language package caches"
  run_and_capture "Node caches" bash -lc "du -sh ~/.npm ~/.cache/yarn 2>/dev/null || true"

  section "Largest files on root filesystem"
  run_and_capture "Find files >100MB" bash -lc "find / -xdev -type f -size +100M -printf '%s\\t%p\\n' 2>/dev/null | sort -nr | head -n 50"

  if command -v lsof >/dev/null 2>&1; then
    section "Deleted but still-open files"
    run_and_capture "lsof +L1 (top lines)" bash -lc "lsof +L1 2>/dev/null | head -n 200"
  else
    warn "lsof not found; skipping deleted-open-files check"
  fi

  ok "Analysis complete. Report saved: ${REPORT_FILE}"
}

############################################
# Cleanup (safe and conservative)
############################################
cleanup_actions() {
  info "Starting cleanup actions..."

  # Snapshot before
  run_and_capture "Pre-cleanup df -h" df -h

  # journald vacuum
  if $JOURNAL_ENABLED && command -v journalctl >/dev/null 2>&1; then
    section "journald vacuum"
    run_and_capture "journalctl --vacuum-size=200M" ${SUDO} journalctl --vacuum-size=200M
  else
    warn "journald cleanup skipped (--no-journal or journalctl not found)"
  fi

  # Remove rotated/compressed logs
  section "Remove rotated/compressed logs (*.gz)"
  run_and_capture "Delete /var/log/*.gz" bash -lc "${SUDO} find /var/log -type f -name '*.gz' -delete 2>/dev/null || true"

  # Truncate large Docker container logs
  if $DOCKER_ENABLED && command -v docker >/dev/null 2>&1; then
    section "Truncate large Docker container logs"
    run_and_capture "Truncate container logs > ${LOG_TRUNCATE_THRESHOLD_MB}MB" bash -lc "find /var/lib/docker/containers -name '*-json.log' -size +${LOG_TRUNCATE_THRESHOLD_MB}M -exec sh -c 'echo Truncating: \"\$1\"; ${SUDO} truncate -s 0 \"\$1\"' _ {} \\; 2>/dev/null || true"
  fi

  # Docker prune (unused only)
  if $DOCKER_ENABLED && command -v docker >/dev/null 2>&1; then
    section "Docker prune (unused)"
    run_and_capture "docker system prune -af" docker system prune -af
    run_and_capture "docker builder prune -af" docker builder prune -af
    if $PRUNE_VOLUMES; then
      run_and_capture "docker volume prune -f" docker volume prune -f
    else
      warn "Skipping docker volume prune (enable with --prune-volumes)"
    fi
  else
    warn "Docker cleanup skipped (--no-docker or docker not found)"
  fi

  # APT cleanup
  if $APT_ENABLED; then
    section "APT cleanup"
    run_and_capture "apt-get clean" ${SUDO} apt-get clean -y
    run_and_capture "apt autoremove --purge -y" ${SUDO} apt autoremove --purge -y
    run_and_capture "Remove apt lists/cache leftovers" bash -lc "${SUDO} rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/* 2>/dev/null || true"
  else
    warn "APT cleanup skipped (--no-apt)"
  fi

  # Node caches (non-root)
  section "Remove Node/yarn caches (if present)"
  run_and_capture "Remove ~/.npm/_cacache ~/.cache/yarn" bash -lc "rm -rf ~/.npm/_cacache ~/.cache/yarn 2>/dev/null || true"

  # Snapshot after
  run_and_capture "Post-cleanup df -h" df -h
  ok "Cleanup completed."
}

############################################
# Confirmation prompt
############################################
confirm_cleanup() {
  if $ANALYZE_ONLY; then
    info "Analyze-only mode: cleanup will not run."
    return 1
  fi
  if $APPROVE; then
    info "Approve flag provided: proceeding without interactive prompt."
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "No TTY detected and --approve not provided; skipping cleanup."
    return 1
  fi
  echo ""
  echo "${COLOR_BOLD}Do you want to run cleanup now?${COLOR_RESET} [y/N]"
  read -r answer
  case "${answer}" in
    y|Y|yes|YES) return 0 ;;
    *) info "Cleanup skipped by user."; return 1 ;;
  esac
}

############################################
# JSON summary output
############################################
print_json_summary() {
  local avail_mb used_pct
  avail_mb="$(df --output=avail -m / | tail -1 | tr -dc '0-9')"
  used_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
  cat <<JSON
{"timestamp":"$(ts)","avail_mb":${avail_mb:-0},"used_percent":${used_pct:-0},"threshold_mb":${THRESHOLD_MB},"report_path":"${REPORT_FILE}"}
JSON
}

############################################
# Main
############################################
main() {
  prepare_report_path

  info "Free space threshold set to ${THRESHOLD_MB} MB"
  info "Docker: ${DOCKER_ENABLED}, journald: ${JOURNAL_ENABLED}, apt: ${APT_ENABLED}, prune-volumes: ${PRUNE_VOLUMES}"
  echo ""

  info "Running pre-analysis disk snapshot"
  df -h | tee -a "${REPORT_FILE}" >/dev/null 2>&1 || true

  analyze

  if $OUTPUT_JSON; then
    print_json_summary
  fi

  local avail_mb
  avail_mb="$(df --output=avail -m / | tail -1 | tr -dc '0-9')"
  if [[ -n "${avail_mb}" && "${avail_mb}" -lt "${THRESHOLD_MB}" ]]; then
    warn "Available space ${avail_mb} MB is below threshold ${THRESHOLD_MB} MB."
  else
    ok "Available space is above threshold."
  fi

  if confirm_cleanup; then
    cleanup_actions
  fi

  info "Final disk snapshot:"
  df -h | tee -a "${REPORT_FILE}" >/dev/null 2>&1 || true

  ok "All done. Detailed report saved to: ${REPORT_FILE}"
}

main "$@"


