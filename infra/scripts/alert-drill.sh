#!/usr/bin/env bash
# Alert round-trip drill for the EILA monitoring stack (board eila/tasks#10).
#
# WHY THIS EXISTS
#   Every check on https://status.elilaltd.com evaluates healthy and the alert
#   path has never been exercised: "simulated failure produces an alert" was the
#   one acceptance clause of eila/tasks#10 that no evidence covered. Proving it by
#   breaking production is not acceptable, so the failure is injected into a
#   DEDICATED CANARY instead — a two-line systemd unit that serves nothing but
#   `python3 -m http.server` on 127.0.0.1:8099 (infra/monitoring/alert-canary/).
#
#   Gatus polls the canary over TCP. This script stops it (the controlled
#   failure) and starts it again (the recovery). The alert therefore travels the
#   REAL chain: Gatus evaluation -> its configured alert provider (relay) ->
#   #eila-alerts + ugur@. No production unit, no nginx, no database is touched.
#
# WHERE IT RUNS
#   elilavps1, as root (Gatus + the relay live there). I do not hold that access:
#   the run is executed by the owner/orchestrator or the Team Leader and the
#   result is recorded on the task. Running it is a deliberate, visible state
#   change, so nothing happens without --apply.
#
# USAGE
#   --status             show the canary unit state and where to read the check
#   --fail               stop the canary  (controlled failure; needs --apply)
#   --recover            start the canary (recovery;          needs --apply)
#   --apply              actually change the state (default is a dry run)
#   --self-test          no-host/no-network/no-root assertions (CI)
#   --help               print this header
#
# SAFETY
#   * The only unit name this script will ever start/stop is
#     eila-alert-canary.service, matched exactly. UNIT may be overridden only to
#     prove that guard in --self-test; any other value is REFUSED with exit 3.
#   * No credential is read, printed or needed: the relay's token stays on the
#     host, and this script never talks to the relay directly.
#   * Exit codes: 0 ok, 1 systemctl failed, 2 dry run (nothing changed),
#     3 refused (wrong unit), 64 bad argument.
#
# EVIDENCE CONTRACT (what makes the acceptance met)
#   After --fail --apply: one alert in #eila-alerts:elilaltd.com AND one mail to
#   ugur@, naming "alert-drill canary" and the failing condition. After
#   --recover --apply: one recovery notice. Record on the board the drill nonce,
#   both timestamps, the message text and who confirmed delivery — never a token.

set -uo pipefail

CANARY_UNIT="eila-alert-canary.service"
CANARY_ADDR="127.0.0.1:8099"
STATUS_PAGE="https://status.elilaltd.com"
ALERT_ROOM="#eila-alerts:elilaltd.com"
ALERT_MAIL="ugur@elilaltd.com"
RECOVER_HINT="run --recover --apply, then expect ONE recovery notice"
UNIT="${UNIT:-$CANARY_UNIT}"

MODE="help"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --status)    MODE="status" ;;
    --fail)      MODE="fail" ;;
    --recover)   MODE="recover" ;;
    --apply)     APPLY=1 ;;
    --self-test) MODE="self-test" ;;
    --help|-h)   MODE="help" ;;
    *)
      printf 'unknown argument: %s (try --help)\n' "$arg" >&2
      exit 64
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

# The one-unit guard. A drill that can stop "whatever is in $UNIT" is a loaded
# gun: refuse anything that is not the canary, before any state is read.
guard_unit() {
  if [ "$UNIT" != "$CANARY_UNIT" ]; then
    err "REFUSED: this drill only ever starts/stops $CANARY_UNIT (got: $UNIT)."
    err "It must never touch a production unit. Use the relay's own test path for that."
    return 3
  fi
  return 0
}

