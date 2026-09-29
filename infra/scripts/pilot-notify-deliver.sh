#!/usr/bin/env bash
# RoadwiseFleet — customer notification delivery transport (board eila/tasks#79, UXF-O2).
#
# The app owns WHAT happened (a lifecycle event); this transport owns the safe
# DELIVERY of it:
#
#   * render the template for the event (one template per event, no blank or
#     half-rendered message ever leaves the host),
#   * honour the recipient's channel preferences (a channel switched off is
#     suppressed, not sent),
#   * retry ONCE on failure, then give up and record the failure, and
#   * log the outcome without secrets: never the message body (a delivered link
#     is a capability token), never a transport setting, and the recipient is
#     redacted.
#
# It is provider-agnostic and SAFE BY DEFAULT: with no owner-approved transport
# configured it sends NOTHING (exit 3). It never invents a sender, a domain or a
# provider — those are owner decisions (#29 email enablement, #21/#24 WhatsApp /
# SMS providers). The app-side emission of events is software development (Max).
#
# Usage:
#   pilot-notify-deliver.sh --event-file <path>   deliver one queued event
#   pilot-notify-deliver.sh --drain <dir>         deliver every *.key in <dir>
#   pilot-notify-deliver.sh --check-repo          template/catalogue consistency (CI)
#   pilot-notify-deliver.sh --self-test           fixture proof (no host, no network)
#   pilot-notify-deliver.sh --help
#
# Envelope (key=value, one per line — the app-side contract):
#   event=offer_received
#   channel=email                       email | whatsapp | sms
#   recipient=customer@example.com      an address, or an E.164 phone for whatsapp/sms
#   trip_ref=RWF-1042                   ...plus the template's own variables
#
# Transport (a command per channel; each receives the message on stdin):
#   RWF_NOTIFY_EMAIL_CMD     sendmail-compatible: message headers+body on stdin
#   RWF_NOTIFY_WEBHOOK_CMD   whatsapp/sms bridge: text on stdin, plus
#                            RWF_NOTIFY_CHANNEL and RWF_NOTIFY_RECIPIENT in the env
#   RWF_NOTIFY_FROM          the owner-approved From address (email). Unset -> exit 3.
#
# Settings come from a 0600 EnvironmentFile (default
# /etc/roadwisefleet/notifications.env), sourced and never echoed.
#
# Exit codes:
#   0  delivered, or suppressed by the recipient's preferences (nothing to send)
#   2  usage error / malformed envelope / unknown channel
#   3  NO owner-approved transport (or sender) configured — nothing was sent
#   4  the transport failed on the attempt and on the single retry
#   5  template error (unknown event, or an unresolved variable)
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.

set -uo pipefail

if [[ -r "${RWF_NOTIFY_ENV:-/etc/roadwisefleet/notifications.env}" ]]; then
  set -a
  # shellcheck disable=SC1090  # 0600 root-owned EnvironmentFile, by design
  . "${RWF_NOTIFY_ENV:-/etc/roadwisefleet/notifications.env}"
  set +a
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_DIR="${RWF_NOTIFY_TEMPLATES:-$REPO_ROOT/infra/notifications/templates}"
PREFS_FILE="${RWF_NOTIFY_PREFS:-/etc/roadwisefleet/notify-prefs.conf}"
LOG_FILE="${RWF_NOTIFY_LOG:-/var/log/roadwisefleet/notifications.log}"
RETRY_DELAY="${RWF_NOTIFY_RETRY_DELAY:-2}"

# The lifecycle events UXF-O2 must deliver (the issue's list). Every one needs a
# template; an event that is not catalogued is refused, never sent blank.
EVENTS=(offer_received awarded driver_assigned at_pickup in_transit delivered pod_ready invoice_issued)
CHANNELS=(email whatsapp sms)

usage() {
  cat >&2 <<'EOF'
usage: pilot-notify-deliver.sh --event-file <path>
       pilot-notify-deliver.sh --drain <dir>
       pilot-notify-deliver.sh --check-repo
       pilot-notify-deliver.sh --self-test
       pilot-notify-deliver.sh --help
EOF
}

