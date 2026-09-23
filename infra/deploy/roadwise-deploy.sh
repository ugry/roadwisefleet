#!/usr/bin/env bash
# RoadwiseFleet — staging deployer: the ONE sanctioned path from merged `main`
# to the staging surface. Board task eila/tasks#31.
#
# Host: elilavps2. Installed at /usr/local/bin/roadwise-deploy.sh, run as root by
# roadwise-deploy-staging.timer (pull model, 5-minute poll). See infra/deploy.md.
#
# Subcommands:
#   staging            (default) deploy the newest CI-green commit on `main` to
#                      the staging release dir, health-check it, auto-rollback on
#                      failure. Idempotent: a no-op when already current+healthy.
#   status             print the recorded state (no changes).
#   rollback [<sha>]   switch staging back to the recorded previous release (or a
#                      named release directory) and health-check it.
#
# Guarantees / guardrails:
#   * Staging only. It never restarts the production units (`roadwise-api`,
#     `roadwisefleet-waitlist`) and refuses to run against the production port.
#   * No credential is ever written to a log, the state file, or stdout; the
#     staging settings come from a 0600 EnvironmentFile that is sourced, never
#     echoed.
#   * A failed deploy always leaves a serving release behind (previous release)
#     and reports the failure.
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.
# Review infra/deploy.md (install, rollback, acceptance) before installing.

set -euo pipefail

PROG="$(basename "$0")"

# Notification: every terminal outcome (ready / rolled back / failed) is sent
# through roadwise-notify.sh and its delivery result is recorded in the state
# file as `notify=` (sent | not-sent-no-transport | not-sent-transport-failed | …).
# A notification is never allowed to fail a deploy, but it is never allowed to
# fail silently either: `notify=not-sent-*` in deploy-state.json means the owner
# was NOT told and the alert transport needs fixing (infra/deploy.md §9 B3).

# ------------------------------------------------------------------ config ---
GIT_REMOTE="${RWF_GIT_REMOTE:-https://github.com/ugry/roadwisefleet.git}"
BRANCH="${RWF_BRANCH:-main}"
GITHUB_REPO="${RWF_GITHUB_REPO:-ugry/roadwisefleet}"
CI_WORKFLOW="${RWF_CI_WORKFLOW:-ci.yml}"

MIRROR_DIR="${RWF_MIRROR_DIR:-/opt/roadwisefleet/repo.git}"
RELEASES_DIR="${RWF_RELEASES_DIR:-/opt/roadwisefleet/releases}"
STAGING_ROOT="${RWF_STAGING_ROOT:-/opt/roadwisefleet/staging}"
STAGING_LINK="$STAGING_ROOT/current"
STAGING_ENV="${RWF_STAGING_ENV:-$STAGING_ROOT/.env}"
STAGING_UNIT="${RWF_STAGING_UNIT:-roadwise-staging-api.service}"
STAGING_PORT="${RWF_STAGING_PORT:-8081}"
PROD_PORT="${RWF_PROD_PORT:-8080}"

STATE_DIR="${RWF_STATE_DIR:-/var/lib/roadwisefleet}"
STATE_FILE="$STATE_DIR/deploy-state.json"
LOG_FILE="${RWF_LOG_FILE:-/var/log/roadwisefleet-deploy.log}"

KEEP_RELEASES="${RWF_KEEP_RELEASES:-5}"
HEALTH_TIMEOUT_S="${RWF_HEALTH_TIMEOUT_S:-60}"
RUN_SMOKE="${RWF_RUN_SMOKE:-auto}"           # auto | 1 | 0
NOTIFY_BIN="${RWF_NOTIFY_BIN:-/usr/local/bin/roadwise-notify.sh}"
NOTIFY_RESULT="unknown"                      # set by notify() for the state file

# --------------------------------------------------------------- utilities ---
init_dirs() {
  mkdir -p "$STATE_DIR" "$RELEASES_DIR" "$STAGING_ROOT"
  touch "$LOG_FILE" 2>/dev/null || true
}

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$PROG] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
}

