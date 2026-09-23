#!/usr/bin/env bash
# RoadwiseFleet pilot disk-headroom + uploads-directory check (board eila/tasks#46, F7b/F9d).
#
# Ready-to-apply artifact. NOT installed by CI — installing this on elilavps2 is a
# host change that needs owner approval + host access, like the rest of the
# infra/scripts set (see infra/uploads.md §6).
#
# Why: a full filesystem is the one failure that takes the API, Postgres and the
# document upload path down together, and nothing watched it. This check also
# enforces the "no upload is stored world-readable" rule continuously after the
# permission fix lands, so a regression is caught without a human looking.
#
# Behaviour
#   - filesystem used %% vs WARN_PCT / CRIT_PCT and a hard MIN_FREE_MB floor;
#   - reports uploads file count / total bytes every run (growth visibility);
#   - fails on any world-readable (o+r) file or directory under the uploads root;
#   - fails when the uploads directory is missing or not writable;
#   - alerts by mail with a cooldown so a persistent condition mails once per
#     ALERT_COOLDOWN_MIN, and mails a RECOVERY when it clears.
#   Exit: 0 green or warning, 1 critical.
#
# No credential values are used or printed.
#
# Install (on host, as root):
#   install -m 0755 pilot-disk-check.sh /usr/local/bin/pilot-disk-check.sh
#   install -m 0644 pilot-disk-check.service pilot-disk-check.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now pilot-disk-check.timer

set -uo pipefail

ALERT_MAIL="${ALERT_MAIL:-ugur@elilaltd.com}"
UPLOAD_DIR="${UPLOAD_DIR:-/opt/roadwisefleet/api/var/uploads}"
WARN_PCT="${WARN_PCT:-80}"
CRIT_PCT="${CRIT_PCT:-90}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
ALERT_COOLDOWN_MIN="${ALERT_COOLDOWN_MIN:-360}"
STATE_DIR="${STATE_DIR:-/var/lib/pilot-disk-check}"
STATE_FILE="$STATE_DIR/state"
LOG_TAG="pilot-disk-check"

mkdir -p "$STATE_DIR" 2>/dev/null || true

# sendmail lives in /usr/sbin, which is not always on a service PATH.
SENDMAIL="$(command -v sendmail || true)"
if [ -z "$SENDMAIL" ] && [ -x /usr/sbin/sendmail ]; then SENDMAIL=/usr/sbin/sendmail; fi
if [ -z "$SENDMAIL" ] && [ -x /usr/lib/sendmail ]; then SENDMAIL=/usr/lib/sendmail; fi

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; logger -t "$LOG_TAG" "$*" 2>/dev/null || true; }

mail_alert() {
  local subject="$1" body="$2"
  if [ -n "$SENDMAIL" ]; then
    {
      printf 'To: %s\n' "$ALERT_MAIL"
      printf 'Subject: %s\n' "$subject"
      printf 'From: pilot-disk-check@elilavps2\n'
      printf 'Content-Type: text/plain; charset=utf-8\n\n'
      printf '%s\n' "$body"
    } | "$SENDMAIL" -t
    log "alert mailed to $ALERT_MAIL: $subject"
  else
    log "WARN no sendmail found; alert not delivered: $subject"
  fi
}

# Failures are collected in files: probe helpers may be called from a subshell,
# where shell variables do not survive.
CRIT_FILE="$(mktemp "${TMPDIR:-/tmp}/pilot-disk-crit.XXXXXX")"
WARN_FILE="$(mktemp "${TMPDIR:-/tmp}/pilot-disk-warn.XXXXXX")"
trap 'rm -f "$CRIT_FILE" "$WARN_FILE"' EXIT
: > "$CRIT_FILE"
: > "$WARN_FILE"

log "disk check start (UPLOAD_DIR=$UPLOAD_DIR)"

# --- 1. the uploads directory: present, writable, not world-readable --------
PROBE_DIR="$UPLOAD_DIR"
if [ ! -d "$UPLOAD_DIR" ]; then
  printf 'uploads: %s does not exist — uploads cannot be stored\n' "$UPLOAD_DIR" >> "$CRIT_FILE"
  PROBE_DIR="/"
else
  if [ ! -w "$UPLOAD_DIR" ]; then
    printf 'uploads: %s is not writable by this account\n' "$UPLOAD_DIR" >> "$CRIT_FILE"
  fi

  FILE_COUNT="$(find "$UPLOAD_DIR" -type f 2>/dev/null | wc -l)"
  TOTAL_BYTES="$(find "$UPLOAD_DIR" -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')"
  DIR_MODE="$(stat -c '%a' "$UPLOAD_DIR" 2>/dev/null || echo '?')"
  case "$TOTAL_BYTES" in ''|*[!0-9]*) TOTAL_BYTES=0 ;; esac
  log "uploads: ${FILE_COUNT} file(s), ${TOTAL_BYTES} bytes, dir mode ${DIR_MODE}"

  WORLD_FILES="$(find "$UPLOAD_DIR" -type f -perm -o+r 2>/dev/null | wc -l)"
  if [ "$WORLD_FILES" -gt 0 ]; then
    printf 'uploads: %s file(s) are world-readable (o+r) under %s — POD documents must not be\n' \
      "$WORLD_FILES" "$UPLOAD_DIR" >> "$CRIT_FILE"
  fi
  WORLD_DIRS="$(find "$UPLOAD_DIR" -type d -perm -o+r 2>/dev/null | wc -l)"
  if [ "$WORLD_DIRS" -gt 0 ]; then
    printf 'uploads: %s director(y|ies) are world-traversable (o+r) under %s\n' \
      "$WORLD_DIRS" "$UPLOAD_DIR" >> "$WARN_FILE"
  fi
