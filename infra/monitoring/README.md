# Monitoring & alerting — stack, config-as-code status, thresholds

**Scope:** the EILA monitoring stack (Gatus / VictoriaMetrics / node_exporter /
Grafana / alert relay), what of it is config-as-code, and the thresholds and
checks the DevOps role owns. **No credential values appear here.**

**Related:** [`../pilot-observability.md`](../pilot-observability.md) (pilot
signals + verified backup state), [`runbook.md`](./runbook.md) (operations:
silence a check, alert round-trip, rotate the relay token, restore from a dump).

---

## 1. Deployed stack (inventory)

**Provenance:** the deployment account in §1 is **not first-hand** — it is the
owner's report in `eila/tasks#10` (ugur, 2026-09-22). The rows marked
*verified here* were re-checked by me (Lance) with read-only probes on
2026-09-23 16:30 UTC; see §4. The stack runs on **elilavps1**; I have no shell or
file access to that host.

| Component | Version / endpoint | Notes | Source |
|---|---|---|---|
| Gatus | v5.36, `https://status.elilaltd.com` | 15 checks: roadwisefleet.com + pilot, gitea, matrix, mail admin, mta-sts, SMTP/465/IMAPS/POP3S/Sieve ports, pings + ssh on both VPSes, grafana, TLS expiry > 7d | owner report; endpoint **verified here** (200) |
| VictoriaMetrics | v1.152 | 30 s scrape, 180 d retention, on elilavps1 | owner report |
| node_exporter | `:9100` on elilavps1 **and** elilavps2 | elilavps2:9100 restricted in UFW to elilavps1 | owner report; `127.0.0.1:9100/metrics` on elilavps2 **verified here** (200) |
| Grafana | 13.2, `https://grafana.elilaltd.com` | VictoriaMetrics datasource + "Node Exporter Full" dashboard, provisioned as code | owner report; endpoint **verified here** (302 → `/login`) |
| Alert relay | `127.0.0.1:9099` (elilavps1) | → Matrix room `#eila-alerts:elilaltd.com` **and** mail to `ugur@` | owner report; not reachable/verifiable from here |
| Metric checks cron | `*/5` | disk > 85 %, mem > 92 %, node down, read-only filesystem → relay | owner report |
| Dead-man watchdog | elilavps2 → status.elilaltd.com every 5 min | alerts straight to Matrix if elilavps1 dies | owner report |

## 2. Config-as-code status — **BLOCKED (owner/orchestrator input needed)**

Owner ask on `eila/tasks#10`: *"Move the configs into git (`infra/monitoring/`)"*.

**Status: not done — and it cannot be done by transcription.** The stack configs
live on **elilavps1**, to which I have no access; my shell can only read inside my
own workspace (reads outside it are denied by policy), and there is no copy of
these files in any repo I can read (`infra/monitoring/` did not exist before this
commit — this file is the first content in it).

Writing "mirrors" of files I have never read would be inventing infrastructure, so
I have deliberately **not** done it. To close this item, one of these is needed:

1. the files pasted into a `eila/tasks#10` comment / PR (as was done for the
   systemd unit mirrors in `../systemd/`), **or**
2. a checkout or repo path on the host I can read, **or**
3. an access request approving read access to those paths on elilavps1.

Files required (value-free; strip tokens/passwords before pasting):

| File | Why |
|---|---|
| Gatus `config.yaml` | 15 checks + conditions + alerting block |
| VictoriaMetrics / vmagent scrape config | scrape targets + intervals, retention |
| Grafana provisioning (datasources YAML + dashboard JSON/provisioner) | "as code" claim + restore |
| Alert relay config/script + its systemd unit | alert routing, cooldown, token **name only** |
| Dead-man watchdog script + unit | who alerts if elilavps1 dies |
| Metric-checks cron entry (`*/5`) | thresholds in §3 |
| elilavps1 nginx vhosts for `status/` + `grafana/` | TLS + proxy config |

**Until this lands, every change to these checks is manual and unaudited** — that
is the risk this item exists to remove, and it is why the runbook
([`runbook.md`](./runbook.md)) says to record every manual change on the board.

## 3. Thresholds & checks — owned by DevOps (proposed; **not applied**)

