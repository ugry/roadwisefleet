# Monitoring runbook — operations

**Audience:** DevOps (Lance). **Scope:** day-to-day operation of the EILA
monitoring stack documented in [`README.md`](./README.md). **No credential
values appear here** — token rotation below is a *procedure*, and the values stay
on elilavps1 / in the secret store.

**Golden rule:** I hold no production access and no credential for the monitoring
stack. Everything in this runbook that touches elilavps1 is either (a) a
read-only probe I run myself, or (b) a procedure that the owner/orchestrator
executes, which I then verify. Nothing is applied on my initiative.

---

## 1. Routine checks (read-only, safe, do these first)

Run from my workspace; all are probe-only.

| Check | Command | Expected |
|---|---|---|
| Status page up | `curl -sI https://status.elilaltd.com/` | `200` |
| Grafana up | `curl -sI https://grafana.elilaltd.com/` | `302 → /login` + `x-frame-options: deny` |
| node_exporter (elilavps2) | `curl -sI http://127.0.0.1:9100/metrics` | `200 text/plain; version=0.0.4` |
| Backups scheduled | `systemctl status roadwise-pg-backup.timer` | `active (waiting)`, next trigger ~03:15 UTC |
| Last backup result | `systemctl status roadwise-pg-backup.service` | `status=0/SUCCESS`, < 26 h ago |
| Host capacity | `free -m`, `df -h /` | swap 0 used; `/` < 85 % |
| Pilot surface | `curl -sI https://roadwisefleet.com/` and `/pilot/` | `200` (+ noindex on `/pilot/`) |
| Public exposure | `ss -ltn` | see `../host-exposure.md` §3 (3000/9000/9001/9200/5355 still bound — firewall-dropped) |

If a check fails: (1) confirm it is not my vantage point (re-run, check another
endpoint); (2) check `systemctl status` for the backing unit; (3) report on the
board with the exact command + output; (4) **do not** apply a fix to the host —
that needs owner approval (see §6).

## 2. Silence / extend a check

A silence is a **transient, recorded** state — never a permanent disable.

1. Reason first: is a maintenance window planned, or is the check flapping?
   Flapping is fixed by thresholds (§
   [`README.md`](./README.md) §3 T8), not by muting.
2. In Gatus (`https://status.elilaltd.com`) open the failing endpoint and
   **disable/pause the specific check** (not the whole group).
3. Post a board comment on `eila/tasks#10` (or the active task) recording: which
   check, why, **who approved**, and the **expiry** it must be re-enabled by.
4. Re-enable and confirm the check goes green; comment again.
5. If the silence > 24 h, it needs an owner decision — a muted check is an
   unmonitored production surface.

If the change was made in the *live* config on elilavps1 rather than the UI, it
must be reflected in the config file that gets committed under `infra/monitoring/`
once §2 of `README.md` is unblocked — otherwise the next config reload silently
reverts the silence.

## 3. Alert round-trip test (the "simulated failure" drill)

Goal: prove an alert actually reaches `#eila-alerts` (Matrix) **and** `ugur@`
(email). **Never** test by taking down a production service.

Status 2026-10-27: the chain is wired and every check evaluates healthy, but
**no alert has ever been delivered** (`/opt/monitoring/metric-alerts.log` holds
only heartbeats, Gatus has no alert history). That is the acceptance gap on
`eila/tasks#10` — a monitoring stack that has never fired is an untested one.

### 3.1 The canary (why not a real check)

Stop a real unit and you are breaking production to test monitoring. Instead the
drill flips a **dedicated canary** that serves nothing:

| Piece | Path | What it is |
|---|---|---|
| Canary unit | `alert-canary/eila-alert-canary.service` | `python3 -m http.server` on `127.0.0.1:8099`, `DynamicUser`, hardened, `Restart=no` (so a stop stays stopped) |
| Gatus check | `alert-canary/gatus-check.yaml` | `tcp://127.0.0.1:8099`, `[CONNECTED] == true`, failure-threshold 3 |
| Drill driver | `../scripts/alert-drill.sh` | `--status` / `--fail` / `--recover` / `--apply` / `--self-test` |

