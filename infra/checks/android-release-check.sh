#!/usr/bin/env bash
# RoadwiseFleet — Android release/signing guard (board eila/tasks#109, AND1-OPS1).
#
# AND1-OPS1 introduces three credentials — the release keystore, the Google Play
# service-account key, and the FCM server credential. This repository is public
# (github.com/ugry/roadwisefleet), so none of them may ever be committed, and
# the CI that consumes them must take them only from the GitHub secrets context.
# Both properties are easy to lose in a later edit and neither is visible in a
# review of the Gradle build, so they are checked here.
#
# What the repo check (default; the CI gate) proves:
#   1. no keystore / signing-properties / service-account file is in the tree;
#   2. no file anywhere contains a PEM private key or a service-account
#      "private-key" JSON field (filename-independent — a key renamed to
#      creds.json is still caught);
#   3. .gitignore keeps those classes of file out;
#   4. the Android release workflow exists, is GATED (it must not run before the
#      A1 scaffold, board #103, exists), declares least-privilege permissions,
#      takes every secret-like value from the `secrets.` context, carries no
#      inline key material, and is not unconditionally triggered;
#   5. the workflow and infra/android-release.md agree on the secret-name
#      contract, so a rename in one without the other cannot ship silently.
#
# Usage:
#   bash infra/checks/android-release-check.sh             # repo (CI)
#   bash infra/checks/android-release-check.sh --self-test # fixture proof
#   bash infra/checks/android-release-check.sh --help
# Exit: 0 ok, 1 a real failure, 2 usage error.
#
# The content scan (2) excludes this file by name: it deliberately contains the
# patterns it searches for, and a guard that matches itself proves nothing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RUNBOOK_REL='infra/android-release.md'
WORKFLOW_GLOB='android*.yml'

# The single source of truth for the secret-name contract (mirrored in the
# runbook and used by the release workflow).
SECRET_NAMES=(
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
  PLAY_SERVICE_ACCOUNT_JSON
)
GITIGNORE_TOKENS=(
  '*.jks'
  '*.keystore'
  'service-account*.json'
  'keystore.properties'
)
# PEM blocks and the JSON field every Google service-account key carries.
KEY_MATERIAL_RE='BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|"private_key"'

fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }

usage() {
  printf 'Usage: %s [--self-test|--help]\n' "$(basename "$0")"
  printf '  (no flag)   repo check: no key material in the tree, and a gated/safe release workflow\n'
  printf '  --self-test fixture proof of every rejection (no host, no network)\n'
}

# Every file in the tree, relative to $root, minus VCS/tooling noise.
list_files() {
  find "$1" \
    \( -name .git -o -name node_modules \) -prune -o \
    -type f -printf '%P\n' 2>/dev/null
}

# --- repo checks ------------------------------------------------------------