nonce() { printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$RANDOM$RANDOM"; }

evidence() { # evidence <phase> <nonce>
  local phase="$1" n="$2"
  cat <<EOF

--- evidence to record on eila/tasks#10 (no secrets) ---
phase          : $phase
drill nonce    : $n
recorded at    : $(date -u +%Y-%m-%dT%H:%M:%SZ)
canary         : $CANARY_UNIT on $CANARY_ADDR
expect         : ONE alert in $ALERT_ROOM AND one mail to $ALERT_MAIL
                 (Gatus "alert-drill canary" check; failure threshold x interval
                 plus the relay's own delay — allow ~3 min)
read the check : $STATUS_PAGE  -> endpoint "alert-drill canary"
                 the top-level success field is NOT the verdict; read the LAST
                 result in that endpoint's results[]
then           : $RECOVER_HINT
Never paste the payload's transport details or any token. The nonce, both
timestamps, the delivered message text and who confirmed it are the evidence.
EOF
}

status_mode() {
  say "canary unit : $UNIT"
  systemctl status "$CANARY_UNIT" --no-pager 2>&1 | head -12
  say ""
  say "check       : $STATUS_PAGE  -> endpoint \"alert-drill canary\" ($CANARY_ADDR)"
  say "drill       : --fail --apply  (controlled failure), then --recover --apply"
}

change_mode() { # change_mode <start|stop> <phase>
  local verb="$1" phase="$2" n
  guard_unit || exit $?
  if [ "$APPLY" -ne 1 ]; then
    say "DRY RUN: would run 'systemctl $verb $CANARY_UNIT' — nothing changed."
    say "Re-run with --apply to inject ${phase} deliberately."
    exit 2
  fi
  # Precondition for the failure direction: a canary that is already stopped is
  # not a new failure, so it would prove nothing. Refuse rather than "pass".
  if [ "$verb" = "stop" ]; then
    if systemctl is-active --quiet "$CANARY_UNIT"; then
      say "canary is active (as expected for a failure drill)"
    else
      err "$CANARY_UNIT is not active: the check is already failing, so stopping"
      err "it again would prove nothing. Run --recover --apply first, wait for the"
      err "recovery notice, then re-run --fail --apply."
      exit 1
    fi
  fi
  n="$(nonce)"
  say "drill nonce : $n"
  if systemctl "$verb" "$CANARY_UNIT"; then
    say "systemctl $verb $CANARY_UNIT: ok"
  else
    err "systemctl $verb $CANARY_UNIT FAILED — the drill did NOT run."
    err "Fix the unit before treating any silence as evidence."
    exit 1
  fi
  evidence "$phase" "$n"
  exit 0
}

# ---------------------------------------------------------------------------
# self-test — run by CI (.github/workflows/ci.yml, job `infra-scripts`).
# No host, no network, no root, no Gatus. A stub `systemctl` records every call
# it receives, so the assertions read what the script ACTUALLY did rather than
# what it printed: a dry run changes nothing, --apply touches exactly the canary,
# a wrong UNIT is refused before any call, and a failing systemctl is loud.
# ---------------------------------------------------------------------------
self_test() {
  local tmp pass=0 fail=0 OUT RC SELF="$0"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/alert-drill-selftest.XXXXXX")" || return 2
  mkdir -p "$tmp/bin"
  STUB_LOG="$tmp/systemctl.log"
  : > "$STUB_LOG"

  cat > "$tmp/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
if [ "${STUB_INACTIVE:-0}" = "1" ] && [ "$1" = "is-active" ]; then
  exit 3
fi
if [ "${STUB_RC:-0}" -ne 0 ] && [ "$1" != "is-active" ]; then
  echo "stub: systemctl failed" >&2
  exit "${STUB_RC}"
fi
exit 0
STUB
  chmod +x "$tmp/bin/systemctl"

  check() { # check <label> <got> <want>
    if [ "$2" = "$3" ]; then
      printf 'PASS %s (%s)\n' "$1" "$2"; pass=$(( pass + 1 ))
    else
      printf 'FAIL %s: got "%s", want "%s"\n' "$1" "$2" "$3"; fail=$(( fail + 1 ))
    fi
  }
  has() { # has <label> <pattern>
    case "$OUT" in
      *"$2"*) printf 'PASS %s\n' "$1"; pass=$(( pass + 1 )) ;;
      *) printf 'FAIL %s: %s not in output\n' "$1" "$2"; fail=$(( fail + 1 )) ;;
    esac
  }
  capture() {
    OUT="$(env PATH="$tmp/bin:$PATH" STUB_LOG="$STUB_LOG" STUB_RC="${STUB_RC:-0}" \
      STUB_INACTIVE="${STUB_INACTIVE:-0}" bash "$SELF" "$@" 2>&1)"
    RC=$?
  }
  calls() { wc -l < "$STUB_LOG" | tr -d ' '; }

  # 1. Dry run: exit 2, and NOTHING was changed on the host.
  : > "$STUB_LOG"
  capture --fail
  check "dry run exit code" "$RC" "2"
  check "dry run leaves the host alone" "$(calls)" "0"
  has "dry run says nothing changed" "nothing changed"

  # 2. --apply stops exactly the canary, and says so.
  : > "$STUB_LOG"
  capture --fail --apply
  check "fail --apply exit code" "$RC" "0"
  check "fail --apply confirms the canary was active" \
    "$(grep -c '^is-active --quiet eila-alert-canary.service$' "$STUB_LOG")" "1"
  check "fail --apply stops one unit" "$(grep -c '^stop ' "$STUB_LOG")" "1"
  check "fail --apply stops the canary" "$(tail -n 1 "$STUB_LOG")" "stop $CANARY_UNIT"
  has "failure evidence names the alert room" "#eila-alerts:elilaltd.com"
  has "failure evidence names the mail recipient" "ugur@elilaltd.com"
  has "failure evidence names the check" "alert-drill canary"
  has "failure evidence carries a nonce" "drill nonce    : "
  has "failure evidence points at recovery" "--recover --apply"

  # 3. --recover starts the same unit (the recovery alert's trigger).
  : > "$STUB_LOG"
  capture --recover --apply
  check "recover --apply exit code" "$RC" "0"
  check "recover --apply starts the canary" "$(grep -c '^start ' "$STUB_LOG")" "1"
  check "recover --apply starts the canary (verb)" "$(tail -n 1 "$STUB_LOG")" "start $CANARY_UNIT"

  # 4. The one-unit guard fires BEFORE any call, for any other unit.
  : > "$STUB_LOG"
  UNIT="nginx.service" capture --fail --apply
  check "wrong unit is refused" "$RC" "3"
  check "wrong unit touches no unit at all" "$(calls)" "0"
  has "refusal names the canary" "$CANARY_UNIT"
  has "refusal calls out production" "never touch a production unit"

  # 5. A failing systemctl is a loud failure, never a silent "drill done".
  : > "$STUB_LOG"
  STUB_RC=1 capture --fail --apply
  check "failed state change exit code" "$RC" "1"
  has "failed state change is loud" "the drill did NOT run"

  # 5b. An already-stopped canary is refused: a second stop proves nothing.
  : > "$STUB_LOG"
  STUB_INACTIVE=1 capture --fail --apply
  check "already-failing canary exit code" "$RC" "1"
  check "already-failing canary is not stopped again" "$(grep -c '^stop ' "$STUB_LOG")" "0"
  has "already-failing canary points at recovery" "would prove nothing"

  # 6. --status reads, never writes.
  : > "$STUB_LOG"
  capture --status
  check "status exit code" "$RC" "0"
  check "status only reads" "$(cat "$STUB_LOG")" "status $CANARY_UNIT --no-pager"
  has "status names the status page" "$STATUS_PAGE"

  # 7. Unknown argument is rejected, not ignored.
  : > "$STUB_LOG"
  capture --nonsense
  check "unknown argument exit code" "$RC" "64"
  check "unknown argument changes nothing" "$(calls)" "0"

  rm -rf "$tmp"
  printf 'self-test: %d passed, %d failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "$MODE" in
  help)      head -n 42 "$0" | tail -n +2 ;;
  status)    guard_unit || exit $?; status_mode ;;
  fail)      change_mode stop "failure (canary stopped)" ;;
  recover)   change_mode start "recovery (canary started)" ;;
  self-test) self_test ;;
esac
