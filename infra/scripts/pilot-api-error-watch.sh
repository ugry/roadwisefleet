#!/usr/bin/env bash
# RoadwiseFleet pilot API error visibility — 5xx / upstream / liveness / latency
# watchdog (task eila/tasks#44, FAv1-F9d).
#
# READY-TO-APPLY ARTIFACT. NOT installed by CI. Installing it on elilavps2 is a
# host change that needs owner approval + host access (see infra/deploy.md §10,
# infra/monitoring/README.md §5).
#
# Why this exists (task #44): "a 5xx on the pilot API is invisible unless a human
# happens to hit it". This turns nginx's own log + the API unit state into one
# alert a human reads, on the ALREADY EXISTING alert path — `roadwise-notify.sh`
# (Matrix #eila-alerts + owner mail). It does NOT build a second monitoring stack:
# reachability stays with Gatus on elilavps1 (threshold T7), so this check never
# alerts on reachability alone.
#
# Signals (one alert per signal per cooldown; recovery is announced once):
#   api-up      the API unit is not active, or the loopback liveness probe fails,
#               or the unit restarted >= RESTART_BURST times in one interval
#   http-5xx    >= MIN_5XX_COUNT and >= MIN_5XX_RATIO_PCT of the requests in the
#               last WINDOW_SECS returned 5xx; the newest nginx error-log line is
#               included (upstream failures are named explicitly)
#   latency     the public pilot surface exceeded LATENCY_WARN_SECS on
#               CONSEC_LATENCY consecutive checks
#
# Flap control (threshold T8): api-up needs CONSEC_FAILS consecutive bad checks
# (a single `systemctl restart` is therefore not an alert); a restart is only
# reported as a loop at RESTART_BURST restarts per interval; a signal re-alerts
# at most every ALERT_COOLDOWN_MIN minutes; while the API is down the 5xx and
# latency signals are suppressed (their cause is the api-up alert, so an outage
# produces one actionable alert, not four).
#
# Exit codes: 0 = all signals green, 1 = at least one signal is bad (systemd
# shows the unit failed), 2 = usage error. `--self-test` is run by CI and needs
# no host, no network and no root.
#
# Privileges: reads /var/log/nginx/*.log (0640 root:adm on the host) and calls
# `systemctl show` — run it from its unit as root; it writes nothing outside its
# StateDirectory. No credential value is read, printed or needed.
#
# Install (on host, as root; part of the owner window — see infra/deploy.md §10):
#   install -m 0755 pilot-api-error-watch.sh /usr/local/bin/pilot-api-error-watch.sh
#   install -m 0644 pilot-api-error-watch.service pilot-api-error-watch.timer \
#       /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now pilot-api-error-watch.timer
#   sudo /usr/local/bin/pilot-api-error-watch.sh status        # inspect state
#
# Notifier prerequisite: /usr/local/bin/roadwise-notify.sh + a 0600
# /etc/roadwisefleet/notify.env (same transport the deployer uses). Without it
# this script logs "alert NOT delivered" loudly — it never pretends to page.

set -uo pipefail

MODE="${1:-run}"

