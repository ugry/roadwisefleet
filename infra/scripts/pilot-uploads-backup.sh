#!/usr/bin/env bash
# RoadwiseFleet uploads-directory backup (board eila/tasks#46 — F7b transport / F9c backup).
#
# Ready-to-apply artifact. NOT installed by CI — installing this on elilavps2 is a
# host change that needs owner approval + host access (see infra/uploads.md §7).
#
# Why: the Postgres dump backs up the document ROWS, not the bytes. Until this
# script exists, every POD/eCMR photo on the pilot had no backup at all: a lost
# disk or a stray `git clean` in the deploy checkout would destroy the compliance
# evidence permanently (finding U3 in infra/uploads.md).
#
# What it does
#   1. archives UPLOAD_DIR to <BACKUP_DIR>/uploads-<UTC stamp>.tar.gz (mode 0600);
#   2. writes <BACKUP_DIR>/uploads-<UTC stamp>.manifest (mode 0600) — every file
#      with its byte size and sha256, so a restore can prove the bytes round-trip
#      (used by pilot-restore-drill.sh and pilot-backup-verify.sh);
#   3. re-reads the archive it just wrote (tar -tzf) so a truncated write is
#      caught immediately rather than at restore time;
#   4. deletes archives + manifests older than KEEP_DAYS (default 30);
#   5. refuses to run when UPLOAD_DIR is missing or empty unless --allow-empty is
#      passed: an empty archive that looks healthy is worse than no archive.
#
# Usage: pilot-uploads-backup.sh [--allow-empty]
#
# No credential values are read, written or printed.

set -uo pipefail

# board #62: post-move location. The pre-B1 /opt/roadwisefleet/api/var/uploads is
# abandoned — a default pointing there would archive a dead directory.
UPLOAD_DIR="${UPLOAD_DIR:-/var/lib/roadwisefleet/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet/uploads}"
KEEP_DAYS="${KEEP_DAYS:-30}"
ALERT_MAIL="${ALERT_MAIL:-ugur@elilaltd.com}"
LOG_TAG="pilot-uploads-backup"
ALLOW_EMPTY=0

for arg in "$@"; do
  case "$arg" in
    --allow-empty) ALLOW_EMPTY=1 ;;
    -h|--help)
      printf 'usage: %s [--allow-empty]\n' "$0"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

SENDMAIL="$(command -v sendmail || true)"
if [ -z "$SENDMAIL" ] && [ -x /usr/sbin/sendmail ]; then SENDMAIL=/usr/sbin/sendmail; fi
if [ -z "$SENDMAIL" ] && [ -x /usr/lib/sendmail ]; then SENDMAIL=/usr/lib/sendmail; fi

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; logger -t "$LOG_TAG" "$*" 2>/dev/null || true; }

mail_alert() {
  local subject="$1" body="$2"
  if [ -n "$SENDMAIL" ]; then
    {
      printf 'To: %s\n' "$ALERT_MAIL"
      printf 'Subject: %s\n' "$subject"
      printf 'From: pilot-uploads-backup@elilavps2\n'
      printf 'Content-Type: text/plain; charset=utf-8\n\n'
      printf '%s\n' "$body"
    } | "$SENDMAIL" -t
    log "alert mailed to $ALERT_MAIL: $subject"
  else
    log "WARN no sendmail found; alert not delivered: $subject"
  fi
}

abort() {
  log "FAILED: $1"
  mail_alert "[ALERT] RoadwiseFleet uploads backup failed" \
    "The uploads backup did not complete at $(date -u +%Y-%m-%dT%H:%M:%SZ).

${1}

UPLOAD_DIR: ${UPLOAD_DIR}
BACKUP_DIR: ${BACKUP_DIR}
Consequence: document bytes are not protected by a fresh archive.
Runbook: infra/uploads.md §7"
  exit 1
}

log "uploads backup start (UPLOAD_DIR=$UPLOAD_DIR BACKUP_DIR=$BACKUP_DIR)"

if [ ! -d "$UPLOAD_DIR" ]; then
  abort "uploads directory ${UPLOAD_DIR} does not exist"
fi

FILE_COUNT="$(find "$UPLOAD_DIR" -type f 2>/dev/null | wc -l)"
case "$FILE_COUNT" in ''|*[!0-9]*) FILE_COUNT=0 ;; esac
TOTAL_BYTES="$(find "$UPLOAD_DIR" -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')"
case "$TOTAL_BYTES" in ''|*[!0-9]*) TOTAL_BYTES=0 ;; esac
log "source: ${FILE_COUNT} file(s), ${TOTAL_BYTES} bytes"

if [ "$FILE_COUNT" -eq 0 ] && [ "$ALLOW_EMPTY" -ne 1 ]; then
  abort "no files under ${UPLOAD_DIR} — refusing to write an empty archive (use --allow-empty to override)"
fi

mkdir -p "$BACKUP_DIR" 2>/dev/null || abort "cannot create ${BACKUP_DIR}"

# Everything this script creates is private: 0600 archive + manifest.
umask 077

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/uploads-$STAMP.tar.gz"
MANIFEST="$BACKUP_DIR/uploads-$STAMP.manifest"

if ! tar -czf "$ARCHIVE" -C "$UPLOAD_DIR" . ; then
  abort "tar failed for ${UPLOAD_DIR} -> ${ARCHIVE}"
fi
chmod 600 "$ARCHIVE" 2>/dev/null || true

# Manifest: sha256 + relative path, rooted at UPLOAD_DIR so a restore can verify
# in place with `sha256sum -c` from the restored directory.
if ! ( cd "$UPLOAD_DIR" && find . -type f -exec sha256sum {} + ) > "$MANIFEST" ; then
  abort "manifest generation failed for ${UPLOAD_DIR} -> ${MANIFEST}"
fi
chmod 600 "$MANIFEST" 2>/dev/null || true

MANIFEST_LINES="$(wc -l < "$MANIFEST" | tr -d ' ')"
case "$MANIFEST_LINES" in ''|*[!0-9]*) MANIFEST_LINES=0 ;; esac
if [ "$MANIFEST_LINES" -lt "$FILE_COUNT" ]; then
  abort "manifest lists ${MANIFEST_LINES} of ${FILE_COUNT} files — incomplete manifest"
fi

# Read the archive back: catches a truncated/interrupted write now, not at restore.
if ! tar -tzf "$ARCHIVE" > /dev/null 2>&1 ; then
  abort "archive integrity check failed (tar -tzf) for ${ARCHIVE}"
fi

ARCHIVE_BYTES="$(stat -c '%s' "$ARCHIVE" 2>/dev/null || echo 0)"
case "$ARCHIVE_BYTES" in ''|*[!0-9]*) ARCHIVE_BYTES=0 ;; esac
log "archive: ${ARCHIVE} (${ARCHIVE_BYTES} bytes), manifest ${MANIFEST_LINES} entries"

# Retention: archive + manifest are removed together so a manifest never
# outlives its archive.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'uploads-*.tar.gz'   -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'uploads-*.manifest' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'uploads-*.tar.gz' 2>/dev/null | wc -l)"
log "uploads backup end: OK (${REMAINING} archive(s) retained, KEEP_DAYS=${KEEP_DAYS})"
exit 0
