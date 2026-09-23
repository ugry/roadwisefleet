#!/usr/bin/env bash
# RoadwiseFleet — pilot public-exposure check (READ-ONLY).
#
# Usage:  bash infra/checks/pilot-exposure-check.sh
#         bash infra/checks/pilot-exposure-check.sh 2>&1 | tee /tmp/rwf-exposure-$(date +%Y%m%d-%H%M).txt
#
# Sends only HEAD requests (curl -sI) plus one read-only GET of the local
# /health endpoint. It does not write anything, does not restart anything and
# does not submit to the waitlist. Safe to run before and after a change; diff
# the two outputs for evidence.
#
# Exits non-zero if a hard expectation fails (marked FAIL), so it can gate a
# maintenance step. WARN lines are informational and do not fail the run.

set -uo pipefail

APEX="https://roadwisefleet.com"
WWW="https://www.roadwisefleet.com"
LOCAL_API="http://127.0.0.1:8080/health"

fails=0
warns=0

hdr() { printf '\n=== %s ===\n' "$1"; }

# status <url> -> prints "HTTP <code>" (follows no redirects)
status() {
  curl -sI "$1" 2>/dev/null | awk 'NR==1 {print $2; exit}'
}

# header <url> <name> -> prints the header value, case-insensitively
header() {
  curl -sI "$1" 2>/dev/null | tr -d '\r' | awk -v n="$(printf '%s' "$2" | tr 'A-Z' 'a-z')" '
    index(tolower($0), n ":") == 1 { sub(/^[^:]*:[ ]*/, ""); print; exit }'
}

# location <url> -> prints the Location header value
location() { header "$1" "location"; }

expect_status() { # url want label
  local got; got="$(status "$1")"
  if [ "$got" = "$2" ]; then
    printf '  ok    %-55s HTTP %s\n' "$3" "$got"
  else
    printf '  FAIL  %-55s HTTP %s (want %s)\n' "$3" "$got" "$2"; fails=$((fails + 1))
  fi
}

expect_header() { # url name label
  local got; got="$(header "$1" "$2")"
  if [ -n "$got" ]; then
    printf '  ok    %-55s %s: %s\n' "$3" "$2" "$got"
  else
    printf '  FAIL  %-55s missing %s\n' "$3" "$2"; fails=$((fails + 1))
  fi
}

soft_header() { # url name label
  local got; got="$(header "$1" "$2")"
  if [ -n "$got" ]; then
    printf '  ok    %-55s %s: %s\n' "$3" "$2" "$got"
  else
    printf '  WARN  %-55s missing %s (expected before the header change)\n' "$3" "$2"; warns=$((warns + 1))
  fi
}

printf 'RoadwiseFleet pilot exposure check — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"

hdr "1. Static landing page (apex)"
expect_status "$APEX/" 200 "GET /"
soft_header   "$APEX/" "strict-transport-security" "GET /"
soft_header   "$APEX/" "content-security-policy" "GET /"
soft_header   "$APEX/" "x-frame-options" "GET /"
soft_header   "$APEX/" "x-content-type-options" "GET /"
soft_header   "$APEX/" "referrer-policy" "GET /"

hdr "2. Canonical host (F2)"
expect_status "$APEX/dashboard" 200 "GET /dashboard"
expect_status "http://roadwisefleet.com/" 301 "GET http://apex/"
if [ "$(status "$WWW/")" = "301" ]; then
  printf '  ok    %-55s HTTP 301 -> %s\n' "GET https://www/" "$(location "$WWW/")"
else
  printf '  FAIL  %-55s HTTP %s (want 301 -> %s)\n' "GET https://www/" "$(status "$WWW/")" "$APEX/"
  fails=$((fails + 1))
fi
if [ "$(status "http://www.roadwisefleet.com/")" = "301" ]; then
  printf '  ok    %-55s HTTP 301 -> %s\n' "GET http://www/" "$(location "http://www.roadwisefleet.com/")"
else
  printf '  FAIL  %-55s HTTP %s (want 301 -> %s)\n' "GET http://www/" "$(status "http://www.roadwisefleet.com/")" "$APEX/"
  fails=$((fails + 1))
fi

hdr "3. Pilot web surface"
expect_status "$APEX/pilot/" 200 "GET /pilot/"
expect_status "$APEX/pilot/dashboard.html" 200 "GET /pilot/dashboard.html"
expect_header "$APEX/pilot/" "x-robots-tag" "GET /pilot/"
soft_header   "$APEX/pilot/" "content-security-policy" "GET /pilot/"
if [ "$(status "$APEX/pilot")" = "301" ]; then
  printf '  ok    %-55s HTTP 301 -> %s\n' "GET /pilot (no slash)" "$(location "$APEX/pilot")"
else
  printf '  WARN  %-55s HTTP %s (want 301 -> /pilot/)\n' "GET /pilot (no slash)" "$(status "$APEX/pilot")"
  warns=$((warns + 1))
fi

hdr "4. Routing split (pilot API vs legacy waitlist)"
expect_status "$APEX/api/trips" 401 "GET /api/trips (pilot API auth guard)"
expect_status "$APEX/api/health" 404 "GET /api/health (pilot API, no such route)"
expect_status "$APEX/health" 404 "GET /health (not exposed)"
expect_status "$APEX/api/waitlist" 404 "GET /api/waitlist (waitlist svc, no token)"
if [ -n "$(header "$APEX/api/waitlist" "access-control-allow-origin")" ]; then
  printf '  ok    %-55s served by the 8787 waitlist service\n' "GET /api/waitlist"
else
  printf '  FAIL  %-55s CORS fingerprint missing — is /api/waitlist still on 8787?\n' "GET /api/waitlist"
  fails=$((fails + 1))
fi

hdr "5. Local services (elilavps2)"
expect_status "$LOCAL_API" 200 "GET 127.0.0.1:8080/health (pilot API)"
printf '\n  listening sockets:\n'
ss -ltn 2>/dev/null | awk 'NR==1 || /127\.0\.0\.1:(8080|8787|5432|6379)/ || /:(80|443) /' | sed 's/^/    /'
printf '\n  systemd units:\n'
systemctl status roadwise-api roadwise-pg roadwise-redis roadwisefleet-waitlist 2>/dev/null \
  | awk '/^●|Loaded:|Active:/ {printf "    %s\n", $0}'

hdr "Result"
printf '  failures: %d   warnings: %d\n' "$fails" "$warns"
if [ "$fails" -gt 0 ]; then
  printf '  one or more hard expectations failed — investigate before/after the change\n'
  exit 1
fi
printf '  all hard expectations passed\n'