# --- configuration (env-overridable; the unit sets the first four) ------------
STATE_DIR="${STATE_DIR:-/var/lib/pilot-api-watch}"
LOG_FILE="${LOG_FILE:-/var/log/nginx/access.log}"
ERROR_LOG="${ERROR_LOG:-/var/log/nginx/error.log}"
API_UNIT="${API_UNIT:-roadwise-api.service}"
API_HEALTH="${API_HEALTH:-http://127.0.0.1:8080/health}"
PUBLIC_BASE="${PUBLIC_BASE:-https://roadwisefleet.com}"
PUBLIC_PATH="${PUBLIC_PATH:-/pilot/}"
WINDOW_SECS="${WINDOW_SECS:-300}"
MIN_5XX_COUNT="${MIN_5XX_COUNT:-3}"
MIN_5XX_RATIO_PCT="${MIN_5XX_RATIO_PCT:-5}"
CONSEC_FAILS="${CONSEC_FAILS:-2}"
CONSEC_LATENCY="${CONSEC_LATENCY:-3}"
LATENCY_WARN_SECS="${LATENCY_WARN_SECS:-3}"
RESTART_BURST="${RESTART_BURST:-3}"
ALERT_COOLDOWN_MIN="${ALERT_COOLDOWN_MIN:-60}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-15}"
TAIL_LINES="${TAIL_LINES:-2000}"
NOTIFY_BIN="${RWF_NOTIFY_BIN:-/usr/local/bin/roadwise-notify.sh}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CURL_BIN:-curl}"
PROBE_HELPER="${PROBE_HELPER:-}"   # test injection: helper <url> -> "code time"
DRY_RUN="${DRY_RUN:-0}"            # 1 = evaluate fully, print instead of sending
COOLDOWN_SECS=$(( ALERT_COOLDOWN_MIN * 60 ))

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# ---------------------------------------------------------------------------
# state: one file per signal -> "<state> <last_alert_epoch> <consecutive>"
# ---------------------------------------------------------------------------
ST_STATE=ok; ST_ALERT=0; ST_CONSEC=0
state_read() {
  ST_STATE=ok; ST_ALERT=0; ST_CONSEC=0
  local f="$STATE_DIR/$1.state"
  [ -f "$f" ] || return 0
  read -r ST_STATE ST_ALERT ST_CONSEC < "$f" || true
  case "${ST_ALERT:-}" in ''|*[!0-9]*) ST_ALERT=0 ;; esac
  case "${ST_CONSEC:-}" in ''|*[!0-9]*) ST_CONSEC=0 ;; esac
  [ -n "${ST_STATE:-}" ] || ST_STATE=ok
}
state_write() { printf '%s %s %s\n' "$2" "$3" "$4" > "$STATE_DIR/$1.state"; }

send_alert() { # send_alert <key> <single-line text>
  local key="$1" text="$2"
  if [ "$DRY_RUN" = 1 ]; then
    printf 'NOTIFY %s %s\n' "$key" "$text"
    return 0
  fi
  log "ALERT[$key] $text"
  if [ ! -x "$NOTIFY_BIN" ]; then
    log "WARN notifier not found or not executable ($NOTIFY_BIN) — alert NOT delivered"
    return 0
  fi
  local rc=0
  "$NOTIFY_BIN" alert "$text" || rc=$?
  if [ "$rc" = 0 ]; then
    log "alert delivered via $NOTIFY_BIN"
  else
    log "WARN notifier exited $rc (3 = no transport configured, 4 = all transports failed) — alert NOT delivered"
  fi
}

handle() { # handle <key> <bad 0|1> <threshold> <alert text> <recovery text>
  local key="$1" bad="$2" thresh="$3" atext="$4" rtext="$5"
  local now n
  now="$(date +%s)"
  state_read "$key"
  if [ "$bad" = 1 ]; then
    n=$(( ST_CONSEC + 1 ))
    if [ "$n" -ge "$thresh" ]; then
      if [ "$ST_STATE" != failing ] || [ $(( now - ST_ALERT )) -ge "$COOLDOWN_SECS" ]; then
        send_alert "$key" "$atext"
        state_write "$key" failing "$now" "$n"
      else
        state_write "$key" failing "$ST_ALERT" "$n"
      fi
    else
      state_write "$key" "$ST_STATE" "$ST_ALERT" "$n"
    fi
    FAILED=1
  else
    if [ "$ST_STATE" = failing ]; then
      send_alert "$key" "$rtext"
    fi
    state_write "$key" ok "$now" 0
  fi
}