check_repo() {
  local root="${1:-$REPO_ROOT}"
  local wf wfrel rel hits expr s bad drift found miss

  printf 'RoadwiseFleet Android release guard — repo consistency\n'
  printf 'root: %s\n\n' "$root"

  # 1. no signing material by name.
  found=0
  while IFS= read -r rel; do
    case "$rel" in
      *.jks|*.keystore|*.p12)
        fail "signing material in the tree: $rel"; found=1 ;;
      keystore.properties|key.properties|*/keystore.properties|*/key.properties)
        fail "signing properties in the tree: $rel"; found=1 ;;
      service-account*.json|*/service-account*.json)
        fail "service-account key in the tree: $rel"; found=1 ;;
    esac
  done < <(list_files "$root")
  if [ "$found" -eq 0 ]; then
    ok "no keystore / signing-properties / service-account file in the tree"
  fi

  # 2. no key material by content, whatever the file is called.
  hits="$(grep -rlI -E "$KEY_MATERIAL_RE" \
            --exclude-dir=.git --exclude-dir=node_modules \
            --exclude='android-release-check.sh' "$root" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    while IFS= read -r rel; do
      fail "private key material in the tree: ${rel#"$root"/}"
    done <<< "$hits"
  else
    ok "no PEM private key or service-account private-key field anywhere in the tree"
  fi

  # 3. .gitignore keeps the classes out.
  if [ ! -f "$root/.gitignore" ]; then
    fail ".gitignore is missing at the root"
  else
    miss=0
    for s in "${GITIGNORE_TOKENS[@]}"; do
      if ! grep -qF -- "$s" "$root/.gitignore"; then
        fail ".gitignore does not ignore $s"; miss=1
      fi
    done
    if [ "$miss" -eq 0 ]; then
      ok ".gitignore covers the signing / service-account material"
    fi
  fi

  # 4. the release workflow: gated, least-privilege, secrets-only, no literals.
  wf="$(find "$root/.github/workflows" -maxdepth 1 -type f -name "$WORKFLOW_GLOB" -print -quit 2>/dev/null)"
  if [ -z "$wf" ]; then
    fail "no Android release workflow ($WORKFLOW_GLOB) under .github/workflows/"
  else
    wfrel="${wf#"$root"/}"
    ok "android release workflow present: $wfrel"

    if grep -qE '^permissions:' "$wf"; then
      ok "$wfrel declares top-level permissions (least privilege)"
    else
      fail "$wfrel has no top-level 'permissions:' block"
    fi

    if grep -q 'hashFiles(' "$wf" || grep -qE '^[[:space:]]+paths:' "$wf"; then
      ok "$wfrel is gated (hashFiles or a paths filter)"
    else
      fail "$wfrel is not gated — it would run (and fail) before the A1 scaffold exists"
    fi

    bad=0
    while IFS= read -r expr; do
      if printf '%s' "$expr" | grep -qiE 'password|keystore|_alias|service[_-]account'; then
        if ! printf '%s' "$expr" | grep -q 'secrets\.'; then
          fail "$wfrel: '$expr' is not taken from the secrets context"
          bad=1
        fi
      fi
    done < <(grep -oE '\$\{\{[^}]*\}\}' "$wf" || true)
    if [ "$bad" -eq 0 ]; then
      ok "$wfrel takes every secret-like value from the secrets context"
    fi

    if grep -qE '[A-Za-z0-9+/]{120,}={0,2}' "$wf"; then
      fail "$wfrel contains a base64/secret-looking literal"
    else
      ok "$wfrel contains no inline base64 blob"
    fi

    # 5. the workflow and the runbook must agree on the secret names.
    drift=0
    for s in "${SECRET_NAMES[@]}"; do
      if ! grep -q "$s" "$wf"; then
        fail "$wfrel does not reference the documented secret $s"; drift=1
      fi
      if [ -f "$root/$RUNBOOK_REL" ] && ! grep -q "$s" "$root/$RUNBOOK_REL"; then
        fail "$RUNBOOK_REL does not document the secret $s"; drift=1
      fi
    done
    if [ "$drift" -eq 0 ]; then
      ok "$wfrel and $RUNBOOK_REL agree on the secret-name contract"
    fi
  fi

  # A tracked client config is allowed (Google ships it with the app); the
  # server-side Play/FCM credentials are what the checks above refuse.
  if [ -n "$(find "$root" -name google-services.json -print -quit 2>/dev/null)" ]; then
    warn "google-services.json is present (client config is allowed; never the server key)"
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

mk_good_repo() {
  local d="$1"
  mkdir -p "$d/.github/workflows" "$d/infra"
  cat > "$d/.github/workflows/android-release.yml" <<'YAML'
name: android-release
on:
  pull_request:
    paths:
      - 'apps/android/**'
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    if: ${{ hashFiles('apps/android/gradlew') != '' }}
    steps:
      - name: decode
        env:
          KEYSTORE_B64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: printf '%s' "$KEYSTORE_B64" | base64 -d > "$RUNNER_TEMP/release.keystore"
      - name: release
        env:
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: ./gradlew assembleRelease bundleRelease
      - name: publish
        env:
          PLAY: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
        run: echo "${PLAY:+configured}"
YAML
  cat > "$d/.gitignore" <<'GI'
*.jks
*.keystore
service-account*.json
keystore.properties
GI
  cat > "$d/infra/android-release.md" <<'MD'
Android release secret contract:
ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD PLAY_SERVICE_ACCOUNT_JSON
MD
}

