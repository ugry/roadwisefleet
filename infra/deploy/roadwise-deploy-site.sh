#!/usr/bin/env bash
# RoadwiseFleet — single-environment deployer: merged `main` -> the live pilot.
#
# Board task eila/tasks#31, RE-SCOPED by the owner (board comment 406,
# 2026-09-23 ~19:48 UTC): there is NO staging environment. The live pilot IS the
# test environment. "merge to main -> deploy directly to the pilot."
#
# Host: elilavps2. Installed at /usr/local/bin/roadwise-deploy-site.sh, run as
# root by roadwise-deploy-site.timer (pull model, 5-minute poll).
# Runbook: infra/deploy.md §10.
#
# Subcommands:
#   deploy            (default) deploy the newest CI-green commit on `main` into
#                     the pilot checkout in place, migrate, restart, health-check;
#                     auto-rollback on any failed step. Idempotent: a SILENT
#                     no-op when the target is already deployed and healthy.
#   status            print the recorded state and live health (no changes).
#   rollback [<sha>]  revert the checkout to the recorded previous commit, or <sha>.
#   --self-test       run the no-host/no-network assertions CI runs (board #42);
#                     drives this same file in a fixture git repo with stubbed
#                     curl/systemctl/python3/pnpm/notify and asserts the
#                     acceptance-relevant decisions — a good deploy records the
#                     deployed SHA as ready, and a deliberately broken deploy
#                     rolls the checkout back and alerts exactly once
#   --help, help      print this usage
#
# Target (hard-coded defaults; overridable via the unit's Environment=):
#   repo checkout  /opt/roadwisefleet/api      (in place, NOT a release symlink)
#   unit           roadwise-api.service
#   origin         http://127.0.0.1:8080       (database: roadwisefleet)
#   public surface https://roadwisefleet.com/pilot/
#
# Design notes:
#   * Reuses the reviewed helpers (log / die / state / ci_is_green / wait_healthy /
#     notify) from the merged infra/deploy/roadwise-deploy.sh (PR #29) verbatim, so
#     the two deployers cannot drift. The staging-specific release-directory +
#     `current` symlink logic is deliberately NOT used: the pilot is updated in
#     place, so there is no symlink to repoint and no second unit/port/database.
#   * No credential is ever written to the log, the state file, or stdout. The app
#     EnvironmentFile (0600, debian:debian) is sourced, never echoed.
#
# READY-TO-APPLY ARTIFACT — reviewed in the repo, NOT installed on any host.
# Review infra/deploy.md §10 (install, rollback, acceptance) before installing.

set -euo pipefail

PROG="$(basename "$0")"

# --self-test is handled before any host interaction (see self_test() and the
# dispatch at the bottom): it must run before the flock is taken, because it
# spawns this same file as a child process, which takes the lock itself.
MODE="run"
for arg in "$@"; do
  case "$arg" in
    --self-test) MODE="self-test" ;;
    --help|-h)   MODE="help" ;;
    *) ;;
  esac
done

# ------------------------------------------------------------------ config ---
REMOTE="${RWF_SITE_REMOTE:-origin}"
BRANCH="${RWF_BRANCH:-main}"
GITHUB_REPO="${RWF_GITHUB_REPO:-ugry/roadwisefleet}"
CI_WORKFLOW="${RWF_CI_WORKFLOW:-ci.yml}"

SITE_DIR="${RWF_SITE_DIR:-/opt/roadwisefleet/api}"
SITE_ENV="${RWF_SITE_ENV:-$SITE_DIR/.env}"
SITE_UNIT="${RWF_SITE_UNIT:-roadwise-api.service}"
SITE_PORT="${RWF_SITE_PORT:-8080}"
SITE_URL="${RWF_SITE_URL:-https://roadwisefleet.com/pilot/}"

STATE_DIR="${RWF_STATE_DIR:-/var/lib/roadwisefleet}"
STATE_FILE="${RWF_SITE_STATE_FILE:-$STATE_DIR/deploy-site-state.json}"
LOG_FILE="${RWF_LOG_FILE:-/var/log/roadwisefleet-deploy.log}"

