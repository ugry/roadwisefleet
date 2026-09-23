#!/usr/bin/env bash
# RoadwiseFleet pilot Postgres restore drill (task eila/tasks#10, finding B1).
#
# Ready-to-apply artifact. NOT run by CI and NOT run automatically — a restore
# drill is a deliberate, supervised operation. Run it on elilavps2 as root:
#
#   sudo /usr/local/bin/pilot-restore-drill.sh            # newest dump
#   sudo /usr/local/bin/pilot-restore-drill.sh <dumpfile> # a specific dump
#
# It NEVER touches the live volume `roadwise-pgdata` and never connects to the
# live database. It spins up a throwaway postgres:17-alpine container on
# 127.0.0.1:5433 with a random scratch password generated at runtime, restores
# the dump into it, runs sanity checks, then removes the container.
#
# Board eila/tasks#46 (F7b transport) added the SECOND half: the upload directory
# is restored from its own archive into a scratch directory and every file is
# verified against the sha256 manifest written by pilot-uploads-backup.sh, plus
# file-count/byte-count comparison and a "no world-readable document" assertion.
# A restore is only meaningful if the trip AND its POD photo come back, so both
# halves run in one drill.
#
#   --with-uploads  require the uploads archive and fail if it is missing
#   --no-uploads    skip the uploads half entirely
#   (default)       restore uploads when an archive + manifest exist, say so
#                   clearly when they do not, but do not fail the DB drill
#
# No credential value is read, printed or stored: the scratch password exists
# only in this process' environment for the lifetime of the drill.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet/postgres}"
PODMAN="${PODMAN:-podman}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:17-alpine}"
SCRATCH_NAME="${SCRATCH_NAME:-rwf-restore-drill}"
SCRATCH_PORT="${SCRATCH_PORT:-5433}"
SCRATCH_DB="${SCRATCH_DB:-roadwise_restore_drill}"
SCRATCH_USER="${SCRATCH_USER:-postgres}"
UPLOAD_BACKUP_DIR="${UPLOAD_BACKUP_DIR:-/var/backups/roadwisefleet/uploads}"
UPLOAD_MODE="${UPLOAD_MODE:-auto}"   # auto | yes | no

DUMP=""
for arg in "$@"; do
  case "$arg" in
    --with-uploads) UPLOAD_MODE="yes" ;;
    --no-uploads)   UPLOAD_MODE="no" ;;
    --) ;;
    *) DUMP="$arg" ;;
  esac
done

if [ -z "$DUMP" ]; then
  DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
         \( -name '*.dump' -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.gz' \) \
         -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
fi

if [ -z "$DUMP" ] || [ ! -s "$DUMP" ]; then
  echo "ERROR: no usable dump found (looked in $BACKUP_DIR)" >&2
  exit 1
fi

echo "restore drill: dump=$DUMP"
echo "restore drill: scratch container=$SCRATCH_NAME on 127.0.0.1:$SCRATCH_PORT (live volume untouched)"

# Random scratch-only password; never logged, never persisted.
# `cut` reads the whole stream (unlike `head -c`) so no SIGPIPE under pipefail.
SCRATCH_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)"

cleanup() {
  "$PODMAN" rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
  echo "restore drill: scratch container removed"
}
trap cleanup EXIT

"$PODMAN" rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
"$PODMAN" run --rm -d --name "$SCRATCH_NAME" \
  -p "127.0.0.1:${SCRATCH_PORT}:5432" \
  -e POSTGRES_PASSWORD="$SCRATCH_PW" \
  -e POSTGRES_DB="$SCRATCH_DB" \
  "$PG_IMAGE" >/dev/null

echo "restore drill: waiting for scratch Postgres..."
for _ in $(seq 1 30); do
  if "$PODMAN" exec "$SCRATCH_NAME" pg_isready -U "$SCRATCH_USER" >/dev/null 2>&1; then break; fi
  sleep 1
done
"$PODMAN" exec "$SCRATCH_NAME" pg_isready -U "$SCRATCH_USER" >/dev/null

echo "restore drill: loading dump"
case "$DUMP" in
  *.sql.gz)
    zcat "$DUMP" | "$PODMAN" exec -i -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
      psql -v ON_ERROR_STOP=1 -U "$SCRATCH_USER" -d "$SCRATCH_DB" >/dev/null
    ;;
  *.sql)
    "$PODMAN" exec -i -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
      psql -v ON_ERROR_STOP=1 -U "$SCRATCH_USER" -d "$SCRATCH_DB" < "$DUMP" >/dev/null
    ;;
  *)
    "$PODMAN" exec -i -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
      pg_restore --clean --if-exists --no-owner -U "$SCRATCH_USER" -d "$SCRATCH_DB" < "$DUMP" >/dev/null
    ;;
