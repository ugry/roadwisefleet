#!/usr/bin/env bash
# RoadwiseFleet — production promotion: staging -> production, OWNER-GATED.
# Board task eila/tasks#31, scope item 5 ("promote only on the owner's explicit go").
#
# Installed at /usr/local/bin/roadwise-promote.sh. It is deliberately NOT wired
# to any timer and NOT triggered by CI: a human runs it in an agreed window,
# quoting the approval artifact.
#
# Usage:
#   roadwise-promote.sh --sha <sha> --approval <ref> [--web] [--dry-run]
#
#   --sha <sha>        the tested staging build to promote (must currently be the
#                      healthy staging release; promote-the-tested-build only)
#   --approval <ref>   REQUIRED. The recorded approval artifact, e.g.
#                      eila/requests#6 or eila/tasks#7. No ref, no promotion.
#   --web              also sync web/*.html to /var/www/roadwisefleet (the local
#                      equivalent of deploy.sh; static assets only)
#   --dry-run          print the plan and exit without changing anything
#
# Guarantees / guardrails:
#   * Refuses to run without an approval ref, and refuses a SHA that is not the
#     current healthy staging release (i.e. an untested build).
#   * Records the pre-promotion production SHA and reverts to it automatically if
#     the production health check fails.
#   * Never prints a credential: production settings are read from the existing
#     /opt/roadwisefleet/api/.env (0600, debian:debian) by the service, and this
#     script does not read it at all.
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed or run on any
# host. Read infra/deploy.md §6 (promotion + rollback) first.

set -euo pipefail

PROG="$(basename "$0")"

PROD_DIR="${RWF_PROD_DIR:-/opt/roadwisefleet/api}"
PROD_UNIT="${RWF_PROD_UNIT:-roadwise-api.service}"
PROD_PORT="${RWF_PROD_PORT:-8080}"
STAGING_PORT="${RWF_STAGING_PORT:-8081}"
WEB_ROOT="${RWF_WEB_ROOT:-/var/www/roadwisefleet}"
STATE_DIR="${RWF_STATE_DIR:-/var/lib/roadwisefleet}"
STATE_FILE="$STATE_DIR/deploy-state.json"
LOG_FILE="${RWF_LOG_FILE:-/var/log/roadwisefleet-deploy.log}"
HEALTH_TIMEOUT_S="${RWF_HEALTH_TIMEOUT_S:-60}"
NOTIFY_BIN="${RWF_NOTIFY_BIN:-/usr/local/bin/roadwise-notify.sh}"
GIT_REMOTE="${RWF_GIT_REMOTE:-https://github.com/ugry/roadwisefleet.git}"

sha=""
approval=""
sync_web=0
dry_run=0

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$PROG] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
}
die() { log "ERROR: $*"; exit 1; }

notify() { # notify <update|alert> <args...>; never fails the caller
  local kind="$1"; shift
  if [[ -x "$NOTIFY_BIN" ]]; then
    "$NOTIFY_BIN" "$kind" "$@" || log "WARN: notification NOT delivered (see infra/deploy.md §9 B3)"
  else
    log "WARN: $NOTIFY_BIN not installed — no notification sent"
  fi
}

state_get() {
  [[ -f "$STATE_FILE" ]] || return 0
  python3 - "$STATE_FILE" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
value = data.get(sys.argv[2])
if value is not None:
    print(str(value).lower() if isinstance(value, bool) else value)
PY
}

