# Pilot database & cache runbook (elilavps2)

**Scope:** the RoadwiseFleet pilot Postgres + Redis stack on **elilavps2**, the
host that runs the pilot API. Read-only operations only unless an owner has
approved a change.

**Status:** pilot. The sanctioned deploy path for the app is the manual
`deploy.sh` (decision recorded in Gitea `eila/requests#3`). An
Actions-based VPS deploy is **deferred** — do not add one without a new
decision.

**Secrets:** this document contains **no** credential values. Never commit
`.env`, connection strings, or passwords to this repo (they are covered by
`.gitignore`).

---

## 1. Components

| Component | Detail |
|---|---|
| Runtime | **rootful podman** (system-level, `systemctl`-managed units) |
| Postgres | container `roadwise-pg`, image `docker.io/library/postgres:17-alpine` |
| Redis | container `roadwise-redis`, image `docker.io/library/redis:7-alpine` (`--appendonly yes`) |
| Bind address | both published **loopback-only**: `127.0.0.1:5432` and `127.0.0.1:6379` |
| Volumes | `roadwise-pgdata` (PG data dir), `roadwise-redisdata` (AOF) |

Neither service is reachable off-host. Anything that needs the DB (API,
workers, migrations) runs on elilavps2 or over an SSH tunnel — there is no
public DB port.

## 2. systemd units

| Unit | Purpose |
|---|---|
| `roadwise-pg.service` | `podman run` for the Postgres container |
| `roadwise-redis.service` | `podman run` for the Redis container |
| `roadwise-pg-backup.timer` | nightly backup trigger (see §3) |
| `roadwise-pg-backup.service` | oneshot `pg_dump` executed by the timer |

Standard operations (root on elilavps2):

```bash
systemctl status roadwise-pg roadwise-redis roadwise-pg-backup.timer
systemctl restart roadwise-pg          # only with approval — drops connections
journalctl -u roadwise-pg -n 100 --no-pager
```

## 3. Backups

- `roadwise-pg-backup.timer` fires at **03:15 UTC daily** and runs
  `roadwise-pg-backup.service` (oneshot), which `pg_dump`s the pilot database.
- Dumps land in **`/var/backups/roadwisefleet/postgres`**.
- Retention: **14 days** (older dumps are pruned by the backup job).

Verify (read-only):

```bash
systemctl status roadwise-pg-backup.timer
systemctl list-timers roadwise-pg-backup.timer
ls -lh /var/backups/roadwisefleet/postgres
```

A restore drill (into a throwaway database, never over the live one) should be
run periodically and recorded — untested backups are not backups.

## 4. Application configuration

The API reads its connection settings from environment variables:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- `AUTH_SECRET` — **required** HMAC key for pilot session tokens; there is no
  committed fallback. The API fails fast at startup if it is unset. Generate a
  strong random value (e.g. `openssl rand -base64 48`) into the host `.env` and
  restart the API. Rotating it invalidates all issued pilot tokens.

On the pilot host these are supplied from a **gitignored `.env`** file
(`.env` / `.env.*` are ignored in this repo). Rules:

- Never commit a real `.env` or any credential value to the repo.
- Never paste connection strings or passwords into issues, PRs, runbooks, or
  CI logs.
- Rotate credentials by updating the `.env` on the host (and the
  corresponding secret store), then restarting the affected service.

## 5. Deploy path

- **Sanctioned:** manual `./deploy.sh` (see repo root), per Gitea
  `eila/requests#3`.
- **Deferred:** GitHub Actions VPS deploy. The `ci` workflow builds/tests and
  deploys `web/` to GitHub Pages only; it does not touch the pilot DB host.

## 6. Verification checklist (read-only)

Run from elilavps2 and expect the values below:

| Check | Expected |
|---|---|
| `ss -ltn` | `127.0.0.1:5432` (Postgres) and `127.0.0.1:6379` (Redis) LISTEN; no `0.0.0.0` bind for either |
| `systemctl is-active roadwise-pg roadwise-redis roadwise-pg-backup.timer` | all `active` |
| `systemctl list-timers roadwise-pg-backup.timer` | next trigger 03:15 UTC |

## 7. Hardening / known issues

- The pilot `roadwise-pg.service` currently passes the Postgres password via
  `-e POSTGRES_PASSWORD=...` on the `podman run` command line, so the value is
  visible in `systemctl status` output and the process table to any local user
  who can read it. **Recommendation:** move it to an `EnvironmentFile=`
  (mode `0600`, owned by root, outside the repo) and reference the variable in
  the unit, then restart. Track as a hardening follow-up; requires owner
  approval to change the running unit.
- Both containers run under **rootful** podman. That is acceptable for the
  pilot; revisit (rootless podman or a dedicated service user) before
  production.
