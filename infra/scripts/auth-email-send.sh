#!/usr/bin/env bash
# RoadwiseFleet — auth email sender: preflight, real send, CI guards
# (board eila/tasks#124, email P0 half).
#
# The Android/email OTP flow (#125) needs one dedicated sender:
#   no-reply@elilaltd.com  ->  Stalwart on elilavps1, submission port 465 (smtps).
#
# This script owns the DELIVERY side of that: where the credential must live,
# which key names the API reads, and whether a real message is accepted by the
# mail server. It deliberately does not implement OTP endpoints or templates —
# that is #125.
#
# Usage:
#   auth-email-send.sh --check                 verify the 0600 env file + key names
#   auth-email-send.sh --send --to <address>   send a real test message (needs the credential)
#   auth-email-send.sh --check-repo [root]     env-contract drift guard (CI, no network)
#   auth-email-send.sh --self-test             fixture proof (no host, no network)
#   auth-email-send.sh --help
#
# Secret handling, by construction:
#   * the env file must be mode 0600 (0400 accepted) and owned by root when this
#     runs as root, otherwise by the invoking user (so CI fixtures can run);
#   * the credential is written to a 0600 curl config file in a private temp dir
#     and passed with --config, never on the command line (no `ps` exposure);
#   * no value is ever printed: --check reports `<KEY>: set` / `<KEY>: MISSING`;
#   * the temp dir is removed on exit.
#
# Exit codes:
#   0  ok (check passed / message accepted by the server)
#   2  usage error or invalid input (address, port, host)
#   3  not configured: env file missing/unreadable, bad mode/owner, missing key
#   4  the SMTP submission failed (curl non-zero) — nothing is retried here
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.

set -uo pipefail

# Canonical key contract. #125's API code must read exactly these names.
REQUIRED_KEYS=(AUTH_EMAIL_SMTP_HOST AUTH_EMAIL_SMTP_USER AUTH_EMAIL_SMTP_PASS AUTH_EMAIL_FROM)
OPTIONAL_KEYS=(AUTH_EMAIL_SMTP_PORT)
DEFAULT_PORT=465

DEFAULT_ENV_FILE=/etc/roadwisefleet/auth-email.env
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: auth-email-send.sh --check
       auth-email-send.sh --send --to <address>
       auth-email-send.sh --check-repo [repo-root]
       auth-email-send.sh --self-test
       auth-email-send.sh --help
EOF
}

die() {
  printf 'auth-email-send: %s\n' "$1" >&2
  exit "${2:-3}"
}

# Escape a value for a curl config double-quoted string.
cfg_escape() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '%s' "$v"
}

# Parsed, never sourced: the file is data (systemd EnvironmentFile syntax), so a
# malformed line can never execute, and a syntax error can never echo a value.
# Unknown keys FAIL: a typo in the file would otherwise silently disable auth
# email (systemd ignores an unused variable too).
declare -A ENV=()

parse_env() {
  local file="$1" line key value failures=0
  ENV=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*$ ]]; then
      continue
    fi
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! "$line" =~ ^[[:space:]]*([A-Z0-9_]+)=(.*)$ ]]; then
      printf 'FAIL %s: unparseable line (expected KEY=value)\n' "$file"
      failures=$((failures + 1))
      continue
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ ${#value} -ge 2 ]]; then
      case "$value" in
        \"*\") value="${value:1:${#value}-2}" ;;
        \'*\') value="${value:1:${#value}-2}" ;;
      esac
    fi
    case "$key" in
      AUTH_EMAIL_SMTP_HOST|AUTH_EMAIL_SMTP_PORT|AUTH_EMAIL_SMTP_USER|AUTH_EMAIL_SMTP_PASS|AUTH_EMAIL_FROM)
        ENV["$key"]="$value"
        ;;
      *)
        printf 'FAIL %s: unknown key %s (not in the auth-email contract)\n' "$file" "$key"
        failures=$((failures + 1))
        ;;
    esac
  done <"$file"
  return "$failures"
}