PNPM_BIN="${RWF_PNPM_BIN:-/usr/local/bin/pnpm}"
HEALTH_TIMEOUT_S="${RWF_HEALTH_TIMEOUT_S:-60}"
NOTIFY_BIN="${RWF_NOTIFY_BIN:-/usr/local/bin/roadwise-notify.sh}"
NOTIFY_RESULT="unknown"                      # set by notify() for the state file

# --------------------------------------------------------------- utilities ---
# Copied verbatim from the reviewed infra/deploy/roadwise-deploy.sh (PR #29) so
# both deployers share one implementation. Extract a shared library if they ever
# need to diverge; do not fork silently.

init_dirs() {
  mkdir -p "$STATE_DIR"
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

notify() { # notify <ready|alert> <args...>; never fails the caller, sets NOTIFY_RESULT
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
  log "WARN: notification NOT delivered ($NOTIFY_RESULT) — see infra/deploy.md §10"
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
    "User-Agent": "roadwise-deploy-site",
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

wait_healthy() { # wait_healthy <port> <timeout_s> -> /health AND /pilot/ both 200
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

git_site() { # git in the pilot checkout; safe.directory because the unit runs as root
  git -C "$SITE_DIR" -c safe.directory="$SITE_DIR" "$@"
}

apply_migrations() { # additive-only against the pilot database in $SITE_ENV
  log "applying Prisma migrations to the pilot database (additive-only policy)"
  (
    set -a
    # shellcheck disable=SC1090  # 0600 EnvironmentFile, by design
    . "$SITE_ENV"
    set +a
    cd "$SITE_DIR"
    "$PNPM_BIN" --filter @roadwisefleet/api exec prisma migrate deploy
  )
}

record_ready() { # record_ready <sha> <previous_sha>
  local sha="$1" prev="$2"
  state_write "surface=site" "sha=$sha" "short_sha=${sha:0:7}" "previous_sha=$prev" \
    "status=ready" "deployed_at=$(now_utc)" "url=$SITE_URL" "notify=$NOTIFY_RESULT"
}

record_problem() { # record_problem <status> <live_sha> <failed_sha> <detail>
  local status="$1" live="$2" failed="$3" detail="$4"
  state_write "surface=site" "status=$status" "sha=$live" "short_sha=${live:0:7}" \
    "previous_sha=$failed" "failed_sha=$failed" "detail=$detail" \
    "failed_at=$(now_utc)" "url=$SITE_URL" "notify=$NOTIFY_RESULT"
}

# -------------------------------------------------------------- operations ---
deploy_site() {
  [[ -d "$SITE_DIR/.git" ]] || die "pilot checkout $SITE_DIR is not a git clone"
  [[ -r "$SITE_ENV" ]] || die "pilot EnvironmentFile $SITE_ENV is missing or unreadable"

  git_site fetch --quiet --prune "$REMOTE" || die "git fetch failed in $SITE_DIR"

  local target current
  target="$(git_site rev-parse "refs/remotes/$REMOTE/$BRANCH^{commit}")" \
    || die "cannot resolve refs/remotes/$REMOTE/$BRANCH"
  current="$(state_get sha)"

  # Idempotent no-op: the target is already deployed and the pilot answers on
  # both /health and /pilot/. Silent by design — the timer runs every 5 minutes.
  if [[ "$target" == "$current" ]] && wait_healthy "$SITE_PORT" 6; then
    exit 0
  fi

  # CI-green gate: only a commit whose ci.yml run concluded success is deployable.
  local ci_state
  if ! ci_state="$(ci_is_green "$target")"; then
    log "commit $target is not CI-green (state: ${ci_state:-unknown}) — deferring to the next window"
    state_write "surface=site" "status=pending" "pending_sha=$target" "pending_reason=ci-not-green"
    return 0
  fi

  local prev_sha
  prev_sha="$(git_site rev-parse HEAD)" || die "cannot read HEAD of $SITE_DIR"

  local dirty
  dirty="$(git_site status --porcelain | wc -l)"
  if (( dirty > 0 )); then
    log "WARN: $SITE_DIR has $dirty local change(s); checkout --force will discard them"
  fi

  log "deploying $target into $SITE_DIR (previous: $prev_sha, CI: $ci_state)"
  if ! git_site checkout --force "$target"; then
    notify alert "SITE DEPLOY of $target FAILED at checkout; the pilot is still running $prev_sha."
    record_problem "failed" "$prev_sha" "$target" "checkout failed; previous commit still checked out"
    return 1
  fi

  log "installing dependencies (CI=true $PNPM_BIN install --frozen-lockfile)"
  if ! ( cd "$SITE_DIR" && CI=true "$PNPM_BIN" install --frozen-lockfile ); then
    log "dependency install FAILED for $target"
    rollback_to "$prev_sha" "$target" "pnpm install failed"
    return $?
  fi

  if ! apply_migrations; then
    log "prisma migrate deploy FAILED for $target"
    rollback_to "$prev_sha" "$target" "prisma migrate deploy failed"
    return $?
  fi

  log "restarting $SITE_UNIT"
  if ! systemctl restart "$SITE_UNIT"; then
    log "WARN: systemctl restart $SITE_UNIT returned non-zero"
  fi

  if ! wait_healthy "$SITE_PORT" "$HEALTH_TIMEOUT_S"; then
    log "health check FAILED for $target"
    rollback_to "$prev_sha" "$target" "health check failed (/health or /pilot/)"
    return $?
  fi

  notify ready "$target" "$SITE_URL"
  record_ready "$target" "$prev_sha"
  log "pilot is READY TO TEST at $target (notify: $NOTIFY_RESULT)"
  return 0
}

rollback_to() { # rollback_to <target_sha> <failed_sha> <reason>
  local target="$1" failed="$2" reason="$3"

  if [[ -z "$target" ]]; then
    notify alert "SITE DEPLOY of $failed FAILED ($reason) and there is no previous commit to roll back to. The pilot needs manual attention."
    record_problem "down" "$failed" "$failed" "$reason; no previous commit recorded"
    log "ERROR: no rollback target available"
    return 1
  fi

  log "rolling $SITE_DIR back to $target ($reason)"
  if ! git_site checkout --force "$target"; then
    notify alert "SITE ROLLBACK FAILED: deploy of $failed failed ($reason) and the checkout of $target failed. The pilot needs manual attention."
    record_problem "down" "$failed" "$failed" "$reason; rollback checkout to $target failed"
    return 1
  fi

  if ! ( cd "$SITE_DIR" && CI=true "$PNPM_BIN" install --frozen-lockfile ); then
    log "WARN: dependency install after rollback failed"
  fi

  if ! systemctl restart "$SITE_UNIT"; then
    log "WARN: systemctl restart $SITE_UNIT returned non-zero"
  fi

  if wait_healthy "$SITE_PORT" "$HEALTH_TIMEOUT_S"; then
    notify alert "SITE DEPLOY of $failed FAILED ($reason); rolled back to $target and the pilot is healthy again."
    record_problem "rolled_back" "$target" "$failed" "$reason"
    log "rollback to $target OK (notify: $NOTIFY_RESULT)"
    return 0
  fi

  notify alert "SITE DOWN: deploy of $failed FAILED ($reason) and the rollback to $target is not healthy. Manual attention needed."
  record_problem "down" "$target" "$failed" "$reason; rollback health check failed"
  log "ERROR: rollback to $target also failed health check"
  return 1
}

do_rollback() { # do_rollback [<sha>]
  local target="${1:-}"
  local live
  live="$(state_get sha)"
  if [[ -z "$target" ]]; then
    target="$(state_get previous_sha)"
  fi
  [[ -n "$target" ]] || die "no rollback target recorded in $STATE_FILE and none given"
  log "manual rollback requested: ${live:-unknown} -> $target"
  rollback_to "$target" "${live:-unknown}" "manual rollback"
}

show_status() {
  printf 'state_file: %s\n' "$STATE_FILE"
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  fi
  printf 'checkout: %s @ %s\n' "$SITE_DIR" "$(git_site rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'unit: %s = %s\n' "$SITE_UNIT" "$(systemctl is-active "$SITE_UNIT" 2>/dev/null || echo unknown)"
  if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$SITE_PORT/health"; then
    printf 'health: 200 on 127.0.0.1:%s\n' "$SITE_PORT"
  else
    printf 'health: NOT OK on 127.0.0.1:%s\n' "$SITE_PORT"
  fi
}

# ---------------------------------------------------------------------------
# self-test — run by CI (.github/workflows/ci.yml, job `deploy-site-selftest`).
# Board #42's acceptance is: "a deliberately broken deploy rolls back
# automatically and reports it; a good deploy reports success with the commit
# SHA". The deployer only ever runs on the host as root, so before this nothing
# machine-checked that behaviour — CI only ran shellcheck over the file.
#
# This drives THIS file in a fixture git repo (a real local bare `origin` plus a
# working checkout, so no network is needed) with:
#   * stubbed `curl` (health), `systemctl` (restart), `pnpm`,
#     `roadwise-notify.sh`, and a `python3` that intercepts ONLY the ci.yml gate
#     (sentinel repo name) and delegates every other call to the real one;
# and asserts on the state file / notifications the run actually produced.
# No host, no network, no root. `set +e` so a failed step reports rather than
# aborting the harness.
# ---------------------------------------------------------------------------
self_test() {
  set +e
  local tmp tests_pass=0 tests_fail=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/deploy-site-selftest.XXXXXX")" || return 2
  local SELF OUT RC MAIL="$tmp/notify.log" BIN="$tmp/bin"
  local HEALTH_FAIL_CALLS=0 PNPM_FAIL="" CI_FAIL=0
  local SRC="$tmp/src" ORIGIN="$tmp/origin.git" SITE="$tmp/site"
  local PREV TARGET
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  check() { # check <label> <got> <want>
    if [ "$2" = "$3" ]; then
      printf 'PASS %s (%s)\n' "$1" "$2"; tests_pass=$(( tests_pass + 1 ))
    else
      printf 'FAIL %s: got "%s", want "%s"\n' "$1" "$2" "$3"; tests_fail=$(( tests_fail + 1 ))
    fi
  }
  capture() { # capture <cmd...> — sets OUT (stdout+stderr) and RC
    set +e
    OUT="$("$@" 2>&1)"
    RC=$?
    set +e
  }

  # --- fixture git: a real bare `origin` and the pilot checkout --------------
  mkdir -p "$SRC" "$BIN"
  git -C "$SRC" init -q -b main
  git -C "$SRC" config user.email selftest@example.invalid
  git -C "$SRC" config user.name "deploy-site self-test"
  printf '.env\n' > "$SRC/.gitignore"
  printf 'v1\n' > "$SRC/app.txt"
  git -C "$SRC" add .gitignore app.txt
  git -C "$SRC" commit -q -m v1
  git clone -q --bare "$SRC" "$ORIGIN"
  git clone -q "$ORIGIN" "$SITE"
  printf 'DATABASE_URL="postgres://fixture@127.0.0.1:5432/roadwisefleet_selftest"\n' > "$SITE/.env"
  printf 'v2\n' > "$SRC/app.txt"
  git -C "$SRC" commit -q -am v2
  git -C "$SRC" push -q "$ORIGIN" main
  PREV="$(git -C "$SITE" rev-parse HEAD)"
  TARGET="$(git -C "$SRC" rev-parse HEAD)"

  # --- stubs ----------------------------------------------------------------
  # curl: health probe. Fails its first $HEALTH_FAIL_CALLS calls, then answers OK.
  cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
n=0
if [ -f "${HEALTH_COUNT:?}" ]; then n="$(cat "$HEALTH_COUNT")"; fi
n=$(( n + 1 ))
printf '%s\n' "$n" > "$HEALTH_COUNT"
if [ "$n" -le "${HEALTH_FAIL_CALLS:-0}" ]; then exit 22; fi
exit 0
STUB
  # systemctl: restart/is-active always succeed.
  cat > "$BIN/systemctl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # roadwise-notify.sh: record the kind + arguments of every call.
  cat > "$BIN/roadwise-notify.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${NOTIFY_LOG:?}"
exit 0
STUB
  # pnpm: succeed like a real install, except when the fixture asks it to fail.
  cat > "$BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
if [ -n "${PNPM_FAIL:-}" ] && [ -s "${PNPM_FAIL}" ]; then
  echo "fixture: dependency install failed" >&2
  exit 1
fi
exit 0
STUB
  # python3: intercept ONLY the ci.yml gate (sentinel repo anywhere in argv —
  # the deployer calls `python3 - <repo> <workflow> <sha>`), delegate otherwise.
  local REAL_PY
  REAL_PY="$(command -v python3)"
  cat > "$BIN/python3" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "selftest/repo" ]; then
    if [ "\${CI_FAIL:-0}" = "1" ]; then exit 4; fi
    exit 0
  fi
done
exec "$REAL_PY" "\$@"
STUB
  chmod +x "$BIN/curl" "$BIN/systemctl" "$BIN/roadwise-notify.sh" "$BIN/pnpm" "$BIN/python3"

  # --- helpers --------------------------------------------------------------
  state() { # state <key> — a field of the deployer's JSON state file
    [ -f "$tmp/state/deploy-site-state.json" ] || return 0
    python3 - "$tmp/state/deploy-site-state.json" "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
value = data.get(sys.argv[2])
if value is not None:
    print(value)
PY
  }
  notified() { # notified <pattern> — occurrences in what the notifier was told
    if [ -f "$MAIL" ]; then grep -c -- "$1" "$MAIL" || true; else echo 0; fi
  }
  site_sha() { git -C "$SITE" rev-parse HEAD; }
  run_deploy() { # drive the real deployer against the fixtures
    capture env \
      RWF_SITE_DIR="$SITE" \
      RWF_SITE_UNIT="roadwise-api.service" \
      RWF_SITE_PORT="18080" \
      RWF_SITE_URL="https://selftest.invalid/pilot/" \
      RWF_STATE_DIR="$tmp/state" \
      RWF_SITE_STATE_FILE="$tmp/state/deploy-site-state.json" \
      RWF_LOG_FILE="$tmp/deploy.log" \
      RWF_GITHUB_REPO="selftest/repo" \
      RWF_PNPM_BIN="$BIN/pnpm" \
      RWF_NOTIFY_BIN="$BIN/roadwise-notify.sh" \
      RWF_HEALTH_TIMEOUT_S="2" \
      PATH="$BIN:$PATH" \
      HEALTH_COUNT="$tmp/health.count" \
      HEALTH_FAIL_CALLS="$HEALTH_FAIL_CALLS" \
      NOTIFY_LOG="$MAIL" \
      PNPM_FAIL="$PNPM_FAIL" \
      CI_FAIL="$CI_FAIL" \
      bash "$SELF" deploy
  }
  reset_fixture() { # pre-deploy state: checkout on main @ PREV, no state/no mail
    git -C "$SITE" checkout -q -B main "$PREV"
    rm -rf "$tmp/state"
    rm -f "$tmp/health.count" "$MAIL"
  }

  # --- 1. a good deploy records the deployed SHA and notifies once ----------
  reset_fixture; HEALTH_FAIL_CALLS=0; PNPM_FAIL=""; CI_FAIL=0
  run_deploy
  check "a good deploy exits 0" "$RC" "0"
  check "the state records the deployed target commit" "$(state sha)" "$TARGET"
  check "the state records status=ready" "$(state status)" "ready"
  check "the state records the previous commit for rollback" "$(state previous_sha)" "$PREV"
  check "the checkout is on the deployed commit" "$(site_sha)" "$TARGET"
  check "exactly one 'ready' notification is sent" "$(notified '^ready ')" "1"
  check "no alert is sent for a good deploy" "$(notified '^alert ')" "0"
  check "the run reports READY TO TEST with the deployed SHA" \
    "$(printf '%s\n' "$OUT" | grep -c "READY TO TEST at $TARGET" || true)" "1"

  # --- 2. idempotent: the target already deployed and healthy is a no-op -----
  rm -f "$tmp/health.count" "$MAIL"; HEALTH_FAIL_CALLS=0
  run_deploy
  check "an already-deployed healthy target is a silent no-op (exit 0)" "$RC" "0"
  check "the no-op sends no new ready notification" "$(notified '^ready ')" "0"
  check "the no-op leaves the recorded state unchanged" "$(state sha)" "$TARGET"

  # --- 3. ACCEPTANCE: a deliberately broken deploy rolls back and reports it -
  reset_fixture; HEALTH_FAIL_CALLS=0; CI_FAIL=0
  PNPM_FAIL="$tmp/pnpm-fail"; : > "$PNPM_FAIL"
  run_deploy
  check "a broken deploy rolls the checkout back to the previous commit" "$(site_sha)" "$PREV"
  check "the state records status=rolled_back" "$(state status)" "rolled_back"
  check "the state names the failed commit" "$(state failed_sha)" "$TARGET"
  check "the state records the live (rolled-back) commit" "$(state sha)" "$PREV"
  check "exactly one failure alert is sent" "$(notified '^alert ')" "1"
  check "the alert names the failure reason" "$(notified 'pnpm install failed')" "1"
  check "the alert names the failed commit" "$(notified "$TARGET")" "1"
  check "no ready notification is sent for a broken deploy" "$(notified '^ready ')" "0"
  check "a rolled-back deploy exits 0 — the pilot is healthy again, the alert is the report" "$RC" "0"

  # --- 4. a deploy whose rollback is also unhealthy is marked down -----------
  reset_fixture; PNPM_FAIL=""; CI_FAIL=0
  HEALTH_FAIL_CALLS=2                    # the deploy's and the rollback's health checks both fail
  run_deploy
  check "a deploy whose rollback is also unhealthy exits non-zero" "$RC" "1"
  check "the state records status=down" "$(state status)" "down"
  check "the down state still names the failed commit" "$(state failed_sha)" "$TARGET"
  check "exactly one manual-attention alert is sent" "$(notified '^alert ')" "1"
  check "the alert says the rollback is not healthy" "$(notified 'rollback to')" "1"

  # --- 5. a commit whose ci.yml run is not green is deferred, not deployed ---
  reset_fixture; HEALTH_FAIL_CALLS=0; PNPM_FAIL=""; CI_FAIL=1
  run_deploy
  check "a non-CI-green commit is deferred (exit 0)" "$RC" "0"
  check "the state records status=pending" "$(state status)" "pending"
  check "the checkout did not move" "$(site_sha)" "$PREV"
  check "no notification is sent for a deferral" "$(notified '^ready ')" "0"
  check "no alert is sent for a deferral" "$(notified '^alert ')" "0"

  rm -rf "$tmp"
  printf 'self-test: %d passed, %d failed\n' "$tests_pass" "$tests_fail"
  [ "$tests_fail" = 0 ] || return 1
  return 0
}

usage() {
  cat <<EOF
Usage: $PROG [deploy|status|rollback [<sha>]]

  deploy            deploy the newest CI-green commit on $BRANCH into $SITE_DIR
                    (idempotent; auto-rollback on failed install/migrate/health)
  status            print the recorded deploy state and live health
  rollback [<sha>]  revert to the recorded previous commit, or to <sha>
  --self-test       run the no-host/no-network assertions CI runs (board #42)

Target defaults: unit $SITE_UNIT, http://127.0.0.1:$SITE_PORT, surface $SITE_URL.
Environment overrides are documented in infra/deploy.md §10.
EOF
}

main() {
  init_dirs
  case "${1:-deploy}" in
    deploy)   deploy_site ;;
    status)   show_status ;;
    rollback) do_rollback "${2:-}" ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}

# Dispatch the modes that must not touch the host. `--self-test` runs before the
# flock below on purpose: it spawns this file as a child, and a child that finds
# the lock held would silently no-op.
if [ "$MODE" = "help" ]; then
  usage
  exit 0
fi
if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

# Serialise runs: the 5-minute timer must never overlap itself.
init_dirs
exec 9>"$STATE_DIR/deploy-site.lock"
if ! flock -n 9; then
  log "another deploy-site run holds the lock — exiting"
  exit 0
fi

main "$@"