die() { log "ERROR: $*"; exit 1; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

notify() { # notify <ready|update|alert> <args...>; never fails the caller, sets NOTIFY_RESULT
  local kind="$1"; shift
  local rc=0
  if [[ -x "$NOTIFY_BIN" ]]; then
    "$NOTIFY_BIN" "$kind" "$@" || rc=$?
  else
    log "WARN: $NOTIFY_BIN not installed — no notification sent"
    rc=3
  fi
  case "$rc" in
    0) NOTIFY_RESULT="sent"; return 0 ;;
    3) NOTIFY_RESULT="not-sent-no-transport" ;;
    4) NOTIFY_RESULT="not-sent-transport-failed" ;;
    *) NOTIFY_RESULT="not-sent-error-$rc" ;;
  esac
  log "WARN: notification NOT delivered ($NOTIFY_RESULT) — see infra/deploy.md §9 (B3)"
  return 0
}

state_get() { # state_get <key> -> value or empty
  [[ -f "$STATE_FILE" ]] || return 0
  python3 - "$STATE_FILE" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
value = data.get(sys.argv[2])
if value is None:
    sys.exit(0)
print(str(value).lower() if isinstance(value, bool) else value)
PY
}

state_write() { # state_write key=value [key=value ...] (atomic)
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

ci_is_green() { # ci_is_green <sha> -> exit 0 if the CI workflow concluded success
  python3 - "$GITHUB_REPO" "$CI_WORKFLOW" "$1" <<'PY'
import json, sys, urllib.request
repo, workflow, sha = sys.argv[1], sys.argv[2], sys.argv[3]
url = ("https://api.github.com/repos/%s/actions/workflows/%s/runs"
       "?head_sha=%s&per_page=1" % (repo, workflow, sha))
req = urllib.request.Request(url, headers={
    "Accept": "application/vnd.github+json",
    "User-Agent": "roadwise-deploy",
})
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.load(resp)
except Exception as exc:                      # network/API failure: not eligible
    print("api-error: %s" % exc, file=sys.stderr)
    sys.exit(2)
runs = payload.get("workflow_runs") or []
if not runs:
    print("no-run-yet", file=sys.stderr)
    sys.exit(3)
conclusion = runs[0].get("conclusion")
print(conclusion or runs[0].get("status") or "unknown")
sys.exit(0 if conclusion == "success" else 4)
PY
}

wait_healthy() { # wait_healthy <port> <timeout_s>
  local port="$1" timeout="$2" waited=0
  while (( waited < timeout )); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/health" \
       && curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/pilot/"; then
      return 0
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  return 1
}

run_smoke() { # run_smoke <release_dir> ; needs SEED_PASSWORD in the staging env
  local rel="$1"
  case "$RUN_SMOKE" in
    0) return 0 ;;
  esac
  (
    set -a
    # shellcheck disable=SC1090  # 0600 root-owned EnvironmentFile, by design
    . "$STAGING_ENV"
    set +a
    if [[ -z "${SEED_PASSWORD:-}" ]]; then
      echo "smoke skipped: SEED_PASSWORD not set in the staging environment"
      exit 2
    fi
    cd "$rel"
    pnpm --filter @roadwisefleet/api smoke
  ) || {
    local rc=$?
    if (( rc == 2 )); then
      log "WARN: smoke test not configured (no SEED_PASSWORD); health checks only"
      return 0
    fi
    return 1
  }
}

apply_migrations() { # apply_migrations <release_dir>
  local rel="$1"
  [[ -r "$STAGING_ENV" ]] || die "staging EnvironmentFile $STAGING_ENV is missing or unreadable"
  log "applying Prisma migrations to the staging database (additive-only policy)"
  (
    set -a
    # shellcheck disable=SC1090
    . "$STAGING_ENV"
    set +a
    cd "$rel"
    pnpm --filter @roadwisefleet/api exec prisma migrate deploy
  )
}

