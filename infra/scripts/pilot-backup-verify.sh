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
# It also checks the legacy waitlist tarball (freshness + tar -tzf integrity)
# and, since board eila/tasks#46, the document-uploads archive written by
# pilot-uploads-backup.sh (freshness, tar integrity, manifest present) — the
# Postgres dump protects the document rows, not the bytes.
#
# On failure it mails ALERT_MAIL and exits non-zero.
#
# No credential values are used: the dump is inspected with pg_restore --list /
# zcat, which need no database connection.
#
#   --self-test     run the no-host/no-network/no-root assertions CI runs
#                   (.github/workflows/ci.yml, job `infra-scripts`); state which
#                   assertions exist here so a reinstall cannot regress them
#   --help          print this header
#
# Self-test note (board #43): this script is the check that makes a backup
# *verified* rather than merely scheduled. Its acceptance-relevant decision —
# "deleting the newest backup is detected by the freshness check and alerts" —
# now has a machine-checked proof (fixture backup sets + a stub sendmail that
# captures the message), so it can no longer regress unnoticed on a reinstall.

set -uo pipefail

ALERT_MAIL="${ALERT_MAIL:-ugur@elilaltd.com}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/roadwisefleet}"
PG_DIR="$BACKUP_DIR/postgres"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
LOG_TAG="pilot-backup-verify"
PODMAN="${PODMAN:-podman}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:17-alpine}"

MODE="run"
for arg in "$@"; do
  case "$arg" in
    --self-test) MODE="self-test" ;;
    --help|-h)   MODE="help" ;;
    *) ;;
  esac
done

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

# ---------------------------------------------------------------------------
# self-test — run by CI (.github/workflows/ci.yml, job `infra-scripts`).
# Drives the REAL script against fixture backup sets with a stubbed sendmail
# (every assertion reads what was actually sent) and a stubbed podman. It
# proves the decisions board #43's acceptance depends on, above all:
#   * deleting the newest backup is detected and raises exactly one alert;
#   * a gap in the archive series, a missing manifest, an empty dump, a stale
#     dump and a file that is not a pg_dump are each rejected by name;
#   * a healthy set passes and sends NOTHING.
# No host, no network, no root, no Postgres. This script does not use `set -e`
# (it accumulates failures via `|| FAILURES=`), so nothing here re-enables it.
# ---------------------------------------------------------------------------
self_test() {
  local tmp tests_pass=0 tests_fail=0 OUT RC
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/backup-verify-selftest.XXXXXX")" || return 2
  local SELF="${BASH_SOURCE[0]}" MAIL="$tmp/mail.log"
  local B="$tmp/backups" PG="$tmp/backups/postgres" UP="$tmp/backups/uploads"

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
    set +e
  }
  mails() { # messages the stubbed sendmail actually received
    if [ -f "$MAIL" ]; then grep -c '^===MAIL===' "$MAIL" || true; else echo 0; fi
  }
  sent() { # occurrences of <pattern> in what was actually sent
    if [ -f "$MAIL" ]; then grep -c -- "$1" "$MAIL" || true; else echo 0; fi
  }
  run_verify() { # run the real script against the current fixtures
    capture env BACKUP_DIR="$B" UPLOAD_BACKUP_DIR="$UP" \
      PATH="$tmp/bin:$PATH" bash "$SELF"
  }
  dump() { # dump <path> — minimal file that passes the pg_dump sanity read
    { printf -- '--\n-- PostgreSQL database dump\n--\n\n'; printf 'CREATE TABLE "Trip" (id text);\n'; } > "$1"
  }
  tarball() { # tarball <path> [content]
    local d="$tmp/tar.$$.$RANDOM"
    mkdir -p "$d"; printf '%s\n' "${2:-payload}" > "$d/file.txt"
    tar -czf "$1" -C "$d" .; rm -rf "$d"
  }
  fresh_set() { # a fresh, complete, healthy backup set
    rm -rf "$B"; mkdir -p "$PG" "$UP"
    dump "$PG/roadwisefleet-20260924-010101.sql"
    tarball "$B/waitlist-20260924-010101.tar.gz"
    tarball "$UP/uploads-20260924-010101.tar.gz"
    printf 'deadbeefdeadbeef  a/file.txt\n' > "$UP/uploads-20260924-010101.manifest"
  }

  # Test double for sendmail: append subject+body to $MAIL_LOG so each
  # assertion reads the payload that was really sent.
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/sendmail" <<'STUB'
#!/usr/bin/env bash
printf '===MAIL===\n' >> "${MAIL_LOG:?}"
cat >> "$MAIL_LOG"
exit 0
STUB
  # Test double for podman: the readability branch must run, but nothing may
  # start. The `.sql` sanity path never calls it.
  cat > "$tmp/bin/podman" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$tmp/bin/sendmail" "$tmp/bin/podman"
  export MAIL_LOG="$MAIL"

  # 1. a healthy set verifies OK and sends nothing
  rm -f "$MAIL"; fresh_set
  run_verify
  check "a fresh, complete backup set verifies OK" "$RC" "0"
  check "no alert is sent for a healthy set" "$(mails)" "0"

  # 2. ACCEPTANCE: deleting the newest backup is detected by the freshness
  #    check and alerts (a stale older archive becomes the newest)
  rm -f "$MAIL"; fresh_set
  cp "$UP/uploads-20260924-010101.tar.gz" "$UP/uploads-20260923-010101.tar.gz"
  cp "$UP/uploads-20260924-010101.manifest" "$UP/uploads-20260923-010101.manifest"
  touch -d '30 hours ago' "$UP/uploads-20260923-010101.tar.gz" "$UP/uploads-20260923-010101.manifest"
  rm -f "$UP/uploads-20260924-010101.tar.gz" "$UP/uploads-20260924-010101.manifest"
  run_verify
  check "deleting the newest uploads archive is detected" "$RC" "1"
  check "the freshness check names the stale uploads archive" "$(sent 'uploads: newest archive is stale')" "1"
  check "exactly one alert is sent for that incident" "$(mails)" "1"

  # 3. an archive that has no manifest is not a verifiable backup
  rm -f "$MAIL"; fresh_set; rm -f "$UP/uploads-20260924-010101.manifest"
  run_verify
  check "an archive with no manifest is rejected" "$RC" "1"
  check "the alert names the missing manifest" "$(sent 'has no manifest')" "1"

  # 4. an empty dump is rejected by name
  rm -f "$MAIL"; fresh_set; : > "$PG/roadwisefleet-20260924-010101.sql"
  run_verify
  check "an empty dump is rejected" "$RC" "1"
  check "the alert names the empty dump" "$(sent 'newest dump is empty')" "1"

  # 5. a stale dump is rejected by name
  rm -f "$MAIL"; fresh_set
  mv "$PG/roadwisefleet-20260924-010101.sql" "$PG/roadwisefleet-20260922-010101.sql"
  touch -d '30 hours ago' "$PG/roadwisefleet-20260922-010101.sql"
  run_verify
  check "a stale dump is rejected" "$RC" "1"
  check "the alert names the stale dump" "$(sent 'newest dump is stale')" "1"

  # 6. a file that is not a pg_dump is not a backup
  rm -f "$MAIL"; fresh_set; printf 'hello world\n' > "$PG/roadwisefleet-20260924-010101.sql"
  run_verify
  check "a file that is not a pg_dump SQL file is rejected" "$RC" "1"
  check "the alert names the unreadable dump" "$(sent 'does not look like a pg_dump SQL file')" "1"

  # 7. a completely missing set reports every gap but sends ONE deduplicated mail
  rm -f "$MAIL"; rm -rf "$B"; mkdir -p "$PG" "$UP"
  run_verify
  check "a completely missing backup set is rejected" "$RC" "1"
  check "the postgres gap is named" "$(sent 'postgres: no dump file found')" "1"
  check "the waitlist gap is named" "$(sent 'waitlist: no waitlist')" "1"
  check "the uploads gap is named" "$(sent 'uploads: no uploads')" "1"
  check "all gaps are deduplicated into exactly one alert" "$(mails)" "1"
  check "the sent alert carries the alert subject" \
    "$(sent '\[ALERT\] RoadwiseFleet backup verification failed')" "1"

  rm -rf "$tmp"
  printf 'self-test: %d passed, %d failed\n' "$tests_pass" "$tests_fail"
  [ "$tests_fail" = 0 ] || return 1
  return 0
}

