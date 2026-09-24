#!/usr/bin/env bash
# RoadwiseFleet pilot Postgres restore drill (task eila/tasks#10, finding B1;
# board #62 hardening).
#
# Ready-to-apply artifact. A restore drill is a deliberate, supervised operation
# (its host install belongs to the owner window); it is never run automatically.
# Run it on elilavps2 as root:
#
#   sudo /usr/local/bin/pilot-restore-drill.sh            # newest dump
#   sudo /usr/local/bin/pilot-restore-drill.sh <dumpfile> # a specific dump
#
# It NEVER touches the live volume `roadwise-pgdata` and never connects to the
# live database. It spins up a throwaway postgres:17-alpine container with a
# random scratch password generated at runtime, restores the dump into it, runs
# sanity checks, then removes the container.
#
# Scratch port (board #62) — no fixed default any more. `SCRATCH_PORT=auto`
# (the default) publishes the container on the first FREE port found in
# SCRATCH_PORT_RANGE_START..SCRATCH_PORT_RANGE_END (5440..5479 by default) and
# retries the next candidate when the container fails to bind. It never tries
# 5432/5433: on elilavps2 the host `postgresql@17-main` cluster listens on 5433,
# and the previous hardcoded default aborted the first drill with
# "bind: address already in use". `SCRATCH_PORT=<n>` still pins one port, and a
# busy pinned port fails with a clear message instead of a bare bind error.
#
# Owner roles (board #62) — roles are cluster-level, so a PLAIN SQL dump
# references its owner role (`ALTER … OWNER TO roadwisefleet`) but does not
# contain it, and `ON_ERROR_STOP=1` aborted the load on the first such line.
# The drill now derives the referenced roles from the dump
# (OWNER TO / AUTHORIZATION / GRANT|REVOKE … TO|FROM) and creates each one with
# LOGIN in the throwaway cluster if it is absent, before loading. A reference
# that is not a simple identifier is skipped with a loud message and is never
# interpolated into SQL.
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
#   --self-test     run the no-host/no-network/no-root assertions CI runs
#                   (.github/workflows/ci.yml, job `restore-drill-selftest`)
#   --help          print this header
#
# No credential value is read, printed or stored: the scratch password exists
# only in this process' environment for the lifetime of the drill.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet/postgres}"
PODMAN="${PODMAN:-podman}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:17-alpine}"
SCRATCH_NAME="${SCRATCH_NAME:-rwf-restore-drill}"
# auto = first free candidate port; a number = pin exactly that port.
SCRATCH_PORT="${SCRATCH_PORT:-auto}"
SCRATCH_PORT_RANGE_START="${SCRATCH_PORT_RANGE_START:-5440}"
SCRATCH_PORT_RANGE_END="${SCRATCH_PORT_RANGE_END:-5479}"
SCRATCH_DB="${SCRATCH_DB:-roadwise_restore_drill}"
SCRATCH_USER="${SCRATCH_USER:-postgres}"
UPLOAD_BACKUP_DIR="${UPLOAD_BACKUP_DIR:-/var/backups/roadwisefleet/uploads}"
UPLOAD_MODE="${UPLOAD_MODE:-auto}"   # auto | yes | no
ROLE_BOOTSTRAP="${ROLE_BOOTSTRAP:-1}"   # 1 = create the dump's owner roles first
MODE="run"

DUMP=""
for arg in "$@"; do
  case "$arg" in
    --with-uploads) UPLOAD_MODE="yes" ;;
    --no-uploads)   UPLOAD_MODE="no" ;;
    --self-test)    MODE="self-test" ;;
    --help|-h)      MODE="help" ;;
    --) ;;
    *) DUMP="$arg" ;;
  esac
done

if [ -z "$DUMP" ]; then
  # `|| true`: with `set -o pipefail`, a missing BACKUP_DIR (e.g. running
  # `--self-test` on a machine with no backups) made `find` fail the whole
  # assignment and `set -e` exited before the "no usable dump" message.
  DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
         \( -name '*.dump' -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.gz' \) \
         -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2- || true)
fi

# ---------------------------------------------------------------------------
# role derivation (board #62)
# ---------------------------------------------------------------------------
dump_roles() { # dump_roles <dumpfile> -> one role per line; '#' lines are notes
  local f="$1" reader
  case "$f" in
    *.gz) reader="zcat" ;;
    *)    reader="cat" ;;
  esac
  "$reader" -- "$f" | awk '
    function clean(s) {
      gsub(/[;"'"'"']/, "", s)
      gsub(/^[ \t]+|[ \t]+$/, "", s)
      return s
    }
    function emit(s) {
      s = clean(s)
      if (s == "" || s == "PUBLIC" || s == "postgres") return
      if (s ~ /^[A-Za-z_][A-Za-z0-9_$]*$/) { print s; return }
      # Never interpolate an unvalidated string into SQL: report and drop it.
      print "# skipped role reference that is not a simple identifier: " s
    }
    /OWNER TO /      { split($0, a, "OWNER TO ");      emit(a[2]); next }
    /AUTHORIZATION / { split($0, a, "AUTHORIZATION "); emit(a[2]); next }
    /^[ \t]*(GRANT|REVOKE) / {
      line = $0; sub(/;[ \t]*$/, "", line)
      if (match(line, / TO /))        rest = substr(line, RSTART + 4)
      else if (match(line, / FROM /)) rest = substr(line, RSTART + 6)
      else next
      n = split(rest, b, ",")
      for (i = 1; i <= n; i++) emit(b[i])
    }'
}