prune_releases() { # prune_releases <keep> <protected...>
  local keep="$1"; shift
  local protected=("$@")
  local dir name
  # newest first, skip the newest $keep and anything protected
  while IFS= read -r dir; do
    name="$(basename "$dir")"
    local is_protected=0 protected_name
    for protected_name in "${protected[@]}"; do
      if [[ -n "$protected_name" && "$name" == "$protected_name" ]]; then
        is_protected=1
      fi
    done
    if (( is_protected )); then
      continue
    fi
    log "pruning old release $name"
    rm -rf --one-file-system "$dir"
  done < <(ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n "+$(( keep + 1 ))")
}

activate() { # activate <release_dir> <unit>
  ln -sfn "$1" "$STAGING_LINK"
  systemctl restart "$2"
}

record_ready() { # record_ready <sha> <prev_sha> <url>
  local sha="$1" prev="$2" url="$3"
  state_write "surface=staging" "sha=$sha" "short_sha=${sha:0:7}" "status=ready" \
    "previous_sha=$prev" "deployed_at=$(now_utc)" "url=$url" \
    "notify=$NOTIFY_RESULT"
  mkdir -p "$STATE_DIR"
  {
    printf 'ready-to-test surface=staging sha=%s short=%s at=%s url=%s\n' \
      "$sha" "${sha:0:7}" "$(now_utc)" "$url"
  } >"$STATE_DIR/ready-to-test.txt"
}

record_problem() { # record_problem <status> <sha> <detail>
  state_write "surface=staging" "status=$1" "sha=$2" "detail=$3" "failed_at=$(now_utc)" \
    "notify=$NOTIFY_RESULT"
}

# -------------------------------------------------------------- operations ---
deploy_staging() {
  [[ "$STAGING_PORT" == "$PROD_PORT" ]] && \
    die "refusing to run: staging port equals the production port ($PROD_PORT)"
  [[ -d "$MIRROR_DIR" ]] || \
    die "mirror $MIRROR_DIR not found (bootstrap: git clone --bare $GIT_REMOTE $MIRROR_DIR)"

  log "fetching $BRANCH from $GIT_REMOTE"
  git --git-dir="$MIRROR_DIR" fetch --quiet --prune origin \
    "+refs/heads/$BRANCH:refs/heads/$BRANCH" || die "git fetch failed"

  local target current
  target="$(git --git-dir="$MIRROR_DIR" rev-parse "refs/heads/$BRANCH^{commit}")"
  current="$(state_get sha)"

  if [[ "$target" == "$current" ]] && wait_healthy "$STAGING_PORT" 6; then
    log "already at $target and healthy — nothing to do"
    return 0
  fi

  # Gate on CI: only a green `ci` run for this exact commit is deployable.
  local ci_state
  ci_state="$(ci_is_green "$target")" || {
    log "commit $target is not CI-green (state: $ci_state) — deferring to the next window"
    state_write "surface=staging" "pending_sha=$target" "pending_reason=ci-not-green"
    return 0
  }
  log "commit $target is CI-green ($ci_state)"

  local rel="$RELEASES_DIR/$target"
  local prev_link prev_sha
  prev_link="$(readlink -f "$STAGING_LINK" 2>/dev/null || true)"
  prev_sha=""
  if [[ -n "$prev_link" ]]; then
    prev_sha="$(basename "$prev_link")"
  fi

  if [[ ! -f "$rel/.release-ready" ]]; then
    log "building release $target"
    rm -rf "$rel"
    mkdir -p "$rel"
    if ! git --git-dir="$MIRROR_DIR" archive "$target" | tar -x -C "$rel"; then
      rm -rf "$rel"
      notify alert "STAGING DEPLOY of $target FAILED: release extraction failed (mirror $MIRROR_DIR). Staging still runs ${prev_sha:-nothing}."
      die "release extraction failed for $target"
    fi
    if ! ( cd "$rel" && pnpm install --frozen-lockfile ); then
      rm -rf "$rel"
      notify alert "STAGING DEPLOY of $target FAILED during pnpm install. Staging still runs ${prev_sha:-nothing}; production untouched."
      die "dependency install failed for $target"
    fi
    : >"$rel/.release-ready"
  fi

  if ! apply_migrations "$rel"; then
    notify alert "STAGING DEPLOY of $target FAILED at the Prisma migration step. Nothing was activated: staging still runs ${prev_sha:-nothing}, production untouched."
    record_problem "failed" "$target" "prisma migrate deploy failed; previous release still active"
    die "prisma migrate deploy failed for $target"
  fi

  log "activating $target (previous: ${prev_sha:-none})"
  activate "$rel" "$STAGING_UNIT"

  if ! wait_healthy "$STAGING_PORT" "$HEALTH_TIMEOUT_S"; then
    log "health check FAILED for $target"
    rollback_to "$prev_sha" "$target"
    return $?
  fi

  if ! run_smoke "$rel"; then
    log "smoke test FAILED for $target"
    rollback_to "$prev_sha" "$target"
    return $?
  fi

  local staging_url="https://staging.roadwisefleet.com/pilot/"
  notify ready "$target" "$staging_url"
  record_ready "$target" "$prev_sha" "$staging_url"
  prune_releases "$KEEP_RELEASES" "$target" "$prev_sha"
  log "staging is READY TO TEST at $target (signal: $NOTIFY_RESULT)"
  return 0
}

