#!/usr/bin/env bash
# RoadwiseFleet — share-token surface guard (board eila/tasks#75, UXF-O1).
#
# The board #75 guest surfaces carry a capability token in the URL path:
# /track/<token> for the tracking page, /s/<token> — which became the
# solo-driver shell — and /g/<scope>/<token> for the POD/eCMR download and the
# invoice view (board #132, the app half of #75; it has its own prefix because
# /s/ and /track/ each belong to another surface). Two things must hold for
# every location that can carry a token:
#
#   1. the surface is rate-limited by the dedicated `rwf_share` zone (a token
#      that can be enumerated is not a capability), and
#   2. the access log must NOT contain the token — the default `combined`
#      format logs $request / $http_referer verbatim, and the page's own
#      same-origin fetch sends the token back in the Referer. A token in a log
#      outlives the link's expiry and its revocation.
#
# Board #91 semantics note: /s/ is now the solo-driver shell (board #77/#87) and
# NOT the #75 document/invoice route. It is deliberately KEPT on `rwf_share` +
# the token-free log: the board #75 review decided not to relax a merged guard.
# The `/s/` live probe therefore accepts a 200 only when the answer IS the solo
# shell (text/html, no attachment, no cookie) — a 200 carrying document bytes or
# a cookie stays a FAIL.
#
# Two independent jobs:
#
#   repo mode (default; runs in CI, needs no host): the repo nginx files must
#   wire every share location to the `rwf_share` zone and to a log format that
#   cannot carry the token.
#
#   --live (run on elilavps2 / any host with curl): probe a random token and
#   assert the acceptance-relevant behaviour — a share shell answers without
#   setting a cookie, an unknown token is a clear 404/410 (never data), the
#   guest document/invoice surface never answers an unknown token with a 200,
#   and a rapid loop trips the 429. Prints the transcript.
#
# Usage:
#   bash infra/checks/share-link-check.sh             # repo consistency (CI)
#   bash infra/checks/share-link-check.sh --live      # host/URL probes
#   bash infra/checks/share-link-check.sh --self-test # fixture proof
#   bash infra/checks/share-link-check.sh --help
# Exit: 0 ok, 1 a real failure, 2 usage error.
#
# Env overrides:
#   RWF_SITE_FILE    default <repo>/infra/nginx/roadwisefleet.conf
#   RWF_ZONES_FILE   default <repo>/infra/nginx/conf.d/roadwisefleet-limits.conf
#   RWF_BASE_URL     default https://roadwisefleet.com          (--live)
#   RWF_CURL         default curl                                 (--live/self-test)
#   RWF_RATE_LOOP    default 60                                  (--live)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE_FILE="${RWF_SITE_FILE:-$REPO_ROOT/infra/nginx/roadwisefleet.conf}"
ZONES_FILE="${RWF_ZONES_FILE:-$REPO_ROOT/infra/nginx/conf.d/roadwisefleet-limits.conf}"
BASE_URL="${RWF_BASE_URL:-https://roadwisefleet.com}"
CURL_BIN="${RWF_CURL:-curl}"
RATE_LOOP="${RWF_RATE_LOOP:-60}"

# Variables a share-surface log format must never contain: they carry the
# request line / URI (and therefore the token) or visitor identifiers.
FORBIDDEN_LOG_VARS='(\$request([^a-zA-Z0-9_]|$)|\$request_uri|\$uri([^a-zA-Z0-9_]|$)|\$document_uri|\$args([^a-zA-Z0-9_]|$)|\$query_string|\$http_referer|\$http_user_agent)'
# Locations that can carry a share token (see the board #91 semantics note in
# the header): /track/ = the board #75 tracking page; /s/ = the solo-driver
# shell; /g/ = the guest document + invoice views (board #132, UXF-O1a — the
# app half of #75 that needed no provider). /g/ arrived last, so it is the only
# one whose token route actually exists; /s/ is kept on the guard because the
# merged board #75 review decided not to relax it.
SHARE_LOCATIONS=("/track/" "/s/" "/g/")

fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

usage() {
  printf 'Usage: %s [--live|--self-test|--help]\n' "$(basename "$0")"
  printf '  (no flag)   repo consistency: share locations use rwf_share + a token-free log format\n'
  printf '  --live      probe a random token on the share surfaces (cookie-free, 404, 429)\n'
  printf '  --self-test fixture proof of every decision (no host, no network)\n'
}

# --- shared helpers ---------------------------------------------------------

