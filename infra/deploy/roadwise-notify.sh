#!/usr/bin/env bash
# RoadwiseFleet — deploy notifier: the "READY TO TEST" signal, the production
# promotion notice, and the deploy failure alert. Board task eila/tasks#31.
#
# Installed at /usr/local/bin/roadwise-notify.sh. Called by
# roadwise-deploy.sh (staging) and roadwise-promote.sh (production).
#
# Usage:
#   roadwise-notify.sh ready  <sha> <url>       # staging is green -> "READY TO TEST"
#   roadwise-notify.sh update <sha> <url> [<note>]  # production promoted (+ approval ref)
#   roadwise-notify.sh alert  <message...>      # deploy failed / rolled back
#
# Exit codes — the caller decides what to do; this must never fail a deploy:
#   0  delivered on the first transport that worked
#   2  usage error
#   3  NO transport configured — nothing was sent (the signal is MISSING)
#   4  a transport was configured, but every configured transport failed
#
# Transports (first configured transport that works wins):
#
#   1. Matrix — the PRIMARY transport. The homeserver (matrix.elilaltd.com) is
#      reachable from any host, including elilavps2 where the deployer runs.
#        RWF_MATRIX_HOMESERVER + RWF_MATRIX_ROOM_ID + RWF_MATRIX_ACCESS_TOKEN
#
#   2. Relay — OPTIONAL, and NOT usable from elilavps2 as deployed today: the
#      orchestrator's alert relay listens on 127.0.0.1:9099 of elilavps1
#      (loopback), so elilavps2 cannot reach it. RWF_RELAY_URL must therefore
#      point at a host that can really reach the relay, and must use one of the
#      relay's REGISTERED endpoints (/alert, /gatus, /grafana). The relay reads
#      the JSON key "message". An unregistered path (e.g. the old /notify, which
#      only worked through the relay's catch-all and delivered a raw JSON blob)
#      is refused here instead of being posted silently, and a reachable-looking
#      but broken transport is a loud failure (exit 4), never a silent skip.
#
# All settings come from a 0600 EnvironmentFile (default
# /etc/roadwisefleet/notify.env) that is sourced, never echoed. The access token
# is NEVER printed, logged, or passed on a command line that lands in a log.
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.

set -euo pipefail

ENV_FILE="${RWF_NOTIFY_ENV:-/etc/roadwisefleet/notify.env}"
RELAY_ENDPOINTS="/alert /gatus /grafana"

if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090  # 0600 root-owned EnvironmentFile, by design
  . "$ENV_FILE"
  set +a
fi

usage() {
  cat >&2 <<'EOF'
usage: roadwise-notify.sh ready  <sha> <url>
       roadwise-notify.sh update <sha> <url> [<note>]
       roadwise-notify.sh alert  <message...>
EOF
}

kind="${1:-}"
shift || true

sha=""
url=""
note=""
text=""

case "$kind" in
  ready|update)
    sha="${1:-}"
    url="${2:-}"
    note="${3:-}"
    if [[ -z "$sha" || -z "$url" ]]; then
      usage
      exit 2
    fi
    ;;
  alert)
    text="${*:-deploy failure}"
    ;;
  *)
    usage
    exit 2
    ;;
esac

case "$kind" in
  ready)
    text="READY TO TEST — staging is green at ${sha} (${url}). Nothing to deploy: open the link and test that build."
    ;;
  update)
    text="PRODUCTION UPDATED to ${sha} (${url}) — promoted after approval${note:+ (${note})} and verified healthy."
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
  # The relay's documented payload key is "message" (not "text").
  python3 - "$RWF_RELAY_URL" "$message" <<'PY'
import json, sys, urllib.request
relay_url, message = sys.argv[1], sys.argv[2]
body = json.dumps({"message": message}).encode()
req = urllib.request.Request(relay_url, data=body, method="POST",
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=20) as resp:
    resp.read()
PY
}

relay_path() { # relay_path <url> -> the path component, for endpoint validation
  python3 - "$1" <<'PY'
import sys, urllib.parse
print(urllib.parse.urlsplit(sys.argv[1]).path or "/")
PY
}

attempted=0

if [[ -n "${RWF_MATRIX_HOMESERVER:-}" && -n "${RWF_MATRIX_ROOM_ID:-}" && -n "${RWF_MATRIX_ACCESS_TOKEN:-}" ]]; then
  attempted=1
  if send_matrix; then
    echo "notified via Matrix"
    exit 0
  fi
  echo "WARN: Matrix notification failed" >&2
fi

if [[ -n "${RWF_RELAY_URL:-}" ]]; then
  attempted=1
  relay_ep="$(relay_path "$RWF_RELAY_URL" 2>/dev/null || echo /)"
  if [[ " $RELAY_ENDPOINTS " != *" $relay_ep "* ]]; then
    echo "WARN: RWF_RELAY_URL path '$relay_ep' is not a registered relay endpoint ($RELAY_ENDPOINTS) — not posted" >&2
  elif send_relay; then
    echo "notified via relay"
    exit 0
  else
    echo "WARN: relay notification failed — is the relay reachable from this host? (it is loopback-only on elilavps1)" >&2
  fi
fi

if (( attempted == 0 )); then
  echo "WARN: no notifier transport configured (Matrix or relay) — NOTHING was sent" >&2
  exit 3
fi

echo "ERROR: every configured transport failed — NOTHING was delivered" >&2
exit 4