bootstrap_roles() { # bootstrap_roles <dumpfile> — create referenced roles
  local roles line created=0
  roles="$(dump_roles "$1" | sort -u)"
  if [ -z "$roles" ]; then
    echo "restore drill: no owner roles referenced by the dump"
    return 0
  fi
  echo "restore drill: bootstrapping owner roles referenced by the dump"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      '#'*) echo "restore drill: ${line#'# '}" ;;
      # The identifier was validated by dump_roles, so this is not injection.
      *) if ! "$PODMAN" exec -e PGPASSWORD="$SCRATCH_PW" "$SCRATCH_NAME" \
                psql -v ON_ERROR_STOP=1 -q -U "$SCRATCH_USER" -d "$SCRATCH_DB" -c \
                "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$line') THEN CREATE ROLE \"$line\" LOGIN; END IF; END \$\$;" >/dev/null; then
           echo "ERROR: could not create role '$line' in the scratch cluster" >&2
           return 1
         fi
         echo "restore drill: role '$line' present in the scratch cluster"
         created=$(( created + 1 )) ;;
    esac
  done <<EOF
$roles
EOF
  echo "restore drill: ${created} owner role(s) ensured"
  return 0
}

# ---------------------------------------------------------------------------
# scratch container start, with a free-port search (board #62)
# ---------------------------------------------------------------------------
start_scratch() { # start_scratch <port> -> 0 started | 2 port busy | 1 other
  local out rc
  set +e
  out="$("$PODMAN" run --rm -d --name "$SCRATCH_NAME" \
        -p "127.0.0.1:${1}:5432" \
        -e POSTGRES_PASSWORD="$SCRATCH_PW" \
        -e POSTGRES_DB="$SCRATCH_DB" \
        "$PG_IMAGE" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then return 0; fi
  printf '%s\n' "$out" >&2
  case "$out" in
    *"address already in use"*|*"port is already allocated"*|*"bind: address in use"*|*"cannot expose privileged port"*)
      return 2 ;;
    *) return 1 ;;
  esac
}

start_scratch_auto() { # sets CHOSEN_PORT; returns 1 with a message on failure
  local p rc ports=()
  if [ "$SCRATCH_PORT" != "auto" ]; then
    case "$SCRATCH_PORT" in
      ''|*[!0-9]*) echo "ERROR: SCRATCH_PORT must be a number or 'auto'" >&2; return 1 ;;
    esac
    ports=("$SCRATCH_PORT")
  else
    mapfile -t ports < <(seq "$SCRATCH_PORT_RANGE_START" "$SCRATCH_PORT_RANGE_END")
  fi
  for p in "${ports[@]}"; do
    set +e
    start_scratch "$p"
    rc=$?
    set -e
    case "$rc" in
      0) CHOSEN_PORT="$p"; return 0 ;;
      2)
        if [ "$SCRATCH_PORT" != "auto" ]; then
          echo "ERROR: SCRATCH_PORT=$p is in use — free it or use SCRATCH_PORT=auto" >&2
          return 1
        fi
        echo "restore drill: port $p is in use — trying the next one" >&2
        continue ;;
      *)
        echo "ERROR: starting the scratch container failed for a reason other than a busy port (see above)" >&2
        return 1 ;;
    esac
  done
  echo "ERROR: no free scratch port in ${SCRATCH_PORT_RANGE_START}-${SCRATCH_PORT_RANGE_END} (set SCRATCH_PORT_RANGE_START/END or pin SCRATCH_PORT=<n>)" >&2
  return 1
}

