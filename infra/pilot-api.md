# Pilot API runbook (elilavps2)

**Scope:** the RoadwiseFleet pilot API running as the systemd unit
`roadwise-api.service` on **elilavps2**. Read-only operations unless an owner has
approved a change. This document contains **no** credential values.

**Status:** pilot. The sanctioned app deploy path is the manual `deploy.sh`
(decision recorded in Gitea `eila/requests#3`). An Actions-based VPS deploy is
**deferred** — do not add one without a new decision. CI builds/tests and deploys
`web/` to GitHub Pages only; it does not touch the pilot host.

**Prepared, not yet approved (2026-09-23, board `eila/tasks#31`):** an automatic
deploy path — merge → staging → health check → auto-rollback → "ready to test",
with production promotion owner-gated — is specified in [`deploy.md`](./deploy.md).
Its artifacts (deployer, staging unit, timer, nginx vhost) are reviewed in the
repo but **not installed**; until an owner-approved window lands them, this
section remains the live procedure.

**Related:** the Postgres/Redis stack behind this API is documented in
[`pilot-db.md`](./pilot-db.md). Reference unit mirrors live in
[`systemd/`](./systemd/).

---

## 1. Purpose / scope

`roadwise-api.service` runs the `@roadwisefleet/api` Fastify + Prisma service —
the pilot backend for the trip loop, waitlist, and pilot auth. It is an internal,
loopback-only service: no public listener, no signup flow. It depends on the
pilot Postgres and Redis containers (see `pilot-db.md`).

## 2. Host and unit

| Item | Value |
|---|---|
| Host | **elilavps2** |
| Unit | `roadwise-api.service` (`/etc/systemd/system/roadwise-api.service`, mode `0644`, `root:root`) |
| Service user / group | `debian:debian` |
| Service type | `Type=simple` |
| Working directory | `/opt/roadwisefleet/api` (git clone of the public repo; `debian`-owned) |
| Environment | `HOME=/home/debian`; other settings via `EnvironmentFile` (below) |
| ExecStart | `/usr/local/bin/pnpm --filter @roadwisefleet/api start` (→ `tsx src/server.ts`) |
| EnvironmentFile | `/opt/roadwisefleet/api/.env` (mode `0600`, owned `debian:debian`) |
| Bind address / port | `127.0.0.1:8080` (loopback only) |
| Restart policy | `Restart=always`, `RestartSec=5` |
| Hardening | `NoNewPrivileges=true` |
| Ordering | `After=network-online.target roadwise-pg.service roadwise-redis.service`; `Wants=network-online.target` |
| Dependencies | `Requires=roadwise-pg.service` |

The unit file is the authoritative copy on the host; the mirror in
[`systemd/roadwise-api.service`](./systemd/roadwise-api.service) is a value-free
reference transcription (see the note in that file). The ordering / `Type=` /
`Environment=` values above were read from the live unit by the overseer over
SSH `sudo` (2026-09-14, ref 12) — this sandbox cannot read `/etc` directly, so
they are not independently re-read here.

## 3. Configuration

The API reads its settings from environment variables, supplied on the host via
`/opt/roadwisefleet/api/.env` (mode `0600`, `debian:debian`, gitignored — never
committed). Relevant keys (names only — **never** record values):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (pilot DB on `127.0.0.1:5432`) |
| `REDIS_URL` | Redis connection string (pilot cache on `127.0.0.1:6379`) |
| `PORT` | API listen port (default `8080`) |
| `HOST` | API bind address (default `127.0.0.1`) |
| `AUTH_SECRET` | HMAC key for pilot session tokens |
| `ADMIN_TOKEN` | token for the admin waitlist endpoint |

Rules: never commit a real `.env` or any credential value; never paste
connection strings/passwords into issues, PRs, runbooks, or CI logs. Rotate by
updating the `.env` on the host (and the secret store), then restarting the
service.

## 4. Operations

```bash
# status (read-only)
systemctl status roadwise-api
systemctl status roadwise-api roadwise-pg roadwise-redis

# start / stop / restart  — owner approval required (production change)
sudo systemctl start roadwise-api
sudo systemctl stop roadwise-api
sudo systemctl restart roadwise-api

# logs
journalctl -u roadwise-api -n 100 --no-pager
journalctl -u roadwise-api -f

# health check (expect HTTP/1.1 200 OK, JSON body)
curl -sI http://127.0.0.1:8080/health
```

`systemctl status` output can be long; it shows the process tree but **not** the
env file contents. The `.env` is `0600`, so its values are not world-readable.

## 5. Verification checklist (read-only)

Run from elilavps2 and expect the values below:

| Check | Expected |
|---|---|
| `systemctl status roadwise-api` | `active (running)`, `enabled` |
| `ss -ltn` | `127.0.0.1:8080` LISTEN (no `0.0.0.0:8080`) |
| `curl -sI http://127.0.0.1:8080/health` | `HTTP/1.1 200 OK`, `content-type: application/json` |
| `systemctl status roadwise-pg roadwise-redis` | both `active (running)` |
| `systemctl status roadwise-pg-backup.timer` | `active (waiting)`, next trigger 03:15 UTC |

## 6. Update / deploy steps

The pilot API is a git checkout on the host, updated in place. This is separate
from the web/waitlist `deploy.sh` path.

> **Automation prepared (not installed):** [`deploy.md`](./deploy.md) defines the
> sanctioned automatic path — staging deploys itself from `main` after CI is
> green, with health-check + auto-rollback, and production promotion is
> owner-gated with an automatic revert. The steps below are the current manual
> procedure and remain the fallback.

```bash
cd /opt/roadwisefleet/api
git fetch origin
git checkout main
git pull --ff-only origin main
pnpm install                      # repo root; postinstall runs prisma generate
# schema changes only: pnpm --filter @roadwisefleet/api db:migrate
sudo systemctl restart roadwise-api
curl -sI http://127.0.0.1:8080/health
```

Notes:

- Run `pnpm install` from the repo root (`/opt/roadwisefleet/api`) so the
  workspace install + Prisma `postinstall` are applied.
- The restart is a production change: get owner approval first, then verify the
  health check and `journalctl -u roadwise-api` afterwards.
- Migrations must be applied deliberately (`db:migrate`) and are not run
  automatically by the restart.
- CI (`api-tests` job, `node --test apps/api/src/`) must be green before
  updating the host to a new `main`.

## 7. Hardening notes

- Credentials live in `EnvironmentFile` (`.env`, mode `0600`, `debian:debian`),
  **not** on the command line — nothing secret appears in `systemctl status` or
  the process table. Keep it that way.
- `NoNewPrivileges=true` is set. Additional sandboxing (`ProtectSystem=strict`,
  `ProtectHome=true`, `PrivateTmp=true`) and a dedicated unprivileged service
  user are **pending owner approval** and a tested rollout — they change the
  live unit and the API writes under its working directory, so a strict sandbox
  can break it. Do not apply them unilaterally; the item is tracked by the
  overseer.
- The service binds loopback only; keep it behind the local reverse proxy /
  tunnel rather than exposing `8080`.
- Postgres/Redis run under **rootful** podman — revisit (rootless podman or a
  dedicated service user) before production; see `pilot-db.md` §7.
- Rotate `AUTH_SECRET` and `ADMIN_TOKEN` away from pilot defaults before any
  real use.