# Print one `location <want> { ... }` block from a file (exact substring match
# on the location line; stops at the closing brace in column 0).
extract_location() { # file, location-prefix
  awk -v want="location $2 {" '
    index($0, want) > 0 { inside = 1 }
    inside { print }
    inside && /^[[:space:]]*}/ { exit }
  ' "$1"
}

# Print the whole `log_format rwf_share ...;` statement (it may span lines).
log_format_body() { # file
  awk '
    /^[[:space:]]*log_format[[:space:]]+rwf_share/ { inside = 1 }
    inside { printf "%s\n", $0 }
    inside && /;/ { exit }
  ' "$1"
}

# --- repo consistency (CI) --------------------------------------------------
check_repo() {
  local block zone hits declared body

  printf 'RoadwiseFleet share-link guard — repo consistency\n'
  printf 'site file:  %s\n' "${SITE_FILE#"$REPO_ROOT"/}"
  printf 'zones file: %s\n\n' "${ZONES_FILE#"$REPO_ROOT"/}"

  if [ ! -f "$SITE_FILE" ]; then
    fail "site file missing: $SITE_FILE"
    printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
    return 1
  fi
  if [ ! -f "$ZONES_FILE" ]; then
    fail "zones file missing: $ZONES_FILE"
    printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
    return 1
  fi

  # 1. the dedicated zone exists.
  declared="$(grep -oE 'limit_req_zone[^;]*zone=rwf_share' "$ZONES_FILE" || true)"
  if [ -n "$declared" ]; then
    ok "zones file declares the dedicated rwf_share zone"
  else
    fail "zones file does not declare zone=rwf_share (share surfaces would share the pilot zone)"
  fi

  # 2. 429, not the default 503.
  if grep -qE '^[[:space:]]*limit_req_status[[:space:]]+429' "$ZONES_FILE"; then
    ok "limit_req_status 429 is set"
  else
    fail "limit_req_status 429 is missing (429 is the clear, retryable rate-limit status)"
  fi

  # 3. every share location uses the zone and the redacted log.
  for zone in "${SHARE_LOCATIONS[@]}"; do
    block="$(extract_location "$SITE_FILE" "$zone")"
    if [ -z "$block" ]; then
      fail "no 'location $zone' block in the site file"
      continue
    fi
    if printf '%s\n' "$block" | grep -qE '^[[:space:]]*limit_req[[:space:]]+zone=rwf_share'; then
      ok "location $zone is rate-limited by rwf_share"
    else
      fail "location $zone does not use zone=rwf_share"
    fi
    if printf '%s\n' "$block" | grep -qE '^[[:space:]]*access_log[[:space:]].*rwf_share'; then
      ok "location $zone logs with the rwf_share format"
    else
      fail "location $zone has no 'access_log ... rwf_share' — the default combined log would record the token"
    fi
  done

  # 4. the log format exists and cannot carry the token.
  body="$(log_format_body "$ZONES_FILE")"
  if [ -z "$body" ]; then
    fail "no 'log_format rwf_share' in the zones file (the share locations reference it)"
  else
    if printf '%s\n' "$body" | grep -qE 'rwf_share_path'; then
      ok "log_format rwf_share uses the redacted \$rwf_share_path"
    else
      fail "log_format rwf_share does not use the redacted \$rwf_share_path"
    fi
    hits="$(printf '%s\n' "$body" | grep -nE "$FORBIDDEN_LOG_VARS" || true)"
    if [ -n "$hits" ]; then
      fail "log_format rwf_share leaks the request/token: $hits"
    else
      ok "log_format rwf_share contains no \$request/\$uri/referer/user-agent variable"
    fi
  fi

  # 5. the redaction map exists.
  if grep -qE '^[[:space:]]*map[[:space:]]+\$uri[[:space:]]+\$rwf_share_path' "$ZONES_FILE"; then
    ok "the \$uri -> \$rwf_share_path redaction map is declared"
  else
    fail "the \$uri -> \$rwf_share_path redaction map is missing from the zones file"
  fi

  printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
  if [ "$fails" -gt 0 ]; then
    return 1
  fi
  return 0
}

# --- live probes ------------------------------------------------------------
random_token() {
  head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' | cut -c1-64
}

headers_for() { # url -> headers
  "$CURL_BIN" -sI --max-time 10 "$1" 2>/dev/null
}

status_for() { # url -> status code
  "$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null
}

header_value() { # headers, name -> value (last match, CR stripped)
  printf '%s\n' "$1" | grep -i -m1 "^$2:" | cut -d: -f2- | tr -d '\r' | sed 's/^[[:space:]]*//'
}

status_of() { # headers -> 3-digit status ("" when absent)
  printf '%s\n' "$1" | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]+' | awk '{print $2}'
}

