#!/usr/bin/env bash
# RoadwiseFleet — Play Data Safety declaration vs. the Android manifest (READ-ONLY).
#
# Board #109 (AND1-OPS1). The Data Safety form is a legal statement made by the
# Play developer account holder; the one part CI can keep honest is the
# permission set:
#
#   1. a permission the app declares but the declaration does not mention means
#      the submitted form is incomplete — Play rejects it, or accepts it wrong;
#   2. a permission the declaration names but the app no longer declares is stale
#      text that misleads the reviewer;
#   3. a permission line with no written justification is a placeholder, not a
#      decision.
#
# The known future trigger is the POD camera (A4 follow-up): it adds CAMERA, and
# this job then fails until infra/play-data-safety.md is updated in the same PR.
#
# Modes:
#   (default)    compare the repo declaration against the repo manifest (CI,
#                .github/workflows/ci.yml job `play-data-safety`)
#   --self-test  fixture assertions proving each of the three failures fires
#   --help
#
# Env overrides (used by --self-test, and to point at another build):
#   DOC=...       default infra/play-data-safety.md
#   MANIFEST=...  default apps/android/app/src/main/AndroidManifest.xml
#
# Exit: 0 = the declaration matches the manifest and every line is justified,
#       1 = it does not.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
DOC="${DOC:-$REPO_ROOT/infra/play-data-safety.md}"
MANIFEST="${MANIFEST:-$REPO_ROOT/apps/android/app/src/main/AndroidManifest.xml}"

START_MARKER='<!-- play-data-safety:permissions:start -->'
END_MARKER='<!-- play-data-safety:permissions:end -->'

MODE="check"
for arg in "$@"; do
  case "$arg" in
    --self-test) MODE="self-test" ;;
    --help|-h)   MODE="help" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "help" ]; then
  awk 'NR > 1 && /^set -uo pipefail/ { exit } NR > 1 { print }' "$SELF"
  exit 0
fi

fails=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# permissions_block <doc> -> the permission lines between the markers
permissions_block() {
  awk -v s="$START_MARKER" -v e="$END_MARKER" '
    index($0, s) == 1 { inblock = 1; next }
    index($0, e) == 1 { inblock = 0; next }
    inblock && /^- / { print }
  ' "$1"
}

# check_pair <doc> <manifest>
check_pair() {
  local doc="$1" manifest="$2"
  local manifest_perms doc_perms block missing extra unjustified

  if [ ! -f "$manifest" ]; then
    fail "manifest not found: $manifest"
    return 1
  fi
  if [ ! -f "$doc" ]; then
    fail "declaration not found: $doc"
    return 1
  fi
  if ! grep -qxF "$START_MARKER" "$doc" || ! grep -qxF "$END_MARKER" "$doc"; then
    fail "the machine-checked permission block markers are missing in $doc"
    return 1
  fi

  manifest_perms="$(grep -oE 'android\.permission\.[A-Z0-9_]+' "$manifest" | sort -u)"
  block="$(permissions_block "$doc")"
  doc_perms="$(printf '%s\n' "$block" | grep -oE '^- android\.permission\.[A-Z0-9_]+' \
    | sed 's/^- //' | sort -u)"

  missing="$(comm -23 <(printf '%s\n' "$manifest_perms" | grep -E '.') \
    <(printf '%s\n' "$doc_perms" | grep -E '.'))"
  extra="$(comm -13 <(printf '%s\n' "$manifest_perms" | grep -E '.') \
    <(printf '%s\n' "$doc_perms" | grep -E '.'))"
  unjustified="$(printf '%s\n' "$block" | grep -E '^- android\.permission\.' \
    | grep -vE '^- android\.permission\.[A-Z0-9_]+ :: .+' || true)"

  if [ -n "$missing" ]; then
    fail "declared in the app but missing from the Data Safety block: $(printf '%s' "$missing" | tr '\n' ' ')"
  else
    ok "every permission the app declares is in the Data Safety block"
  fi

  if [ -n "$extra" ]; then
    fail "listed in the Data Safety block but not declared by the app: $(printf '%s' "$extra" | tr '\n' ' ')"
  else
    ok "the Data Safety block declares no permission the app does not use"
  fi

  if [ -n "$unjustified" ]; then
    fail "a permission line carries no ' :: <justification>': $(printf '%s' "$unjustified" | tr '\n' ' ')"
  else
    ok "every permission line carries a justification"
  fi

  [ "$fails" -eq 0 ]
}