"Present" = the value the owner reported as live. "Proposed" = my recommendation,
for the owner/orchestrator to merge into the config in §2. Nothing in this table
was applied by me.

| # | Signal | Present | Proposed | Rationale |
|---|---|---|---|---|
| T1 | Disk `/` on both VPSes | alert > 85 % | keep > 85 %, **add growth-rate** alert (> 5 %/24 h) | elilavps2 `/` baseline 17 % (16 G/99 G) — a fast-fill would still be caught by 85 %, but growth is the earlier signal |
| T2 | Memory | alert > 92 % | keep; **add swap > 50 % used** and **available < 1 GB** | finding O3 (88 % swap, 205 MB free on 2026-09-22) crossed neither the 92 %-mem nor any swap threshold, yet was a capacity incident |
| T3 | node down | alert | keep | — |
| T4 | Read-only filesystem | alert | keep | — |
| T5 | TLS expiry | > 7 d | keep, **add domain-expiration checks** for `roadwisefleet.com` **and** `mail.elilaltd.com` (warn 30 d / alert 14 d) | certbot renewal is unattended; a renewal failure should alert before the 7-day edge |
| T6 | pg_dump heartbeat | **none** | alert if `roadwise-pg-backup.service` has not exited `0` in the last **26 h** (timer is 24 h) | today the only failure signal is a human reading `systemctl status`; implemented as `../scripts/pilot-backup-verify.sh` + `../systemd/pilot-backup-verify.{service,timer}` (**ready-to-apply, not installed** — `systemctl status pilot-backup-verify.timer` → *Unit could not be found*) |
| T7 | Pilot uptime (external) | Gatus checks exist | keep; they supersede the in-host `../scripts/pilot-uptime-check.sh` for reachability, which stays useful for the loopback/`noindex` details Gatus cannot see | avoid duplicate alert noise — one alert per failure |
| T8 | Flapping | not specified | require **3 consecutive failures** before alerting, recovery notification **on**, mail cooldown **60 min** | one-off 5xx/timeout bursts on a single VPS produce false pages; the 60-min cooldown is already used by `pilot-uptime-check.sh` |
| T11 | API 5xx rate | **none** (a forced 5xx is invisible) | alert when **≥ 3 requests and ≥ 5 %** of the last **300 s** are 5xx, or **≥ 1** upstream 502/503/504 with ≥ 3 5xx; include the newest nginx error-log line | `../scripts/pilot-api-error-watch.sh` (signal `http-5xx`). Ratio **and** count together: a single 500 on a quiet pilot is not an incident, a burst is |
| T12 | API process down / restarting | **none** | alert after **2 consecutive** bad checks; a restart is reported only at **≥ 3 restarts per interval** (a deliberate `systemctl restart` is not an alert); a down API is one alert, not one per symptom | `CONSEC_FAILS=2` × the 2-minute timer ⇒ a stopped API alerts in ~4 min, which is the #44 acceptance |
| T13 | Pilot latency | **none** | alert when `https://roadwisefleet.com/pilot/` exceeds **3 s** on **3 consecutive** checks | latency creep is the cheapest early warning of a saturated VPS; reachability itself stays with Gatus (T7) |

**Ownership proposal:** DevOps owns *check definitions + thresholds* (T1–T13);
alert *delivery* (relay + Matrix bot) stays with the orchestrator/owner, because
the bot token is not my credential.

## 4. Read-only evidence from my vantage point (2026-09-23 16:30 UTC)

