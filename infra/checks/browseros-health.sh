#!/usr/bin/env bash
# RoadwiseFleet — BrowserOS health check (board eila/tasks#8).
#
# browseros.service is the headless BrowserOS + CDP + MCP browser server that
# the agent sessions (Max, Brooklyn, Victor) drive for browser-based QA and
# verification. Its failure mode is deceptive: the unit reports
# `active (running)` and the MCP `/health` endpoint answers 200, while every
# window/tab operation fails with
#
#     tabs failed: CDP error: No browser window available
#
# because the profile has never completed first-run onboarding — CDP's
# /json/list then holds exactly one page target, `chrome://browseros-onboarding/`,
# and no drivable page. `systemctl status` cannot see that, which is why this
# check exists: it asserts the precondition the MCP tab/window calls need.
#
# Modes:
#   --live       (on elilavps2) unit active + MCP healthy + CDP up + at least
#                one drivable page; exit 1 when the known defect is present, so
#                it can be wired into monitoring.
#   --self-test  fixture proof of every decision (no host, no network).
#   --help
# Exit: 0 ok (warnings allowed), 1 a real failure, 2 usage error.
#
# Env overrides:
#   RWF_BROWSEROS_UNIT   default browseros.service
#   RWF_BROWSEROS_MCP    default http://127.0.0.1:9200
#   RWF_BROWSEROS_CDP    default http://127.0.0.1:9101
#
# Limits (stated, not hidden): this check cannot call the MCP tools itself, so
# it asserts the *precondition* a drivable page — the acceptance test
# (`tabs new` + `navigate` + `snapshot`) still needs an MCP client session.
# Runbook: infra/browseros.md.

set -uo pipefail

UNIT="${RWF_BROWSEROS_UNIT:-browseros.service}"
MCP_BASE="${RWF_BROWSEROS_MCP:-http://127.0.0.1:9200}"
CDP_BASE="${RWF_BROWSEROS_CDP:-http://127.0.0.1:9101}"
ONBOARDING_URL="chrome://browseros-onboarding/"

fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

usage() {
  printf 'Usage: %s [--live|--self-test|--help]\n' "$(basename "$0")"
  printf '  (no flag)   same as --live\n'
  printf '  --live      assert the browser is up AND has a drivable page (run on elilavps2)\n'
  printf '  --self-test fixture proof of every decision (no host, no network)\n'
}

# --- probes -----------------------------------------------------------------
# probe URL -> sets PROBE_CODE (HTTP status, "000" when curl could not connect)
#               and PROBE_BODY.
probe() {
  local out
  PROBE_CODE="000"
  PROBE_BODY=""
  if ! out="$(curl -sS -m 5 -w $'\n%{http_code}' "$1" 2>/dev/null)"; then
    return 0
  fi
  PROBE_CODE="${out##*$'\n'}"
  PROBE_BODY="${out%$'\n'*}"
  return 0
}

# page_urls BODY -> the drivable page URLs, one per line.
# CDP /json/list is an array of flat target objects; walk each object and keep
# only type="page", dropping the onboarding page and devtools inspectors (the
# two targets that exist precisely when there is no usable window).
page_urls() {
  local flat obj type url
  flat="$(tr -d '\n' <<<"$1")"
  while IFS= read -r obj; do
    [ -n "$obj" ] || continue
    type="$(sed -nE 's/.*"type"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' <<<"$obj")"
    [ "$type" = "page" ] || continue
    url="$(sed -nE 's/.*"url"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' <<<"$obj")"
    [ -n "$url" ] || continue
    case "$url" in
      "$ONBOARDING_URL"*|devtools://*) continue ;;
    esac
    printf '%s\n' "$url"
  done < <(grep -oE '\{[^{}]*\}' <<<"$flat" || true)
}

has_onboarding() {
  grep -q 'chrome://browseros-onboarding' <<<"$1"
}

