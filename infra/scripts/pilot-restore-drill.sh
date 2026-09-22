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

DUMP="${1:-}"
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

echo "restore drill: SUCCESS — record the date, dump file and row counts in infra/pilot-observability.md"
