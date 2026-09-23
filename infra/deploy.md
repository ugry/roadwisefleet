# Deploy path — merge → staging → owner tests (elilavps2)

**Board task:** [`eila/tasks#31`](https://gitea.elilaltd.com/eila/tasks/issues/31) —
*automatic deploy path: merge to staging, health-check, auto-rollback; make the
owner a tester, not an operator.*

**Status: READY-TO-APPLY ARTIFACT — nothing in this document has been installed
or run on any host.** Every file referenced here is reviewed in the repo only.
Installing is a production change that needs owner approval and a change window
(see §4 and §9). The DevOps agent holds no host write access.

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

# 5. seed the staging database once the first release is live (smoke needs it)
sudo -u debian bash -c 'cd /opt/roadwisefleet/staging/current && set -a && . /opt/roadwisefleet/staging/.env && set +a && pnpm --filter @roadwisefleet/api db:seed -- --reset'

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
  "prod_status": "live | rolled_back | down",
  "prod_sha": "<sha>",
  "prod_approval": "<eila/requests#N>"
}
```

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
| B3 | **Notifier credential** — a Matrix bot token (or relay URL) for `#eila`. Not my credential, never handled by me. | owner/orchestrator |
| B4 | **DNS + cert + basic-auth user** for `staging.roadwisefleet.com` (or a decision to use the path-based fallback). | owner |
| B5 | **Failure-injection test** — proving rollback + alert requires breaking a deploy on purpose; needs B1–B3 and a supervised run. | owner + overseer |
| B6 | **Digest wiring** — pointing `/opt/eila/owner_digest.py` at `ready-to-test.txt` (or the JSON). Orchestrator-owned file; I did not touch it. | orchestrator |
| B7 | **Deploy privilege** — decision on the root pull-deploy risk in §7.1. | owner |

## 10. Related documents

- [`pilot-api.md`](./pilot-api.md) — the production API unit and its update steps.
- [`pilot-db.md`](./pilot-db.md) — Postgres/Redis and backups.
- [`pilot-exposure.md`](./pilot-exposure.md) — public routing and the nginx apply/rollback procedure.
- [`monitoring/README.md`](./monitoring/README.md) — the alert path (relay → `#eila-alerts`) this deployer uses.
- [`../deploy.sh`](../deploy.sh) — the legacy manual web/waitlist deploy; unchanged, and superseded for the pilot by this path once approved.