# --- logging (the durable artifact; must never carry a secret or PII) --------

# redact_contact <contact> -> a redacted form safe for a log line.
redact_contact() {
  local c="$1"
  if [[ "$c" == *@* ]]; then
    printf '%s***@%s\n' "${c:0:1}" "${c#*@}"
  elif [[ ${#c} -ge 4 ]]; then
    printf '***%s\n' "${c: -4}"
  else
    printf '***\n'
  fi
}

# log_line <result> <event> <channel> <recipient> <attempt>
# Deliberately logs ONLY the result, the event, the channel, the REDACTED
# recipient and the attempt number: the body can carry a capability link and
# the settings can carry credentials.
log_line() {
  local result="$1" event="$2" channel="$3" recipient="$4" attempt="$5"
  local ts line redacted
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  redacted="$(redact_contact "$recipient")"
  line="${ts} event=${event} channel=${channel} to=${redacted} attempt=${attempt} result=${result}"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  if ! printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null; then
    printf 'WARN: cannot write the notification log %s\n' "$LOG_FILE" >&2
  fi
  printf '%s\n' "$line" >&2
}

# --- rendering ---------------------------------------------------------------

# render_template <template-file>
# Substitutes every {{variable}} from the envelope's VARS map. If a placeholder
# has no value the render FAILS (exit 5 upstream) rather than sending a message
# with "{{...}}" in it. Sets RENDERED and RENDER_ERR.
RENDERED=""
RENDER_ERR=""
render_template() {
  local tpl="$1" ph name val out
  local -a missing=()
  out="$(cat "$tpl")"
  while IFS= read -r ph; do
    name="${ph#\{\{}"
    name="${name%\}\}}"
    val="${VARS[$name]:-}"
    if [[ -z "$val" ]]; then
      missing+=("$name")
      continue
    fi
    out="${out//$ph/$val}"
  done < <(grep -oE '\{\{[a-zA-Z0-9_]+\}\}' "$tpl" | sort -u)
  if [[ ${#missing[@]} -gt 0 ]]; then
    RENDER_ERR="${missing[*]}"
    return 1
  fi
  RENDERED="$out"
  RENDER_ERR=""
  return 0
}

# --- preferences -------------------------------------------------------------

# pref_allows <recipient> <channel> -> 0 allowed, 1 suppressed.
# File format: "<recipient> <channel> <true|false>", '#' comments. Absent
# recipient or channel means allowed (opt-out model); an explicit false wins.
pref_allows() {
  local want_r="$1" want_c="$2" r c v
  if [[ ! -r "$PREFS_FILE" ]]; then
    return 0
  fi
  while read -r r c v _; do
    if [[ -z "$r" || "$r" == '#'* ]]; then
      continue
    fi
    if [[ "$r" == "$want_r" && "$c" == "$want_c" ]]; then
      if [[ "$v" == "false" ]]; then
        return 1
      fi
      return 0
    fi
  done < "$PREFS_FILE"
  return 0
}

# --- transports --------------------------------------------------------------

# send_via_transport <channel> <recipient> <message>
#   0 delivered · 3 no configured transport · other = transport failure
send_via_transport() {
  local channel="$1" recipient="$2" message="$3"
  case "$channel" in
    email)
      if [[ -z "${RWF_NOTIFY_EMAIL_CMD:-}" ]]; then
        return 3
      fi
      # shellcheck disable=SC2086  # a command with its own arguments, by design
      printf '%s' "$message" | $RWF_NOTIFY_EMAIL_CMD
      ;;
    whatsapp|sms)
      if [[ -z "${RWF_NOTIFY_WEBHOOK_CMD:-}" ]]; then
        return 3
      fi
      # shellcheck disable=SC2086  # a command with its own arguments, by design
      printf '%s' "$message" | RWF_NOTIFY_CHANNEL="$channel" RWF_NOTIFY_RECIPIENT="$recipient" $RWF_NOTIFY_WEBHOOK_CMD
      ;;
    *)
      return 2
      ;;
  esac
}

# --- delivery ----------------------------------------------------------------

# deliver_one <envelope-file>
deliver_one() {
  local env_file="$1"
  local line key value event channel recipient tpl subject body message rc
  local -A VARS=()

  if [[ ! -r "$env_file" ]]; then
    printf 'ERROR: envelope is not readable: %s\n' "$env_file" >&2
    return 2
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == '#'* ]]; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    VARS["$key"]="$value"
  done < "$env_file"

  event="${VARS[event]:-}"
  channel="${VARS[channel]:-}"
  recipient="${VARS[recipient]:-}"
  if [[ -z "$event" || -z "$channel" || -z "$recipient" ]]; then
    printf 'ERROR: the envelope needs event=, channel= and recipient=: %s\n' "$env_file" >&2
    return 2
  fi
  if [[ " ${CHANNELS[*]} " != *" $channel "* ]]; then
    printf 'ERROR: unknown channel: %s\n' "$channel" >&2
    return 2
  fi

  tpl="$TEMPLATE_DIR/$event.txt"
  if [[ ! -r "$tpl" ]]; then
    printf 'ERROR: no template for event: %s\n' "$event" >&2
    log_line template_error "$event" "$channel" "$recipient" 0
    return 5
  fi

  if ! pref_allows "$recipient" "$channel"; then
    printf 'suppressed: %s is switched off for this recipient\n' "$channel" >&2
    log_line suppressed "$event" "$channel" "$recipient" 0
    return 0
  fi

  if ! render_template "$tpl"; then
    printf 'ERROR: template %s has unresolved variables: %s\n' "$event" "$RENDER_ERR" >&2
    log_line template_error "$event" "$channel" "$recipient" 0
    return 5
  fi

  subject="$(printf '%s\n' "$RENDERED" | sed -n '1s/^Subject:[[:space:]]*//p')"
  body="$(printf '%s\n' "$RENDERED" | awk 'p{print} /^$/{p=1}')"
  if [[ -z "$subject" || -z "$body" ]]; then
    printf 'ERROR: template %s needs a Subject: line and a body\n' "$event" >&2
    log_line template_error "$event" "$channel" "$recipient" 0
    return 5
  fi

  if [[ "$channel" == "email" ]]; then
    if [[ -z "${RWF_NOTIFY_FROM:-}" ]]; then
      printf 'WARN: RWF_NOTIFY_FROM is not set — no owner-approved sender, nothing sent\n' >&2
      log_line no_sender "$event" "$channel" "$recipient" 0
      return 3
    fi
    message="$(printf 'From: %s\nTo: %s\nSubject: %s\n\n%s\n' "$RWF_NOTIFY_FROM" "$recipient" "$subject" "$body")"
  else
    message="$body"
  fi

  # Attempt 1.
  send_via_transport "$channel" "$recipient" "$message"
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    log_line delivered "$event" "$channel" "$recipient" 1
    return 0
  fi
  if [[ "$rc" -eq 3 ]]; then
    printf 'WARN: no owner-approved transport for channel %s — nothing was sent\n' "$channel" >&2
    log_line no_transport "$event" "$channel" "$recipient" 1
    return 3
  fi

  # Retry exactly once.
  log_line retry "$event" "$channel" "$recipient" 1
  sleep "$RETRY_DELAY"
  send_via_transport "$channel" "$recipient" "$message"
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    log_line delivered "$event" "$channel" "$recipient" 2
    return 0
  fi
  if [[ "$rc" -eq 3 ]]; then
    log_line no_transport "$event" "$channel" "$recipient" 2
    return 3
  fi
  log_line failed "$event" "$channel" "$recipient" 2
  return 4
}

# drain_dir <dir> — deliver every *.key, then move it to .sent or .failed.
drain_dir() {
  local dir="$1" f rc=0
  local -a files=()
  if [[ ! -d "$dir" ]]; then
    printf 'ERROR: spool directory not found: %s\n' "$dir" >&2
    return 2
  fi
  shopt -s nullglob
  files=("$dir"/*.key)
  shopt -u nullglob
  if [[ ${#files[@]} -eq 0 ]]; then
    printf 'notification spool empty: %s\n' "$dir"
    return 0
  fi
  for f in "${files[@]}"; do
    if deliver_one "$f"; then
      mv "$f" "${f}.sent" 2>/dev/null || true
    else
      rc=1
      mv "$f" "${f}.failed" 2>/dev/null || true
    fi
  done
  return "$rc"
}

# --- repo consistency (CI) ---------------------------------------------------

repo_fails=0
repo_warns=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; repo_fails=$((repo_fails + 1)); }
warn() { printf '  WARN  %s\n' "$1"; repo_warns=$((repo_warns + 1)); }

check_repo() {
  local e tpl base
  printf 'RoadwiseFleet notification catalogue — repo consistency\n'
  printf 'templates: %s\n\n' "${TEMPLATE_DIR#"$REPO_ROOT"/}"

  if [[ ! -d "$TEMPLATE_DIR" ]]; then
    fail "template directory missing: $TEMPLATE_DIR"
    printf '\n  failures: %d   warnings: %d\n' "$repo_fails" "$repo_warns"
    return 1
  fi

  for e in "${EVENTS[@]}"; do
    tpl="$TEMPLATE_DIR/$e.txt"
    if [[ ! -f "$tpl" ]]; then
      fail "no template for event $e"
      continue
    fi
    if ! grep -qE '^Subject:' "$tpl"; then
      fail "$e.txt has no Subject: line"
    fi
    # A template must never hardcode an address: the sender is the owner's
    # decision and the recipient comes from the envelope.
    if grep -qE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' "$tpl"; then
      fail "$e.txt embeds an address — templates must not invent a sender/recipient"
    fi
    ok "$e.txt present"
  done

  shopt -s nullglob
  for tpl in "$TEMPLATE_DIR"/*.txt; do
    base="$(basename "$tpl" .txt)"
    if [[ " ${EVENTS[*]} " != *" $base "* ]]; then
      fail "template $base.txt has no event in the catalogue"
    fi
  done
  shopt -u nullglob

  printf '\n  failures: %d   warnings: %d\n' "$repo_fails" "$repo_warns"
  if [[ "$repo_fails" -gt 0 ]]; then
    return 1
  fi
  return 0
}

# --- self-test ---------------------------------------------------------------

pass=0
failed=0

expect() { # name want got
  if [[ "$2" == "$3" ]]; then
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

absent() { # name haystack needle
  case "$2" in
    *"$3"*)
      printf 'FAIL %s (output must NOT contain: %s)\n' "$1" "$3"
      failed=$((failed + 1))
      ;;
    *)
      printf 'PASS %s\n' "$1"
      pass=$((pass + 1))
      ;;
  esac
}

write_envelope() { # file event channel recipient [extra...]
  local f="$1" event="$2" channel="$3" recipient="$4"
  shift 4
  {
    printf 'event=%s\n' "$event"
    printf 'channel=%s\n' "$channel"
    printf 'recipient=%s\n' "$recipient"
    printf 'customer_name=Ada\n'
    printf 'trip_ref=RWF-1042\n'
    printf 'pickup=Lagos, NG\n'
    printf 'delivery=Accra, GH\n'
    printf 'carrier_name=Asif Transport\n'
    printf 'driver_name=Kofi\n'
    printf 'vehicle=TRK-77\n'
    printf 'price=1200 USD\n'
    printf 'eta=14:30 UTC\n'
    printf 'invoice_ref=INV-9001\n'
    printf 'amount=1200.00 USD\n'
    printf 'link=https://roadwisefleet.com/track/abcdef0123456789\n'
    local extra
    for extra in "$@"; do
      printf '%s\n' "$extra"
    done
  } > "$f"
}

# The transports are commands, so a fixture stub is the real proof.
write_mail_stub() { # file
  cat > "$1" <<'EOF'
#!/usr/bin/env bash
msg="$(cat)"
printf '%s\n---\n' "$msg" >> "$STUB_SENT"
EOF
}

# Fails the first invocation, succeeds afterwards: the retry-once proof.
write_once_stub() { # file
  cat > "$1" <<'EOF'
#!/usr/bin/env bash
msg="$(cat)"
printf 'x' >> "$STUB_COUNT"
n="$(wc -c < "$STUB_COUNT")"
if [ "$n" -lt 2 ]; then
  exit 1
fi
printf '%s\n---\n' "$msg" >> "$STUB_SENT"
EOF
}

# Always fails: the "failed on the retry too" proof.
write_fail_stub() { # file
  cat > "$1" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
printf 'x' >> "$STUB_COUNT"
exit 1
EOF
}

self_test() {
  local st rc out logstub
  st="$(mktemp -d "${TMPDIR:-/tmp}/notify-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$st'" EXIT

  export STUB_SENT="$st/sent.txt"
  export STUB_COUNT="$st/count.txt"
  export RWF_NOTIFY_RETRY_DELAY=0
  export RWF_NOTIFY_FROM="notifications@roadwisefleet.com"
  # The script resolves its own paths at startup, so point them at the fixture
  # directly (the RWF_* env override is for a host, not for this proof).
  LOG_FILE="$st/notifications.log"
  PREFS_FILE="$st/absent-prefs.conf"
  RETRY_DELAY=0
  : > "$STUB_SENT"
  : > "$STUB_COUNT"

  write_mail_stub "$st/mail-stub"
  write_once_stub "$st/once-stub"
  write_fail_stub "$st/fail-stub"
  chmod +x "$st/mail-stub" "$st/once-stub" "$st/fail-stub"

  # 1. the real repo catalogue passes, and every event has its template.
  repo_fails=0
  repo_warns=0
  TEMPLATE_DIR="$REPO_ROOT/infra/notifications/templates"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "the real catalogue passes (rc)" 0 "$rc"
  expect "the real catalogue has no failures" 0 "$repo_fails"
  contains "the catalogue lists the offer event" "$out" "offer_received.txt present"
  contains "the catalogue lists the invoice event" "$out" "invoice_issued.txt present"

  # 2. a missing template FAILS and is named.
  mkdir -p "$st/tpl-missing"
  cp "$REPO_ROOT"/infra/notifications/templates/*.txt "$st/tpl-missing/"
  rm -f "$st/tpl-missing/pod_ready.txt"
  repo_fails=0
  repo_warns=0
  TEMPLATE_DIR="$st/tpl-missing"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a missing template fails (rc)" 1 "$rc"
  contains "the missing template is named" "$out" "no template for event pod_ready"

  # 3. a template with a hardcoded address FAILS (the sender is the owner's).
  mkdir -p "$st/tpl-sender"
  cp "$REPO_ROOT"/infra/notifications/templates/*.txt "$st/tpl-sender/"
  printf 'Reply to us at hello@example.com\n' >> "$st/tpl-sender/delivered.txt"
  repo_fails=0
  repo_warns=0
  TEMPLATE_DIR="$st/tpl-sender"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a hardcoded address fails (rc)" 1 "$rc"
  contains "the hardcoded address is named" "$out" "must not invent a sender"

  # 4. a stray template FAILS.
  mkdir -p "$st/tpl-stray"
  cp "$REPO_ROOT"/infra/notifications/templates/*.txt "$st/tpl-stray/"
  printf 'Subject: x\n\nbody\n' > "$st/tpl-stray/new_event_not_in_catalogue.txt"
  repo_fails=0
  repo_warns=0
  TEMPLATE_DIR="$st/tpl-stray"
  check_repo > "$st/out" 2>&1
  rc=$?
  out="$(cat "$st/out")"
  expect "a stray template fails (rc)" 1 "$rc"
  contains "the stray template is named" "$out" "has no event in the catalogue"

  TEMPLATE_DIR="$REPO_ROOT/infra/notifications/templates"

  # 5. a healthy email delivery: exit 0, message rendered, log says delivered.
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  write_envelope "$st/e1.key" offer_received email customer@example.com
  RWF_NOTIFY_EMAIL_CMD="$st/mail-stub"
  deliver_one "$st/e1.key" > "$st/out" 2>&1
  rc=$?
  expect "a healthy delivery succeeds (rc)" 0 "$rc"
  contains "the subject is rendered from the template" "$(cat "$STUB_SENT")" "We received your offer for RWF-1042"
  contains "the body carries the envelope variable" "$(cat "$STUB_SENT")" "Lagos, NG"
  logstub="$(cat "$LOG_FILE")"
  contains "the log records the delivered result" "$logstub" "result=delivered"
  contains "the log records the redacted recipient" "$logstub" "c***@example.com"
  absent "the log never carries the full recipient (PII)" "$logstub" "customer@example.com"

  # 6. an event whose body carries a capability link: the token is NEVER logged
  #    (and the check is meaningful because it IS in the delivered message).
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  write_envelope "$st/e8.key" delivered email customer@example.com
  deliver_one "$st/e8.key" > "$st/out" 2>&1
  rc=$?
  logstub="$(cat "$LOG_FILE")"
  expect "the delivered event sends (rc)" 0 "$rc"
  contains "the delivered link is in the message" "$(cat "$STUB_SENT")" "abcdef0123456789"
  absent "the log never carries the tracking token" "$logstub" "abcdef0123456789"
  absent "the log never carries the message body" "$logstub" "has been delivered"

  # 7. a channel switched off is suppressed: exit 0, nothing sent.
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  printf 'customer@example.com sms false\n' > "$st/prefs.conf"
  PREFS_FILE="$st/prefs.conf"
  write_envelope "$st/e2.key" in_transit sms +15551234567
  RWF_NOTIFY_WEBHOOK_CMD="$st/mail-stub"
  deliver_one "$st/e2.key" > "$st/out" 2>&1
  rc=$?
  expect "a suppressed channel exits 0 (rc)" 0 "$rc"
  expect "a suppressed channel sends nothing" "" "$(cat "$STUB_SENT")"
  contains "the suppression is logged" "$(cat "$LOG_FILE")" "result=suppressed"

  # 8. the same channel, switched on, is delivered.
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  printf 'customer@example.com sms true\n' > "$st/prefs.conf"
  write_envelope "$st/e3.key" in_transit sms +15551234567
  deliver_one "$st/e3.key" > "$st/out" 2>&1
  rc=$?
  expect "an enabled channel is delivered (rc)" 0 "$rc"
  contains "the whatsapp/sms body is rendered" "$(cat "$STUB_SENT")" "RWF-1042"
  PREFS_FILE="$st/absent-prefs.conf"

  # 9. a transport that fails once then succeeds: exactly one retry, then delivered.
  : > "$STUB_SENT"
  : > "$STUB_COUNT"
  : > "$LOG_FILE"
  write_envelope "$st/e4.key" awarded email customer@example.com
  RWF_NOTIFY_EMAIL_CMD="$st/once-stub"
  deliver_one "$st/e4.key" > "$st/out" 2>&1
  rc=$?
  logstub="$(cat "$LOG_FILE")"
  expect "a flaky transport still delivers (rc)" 0 "$rc"
  expect "the transport was invoked exactly twice" 2 "$(wc -c < "$STUB_COUNT")"
  contains "the first attempt is logged as a retry" "$logstub" "attempt=1 result=retry"
  contains "the retry is logged as delivered" "$logstub" "attempt=2 result=delivered"
  contains "the retried message was actually sent" "$(cat "$STUB_SENT")" "Asif Transport"

  # 10. a transport that always fails: exit 4, two attempts, failure logged.
  : > "$STUB_SENT"
  : > "$STUB_COUNT"
  : > "$LOG_FILE"
  RWF_NOTIFY_EMAIL_CMD="$st/fail-stub"
  deliver_one "$st/e4.key" > "$st/out" 2>&1
  rc=$?
  logstub="$(cat "$LOG_FILE")"
  expect "a permanent failure exits 4 (rc)" 4 "$rc"
  expect "a permanent failure is attempted exactly twice" 2 "$(wc -c < "$STUB_COUNT")"
  contains "the permanent failure is logged" "$logstub" "attempt=2 result=failed"
  expect "a permanent failure sends nothing" "" "$(cat "$STUB_SENT")"

  # 11. no transport configured: exit 3, nothing sent, nothing invented.
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  RWF_NOTIFY_EMAIL_CMD=""
  deliver_one "$st/e1.key" > "$st/out" 2>&1
  rc=$?
  expect "an unconfigured transport exits 3 (rc)" 3 "$rc"
  contains "the missing transport is logged" "$(cat "$LOG_FILE")" "result=no_transport"
  expect "an unconfigured transport sends nothing" "" "$(cat "$STUB_SENT")"

  # 12. no owner-approved sender: exit 3, nothing sent.
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  RWF_NOTIFY_EMAIL_CMD="$st/mail-stub"
  RWF_NOTIFY_FROM=""
  deliver_one "$st/e1.key" > "$st/out" 2>&1
  rc=$?
  expect "an unset sender exits 3 (rc)" 3 "$rc"
  contains "the missing sender is logged" "$(cat "$LOG_FILE")" "result=no_sender"
  expect "an unset sender sends nothing" "" "$(cat "$STUB_SENT")"
  RWF_NOTIFY_FROM="notifications@roadwisefleet.com"

  # 13. an unknown event: exit 5, nothing sent.
  : > "$STUB_SENT"
  write_envelope "$st/e5.key" surprise_event email customer@example.com
  deliver_one "$st/e5.key" > "$st/out" 2>&1
  rc=$?
  expect "an unknown event exits 5 (rc)" 5 "$rc"
  expect "an unknown event sends nothing" "" "$(cat "$STUB_SENT")"

  # 14. an unresolved variable: exit 5, nothing sent.
  : > "$STUB_SENT"
  write_envelope "$st/e6.key" delivered email customer@example.com 'link='
  deliver_one "$st/e6.key" > "$st/out" 2>&1
  rc=$?
  expect "an unresolved variable exits 5 (rc)" 5 "$rc"
  expect "an unresolved variable sends nothing" "" "$(cat "$STUB_SENT")"

  # 15. an unknown channel: exit 2.
  write_envelope "$st/e7.key" delivered carrier-pigeon customer@example.com
  deliver_one "$st/e7.key" > "$st/out" 2>&1
  rc=$?
  expect "an unknown channel exits 2 (rc)" 2 "$rc"

  # 16. every catalogued event renders and delivers (the issue's list).
  local ev
  : > "$STUB_SENT"
  : > "$LOG_FILE"
  RWF_NOTIFY_EMAIL_CMD="$st/mail-stub"
  for ev in "${EVENTS[@]}"; do
    write_envelope "$st/ev.key" "$ev" email customer@example.com
    deliver_one "$st/ev.key" > "$st/out" 2>&1
    rc=$?
    expect "event $ev delivers (rc)" 0 "$rc"
  done
  expect "all eight events were delivered" 8 "$(grep -c '^Subject:' "$STUB_SENT")"

  printf '\nself-test: %d passed, %d failed\n' "$pass" "$failed"
  if [[ "$failed" -gt 0 ]]; then
    return 1
  fi
  return 0
}

# --- main --------------------------------------------------------------------

main() {
  case "${1:-}" in
    --event-file)
      shift
      if [[ $# -lt 1 ]]; then usage; return 2; fi
      deliver_one "$1"
      ;;
    --drain)
      shift
      if [[ $# -lt 1 ]]; then usage; return 2; fi
      drain_dir "$1"
      ;;
    --check-repo) check_repo ;;
    --self-test)  self_test ;;
    --help|-h)    usage; return 0 ;;
    *)            usage; return 2 ;;
  esac
}

main "$@"
exit $?
