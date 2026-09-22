# Host public-listener inventory & closure plan (elilavps2)

**Scope:** which TCP ports on the RoadwiseFleet VPS are bound to a public
(`0.0.0.0` / `[::]` / `*`) address, which are loopback-only, and how to close the
ones that should not be public. **No host change is made by this document** — it
is the reviewed plan for a change that needs owner approval and host access.

**Host:** elilavps2 (`51.222.139.227`). **Verified:** 2026-09-22 ~15:45 UTC, read-only.

**Related:** [`pilot-exposure.md`](./pilot-exposure.md) (public HTTP surface),
[`pilot-db.md`](./pilot-db.md) (Postgres/Redis), [`pilot-observability.md`](./pilot-observability.md).

---

## 1. Inventory (`ss -ltn`, 2026-09-22 15:45 UTC)

| Bind | Port | Reachability | Assessment |
|---|---|---|---|
| `0.0.0.0` / `[::]` | 22 | public | expected (SSH) |
| `0.0.0.0` / `[::]` | 80, 443 | public | expected (nginx — the only intended public service) |
| `0.0.0.0` / `[::]` | **5355** | public | **unexpected** — LLMNR (`systemd-resolved`); local-discovery protocol, no business on a public VPS |
| `*` (v4+v6) | **3000** | public | **unexpected** — unidentified HTTP service (see §2) |
| `0.0.0.0` | **9000** | public | **unexpected** — unidentified HTTP service (see §2) |
| `0.0.0.0` | **9001** | public | **unexpected** — unidentified (see §2) |
| `0.0.0.0` | **9200** | public | **unexpected** — unidentified HTTP service (see §2) |
| `127.0.0.1` | 8080 | loopback | pilot API — correct |
| `127.0.0.1` | 8787 | loopback | legacy waitlist — correct |
| `127.0.0.1` | 5432 | loopback | pilot Postgres — correct |
| `127.0.0.1` | 6379 | loopback | pilot Redis — correct |
| `127.0.0.1` | 8877, 9101 | loopback | unidentified internal services — correct (loopback) |
| `127.0.0.1` / `127.0.0.53` / `127.0.0.54` | 25, 53 | loopback | MTA + stub resolver — correct |

**Finding H1:** ports **3000, 9000, 9001, 9200 and 5355** are bound to public
addresses on a host that should only expose `22`, `80`, `443`.

## 2. No host firewall (finding H2)

| Firewall | State (2026-09-22) |
|---|---|
| `ufw` | installed, **enabled at boot, but `inactive (dead)`** |
| `nftables` | installed, **disabled, `inactive (dead)`** |
| `firewalld` | not installed |

So every `0.0.0.0`/`[::]` binding in §1 is reachable from the internet. There is
no packet filter to compensate for a service that binds too widely.

## 3. What the unidentified services are (limits of this check)

`ss -ltnp` returned **no process names** (unprivileged user), and no systemd unit
matched the obvious names (`grafana-server`, `minio`, `elasticsearch`). They are
therefore most likely containers (podman/docker) or services started by tooling
outside systemd. Loopback `HEAD` fingerprints (read-only, `curl -sI`):

| Port | Response |
|---|---|
| 3000 | `200 OK`, no `Server` header, `Content-Type` not set on HEAD |
| 9200 | `404 Not Found`, `Access-Control-Allow-Credentials: true`, `Vary: Origin`, `text/plain` |
| 9000 | identical `404` shape to 9200 (same framework) |
| 9001 | no response to `HEAD` from loopback |
| 5355 | no HTTP — this is LLMNR (`systemd-resolved`), confirmed by the unit being active |

> The exact owners must be identified **on the host** (`sudo ss -ltnp`,
> `sudo podman ps`, `systemctl list-units`) before anything is closed. Do not
> guess from the outside — closing the wrong listener could break another team's
> service.

## 4. Closure plan (proposed — requires owner approval + host access)

Order matters: identify, then restrict, then verify. Nothing here is applied yet.

**Step 0 — identify (read-only, on host):**
```bash
sudo ss -ltnp | grep -E ':(3000|9000|9001|9200|5355)\b'
sudo podman ps --format '{{.Names}}\t{{.Ports}}'
```

**Step 1 — preferred: default-deny inbound firewall.** Keep only 22/80/443
reachable; this closes 3000/9000/9001/9200/5355 in one reversible step:
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose        # verify
```
Rollback: `sudo ufw disable` (or `ufw delete` the rules). Note `ufw` is already
`enabled` at boot, so this only needs the rules + activation.

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
ss -ltn | grep -vE '127\.0\.0\.1|\[::1\]'     # only 22/80/443 (+ any approved) public
curl -sI http://<public-ip>:3000/   # expect timeout/refused
curl -sI https://roadwisefleet.com/ && curl -sI https://roadwisefleet.com/pilot/  # still 200
```

**Step 5 — make it permanent:** record the firewall rules in this repo (e.g. an
`infra/firewall/` drop-in) so the state is owned configuration, not a hand edit —
the same treatment the nginx stopgap got.

## 5. Status

| ID | Item | State | Owner |
|---|---|---|---|
| H1 | Close public listeners 3000, 9000/9001, 9200, 5355 | **open — not applied** | ops + owner approval (host access) |
| H2 | No host firewall active | **open — not applied** | ops + owner approval |
| H3 | Identify owners of the four HTTP ports before closing | **open** | ops (needs `sudo` on host) |
| H4 | Persist firewall rules as reviewed config in `infra/` | proposed | ops |

*This runbook made no production change. Applying §4 is a production change and
requires explicit owner approval plus host access, which this agent does not
hold.*
