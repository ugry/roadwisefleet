#!/usr/bin/env bash
# RoadwiseFleet — uploads storage guard (board eila/tasks#46; findings U1 + U7).
#
# Two independent jobs:
#
#   1. repo mode (default; runs in CI, needs no host): the four artifacts that
#      decide where the uploads live —
#        infra/systemd/pilot-disk-check.service
#        infra/systemd/pilot-uploads-backup.service
#        infra/scripts/pilot-disk-check.sh
#        infra/scripts/pilot-uploads-backup.sh
#      — must bind UPLOAD_DIR to the post-move live root and must NOT bind it to
#      the retired pre-move root. Board #62 (D1) was exactly this drift: the
#      merged units still hard-coded the pre-move path, found on the host after
#      merge because CI had no way to see it.
#
#   2. --live (run on elilavps2 with read access to the roots): no upload may be
#      world-readable. A world-readable FILE fails; a world-traversable DIR
#      warns. A retired root that is still present warns; one that still holds
#      world-readable files FAILS — that leftover copy keeps leaking POD photos.
#
# Usage:
#   bash infra/checks/uploads-perms-check.sh             # repo consistency (CI)
#   bash infra/checks/uploads-perms-check.sh --live      # host audit
#   bash infra/checks/uploads-perms-check.sh --self-test # fixture proof
#   bash infra/checks/uploads-perms-check.sh --help
# Exit: 0 ok, 1 a real failure, 2 usage error.
#
# Env overrides (--live / --self-test):
#   RWF_LIVE_UPLOAD_DIR       default /var/lib/roadwisefleet/uploads
#   RWF_RETIRED_UPLOAD_DIRS   default /opt/roadwisefleet/api/var/uploads (space list)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIVE_UPLOAD_DIR="${RWF_LIVE_UPLOAD_DIR:-/var/lib/roadwisefleet/uploads}"
RETIRED_UPLOAD_DIRS="${RWF_RETIRED_UPLOAD_DIRS:-/opt/roadwisefleet/api/var/uploads}"

ARTIFACTS=(
  infra/systemd/pilot-disk-check.service
  infra/systemd/pilot-uploads-backup.service
  infra/scripts/pilot-disk-check.sh
  infra/scripts/pilot-uploads-backup.sh
)

fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

usage() {
  printf 'Usage: %s [--live|--self-test|--help]\n' "$(basename "$0")"
  printf '  (no flag)   repo consistency: the storage artifacts agree on the live root\n'
  printf '  --live      audit the live + retired uploads roots for world-readable files\n'
  printf '  --self-test fixture proof of every decision (no host, no network)\n'
}

# --- shared scanner ---------------------------------------------------------
# Scans one root; mutates the global fails/warns counters.
# $1 = root, $2 = label ("live" | "retired").
scan_root() {
  local root="$1"
  local label="$2"
  local mode world_files world_dirs

  if [ ! -d "$root" ]; then
    if [ "$label" = "live" ]; then
      fail "live uploads root does not exist: $root — uploads cannot be stored or checked"
    else
      ok "retired root absent: $root"
    fi
    return 0
  fi

  mode="$(stat -c '%a' "$root" 2>/dev/null || echo '?')"
  world_files="$(find "$root" -type f -perm -o+r 2>/dev/null | wc -l | tr -d '[:space:]')"
  world_dirs="$(find "$root" -type d -perm -o+r 2>/dev/null | wc -l | tr -d '[:space:]')"

  if [ "$world_files" -gt 0 ]; then
    fail "$label uploads root $root has $world_files world-readable file(s) (dir mode $mode) — POD documents must not be world-readable"
  elif [ "$label" = "live" ]; then
    ok "live uploads root $root: no world-readable files (dir mode $mode)"
  fi

  if [ "$world_dirs" -gt 0 ]; then
    warn "$label uploads root $root has $world_dirs world-traversable director(y|ies) (dir mode $mode)"
  fi

  if [ "$label" = "retired" ] && [ "$world_files" -eq 0 ] && [ "$world_dirs" -eq 0 ]; then
    warn "retired uploads root still present but locked down: $root — remove it once the restore drill has confirmed the move"
  fi
  return 0
}

run_live_scan() {
  local d
  local -a retired_list
  printf 'RoadwiseFleet uploads permissions audit — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
  printf 'live root:       %s\n' "$LIVE_UPLOAD_DIR"
  printf 'retired root(s): %s\n\n' "$RETIRED_UPLOAD_DIRS"

  scan_root "$LIVE_UPLOAD_DIR" live
  read -ra retired_list <<< "$RETIRED_UPLOAD_DIRS"
  for d in "${retired_list[@]}"; do
    scan_root "$d" retired
  done

  printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
  if [ "$fails" -gt 0 ]; then
    return 1
  fi
  return 0
}