fi

# --- 2. filesystem headroom --------------------------------------------------
DF_LINE="$(df -P "$PROBE_DIR" 2>/dev/null | tail -n 1)"
AVAIL_KB="$(printf '%s\n' "$DF_LINE" | awk '{ print $4 }')"
USED_PCT="$(printf '%s\n' "$DF_LINE" | awk '{ print $5 }' | tr -d '%')"
MOUNT_POINT="$(printf '%s\n' "$DF_LINE" | awk '{ print $6 }')"
case "$AVAIL_KB" in ''|*[!0-9]*) AVAIL_KB=0 ;; esac
case "$USED_PCT" in ''|*[!0-9]*) USED_PCT=0 ;; esac
[ -n "$MOUNT_POINT" ] || MOUNT_POINT="?"
AVAIL_MB=$(( AVAIL_KB / 1024 ))

log "filesystem for ${PROBE_DIR}: mount=${MOUNT_POINT} used=${USED_PCT}% avail=${AVAIL_MB}MB (warn ${WARN_PCT}% crit ${CRIT_PCT}% floor ${MIN_FREE_MB}MB)"

if [ "$USED_PCT" -ge "$CRIT_PCT" ]; then
  printf 'disk: %s is %s%% full (critical threshold %s%%)\n' "$MOUNT_POINT" "$USED_PCT" "$CRIT_PCT" >> "$CRIT_FILE"
elif [ "$USED_PCT" -ge "$WARN_PCT" ]; then
  printf 'disk: %s is %s%% full (warning threshold %s%%)\n' "$MOUNT_POINT" "$USED_PCT" "$WARN_PCT" >> "$WARN_FILE"
fi
if [ "$AVAIL_MB" -lt "$MIN_FREE_MB" ]; then
  printf 'disk: only %sMB free on %s (hard floor %sMB)\n' "$AVAIL_MB" "$MOUNT_POINT" "$MIN_FREE_MB" >> "$CRIT_FILE"
fi

# --- 3. alert state machine (shared cooldown for warn + crit) ----------------
CRITICAL="$(cat "$CRIT_FILE")"
WARNING="$(cat "$WARN_FILE")"
NOW_EPOCH=$(date +%s)
PREV_STATE="ok"
[ -f "$STATE_FILE" ] && PREV_STATE=$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || echo ok)
LAST_ALERT=$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null || echo 0)
case "$LAST_ALERT" in ''|*[!0-9]*) LAST_ALERT=0 ;; esac

COOLDOWN_SECS=$(( ALERT_COOLDOWN_MIN * 60 ))
SUMMARY="uploads dir: ${UPLOAD_DIR}
filesystem: ${MOUNT_POINT} (${USED_PCT}% used, ${AVAIL_MB}MB free)
Runbook: infra/uploads.md §6 · thresholds T9/T10 in infra/monitoring/README.md"

if [ -n "$CRITICAL" ]; then
  if [ "$PREV_STATE" != "crit" ] || [ $(( NOW_EPOCH - LAST_ALERT )) -ge "$COOLDOWN_SECS" ]; then
    mail_alert "[ALERT] RoadwiseFleet pilot disk/uploads check failed" \
      "The pilot disk/uploads check is in a critical state at $(date -u +%Y-%m-%dT%H:%M:%SZ).

${CRITICAL}
${SUMMARY}"
    printf 'crit %s\n' "$NOW_EPOCH" > "$STATE_FILE"
  else
    printf 'crit %s\n' "$LAST_ALERT" > "$STATE_FILE"
  fi
  log "disk check end: CRITICAL"
  exit 1
fi

if [ -n "$WARNING" ]; then
  if [ "$PREV_STATE" = "ok" ] || [ $(( NOW_EPOCH - LAST_ALERT )) -ge "$COOLDOWN_SECS" ]; then
    mail_alert "[WARN] RoadwiseFleet pilot disk/uploads check: warning" \
      "The pilot disk/uploads check raised a warning at $(date -u +%Y-%m-%dT%H:%M:%SZ).

${WARNING}
${SUMMARY}"
    printf 'warn %s\n' "$NOW_EPOCH" > "$STATE_FILE"
  else
    printf 'warn %s\n' "$LAST_ALERT" > "$STATE_FILE"
  fi
  log "disk check end: WARNING"
  exit 0
fi

if [ "$PREV_STATE" != "ok" ]; then
  mail_alert "[RECOVERED] RoadwiseFleet pilot disk/uploads check passed" \
    "The pilot disk/uploads check is green again at $(date -u +%Y-%m-%dT%H:%M:%SZ).

${SUMMARY}"
fi
printf 'ok %s\n' "$NOW_EPOCH" > "$STATE_FILE"
log "disk check end: OK"
exit 0
