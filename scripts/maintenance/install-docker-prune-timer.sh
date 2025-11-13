#!/usr/bin/env bash
#
# Install and enable the Docker prune systemd service + timer
# - Copies unit files from repo to /etc/systemd/system
# - Enables and starts the timer
#
# Usage:
#   sudo ./scripts/maintenance/install-docker-prune-timer.sh
#
set -Eeuo pipefail

SUDO=sudo
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  SUDO=""
fi

UNIT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd"
UNIT_DST_DIR="/etc/systemd/system"

echo "[INFO] Copying unit files from ${UNIT_SRC_DIR} to ${UNIT_DST_DIR}"
${SUDO} cp -f "${UNIT_SRC_DIR}/docker-prune.service" "${UNIT_DST_DIR}/docker-prune.service"
${SUDO} cp -f "${UNIT_SRC_DIR}/docker-prune.timer" "${UNIT_DST_DIR}/docker-prune.timer"

echo "[INFO] Reloading systemd daemon"
${SUDO} systemctl daemon-reload

echo "[INFO] Enabling and starting docker-prune.timer"
${SUDO} systemctl enable --now docker-prune.timer

echo "[OK] docker-prune.timer is active:"
${SUDO} systemctl status docker-prune.timer --no-pager || true

echo "[OK] To disable:"
echo "  sudo systemctl disable --now docker-prune.timer"


