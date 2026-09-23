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

**Ownership proposal:** DevOps owns *check definitions + thresholds* (T1–T8);
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