self_test() {
  local st out rc
  st="$(mktemp -d "${TMPDIR:-/tmp}/android-release-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$st'" EXIT

  mk_good_repo "$st/good"

  # 1. a healthy repo passes.
  fails=0
  warns=0
  check_repo "$st/good" > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a healthy repo passes (rc)" 0 "$rc"
  expect "a healthy repo has no failures" 0 "$fails"
  contains "the workflow is named" "$out" "android release workflow present"
  contains "the secret-name contract is reported" "$out" "agree on the secret-name contract"

  # 2. a tracked keystore FAILS and is named.
  mk_good_repo "$st/keystore"
  : > "$st/keystore/release.jks"
  fails=0
  warns=0
  check_repo "$st/keystore" > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a tracked keystore fails (rc)" 1 "$rc"
  contains "the keystore is named" "$out" "signing material in the tree: release.jks"

  # 3. a private key under an innocent filename FAILS (content, not name).
  mk_good_repo "$st/keymat"
  printf '%s\n' '-----BEGIN PRIVATE KEY-----' > "$st/keymat/creds.json"
  fails=0
  warns=0
  check_repo "$st/keymat" > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "private-key content fails (rc)" 1 "$rc"
  contains "the key file is named" "$out" "private key material in the tree: creds.json"

  # 4. a .gitignore gap FAILS.
  mk_good_repo "$st/noignore"
  : > "$st/noignore/.gitignore"
  fails=0
  warns=0
  check_repo "$st/noignore" > "$st/out" 2>&1
  out="$(cat "$st/out")"
  contains "the gitignore gap is named" "$out" ".gitignore does not ignore"

  # 5. an inline base64 blob in the workflow FAILS.
  mk_good_repo "$st/inline"
  printf '    blob: %s\n' "$(printf 'A%.0s' {1..140})" >> "$st/inline/.github/workflows/android-release.yml"
  fails=0
  warns=0
  check_repo "$st/inline" > "$st/out" 2>&1
  out="$(cat "$st/out")"
  contains "the inline blob is rejected" "$out" "contains a base64/secret-looking literal"

  # 6. a signing value taken from `vars` instead of `secrets` FAILS.
  mk_good_repo "$st/badexpr"
  sed -i 's/secrets\.ANDROID_KEYSTORE_PASSWORD/vars.ANDROID_KEYSTORE_PASSWORD/' \
    "$st/badexpr/.github/workflows/android-release.yml"
  fails=0
  warns=0
  check_repo "$st/badexpr" > "$st/out" 2>&1
  out="$(cat "$st/out")"
  contains "a non-secrets expression is rejected" "$out" "is not taken from the secrets context"

  # 7. an ungated workflow FAILS.
  mk_good_repo "$st/ungated"
  sed -i '/hashFiles/d' "$st/ungated/.github/workflows/android-release.yml"
  sed -i '/paths:/d' "$st/ungated/.github/workflows/android-release.yml"
  fails=0
  warns=0
  check_repo "$st/ungated" > "$st/out" 2>&1
  out="$(cat "$st/out")"
  contains "an ungated workflow is rejected" "$out" "is not gated"

  # 8. no release workflow at all FAILS.
  mkdir -p "$st/nowf/.github/workflows" "$st/nowf/infra"
  cp "$st/good/.gitignore" "$st/nowf/.gitignore"
  cp "$st/good/infra/android-release.md" "$st/nowf/infra/android-release.md"
  fails=0
  warns=0
  check_repo "$st/nowf" > "$st/out" 2>&1
  out="$(cat "$st/out")"
  contains "a missing workflow is rejected" "$out" "no Android release workflow"

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
    --help|-h)   usage; return 0 ;;
    "")          check_repo ;;
    *)           printf 'unknown argument: %s\n' "$1" >&2; usage; return 2 ;;
  esac
}

main "$@"
exit $?
