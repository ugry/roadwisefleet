# Pilot observability & verified backups (elilavps2)

**Scope:** what monitoring/observability exists for the RoadwiseFleet pilot, how
to verify it, and the current *verified* state of the backups. Read-only; this
document makes no host change. **No credential values appear here.**

**Host:** elilavps2 (`51.222.139.227`). **Verified:** 2026-09-22 ~15:45 UTC and
re-verified 2026-09-22 ~16:20 UTC (task `eila/tasks#10`).

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

**Finding O3 — host memory pressure (new, 2026-09-22 16:20 UTC).** `free -m`
reports 3826 MB total, 1746 MB used, **205 MB free**, and **swap 1805 MB of
2047 MB used (88%)**. `browseros.service` alone is ~198 MB RSS with ~183 MB
swapped out. There is no alerting on this, so the first symptom would be a slow
or OOM-killed service. This is a capacity watch item, not yet an outage; add a
swap/available-memory threshold to §3 item 4 and consider a `MemoryMax=` on
`browseros.service`.

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

## 3b. Ready-to-apply artifacts (delivered in this PR — not installed)

The gaps above are implemented as reviewable files. **Nothing here is installed
on the host yet** — installing any of it is a host change requiring owner
approval and root, which this agent does not hold.

| Artifact | Installs to | Implements |
|---|---|---|
| [`scripts/pilot-uptime-check.sh`](./scripts/pilot-uptime-check.sh) | `/usr/local/bin/` | §3.1 — probes `/`, `/pilot/` (+noindex), `/api/trips`→401, `/api/waitlist`→404, loopback `/health`→200; mails `ugur@` on failure with a 60-min cooldown, plus a recovery mail |
| [`systemd/pilot-uptime-check.service`](./systemd/pilot-uptime-check.service), [`…timer`](./systemd/pilot-uptime-check.timer) | `/etc/systemd/system/` | runs the above every 5 min |
| [`scripts/pilot-backup-verify.sh`](./scripts/pilot-backup-verify.sh) | `/usr/local/bin/` | §3.3 + B1 — dump exists, non-empty, <26 h old, and `pg_restore --list`/gzip/tar integrity check; waitlist tarball freshness + `tar -tzf` |
| [`systemd/pilot-backup-verify.service`](./systemd/pilot-backup-verify.service), [`…timer`](./systemd/pilot-backup-verify.timer) | `/etc/systemd/system/` | runs the above nightly at 04:15 UTC (after both backups) |
| [`scripts/pilot-restore-drill.sh`](./scripts/pilot-restore-drill.sh) | `/usr/local/bin/` | §4 — automated restore into a throwaway container on `127.0.0.1:5433` with a runtime-random scratch password; never touches `roadwise-pgdata` |
| [`logrotate/roadwisefleet`](./logrotate/roadwisefleet) | `/etc/logrotate.d/` | §3 log hygiene — weekly, 8 rotations, `copytruncate` |

Install (as root, after approval):
```bash
install -m 0755 infra/scripts/pilot-uptime-check.sh   /usr/local/bin/
install -m 0755 infra/scripts/pilot-backup-verify.sh  /usr/local/bin/
install -m 0755 infra/scripts/pilot-restore-drill.sh  /usr/local/bin/
install -m 0644 infra/systemd/pilot-uptime-check.{service,timer}   /etc/systemd/system/
install -m 0644 infra/systemd/pilot-backup-verify.{service,timer}  /etc/systemd/system/
install -m 0644 infra/logrotate/roadwisefleet /etc/logrotate.d/roadwisefleet
systemctl daemon-reload
systemctl enable --now pilot-uptime-check.timer pilot-backup-verify.timer
```

**Acceptance mapping for `eila/tasks#10`:**

| Acceptance | Status |
|---|---|
| Simulated failure produces an alert | **artifact ready**; needs install + a supervised failure simulation (e.g. stop `roadwise-api`, confirm the mail reaches `ugur@`) — **pending host access** |
| Restore drill succeeds and is documented | **procedure + script ready**; the drill itself needs root on the host to read `/var/backups/roadwisefleet/postgres` — **not executed** |
| Offsite copies exist | **not done** — needs a destination and credentials (owner decision); local-only today |
| Logrotate verified | **partial** — an `/etc/logrotate.d/eila-agents` drop-in exists (orchestrator-owned, not readable from this account); pilot-specific drop-in added above, not yet installed |

## 4. Restore drill (procedure — now scripted in §3b)

Run quarterly; record the date and result in this file. Never restore over the
live volume. The procedure is implemented as
[`scripts/pilot-restore-drill.sh`](./scripts/pilot-restore-drill.sh):

```bash
# on host, as root — newest dump, scratch container on 127.0.0.1:5433,
# random scratch password, live volume untouched, container removed on exit
sudo /usr/local/bin/pilot-restore-drill.sh
```

It prints the restored table count and row count; copy those numbers into the
drill log below. (The `pg_restore --list` artifact check now also runs nightly —
see `pilot-backup-verify.sh` — so a corrupt dump fails a unit instead of only
being found during a real incident.)

**Drill log** (append one row per drill):

| Date (UTC) | Dump file | Tables | Rows | Result |
|---|---|---|---|---|
| — | — | — | — | *no drill run yet* |

## 5. Status

| ID | Item | State | Owner |
|---|---|---|---|
| O1 | No metrics / alerting / uptime check for the pilot | **artifacts ready (§3b), not installed** | ops + owner approval |
| O2 | `/health` is liveness-only; add `/health/ready` | open | **developer** (app code) |
| O3 | Host swap 88% used, 205 MB RAM free; no memory alerting | **open — watch** | ops (thresholds) + owner |
| B1 | Backups scheduled + last run `status=0`, but no restore test / artifact check | **artifacts ready (§3b), not installed; no drill run** | ops (needs root) + owner approval |
| B2 | Backup freshness + integrity alert | **scripted (§3b)** | ops |
| B3 | Quarterly restore drill recorded in this file | **scripted (§3b)**, first drill pending host access | ops |
| B4 | Offsite copy of pg dump + waitlist JSONL | **not done** — needs destination + credentials | owner decision |

**Backup re-verification (2026-09-22 ~16:20 UTC, read-only):**
`roadwise-pg-backup.timer` `enabled`, `active (waiting)`, next trigger
2026-09-23 03:15 UTC; `roadwise-pg-backup.service` last run 2026-09-22 03:15:14 UTC
**`status=0/SUCCESS`** (Mem peak 60.3M). `roadwisefleet-backup.timer` `enabled`,
`active (waiting)`, next trigger 2026-09-23 03:30 UTC. Artifact-level check still
**not possible** from this account (`/var/backups/roadwisefleet/postgres` is
`Permission denied`), so the backup remains *green by exit code only* until the
drill in §4 runs.

**Resource baseline (2026-09-22 ~16:20 UTC):** `/` 14G/40G (38% used);
RAM 3826 MB total / 205 MB free; swap 2047 MB total / **1805 MB used (88%)**.

*This runbook made no production change and changed no unit or timer.*
