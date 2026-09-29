#!/usr/bin/env bash
# RoadwiseFleet — pilot CSP vs. pilot assets check (READ-ONLY).
#
# Board #65. The /pilot/ surface is served with a near-lockdown CSP
# (infra/nginx/snippets/roadwisefleet-headers-pilot.conf). Board #7 / PR #13
# shipped a template policy that omitted 'self', so every <script src="lib/...">
# the pages load was blocked and the pilot never booted in a browser. This check
# makes that class of failure machine-detectable: it reads the policy from the
# snippet and every resource the pilot HTML/JS actually declares, applies CSP
# fallback semantics, and fails if any of them is not allowed.
#
# It also asserts the lockdown was NOT relaxed (default-src, base-uri,
# form-action, frame-ancestors) — a policy that boots by allowing everything is
# not a fix.
#
# Modes:
#   (default)    repo-only, no network — runs in CI (.github/workflows/ci.yml,
#                job `pilot-csp-check`) on every PR and push.
#   --live       additionally compares the LIVE pilot headers with the repo
#                policy. Run it in the owner change window (HEAD requests only,
#                no credentials). The live probe is never part of CI.
#   --self-test  fixture assertions that prove this check FAILS on the broken
#                policy (the board-#65 regression) and PASSES on the fixed one.
#   --help
#
# Exit: 0 = the policy covers every declared resource, 1 = it does not.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
SNIPPET="${SNIPPET:-$REPO_ROOT/infra/nginx/snippets/roadwisefleet-headers-pilot.conf}"
PILOT_DIR="${PILOT_DIR:-$REPO_ROOT/pilot}"
LIVE_URLS="${LIVE_URLS:-https://roadwisefleet.com/pilot/ https://roadwisefleet.com/pilot/dashboard.html https://roadwisefleet.com/pilot/driver.html}"

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

