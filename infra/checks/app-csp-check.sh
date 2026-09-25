#!/usr/bin/env bash
# RoadwiseFleet — Fleet Manager (/app/) CSP vs. app assets check (READ-ONLY).
#
# Board #69 / GitHub #48. The Fleet Manager is served by the API at /app/ and
# gets its own header snippet
# (infra/nginx/snippets/roadwisefleet-headers-app.conf). The app pages load
# same-origin scripts (`/pilot/lib/*.js`, `/app/lib/*.js`, `/app/app.js`) and a
# same-origin stylesheet, and declare no inline code — so the app policy must
# include `script-src 'self'` and must NOT be the pilot snippet's wider
# `'unsafe-inline'` policy. A policy that omits 'self' is the board #65/#39
# failure mode (the app shell never boots); 'unsafe-inline' here would silently
# give up the stricter policy the app's own markup allows.
#
# This check reads the policy from the snippet and every resource the app HTML/JS
# actually declares, applies CSP fallback semantics, and fails if any of them is
# not allowed OR if the policy is wider than the app needs (both directions of
# the inline decision). It also asserts the lockdown was NOT relaxed.
#
# Modes:
#   (default)    repo-only, no network — runs in CI (.github/workflows/ci.yml,
#                job `app-csp-check`) on every PR and push.
#   --live       additionally compares the LIVE /app/ headers with the repo
#                policy (HEAD requests only, no credentials). Owner change
#                window only; never part of CI.
#   --self-test  fixture assertions that prove this check FAILS on a reused
#                pilot policy, on a no-'self' policy and on a relaxed lockdown,
#                and that it detects a future inline <script>/<style> under a
#                strict policy.
#   --help
#
# Exit: 0 = the policy matches the app's real needs, 1 = it does not.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
SNIPPET="${SNIPPET:-$REPO_ROOT/infra/nginx/snippets/roadwisefleet-headers-app.conf}"
APP_DIR="${APP_DIR:-$REPO_ROOT/app}"
LIVE_URLS="${LIVE_URLS:-https://roadwisefleet.com/app/ https://roadwisefleet.com/app/app.js}"

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

policy() { # -> the CSP value on the last Content-Security-Policy add_header
  grep -E '^[[:space:]]*add_header[[:space:]]+Content-Security-Policy[[:space:]]+"' "$SNIPPET" \
    | tail -n1 | sed -E 's/^[^"]*"([^"]*)".*$/\1/'
}

csp_sources() { # csp_sources <policy> <directive> -> space-separated sources (last wins)
  printf '%s\n' "$1" | tr ';' '\n' | awk -v d="$2" '
    { gsub(/^[ \t]+|[ \t]+$/, ""); n = split($0, a, " ");
      if (n >= 1 && a[1] == d) {
        out = ""
        for (i = 2; i <= n; i++) { if (a[i] != "") out = out (out == "" ? "" : " ") a[i] }
        last = out
      } }
    END { print last }'
}

eff() { # eff <policy> <directive...> -> first directive in the chain that is present
  local p="$1" d s
  shift
  for d in "$@"; do
    s="$(csp_sources "$p" "$d")"
    if [ -n "$s" ]; then printf '%s' "$s"; return 0; fi
  done
  return 0
}

has() { # has <sources-string> <token>
  if [ -z "$1" ]; then return 1; fi
  printf '%s\n' "$1" | tr ' ' '\n' | grep -qx -- "$2"
}