# --- repo consistency (CI) --------------------------------------------------
check_repo() {
  local a path live_hits retired_hits d
  local -a retired_list

  printf 'RoadwiseFleet uploads storage guard — repo consistency\n'
  printf 'live root (expected): %s\n\n' "$LIVE_UPLOAD_DIR"

  read -ra retired_list <<< "$RETIRED_UPLOAD_DIRS"

  for a in "${ARTIFACTS[@]}"; do
    path="$REPO_ROOT/$a"
    if [ ! -f "$path" ]; then
      fail "artifact missing: $a"
      continue
    fi
    live_hits="$(grep -nE "^[^#]*UPLOAD_DIR=[^ ]*/${LIVE_UPLOAD_DIR#/}" "$path" || true)"
    if [ -n "$live_hits" ]; then
      ok "$a binds UPLOAD_DIR to the live root"
    else
      fail "$a does not bind UPLOAD_DIR to the live root ($LIVE_UPLOAD_DIR)"
    fi
    for d in "${retired_list[@]}"; do
      retired_hits="$(grep -nE "^[^#]*UPLOAD_DIR=[^ ]*/${d#/}" "$path" || true)"
      if [ -n "$retired_hits" ]; then
        fail "$a binds UPLOAD_DIR to the retired root $d (line $retired_hits) — a reinstall would watch an abandoned tree"
      fi
    done
  done

  printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
  if [ "$fails" -gt 0 ]; then
    return 1
  fi
  return 0
}

# --- self-test --------------------------------------------------------------
pass=0
failed=0

expect() { # name want got
  if [ "$2" = "$3" ]; then
    printf 'PASS %s (%s)\n' "$1" "$3"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (got %s, want %s)\n' "$1" "$3" "$2"
    failed=$((failed + 1))
  fi
}

contains() { # name haystack needle
  case "$2" in
    *"$3"*)
      printf 'PASS %s\n' "$1"
      pass=$((pass + 1))
      ;;
    *)
      printf 'FAIL %s (output does not contain: %s)\n' "$1" "$3"
      failed=$((failed + 1))
      ;;
  esac
}

self_test() {
  local st out rc
  st="$(mktemp -d "${TMPDIR:-/tmp}/uploads-perms-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$st'" EXIT

  mkdir -p \
    "$st/live-clean/uploads/trip1/pod" \
    "$st/live-bad/uploads" \
    "$st/retired-bad/uploads" \
    "$st/retired-locked/uploads"
  : > "$st/live-clean/uploads/trip1/pod/ok.jpg"
  : > "$st/live-bad/uploads/leak.jpg"
  : > "$st/retired-bad/uploads/old.jpg"
  : > "$st/retired-locked/uploads/old.jpg"
  chmod 0640 "$st/live-clean/uploads/trip1/pod/ok.jpg"
  chmod 0644 "$st/live-bad/uploads/leak.jpg"
  chmod 0644 "$st/retired-bad/uploads/old.jpg"
  chmod 0600 "$st/retired-locked/uploads/old.jpg"
  chmod 0750 \
    "$st/live-clean/uploads" "$st/live-clean/uploads/trip1" "$st/live-clean/uploads/trip1/pod" \
    "$st/live-bad/uploads" "$st/retired-bad/uploads" "$st/retired-locked/uploads"

  # 1. clean live root, no retired root -> pass silently
  LIVE_UPLOAD_DIR="$st/live-clean/uploads"
  RETIRED_UPLOAD_DIRS="$st/absent-retired"
  fails=0
  warns=0
  run_live_scan > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a clean live root passes (rc)" 0 "$rc"
  expect "a clean live root has no failures" 0 "$fails"
  expect "a clean live root has no warnings" 0 "$warns"

  # 2. world-readable file in the LIVE root -> fail, named
  LIVE_UPLOAD_DIR="$st/live-bad/uploads"
  RETIRED_UPLOAD_DIRS="$st/absent-retired"
  fails=0
  warns=0
  run_live_scan > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a world-readable live file fails (rc)" 1 "$rc"
  expect "a world-readable live file is one failure" 1 "$fails"
  contains "the live failure names the leak" "$out" "world-readable"

  # 3. world-readable file in the RETIRED root -> fail, attributed to the retired tree
  LIVE_UPLOAD_DIR="$st/live-clean/uploads"
  RETIRED_UPLOAD_DIRS="$st/retired-bad/uploads"
  fails=0
  warns=0
  run_live_scan > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a world-readable retired file fails (rc)" 1 "$rc"
  expect "a world-readable retired file is one failure" 1 "$fails"
  contains "the retired failure names the retired root" "$out" "retired uploads root $st/retired-bad/uploads"
  contains "the retired failure says world-readable" "$out" "world-readable"

  # 4. retired root present but locked down -> warn only
  LIVE_UPLOAD_DIR="$st/live-clean/uploads"
  RETIRED_UPLOAD_DIRS="$st/retired-locked/uploads"
  fails=0
  warns=0
  run_live_scan > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a locked-down retired root passes (rc)" 0 "$rc"
  expect "a locked-down retired root has no failures" 0 "$fails"
  expect "a locked-down retired root warns once" 1 "$warns"
  contains "the retired warning says it is still present" "$out" "still present"

  # 5. missing live root -> fail
  LIVE_UPLOAD_DIR="$st/missing/uploads"
  RETIRED_UPLOAD_DIRS="$st/absent-retired"
  fails=0
  warns=0
  run_live_scan > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a missing live root fails (rc)" 1 "$rc"
  expect "a missing live root is one failure" 1 "$fails"
  contains "the missing-live failure says why" "$out" "does not exist"

  printf '\nself-test: %d passed, %d failed\n' "$pass" "$failed"
  if [ "$failed" -gt 0 ]; then
    return 1
  fi
  return 0
}

# --- main -------------------------------------------------------------------
main() {
  case "${1:-}" in
    --self-test) self_test ;;
    --live)      run_live_scan ;;
    --help|-h)   usage; return 0 ;;
    "")          check_repo ;;
    *)           printf 'unknown argument: %s\n' "$1" >&2; usage; return 2 ;;
  esac
}

main "$@"
exit $?