# ---------------------------------------------------------------------------
# probes
# ---------------------------------------------------------------------------
probe() { # probe <url> -> "<http_code> <time_total>"
  local url="$1" out
  if [ -n "$PROBE_HELPER" ]; then
    "$PROBE_HELPER" "$url"
    return 0
  fi
  out="$("$CURL_BIN" -sS -o /dev/null -w '%{http_code} %{time_total}' \
        --max-time "$HTTP_TIMEOUT" "$url" 2>/dev/null)" || out="conn-err 0"
  printf '%s\n' "$out"
}

unit_prop() { # unit_prop <property> -> value or empty (unsupported unit/systemd)
  "$SYSTEMCTL_BIN" show -p "$1" --value "$API_UNIT" 2>/dev/null | head -n 1
}

# ---------------------------------------------------------------------------
# nginx log parsing (reads stdin; cutoff "0" = no time filter)
# prints: "<lines_seen> <total_in_window> <5xx> <upstream_5xx> <newest_upstream_line>"
# ---------------------------------------------------------------------------
log_report() { # log_report <cutoff YYYYMMDDHHMMSS|0>
  awk -v cutoff="$1" '
    BEGIN { n=split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", M, " ")
            for (i=1;i<=n;i++) mon[M[i]]=i
            seen=0; total=0; five=0; up=0; last="" }
    {
      ts=""; ti=0
      for (i=1;i<=NF;i++) if (substr($i,1,1)=="[") { ts=$i; ti=i; break }
      if (ts=="") next
      seen++
      if (cutoff != "0") {
        gsub(/^\[/,"",ts)
        split(ts,p,":")
        split(p[1],d,"/")
        if (!(d[2] in mon)) next
        key=sprintf("%04d%02d%02d%02d%02d%02d", d[3]+0, mon[d[2]], d[1]+0, p[2]+0, p[3]+0, p[4]+0)
        if (key < cutoff) next
      }
      st=""
      for (i=1;i<=NF;i++) {
        if (substr($i,length($i),1)=="\"") {
          cand=$(i+1)
          if (cand ~ /^[0-9][0-9][0-9]$/) { st=cand; break }
        }
      }
      if (st=="") next
      total++
      if (st ~ /^5/) five++
      if (st=="502" || st=="503" || st=="504") { up++; last=$0 }
    }
    END { printf "%d %d %d %d %s\n", seen, total, five, up, last }'
}

newest_error_line() { # newest_error_line <cutoff> -> shortest newest error line
  awk -v cutoff="$1" '
    BEGIN { n=split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", M, " ")
            for (i=1;i<=n;i++) mon[M[i]]=i; last="" }
    {
      if ($1 !~ /^[0-9][0-9][0-9][0-9]\/[0-9][0-9]\/[0-9][0-9]$/) next
      if ($2 !~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/) next
      split($1,d,"/"); split($2,t,":")
      key=sprintf("%04d%02d%02d%02d%02d%02d", d[1]+0, d[2]+0, d[3]+0, t[1]+0, t[2]+0, t[3]+0)
      if (key < cutoff) next
      line=$0; gsub(/^[ \t]+/,"",line)
      if (length(line) > 200) line=substr(line,1,200)
      last=line
    }
    END { if (last != "") printf "%s\n", last }'
}

# ---------------------------------------------------------------------------
# self-test — run by CI (.github/workflows/ci.yml, job "infra-scripts")
# ---------------------------------------------------------------------------
self_test() {
  local tmp st_fail tests_pass=0 tests_fail=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pilot-api-watch-selftest.XXXXXX")" || return 2
  st_fail=0

  cat > "$tmp/probe" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${STUB_PROBE_REPLY:-200 0.10}"
STUB
  cat > "$tmp/systemctl" <<'STUB'
#!/usr/bin/env bash
prop=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) shift; prop="${1:-}" ;;
  esac
  shift
done
case "$prop" in
  NRestarts)   cat "${STUB_RESTARTS_FILE:-/dev/null}" 2>/dev/null || echo 0 ;;
  ActiveState) echo "${STUB_ACTIVESTATE:-active}" ;;
  *)           echo "" ;;