state_write() {
  python3 - "$STATE_FILE" "$@" <<'PY'
import datetime, json, os, sys
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except Exception:
        data = {}
for pair in sys.argv[2:]:
    key, _, value = pair.partition("=")
    if key:
        data[key] = value
data["updated_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
os.replace(tmp, path)
PY
}

wait_healthy() { # wait_healthy <port> <timeout_s>
  local port="$1" timeout="$2" waited=0
  while (( waited < timeout )); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/health"; then
      return 0
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  return 1
}

while (( $# )); do
  case "$1" in
    --sha)      sha="${2:-}"; shift 2 ;;
    --approval) approval="${2:-}"; shift 2 ;;
    --web)      sync_web=1; shift ;;
    --dry-run)  dry_run=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: $PROG --sha <sha> --approval <ref> [--web] [--dry-run]

  --sha <sha>        the tested staging build to promote (must be the current
                     healthy staging release)
  --approval <ref>   REQUIRED owner approval artifact (e.g. eila/requests#6)
  --web              also sync web/*.html to $WEB_ROOT
  --dry-run          print the plan and exit without changing anything
EOF
      exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

[[ -n "$sha" ]]      || die "--sha is required"
[[ -n "$approval" ]] || die "--approval <ref> is required: production promotion is owner-gated"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "--sha does not look like a git SHA: $sha"
[[ "$PROD_PORT" != "$STAGING_PORT" ]] || die "production and staging ports must differ"

staged_sha="$(state_get sha)"
staged_status="$(state_get status)"
if [[ "$staged_status" != "ready" || "$staged_sha" != "$sha" ]]; then
  die "refusing to promote: staging state is status=${staged_status:-unknown} sha=${staged_sha:-none}, not the requested ready build ${sha} (promote the tested build only)"
fi

mkdir -p "$STATE_DIR"
[[ -d "$PROD_DIR/.git" ]] || die "production checkout $PROD_DIR is not a git clone"
if [[ -n "$(git -C "$PROD_DIR" status --porcelain)" ]]; then
  die "production checkout $PROD_DIR has uncommitted changes — resolve them before promoting"
fi

prev_sha="$(git -C "$PROD_DIR" rev-parse HEAD)"
log "promotion plan: $prev_sha -> $sha (approval: $approval, web: $sync_web, dry-run: $dry_run)"
if (( dry_run )); then
  log "dry-run requested — nothing changed"
  exit 0
fi

log "fetching $GIT_REMOTE"
git -C "$PROD_DIR" fetch --quiet --prune origin || die "git fetch failed in the production checkout"

log "checking out $sha"
git -C "$PROD_DIR" checkout --force "$sha" || die "checkout of $sha failed"

log "installing dependencies"
( cd "$PROD_DIR" && pnpm install --frozen-lockfile ) || die "dependency install failed"

log "applying Prisma migrations (additive-only policy)"
( cd "$PROD_DIR" && pnpm --filter @roadwisefleet/api exec prisma migrate deploy ) || \
  die "prisma migrate deploy failed — production still runs $prev_sha in the previous process"

log "restarting $PROD_UNIT"
systemctl restart "$PROD_UNIT"

if ! wait_healthy "$PROD_PORT" "$HEALTH_TIMEOUT_S"; then
  log "production health check FAILED for $sha — rolling back to $prev_sha"
  git -C "$PROD_DIR" checkout --force "$prev_sha"
  ( cd "$PROD_DIR" && pnpm install --frozen-lockfile ) || log "WARN: install after rollback failed"
  systemctl restart "$PROD_UNIT"
  if wait_healthy "$PROD_PORT" "$HEALTH_TIMEOUT_S"; then
    state_write "prod_status=rolled_back" "prod_sha=$prev_sha" "prod_failed_sha=$sha"
    notify alert "PRODUCTION promotion of $sha FAILED health check; rolled back to $prev_sha. Live surface verified healthy again."
    exit 0
  fi
  state_write "prod_status=down" "prod_failed_sha=$sha"
  notify alert "PRODUCTION is DOWN: promotion of $sha failed and the rollback to $prev_sha is not healthy. Manual attention needed."
  exit 1
fi

if (( sync_web )); then
  log "syncing static web assets to $WEB_ROOT"
  install -m 0644 "$PROD_DIR"/web/*.html "$WEB_ROOT"/ || die "static asset sync failed"
fi

state_write "prod_status=live" "prod_sha=$sha" "prod_short_sha=${sha:0:7}" \
  "prod_previous_sha=$prev_sha" "prod_promoted_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "prod_approval=$approval"
log "production promoted to $sha (approval: $approval)"
notify update "$sha" "https://roadwisefleet.com/pilot/" "approval: $approval"
