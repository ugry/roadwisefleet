# Host public-listener inventory & closure plan (elilavps2)

**Scope:** which TCP ports on the RoadwiseFleet VPS are bound to a public
(`0.0.0.0` / `[::]` / `*`) address, which are loopback-only, and how to close the
ones that should not be public. **No host change is made by this document** — it
is the reviewed plan for a change that needs owner approval and host access.

**Host:** elilavps2 (`51.222.139.227`). **Verified:** 2026-09-22 ~15:45 UTC, read-only;
re-verified 2026-09-22 ~16:20 UTC; re-verified again **2026-09-22 18:05 UTC** after the
16:25 UTC operator reboot (task `eila/tasks#9`).

**Related:** [`pilot-exposure.md`](./pilot-exposure.md) (public HTTP surface),
[`pilot-db.md`](./pilot-db.md) (Postgres/Redis), [`pilot-observability.md`](./pilot-observability.md).

---

## 1. Inventory (`ss -ltn`, re-verified 2026-09-22 18:05 UTC)

| Bind | Port | Owner (§3) | Assessment |
|---|---|---|---|
| `0.0.0.0` / `[::]` | 22 | sshd | expected (SSH) |
| `0.0.0.0` / `[::]` | 80, 443 | nginx | expected (the only intended public service) |
| `0.0.0.0` / `[::]` | **5355** | `systemd-resolve` (LLMNR) | **unexpected** — link-local discovery protocol, no business on a public VPS |
| `*` (v4+v6) | **3000** | `gitea` | **unexpected public** — meant for the nginx proxy only; firewall-dropped since 16:25, still bound `0.0.0.0` (H1 residual) |
| `0.0.0.0` | **9000, 9001** | `browseros` (CDP) | **unexpected public** — same residual |
| `0.0.0.0` | **9200** | `browseros_server` (MCP) | **unexpected public** — same residual |
| `*` (v4+v6) | **9100** | `node_exporter` | **new 2026-09-22** (monitoring stack, board #10); UFW-restricted to elilavps1 — not for the world |
| `127.0.0.1` | 8080 | pilot API | correct (loopback) |
| `127.0.0.1` | 8787 | legacy waitlist | correct |
| `127.0.0.1` | 5432 | pilot Postgres | correct |
| `127.0.0.1` | 5433 | restore-drill scratch port | correct — matches `pilot-restore-drill.sh` |
| `127.0.0.1` | 6379 | pilot Redis | correct |
| `127.0.0.1` | 8008 | Synapse (Matrix) | correct — `Server: Synapse/1.161.0` |
| `127.0.0.1` | 2586, 8877, 9101 | internal services | correct (loopback) |
| `127.0.0.1` / `127.0.0.53` / `127.0.0.54` | 25, 53 | MTA + stub resolver | correct |

**Finding H1 (residual):** 3000, 9000, 9001, 9200, 5355 and (new) 9100 are still
**bound** to public addresses. Since the 16:25 UTC reboot the UFW filter drops
them at the packet level (§2), but the binds themselves are unchanged — a flushed
or bypassed firewall re-exposes them. That is why task #9 stays **open** for the
loopback-rebind step.

> **Provenance.** The bind list is my own `ss -ltn` (2026-09-22 18:05 UTC). The
> **owner** column is the overseer's `sudo ss -ltnp` read (Victor, board #9,
> 2026-09-22) — my account sees no process names without root and I hold no
> `sudo`, so I could not independently re-derive it. Labelled as third-party
> evidence throughout.

## 2. Packet filter (finding H2) — RESOLVED at the network level

| Firewall | State (2026-09-22 18:05 UTC) |
|---|---|
| `ufw` | **`active (exited)` + enabled** — started 16:25:35 UTC |
| `nftables` | installed, disabled |
| `firewalld` | not installed |

