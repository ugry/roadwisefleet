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

## 3. Alert round-trip test

Goal: prove an alert actually reaches `#eila-alerts` (Matrix) and `ugur@`
(email). **Never** test by taking down a production service.

1. Preferred: use the relay's own test path (a test alert payload) from
   elilavps1 — owner/orchestrator runs it; the token stays on that host.
2. Then verify: the message appears in `#eila-alerts:elilaltd.com` and the mail
   lands in `ugur@`. Paste the timestamp (not the payload) into the board.
3. After the stack configs are in git, add a scheduled synthetic check (a
   deliberately failing endpoint on a non-production host) so the round-trip is
   tested continuously rather than by hand.
4. Record the result in `../pilot-observability.md` §3b / the board comment.

**Alternative while the relay test is unavailable:** the in-host
`../scripts/pilot-uptime-check.sh` mails `ugur@` on failure; once installed
(`README.md` §3 T7), a *simulated* failure for it can be run in a change window
by stopping a non-critical pilot unit — with explicit owner approval and the
overseer watching.

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
container on `127.0.0.1:5433` with a runtime-random scratch password. The live
volume is never touched. Record `Date | dump file | tables | rows | result` in the
drill log there. **Not yet executed — needs root on elilavps2.**

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
