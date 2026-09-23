# Pilot observability & verified backups (elilavps2)

**Scope:** what monitoring/observability exists for the RoadwiseFleet pilot, how
to verify it, and the current *verified* state of the backups. Read-only; this
document makes no host change. **No credential values appear here.**

**Host:** elilavps2 (`51.222.139.227`). **Verified:** 2026-09-22 ~15:45 UTC,
re-verified ~16:20 UTC, and re-verified **18:04 UTC** after the 16:25 UTC operator
reboot (task `eila/tasks#10`).

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

**Finding O3 — host memory pressure — RESOLVED 2026-09-22 18:05 UTC.** The 16:25
UTC operator reboot cleared it: `free` now reports swap **0 / 2047 MB used** and
**8.7 GB available** (was 88 % swap used, 205 MB free). Keep the proposed
swap/available-memory threshold in §3 item 4 anyway — it is what would have caught
this before it became a user-visible symptom.

### 1.1 Monitoring stack deployed by the orchestrator (2026-09-22) — verified from here

Owner directive (ugur, board #10): dedicated `#eila-alerts` Matrix room, monitoring
stack on elilavps1 (Gatus + VictoriaMetrics + node_exporter + Grafana + alert
relay). I re-verified the reachable surface read-only at 18:04 UTC:

| Check | Result |
|---|---|
| `https://status.elilaltd.com/` (Gatus) | `200`, `server: nginx` |
| `https://grafana.elilaltd.com/` (Grafana) | `302 → /login`, `x-frame-options: deny`, `x-content-type-options: nosniff` |
| `127.0.0.1:9100/metrics` (node_exporter) | `200`, `text/plain; version=0.0.4` |
| `127.0.0.1:9100/` | `200 text/html` (node_exporter landing page) — corroborates the port-owner map in `host-exposure.md` §3 |
| `https://gitea.elilaltd.com/` | `200` — Gitea unaffected by the firewall activation |
| `https://roadwisefleet.com/`, `/pilot/` | `200`; `/pilot/` still `X-Robots-Tag: noindex, nofollow` |

**What I could NOT verify from here:** the alert round-trip (needs the relay + the
Matrix bot token — not my credential, I did not touch it), the Gatus check list,
and the VictoriaMetrics/Grafana provisioning (configs live on elilavps1).
**Follow-ups assigned to me on board #10 — pending, not done:** move the configs
into `infra/monitoring/`, own the thresholds/checks (certbot renewal, pg_dump
heartbeat, elilavps2 disk-growth watch), and document the runbook
(silence/extend a check, rotate the Matrix bot token, restore VM from a dump).

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
| O1 | No metrics / alerting / uptime check for the pilot | **partly resolved externally** — orchestrator deployed Gatus/VictoriaMetrics/node_exporter/Grafana + `#eila-alerts` relay on elilavps1 (§1.1); my in-host artifacts (§3b) still **not installed** | ops + owner approval |
| O2 | `/health` is liveness-only; add `/health/ready` | open | **developer** (app code) |
| O3 | Host swap 88% used, 205 MB RAM free; no memory alerting | **RESOLVED 2026-09-22 16:25 UTC** (reboot: swap 0 used, 8.7 GB available); threshold still worth adding | ops (thresholds) + owner |
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

**Resource baseline (2026-09-22 18:05 UTC, post-reboot):** RAM 11.4 GB total /
8.7 GB available; swap **0 / 2047 MB used** (was 1805 MB used at 16:20). Backup
timers survived the reboot: `roadwise-pg-backup.timer` next 2026-09-23 03:15 UTC,
`roadwisefleet-backup.timer` next 2026-09-23 03:30 UTC.

**Re-verification (2026-09-23 16:30 UTC, read-only, `eila/tasks#10`):**
`roadwise-pg-backup.service` last run **2026-09-23 03:15:02 UTC, `status=0/SUCCESS`**
(the nightly ran, so the timer re-armed) — `roadwise-pg-backup.timer`
`active (waiting)`, next **2026-09-24 03:15 UTC**; `roadwisefleet-backup.timer`
next **2026-09-24 03:30 UTC**. Artifact-level check still **not possible** from
this account (`/var/backups/roadwisefleet/postgres` → `Permission denied`) →
**still green by exit code only**. Host resources: RAM 11.7 GB total / 7.9 GB
available, swap **0/2047 MB**, `/` 16 G/99 G (17 %).

**Ready-to-apply artifacts are still NOT installed** (verified, not assumed):
`systemctl status pilot-uptime-check.timer` and `pilot-backup-verify.timer` both
return *"Unit … could not be found"*; `ls -l /etc/logrotate.d` shows no
`roadwisefleet` drop-in. Their installation remains the §3b step, gated on owner
approval + root.

**Monitoring-stack config-as-code and the owned thresholds/checks now live in
[`monitoring/README.md`](./monitoring/README.md)**, with operations in
[`monitoring/runbook.md`](./monitoring/runbook.md): the stack configs are on
elilavps1 and are **not transcribable from this account** (they need to be pasted
or made readable), and the threshold proposals (certbot/domain expiry, pg_dump
heartbeat, disk-growth watch, flap tuning) are documented there as **proposed,
not applied**.

*This runbook made no production change and changed no unit or timer.*