run_live() {
  local tok shell_h api_h api_status s_h s_status s_type s_disp scope g_h g_status i code got429

  printf 'RoadwiseFleet share-link probe — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
  printf 'base: %s\n' "$BASE_URL"
  tok="$(random_token)"
  printf 'random token: %.16s… (%d chars)\n\n' "$tok" "${#tok}"

  # 1. the share shell answers, without a cookie, and is noindex.
  shell_h="$(headers_for "$BASE_URL/track/$tok")"
  if printf '%s\n' "$shell_h" | grep -qE '^HTTP/[0-9.]+ 200'; then
    ok "GET /track/<random> -> 200 (the shell does not need a token to exist)"
  else
    fail "GET /track/<random> did not return 200: $(printf '%s' "$shell_h" | grep -m1 '^HTTP/')"
  fi
  if printf '%s\n' "$shell_h" | grep -qiE '^set-cookie:'; then
    fail "the share shell set a cookie — a guest link must work with no account and no cookie"
  else
    ok "the share shell sets no cookie"
  fi
  if printf '%s\n' "$shell_h" | grep -qiE '^x-robots-tag:.*noindex'; then
    ok "X-Robots-Tag: noindex is present on the share shell"
  else
    fail "X-Robots-Tag: noindex is missing on the share shell (a shared customer link must not be indexed)"
  fi

  # 2. an unknown token is a clear not-found, never data.
  api_h="$(headers_for "$BASE_URL/api/track/$tok")"
  api_status="$(printf '%s\n' "$api_h" | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]+' | awk '{print $2}')"
  if [ "$api_status" = "404" ] || [ "$api_status" = "410" ]; then
    ok "GET /api/track/<random> -> $api_status (unknown/expired/revoked = clear not-found)"
  else
    fail "GET /api/track/<random> -> ${api_status:-no response} (want 404 or 410; a 200 would be an auth bypass)"
  fi
  if printf '%s\n' "$api_h" | grep -qiE '^set-cookie:'; then
    fail "GET /api/track/<random> set a cookie"
  fi

  # 3. /s/: the solo-driver shell (board #87) answers here. A 200 is acceptable
  #    ONLY when it is that shell — text/html, no attachment, no cookie — and an
  #    unknown path may also be a 404/410. Anything else (document bytes, a PDF,
  #    a cookie, a 5xx) stays a FAIL: this is the "never 200 with data" invariant.
  s_h="$(headers_for "$BASE_URL/s/$tok")"
  s_status="$(status_of "$s_h")"
  s_type="$(header_value "$s_h" 'content-type')"
  s_disp="$(header_value "$s_h" 'content-disposition')"
  if [ "$s_status" = "404" ] || [ "$s_status" = "410" ]; then
    ok "GET /s/<random> -> $s_status (unknown path; no share token is exposed)"
  elif [ "$s_status" = "200" ]; then
    if printf '%s\n' "$s_h" | grep -qiE '^set-cookie:'; then
      fail "GET /s/<random> -> 200 but it SET A COOKIE — a guest path must never set one"
    elif [ -n "$s_disp" ]; then
      fail "GET /s/<random> -> 200 with Content-Disposition ($s_disp) — that is a document download, not the solo shell"
    else
      case "$s_type" in
        text/html*)
          ok "GET /s/<random> -> 200 (the solo-driver shell: text/html, no cookie, no attachment)"
          ;;
        *)
          fail "GET /s/<random> -> 200 '${s_type:-no content-type}' — a 200 here must be the text/html solo shell (board #91), never data"
          ;;
      esac
    fi
  elif [ -z "$s_status" ]; then
    warn "GET /s/<random> produced no response (surface not routed yet)"
  else
    fail "GET /s/<random> -> $s_status (want 404/410 for an unknown path, or 200 with the solo shell)"
  fi

  # 4. /g/: the guest document + invoice surface (board #132). An unknown token
  #    must be a clear 404/410 — never a 200 and never a document body — and it
  #    must not set a cookie. This is the acceptance row board #75 carried.
  for scope in document invoice; do
    g_h="$(headers_for "$BASE_URL/g/$scope/$tok")"
    g_status="$(status_of "$g_h")"
    if [ "$g_status" = "404" ] || [ "$g_status" = "410" ]; then
      ok "GET /g/$scope/<random> -> $g_status (unknown token: no document, no existence leak)"
    else
      fail "GET /g/$scope/<random> -> ${g_status:-no response} (want 404/410; a 200 would be an auth bypass)"
    fi
    if printf '%s\n' "$g_h" | grep -qiE '^set-cookie:'; then
      fail "GET /g/$scope/<random> set a cookie — the guest view must need no account and no cookie"
    fi
  done

  # 5. the rate limit trips under a simple loop.
  got429=0
  i=0
  while [ "$i" -lt "$RATE_LOOP" ]; do
    code="$(status_for "$BASE_URL/track/$tok")"
    if [ "$code" = "429" ]; then
      got429=$((got429 + 1))
    fi
    i=$((i + 1))
  done
  if [ "$got429" -gt 0 ]; then
    ok "rate limit holds: $got429 of $RATE_LOOP rapid requests to /track/ were 429"
  else
    fail "no 429 in $RATE_LOOP rapid requests — the share zone is not enforcing (or is far too wide)"
  fi

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