`systemctl status ufw.service` (my own read, 18:05 UTC) shows
`Active: active (exited) since Tue 2026-09-22 16:25:35 UTC`. The ruleset had been
written/enabled since 2026-08-26 but the service was never started, so the
**16:25:38 UTC operator reboot** activated a long-dormant filter. Per the overseer
the live policy is default-deny incoming with 22/80/443 + ICMP allowed, plus
node_exporter 9100 allowed from elilavps1 only. No reviewed ruleset was applied
by the workforce; the only host change was the operator reboot.

**Limits of this verification (important):**
- `/etc/ufw/user.rules` is root-only (`0640`) and my sandbox cannot read outside
  the workspace, so I could **not** diff the live rule list against the intended
  state. `ls -l /etc/ufw` shows `user.rules` mtime **17:45 UTC** — i.e. modified
  after the reboot — which I cannot inspect.
- I have **no second vantage point**. My `curl` probes to `51.222.139.227:3000`
  run *on elilavps2 itself* and traverse loopback, so they returned `200` and
  prove nothing about external reachability. The external-closure evidence is the
  overseer's probe from elilavps1 (17:14 UTC: 3000/9000/9001/9200/5355
  closed/filtered, 443 open), which I cannot reproduce from here.

So H2 is resolved **by the operator reboot**, verified by me only to the extent
that `ufw.service` is active; the rule content and external closure rest on the
overseer's evidence.

## 3. Port owners (identified 2026-09-22)

| Port | Owner (process) | Intended consumer | Action |
|---|---|---|---|
| 3000 | `gitea` (pid 1285) | nginx → `gitea.elilaltd.com` | rebind to `127.0.0.1`; keep the nginx proxy working |
| 9000, 9001 | `browseros` (pid 1490, CDP) | BrowserOS / agent tooling | rebind to `127.0.0.1` |
| 9200 | `browseros_server` (pid 1557, MCP) | BrowserOS MCP | rebind to `127.0.0.1` |
| 5355 | `systemd-resolve` (pid 420) | LLMNR — nothing | `LLMNR=no` in `/etc/systemd/resolved.conf` |
| 9100 | `node_exporter` | VictoriaMetrics on elilavps1 | keep; UFW-restrict to elilavps1 (already live) |