# ---------------------------------------------------------------------------
# self-test — run by CI (.github/workflows/ci.yml, job `restore-drill-selftest`).
# The three board-#62 defects were fixed on the host first and were unverified
# by CI; these assertions close that: stubbed podman, a fixture dump and a
# fixture uploads archive, no host, no network, no root, no real Postgres.
# ---------------------------------------------------------------------------
self_test() {
  local tmp tests_pass=0 tests_fail=0 OUT RC boot_ln load_ln
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill-selftest.XXXXXX")" || return 2
  local SELF="${BASH_SOURCE[0]}" LOG="$tmp/podman.log"
  : > "$LOG"

  check() { # check <label> <got> <want>
    if [ "$2" = "$3" ]; then
      printf 'PASS %s (%s)\n' "$1" "$2"; tests_pass=$(( tests_pass + 1 ))
    else
      printf 'FAIL %s: got "%s", want "%s"\n' "$1" "$2" "$3"; tests_fail=$(( tests_fail + 1 ))
    fi
  }
  capture() { # capture <cmd...> — sets OUT (stdout+stderr) and RC
    set +e
    OUT="$("$@" 2>&1)"
    RC=$?
    set -e
  }

  # Test double for podman: logs argv, simulates a busy published port, drains
  # stdin for `exec -i`. It never starts anything.
  cat > "$tmp/podman" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_LOG:?}"
case "$1" in
  rm) exit 0 ;;
  run)
    prev=""; port=""
    for a in "$@"; do
      if [ "$prev" = "-p" ]; then port="${a%:*}"; port="${port##*:}"; fi
      prev="$a"
    done
    case " ${STUB_BUSY_PORTS:-} " in
      *" $port "*) echo "Error: rootlessport ... bind: address already in use" >&2; exit 126 ;;
    esac
    echo "stub-container-id"
    exit 0 ;;
  exec)
    saw_i=0
    for a in "$@"; do if [ "$a" = "-i" ]; then saw_i=1; fi; done
    if [ "$saw_i" = 1 ]; then cat >> "${STUB_LOG}.stdin"; fi
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$tmp/podman"

  # Fixture: a plain SQL dump that references an owner role (the board-#62
  # failure), a second role only via GRANT, and one non-identifier reference.
  mkdir -p "$tmp/backups/postgres" "$tmp/up" "$tmp/up/empty"
  cat > "$tmp/fixture.sql" <<'SQL'
CREATE SCHEMA roadwisefleet;
ALTER SCHEMA roadwisefleet OWNER TO roadwisefleet;
ALTER TABLE public."Trip" OWNER TO roadwisefleet;
GRANT SELECT ON TABLE public."Trip" TO roadwisefleet, readonly;
ALTER TABLE public."Weird" OWNER TO "weird role";
SQL
  gzip -c "$tmp/fixture.sql" > "$tmp/backups/postgres/roadwisefleet-fixture.sql.gz"

  # Fixture: two "documents" archived with the manifest layout the backup
  # script produces (sha256 lines relative to the upload dir).
  mkdir -p "$tmp/uptree/a" "$tmp/uptree/b"
  printf 'pod-bytes-one\n' > "$tmp/uptree/a/one.jpg"
  printf 'pod-bytes-two\n' > "$tmp/uptree/b/two.jpg"
  ( cd "$tmp/uptree" && find . -type f -exec sha256sum {} + ) > "$tmp/up/uploads-20260924-000000.manifest"
  ( cd "$tmp/uptree" && tar -czf "$tmp/up/uploads-20260924-000000.tar.gz" . )

  # 1. port selection: skips busy candidates, never tries the host 5433
  : > "$LOG"
  capture env STUB_LOG="$LOG" STUB_BUSY_PORTS="5440 5441" \
    BACKUP_DIR="$tmp/backups/postgres" PODMAN="$tmp/podman" \
    UPLOAD_MODE=no bash "$SELF" --no-uploads
  check "drill completes although the first candidate ports are busy" "$RC" "0"
  check "busy candidates are retried" \
    "$(printf '%s\n' "$OUT" | grep -c 'trying the next one' || true)" "2"
  check "the next free port (5442) is used" \
    "$(printf '%s\n' "$OUT" | grep -c '127.0.0.1:5442' || true)" "1"
  check "the host postgres port 5433 is never tried" "$(grep -c ':5433:' "$LOG" || true)" "0"

  # 2. a PINNED busy port fails with a clear message, not a bare bind error
  : > "$LOG"
  capture env STUB_LOG="$LOG" STUB_BUSY_PORTS="5433" SCRATCH_PORT=5433 \
    BACKUP_DIR="$tmp/backups/postgres" PODMAN="$tmp/podman" \
    UPLOAD_MODE=no bash "$SELF" --no-uploads
  check "pinned busy SCRATCH_PORT fails" "$RC" "1"
  check "pinned busy port message names the port and the alternative" \
    "$(printf '%s\n' "$OUT" | grep -c 'SCRATCH_PORT=5433 is in use' || true)" "1"

  # 3. role bootstrap: the dump's owner roles are created BEFORE the load
  : > "$LOG"; : > "${LOG}.stdin"
  capture env STUB_LOG="$LOG" BACKUP_DIR="$tmp/backups/postgres" PODMAN="$tmp/podman" \
    UPLOAD_MODE=no bash "$SELF" --no-uploads
  check "plain SQL dump loads without a hand patch" "$RC" "0"
  check "the dump owner role is created in the scratch cluster" \
    "$(grep -c 'CREATE ROLE "roadwisefleet"' "$LOG" || true)" "1"
  check "a role referenced only by GRANT is created too" \
    "$(grep -c "rolname = 'readonly'" "$LOG" || true)" "1"
  boot_ln="$(grep -n 'CREATE ROLE "roadwisefleet"' "$LOG" | head -n1 | cut -d: -f1)"
  load_ln="$(grep -n -e '-i .*ON_ERROR_STOP=1' "$LOG" | head -n1 | cut -d: -f1)"
  check "role bootstrap runs before the dump load" \
    "$(if [ -n "$boot_ln" ] && [ -n "$load_ln" ] && [ "$boot_ln" -lt "$load_ln" ]; then echo yes; else echo no; fi)" "yes"
  check "the dump body reaches psql" \
    "$(grep -c 'ALTER TABLE public."Trip" OWNER TO roadwisefleet' "${LOG}.stdin" || true)" "1"
  check "a non-identifier role reference is reported, not executed" \
    "$(printf '%s\n' "$OUT" | grep -c 'skipped role reference that is not a simple identifier' || true)" "1"
  check "the non-identifier name is never interpolated into SQL" \
    "$(grep -c 'weird role' "$LOG" || true)" "0"

  # 4. the uploads half, end to end (count + per-file sha256 against manifest)
  : > "$LOG"
  capture env STUB_LOG="$LOG" BACKUP_DIR="$tmp/backups/postgres" PODMAN="$tmp/podman" \
    UPLOAD_BACKUP_DIR="$tmp/up" bash "$SELF" --with-uploads
  check "drill with a real uploads archive succeeds" "$RC" "0"
  check "restored file count matches the manifest" \
    "$(printf '%s\n' "$OUT" | grep -c 'uploads file count restored=2 manifest=2' || true)" "1"
  check "every restored byte is verified against the manifest" \
    "$(printf '%s\n' "$OUT" | grep -c 'uploads checksums OK (2 files)' || true)" "1"

  # 5. --with-uploads with no archive is a hard failure, not a silent skip
  : > "$LOG"
  capture env STUB_LOG="$LOG" BACKUP_DIR="$tmp/backups/postgres" PODMAN="$tmp/podman" \
    UPLOAD_BACKUP_DIR="$tmp/up/empty" bash "$SELF" --with-uploads
  check "--with-uploads fails when no archive exists" "$RC" "1"
  check "the missing archive is named" \
    "$(printf '%s\n' "$OUT" | grep -c 'no uploads archive exists' || true)" "1"

  rm -rf "$tmp"
  printf 'self-test: %d passed, %d failed\n' "$tests_pass" "$tests_fail"
  [ "$tests_fail" = 0 ] || return 1
  return 0
}