esac
STUB
  chmod +x "$tmp/probe" "$tmp/systemctl"

  # fixture log writer: make_log <file> <ok> <5xx> <upstream>
  # NOTE: the file is $1 and the counts are $2/$3/$4 (with set -u, read them with
  # a default). An earlier revision read the file from $2, so every call wrote to
  # a file literally named after the first count and never created access.log —
  # the watcher then saw an unreadable log and skipped the 5xx/latency signals,
  # which is why those assertions could not pass.
  make_log() {
    : > "$1"
    local ts i
    ts="$(date -u -d '-30 seconds' '+%d/%b/%Y:%H:%M:%S +0000')"
    for (( i=0; i<${2:-0}; i++ )); do
      printf '203.0.113.7 - - [%s] "GET /pilot/ HTTP/1.1" 200 512 "-" "curl/8"\n' "$ts" >> "$1"
    done
    for (( i=0; i<${3:-0}; i++ )); do
      printf '203.0.113.7 - - [%s] "POST /api/trips HTTP/1.1" 500 42 "-" "curl/8"\n' "$ts" >> "$1"
    done
    for (( i=0; i<${4:-0}; i++ )); do
      printf '203.0.113.7 - - [%s] "GET /api/trips HTTP/1.1" 502 0 "-" "curl/8"\n' "$ts" >> "$1"
    done
  }

  run_watch() { # run_watch <state-dir> <log-file>  -> stdout of a `run`
    STATE_DIR="$1" LOG_FILE="$2" ERROR_LOG="$tmp/error.log" \
      PROBE_HELPER="$tmp/probe" SYSTEMCTL_BIN="$tmp/systemctl" \
      DRY_RUN=1 RWF_NOTIFY_BIN=/nonexistent "${BASH_SOURCE[0]}" run 2>&1
  }
  count() { # count <output> <key>
    printf '%s\n' "$1" | grep -c "^NOTIFY $2 " || true
  }
  alert_payload() { # alert_payload <output> <key> -> only the sent NOTIFY lines
    # A bad check prints two lines carrying the same detail text: the NOTIFY
    # line (what the notifier sends) and the log line `http-5xx: BAD (…)`.
    # Assertions about the alert text must look at the payload that is actually
    # sent, otherwise a whole-output grep counts the log copy a second time.
    printf '%s\n' "$1" | grep "^NOTIFY $2 " || true
  }
  check() { # check <label> <got> <want>
    if [ "$2" = "$3" ]; then
      printf 'PASS %s (%s)\n' "$1" "$2"; tests_pass=$(( tests_pass + 1 ))
    else
      printf 'FAIL %s: got "%s", want "%s"\n' "$1" "$2" "$3"; tests_fail=$(( tests_fail + 1 )); st_fail=1
    fi
  }

  : > "$tmp/error.log"
  printf '%s [error] 123#0: *9 connect() failed (111: Connection refused) while connecting to upstream, client: 203.0.113.7, server: roadwisefleet.com, request: "GET /api/trips HTTP/1.1", upstream: "http://127.0.0.1:8080/api/trips"\n' \
    "$(date -u -d '-20 seconds' '+%Y/%m/%d %H:%M:%S')" >> "$tmp/error.log"

  # 1. healthy log + healthy probe -> no alerts
  make_log "$tmp/access.log" 20 0 0
  st="$tmp/s1"; mkdir -p "$st"
  out="$(run_watch "$st" "$tmp/access.log")"
  check "healthy: no 5xx alert" "$(count "$out" http-5xx)" "0"
  check "healthy: no api-up alert" "$(count "$out" api-up)" "0"
  check "healthy: no latency alert" "$(count "$out" latency)" "0"

  # 2. 5xx burst -> exactly ONE alert, and it does not repeat while it persists
  make_log "$tmp/access.log" 20 3 2
  st="$tmp/s2"; mkdir -p "$st"
  out1="$(run_watch "$st" "$tmp/access.log")"
  out2="$(run_watch "$st" "$tmp/access.log")"
  out3="$(run_watch "$st" "$tmp/access.log")"
  check "5xx burst: one alert" "$(count "$out1" http-5xx)" "1"
  check "5xx burst: deduplicated (run 2)" "$(count "$out2" http-5xx)" "0"
  check "5xx burst: deduplicated (run 3)" "$(count "$out3" http-5xx)" "0"
  check "5xx burst: alert names the upstream failure" \
    "$(alert_payload "$out1" http-5xx | grep -c 'upstream 502/503/504: 2' || true)" "1"
  check "5xx burst: alert carries the nginx error line" \
    "$(alert_payload "$out1" http-5xx | grep -c 'connect() failed' || true)" "1"

  # 3. below threshold -> no alert
  make_log "$tmp/access.log" 500 2 0
  st="$tmp/s3"; mkdir -p "$st"
  out="$(run_watch "$st" "$tmp/access.log")"
  check "below 5xx threshold: no alert (2 in 300 s, threshold 3)" "$(count "$out" http-5xx)" "0"

  # 4. recovery announced exactly once
  make_log "$tmp/access.log" 20 4 0
  st="$tmp/s4"; mkdir -p "$st"
  out="$(run_watch "$st" "$tmp/access.log")"
  check "recovery setup: alert fired" "$(count "$out" http-5xx)" "1"
  make_log "$tmp/access.log" 20 0 0
  outr1="$(run_watch "$st" "$tmp/access.log")"
  outr2="$(run_watch "$st" "$tmp/access.log")"
  check "recovery: announced once" "$(count "$outr1" http-5xx)" "1"
  check "recovery: not repeated" "$(count "$outr2" http-5xx)" "0"

  # 5. API down -> alert on the 2nd consecutive bad check, dedup after that
  st="$tmp/s5"; mkdir -p "$st"
  make_log "$tmp/access.log" 20 5 0
  out1="$(STUB_PROBE_REPLY='000 0' run_watch "$st" "$tmp/access.log")"
  out2="$(STUB_PROBE_REPLY='000 0' run_watch "$st" "$tmp/access.log")"
  out3="$(STUB_PROBE_REPLY='000 0' run_watch "$st" "$tmp/access.log")"
  check "api down: silent on 1st bad check (flap control)" "$(count "$out1" api-up)" "0"
  check "api down: alert on 2nd consecutive check" "$(count "$out2" api-up)" "1"
  check "api down: deduplicated" "$(count "$out3" api-up)" "0"
  # while the API is down the consequence signals stay quiet (one actionable alert
  # per outage, and no second alert for the same underlying cause)
  check "api down: 5xx signal suppressed" "$(count "$out2" http-5xx)" "0"
  check "api down: latency signal suppressed" "$(count "$out2" latency)" "0"
  # recovery
  make_log "$tmp/access.log" 20 0 0
  outr="$(run_watch "$st" "$tmp/access.log")"
  check "api up: recovery announced once" "$(count "$outr" api-up)" "1"

  # 6. restart loop: the first run is only a baseline, a single restart never
  #    alerts, and a burst alerts on the second consecutive bad check (the same
  #    CONSEC_FAILS flap control as liveness, so a restart of the API is not spam)
  st="$tmp/s6"; mkdir -p "$st"
  echo 100 > "$tmp/restarts"
  out1="$(STUB_RESTARTS_FILE="$tmp/restarts" run_watch "$st" "$tmp/access.log")"
  echo 101 > "$tmp/restarts"
  out2="$(STUB_RESTARTS_FILE="$tmp/restarts" run_watch "$st" "$tmp/access.log")"
  check "restart: baseline run does not alert" "$(count "$out1" api-up)" "0"
  check "restart: a single restart does not alert" "$(count "$out2" api-up)" "0"
  echo 105 > "$tmp/restarts"
  out3="$(STUB_RESTARTS_FILE="$tmp/restarts" run_watch "$st" "$tmp/access.log")"
  echo 110 > "$tmp/restarts"
  out4="$(STUB_RESTARTS_FILE="$tmp/restarts" run_watch "$st" "$tmp/access.log")"
  check "restart: burst silent on the first bad check (flap control)" "$(count "$out3" api-up)" "0"
  check "restart: burst of restarts alerts on the second bad check" "$(count "$out4" api-up)" "1"

  # 7. latency: needs CONSEC_LATENCY consecutive slow checks
  st="$tmp/s7"; mkdir -p "$st"
  out1="$(STUB_PROBE_REPLY='200 9.50' run_watch "$st" "$tmp/access.log")"
  out2="$(STUB_PROBE_REPLY='200 9.50' run_watch "$st" "$tmp/access.log")"
  out3="$(STUB_PROBE_REPLY='200 9.50' run_watch "$st" "$tmp/access.log")"
  check "latency: silent on check 1" "$(count "$out1" latency)" "0"
  check "latency: silent on check 2" "$(count "$out2" latency)" "0"
  check "latency: alerts on check 3" "$(count "$out3" latency)" "1"

  # 8. unreadable log is an alert, not silence
  st="$tmp/s8"; mkdir -p "$st"
  out="$(run_watch "$st" "$tmp/does-not-exist.log")"
  check "missing log: alerts once" "$(count "$out" log-unreadable)" "1"

  rm -rf "$tmp"
  printf 'self-test: %d passed, %d failed\n' "$tests_pass" "$tests_fail"
  [ "$st_fail" = 0 ] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