Source: overseer `sudo ss -ltnp` (Victor, board #9). My unprivileged `ss -ltnp`
returns no process names and I hold no `sudo`, so I reproduced only what I can see
myself (the bind list, §1) and label the owner column as third-party evidence.

Fingerprints I could take myself (loopback `HEAD`, read-only, 18:03 UTC): 3000 →
`200`, no `Server` header (consistent with Gitea); 9200 → `404` with
`Access-Control-Allow-Credentials: true`; 9000 → same `404` shape (same
framework); 9100 → `200 text/html` on `/` and `200 text/plain; version=0.0.4` on
`/metrics` (node_exporter landing page — independently corroborates the owner map).

> Do not close a listener before its owner is known — closing the wrong one can
> break another team's service. The owners are now known, so step 1 (firewall) is
> safe; the rebind in step 2 still needs the owning team's change window.

## 4. Closure plan (status: step 1 live; step 2 open)

Order matters: identify, then restrict, then verify. Step 0 is done and step 1 is
live (activated by the operator reboot); step 2 is the open residual.

**Step 0 — identify — DONE 2026-09-22.** Owners in §3, via the overseer's
`sudo ss -ltnp`.

**Step 1 — default-deny inbound firewall — LIVE since 2026-09-22 16:25 UTC.**
The dormant ruleset activated on reboot; the intended policy (default-deny
incoming, allow 22/80/443 + ICMP, node_exporter 9100 from elilavps1 only) matches
[`firewall/ufw-pilot.sh`](./firewall/ufw-pilot.sh). **Do not re-apply blindly**:
`user.rules` was modified at 17:45 UTC and I could not read the live list to diff
it. Run `sudo firewall/ufw-pilot.sh status` first; `apply` is now an idempotent
re-assert and warns that ufw is already active. `rollback` disables *the only
packet filter on the host* and re-exposes every port below — break-glass only,
inside an approved change window, followed by a re-apply.

**Step 2 — defence in depth: rebind the services.** For each identified service
that is only consumed locally, bind it to `127.0.0.1` (or a private interface)
instead of `0.0.0.0`. For podman/docker, publish on loopback (`-p
127.0.0.1:PORT:PORT`) and restart the owning unit. This survives a firewall being
flushed or bypassed.

**Step 3 — LLMNR off.** If nothing needs it:
```bash
# /etc/systemd/resolved.conf  ->  LLMNR=no
sudo systemctl restart systemd-resolved
```
(5355 is a link-local discovery protocol; it should not be exposed on a
public-internet VPS.)

**Step 4 — verify (read-only):**
```bash
ss -ltn | grep -vE '127\.0\.0\.1|\[::1\]'     # only 22/80/443 (+9100 from elilavps1) public
curl -sI http://<public-ip>:3000/   # expect timeout/refused
curl -sI https://roadwisefleet.com/ && curl -sI https://roadwisefleet.com/pilot/  # still 200
```
Run these from a **different host** (elilavps1) — from elilavps2 itself they
traverse loopback and do not prove external closure.

**Step 5 — make it permanent:** the reviewed rule set is
[`firewall/ufw-pilot.sh`](./firewall/ufw-pilot.sh) (`apply` / `status` /
`rollback`) with its own [`firewall/README.md`](./firewall/README.md) — owned
configuration instead of a hand edit, the same treatment the nginx stopgap got.
**Reconciled 2026-09-22 18:05 UTC** with the live, now-active UFW (see §4 step 1).

## 5. Status

| ID | Item | State | Owner |
|---|---|---|---|
| H1 | Close public listeners 3000, 9000/9001, 9200, 5355 (+9100 for the world) | **open — residual: firewall drops them, but they are still bound `0.0.0.0`; rebind pending** | ops + owner approval (host access) |
| H2 | No host firewall active | **RESOLVED 2026-09-22 16:25 UTC** — ufw active + enabled (operator reboot activated the dormant ruleset) | operator |
| H3 | Identify owners of the four HTTP ports before closing | **RESOLVED 2026-09-22** — owner map in §3 (overseer `sudo ss -ltnp`) | overseer |
| H4 | Persist firewall rules as reviewed config in `infra/` | **artifact reconciled** — [`firewall/ufw-pilot.sh`](./firewall/ufw-pilot.sh); not re-applied | ops + owner approval |

**Re-verification (2026-09-22 18:05 UTC, read-only, post-reboot):** `ss -ltn`
still shows `3000` (`*`), `9000`, `9001`, `9200`, `5355`, and **new `9100`**
(node_exporter, added by the monitoring deployment) bound to public addresses;
`8080`, `8787`, `5432`, `5433`, `6379`, `8008`, `2586`, `8877`, `9101`, `25`, `53`
loopback-only; `22`, `80`, `443` public as intended. `systemctl status ufw.service`
→ **`active (exited)` since 16:25:35 UTC**, so H2 no longer holds. `free` → swap
**0 / 2047 MB used**, RAM available 8.7 GB (was 88 % swap used, 205 MB free) —
**O3 resolved**. Backup timers survived the reboot: `roadwise-pg-backup.timer`
next 2026-09-23 03:15 UTC, `roadwisefleet-backup.timer` next 2026-09-23 03:30 UTC.

**What I could not verify myself:** the live rule list (root-only `user.rules`),
and external closure (no second vantage point — my probes from elilavps2 traverse
loopback). Both rest on the overseer's evidence and are labelled as such.

*This runbook made no production change. Applying §4 is a production change and
requires explicit owner approval plus host access, which this agent does not
hold.*