write_zones_good() {
  cat > "$1" <<'EOF'
limit_req_zone $binary_remote_addr zone=rwf_share:10m rate=10r/s;
limit_req_status 429;
map $uri $rwf_share_path {
    default         $uri;
    ~^/(track|s|g)/ /$1/<token>;
}
log_format rwf_share '$remote_addr - $remote_user [$time_local] '
                     '"$request_method $rwf_share_path $server_protocol" '
                     '$status $body_bytes_sent';
EOF
}

write_zones_leaky() {
  cat > "$1" <<'EOF'
limit_req_zone $binary_remote_addr zone=rwf_share:10m rate=10r/s;
limit_req_status 429;
map $uri $rwf_share_path {
    default         $uri;
    ~^/(track|s|g)/ /$1/<token>;
}
log_format rwf_share '$remote_addr "$request" $status $http_referer';
EOF
}

write_site_good() {
  cat > "$1" <<'EOF'
server {
    location /track/ {
        limit_req zone=rwf_share burst=20 nodelay;
        access_log /var/log/nginx/roadwisefleet-share.access.log rwf_share;
        proxy_pass http://127.0.0.1:8080;
    }
    location /s/ {
        limit_req zone=rwf_share burst=20 nodelay;
        access_log /var/log/nginx/roadwisefleet-share.access.log rwf_share;
        proxy_pass http://127.0.0.1:8080;
    }
    location /g/ {
        limit_req zone=rwf_share burst=20 nodelay;
        access_log /var/log/nginx/roadwisefleet-share.access.log rwf_share;
        proxy_pass http://127.0.0.1:8080;
    }
}
EOF
}

write_site_no_share() {
  cat > "$1" <<'EOF'
server {
    location /track/ {
        limit_req zone=rwf_pilot burst=20 nodelay;
        proxy_pass http://127.0.0.1:8080;
    }
}
EOF
}