# --- live check -------------------------------------------------------------
run_live_check() {
  local state list urls n
  printf 'RoadwiseFleet BrowserOS health — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
  printf 'unit: %s   MCP: %s   CDP: %s\n\n' "$UNIT" "$MCP_BASE" "$CDP_BASE"

  state="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
  state="$(printf '%s' "$state" | tr -d '[:space:]')"
  if [ "$state" != "active" ]; then
    fail "$UNIT is '${state:-unknown}', not active — every browser operation fails until the unit is up"
    printf '\n  skipping the MCP/CDP probes: an inactive unit explains them (infra/browseros.md §6).\n'
    printf '\n  failures: %d   warnings: %d\n' "$fails" "$warns"
    return 1
  fi
  ok "$UNIT is active"

  probe "$MCP_BASE/health"
  if [ "$PROBE_CODE" = "200" ]; then
    ok "MCP health answers 200 ($MCP_BASE/health)"
  else
    fail "MCP health did not answer 200 (got ${PROBE_CODE}) at $MCP_BASE/health — the MCP server is down"
  fi

  probe "$CDP_BASE/json/version"
  if [ "$PROBE_CODE" = "200" ]; then
    ok "CDP answers 200 ($CDP_BASE/json/version)"
  else
    fail "CDP did not answer 200 (got ${PROBE_CODE}) at $CDP_BASE/json/version — no browser process is listening"
  fi

  probe "$CDP_BASE/json/list"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "CDP /json/list did not answer 200 (got ${PROBE_CODE}) — cannot tell whether a drivable page exists"
  else
    list="$PROBE_BODY"
    urls="$(page_urls "$list")"
    if [ -n "$urls" ]; then
      n="$(printf '%s\n' "$urls" | wc -l | tr -d '[:space:]')"
      ok "browser window present: $n drivable page(s), e.g. $(printf '%s\n' "$urls" | head -n 1)"
      if has_onboarding "$list"; then
        warn "the BrowserOS onboarding page is still open alongside a real page — onboarding never finished, so a restart can lose the window again (infra/browseros.md §5)"
      fi
    elif has_onboarding "$list"; then
      fail "no drivable page: CDP only holds $ONBOARDING_URL — this is the board #8 defect ('tabs failed: CDP error: No browser window available'): the profile has never completed first-run onboarding (infra/browseros.md §4)"
    else
      fail "no drivable CDP page target — every tab/window operation fails with 'No browser window available' (infra/browseros.md §4)"
    fi
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

fixture() { # -> sets rc and out, leaving fails/warns set by the run
  fails=0
  warns=0
  run_live_check > "$ST/out" 2>&1
  rc=$?
  out="$(cat "$ST/out")"
}

self_test() {
  local st rc out
  st="$(mktemp -d "${TMPDIR:-/tmp}/browseros-health-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$st'" EXIT
  ST="$st"
  mkdir -p "$st/bin"

  # Stubbed curl: reproduces the "body\nHTTP-code" contract the real script
  # parses, driven by STUB_* env vars so each fixture is one assignment.
  cat > "$st/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${!#}"
emit() { printf '%s' "$1"; printf '\n%s\n' "$2"; }
case "$url" in
  *:9200/health)  emit "${STUB_MCP_BODY:-}" "${STUB_MCP_CODE:-200}" ;;
  */json/version) emit "${STUB_CDP_VERSION_BODY:-}" "${STUB_CDP_VER_CODE:-200}" ;;
  */json/list)    emit "${STUB_CDP_LIST_BODY:-[]}" "${STUB_CDP_LIST_CODE:-200}" ;;
  *)              emit "" "000" ;;
esac
STUB
  chmod 0755 "$st/bin/curl"

  cat > "$st/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "is-active" ]; then
  state="${STUB_UNIT_STATE:-active}"
  printf '%s\n' "$state"
  [ "$state" = "active" ]
  exit $?