policy() { # policy -> the CSP value on the last Content-Security-Policy add_header
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
  local p e_script e_style e_img e_img_data e_manifest e_worker e_connect
  local url inline_scripts inline_styles srcs

  if [ ! -f "$SNIPPET" ]; then
    fail "pilot snippet not found: $SNIPPET"
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
  # script/style/img/manifest fall back to default-src; worker-src falls back
  # to child-src, then script-src, then default-src; connect falls back to
  # default-src.
  e_script="$(eff "$p" script-src default-src)"
  e_style="$(eff "$p" style-src default-src)"
  e_img="$(eff "$p" img-src default-src)"
  e_manifest="$(eff "$p" manifest-src default-src)"
  e_worker="$(eff "$p" worker-src child-src script-src default-src)"
  e_connect="$(eff "$p" connect-src default-src)"
  printf '\n=== effective sources ===\n'
  printf '  script-src      -> %s\n' "${e_script:-<empty>}"
  printf '  style-src       -> %s\n' "${e_style:-<empty>}"
  printf '  img-src         -> %s\n' "${e_img:-<empty>}"
  printf '  connect-src     -> %s\n' "${e_connect:-<empty>}"
  printf '  worker-src      -> %s\n' "${e_worker:-<empty>}"
  printf '  manifest-src    -> %s\n' "${e_manifest:-<empty>}"

  # --- resources the pilot actually declares --------------------------------
  local files=("$PILOT_DIR"/*.html)
  if [ ! -e "${files[0]}" ]; then
    fail "no pilot HTML found under $PILOT_DIR"
    return 0
  fi
  printf '\n=== declared resources (%d HTML files) ===\n' "${#files[@]}"

  # 1. external (same-origin) classic scripts: <script src="...">
  srcs="$(grep -ohE '<script[^>]+src="[^"]+"' "${files[@]}" | sed -E 's/.*src="([^"]*)".*/\1/' | sort -u)"
  if [ -z "$srcs" ]; then
    printf '  (no external <script src>)\n'
  else
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      case "$url" in
        http://*|https://*|//*)
          warn "absolute script URL $url — an external host would have to be allowed; the pilot is supposed to be self-contained" ;;
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

  # 2. inline <script> / <style>
  inline_scripts="$(grep -ohE '<script[^>]*>' "${files[@]}" | grep -vc 'src=' || true)"
  inline_styles="$(grep -ohE '<style[^>]*>' "${files[@]}" | wc -l | tr -d ' ')"
  if [ "${inline_scripts:-0}" -gt 0 ]; then
    if has "$e_script" "'unsafe-inline'"; then
      ok "$inline_scripts inline <script> tag(s) allowed (script-src 'unsafe-inline')"
    else
      fail "$inline_scripts inline <script> tag(s) present but script-src lacks 'unsafe-inline'"
    fi
  fi
  if [ "${inline_styles:-0}" -gt 0 ]; then
    if has "$e_style" "'unsafe-inline'"; then
      ok "$inline_styles inline <style> tag(s) allowed (style-src 'unsafe-inline')"
    else
      fail "$inline_styles inline <style> tag(s) present but style-src lacks 'unsafe-inline'"
    fi
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

  # 4. PWA manifest: <link rel="manifest" href="...">
  srcs="$(grep -ohE '<link[^>]+rel="manifest"[^>]*>' "${files[@]}" | sed -E 's/.*href="([^"]*)".*/\1/' | sort -u || true)"
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    if has "$e_manifest" "'self'"; then
      ok "manifest $url allowed (manifest-src allows 'self')"
    else
      fail "manifest $url is BLOCKED — manifest-src has no 'self' (effective: ${e_manifest:-<empty>})"
    fi
  done <<EOF
$srcs
EOF

  # 5. service worker registration (worker-src -> child-src -> script-src -> default-src)
  if grep -rqE 'serviceWorker\.register\(' "$PILOT_DIR"; then
    if has "$e_worker" "'self'"; then
      ok "service worker registered and allowed (worker-src chain allows 'self')"
    else
      fail "a service worker is registered but worker-src/script-src/default-src chain has no 'self' (effective: ${e_worker:-<empty>})"
    fi
  fi

  # 6. icons / images (link rel=icon and <img> are governed by img-src)
  if grep -ohqE '(<img|rel="(icon|apple-touch-icon)")' "${files[@]}"; then
    if has "$e_img" "'self'"; then
      ok "icons/images allowed (img-src allows 'self')"
    else
      fail "icons/images are referenced but img-src has no 'self' (effective: ${e_img:-<empty>})"
    fi
    e_img_data="$e_img"
    if grep -ohqE 'data:image/' "${files[@]}"; then
      if has "$e_img_data" "data:"; then
        ok "data: images allowed by img-src"
      else
        fail "a data: image is referenced but img-src has no data:"
      fi
    fi
  fi

  # 7. same-origin fetch() needs connect-src 'self'
  if grep -rqE '(^|[^A-Za-z])fetch\(' "$PILOT_DIR"; then
    if has "$e_connect" "'self'"; then
      ok "fetch() calls allowed (connect-src allows 'self')"
    else
      fail "pilot scripts call fetch() but connect-src has no 'self' (effective: ${e_connect:-<empty>})"
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
  local tmp out rc passed=0 failed=0 policy_broken policy_fixed policy_noself policy_relaxed
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pilot-csp-selftest.XXXXXX")" || return 2
  mkdir -p "$tmp/html"

  cat > "$tmp/html/index.html" <<'HTML'
<!doctype html><html><head><style>body{font-family:sans-serif}</style></head>
<body><script src="lib/i18n.js"></script>
<script>RoadwiseI18n.init();</script></body></html>
HTML
  cat > "$tmp/html/driver.html" <<'HTML'
<!doctype html><html><head>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
</head><body><script src="lib/driver-core.js"></script>
<script>navigator.serviceWorker.register('sw.js', { scope: './' });</script></body></html>
HTML

  policy_broken="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
  policy_fixed="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'"
  policy_noself="default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'"
  policy_relaxed="default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'"

  mk_snippet() { # mk_snippet <name> <policy>
    printf '# fixture\nadd_header Content-Security-Policy "%s" always;\n' "$2" > "$tmp/$1.conf"
  }
  mk_snippet broken "$policy_broken"
  mk_snippet fixed "$policy_fixed"
  mk_snippet noself "$policy_noself"
  mk_snippet relaxed "$policy_relaxed"

  run_case() { # run_case <label> <snippet-name> <expected-exit> <needle>
    out="$(SNIPPET="$tmp/$2.conf" PILOT_DIR="$tmp/html" bash "$SELF" 2>&1)"
    rc=$?
    if [ "$rc" != "$3" ]; then
      printf 'FAIL %s: got exit %s, want %s\n' "$1" "$rc" "$3"
      printf '%s\n' "$out" | sed 's/^/        /'
      failed=$((failed + 1))
      return 0
    fi
    if [ -n "$4" ]; then
      if printf '%s\n' "$out" | grep -qF -- "$4"; then
        printf 'PASS %s (exit %s, reported "%s")\n' "$1" "$rc" "$4"
        passed=$((passed + 1))
      else
        printf 'FAIL %s: exit %s but the output never says "%s"\n' "$1" "$rc" "$4"
        printf '%s\n' "$out" | sed 's/^/        /'
        failed=$((failed + 1))
      fi
      return 0
    fi
    printf 'PASS %s (exit %s)\n' "$1" "$rc"
    passed=$((passed + 1))
    return 0
  }

  # 1. the live-regression policy must be REJECTED, naming the blocked script
  run_case "broken policy (board #65 live state) is rejected" broken 1 "is BLOCKED"
  # 2. the fixed policy must be ACCEPTED
  run_case "fixed policy passes" fixed 0 "script src lib/driver-core.js allowed"
  # 3. a policy that keeps 'self' off scripts must be REJECTED
  run_case "policy without script-src 'self' is rejected" noself 1 "script-src has no 'self'"
  # 4. a policy that "boots" by relaxing the lockdown must be REJECTED
  run_case "relaxed default-src is rejected" relaxed 1 "lockdown was relaxed"

  rm -rf "$tmp"
  printf '\nself-test: %d passed, %d failed\n' "$passed" "$failed"
  if [ "$failed" != 0 ]; then return 1; fi
  return 0
}

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

printf 'RoadwiseFleet pilot CSP check — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')"
check_surface
if [ "$MODE" = "live" ]; then
  live_check
fi

printf '\n=== Result ===\n'
printf '  failures: %d   warnings: %d\n' "$fails" "$warns"
if [ "$fails" -gt 0 ]; then
  printf '  the pilot CSP does not cover the pilot surface — do NOT install/reload; fix the snippet first\n'
  exit 1
fi
printf '  policy covers every declared pilot resource — safe to install in the change window\n'
exit 0
