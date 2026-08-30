#!/usr/bin/env bash
# Nightly backup of the RoadwiseFleet waitlist data (JSONL + admin token).
# Runs on the VPS via cron (see infra/README.md). Local copy today;
# extend with an offsite sync (B2/rclone) when credentials exist.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet}"
DATA_DIR="${DATA_DIR:-/var/lib/roadwisefleet}"
STAMP=$(date +%Y%m%d-%H%M%S)

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO=sudo

$SUDO mkdir -p "$BACKUP_DIR"
$SUDO tar -czf "$BACKUP_DIR/waitlist-$STAMP.tar.gz" -C "$DATA_DIR" waitlist.jsonl admin-token
$SUDO chmod 600 "$BACKUP_DIR/waitlist-$STAMP.tar.gz"

# Keep 14 days of backups
$SUDO find "$BACKUP_DIR" -name 'waitlist-*.tar.gz' -mtime +14 -delete

echo "backup written: $BACKUP_DIR/waitlist-$STAMP.tar.gz"