if [ "$MODE" = "self-test" ]; then
  # Each fixture runs in a subshell so its failures do not leak into the count.
  run_pair() { ( fails=0; check_pair "$1" "$2" ); }

  expect_pass() {
    local label="$1" doc="$2" manifest="$3" out rc
    out="$(run_pair "$doc" "$manifest")"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      ok "self-test: $label"
    else
      fail "self-test: $label (rc=$rc, want 0)"
      printf '%s\n' "$out"
    fi
  }

  expect_fail() {
    local label="$1" doc="$2" manifest="$3" needle="$4" out rc
    out="$(run_pair "$doc" "$manifest")"
    rc=$?
    if [ "$rc" -ne 1 ]; then
      fail "self-test: $label (rc=$rc, want 1)"
      return
    fi
    if printf '%s' "$out" | grep -qF "$needle"; then
      ok "self-test: $label"
    else
      fail "self-test: $label (failure text does not mention: $needle)"
      printf '%s\n' "$out"
    fi
  }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  cat >"$tmp/good-manifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
</manifest>
XML

  cat >"$tmp/good-doc.md" <<DOCFILE
# fixture
<!-- play-data-safety:permissions:start -->
- android.permission.INTERNET :: transport only; no data type
- android.permission.ACCESS_FINE_LOCATION :: precise location while a trip is active
<!-- play-data-safety:permissions:end -->
DOCFILE

  expect_pass "the declared set matches and every line is justified" "$tmp/good-doc.md" "$tmp/good-manifest.xml"

  # A permission the app ships but the declaration never mentions (the POD camera case).
  cat >"$tmp/camera-manifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.CAMERA" />
</manifest>
XML
  expect_fail "a new app permission missing from the declaration fails" \
    "$tmp/good-doc.md" "$tmp/camera-manifest.xml" "android.permission.CAMERA"

  # A declaration that still names a permission the app no longer requests.
  cat >"$tmp/extra-doc.md" <<DOCFILE
# fixture
<!-- play-data-safety:permissions:start -->
- android.permission.INTERNET :: transport only; no data type
- android.permission.ACCESS_FINE_LOCATION :: precise location while a trip is active
- android.permission.SYSTEM_ALERT_WINDOW :: never requested by this app
<!-- play-data-safety:permissions:end -->
DOCFILE
  expect_fail "a stale permission in the declaration fails" \
    "$tmp/extra-doc.md" "$tmp/good-manifest.xml" "SYSTEM_ALERT_WINDOW"

  # A line with no reason at all is a placeholder, not a decision.
  cat >"$tmp/unjustified-doc.md" <<DOCFILE
# fixture
<!-- play-data-safety:permissions:start -->
- android.permission.INTERNET :: transport only; no data type
- android.permission.ACCESS_FINE_LOCATION
<!-- play-data-safety:permissions:end -->
DOCFILE
  expect_fail "a permission line without a justification fails" \
    "$tmp/unjustified-doc.md" "$tmp/good-manifest.xml" "justification"

  # Markers gone: the block can no longer be found, so nothing is checked.
  cat >"$tmp/no-markers-doc.md" <<DOCFILE
# fixture
- android.permission.INTERNET :: transport only; no data type
- android.permission.ACCESS_FINE_LOCATION :: precise location while a trip is active
DOCFILE
  expect_fail "a declaration without the block markers fails" \
    "$tmp/no-markers-doc.md" "$tmp/good-manifest.xml" "markers"

  # The repo itself must pass.
  expect_pass "the repo declaration matches the repo manifest" "$DOC" "$MANIFEST"

  if [ "$fails" -eq 0 ]; then
    echo "self-test: all assertions passed"
  else
    echo "self-test: $fails failed"
  fi
else
  echo "Play Data Safety declaration:"
  check_pair "$DOC" "$MANIFEST"
  echo "failures: $fails"
fi

[ "$fails" -eq 0 ]