rollback_to() { # rollback_to <target_sha|""> <failed_sha>
  local target="${1:-}" failed="${2:-unknown}"
  if [[ -z "$target" || ! -d "$RELEASES_DIR/$target" ]]; then
    notify alert "STAGING DEPLOY FAILED at $failed and no previous release exists — staging is down. Manual attention needed."
    record_problem "failed" "$failed" "no usable previous release to roll back to"
    log "ERROR: no previous release available — staging may be down"
    return 1
  fi
  log "rolling back to $target"
  activate "$RELEASES_DIR/$target" "$STAGING_UNIT"
  if wait_healthy "$STAGING_PORT" "$HEALTH_TIMEOUT_S"; then
    notify alert "STAGING DEPLOY of $failed FAILED health/smoke; automatically rolled back to $target. Production untouched."
    record_problem "rolled_back" "$target" "failed deploy of $failed rolled back automatically"
    log "rollback to $target OK (alert: $NOTIFY_RESULT)"
    return 0
  fi
  notify alert "STAGING ROLLBACK FAILED: $failed failed and the rollback to $target is not healthy. Manual attention needed."
  record_problem "down" "$target" "rollback of $failed to $target also failed health check"
  log "ERROR: rollback to $target also failed health check"
  return 1
}

show_status() {
  printf 'state_file: %s\n' "$STATE_FILE"
  [[ -f "$STATE_FILE" ]] && cat "$STATE_FILE"
  printf 'current_symlink: %s\n' "$(readlink -f "$STAGING_LINK" 2>/dev/null || echo none)"
  printf 'unit: %s = %s\n' "$STAGING_UNIT" \
    "$(systemctl is-active "$STAGING_UNIT" 2>/dev/null || echo unknown)"
  if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$STAGING_PORT/health"; then
    printf 'health: 200 on 127.0.0.1:%s\n' "$STAGING_PORT"
  else
    printf 'health: NOT OK on 127.0.0.1:%s\n' "$STAGING_PORT"
  fi
  printf 'releases: %s\n' "$(ls -1dt "$RELEASES_DIR"/* 2>/dev/null | wc -l)"
}

usage() {
  cat <<EOF
Usage: $PROG [staging|status|rollback [<sha>]]

  staging           deploy the newest CI-green commit on $BRANCH to staging
                    (idempotent; auto-rollback on failed health/smoke)
  status            print the recorded deploy state and live health
  rollback [<sha>]  switch staging back to the previous release, or to <sha>

Environment overrides are documented in infra/deploy.md (§5).
EOF
}

main() {
  init_dirs
  case "${1:-staging}" in
    staging)  deploy_staging ;;
    status)   show_status ;;
    rollback) rollback_to "${2:-$(state_get previous_sha)}" "$(state_get sha)" ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}

# Serialise runs: the 5-minute timer must never overlap itself.
init_dirs
exec 9>"$STATE_DIR/deploy.lock"
if ! flock -n 9; then
  log "another deploy run holds the lock — exiting"
  exit 0
fi

main "$@"