# --check: the file must be a regular file, mode 0600/0400, owned by root (when
# run as root) or by the invoking user, every required key must be set, and no
# unknown key may appear. Prints key names and set/MISSING only — never a value.
check_env() {
  local env_file="$1" failures=0 k mode owner current_user parse_failures=0

  if [[ ! -e "$env_file" ]]; then
    printf 'FAIL %s: missing\n' "$env_file"
    return 3
  fi
  if [[ ! -f "$env_file" ]]; then
    printf 'FAIL %s: not a regular file\n' "$env_file"
    return 3
  fi
  if [[ ! -r "$env_file" ]]; then
    printf 'FAIL %s: unreadable (run as root or as its owner)\n' "$env_file"
    return 3
  fi

  mode="$(stat -c '%a' "$env_file" 2>/dev/null || true)"
  case "$mode" in
    600 | 400) ;;
    *)
      printf 'FAIL %s: mode is %s, must be 600 (or 400)\n' "$env_file" "${mode:-unknown}"
      failures=$((failures + 1))
      ;;
  esac

  owner="$(stat -c '%U' "$env_file" 2>/dev/null || true)"
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ "$owner" != "root" ]]; then
      printf 'FAIL %s: owner is %s, must be root\n' "$env_file" "${owner:-unknown}"
      failures=$((failures + 1))
    fi
  else
    current_user="$(id -un)"
    if [[ "$owner" != "$current_user" ]]; then
      printf 'FAIL %s: owner is %s, must be %s (or run this as root)\n' \
        "$env_file" "${owner:-unknown}" "$current_user"
      failures=$((failures + 1))
    fi
  fi

  parse_env "$env_file"
  parse_failures=$?
  failures=$((failures + parse_failures))

  for k in "${REQUIRED_KEYS[@]}"; do
    if [[ -z "${ENV[$k]:-}" ]]; then
      printf 'FAIL %s: MISSING\n' "$k"
      failures=$((failures + 1))
    else
      printf 'ok %s: set\n' "$k"
    fi
  done

  if [[ "$failures" -gt 0 ]]; then
    return 3
  fi
  return 0
}

