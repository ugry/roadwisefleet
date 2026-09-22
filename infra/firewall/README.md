# Host firewall — reviewed config (elilavps2)

Task `eila/tasks#9` (findings H1/H2/H4 in [`../host-exposure.md`](../host-exposure.md)).

**Live state (2026-09-22 18:05 UTC): `ufw` is `active (exited)` + enabled** — the
2026-09-22 16:25:38 UTC operator reboot started the ruleset that had been dormant
since 2026-08-26. The intended policy (default-deny incoming; 22/80/443 + ICMP;
node_exporter 9100 from elilavps1 only) matches this file, so treat the script as
a **conformance re-assert, not an activation step**: run `status` and diff against
the live rules before any `apply`. The listeners **3000, 9000, 9001, 9200, 5355**
are still *bound* `0.0.0.0` and are only dropped at the packet level — a firewall
drop is not a loopback rebind (that residual keeps task #9 open).

| File | Purpose |
|---|---|
| [`ufw-pilot.sh`](./ufw-pilot.sh) | Reviewed rule set: default-deny inbound, allow 22/80/443 (+ICMP) and node_exporter 9100 from elilavps1 only. `apply` (idempotent re-assert) / `status` / `rollback` (break-glass). |

## Why config-as-code

The nginx exposure was fixed with a hand edit on 2026-09-22; that drift is exactly
what finding H4 warns about. Keeping the firewall rules here means the intended
state is reviewable in a PR, diffable, and restorable — not a shell history.

## Applying it (owner approval + host access required)

```bash
# 1. copy to the host (as today's nginx workflow does)
scp -i <key> ufw-pilot.sh debian@51.222.139.227:/tmp/ufw-pilot.sh
# 2. review the diff of intended rules vs current state
ssh -i <key> debian@51.222.139.227 'sudo /tmp/ufw-pilot.sh status'
# 3. apply
ssh -i <key> debian@51.222.139.227 'sudo install -m 0755 /tmp/ufw-pilot.sh /opt/roadwisefleet/firewall/ufw-pilot.sh && sudo /opt/roadwisefleet/firewall/ufw-pilot.sh apply'
# 4. rollback if anything breaks
ssh -i <key> debian@51.222.139.227 'sudo /opt/roadwisefleet/firewall/ufw-pilot.sh rollback'
```

> **Do not run `apply` as a "fix".** The live ruleset is already active and was
> modified at 17:45 UTC; I could not read `/etc/ufw/user.rules` (root-only) to diff
> it. `apply` is idempotent and will warn that ufw is already active, but the
> correct first step is always `status`. `rollback` disables the host's only
> packet filter — break-glass only.

## Order of operations (do not skip step 0)

0. **Identify the owners first** — **DONE 2026-09-22** (overseer `sudo ss -ltnp`):
   :3000 gitea, :9000/:9001 browseros CDP, :9200 browseros_server MCP, :5355
   systemd-resolve (LLMNR), :9100 node_exporter. See `../host-exposure.md` §3.
1. Firewall default-deny (this script) — **LIVE since 2026-09-22 16:25 UTC**
   (activated by the operator reboot; re-assert only via `status` + reviewed diff).
2. Rebind the identified services to `127.0.0.1` — defence in depth, survives a
   flushed firewall. **Still open** (keeps task #9 open).
3. `LLMNR=no` in `/etc/systemd/resolved.conf` for port 5355.
4. Verify externally (from elilavps1, never from elilavps2 itself) and record the
   final inventory.

## Status

**Live at the packet level since 2026-09-22 16:25 UTC; reconciled with this
artifact 2026-09-22 18:05 UTC.** The remaining work (step 2 rebind, step 3 LLMNR)
is a production change needing owner approval (access request
[`eila/requests#6`](https://gitea.elilaltd.com/eila/requests/issues/6)) and host
access this agent does not hold. I did not re-apply the script.
