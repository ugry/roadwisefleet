#!/usr/bin/env bash
# RoadwiseFleet pilot backup verification (task eila/tasks#10, finding B1).
#
# Ready-to-apply artifact. NOT installed by CI — installation is a host change
# needing owner approval + root (see infra/pilot-observability.md §4).
#
# Why: `roadwise-pg-backup.timer` only proves a pg_dump *ran*. A dump can exit 0
# and still be unusable. This script adds the artifact-level check:
#   1. newest dump in BACKUP_DIR exists and is non-empty
#   2. newest dump is fresh (younger than MAX_AGE_HOURS, default 26 h)
#   3. the dump is readable by the matching tool (pg_restore --list for custom
#      format, or a plain-SQL sanity read for .sql/.gz) — run in a throwaway
#      postgres:17-alpine container so no host package is required
# It also checks the legacy waitlist tarball (freshness + tar -tzf integrity).
#
# On failure it mails ALERT_MAIL and exits non-zero.
#
# No credential values are used: the dump is inspected with pg_restore --list /
# zcat, which need no database connection.

set -uo pipefail

ALERT_MAIL="${ALERT_MAIL:-ugur@elilaltd.com}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet}"
PG_DIR="$BACKUP_DIR/postgres"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
LOG_TAG="pilot-backup-verify"
PODMAN="${PODMAN:-podman}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:17-alpine}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; logger -t "$LOG_TAG" "$*" 2>/dev/null || true; }

FAILURES=""

mail_alert() {
  local subject="$1" body="$2"
  if command -v sendmail >/dev/null 2>&1; then
    {
      printf 'To: %s\n' "$ALERT_MAIL"
      printf 'Subject: %s\n' "$subject"
      printf 'From: pilot-backup-verify@elilavps2\n'
      printf 'Content-Type: text/plain; charset=utf-8\n\n'
      printf '%s\n' "$body"
    } | sendmail -t
    log "alert mailed to $ALERT_MAIL: $subject"
  else
    log "WARN no sendmail; alert not delivered: $subject"
  fi
}

log "verify start (BACKUP_DIR=$BACKUP_DIR)"

# --- 1. Postgres dump: exists, non-empty, fresh -----------------------------
NEWEST_PG=""
if [ -d "$PG_DIR" ]; then
  NEWEST_PG=$(find "$PG_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.gz' \) \
              -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
fi

if [ -z "$NEWEST_PG" ]; then
  FAILURES="${FAILURES}postgres: no dump file found in ${PG_DIR}"$'\n'
else
  SIZE=$(stat -c %s "$NEWEST_PG" 2>/dev/null || echo 0)
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST_PG" 2>/dev/null || echo 0) ) / 3600 ))
  log "newest dump: $NEWEST_PG (${SIZE} bytes, ${AGE_H}h old)"
  [ "$SIZE" -gt 0 ] || FAILURES="${FAILURES}postgres: newest dump is empty (${NEWEST_PG})"$'\n'
  [ "$AGE_H" -le "$MAX_AGE_HOURS" ] || FAILURES="${FAILURES}postgres: newest dump is stale (${AGE_H}h > ${MAX_AGE_HOURS}h): ${NEWEST_PG}"$'\n'

  # --- 3. artifact-level readability check (no DB connection needed) --------
  if [ "$SIZE" -gt 0 ] && command -v "$PODMAN" >/dev/null 2>&1; then
    case "$NEWEST_PG" in
      *.sql.gz|*.gz)
        if ! gzip -t "$NEWEST_PG" 2>/dev/null; then
          FAILURES="${FAILURES}postgres: gzip integrity check failed for ${NEWEST_PG}"$'\n'
        fi
        ;;
      *.sql)
        # plain SQL: must at least look like a dump
        if ! head -n 50 "$NEWEST_PG" | grep -qiE 'PostgreSQL database dump|CREATE TABLE|SET statement_timeout'; then
          FAILURES="${FAILURES}postgres: ${NEWEST_PG} does not look like a pg_dump SQL file"$'\n'
        fi
        ;;
      *)
        # custom/tar format: pg_restore --list must succeed
        if ! "$PODMAN" run --rm -i -v "$(dirname "$NEWEST_PG")":/b:ro "$PG_IMAGE" \
               pg_restore --list "/b/$(basename "$NEWEST_PG")" >/dev/null 2>&1; then
          FAILURES="${FAILURES}postgres: pg_restore --list failed (dump unreadable/corrupt): ${NEWEST_PG}"$'\n'
        fi
        ;;
    esac
  fi
fi

# --- 2. legacy waitlist tarball --------------------------------------------
NEWEST_WL=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'waitlist-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -n1 | cut -d' ' -f2-)
if [ -z "$NEWEST_WL" ]; then
  FAILURES="${FAILURES}waitlist: no waitlist-*.tar.gz found in ${BACKUP_DIR}"$'\n'
else
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST_WL" 2>/dev/null || echo 0) ) / 3600 ))
  log "newest waitlist backup: $NEWEST_WL (${AGE_H}h old)"
  [ "$AGE_H" -le "$MAX_AGE_HOURS" ] || FAILURES="${FAILURES}waitlist: newest backup is stale (${AGE_H}h > ${MAX_AGE_HOURS}h)"$'\n'
  tar -tzf "$NEWEST_WL" >/dev/null 2>&1 || FAILURES="${FAILURES}waitlist: tar integrity check failed for ${NEWEST_WL}"$'\n'
fi

if [ -n "$FAILURES" ]; then
  mail_alert "[ALERT] RoadwiseFleet backup verification failed" \
    "Backup verification failed at $(date -u +%Y-%m-%dT%H:%M:%SZ).

${FAILURES}
Backup dir: ${BACKUP_DIR}
This means the nightly dump may not be restorable. See infra/pilot-observability.md §4."
  log "verify end: FAILED"
  exit 1
fi

log "verify end: OK"
exit 0
