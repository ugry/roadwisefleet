# Deploy path — merge → staging → owner tests (elilavps2)

**Board task:** [`eila/tasks#31`](https://gitea.elilaltd.com/eila/tasks/issues/31) —
*automatic deploy path: merge to staging, health-check, auto-rollback; make the
owner a tester, not an operator.*

**Status: READY-TO-APPLY ARTIFACT — nothing in this document has been installed
or run on any host.** Every file referenced here is reviewed in the repo only.
Installing is a production change that needs owner approval and a change window
(see §4 and §9). The DevOps agent holds no host write access.

> **Re-scope 2026-09-23 (§10):** the owner removed staging — the live pilot *is*
> the test environment. The deployable path is now the single-environment deployer
> in **§10**; the staging-shaped §4–§7 artifacts are **superseded and not
> installed**.

**Secrets:** no credential value appears in this document, in the artifacts, in
the units, or in any log produced by them. Settings come from 0600
EnvironmentFiles; the deployer sources them and never echoes them.

---

## 1. The problem this removes

| Today | After this design |
|---|---|
| Merge → nothing changes on the server | Merge → staging updates automatically (≤ 5 min) |
| Owner runs the deploy himself before he can test | Owner opens a link and tests a notified build SHA |
| A bad merge lands where the owner tests | A bad build dies on staging; auto-rollback + `#eila-alerts` |
| Production deploy is ad-hoc (`git pull`, `deploy.sh`) | One sanctioned deployer, one release layout, recorded state |

Production stays **owner-gated** (scope item 5): promotion is a separate,
explicitly approved step, never automatic.

## 2. Design in one line

**Pull model.** A systemd timer on elilavps2 polls `main` every 5 minutes; for a
commit whose CI run is green it builds an immutable release, applies additive
migrations, restarts the *staging* unit, verifies health, and either records
"READY TO TEST" or rolls back and alerts. No host credential lives in GitHub and
no public deploy endpoint is opened.

Why not "a CI job that triggers it" (the other option in the task)? A CI-triggered
deploy needs either an SSH deploy key in GitHub Secrets or a public webhook on
the host. The pull model needs neither, keeps working when GitHub Actions is
degraded (it simply catches up on the next tick), and cannot bypass branch
protection — it only ever deploys commits that are already on `main`. The
trade-off (a root-owned script executing merged code) is a real one and is
treated as a finding in §7.

## 3. Files in this change

| File | Host path after install | Role |
|---|---|---|
| `deploy/roadwise-deploy.sh` | `/usr/local/bin/roadwise-deploy.sh` | the deployer: `staging` \| `status` \| `rollback [<sha>]` |
| `deploy/roadwise-notify.sh` | `/usr/local/bin/roadwise-notify.sh` | the "READY TO TEST" signal + failure alerts |
| `deploy/roadwise-promote.sh` | `/usr/local/bin/roadwise-promote.sh` | owner-gated staging → production (never timer-driven) |
| `deploy/staging.env.example` | `/opt/roadwisefleet/staging/.env` | key names for the staging environment (values filled in on the host) |
| `deploy/notify.env.example` | `/etc/roadwisefleet/notify.env` | key names for the Matrix/relay notifier |
| `systemd/roadwise-staging-api.service` | `/etc/systemd/system/` | the staging API unit (port 8081) — new, does not touch `roadwise-api.service` |
| `systemd/roadwise-deploy-staging.service` | `/etc/systemd/system/` | oneshot deploy job |
| `systemd/roadwise-deploy-staging.timer` | `/etc/systemd/system/` | the 5-minute poll |
| `nginx/roadwisefleet-staging.conf` | `/etc/nginx/sites-available/roadwisefleet-staging.conf` | `staging.roadwisefleet.com`, basic auth, proxies 8081 |

## 4. Install (owner-approved window, root on elilavps2)

Prerequisite: **§9 blockers resolved** (staging database, notify credential,
DNS + cert). Steps are ordered so nothing is exposed before it works.

```bash
# 0. bootstrap: read-only mirror used as the deploy source (public repo, no key)
sudo git clone --bare https://github.com/ugry/roadwisefleet.git /opt/roadwisefleet/repo.git
sudo mkdir -p /opt/roadwisefleet/releases /opt/roadwisefleet/staging /var/lib/roadwisefleet

# 1. staging database (separate database, same Postgres container)
sudo podman exec -it roadwise-pg psql -U postgres -c 'CREATE DATABASE roadwisefleet_staging;'

# 2. staging environment + notifier files (0600, values filled in on the host)
sudo install -d -m 0755 /etc/roadwisefleet
sudo install -m 0600 -o root -g root infra/deploy/staging.env.example /opt/roadwisefleet/staging/.env
sudo install -m 0600 -o root -g root infra/deploy/notify.env.example /etc/roadwisefleet/notify.env
sudo editor /opt/roadwisefleet/staging/.env /etc/roadwisefleet/notify.env   # fill values, never commit

# 3. scripts + units (config-as-code -> host)
sudo install -m 0755 infra/deploy/roadwise-deploy.sh  /usr/local/bin/
sudo install -m 0755 infra/deploy/roadwise-notify.sh  /usr/local/bin/
sudo install -m 0755 infra/deploy/roadwise-promote.sh /usr/local/bin/
sudo install -m 0644 infra/systemd/roadwise-staging-api.service   /etc/systemd/system/
sudo install -m 0644 infra/systemd/roadwise-deploy-staging.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/roadwise-deploy-staging.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# 4. first deploy, by hand, in front of a human
sudo systemctl start roadwise-deploy-staging.service
sudo journalctl -u roadwise-deploy-staging.service -n 100 --no-pager
sudo /usr/local/bin/roadwise-deploy.sh status

# 4b. verify the notification transport BEFORE enabling the timer (see §9 B3).
#     Exit 0 = delivered; 3 = no transport configured (nothing was sent);
#     4 = configured but delivery failed. The deploy is not failed by this,
#     but the "ready to test" signal is worthless without it.
sudo /usr/local/bin/roadwise-notify.sh alert "TEST — deploy-path install verification, please ignore"; echo "notify exit: $?"

# 5. seed the staging database once the first release is live (smoke needs it).
#    The staging EnvironmentFile is 0600 root:root BY DESIGN and the app runs as
#    `debian`, so this must NOT be sourced as debian (`. /opt/.../.env` as debian
#    fails with permission denied) and the values must not be put on a command
#    line. Run the seeder as a transient unit that reuses the same
#    EnvironmentFile + user as the service:
sudo systemd-run --unit=roadwise-staging-seed --collect --wait \
  --property=Type=oneshot \
  --property=User=debian --property=Group=debian \
  --property=WorkingDirectory=/opt/roadwisefleet/staging/current \
  --property=Environment=HOME=/home/debian \
  --property=EnvironmentFile=/opt/roadwisefleet/staging/.env \
  /usr/local/bin/pnpm --filter @roadwisefleet/api db:seed -- --reset

# 6. nginx staging vhost (after DNS + htpasswd + certbot per the file header)
sudo install -m 0644 infra/nginx/roadwisefleet-staging.conf /etc/nginx/sites-available/
sudo ln -sfn /etc/nginx/sites-available/roadwisefleet-staging.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7. enable the poll only once 4–6 are green
sudo systemctl enable --now roadwise-deploy-staging.timer
systemctl list-timers roadwise-deploy-staging.timer
```

Roll back the *installation* (not a release): stop and disable the timer
(`systemctl disable --now roadwise-deploy-staging.timer`), stop and disable the
staging unit, remove the nginx symlink + `nginx -t` + reload, delete the files in
§3. The production units are never touched by any of this.

## 5. Configuration knobs and the state contract

The deployer reads overrides from the environment (the unit sets none, so the
defaults below apply). Every path is overridable with an `RWF_*` variable;
defaults: mirror `/opt/roadwisefleet/repo.git`, releases
`/opt/roadwisefleet/releases`, staging root `/opt/roadwisefleet/staging`, staging
port `8081`, keep 5 releases, health timeout 60 s, `RWF_RUN_SMOKE=auto`.

Recorded state — **the only source of truth for "what is live where"**:

`/var/lib/roadwisefleet/deploy-state.json`

```json
{
  "surface": "staging",
  "sha": "<full sha>",
  "short_sha": "<7 chars>",
  "status": "ready | rolled_back | failed | down",
  "previous_sha": "<sha>",
  "deployed_at": "<UTC ISO-8601>",
  "url": "https://staging.roadwisefleet.com/pilot/",
  "notify": "sent | not-sent-no-transport | not-sent-transport-failed | not-sent-error-<rc>",
  "prod_status": "live | rolled_back | down",
  "prod_sha": "<sha>",
  "prod_approval": "<eila/requests#N>"
}
```

`notify` is the delivery result of the notification for that outcome (the notifier
exits 0 = delivered, 3 = no transport configured, 4 = every configured transport
failed). It is recorded on both success and failure paths. **`status=ready` with
`notify=not-sent-*` means staging is fine but nobody was told** — the signal the
owner relies on is missing and the alert transport must be fixed (§9 B3). The
failing deploy still exits non-zero, so systemd shows the unit as failed.

`/var/lib/roadwisefleet/ready-to-test.txt` — one line, for the owner digest
(`/opt/eila/owner_digest.py`, section *READY TO TEST*):

```
ready-to-test surface=staging sha=<full sha> short=<7> at=<UTC ISO-8601> url=<url>
```

The digest file is orchestrator-owned and is **not** modified by this change; the
orchestrator can read either file (or the JSON). Both are written only after a
green health check + smoke, and never on a failed deploy.

## 6. Promotion to production (owner-gated)

```bash
# dry run first: prints the plan, changes nothing
sudo /usr/local/bin/roadwise-promote.sh --sha <sha> --approval eila/requests#6 --dry-run

# real promotion (add --web to also sync web/*.html to /var/www/roadwisefleet)
sudo /usr/local/bin/roadwise-promote.sh --sha <sha> --approval eila/requests#6
```

Guardrails: `--approval <ref>` is mandatory (no ref, no promotion); the SHA must
be the current **healthy staging** release (`status=ready`), so an untested build
cannot be promoted; the production checkout must be clean; the pre-promotion SHA
is recorded and the script reverts to it automatically if the production health
check fails, then alerts. It is never wired to a timer.

Existing production constraints still apply: nginx changes (e.g. PR #13 / #27,
board #7) remain their own approved change window — this script does not touch
nginx.

Migrations: the deploy path runs `prisma migrate deploy` (never `migrate dev`) on
staging and on promotion. **Policy: migrations must be additive-only** so that a
rollback (which reverts code, not schema) leaves the previous release working
against the newer schema. A destructive migration needs its own window and a
written rollback — it is not covered by auto-rollback.

## 7. Security, guardrails, known risks

1. **Pull-deploy executes merged code as root.** The deploy unit runs as root
   because it restarts a unit and writes to `/opt/roadwisefleet`. The control is
   upstream: branch protection + required review (`.github/CODEOWNERS`) means only
   reviewed commits reach `main`. Recommended follow-up (owner decision): run the
   deploy as a dedicated unprivileged `roadwise-deploy` user with a sudoers
   whitelist limited to `systemctl restart roadwise-staging-api.service`, and keep
   `pnpm install` in a sandbox. Recorded as a finding, not silently accepted.
2. **No public deploy endpoint.** The pull model avoids adding a listener; task
   #9 (close public listeners) is not made worse by this change. The nginx staging
   vhost is behind basic auth and adds no new port.
3. **Staging isolation.** Separate unit, separate port (8081 asserted different
   from 8080 at runtime), separate database, separate env file. Production units
   are never referenced by the deployer.
4. **Secrets.** 0600 EnvironmentFiles only; no secret in a unit directive, a
   repo file, a command line, or a log. The notifier never prints its token.
5. **Idempotency.** A lock (`flock`) serialises runs; a commit already staged and
   healthy is a no-op; a release directory is only marked ready after extraction
   and `pnpm install` succeed.
6. **Failure is loud but not destructive.** Health/smoke failure → automatic
   rollback to the previous release → `#eila-alerts` (and `#eila` on success).
   The pilot's live surface is never part of that path.
7. **Release build runs as root, the application runs as `debian`.** The deploy
   unit is `User=root`, so `git archive`, `pnpm install` and `prisma` write a
   root-owned release tree under `/opt/roadwisefleet/releases`, while
   `roadwise-staging-api.service` runs as `debian` and must read/execute it. It
   works with a default umask (755/644, no writes needed at runtime), but a
   restrictive umask or a future write at startup would break staging. Options,
   both a change to this design and therefore flagged, not silently applied:
   (a) run the deployer as a dedicated `roadwise-deploy` user (see §7.1) and
   grant only `systemctl restart roadwise-staging-api.service`; or (b) build as
   `debian` (a transient unit like the seeder in §4 step 5) and keep the
   root-only parts (fetch, symlink, restart) separate.
8. **Notification transport from elilavps2 is Matrix-only.** The orchestrator
   relay is loopback-bound on **elilavps1** (`127.0.0.1:9099`), so elilavps2 —
   where the deployer runs — cannot reach it. `notify.env.example` therefore
   documents Matrix as the transport that actually works, keeps the relay as an
   advanced option with a reachable URL and a **registered** endpoint
   (`/alert`, `/gatus`, `/grafana`, payload key `message`), and the notifier now
   refuses an unregistered path (the old `/notify` default) and exits non-zero
   instead of skipping silently. Consequence: **§9 B3 (Matrix bot token) is a
   hard prerequisite** for acceptance criterion 4 — without it `notify=
   not-sent-no-transport` is recorded and the owner is never told.

## 8. Acceptance mapping (task #31)

| Acceptance criterion | How it is met | Status |
|---|---|---|
| Merge a trivial PR → staging updates, no human action | timer polls `main`, CI-gated, deploys + health-checks | **artifact only — not installed, so not yet demonstrated** |
| Deliberate failure → rollback + `#eila-alerts` fires | `rollback_to()` (health + smoke gate) + `notify alert` | **artifact only — the failure injection test needs the install window** |
| The live pilot is untouched throughout | staging has its own unit/port/database; prod units never referenced | designed; **to be verified live during the window** |
| Owner goes notified → tested with no command | `ready-to-test.txt` + Matrix/relay message with the SHA and URL; `staging.roadwisefleet.com/pilot/` behind basic auth | **needs §9 items (notify credential, DNS/cert, auth user)** |

Nothing above has been executed on the host; nothing is claimed as done.

## 9. Blocked / needs a human

| # | Blocker | Owner of the fix |
|---|---|---|
| B1 | **Install window + approval** — installing units/scripts/nginx and enabling the timer is a production change. | owner (with the overseer) |
| B2 | **Staging database** — a second database on the pilot Postgres (and a decision on whether staging data is disposable; it must be, since the smoke test writes). | owner/DBA-in-the-window |
| B3 | **Notifier credential** — a Matrix bot token for `#eila` (the relay on elilavps1 is loopback-only and unreachable from elilavps2, see §7.8, so Matrix is the working transport). Not my credential, never handled by me. Until this exists, the ready-to-test signal is not delivered (`notify=not-sent-no-transport`), so acceptance criterion 4 cannot be met. | owner/orchestrator |
| B4 | **DNS + cert + basic-auth user** for `staging.roadwisefleet.com` (or a decision to use the path-based fallback). | owner |
| B5 | **Failure-injection test** — proving rollback + alert requires breaking a deploy on purpose; needs B1–B3 and a supervised run. | owner + overseer |
| B6 | **Digest wiring** — pointing `/opt/eila/owner_digest.py` at `ready-to-test.txt` (or the JSON). Orchestrator-owned file; I did not touch it. | orchestrator |
| B7 | **Deploy privilege** — decision on the root pull-deploy risk in §7.1. | owner |

> **Re-scope 2026-09-23:** for the site-direct path (§10) B1 (install window) and
> B7 (root deployer) are closed by the owner, B3 is resolved (`@alerts-bot`) and
> B4 is dropped (no staging surface). B2/B5/B6 apply only to the superseded
> staging design.

## 10. Site-direct deploy — merge → live pilot (re-scope, 2026-09-23)

**Owner re-scope** (`eila/tasks#31`, board comment 406; Matrix ~19:48 UTC): there
is **no staging environment** — the live pilot **is** the test environment
(*"we don't need staging it's not production, so whole site is staging"*). The
staging-shaped artifacts in §3–§7 (release symlink, `roadwise-staging-api` on
8081, `roadwisefleet_staging` DB, `roadwise-promote.sh`) are therefore **not
installed** and are superseded for the pilot route; the §6 promotion step is
dropped for now. Owner decisions that closed blockers: **B1** install window
(~45 min, root, elilavps2), **B3** notifier = the existing `@alerts-bot` in
`#eila`, **B7** root deployer accepted. **B4** (staging surface) is dropped.

### 10.1 Artifacts

| File | Host path after install | Role |
|---|---|---|
| `deploy/roadwise-deploy-site.sh` | `/usr/local/bin/roadwise-deploy-site.sh` | the single-environment deployer: `deploy` \| `status` \| `rollback [<sha>]` |
| `systemd/roadwise-deploy-site.service` | `/etc/systemd/system/roadwise-deploy-site.service` | oneshot deploy job (root) |
| `systemd/roadwise-deploy-site.timer` | `/etc/systemd/system/roadwise-deploy-site.timer` | the 5-minute poll |

It reuses the reviewed helpers (`log`/`die`/state/`ci_is_green`/`wait_healthy`/
`notify`) and `roadwise-notify.sh` from PR #29; the staging release/symlink logic
is deliberately not used.

### 10.2 Target and behaviour

Hard-coded defaults, overridable via the unit's `Environment=`:

| Knob | Default |
|---|---|
| `RWF_SITE_DIR` | `/opt/roadwisefleet/api` (in-place git checkout, not a symlink) |
| `RWF_SITE_UNIT` | `roadwise-api.service` |
| `RWF_SITE_PORT` | `8080` (`127.0.0.1`) |
| `RWF_SITE_URL` | `https://roadwisefleet.com/pilot/` |
| `RWF_SITE_STATE_FILE` | `/var/lib/roadwisefleet/deploy-site-state.json` |
| database | `roadwisefleet` (via the app `.env`) |

1. `flock` single instance; `git fetch` `main` in the checkout; target = newest `main` commit.
2. **CI-green gate** — only a commit whose `ci.yml` run concluded `success`.
3. **Idempotent** — target already deployed and `/health` + `/pilot/` both 200 → silent `exit 0`.
4. Deploy: record previous SHA → `git checkout --force <sha>` → `CI=true pnpm install --frozen-lockfile` → `prisma migrate deploy` (additive-only) → `systemctl restart roadwise-api.service` → health-check `/health` **and** `/pilot/`.
5. **Auto-rollback** — any failed step reverts the checkout to the previous SHA, reinstalls, restarts, re-checks health, and alerts.
6. **Notify** — `roadwise-notify.sh ready <sha> <url>` on success, `alert` on failure/rollback. No credential on a command line or in a log.

### 10.3 State contract

`/var/lib/roadwisefleet/deploy-site-state.json` (separate from the staging
`deploy-state.json`; written atomically; contains no secrets):

```json
{
  "surface": "site",
  "sha": "<live commit>",
  "short_sha": "<7>",
  "previous_sha": "<previous commit>",
  "status": "ready | rolled_back | failed | down | pending",
  "deployed_at": "<UTC ISO-8601>",
  "url": "https://roadwisefleet.com/pilot/",
  "notify": "sent | not-sent-no-transport | not-sent-transport-failed | not-sent-error-<rc>"
}
```

`status=ready` with `notify=not-sent-*` means the pilot is fine but nobody was told.

### 10.4 Install (owner-approved window, root on elilavps2)

Prerequisite: the checkout `/opt/roadwisefleet/api` already exists (it does — main `5cbebb1`).

```bash
# 1. scripts + units (config-as-code -> host)
sudo install -m 0755 infra/deploy/roadwise-deploy-site.sh /usr/local/bin/
sudo install -m 0644 infra/systemd/roadwise-deploy-site.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/roadwise-deploy-site.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# 2. notifier credential (0600) -- see §9 B3; without it notify=not-sent-no-transport
sudo install -d -m 0755 /etc/roadwisefleet
sudo install -m 0600 infra/deploy/notify.env.example /etc/roadwisefleet/notify.env
sudo editor /etc/roadwisefleet/notify.env      # fill values, never commit

# 3. first deploy by hand, in front of a human
sudo systemctl start roadwise-deploy-site.service
sudo journalctl -u roadwise-deploy-site.service -n 100 --no-pager
sudo /usr/local/bin/roadwise-deploy-site.sh status

# 4. verify the transport: 0 = delivered, 3 = nothing configured, 4 = delivery failed
sudo /usr/local/bin/roadwise-notify.sh alert "TEST — site-deploy install verification, please ignore"; echo "notify exit: $?"

# 5. enable the poll only once 3–4 are green
sudo systemctl enable --now roadwise-deploy-site.timer
systemctl list-timers roadwise-deploy-site.timer
```

### 10.5 Rollback

- **Automatic:** every failed step reverts the checkout to the recorded previous
  SHA, reinstalls, restarts and re-checks `/health` + `/pilot/`, then alerts.
  Migrations are **additive-only** and are not reverted.
- **Manual:** `sudo /usr/local/bin/roadwise-deploy-site.sh rollback [<sha>]`
  (defaults to `previous_sha` from the state file).
- **Roll back the installation:** `systemctl disable --now roadwise-deploy-site.timer`
  and remove the three files in §10.1. The app checkout and `roadwise-api.service`
  are left as they are.

### 10.6 Acceptance mapping (re-scoped task #31)

| Acceptance criterion | How it is met | Status |
|---|---|---|
| Merge → live pilot updates, no human action | 5-min timer + CI-green gate + in-place deploy | **artifact only — not installed** |
| Failure → auto-rollback + alert fires | `rollback_to()` on install/migrate/health failure + `notify alert` | **rollback decision machine-checked in CI** (`deploy-site-selftest`, board #42); the live failure-injection still needs the install window |
| Owner notified → tests without a command | `ready <sha> <url>` to `#eila` + `deploy-site-state.json` | **needs the notifier (B3) at install** |
| No staging created | no second unit/port/database/symlink; the pilot checkout is deployed in place | designed |

Nothing above has been executed on the host; nothing is claimed as done.

### 10.6a CI proof (`--self-test`, board #42)

`infra/deploy/roadwise-deploy-site.sh --self-test` runs in the
`deploy-site-selftest` CI job on every push/PR. It drives the real script in a
fixture git repo (a local bare `origin` + working checkout, no network) with
stubbed `curl`/`systemctl`/`pnpm`/`roadwise-notify.sh` and a `python3` that
intercepts only the `ci.yml` gate, and asserts on the state file / notifications
the run actually produced:

| Assertion | Value |
|---|---|
| a good deploy → `status=ready`, `sha=<target>` (the deployed commit), checkout on it | the acceptance's "reports success with the commit SHA" |
| a deliberately broken deploy (dependency install fails) → checkout back on the previous commit, `status=rolled_back`, `failed_sha=<target>`, **exactly one** alert naming the reason and the failed SHA | the acceptance's "rolls back automatically and reports it" |
| a deploy whose rollback is also unhealthy → `status=down`, non-zero exit, one manual-attention alert | the safety net beyond the acceptance |
| a commit whose `ci.yml` run is not green → `status=pending`, nothing deployed, no notification | the CI gate |
| the target already deployed and healthy → silent no-op | idempotency |

Two behaviours the self-test pins, surfaced for the owner/Team Leader rather than
changed here (deploy semantics on a reviewed artifact):

- **A successfully rolled-back deploy exits `0`.** The state file says
  `status=rolled_back` and the alert is sent, but `roadwise-deploy-site.service`
  is a oneshot, so on the host a rollback would *not* show the unit as failed
  (§5 documents non-zero exit for the superseded staging deployer). If the owner
  wants systemd to surface it too, the site deployer should exit non-zero when
  the target it attempted is not what is live.
- **The next tick retries the same bad target.** After a rollback
  `origin/main` still points at the failed commit and `state.sha` is the previous
  one, so the 5-minute timer re-attempts it and alerts again; `roadwise-notify.sh`
  has no cooldown, so a persisted runtime failure would alert every tick until
  `main` moves. A guard (defer while the newest `main` commit equals
  `failed_sha`) is the obvious fix, but it is a behaviour change, not made here.


### 10.7 Known considerations

- **Root pull-deploy** executes merged code as root (§7.1; owner accepted, B7).
  The control upstream is branch protection + required review on `main`.
- **Checkout ownership:** `/opt/roadwisefleet/api` is `debian`-owned while the
  unit runs as root, so `git` is called with `-c safe.directory=...` and touched
  files may become root-owned. Read-only for the `debian` service under the
  default umask; if that ever breaks, move the build steps to `debian` (§7.7).
- **No staging fallback:** a bad merge reaches the live pilot; the safety net is
  the CI-green gate + auto-rollback, not a second environment (owner's choice).

## 11. Review follow-up (PR #29, overseer request-changes 2026-09-23)

The overseer's review found four defects in the first revision. All four are
fixed in this PR (repo-only; still nothing installed):

| # | Defect | Fix |
|---|---|---|
| D1 | `notify.env.example` offered `RWF_RELAY_URL=http://127.0.0.1:9099/notify`, but the deployer runs on elilavps2 and the relay is loopback-bound on elilavps1 → alerts silently skipped whenever only the relay was configured | The example no longer presents the relay as a ready-to-use transport: Matrix is documented as the transport that works from elilavps2, the relay is marked advanced/usually-wrong with the reason, and a configured-but-failing transport is now a loud failure (§7.8). The deployer records `notify=not-sent-*` in the state file. |
| D2 | `/notify` is not a registered relay endpoint (only `/alert`, `/gatus`, `/grafana` are), and the body was `{"text": …}` while the relay reads `{"message": …}` | `roadwise-notify.sh` sends `{"message": …}` and refuses any relay path outside the registered set instead of relying on the relay's catch-all. |
| D3 | Install §4 step 5 seeded as `debian` against a `0600 root:root` EnvironmentFile — `. /opt/roadwisefleet/staging/.env` fails with permission denied | Step 5 now runs the seeder as a transient `systemd-run` unit with `User=debian` + the same `EnvironmentFile=`, so systemd reads the file as root and no value ever touches a command line. |
| D4 | `roadwise-deploy.sh` called `roadwise-notify.sh ready "<one combined message>"` while `roadwise-notify.sh` expected `<sha> <url>` — duplicated text, and the sha/url contract could silently mis-render | One contract: `ready <sha> <url>`, `update <sha> <url> [<note>]` (production), `alert <message...>`. The deployer passes the SHA and URL separately; `roadwise-promote.sh` uses `update` with the approval ref. |

Also fixed while in there: a failed **extraction / `pnpm install` / Prisma
migration** now raises an alert and records `status=failed` instead of failing
quietly with only a log line, and the previous SHA is resolved before any
mutating step so those alerts can name what staging still runs.

## 12. Related documents

- [`pilot-api.md`](./pilot-api.md) — the production API unit and its update steps.
- [`deploy/roadwise-deploy-site.sh`](./deploy/roadwise-deploy-site.sh) — the current sanctioned deployer (§10); the staging deployer in §3 is superseded.
- [`pilot-db.md`](./pilot-db.md) — Postgres/Redis and backups.
- [`pilot-exposure.md`](./pilot-exposure.md) — public routing and the nginx apply/rollback procedure.
- [`monitoring/README.md`](./monitoring/README.md) — the alert path (relay → `#eila-alerts`) this deployer uses.
- [`../deploy.sh`](../deploy.sh) — the legacy manual web/waitlist deploy; unchanged, and superseded for the pilot by this path once approved.