| Probe | Result |
|---|---|
| `https://status.elilaltd.com/` | `200`, `server: nginx`, `text/html` (Gatus) |
| `https://grafana.elilaltd.com/` | `302 → /login`, `x-frame-options: deny`, `x-content-type-options: nosniff` |
| `http://127.0.0.1:9100/metrics` (elilavps2) | `200`, `text/plain; version=0.0.4` (node_exporter) |
| `https://gitea.elilaltd.com/` | `200` |
| `https://roadwisefleet.com/` | `200`; **no HSTS/nosniff/X-Frame-Options/Referrer-Policy/CSP** (PR #13 config merged but **not yet applied** — board #7) |
| `https://roadwisefleet.com/pilot/` | `200` + `X-Robots-Tag: noindex, nofollow` |
| `https://roadwisefleet.com/track/abc` | `404` (expected until the `/track/` block is applied — board #7 / requests #13) |
| `https://www.roadwisefleet.com/` | `200` (no www→apex 301 yet; board #7) |
| `http://127.0.0.1:8080/health` | `200`, `application/json` (pilot API, loopback) |
| `roadwise-pg-backup.timer` | `enabled`, `active (waiting)`, next **2026-09-24 03:15 UTC** |
| `roadwise-pg-backup.service` | last run **2026-09-23 03:15:02 UTC, `status=0/SUCCESS`** (13 h ago) |
| `roadwisefleet-backup.timer` | `enabled`, `active (waiting)`, next **2026-09-24 03:30 UTC** |
| elilavps2 resources | RAM 11.7 GB total / 7.9 GB available; **swap 0 / 2047 MB**; `/` 16 G/99 G (17 %) |

**Not verifiable from here (stated, not hidden):** the alert round-trip through
the relay (needs the Matrix bot token), the live Gatus check list, the
VictoriaMetrics/Grafana provisioning, and all elilavps1 file state (§2).

## 5. API error visibility (board #44, FAv1-F9d)

**Problem:** a 5xx on the pilot API is invisible unless a human happens to hit it
— the 1 MB upload rejection sat in the nginx log unnoticed. Gatus (T7) proves
*reachability*; nothing watched *what the API answered*.

**Delivered as config-as-code (artifact only, nothing installed):**

| File | Role | Destination |
|---|---|---|
| `../scripts/pilot-api-error-watch.sh` | signals `api-up`, `http-5xx`, `latency`, `log-unreadable`; one alert per incident, one recovery, per-signal 60-min cooldown; `--self-test` runs in CI | `/usr/local/bin/` |
| `../systemd/pilot-api-error-watch.service` | oneshot; runs as **root** because the nginx logs are `0640 root:adm` (an unprivileged run would go blind — hence the `log-unreadable` signal instead of silence) | `/etc/systemd/system/` |
| `../systemd/pilot-api-error-watch.timer` | every **2 minutes** (T12 needs ≤ 5 min detection) | `/etc/systemd/system/` |

**Alert path — reused, not rebuilt:** the script calls the deployer's existing
notifier `../deploy/roadwise-notify.sh` (`alert <message>`; Matrix is the
transport that works from elilavps2, the relay is loopback-only on elilavps1). If
the notifier is missing or has no transport it logs **`alert NOT delivered`**
loudly — it never pretends to page. One signal, one message: while `api-up` is
bad, the 5xx and latency signals are suppressed because the outage is their cause.

**Install (owner window, root on elilavps2):**

```bash
sudo install -m 0755 infra/scripts/pilot-api-error-watch.sh /usr/local/bin/
sudo install -m 0644 infra/systemd/pilot-api-error-watch.service \
                    infra/systemd/pilot-api-error-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo /usr/local/bin/pilot-api-error-watch.sh status     # no state yet = never ran
sudo systemctl start pilot-api-error-watch.service      # one manual run, read the journal
sudo /usr/local/bin/roadwise-notify.sh alert "TEST — API error watch install verification, please ignore"
sudo systemctl enable --now pilot-api-error-watch.timer
```

**Acceptance mapping (task #44):**

| Criterion | Status |
|---|---|
| A forced 500 raises **exactly one** deduplicated alert through the existing path (Matrix `#eila-alerts` + owner mail) | **not demonstrated live** — the *decision* is CI-proven (`--self-test`: one alert per incident, dedup while it persists); delivery needs the install window + the notifier transport |
| Recovery is announced | **not demonstrated live** (logic unit-tested: exactly one recovery message) |
| A stopped API raises an alert within 5 minutes | **not demonstrated live** — designed 2-min timer × 2 consecutive checks ≈ 4 min |
| The check does not spam during a restart | **not demonstrated live** (logic unit-tested: a single restart never alerts; only ≥ 3 restarts per interval do) |

**Open items:** B1 install window + owner merge (the units are protected paths);
B2 notifier transport configured; B3 the live nginx `log_format`/log clock is not
readable from my vantage point — the script assumes the standard `combined` format
in **UTC** and, if the 300 s window matches nothing while the file has lines,
logs a loud WARN and falls back to the last 2000 lines rather than reporting a
false "all clear".
