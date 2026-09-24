#!/usr/bin/env bash
# RoadwiseFleet — nginx rate-limit preflight (READ-ONLY).
#
# Board #45. `limit_req zone=...` only loads if the zone it names is declared in
# the http context (infra/nginx/conf.d/roadwisefleet-limits.conf). Installing the
# site file before the zones file makes `nginx -t` fail with
# "unknown limit_req_zone" and the reload is refused — fail-closed, but a wasted
# change window. This script checks the pairing BEFORE anything is installed.
#
# It checks:
#   1. every enabled `limit_req zone=X` in the repo site file has a matching
#      `limit_req_zone ... zone=X` in the repo zones file;
#   2. no `limit_req` is enabled while the zones file is missing/unreadable;
#   3. on the host: the live copies agree (live zones file present whenever the
#      live site file enables a limit_req), and prints the install order;
#   4. the enabled/disabled line map, as the "config diff" summary for the change.
#
# Usage:  bash infra/checks/nginx-limits-preflight.sh
# Exit:   0 = consistent and safe to install+reload, 1 = do NOT reload.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE_FILE="${REPO_ROOT}/infra/nginx/roadwisefleet.conf"
ZONES_FILE="${REPO_ROOT}/infra/nginx/conf.d/roadwisefleet-limits.conf"

LIVE_SITE="/etc/nginx/sites-available/roadwisefleet.conf"
LIVE_ZONES="/etc/nginx/conf.d/roadwisefleet-limits.conf"

fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

printf 'RoadwiseFleet nginx rate-limit preflight — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"

if [ ! -f "$SITE_FILE" ]; then
  fail "repo site file not found: $SITE_FILE"
  printf '\n  failures: %d\n' "$fails"
  exit 1
fi
ok "repo site file: ${SITE_FILE#"$REPO_ROOT"/}"

# --- 1. declared zones ------------------------------------------------------
declared=""
if [ -f "$ZONES_FILE" ]; then
  declared="$(grep -oE 'limit_req_zone[^;]*zone=[A-Za-z0-9_]+' "$ZONES_FILE" \
    | grep -oE 'zone=[A-Za-z0-9_]+' | sed 's/^zone=//' | sort -u)"
  ok "repo zones file: ${ZONES_FILE#"$REPO_ROOT"/}"
else
  fail "repo zones file missing: $ZONES_FILE"
fi

enabled="$(grep -nE '^[[:space:]]*limit_req[[:space:]]+zone=' "$SITE_FILE" || true)"
disabled="$(grep -nE '^[[:space:]]*#[[:space:]]*limit_req[[:space:]]+zone=' "$SITE_FILE" || true)"

printf '\n=== 1. zone declarations vs enabled limit_req lines ===\n'
if [ -z "$enabled" ]; then
  warn "no limit_req line is enabled in the site file (rate limiting inert)"
else
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    zone="$(printf '%s' "$line" | grep -oE 'zone=[A-Za-z0-9_]+' | head -n1 | sed 's/^zone=//')"
    lineno="${line%%:*}"
    if printf '%s\n' "$declared" | grep -qx "$zone"; then
      ok "line $lineno: zone=$zone is declared"
    else
      fail "line $lineno: zone=$zone is NOT declared in $(basename "$ZONES_FILE") — nginx -t will refuse the reload"
    fi
  done <<< "$enabled"
fi

printf '\n=== 2. enabled / disabled line map ===\n'
if [ -n "$enabled" ]; then
  printf '  enabled:\n'
  printf '%s\n' "$enabled" | sed 's/^/    /'
else
  printf '  enabled: (none)\n'
fi
if [ -n "$disabled" ]; then
  printf '  disabled:\n'
  printf '%s\n' "$disabled" | sed 's/^/    /'
fi

# --- 3. live host state (only when this runs on the host) -------------------
printf '\n=== 3. live host state ===\n'
if [ -r "$LIVE_SITE" ] || [ -r "$LIVE_ZONES" ]; then
  live_enabled=""
  if [ -r "$LIVE_SITE" ]; then
    live_enabled="$(grep -E '^[[:space:]]*limit_req[[:space:]]+zone=' "$LIVE_SITE" || true)"
    ok "readable: $LIVE_SITE"
  else
    warn "not readable (need sudo): $LIVE_SITE"
  fi
  if [ -r "$LIVE_ZONES" ]; then
    ok "readable: $LIVE_ZONES"
  elif [ -n "$live_enabled" ]; then
    fail "the live site file enables limit_req but $LIVE_ZONES is missing/not installed — install the zones file first"
  else
    warn "not installed yet: $LIVE_ZONES"
  fi
else
  warn "live nginx files not readable from this session — run this check on elilavps2 in the change window"
fi

# --- 4. install order -------------------------------------------------------
printf '\n=== 4. install order (owner-approved window) ===\n'
printf '  1) sudo install -m 0644 infra/nginx/conf.d/roadwisefleet-limits.conf /etc/nginx/conf.d/\n'
printf '  2) sudo install -m 0644 infra/nginx/roadwisefleet.conf /etc/nginx/sites-available/roadwisefleet.conf\n'
printf '  3) sudo nginx -t            # must print "test is successful"; it fails closed\n'
printf '  4) sudo systemctl reload nginx\n'
printf '  5) curl -sI https://roadwisefleet.com/api/waitlist   # routing still answers\n'

printf '\n=== Result ===\n'
printf '  failures: %d   warnings: %d\n' "$fails" "$warns"
if [ "$fails" -gt 0 ]; then
  printf '  do NOT reload nginx until the failures above are fixed\n'
  exit 1
fi
printf '  consistent — safe to install in the order above\n'
