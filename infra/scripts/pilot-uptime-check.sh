#!/usr/bin/env bash
# RoadwiseFleet pilot uptime / blackbox check (task eila/tasks#10).
#
# Ready-to-apply artifact. NOT installed by CI — installation on elilavps2 is a
# host change that needs owner approval + host access (see infra/pilot-observability.md).
#
# What it does
#   Probes the pilot's public surface and the local API liveness endpoint.
#   On any failure it mails ALERT_MAIL (default: ugur@elilaltd.com) via the local
#   MTA, then stays quiet for ALERT_COOLDOWN_MIN minutes while the failure
#   persists. When everything is green again after a failure it mails RECOVERY.
#   Exit code is non-zero when the check fails, so the systemd unit shows failed.
#
# No credential values are used or printed. Public URLs only.
#
# Install (on host, as root):
#   install -m 0755 pilot-uptime-check.sh /usr/local/bin/pilot-uptime-check.sh
#   install -m 0644 pilot-uptime-check.service pilot-uptime-check.timer \
#       /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now pilot-uptime-check.timer

set -uo pipefail

ALERT_MAIL="${ALERT_MAIL:-ugur@elilaltd.com}"
STATE_DIR="${STATE_DIR:-/var/lib/pilot-uptime}"
STATE_FILE="$STATE_DIR/state"
LOG_TAG="pilot-uptime-check"
ALERT_COOLDOWN_MIN="${ALERT_COOLDOWN_MIN:-60}"   # re-alert interval while failing
HTTP_TIMEOUT="${HTTP_TIMEOUT:-15}"               # seconds per probe
PUBLIC_BASE="${PUBLIC_BASE:-https://roadwisefleet.com}"
API_HEALTH="${API_HEALTH:-http://127.0.0.1:8080/health}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

# sendmail lives in /usr/sbin, which is not always on a service PATH.
SENDMAIL="$(command -v sendmail || true)"
[ -n "$SENDMAIL" ] || { [ -x /usr/sbin/sendmail ] && SENDMAIL=/usr/sbin/sendmail; }
[ -n "$SENDMAIL" ] || { [ -x /usr/lib/sendmail ] && SENDMAIL=/usr/lib/sendmail; }

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; logger -t "$LOG_TAG" "$*" 2>/dev/null || true; }

# Failures are collected in a file: probe() may be called from a pipeline, and
# shell variables do not survive a subshell.
FAIL_FILE="$(mktemp "${TMPDIR:-/tmp}/pilot-uptime.XXXXXX")"
trap 'rm -f "$FAIL_FILE"' EXIT
: > "$FAIL_FILE"

# probe <url> <expected-code> <label> [extra-curl-arg...]
probe() {
  local url="$1" want="$2" label="$3"; shift 3
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$@" "$url" 2>/dev/null) || code="conn-err"
  if [ "$code" = "$want" ]; then
    printf 'OK   %-30s %s\n' "$label" "$code"
  else
    printf 'FAIL %-30s %s (want %s)\n' "$label" "$code" "$want"
    printf '%s: got %s, want %s (%s)\n' "$label" "$code" "$want" "$url" >> "$FAIL_FILE"
  fi
}

log "probe start"
probe "$PUBLIC_BASE/"              200 "site root"
probe "$PUBLIC_BASE/pilot/"        200 "pilot surface"
probe "$PUBLIC_BASE/api/trips"     401 "api auth gate (502=api down)"
probe "$PUBLIC_BASE/api/waitlist"  404 "legacy waitlist route"
probe "$API_HEALTH"                200 "api liveness (loopback)"

# noindex on /pilot/ is a security control (see infra/host-exposure.md)
if curl -sSI --max-time "$HTTP_TIMEOUT" "$PUBLIC_BASE/pilot/" 2>/dev/null \
     | tr -d '\r' | grep -qi '^x-robots-tag:.*noindex'; then
  printf 'OK   %-30s %s\n' "pilot noindex header" "present"
else
  printf 'FAIL %-30s %s\n' "pilot noindex header" "missing"
  printf 'pilot noindex header: missing (%s/pilot/)\n' "$PUBLIC_BASE" >> "$FAIL_FILE"
fi

FAILURES="$(cat "$FAIL_FILE")"

NOW_EPOCH=$(date +%s)
PREV_STATE="ok"
[ -f "$STATE_FILE" ] && PREV_STATE=$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || echo ok)
LAST_ALERT=$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null || echo 0)
case "$LAST_ALERT" in ''|*[!0-9]*) LAST_ALERT=0 ;; esac

mail_alert() {
  local subject="$1" body="$2"
  if [ -n "$SENDMAIL" ]; then
    {
      printf 'To: %s\n' "$ALERT_MAIL"
      printf 'Subject: %s\n' "$subject"
      printf 'From: pilot-uptime-check@elilavps2\n'
      printf 'Content-Type: text/plain; charset=utf-8\n\n'
      printf '%s\n' "$body"
    } | "$SENDMAIL" -t
    log "alert mailed to $ALERT_MAIL: $subject"
  else
    log "WARN no sendmail found; alert not delivered: $subject"
  fi
}

if [ -n "$FAILURES" ]; then
  COOLDOWN_SECS=$(( ALERT_COOLDOWN_MIN * 60 ))
  if [ "$PREV_STATE" != "fail" ] || [ $(( NOW_EPOCH - LAST_ALERT )) -ge "$COOLDOWN_SECS" ]; then
    mail_alert "[ALERT] RoadwiseFleet pilot check failed" \
      "The pilot uptime check failed at $(date -u +%Y-%m-%dT%H:%M:%SZ).

Failed probes:
${FAILURES}
Checks run: ${PUBLIC_BASE}/ , /pilot/ , /api/trips (expect 401) , /api/waitlist (expect 404) , ${API_HEALTH}
Note: /health is a liveness probe only (it returns 200 even if Postgres/Redis are down).
Runbook: infra/pilot-observability.md"
    printf 'fail %s\n' "$NOW_EPOCH" > "$STATE_FILE"
  else
    printf 'fail %s\n' "$LAST_ALERT" > "$STATE_FILE"
  fi
  log "probe end: FAILED"
  exit 1
fi

if [ "$PREV_STATE" = "fail" ]; then
  mail_alert "[RECOVERED] RoadwiseFleet pilot check passed" \
    "All pilot probes are green again at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
fi
printf 'ok %s\n' "$NOW_EPOCH" > "$STATE_FILE"
log "probe end: OK"
exit 0