check_surface() {
  local p e_script e_style e_connect
  local url inline_scripts inline_styles srcs

  if [ ! -f "$SNIPPET" ]; then
    fail "app snippet not found: $SNIPPET"
    return 0
  fi
  p="$(policy)"
  if [ -z "$p" ]; then
    fail "no Content-Security-Policy add_header found in $SNIPPET"
    return 0
  fi
  printf '\n=== policy under test ===\n  %s\n' "$p"
  printf '  snippet: %s\n' "${SNIPPET#"$REPO_ROOT"/}"

  # --- lockdown tokens must be intact ---------------------------------------
  printf '\n=== lockdown assertions ===\n'
  local ds bs fa2 fa
  ds="$(csp_sources "$p" default-src)"
  bs="$(csp_sources "$p" base-uri)"
  fa="$(csp_sources "$p" form-action)"
  fa2="$(csp_sources "$p" frame-ancestors)"
  if has "$ds" "'none'"; then
    ok "default-src 'none' retained"
  else
    fail "default-src is not 'none' (got: ${ds:-<absent>}) — the lockdown was relaxed"
  fi
  if has "$bs" "'none'"; then
    ok "base-uri 'none' retained"
  else
    fail "base-uri is not 'none' (got: ${bs:-<absent>})"
  fi
  if has "$fa" "'self'"; then
    ok "form-action 'self' retained"
  else
    fail "form-action does not allow 'self' (got: ${fa:-<absent>})"
  fi
  if has "$fa2" "'none'"; then
    ok "frame-ancestors 'none' retained"
  else
    fail "frame-ancestors is not 'none' (got: ${fa2:-<absent>})"
  fi
  if printf '%s\n' "$p" | tr ';' '\n' | grep -qE '(^|[[:space:]])\*([[:space:]]|$)'; then
    fail "the policy contains a wildcard source '*'"
  fi

  # --- effective sources (CSP fallback chains) ------------------------------
  e_script="$(eff "$p" script-src default-src)"
  e_style="$(eff "$p" style-src default-src)"
  e_connect="$(eff "$p" connect-src default-src)"
  printf '\n=== effective sources ===\n'
  printf '  script-src      -> %s\n' "${e_script:-<empty>}"
  printf '  style-src       -> %s\n' "${e_style:-<empty>}"
  printf '  connect-src     -> %s\n' "${e_connect:-<empty>}"

  # --- resources the app actually declares ----------------------------------
  local files=("$APP_DIR"/*.html)
  if [ ! -e "${files[0]}" ]; then
    fail "no app HTML found under $APP_DIR"
    return 0
  fi
  printf '\n=== declared resources (%d HTML files) ===\n' "${#files[@]}"

  # 1. external (same-origin) scripts: <script src="...">
  srcs="$(grep -ohE '<script[^>]+src="[^"]+"' "${files[@]}" | sed -E 's/.*src="([^"]*)".*/\1/' | sort -u)"
  if [ -z "$srcs" ]; then
    printf '  (no external <script src>)\n'
  else
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      case "$url" in
        http://*|https://*|//*)
          warn "absolute script URL $url — an external host would have to be allowed; the app is supposed to be same-origin" ;;
        *)
          if has "$e_script" "'self'"; then
            ok "script src $url allowed (script-src allows 'self')"
          else
            fail "script src $url is BLOCKED — script-src has no 'self' (effective: ${e_script:-<empty>})"
          fi ;;
      esac
    done <<EOF
$srcs
EOF
  fi

  # 2. inline <script> / <style> vs 'unsafe-inline' — checked in BOTH directions:
  #    inline present without 'unsafe-inline' is broken; 'unsafe-inline' present
  #    with no inline code is the board-#69 "reused pilot snippet" mistake.
  inline_scripts="$(grep -ohE '<script[^>]*>' "${files[@]}" | grep -vc 'src=' || true)"
  inline_styles="$(grep -ohE '<style[^>]*>' "${files[@]}" | wc -l | tr -d ' ')"
  if [ "${inline_scripts:-0}" -gt 0 ]; then
    if has "$e_script" "'unsafe-inline'"; then
      ok "$inline_scripts inline <script> tag(s) allowed (script-src 'unsafe-inline')"
    else
      fail "$inline_scripts inline <script> tag(s) present but script-src lacks 'unsafe-inline'"
    fi
  elif has "$e_script" "'unsafe-inline'"; then
    fail "script-src allows 'unsafe-inline' but the app declares no inline <script> — do not reuse the pilot snippet's wider policy (board #69)"
  else
    ok "no inline <script> and script-src is strict (no 'unsafe-inline')"
  fi
  if [ "${inline_styles:-0}" -gt 0 ]; then
    if has "$e_style" "'unsafe-inline'"; then
      ok "$inline_styles inline <style> tag(s) allowed (style-src 'unsafe-inline')"
    else
      fail "$inline_styles inline <style> tag(s) present but style-src lacks 'unsafe-inline'"
    fi
  elif has "$e_style" "'unsafe-inline'"; then
    fail "style-src allows 'unsafe-inline' but the app declares no inline <style> — do not reuse the pilot snippet's wider policy (board #69)"
  else
    ok "no inline <style> and style-src is strict (no 'unsafe-inline')"
  fi

  # 3. stylesheets: <link rel="stylesheet" href="...">
  srcs="$(grep -ohE '<link[^>]+rel="stylesheet"[^>]*>' "${files[@]}" | sed -E 's/.*href="([^"]*)".*/\1/' | sort -u || true)"
  if [ -z "$srcs" ]; then
    printf '  (no external stylesheet)\n'
  else
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      case "$url" in
        http://*|https://*|//*)
          warn "absolute stylesheet URL $url — an external host would have to be allowed" ;;
        *)
          if has "$e_style" "'self'"; then
            ok "stylesheet $url allowed (style-src allows 'self')"
          else
            fail "stylesheet $url is BLOCKED — style-src has no 'self' (effective: ${e_style:-<empty>})"
          fi ;;
      esac
    done <<EOF
$srcs
EOF
  fi

  # 4. same-origin fetch() needs connect-src 'self'
  if grep -rqE 'fetch\(' "$APP_DIR"; then
    if has "$e_connect" "'self'"; then
      ok "fetch() calls allowed (connect-src allows 'self')"
    else
      fail "app scripts call fetch() but connect-src has no 'self' (effective: ${e_connect:-<empty>})"
    fi
  fi

  return 0
}

live_check() {
  local url live want
  printf '\n=== live header comparison ===\n'
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available — skipping the live comparison"
    return 0
  fi
  want="$(policy | tr -s ' ')"
  for url in $LIVE_URLS; do
    live="$(curl -sI "$url" 2>/dev/null | grep -i '^content-security-policy:' | sed -E 's/^[^:]*:[[:space:]]*//' | tr -d '\r' | tr -s ' ' | tail -n1 || true)"
    if [ -z "$live" ]; then
      warn "$url: no Content-Security-Policy header (unreachable, or nginx not reloaded with the snippet)"
    elif [ "$live" = "$want" ]; then
      ok "$url: live CSP matches the repo snippet"
    else
      fail "$url: live CSP differs from the repo snippet"
      printf '        live: %s\n' "$live"
      printf '        repo: %s\n' "$want"
    fi
  done
  return 0
}

self_test() {
  local tmp out rc passed=0 failed=0
  local policy_app policy_pilot policy_noself policy_relaxed
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/app-csp-selftest.XXXXXX")" || return 2
  mkdir -p "$tmp/html_clean" "$tmp/html_inline"

  cat > "$tmp/html_clean/index.html" <<'HTML'
<!doctype html><html><head><link rel="stylesheet" href="/app/app.css"></head>
<body><script src="/app/app.js"></script></body></html>
HTML
  cat > "$tmp/html_inline/index.html" <<'HTML'
<!doctype html><html><head><style>body{margin:0}</style></head>
<body><script>boot();</script></body></html>
HTML
  for d in html_clean html_inline; do
    cat > "$tmp/$d/app.js" <<'JS'
async function api(path) { return fetch(path, { credentials: 'same-origin' }); }
JS
  done

  policy_app="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"
  policy_pilot="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'"
  policy_noself="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'unsafe-inline'; connect-src 'self'"
  policy_relaxed="default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"

  mk_snippet() { # mk_snippet <file> <policy>
    printf '# fixture\nadd_header Content-Security-Policy "%s" always;\n' "$2" > "$1"
  }
  mk_snippet "$tmp/app.conf" "$policy_app"
  mk_snippet "$tmp/pilot.conf" "$policy_pilot"
  mk_snippet "$tmp/noself.conf" "$policy_noself"
  mk_snippet "$tmp/relaxed.conf" "$policy_relaxed"

  run_case() { # run_case <label> <snippet> <appdir> <expected-exit> <needle>
    out="$(SNIPPET="$2" APP_DIR="$3" bash "$SELF" 2>&1)"
    rc=$?
    if [ "$rc" != "$4" ]; then
      printf 'FAIL %s: got exit %s, want %s\n' "$1" "$rc" "$4"
      printf '%s\n' "$out" | sed 's/^/        /'
      failed=$((failed + 1))
      return 0
    fi
    if [ -n "$5" ]; then
      if printf '%s\n' "$out" | grep -qF -- "$5"; then
        printf 'PASS %s (exit %s, reported "%s")\n' "$1" "$rc" "$5"
        passed=$((passed + 1))
      else
        printf 'FAIL %s: exit %s but the output never says "%s"\n' "$1" "$rc" "$5"
        printf '%s\n' "$out" | sed 's/^/        /'
        failed=$((failed + 1))
      fi
      return 0
    fi
    printf 'PASS %s (exit %s)\n' "$1" "$rc"
    passed=$((passed + 1))
    return 0
  }

  # 1. the strict app policy must be ACCEPTED on the clean app surface
  run_case "app policy accepts the clean app surface" "$tmp/app.conf" "$tmp/html_clean" 0 "allowed (script-src allows 'self')"
  # 2. the reused pilot policy must be REJECTED (unsafe-inline with no inline code)
  run_case "reused pilot policy (unsafe-inline) is rejected" "$tmp/pilot.conf" "$tmp/html_clean" 1 "do not reuse the pilot snippet"
  # 3. a policy that keeps 'self' off scripts must be REJECTED
  run_case "policy without script-src 'self' is rejected" "$tmp/noself.conf" "$tmp/html_clean" 1 "is BLOCKED"
  # 4. a policy that "boots" by relaxing the lockdown must be REJECTED
  run_case "relaxed default-src is rejected" "$tmp/relaxed.conf" "$tmp/html_clean" 1 "lockdown was relaxed"
  # 5. a future inline <script> under the strict policy must be REJECTED
  run_case "inline <script> under a strict policy is rejected" "$tmp/app.conf" "$tmp/html_inline" 1 "inline <script> tag(s) present but script-src lacks 'unsafe-inline'"
  # 6. inline code with an unsafe-inline policy is legitimately accepted
  run_case "inline code with an unsafe-inline policy is accepted" "$tmp/pilot.conf" "$tmp/html_inline" 0 "inline <script> tag(s) allowed"

  rm -rf "$tmp"
  printf '\nself-test: %d passed, %d failed\n' "$passed" "$failed"
  if [ "$failed" != 0 ]; then return 1; fi
  return 0
}

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

printf 'RoadwiseFleet Fleet Manager (/app/) CSP check — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
check_surface
if [ "$MODE" = "live" ]; then
  live_check
fi

printf '\n=== Result ===\n'
printf '  failures: %d   warnings: %d\n' "$fails" "$warns"
if [ "$fails" -gt 0 ]; then
  printf '  the app CSP does not match the app surface — do NOT install/reload; fix the snippet first\n'
  exit 1
fi
printf '  policy covers every declared app resource and is not wider than the app needs — safe to install in the change window\n'
exit 0