valid_address() {
  local a="$1"
  # Deliberately no backtick, quote or whitespace: an address that cannot be
  # header-injected is the only kind this test sender accepts.
  [[ "$a" =~ ^[A-Za-z0-9.!#%+&*+/=?^_{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]
}

valid_host() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

# --send: one real message through the configured submission endpoint.
send_mail() {
  local to="$1" env_file="${2:-$DEFAULT_ENV_FILE}"
  local tmp cfg msg host port user pass from nonce rc

  check_env "$env_file" || exit 3

  host="${ENV[AUTH_EMAIL_SMTP_HOST]:-}"
  port="${ENV[AUTH_EMAIL_SMTP_PORT]:-$DEFAULT_PORT}"
  user="${ENV[AUTH_EMAIL_SMTP_USER]:-}"
  pass="${ENV[AUTH_EMAIL_SMTP_PASS]:-}"
  from="${ENV[AUTH_EMAIL_FROM]:-}"

  valid_host "$host" || die "AUTH_EMAIL_SMTP_HOST is not a hostname: '$host'" 2
  [[ "$port" =~ ^[0-9]+$ ]] || die "AUTH_EMAIL_SMTP_PORT is not a number: '$port'" 2
  if [[ "$port" -lt 1 || "$port" -gt 65535 ]]; then
    die "AUTH_EMAIL_SMTP_PORT out of range: '$port'" 2
  fi
  valid_address "$from" || die "AUTH_EMAIL_FROM is not an address: '$from'" 2
  valid_address "$to" || die "invalid recipient address: '$to'" 2

  nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  tmp="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/auth-email.XXXXXX")" || die "cannot create a temp dir" 3
  # shellcheck disable=SC2064  # expand tmp now, on purpose
  trap "rm -rf '$tmp'" EXIT INT TERM

  cfg="$tmp/curl.cfg"
  msg="$tmp/message.eml"

  {
    printf 'url = "smtps://%s:%s"\n' "$(cfg_escape "$host")" "$(cfg_escape "$port")"
    printf 'user = "%s:%s"\n' "$(cfg_escape "$user")" "$(cfg_escape "$pass")"
  } >"$cfg"
  chmod 0600 "$cfg"

  {
    printf 'Date: %s\n' "$(date -R)"
    printf 'From: %s\n' "$from"
    printf 'To: %s\n' "$to"
    printf 'Message-ID: <%s@%s>\n' "$nonce" "$host"
    printf 'Subject: RoadwiseFleet auth sender test %s\n' "$nonce"
    printf 'MIME-Version: 1.0\n'
    printf 'Content-Type: text/plain; charset=utf-8\n'
    printf 'Content-Transfer-Encoding: 8bit\n'
    printf 'X-RoadwiseFleet-Test: %s\n' "$nonce"
    printf '\n'
    printf 'Delivery test for the RoadwiseFleet auth email sender (board #124).\n'
    printf 'Nonce: %s\n' "$nonce"
    printf 'If this message arrived, the SMTP submission credential works.\n'
  } >"$msg"

  printf 'sending test message via smtps://%s:%s as %s\n' "$host" "$port" "$from"
  curl --silent --show-error --fail \
    --connect-timeout 10 --max-time 60 \
    --config "$cfg" \
    --mail-from "$from" \
    --mail-rcpt "$to" \
    --upload-file "$msg"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf 'FAIL send: curl exited %s (see its message above; no credential is printed)\n' "$rc" >&2
    exit 4
  fi

  printf 'ok sent to %s\n' "$to"
  printf 'ok verify delivery by the header: X-RoadwiseFleet-Test: %s\n' "$nonce"
  return 0
}

# --check-repo: the example file, this script and the runbook must agree on the
# key contract, and the example must never carry a secret value.
check_repo() {
  local root="${1:-$REPO_ROOT}" failures=0 warnings=0
  local example="$root/infra/auth-email.env.example"
  local runbook="$root/infra/auth-email.md"
  local k line key value found
  local -a example_keys=()

  if [[ ! -f "$example" ]]; then
    printf 'FAIL %s: missing\n' "$example"
    return 1
  fi
  if [[ ! -f "$runbook" ]]; then
    printf 'FAIL %s: missing\n' "$runbook"
    return 1
  fi

  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ -z "${line//[[:space:]]/}" ]]; then
      continue
    fi
    if [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      example_keys+=("$key")
      if [[ "$key" =~ _(PASS|SECRET|TOKEN)$ && -n "$value" ]]; then
        printf 'FAIL %s: carries a value for %s (the example must be empty)\n' "$example" "$key"
        failures=$((failures + 1))
      fi
    else
      printf 'WARN %s: line is neither a comment nor KEY=value: %s\n' "$example" "$line"
      warnings=$((warnings + 1))
    fi
  done <"$example"

  for k in "${REQUIRED_KEYS[@]}" "${OPTIONAL_KEYS[@]}"; do
    found=0
    for key in "${example_keys[@]}"; do
      [[ "$key" == "$k" ]] && found=1
    done
    if [[ "$found" -eq 0 ]]; then
      printf 'FAIL %s: %s is missing\n' "$example" "$k"
      failures=$((failures + 1))
    fi
    if ! grep -q -- "$k" "$runbook"; then
      printf 'FAIL %s: %s is not documented\n' "$runbook" "$k"
      failures=$((failures + 1))
    fi
  done

  for key in "${example_keys[@]}"; do
    found=0
    for k in "${REQUIRED_KEYS[@]}" "${OPTIONAL_KEYS[@]}"; do
      [[ "$key" == "$k" ]] && found=1
    done
    if [[ "$found" -eq 0 ]]; then
      printf 'FAIL %s: unexpected key %s (not in the script contract)\n' "$example" "$key"
      failures=$((failures + 1))
    fi
  done

  printf 'failures: %s   warnings: %s\n' "$failures" "$warnings"
  [[ "$failures" -eq 0 ]]
}

# ------------------------------------------------------------------ self-test
# Drives the real script against fixtures and a stub curl: no host, no network.
# Every assertion reads what the stub was actually asked to do.
self_test() {
  local tmp pass=0 fail=0
  local env_file out rc nonce

  tmp="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/auth-email-selftest.XXXXXX")" || {
    printf 'FAIL cannot create a temp dir\n'
    return 1
  }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT INT TERM

  mkdir -p "$tmp/bin" "$tmp/work"

  cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Minimal curl stub: records argv, the config file (mode + copy) and the message.
cfg=""
upload=""
printf '%s\n' "$*" >"${STUB_ARGV:?}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      cfg="$2"
      shift 2
      ;;
    --upload-file)
      upload="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
if [[ -n "$cfg" ]]; then
  stat -c '%a' "$cfg" >"${STUB_CFG_MODE:?}"
  cp "$cfg" "${STUB_CFG_COPY:?}"
fi
if [[ -n "$upload" ]]; then
  cp "$upload" "${STUB_MSG_COPY:?}"