fi
exit 0
STUB
  chmod 0755 "$st/bin/systemctl"

  PATH="$st/bin:$PATH"
  export PATH
  export STUB_UNIT_STATE STUB_MCP_CODE STUB_MCP_BODY STUB_CDP_VER_CODE STUB_CDP_LIST_CODE STUB_CDP_LIST_BODY

  local healthy_list onboarding_only
  healthy_list='[{"id":"a","type":"page","url":"https://example.com/","title":"Example"},{"id":"b","type":"service_worker","url":"chrome-extension://k/","title":""}]'
  onboarding_only='[{"id":"o","type":"page","url":"chrome://browseros-onboarding/","title":"BrowserOS Onboarding"}]'

  # 1. healthy: unit up, MCP 200, CDP up, one real page (+ a non-page target)
  STUB_UNIT_STATE=active
  STUB_MCP_CODE=200
  STUB_MCP_BODY='{"status":"ok"}'
  STUB_CDP_VER_CODE=200
  STUB_CDP_LIST_CODE=200
  STUB_CDP_LIST_BODY="$healthy_list"
  fixture
  expect "a healthy browser passes (rc)" 0 "$rc"
  expect "a healthy browser has no failures" 0 "$fails"
  expect "a healthy browser has no warnings" 0 "$warns"
  contains "the healthy run names the drivable page" "$out" "https://example.com/"

  # 2. the board #8 defect: the onboarding page is the only page target
  STUB_CDP_LIST_BODY="$onboarding_only"
  fixture
  expect "the onboarding-only state fails (rc)" 1 "$rc"
  expect "the onboarding-only state is one failure" 1 "$fails"
  contains "the failure quotes the MCP error" "$out" "No browser window available"
  contains "the failure names the onboarding page" "$out" "browseros-onboarding"

  # 3. no page targets at all
  STUB_CDP_LIST_BODY='[]'
  fixture
  expect "an empty CDP page list fails (rc)" 1 "$rc"
  expect "an empty CDP page list is one failure" 1 "$fails"
  contains "the empty-list failure says no drivable page" "$out" "no drivable CDP page target"

  # 4. onboarding page alongside a real page: usable, but warned
  STUB_CDP_LIST_BODY='[{"id":"a","type":"page","url":"about:blank","title":""},{"id":"o","type":"page","url":"chrome://browseros-onboarding/","title":"BrowserOS Onboarding"}]'
  fixture
  expect "a page plus onboarding passes (rc)" 0 "$rc"
  expect "a page plus onboarding has no failures" 0 "$fails"
  expect "a page plus onboarding warns once" 1 "$warns"
  contains "the onboarding warning names the page" "$out" "onboarding page is still open"

  # 5. MCP unhealthy while the browser is up
  STUB_CDP_LIST_BODY="$healthy_list"
  STUB_MCP_CODE=503
  fixture
  expect "an unhealthy MCP fails (rc)" 1 "$rc"
  expect "an unhealthy MCP is one failure" 1 "$fails"
  contains "the MCP failure names the endpoint" "$out" "9200/health"

  # 6. unit not active: fail fast, do not blame the network probes
  STUB_MCP_CODE=200
  STUB_UNIT_STATE=failed
  fixture
  expect "an inactive unit fails (rc)" 1 "$rc"
  expect "an inactive unit is one failure" 1 "$fails"
  contains "the inactive-unit run skips the network probes" "$out" "skipping the MCP/CDP probes"

  # 7. the browser process is gone (CDP unreachable on both endpoints)
  STUB_UNIT_STATE=active
  STUB_CDP_VER_CODE=000
  STUB_CDP_LIST_CODE=000
  fixture
  expect "an unreachable CDP fails (rc)" 1 "$rc"
  expect "an unreachable CDP is two failures (version + list)" 2 "$fails"
  contains "the CDP failure says nothing is listening" "$out" "no browser process is listening"

  # 8. only a devtools inspector page — still no drivable window
  STUB_CDP_VER_CODE=200
  STUB_CDP_LIST_CODE=200
  STUB_CDP_LIST_BODY='[{"id":"d","type":"page","url":"devtools://devtools/bundled/inspector.html","title":"DevTools"}]'
  fixture
  expect "a devtools-only page list fails (rc)" 1 "$rc"
  expect "a devtools-only page list is one failure" 1 "$fails"
  contains "the devtools-only failure says no drivable page" "$out" "no drivable CDP page target"

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
    --live|"")   run_live_check ;;
    --help|-h)   usage; return 0 ;;
    *)           printf 'unknown argument: %s\n' "$1" >&2; usage; return 2 ;;
  esac
}

main "$@"
exit $?