if [ "$MODE" = "help" ]; then
  awk 'NR>1 && /^set -uo pipefail/ { exit } NR>1 { print }' "${BASH_SOURCE[0]}"
  exit 0
fi
if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

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

# --- 4. document uploads archive (board #46, F7b) ----------------------------
# The Postgres dump protects the document ROWS; the uploads archive protects the
# BYTES. Missing either one means the compliance evidence is not recoverable.
UPLOAD_BACKUP_DIR="${UPLOAD_BACKUP_DIR:-/var/backups/roadwisefleet/uploads}"
NEWEST_UP=$(find "$UPLOAD_BACKUP_DIR" -maxdepth 1 -type f -name 'uploads-*.tar.gz' \
            -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
if [ -z "$NEWEST_UP" ]; then
  FAILURES="${FAILURES}uploads: no uploads-*.tar.gz found in ${UPLOAD_BACKUP_DIR}"$'\n'
else
  UP_SIZE=$(stat -c %s "$NEWEST_UP" 2>/dev/null || echo 0)
  UP_AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST_UP" 2>/dev/null || echo 0) ) / 3600 ))
  log "newest uploads archive: $NEWEST_UP (${UP_SIZE} bytes, ${UP_AGE_H}h old)"
  [ "$UP_SIZE" -gt 0 ] || FAILURES="${FAILURES}uploads: newest archive is empty (${NEWEST_UP})"$'\n'
  [ "$UP_AGE_H" -le "$MAX_AGE_HOURS" ] || FAILURES="${FAILURES}uploads: newest archive is stale (${UP_AGE_H}h > ${MAX_AGE_HOURS}h): ${NEWEST_UP}"$'\n'
  tar -tzf "$NEWEST_UP" >/dev/null 2>&1 || FAILURES="${FAILURES}uploads: tar integrity check failed for ${NEWEST_UP}"$'\n'

  # A missing/deleted newest archive (a gap in the series) is the failure mode
  # this check exists for: an archive that is present but has no manifest cannot
  # be verified at restore time, so it does not count as a backup.
  UP_MANIFEST="${NEWEST_UP%.tar.gz}.manifest"
  if [ ! -s "$UP_MANIFEST" ]; then
    FAILURES="${FAILURES}uploads: newest archive has no manifest (${UP_MANIFEST}) — not restorable with verification"$'\n'
  fi
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
