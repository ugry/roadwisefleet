#!/usr/bin/env bash
# RoadwiseFleet — public route wiring check for the apex vhost (READ-ONLY).
#
# Board #87 ("publish the real site"): the public site must be the product entry
# point. Two failure modes are easy to reintroduce and invisible until someone
# visits the URL:
#
#   1. a surface the API serves but nginx does not route — /app/ (board #69) and
#      /c/ (board #87) both answered 404 on the public URL for exactly this
#      reason, while the API was healthy on 127.0.0.1:8080;
#   2. a routed surface with NO header set (add_header does not inherit into a
#      location, so a missing include silently ships an unprotected page), or
#      with the WRONG header set — reusing the pilot snippet's 'unsafe-inline'
#      on a surface that declares no inline code gives up the stricter policy
#      the markup allows (the /app/ mistake, board #69).
#
# This check reads the repo site config and asserts, for every public API-served
# surface (/pilot/, /app/, /c/, /s/, /track/, /api/): a proxying location to
# 127.0.0.1:8080, a rate-limit zone, and a header-snippet include. It also
# asserts the no-slash 301 for /pilot, /app, /c and /s, and — for the
# no-inline-code surfaces /app/, /c/ and /s/ — that the snippet is the strict app
# one, not the pilot one.
#
# Modes:
#   (default)    repo-only, no network — runs in CI (.github/workflows/ci.yml,
#                job `site-routes-check`) on every PR and push.
#   --live       additionally HEAD-probes the public URLs (owner window / after a
#                reload only; never part of CI). Hard expectations are the
#                post-window state: /, /pilot/, /app/, /c/ and /s/ answer 200 and
#                /c and /s answer 301 (live-verified 2026-09-30: /s/ 200 with the
#                app CSP, /s -> 301 /s/).
#   --self-test  fixture assertions proving this check FAILS on a missing
#                location, a location without a header include, a location that
#                does not proxy to the API, a no-inline surface given the pilot
#                snippet, and a missing no-slash 301.
#   --help
#
# Exit: 0 = the route wiring matches the surfaces the API serves, 1 = it does not.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
SITE_CONF="${SITE_CONF:-$REPO_ROOT/infra/nginx/roadwisefleet.conf}"
APEX="${APEX:-https://roadwisefleet.com}"

MODE="check"
for arg in "$@"; do
  case "$arg" in
    --live)      MODE="live" ;;
    --self-test) MODE="self-test" ;;
    --help|-h)   MODE="help" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "help" ]; then
  awk 'NR>1 && /^set -uo pipefail/ { exit } NR>1 { print }' "$SELF"
  exit 0
fi

fails=0
warns=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

