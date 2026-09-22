# Host firewall — reviewed config (elilavps2)

Task `eila/tasks#9` (findings H1/H2/H4 in [`../host-exposure.md`](../host-exposure.md)).

The host currently runs **no active packet filter** (`ufw` is enabled at boot but
`inactive (dead)`; `nftables` disabled; no `firewalld`), so every `0.0.0.0`/`[::]`
binding is reachable from the internet — including the unexpected listeners
**3000, 9000, 9001, 9200** and **5355** (LLMNR).

| File | Purpose |
|---|---|
| [`ufw-pilot.sh`](./ufw-pilot.sh) | Idempotent, reviewed rule set: default-deny inbound, allow only 22/80/443 (+ICMP). `apply` / `status` / `rollback`. |

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

## Order of operations (do not skip step 0)

0. **Identify the owners first** — `sudo ss -ltnp`, `sudo podman ps`. Closing a
   listener owned by another team is an outage. (H3, still open.)
1. Firewall default-deny (this script).
2. Rebind the identified services to `127.0.0.1` — defence in depth, survives a
   flushed firewall.
3. `LLMNR=no` in `/etc/systemd/resolved.conf` for port 5355.
4. Verify externally (the commands `apply` prints) and record the final inventory.

## Status

**Not applied.** Applying this is a production change; it needs owner approval
(access request [`eila/requests#6`](https://gitea.elilaltd.com/eila/requests/issues/6)
covers nginx/units, and the same change window is the natural place for this) and
host access this agent does not hold.