The alert travels the real path: Gatus evaluation → its configured provider
(relay) → Matrix room + `ugur@`. No nginx, no database, no pilot unit is touched.

### 3.2 Procedure (elilavps1, root — owner/orchestrator or Team Leader)

I do not hold elilavps1 access, so **I cannot run these steps**; I own the
artifacts, the CI proof that the driver behaves (`self-test`, `infra-scripts`
job) and the recording of the result.

1. Precondition: `bash infra/scripts/alert-drill.sh --status` → canary
   `active (running)`, and the check green on the status page.
2. Inject the failure: `bash infra/scripts/alert-drill.sh --fail --apply`
   (a dry run without `--apply` changes nothing and exits 2).
   The script refuses if the canary is **already** stopped — a second stop proves
   nothing — and it refuses any unit other than the canary.
3. Within ~90–120 s (3 × 30 s threshold) expect **one** alert in
   `#eila-alerts:elilaltd.com` **and one** mail to `ugur@`, naming
   `alert-drill canary` and the failing condition. Exactly one, not one per
   interval — a repeated alert is a cooldown defect, record it as such.
4. Recover: `bash infra/scripts/alert-drill.sh --recover --apply` → expect one
   recovery notice (Gatus `success-threshold: 1`).
5. Record on `eila/tasks#10`: the drill nonce printed by the script, the failure
   timestamp, the recovery timestamp, the delivered **message text** (not the
   payload's transport details, never a token) and **who** confirmed delivery in
   the room and in the mailbox. Then mark the acceptance clause satisfied.

### 3.3 What is NOT proven by this drill

* Delivery to a mailbox other than `ugur@` (the relay routes one recipient).
* The relay's own cooldown/escalation behaviour beyond "one message per
  incident" — that needs a second drill with a longer outage; record it as its
  own result rather than assuming it.
* Anything about the `metric_alerts.py` cron path (disk/mem thresholds): those
  thresholds are still proposed, not applied (`README.md` §3 T1–T13).

### 3.4 If the canary cannot be installed

The relay's own test path remains the fallback, and the in-host
`../scripts/pilot-uptime-check.sh` mails `ugur@` on failure — but **neither is a
substitute for an observed alert in the room**: until one has been seen, the
clause is unsatisfied and the task stays open.


## 4. Rotate the relay's Matrix bot token

**The token is not mine and never appears in this repo, a ticket, a chat message
or my memory files.** The procedure below is executed by the
owner/orchestrator on elilavps1; I verify the outcome.

1. Confirm a maintenance moment — rotation briefly interrupts alert delivery.
2. Create a **new** access token for the bot account (Matrix admin).
3. Replace the token value in the relay's env/secret file on elilavps1
   (mode `0600`, owned by the relay's service user). Do not pass it as a
   command-line argument (it would leak into `ps` / `systemctl status` — the same
   defect class as the old Postgres unit, see `../pilot-db.md` §7).
4. Restart the relay unit; confirm it is `active (running)` and its log shows a
   successful Matrix login (**log line only, never the token**).
5. Send one test alert (§3); confirm delivery in `#eila-alerts`.
6. **Revoke the old token** and confirm no further alerts arrive using it.
7. Record date + verification in the board comment; update this runbook if the
   file path changes.

## 5. Restore from a dump

### 5a. PostgreSQL (pilot) — drill exists, execute as root in a window

See [`../pilot-observability.md`](../pilot-observability.md) §4 and
`../scripts/pilot-restore-drill.sh`: restores the newest dump into a throwaway
container on the **first free port in 5440–5479** (`SCRATCH_PORT=auto`; it never
tries 5432/5433 — 5433 is the host `postgresql@17-main` cluster, board #62) with a
runtime-random scratch password, after bootstrapping the dump's owner roles in that
throwaway cluster. The live volume is never touched. Record
`Date | dump file | tables | rows | uploads | result` in the drill log there.
**Executed 2026-09-23/24 by the Team Leader (PASS, 25-of-25 uploads sha256 OK) —
the host run needed `SCRATCH_PORT=5434`; the artifact no longer does (board #62).**

### 5b. VictoriaMetrics / Grafana — procedure skeleton (configs unavailable)

Cannot be written accurately today: I have never read the VictoriaMetrics layout
on elilavps1 (data dir, whether dumps/backups even exist, and how Grafana
provisioning is mounted). Completing this requires the §2 files from
`README.md`, **and** an explicit answer to: *is VictoriaMetrics backed up at all?*
Today the observability stack itself appears to be single-host and unbacked-up —
that is a finding, not a documented procedure. Until then:

1. Identify the data volume and whether a dump exists (`vmbackup`/snapshot or
   none).
2. Restore from a dump into a scratch instance first; verify with a query.
3. Only then restore the live instance; re-check the Grafana datasource health.

I will not publish step-by-step commands for a layout I have not verified.

## 6. Change control & escalation

- **Any** host change (config edit, unit restart, install, firewall, rebind) needs
  **owner approval** — for the nginx/pilot work that is
  `eila/requests#6` + the change window in `eila/requests#13`. I hold no sudo.
- A red pipeline is an incident: investigate with `gh run view <id> --log-failed`,
  report, propose a fix — do not merge around it.
- Report on the board: task number, exact commands, exact output, and what I could
  **not** verify from my vantage point.
- Secrets never leave elilavps1; if a token ever appears in a log, artifact, ticket
  or email, treat it as an incident: report the *finding* (value-free) and the file
  for cleanup.

## 7. First response — the API error alert (board #44)

The alert text starts with the signal it came from. Read the signal before
touching anything; the state lives in `/var/lib/pilot-api-watch/<signal>.state`
(`<state> <last-alert-epoch> <consecutive>`), inspectable read-only with
`/usr/local/bin/pilot-api-error-watch.sh status`.

| Signal | Means | First response |
|---|---|---|
| `api-up` | `roadwise-api.service` not `active`, or loopback `/health` ≠ 200, or ≥ 3 restarts in one interval | `systemctl status roadwise-api roadwise-pg roadwise-redis`; if the unit is down, that is a production incident — **do not** restart it on my own initiative, report it and get owner approval. A restart **burst** usually means a crash loop: read `journalctl -u roadwise-api -n 100` for the reason before restarting anything (the logs name the cause; the alert does not). |
| `http-5xx` | real requests are failing — count/ratio over 300 s, with the upstream 502/503/504 count and the newest nginx error line | `/health` returning 200 with 502s upstream usually means the API process is alive but the **database or Redis** is not: `systemctl status roadwise-pg roadwise-redis`. Purely 500s point at an application defect — quote the nginx error line, the request path and the time in the report, then hand it to the dev/QA roles; I do not patch application code as a fix. |
| `latency` | `/pilot/` over 3 s for 3 checks | check capacity, not the app first: `free -m`, `df -h /`, and the swap line — a memory-pressured VPS shows up here before it shows up anywhere else. |
| `log-unreadable` | the check cannot read `access.log` and is therefore **blind** | fix the check, not the alert: confirm the unit still runs as root and the file is `0640 root:adm`. A muted/blind watchdog is worse than no watchdog — say so on the board if it lasts more than one cycle. |

Rules that apply to all four: it is **one alert per signal per hour** by design —
a repeat message means the fault is still there, not that the check is broken. If
the same signal repeats for > 2 cycles without a diagnosis, post on the board with
the exact commands + output rather than muting the alert (§2). Recovery messages
are expected and mean the signal cleared itself; they do not need a reply.