if [ "$MODE" = "help" ]; then
  awk 'NR>1 && /^set -euo pipefail/ { exit } NR>1 { print }' "${BASH_SOURCE[0]}"
  exit 0
fi
if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

if [ -z "$DUMP" ] || [ ! -s "$DUMP" ]; then
  echo "ERROR: no usable dump found (looked in $BACKUP_DIR)" >&2
  exit 1
fi

echo "restore drill: dump=$DUMP"

# Random scratch-only password; never logged, never persisted.
# `cut` reads the whole stream (unlike `head -c`) so no SIGPIPE under pipefail.
SCRATCH_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)"

cleanup() {
  "$PODMAN" rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
  echo "restore drill: scratch container removed"
}
trap cleanup EXIT

"$PODMAN" rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
CHOSEN_PORT=""
start_scratch_auto || exit 1
echo "restore drill: scratch container=$SCRATCH_NAME on 127.0.0.1:$CHOSEN_PORT (live volume untouched)"

echo "restore drill: waiting for scratch Postgres..."
for _ in $(seq 1 30); do
  if "$PODMAN" exec "$SCRATCH_NAME" pg_isready -U "$SCRATCH_USER" >/dev/null 2>&1; then break; fi
  sleep 1
done
"$PODMAN" exec "$SCRATCH_NAME" pg_isready -U "$SCRATCH_USER" >/dev/null

# Roles are cluster-level and are not part of a database dump, so a plain SQL
# dump's `ALTER … OWNER TO <role>` aborts the load under ON_ERROR_STOP=1 unless
# the role exists. Create the referenced roles in the THROWAWAY cluster only.
if [ "$ROLE_BOOTSTRAP" = 1 ]; then
  case "$DUMP" in
    *.sql|*.sql.gz) bootstrap_roles "$DUMP" ;;
    *) echo "restore drill: role bootstrap not needed (custom-format dump is loaded with pg_restore --no-owner)" ;;
  esac
fi

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
