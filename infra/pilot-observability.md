# Pilot observability & verified backups (elilavps2)

**Scope:** what monitoring/observability exists for the RoadwiseFleet pilot, how
to verify it, and the current *verified* state of the backups. Read-only; this
document makes no host change. **No credential values appear here.**

**Host:** elilavps2 (`51.222.139.227`). **Verified:** 2026-09-22 ~15:45 UTC.

**Related:** [`pilot-exposure.md`](./pilot-exposure.md) (health checks, logs),
[`pilot-db.md`](./pilot-db.md) (Postgres/Redis/backups),
[`host-exposure.md`](./host-exposure.md) (listener inventory).

---

## 1. Current observability — what actually exists

| Signal | Present? | Detail |
|---|---|---|
| Metrics / exporter | **no** | no `prometheus`, `node_exporter`, `telegraf` or `netdata` unit on the host |
| Alerting / on-call routing | **no** | nothing observed |
| Uptime / blackbox probe | **no** | nothing observed |
| API liveness | yes | `GET http://127.0.0.1:8080/health` → `200` (host-only; not exposed publicly) |
| Unit health | yes | `systemctl status roadwise-*` |
| nginx logs | yes | `/var/log/nginx/access.log`, `/var/log/nginx/error.log` |
| Service logs | yes | `journalctl -u <unit>` |
| Backup timers | yes | `roadwise-pg-backup.timer`, `roadwisefleet-backup.timer` |

**Finding O1:** the pilot has **no metrics, no alerting and no external uptime
check**. The only way anyone notices an outage today is a user report or a manual
`curl`. For a public pilot that is the main observability gap.

**Finding O2 (carried from `pilot-exposure.md` R3):** `/health` is a **liveness**
probe only — it returns `200 {"ok":true}` even when Postgres/Redis are
unreachable, so it cannot gate a deploy or an alert. A readiness endpoint is
**app code** (developer's area).

## 2. Backup verification (read-only, 2026-09-22)

| Item | Verified value |
|---|---|
| Postgres backup timer | `roadwise-pg-backup.timer` — `enabled`, `active (waiting)`, next trigger **2026-09-23 03:15 UTC** |
| Last Postgres backup run | `roadwise-pg-backup.service` last exited **2026-09-22 03:15:14 UTC, status 0/SUCCESS** (Mem peak 60.3M) |
| Postgres backup script | `/usr/local/bin/roadwise-pg-backup.sh` (`root:root`, `0755`) |
| Waitlist backup timer | `roadwisefleet-backup.timer` — `enabled`, `active (waiting)`, next trigger **2026-09-23 03:30 UTC** |
| Waitlist backup script | `services/waitlist/backup.sh` → `/opt/roadwisefleet/waitlist/backup.sh` (tar.gz, 14-day retention) |
| Backup destination | `/var/backups/roadwisefleet/` (`postgres/`, waitlist `tar.gz`) |
| **File-level check** | **not possible from here** — `/var/backups/roadwisefleet/postgres` is `Permission denied` for this account |

**What "verified" means here:** the timers are scheduled and enabled, and the
**last Postgres run completed successfully** (`status=0/SUCCESS`, confirmed via
`systemctl status`). **What is NOT verified:** that the dump files exist, are
non-zero, are recent, or actually restore. That requires reading
`/var/backups/roadwisefleet/postgres` (root) and a restore drill — see §4.

**Finding B1:** backups are scheduled and the last run succeeded, but there is
**no restore test and no artifact-level check**, so the backup is "green by
exit code" only. A `pg_dump` can exit 0 and still produce an unusable file (e.g.
wrong database, empty schema). This is the standard "untested backup is not a
backup" gap.

## 3. Minimum observability to add (proposed — not applied)

1. **Blackbox/uptime checks** (external, e.g. from a second host or a SaaS
   monitor) on:
   - `GET https://roadwisefleet.com/` → `200`
   - `GET https://roadwisefleet.com/pilot/` → `200` + `X-Robots-Tag`
   - `GET https://roadwisefleet.com/api/trips` → `401` (a `502` means the API is
     down; a `200` would be a security problem)
   - `GET https://roadwisefleet.com/api/waitlist` → `404` + `access-control-allow-origin`
   - alert on non-2xx/401 or on latency regression.
2. **Readiness endpoint** `GET /health/ready` that pings Postgres + Redis; point
   monitoring and the deploy gate at it. *(developer — app code)*
3. **Backup freshness alert**: alert if `roadwise-pg-backup.service` has not
   succeeded in the last 26 h (timer is 24 h).
4. **Host resource thresholds**: disk (`df -h /`), memory (`free -m`), and load
   (`uptime`). Baseline 2026-09-22: `/` 14G/40G (37% used); `/tmp` tmpfs 1.5G/1.9G
   (79% — worth watching).
5. **Log-based alert** on nginx `5xx` rate and on `roadwise-api` restart loops.

Alert delivery: to the ops mailbox; no credential values in any alert body.

## 4. Restore drill (proposed procedure — needs root + a scratch DB)

Run quarterly; record the date and result in this file. Never restore over the
live volume.

```bash
# 1. list backups and pick the newest (on host, as root)
sudo ls -l /var/backups/roadwisefleet/postgres/

# 2. restore into a scratch container/DB, never over roadwise-pgdata
podman run --rm -d --name rwf-restore-test -p 127.0.0.1:5433:5432 \
  -e POSTGRES_PASSWORD=<scratch-only> docker.io/library/postgres:17-alpine
# 3. load the dump and sanity-check row counts
#    (exact command depends on the dump format written by roadwise-pg-backup.sh)
# 4. tear down
podman rm -f rwf-restore-test
```

Add a weekly automated `pg_restore --list`/`psql -c 'select count(*)'` check to
the backup script so a corrupt dump fails the unit instead of only being found
during a real incident.

## 5. Status

| ID | Item | State | Owner |
|---|---|---|---|
| O1 | No metrics / alerting / uptime check for the pilot | **open — not applied** | ops + owner approval |
| O2 | `/health` is liveness-only; add `/health/ready` | open | **developer** (app code) |
| B1 | Backups scheduled + last run `status=0`, but no restore test / artifact check | **open** | ops (needs root) + owner approval |
| B2 | Backup freshness alert (26 h) | proposed | ops |
| B3 | Quarterly restore drill recorded in this file | proposed | ops |

*This runbook made no production change and changed no unit or timer.*
