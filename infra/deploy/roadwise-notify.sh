#!/usr/bin/env bash
# RoadwiseFleet — deploy notifier: the "READY TO TEST" signal and the deploy
# failure alert. Board task eila/tasks#31.
#
# Installed at /usr/local/bin/roadwise-notify.sh. Called by
# roadwise-deploy.sh (and roadwise-promote.sh).
#
# Usage:
#   roadwise-notify.sh ready <sha> <url>     # staging is green -> "ready to test"
#   roadwise-notify.sh alert <message>       # deploy failed / rolled back
#
# Transport (first one that is configured wins):
#   1. Matrix  — RWF_MATRIX_HOMESERVER + RWF_MATRIX_ROOM_ID + RWF_MATRIX_ACCESS_TOKEN
#   2. Relay   — RWF_RELAY_URL (the orchestrator's alert relay, e.g.
#                http://127.0.0.1:9099/notify -> #eila-alerts)
#
# All settings come from a 0600 EnvironmentFile (default
# /etc/roadwisefleet/notify.env) that is sourced, never echoed. The access token
# is NEVER printed, logged, or passed on a command line that lands in a log.
# If nothing is configured the script prints a warning and exits 0 (a missing
# notification must not fail a deploy; the deploy state file is still written).
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.

set -euo pipefail

ENV_FILE="${RWF_NOTIFY_ENV:-/etc/roadwisefleet/notify.env}"

if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090  # 0600 root-owned EnvironmentFile, by design
  . "$ENV_FILE"
  set +a
fi

kind="${1:-}"
shift || true
if [[ "$kind" != "ready" && "$kind" != "alert" ]]; then
  echo "usage: $(basename "$0") ready <sha> <url> | alert <message>" >&2
  exit 2
fi

case "$kind" in
  ready)
    sha="${1:-unknown}"
    url="${2:-}"
    text="READY TO TEST — staging is green at ${sha}${url:+ ($url)}. Nothing to deploy: open the link and test that build."
    ;;
  alert)
    text="DEPLOY ALERT — ${*:-deploy failure}"
    ;;
esac

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
message="[roadwisefleet deploy] ${ts} :: ${text}"

send_matrix() {
  python3 - "$RWF_MATRIX_HOMESERVER" "$RWF_MATRIX_ROOM_ID" "$RWF_MATRIX_ACCESS_TOKEN" "$message" <<'PY'
import json, sys, urllib.parse, urllib.request, uuid
homeserver, room_id, token, message = sys.argv[1:5]
room = urllib.parse.quote(room_id, safe="")
url = "%s/_matrix/client/v3/rooms/%s/send/m.room.message/%s" % (
    homeserver.rstrip("/"), room, uuid.uuid4().hex)
body = json.dumps({"msgtype": "m.text", "body": message}).encode()
req = urllib.request.Request(url, data=body, method="PUT", headers={
    "Authorization": "Bearer %s" % token,
    "Content-Type": "application/json",
})
with urllib.request.urlopen(req, timeout=20) as resp:
    resp.read()
PY
}

send_relay() {
  python3 - "$RWF_RELAY_URL" "$message" <<'PY'
import json, sys, urllib.request
relay_url, message = sys.argv[1], sys.argv[2]
body = json.dumps({"text": message}).encode()
req = urllib.request.Request(relay_url, data=body, method="POST",
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=20) as resp:
    resp.read()
PY
}

if [[ -n "${RWF_MATRIX_HOMESERVER:-}" && -n "${RWF_MATRIX_ROOM_ID:-}" && -n "${RWF_MATRIX_ACCESS_TOKEN:-}" ]]; then
  if send_matrix; then
    echo "notified via Matrix"
    exit 0
  fi
  echo "WARN: Matrix notification failed" >&2
fi

if [[ -n "${RWF_RELAY_URL:-}" ]]; then
  if send_relay; then
    echo "notified via relay"
    exit 0
  fi
  echo "WARN: relay notification failed" >&2
fi

echo "WARN: no notifier configured (matrix or relay) — notification skipped"
exit 0