case "$MODE" in
  --self-test) self_test; exit $? ;;
  --help|-h)
    sed -n '2,45p' "${BASH_SOURCE[0]}"
    exit 0 ;;
  status)
    if [ ! -d "$STATE_DIR" ]; then
      log "no state yet at $STATE_DIR (the watch has never run here)"
      exit 0
    fi
    for f in "$STATE_DIR"/*.state; do
      [ -f "$f" ] || continue
      printf '%s: %s\n' "$(basename "$f" .state)" "$(cat "$f")"
    done
    exit 0 ;;
  run) ;;
  *) echo "usage: $0 [run|status|--self-test]" >&2; exit 2 ;;
esac

mkdir -p "$STATE_DIR" 2>/dev/null || { log "FATAL cannot create state dir $STATE_DIR"; exit 2; }
FAILED=0
NOW_EPOCH="$(date +%s)"
CUTOFF="$(date -u -d "@$(( NOW_EPOCH - WINDOW_SECS ))" +%Y%m%d%H%M%S 2>/dev/null)"
[ -n "$CUTOFF" ] || CUTOFF="$(date -u +%Y%m%d%H%M%S)"   # non-GNU date fallback
RUNBOOK="runbook: infra/monitoring/runbook.md (API error alerts)"

# --- api-up -----------------------------------------------------------------
health="$(probe "$API_HEALTH")"
hcode="${health%% *}"
htime="${health##* }"
active_state="$(unit_prop ActiveState)"
case "$active_state" in ''|unknown) active_state="unknown" ;; esac
restarts_now="$(unit_prop NRestarts)"
restart_delta=0
if [ -n "$restarts_now" ]; then
  case "$restarts_now" in *[!0-9]*) restarts_now="" ;; esac
fi
if [ -n "$restarts_now" ]; then
  # The first run after installation only records a baseline: NRestarts is
  # already non-zero on a long-running host and must not alert spuriously.
  if [ -f "$STATE_DIR/restarts.prev" ]; then
    prev_restarts="$(cat "$STATE_DIR/restarts.prev" 2>/dev/null || echo 0)"
    case "$prev_restarts" in ''|*[!0-9]*) prev_restarts=0 ;; esac
    if [ "$restarts_now" -ge "$prev_restarts" ]; then
      restart_delta=$(( restarts_now - prev_restarts ))
    fi
  else
    log "restart baseline: NRestarts=${restarts_now} (no delta on the first run)"
  fi
  printf '%s\n' "$restarts_now" > "$STATE_DIR/restarts.prev"
fi

api_bad=0; api_reason=""
add_reason() { # add_reason <text> — append to api_reason with "; " between parts
  if [ -z "$api_reason" ]; then
    api_reason="$1"
  else
    api_reason="${api_reason}; $1"
  fi
}
if [ "$hcode" != 200 ]; then
  api_bad=1; add_reason "loopback liveness ${API_HEALTH} returned ${hcode}"
fi
case "$active_state" in
  active|unknown) ;;
  *) api_bad=1; add_reason "${API_UNIT} ActiveState=${active_state}" ;;
esac
if [ "$restart_delta" -ge "$RESTART_BURST" ]; then
  api_bad=1; add_reason "${API_UNIT} restarted ${restart_delta}x since the previous check"
fi
if [ "$api_bad" = 1 ]; then
  handle api-up 1 "$CONSEC_FAILS" \
    "API UNHEALTHY: ${api_reason} (${CONSEC_FAILS} consecutive bad checks required; ActiveState=${active_state}). ${RUNBOOK}" \
    "RECOVERED: the pilot API is healthy again (loopback liveness ${hcode}, ${API_UNIT} ${active_state})."
  log "api-up: BAD (${api_reason})"
else
  handle api-up 0 "$CONSEC_FAILS" "" \
    "RECOVERED: the pilot API is healthy again (loopback liveness 200, ${API_UNIT} ${active_state})."
  log "api-up: ok (liveness ${hcode} in ${htime}s, ActiveState=${active_state}, restarts +${restart_delta})"
fi

# --- log-derived signals (suppressed while the API is down) ------------------
if [ "$api_bad" = 1 ]; then
  log "http-5xx/latency/log-unreadable evaluation suppressed while api-up is bad (same cause)"
else
  if [ ! -r "$LOG_FILE" ]; then
    handle log-unreadable 1 1 \
      "ALERT BLIND SPOT: cannot read ${LOG_FILE} — the 5xx/upstream check is NOT running (check the unit user and the log permissions). ${RUNBOOK}" \
      "RECOVERED: ${LOG_FILE} is readable again; the 5xx/upstream check is running."
    log "log-unreadable: BAD (${LOG_FILE})"
  else
    handle log-unreadable 0 1 "" \
      "RECOVERED: ${LOG_FILE} is readable again; the 5xx/upstream check is running."

    report="$(log_report "$CUTOFF" < "$LOG_FILE")"
    seen="${report%% *}"; rest="${report#* }"
    total="${rest%% *}"; rest="${rest#* }"
    five="${rest%% *}"; rest="${rest#* }"
    up="${rest%% *}"; newest_up="${rest#* }"

    # Guard against a custom log_format or a non-UTC log clock: if the timed
    # window matched nothing but the file has lines, fall back to the tail so a
    # real 5xx burst is never silently ignored. The skew is logged loudly.
    skew_note=""
    if [ "$total" = 0 ] && [ "$seen" != 0 ]; then
      skew_note=" [window fallback active]"
      report="$(tail -n "$TAIL_LINES" "$LOG_FILE" | log_report 0)"
      seen="${report%% *}"; rest="${report#* }"
      total="${rest%% *}"; rest="${rest#* }"
      five="${rest%% *}"; rest="${rest#* }"
      up="${rest%% *}"; newest_up="${rest#* }"
      log "WARN no line matched the last ${WINDOW_SECS}s window (custom log_format or a non-UTC log clock?) — falling back to the last ${TAIL_LINES} lines"
    fi

    ratio_pct=0
    if [ "$total" -gt 0 ]; then
      ratio_pct=$(( five * 100 / total ))
    fi

    err_line=""
    if [ -r "$ERROR_LOG" ]; then
      err_line="$(newest_error_line "$CUTOFF" < "$ERROR_LOG")"
    fi
    if [ -z "$err_line" ]; then
      err_line="(no nginx error-log line in the window)"
    fi

    five_bad=0
    if [ "$five" -ge "$MIN_5XX_COUNT" ] && [ "$ratio_pct" -ge "$MIN_5XX_RATIO_PCT" ]; then
      five_bad=1
    fi
    if [ "$up" -ge 1 ] && [ "$five" -ge "$MIN_5XX_COUNT" ]; then
      five_bad=1
    fi
    if [ "$up" -ge 3 ]; then
      five_bad=1
    fi

    detail="${five} of ${total} requests in the last ${WINDOW_SECS}s returned 5xx (${ratio_pct}%, thresholds ${MIN_5XX_COUNT} count / ${MIN_5XX_RATIO_PCT}%); upstream 502/503/504: ${up}; newest nginx error: ${err_line}${skew_note}"
    # `handle`'s 3rd argument is the number of CONSECUTIVE bad runs, not the 5xx
    # count: the threshold below already requires MIN_5XX_COUNT 5xx inside the
    # 5-minute window, so the breadth lives there. Passing MIN_5XX_COUNT here
    # would delay a first qualifying burst to the 3rd consecutive 2-minute check
    # (~6 min) and contradict the acceptance ("a forced 500 alerts exactly once").
    # Flap control for this signal is the per-signal ALERT_COOLDOWN_MIN, not runs.
    if [ "$five_bad" = 1 ]; then
      handle http-5xx 1 1 \
        "API 5xx RATE: ${detail}. ${RUNBOOK}" \
        "RECOVERED: API 5xx rate back to normal (${detail})."
      log "http-5xx: BAD (${detail})"
    else
      handle http-5xx 0 1 "" \
        "RECOVERED: API 5xx rate back to normal."
      log "http-5xx: ok (${five}/${total} in ${WINDOW_SECS}s, upstream ${up})"
      if [ -n "$newest_up" ]; then
        log "  newest upstream failure request: ${newest_up}"
      fi
    fi

    # latency on the public pilot surface (reachability itself is Gatus's job, T7)
    pub="$(probe "${PUBLIC_BASE}${PUBLIC_PATH}")"
    pcode="${pub%% *}"; ptime="${pub##* }"
    pslow=0
    if [ "$pcode" = 200 ]; then
      pslow="$(awk -v t="$ptime" -v w="$LATENCY_WARN_SECS" 'BEGIN { print (t+0 > w+0) ? 1 : 0 }')"
    else
      log "latency: skipped (public probe returned ${pcode}; reachability is Gatus's signal, T7)"
    fi
    if [ "$pslow" = 1 ]; then
      handle latency 1 "$CONSEC_LATENCY" \
        "API LATENCY: ${PUBLIC_BASE}${PUBLIC_PATH} took ${ptime}s (threshold ${LATENCY_WARN_SECS}s) on ${CONSEC_LATENCY} consecutive checks. ${RUNBOOK}" \
        "RECOVERED: ${PUBLIC_BASE}${PUBLIC_PATH} latency back under ${LATENCY_WARN_SECS}s (${ptime}s)."
      log "latency: BAD (${ptime}s)"
    else
      handle latency 0 "$CONSEC_LATENCY" "" \
        "RECOVERED: ${PUBLIC_BASE}${PUBLIC_PATH} latency back under ${LATENCY_WARN_SECS}s."
      if [ "$pcode" = 200 ]; then
        log "latency: ok (${ptime}s)"
      fi
    fi
  fi
fi

if [ "$FAILED" = 1 ]; then
  log "watch end: FAILED (see the alerts above)"
  exit 1
fi
log "watch end: OK"
exit 0