esac

echo "restore drill: sanity checks"
"$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
  psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -At -c \
  "select 'tables=' || count(*) from information_schema.tables where table_schema='public';"
"$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
  psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -At -c \
  "select 'rows=' || coalesce(sum(n_live_tup),0) from pg_stat_user_tables;"

# Row CONTENT, not just row counts: the counts can match while every row is the
# wrong row. Board #43 asks for a known row count and row content.
"$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
  psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -At -c \
  "select 'trips=' || count(*) from \"Trip\";"
"$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
  psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -At -c \
  "select 'documents=' || count(*) from \"Document\";"
"$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
  psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -At -c \
  "select 'newest_document=' || \"docType\" || '|' || status || '|' || coalesce(\"storageKey\", '-') \
     from \"Document\" order by \"createdAt\" desc limit 1;"

# --- uploads half (board #46, F7b/F9c) ---------------------------------------
# The document ROWS come back from the dump; the document BYTES come back from
# pilot-uploads-backup.sh's archive, verified against its sha256 manifest.
RESTORE_UPLOADS=""
UPLOADS_ARCHIVE=""
if [ "$UPLOAD_MODE" != "no" ]; then
  UPLOADS_ARCHIVE=$(find "$UPLOAD_BACKUP_DIR" -maxdepth 1 -type f -name 'uploads-*.tar.gz' \
                    -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-) || true
fi

if [ "$UPLOAD_MODE" = "no" ]; then
  echo "restore drill: uploads half skipped (--no-uploads)"
elif [ -z "$UPLOADS_ARCHIVE" ]; then
  echo "restore drill: WARNING no uploads archive in $UPLOAD_BACKUP_DIR"
  echo "restore drill: WARNING the DB rows restored, but no document BYTES were verified"
  if [ "$UPLOAD_MODE" = "yes" ]; then
    echo "ERROR: --with-uploads was requested and no uploads archive exists" >&2
    exit 1
  fi
else
  UPLOADS_MANIFEST="${UPLOADS_ARCHIVE%.tar.gz}.manifest"
  if [ ! -s "$UPLOADS_MANIFEST" ]; then
    echo "ERROR: archive has no manifest: $UPLOADS_MANIFEST" >&2
    exit 1
  fi
  RESTORE_UPLOADS="$(mktemp -d "${TMPDIR:-/tmp}/rwf-uploads-drill.XXXXXX")"

  echo "restore drill: uploads=$UPLOADS_ARCHIVE -> $RESTORE_UPLOADS"
  tar -xzf "$UPLOADS_ARCHIVE" -C "$RESTORE_UPLOADS"

  RESTORED_FILES="$(find "$RESTORE_UPLOADS" -type f | wc -l)"
  RESTORED_BYTES="$(find "$RESTORE_UPLOADS" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')"
  MANIFEST_FILES="$(wc -l < "$UPLOADS_MANIFEST" | tr -d ' ')"
  echo "restore drill: uploads file count restored=$RESTORED_FILES manifest=$MANIFEST_FILES"
  echo "restore drill: uploads total bytes restored=$RESTORED_BYTES"

  if [ "$RESTORED_FILES" -ne "$MANIFEST_FILES" ]; then
    echo "ERROR: restored file count does not match the manifest" >&2
    rm -rf "$RESTORE_UPLOADS"
    exit 1
  fi

  # Byte-for-byte proof: every file must match its recorded sha256.
  if ! ( cd "$RESTORE_UPLOADS" && sha256sum -c "$UPLOADS_MANIFEST" --quiet ); then
    echo "ERROR: checksum verification failed for at least one restored document" >&2
    rm -rf "$RESTORE_UPLOADS"
    exit 1
  fi
  echo "restore drill: uploads checksums OK ($RESTORED_FILES files)"

  # Board #46 acceptance: no upload may be stored world-readable.
  WORLD_READABLE="$(find "$RESTORE_UPLOADS" -type f -perm -o+r | wc -l)"
  if [ "$WORLD_READABLE" -gt 0 ]; then
    echo "WARNING: $WORLD_READABLE restored file(s) are world-readable (o+r) in the archive" >&2
    echo "WARNING: fix the source permissions and take a new backup — see infra/uploads.md §4"
  fi

  rm -rf "$RESTORE_UPLOADS"
  echo "restore drill: uploads scratch copy removed"
fi

echo "restore drill: SUCCESS — record the date, dump file, row counts and uploads result in infra/pilot-observability.md"