fi
exit "${STUB_EXIT:-0}"
STUB
  chmod +x "$tmp/bin/curl"

  export PATH="$tmp/bin:$PATH"
  export STUB_ARGV="$tmp/work/argv"
  export STUB_CFG_MODE="$tmp/work/cfg.mode"
  export STUB_CFG_COPY="$tmp/work/cfg.copy"
  export STUB_MSG_COPY="$tmp/work/message.copy"
  unset STUB_EXIT

  assert_eq() { # <label> <got> <want>
    if [[ "$2" == "$3" ]]; then
      printf 'PASS %s\n' "$1"
      pass=$((pass + 1))
    else
      printf 'FAIL %s (got %s, want %s)\n' "$1" "$2" "$3"
      fail=$((fail + 1))
    fi
  }

  assert_contains() { # <label> <file> <text>
    if grep -qF -- "$3" "$2" 2>/dev/null; then
      printf 'PASS %s\n' "$1"
      pass=$((pass + 1))
    else
      printf 'FAIL %s (missing %s in %s)\n' "$1" "$3" "$2"
      fail=$((fail + 1))
    fi
  }

  assert_not_contains() { # <label> <file> <text>
    if grep -qF -- "$3" "$2" 2>/dev/null; then
      printf 'FAIL %s (found %s in %s)\n' "$1" "$3" "$2"
      fail=$((fail + 1))
    else
      printf 'PASS %s\n' "$1"
      pass=$((pass + 1))
    fi
  }

  mk_fixture() { # <path> <mode>
    local path="$1" mode="$2"
    {
      printf 'AUTH_EMAIL_SMTP_HOST=mail.example.test\n'
      printf 'AUTH_EMAIL_SMTP_PORT=465\n'
      printf 'AUTH_EMAIL_SMTP_USER=no-reply@example.test\n'
      printf 'AUTH_EMAIL_SMTP_PASS=fixture-pass-not-real\n'
      printf 'AUTH_EMAIL_FROM=no-reply@example.test\n'
    } >"$path"
    chmod "$mode" "$path"
  }

  # 1. healthy 0600 fixture passes --check and never prints the value
  env_file="$tmp/work/good.env"
  mk_fixture "$env_file" 600
  out="$("$0" --check --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "check: a 0600 fixture passes (rc)" "$rc" "0"
  assert_contains "check: reports the password as set" <(printf '%s\n' "$out") "ok AUTH_EMAIL_SMTP_PASS: set"
  assert_not_contains "check: never prints the password" <(printf '%s\n' "$out") "fixture-pass-not-real"

  # 2. a world-readable fixture is refused
  env_file="$tmp/work/bad-mode.env"
  mk_fixture "$env_file" 644
  out="$("$0" --check --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "check: a 0644 fixture is refused (rc)" "$rc" "3"
  assert_contains "check: names the bad mode" <(printf '%s\n' "$out") "mode is 644"

  # 3. a missing key is refused
  env_file="$tmp/work/missing.env"
  mk_fixture "$env_file" 600
  grep -v '^AUTH_EMAIL_SMTP_PASS=' "$env_file" >"$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
  chmod 600 "$env_file"
  out="$("$0" --check --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "check: a missing key is refused (rc)" "$rc" "3"
  assert_contains "check: names the missing key" <(printf '%s\n' "$out") "AUTH_EMAIL_SMTP_PASS: MISSING"

  # 3b. a typo'd key is refused (systemd would ignore it silently)
  env_file="$tmp/work/typo.env"
  mk_fixture "$env_file" 600
  printf 'AUTH_EMAIL_SMTP_PASSS=oops\n' >>"$env_file"
  out="$("$0" --check --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "check: an unknown key is refused (rc)" "$rc" "3"
  assert_contains "check: names the unknown key" <(printf '%s\n' "$out") "unknown key AUTH_EMAIL_SMTP_PASSS"

  # 4. a real send: right URL, config-file credential, message contents
  env_file="$tmp/work/good.env"
  out="$("$0" --send --to ugur@elilaltd.com --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "send: exits 0 on acceptance (rc)" "$rc" "0"
  assert_contains "send: uses smtps on the configured host/port" "$STUB_CFG_COPY" 'url = "smtps://mail.example.test:465"'
  assert_contains "send: credential travels in the config file" "$STUB_CFG_COPY" 'user = "no-reply@example.test:fixture-pass-not-real"'
  assert_eq "send: the config file is 0600 at call time" "$(cat "$STUB_CFG_MODE")" "600"
  assert_not_contains "send: no credential in argv" "$STUB_ARGV" "fixture-pass-not-real"
  assert_contains "send: sets the envelope sender" "$STUB_ARGV" "--mail-from no-reply@example.test"
  assert_contains "send: sets the recipient" "$STUB_ARGV" "--mail-rcpt ugur@elilaltd.com"
  assert_contains "send: message has a To header" "$STUB_MSG_COPY" "To: ugur@elilaltd.com"
  assert_contains "send: message has a Date header" "$STUB_MSG_COPY" "Date: "
  nonce="$(grep -o 'X-RoadwiseFleet-Test: .*' "$STUB_MSG_COPY" | head -1 | sed 's/^X-RoadwiseFleet-Test: //')"
  if [[ -n "$nonce" ]]; then
    printf 'PASS send: message carries a nonce header\n'
    pass=$((pass + 1))
    assert_contains "send: prints the nonce for delivery verification" <(printf '%s\n' "$out") "$nonce"
  else
    printf 'FAIL send: message carries a nonce header\n'
    fail=$((fail + 1))
  fi
  assert_not_contains "send: never prints the password" <(printf '%s\n' "$out") "fixture-pass-not-real"

  # 5. header injection in the recipient is refused before any send
  rm -f "$STUB_ARGV"
  out="$("$0" --send --to $'a@b.test\nBcc: x@y.test' --env-file "$env_file" 2>&1)"
  rc=$?
  assert_eq "send: a CRLF-injected recipient is refused (rc)" "$rc" "2"
  assert_eq "send: nothing was sent for the injected recipient" "$([[ -f "$STUB_ARGV" ]] && echo sent || echo not-sent)" "not-sent"

  # 6. a server-side rejection is a loud failure and leaks nothing
  export STUB_EXIT=67
  out="$("$0" --send --to ugur@elilaltd.com --env-file "$env_file" 2>&1)"
  rc=$?
  unset STUB_EXIT
  assert_eq "send: a submission failure exits 4" "$rc" "4"
  assert_contains "send: reports the failure" <(printf '%s\n' "$out") "FAIL send: curl exited 67"
  assert_not_contains "send: no credential on failure" <(printf '%s\n' "$out") "fixture-pass-not-real"

  # 7. the repo contract holds on the real tree
  out="$("$0" --check-repo "$REPO_ROOT" 2>&1)"
  rc=$?
  assert_eq "check-repo: the real tree passes (rc)" "$rc" "0"
  assert_contains "check-repo: reports zero failures" <(printf '%s\n' "$out") "failures: 0"

  # 8. contract drift is caught: an example that drops a key
  mkdir -p "$tmp/repo/infra"
  cp "$REPO_ROOT/infra/auth-email.md" "$tmp/repo/infra/auth-email.md"
  grep -v '^AUTH_EMAIL_FROM=' "$REPO_ROOT/infra/auth-email.env.example" >"$tmp/repo/infra/auth-email.env.example"
  out="$("$0" --check-repo "$tmp/repo" 2>&1)"
  rc=$?
  assert_eq "check-repo: a dropped key fails (rc)" "$rc" "1"
  assert_contains "check-repo: names the dropped key" <(printf '%s\n' "$out") "AUTH_EMAIL_FROM is missing"

  # 9. an example carrying a secret value is caught
  sed 's/^AUTH_EMAIL_SMTP_PASS=.*/AUTH_EMAIL_SMTP_PASS=not-a-placeholder/' \
    "$REPO_ROOT/infra/auth-email.env.example" >"$tmp/repo/infra/auth-email.env.example"
  out="$("$0" --check-repo "$tmp/repo" 2>&1)"
  rc=$?
  assert_eq "check-repo: a secret value in the example fails (rc)" "$rc" "1"
  assert_contains "check-repo: says the example must be empty" <(printf '%s\n' "$out") "carries a value for AUTH_EMAIL_SMTP_PASS"

  # 10. usage errors
  out="$("$0" --send 2>&1)"
  rc=$?
  assert_eq "usage: --send without --to exits 2" "$rc" "2"

  printf 'self-test: %s passed, %s failed\n' "$pass" "$fail"
  [[ "$fail" -eq 0 ]]
}

# ---------------------------------------------------------------------- main
mode=""
to=""
env_file="$DEFAULT_ENV_FILE"
repo_root="$REPO_ROOT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) mode="check"; shift ;;
    --send) mode="send"; shift ;;
    --check-repo)
      mode="check-repo"
      shift
      if [[ $# -gt 0 && "$1" != --* ]]; then
        repo_root="$1"
        shift
      fi
      ;;
    --self-test) mode="self-test"; shift ;;
    --to)
      [[ $# -ge 2 ]] || die "--to needs an address" 2
      to="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file needs a path" 2
      env_file="$2"
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" 2 ;;
  esac
done

case "$mode" in
  check) check_env "$env_file" || exit $? ;;
  send)
    [[ -n "$to" ]] || { usage; die "--send needs --to <address>" 2; }
    send_mail "$to" "$env_file"
    ;;
  check-repo) check_repo "$repo_root" ;;
  self-test) self_test ;;
  *)
    usage
    die "pick a mode: --check, --send, --check-repo or --self-test" 2
    ;;
esac