# route_block <file> <location-spec> -> the body of that `location ... { }` block
# The spec is everything between the `location` keyword and the opening brace,
# so both prefix locations ("/c/") and exact ones ("= /c") are addressable.
route_block() {
  awk -v want="$2" '
    {
      line = $0
      sub(/^[ \t]*/, "", line)
      if (line ~ /^location[ \t]/) {
        spec = line
        sub(/^location[ \t]+/, "", spec)
        sub(/[ \t]*\{.*$/, "", spec)
        body = ""
        inblock = (spec == want)
      }
      if (inblock) {
        n = gsub(/\{/, "{", line); depth += n
        m = gsub(/\}/, "}", line); depth -= m
        print
        if (depth <= 0) { exit }
      }
    }' "$1"
}

has() { # has <haystack> <fixed-string>
  printf '%s\n' "$1" | grep -qF -- "$2"
}

check_location() { # check_location <spec> <label> [snippet-must-be]
  local spec="$1" label="$2" want_snippet="${3:-}" body
  body="$(route_block "$SITE_CONF" "$spec")"
  if [ -z "$body" ]; then
    fail "$label: no 'location $spec' block in ${SITE_CONF##*/} — the surface is not routed and answers 404 on the public URL"
    return 0
  fi
  if has "$body" "proxy_pass http://127.0.0.1:8080"; then
    ok "$label: proxies to 127.0.0.1:8080"
  else
    fail "$label: does not proxy to 127.0.0.1:8080 (the API is loopback-only, so the surface is unreachable)"
  fi
  if has "$body" "limit_req zone="; then
    ok "$label: rate-limited ($(printf '%s\n' "$body" | grep -oE 'zone=[A-Za-z0-9_]+' | head -n1))"
  else
    fail "$label: no limit_req zone — an unthrottled public surface"
  fi
  if has "$body" "include /etc/nginx/snippets/roadwisefleet-headers-"; then
    ok "$label: includes a header snippet"
  else
    fail "$label: no 'include .../roadwisefleet-headers-*.conf' — add_header does not inherit into a location, so the page ships unprotected"
  fi
  if [ -n "$want_snippet" ]; then
    if has "$body" "include /etc/nginx/snippets/$want_snippet"; then
      ok "$label: uses $want_snippet"
    else
      fail "$label: must use $want_snippet (a no-inline-site surface must not get the pilot snippet's 'unsafe-inline' policy)"
    fi
  fi
  return 0
}

check_redirect() { # check_redirect <spec> <label> <must-contain-or-empty>
  local spec="$1" label="$2" needle="${3:-}" body
  body="$(route_block "$SITE_CONF" "$spec")"
  if [ -z "$body" ]; then
    fail "$label: no 'location $spec' block — the no-slash form falls through to the static root (404 or the wrong page)"
    return 0
  fi
  if has "$body" "return 301"; then
    ok "$label: 301 ('$(printf '%s\n' "$body" | grep -oE 'return 301 [^;]+' | head -n1)')"
    if [ -n "$needle" ] && ! has "$body" "$needle"; then
      fail "$label: 301 target does not contain $needle"
    fi
  else
    fail "$label: not a 301"
  fi
  return 0
}

check_site() {
  if [ ! -f "$SITE_CONF" ]; then
    fail "site config not found: $SITE_CONF"
    return 0
  fi
  printf '\n=== route wiring (%s) ===\n' "${SITE_CONF#"$REPO_ROOT"/}"

  # API-served surfaces. /app/, /c/ and /s/ are the ones that regressed to 404
  # because the location was never added (boards #69, #87, #75).
  printf '\n-- API-served surfaces (must proxy to 127.0.0.1:8080) --\n'
  check_location "/pilot/" "GET /pilot/" ""
  check_location "/app/"   "GET /app/"   "roadwisefleet-headers-app.conf"
  check_location "/c/"     "GET /c/"     "roadwisefleet-headers-app.conf"
  check_location "/s/"     "GET /s/"     "roadwisefleet-headers-app.conf"
  check_location "/track/" "GET /track/" ""
  check_location "/api/"   "GET /api/"   ""

  printf '\n-- no-slash redirects --\n'
  check_redirect "= /pilot" "GET /pilot" "/pilot/"
  check_redirect "= /app"   "GET /app"   "/app/"
  check_redirect "= /c"     "GET /c"     "/c/"
  check_redirect "= /s"     "GET /s"     "/s/"
  return 0
}

live_check() {
  local code
  printf '\n=== live probes (%s) ===\n' "$APEX"
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available — skipping the live probes"
    return 0
  fi
  probe() { # probe <url> <want> <hard|soft> <label>
    code="$(curl -sI "$1" 2>/dev/null | awk 'NR==1 {print $2; exit}')"
    if [ "$code" = "$2" ]; then
      ok "$4: HTTP $code"
    elif [ "$3" = "hard" ]; then
      fail "$4: HTTP ${code:-none} (want $2)"
    else
      warn "$4: HTTP ${code:-none} (want $2 after the owner window)"
    fi
  }
  probe "$APEX/"          200 hard "GET / (the product entry point)"
  probe "$APEX/pilot/"    200 hard "GET /pilot/ (kept working during the transition)"
  probe "$APEX/app/"      200 hard "GET /app/"
  probe "$APEX/c/"        200 hard "GET /c/"
  probe "$APEX/c"         301 hard "GET /c (nginx-side 301)"
  probe "$APEX/s/"        200 hard "GET /s/ (solo-driver surface, board #87)"
  probe "$APEX/s"         301 hard "GET /s (nginx-side 301)"
  return 0
}

self_test() {
  local tmp out rc passed=0 failed=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/site-routes-selftest.XXXXXX")" || return 2

  mk_route() { # mk_route <file> <extra-locations>
    cat > "$1" <<CONF
server {
    server_name roadwisefleet.com;
    location /pilot/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-pilot.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /pilot { return 301 https://roadwisefleet.com/pilot/; }
    location /app/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-app.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /app { return 301 https://roadwisefleet.com/app/; }
    $2
    location /s/ {
        limit_req zone=rwf_share burst=20 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-app.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /s { return 301 https://roadwisefleet.com/s/; }
    location /track/ {
        limit_req zone=rwf_share burst=20 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-pilot.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location /api/ {
        limit_req zone=rwf_api burst=60 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-api.conf;
        proxy_pass http://127.0.0.1:8080;
    }
}
CONF
  }

  GOOD_LOCATIONS='location /c/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-app.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /c { return 301 https://roadwisefleet.com/c/; }'

  mk_route "$tmp/good.conf" "$GOOD_LOCATIONS"
  # 1. /c/ missing entirely (the board #87 live state: /c/ -> 404)
  mk_route "$tmp/missing.conf" ""
  # 2. /c/ with no header include
  mk_route "$tmp/noheader.conf" 'location /c/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /c { return 301 https://roadwisefleet.com/c/; }'
  # 3. /c/ that does not proxy to the API
  mk_route "$tmp/noproxy.conf" 'location /c/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-app.conf;
        try_files $uri $uri/ =404;
    }
    location = /c { return 301 https://roadwisefleet.com/c/; }'
  # 4. /c/ given the pilot snippet (widening the policy on a no-inline surface)
  mk_route "$tmp/pilotpolicy.conf" 'location /c/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-pilot.conf;
        proxy_pass http://127.0.0.1:8080;
    }
    location = /c { return 301 https://roadwisefleet.com/c/; }'
  # 5. /c/ present but no no-slash redirect
  mk_route "$tmp/noredirect.conf" 'location /c/ {
        limit_req zone=rwf_pilot burst=40 nodelay;
        include /etc/nginx/snippets/roadwisefleet-headers-app.conf;
        proxy_pass http://127.0.0.1:8080;
    }'

  run_case() { # run_case <label> <conf> <expected-exit> <needle>
    out="$(SITE_CONF="$2" bash "$SELF" 2>&1)"
    rc=$?
    if [ "$rc" != "$3" ]; then
      printf 'FAIL %s: got exit %s, want %s\n' "$1" "$rc" "$3"
      printf '%s\n' "$out" | sed 's/^/        /'
      failed=$((failed + 1))
      return 0
    fi
    if [ -n "$4" ] && ! printf '%s\n' "$out" | grep -qF -- "$4"; then
      printf 'FAIL %s: exit %s but the output never says "%s"\n' "$1" "$rc" "$4"
      printf '%s\n' "$out" | sed 's/^/        /'
      failed=$((failed + 1))
      return 0
    fi
    printf 'PASS %s (exit %s)\n' "$1" "$rc"
    passed=$((passed + 1))
    return 0
  }

  run_case "complete wiring is accepted" "$tmp/good.conf" 0 "failures: 0"
  run_case "a missing /c/ location is rejected (the 404 regression)" "$tmp/missing.conf" 1 "GET /c/: no 'location /c/' block"
  run_case "a /c/ without a header include is rejected" "$tmp/noheader.conf" 1 "no 'include .../roadwisefleet-headers-*.conf'"
  run_case "a /c/ that does not proxy to the API is rejected" "$tmp/noproxy.conf" 1 "does not proxy to 127.0.0.1:8080"
  run_case "the pilot snippet on the no-inline /c/ surface is rejected" "$tmp/pilotpolicy.conf" 1 "must use roadwisefleet-headers-app.conf"
  run_case "a missing /c no-slash redirect is rejected" "$tmp/noredirect.conf" 1 "GET /c: no 'location = /c' block"

  rm -rf "$tmp"
  printf '\nself-test: %d passed, %d failed\n' "$passed" "$failed"
  if [ "$failed" != 0 ]; then return 1; fi
  return 0
}

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

printf 'RoadwiseFleet public route wiring check — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
check_site
if [ "$MODE" = "live" ]; then
  live_check
fi

printf '\n=== Result ===\n'
printf '  failures: %d   warnings: %d\n' "$fails" "$warns"
if [ "$fails" -gt 0 ]; then
  printf '  a public surface is not wired correctly — do NOT install/reload; fix the site config first\n'
  exit 1
fi
printf '  every API-served surface is routed, rate-limited and header-protected — safe to install in the change window\n'
exit 0