self_test() {
  local st out rc
  st="$(mktemp -d "${TMPDIR:-/tmp}/share-link-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$st'" EXIT

  write_zones_good "$st/zones-good.conf"
  write_zones_leaky "$st/zones-leaky.conf"
  write_site_good "$st/site-good.conf"
  write_site_no_share "$st/site-no-share.conf"

  # 1. the real repo files pass.
  fails=0
  warns=0
  SITE_FILE="$REPO_ROOT/infra/nginx/roadwisefleet.conf"
  ZONES_FILE="$REPO_ROOT/infra/nginx/conf.d/roadwisefleet-limits.conf"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "the real repo files pass (rc)" 0 "$rc"
  expect "the real repo files have no failures" 0 "$fails"
  contains "the repo check names the rwf_share zone" "$out" "declares the dedicated rwf_share zone"

  # 2. a leaky log format FAILS and is named.
  fails=0
  warns=0
  SITE_FILE="$st/site-good.conf"
  ZONES_FILE="$st/zones-leaky.conf"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a leaky log format fails (rc)" 1 "$rc"
  contains "the leak is named as a leak" "$out" "leaks the request/token"

  # 3. a share location missing rwf_share FAILS.
  fails=0
  warns=0
  SITE_FILE="$st/site-no-share.conf"
  ZONES_FILE="$st/zones-good.conf"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a wrong-zone share location fails (rc)" 1 "$rc"
  contains "the wrong zone is named" "$out" "does not use zone=rwf_share"
  contains "the missing /s/ block is named" "$out" "no 'location /s/' block"

  # 4. live probes, with a stubbed curl: the acceptance decisions must fire.
  cat > "$st/curl-stub" <<'EOF'
#!/usr/bin/env bash
# Minimal curl stub for two modes: -I (headers) and the status-code probe.
# NOTE the case order: /api/track/ must be tested BEFORE /track/, because
# "/api/track/x" also contains "/track/".
url="${!#}"
case "$*" in
  *-w*)
    case "$url" in
      */api/track/*) echo 404 ;;
      */g/document/*) echo 404 ;;
      */g/invoice/*) echo 404 ;;
      */track/*) echo 429 ;;
      *) echo 404 ;;
    esac
    ;;
  *)
    case "$url" in
      */api/track/*) printf 'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n' ;;
      */g/document/*|*/g/invoice/*) printf 'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n' ;;
      */track/*) printf 'HTTP/1.1 200 OK\r\nX-Robots-Tag: noindex, nofollow\r\n\r\n' ;;
      */s/*) printf 'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' ;;
      *) printf 'HTTP/1.1 200 OK\r\n\r\n' ;;
    esac
    ;;
esac
EOF
  chmod +x "$st/curl-stub"

  fails=0
  warns=0
  CURL_BIN="$st/curl-stub"
  BASE_URL="https://example.test"
  RATE_LOOP=5
  run_live > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a healthy stub run passes (rc)" 0 "$rc"
  expect "a healthy stub run has no failures" 0 "$fails"
  contains "the shell 200 is recognised" "$out" "GET /track/<random> -> 200"
  contains "the no-cookie result is recognised" "$out" "sets no cookie"
  contains "the unknown token 404 is recognised" "$out" "unknown/expired/revoked = clear not-found"
  contains "the rate limit result is recognised" "$out" "rate limit holds"
  contains "the solo shell at /s/ is accepted" "$out" "the solo-driver shell: text/html, no cookie, no attachment"
  contains "an unknown /g/ document token is a clear not-found" "$out" "GET /g/document/<random> -> 404"
  contains "an unknown /g/ invoice token is a clear not-found" "$out" "GET /g/invoice/<random> -> 404"

  # 5. a cookie-setting shell with a 200 API must FAIL (the two worst outcomes).
  cat > "$st/curl-bad" <<'EOF'
#!/usr/bin/env bash
url="${!#}"
case "$*" in
  *-w*) echo 200 ;;
  *)
    case "$url" in
      */api/track/*) printf 'HTTP/1.1 200 OK\r\nSet-Cookie: sid=1\r\n\r\n' ;;
      *) printf 'HTTP/1.1 200 OK\r\nSet-Cookie: sid=1\r\n\r\n' ;;
    esac
    ;;
esac
EOF
  chmod +x "$st/curl-bad"

  fails=0
  warns=0
  CURL_BIN="$st/curl-bad"
  BASE_URL="https://example.test"
  RATE_LOOP=5
  run_live > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a cookie-setting, 200-API surface fails (rc)" 1 "$rc"
  contains "the cookie is reported" "$out" "set a cookie"
  contains "the 200 on an unknown token is reported" "$out" "a 200 would be an auth bypass"

  # 6. a /g/ 200 (a document leak) and an /s/ 200 that is a document download
  #    must both FAIL — the assertion board #75/#132 actually care about.
  cat > "$st/curl-leak" <<'EOF'
#!/usr/bin/env bash
url="${!#}"
case "$*" in
  *-w*)
    case "$url" in
      */api/track/*) echo 404 ;;
      */g/*) echo 200 ;;
      */track/*) echo 429 ;;
      *) echo 404 ;;
    esac
    ;;
  *)
    case "$url" in
      */api/track/*) printf 'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n' ;;
      */g/document/*) printf 'HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="pod.pdf"\r\n\r\n' ;;
      */g/invoice/*) printf 'HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: inline\r\n\r\n' ;;
      */track/*) printf 'HTTP/1.1 200 OK\r\nX-Robots-Tag: noindex, nofollow\r\n\r\n' ;;
      */s/*) printf 'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment\r\n\r\n' ;;
      *) printf 'HTTP/1.1 200 OK\r\n\r\n' ;;
    esac
    ;;
esac
EOF
  chmod +x "$st/curl-leak"

  fails=0
  warns=0
  CURL_BIN="$st/curl-leak"
  BASE_URL="https://example.test"
  RATE_LOOP=5
  run_live > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a leaked /g/ document fails (rc)" 1 "$rc"
  contains "the /g/ 200 is named a bypass" "$out" "GET /g/document/<random> -> 200"
  contains "the /g/ 200 names the auth bypass" "$out" "a 200 would be an auth bypass"
  contains "the /s/ download is named" "$out" "that is a document download, not the solo shell"

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
    --live)      run_live ;;
    --help|-h)   usage; return 0 ;;
    "")          check_repo ;;
    *)           printf 'unknown argument: %s\n' "$1" >&2; usage; return 2 ;;
  esac
}

main "$@"
exit $?
