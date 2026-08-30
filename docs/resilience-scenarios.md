# RoadwiseFleet — Resilience Proof: Two Disaster Scenarios

**Status:** v1 — honest walkthrough of what survives, what is lost, and what must change for the design to be truly resilient.
**Facts about the current production posture (2026-08-30):**
- Hosting: OVH VPS (51.222.139.227) — one server, everything on it (nginx, waitlist service, its data, its backups).
- DNS: **OVH** (ns200/dns200.anycast.me) — the domain's DNS is the same provider as the hosting.
- Code & configs: GitHub (ugry/roadwisefleet) — full mirror of code, docs, designs, nginx config, systemd units, deploy script.
- Static site: also mirrored on GitHub Pages (ugry.github.io/roadwisefleet).
- Waitlist data: JSONL on the VPS disk; nightly tar.gz backups **on the same VPS disk** (`/var/backups/roadwisefleet`) — no offsite copy yet.

---

## Scenario 1 — The datacenter burns down (bare-metal rack, total loss)

**Blast radius:** the server, its disks, and everything on them are gone. Nothing external is touched.

| Asset | Survives? | Where |
|---|---|---|
| All code (backend scaffold, waitlist service, deploy scripts) | ✅ | GitHub |
| All research/planning/design docs & diagrams | ✅ | GitHub |
| nginx config + systemd units (infrastructure as code) | ✅ | GitHub (`infra/`, `services/`) |
| Landing page + app screens (static) | ✅ | GitHub + GitHub Pages (still serving!) |
| Let's Encrypt certs | ✅ effectively | re-issued automatically on rebuild (no state to lose) |
| Domain & DNS | ✅ | OVH DNS is external to the datacenter |
| Waitlist leads (emails) | ❌ **LOST** | JSONL + its backups lived on the burned disks — no offsite copy exists |

**Recovery:** provision any new server/VM (any provider — nothing is OVH-specific except the IP) → run `deploy.sh` (already parameterized via `RWF_VPS`) → nginx + waitlist service recreated from git → certbot reissues → DNS A record repointed to the new IP.
**RTO today:** hardware for a *bare-metal* rack replacement can take **days–weeks** (procurement) — that's the nature of the scenario, not of our software. On any cloud VM: **~2 hours**.
**RPO today:** ❌ waitlist data loss since inception (no offsite copy).

**Verdict:** the *software estate* is fully resilient (everything is code in git — this is the design's core property). The *data estate* is not: the waitlist JSONL would die with the rack. **Fix: offsite copy (see §Fixes).**

---

## Scenario 2 — OVH terminates the account / cuts access

**Blast radius:** the VPS becomes unreachable AND — critically, because DNS is also OVH — the domain could be held hostage or go dark.

| Asset | Survives? | Where |
|---|---|---|
| Code, configs, docs, designs | ✅ | GitHub (independent of OVH) |
| Landing page (content) | ✅ | GitHub Pages keeps serving at `ugry.github.io/roadwisefleet` even if the domain dies |
| Waitlist endpoint | ❌ | dead with the VPS (form errors gracefully — leads ask to email hello@, which also dies with OVH if mail is hosted there) |
| Waitlist data | ❌ **LOST** | on the inaccessible VPS; backups were on the same VPS |
| Domain (`roadwisefleet.com`) | ⚠️ **AT RISK** | DNS zone lives at OVH — provider lockout = domain lockout risk |

**Recovery:** new VPS at a different provider (Hetzner/Netcup/Contabo) → `RWF_VPS=new@new-ip ./deploy.sh` → DNS (if still ours, repoint; if not, see fix) → site back.
**RTO today:** ~2–4 hours once a replacement VM exists.
**RPO today:** ❌ waitlist data loss.

**Verdict:** the design survives *provider* loss for everything except two concentrations: **data lives only at OVH, and DNS lives only at OVH.** That single-provider coupling is the real vulnerability this scenario exposes.

---

## Why the design is resilient (the three properties being proven)

1. **Everything is code in git.** nginx, systemd, deploy script, service source — a full rebuild is `deploy.sh`, not tribal knowledge. Provider loss can't delete our product.
2. **Static serving is multi-homed.** GitHub Pages mirrors the site independently of any VPS or datacenter.
3. **Certificates are stateless.** Let's Encrypt reissues on rebuild — no secret lives only on the server (the only on-server secret is the waitlist admin token, regenerable).

## What the proof exposes (the gaps — in order)

| # | Gap | Severity | Fix | Blocked by |
|---|---|---|---|---|
| 1 | **No offsite copy of waitlist data** — both scenarios lose every lead | CRITICAL | rclone/tar → Backblaze B2 bucket nightly (from the existing backup timer) | needs one B2 credential from the founder |
| 2 | **DNS = OVH = hosting** — scenario 2 risks the domain itself | HIGH | migrate the DNS zone to Cloudflare (free tier); keep OVH only as host | needs founder's OVH login for NS change |
| 3 | **hello@ mailbox** (still unset) would die with any provider — the waitlist's error-state fallback is a dead letter | MEDIUM | mailbox on an independent provider (e.g., Zoho/Cloudflare email routing) | needs DNS + mailbox choice |
| 4 | **No restore drill has ever been run** — RTO is theoretical | MEDIUM | monthly drill: fresh VM + `deploy.sh` + restore from offsite + row-count check | after #1 |
| 5 | **Single git remote (GitHub)** — account loss = repo loss | LOW | push mirror to GitLab (free) | needs a GitLab account |

## Recovery runbook (the 2-hour rebuild — to be drilled)

```bash
# 1. Provision a fresh Debian VM anywhere (any provider), get IP + SSH.
# 2. Point it at the repo (the whole system is in git):
git clone https://github.com/ugry/roadwisefleet.git && cd roadwisefleet
# 3. Deploy web + waitlist service:
RWF_VPS=debian@<NEW-IP> ./deploy.sh
# 4. One-time setup on the new box (documented in infra/README.md):
#    - install nginx, nodejs, ufw/fail2ban (commands recorded in infra runbook)
#    - restore waitlist JSONL from offsite backup into /var/lib/roadwisefleet
#    - regenerate admin token; certbot --nginx -d roadwisefleet.com -d www.roadwisefleet.com
# 5. Update DNS A records to <NEW-IP> (Cloudflare after fix #2 — instant).
# 6. Verify: https://roadwisefleet.com/ + POST /api/waitlist + GET admin list.
```

---

## Bottom line

- **Scenario 1 (rack burned):** software survives entirely; RTO is set by hardware procurement, not by us; **data is lost today** — fix #1 closes this.
- **Scenario 2 (OVH cut-off):** code, docs, and even the static site survive; rebuild anywhere in ~2 h; **data and the domain are the exposures** — fixes #1 and #2 close this.
- The design's resilience claim is real but currently **incomplete on purpose**: we prioritized speed, and the proof shows exactly the two things that turn "resilient by design" into "resilient in fact": **offsite data + decoupled DNS.** Both are one founder credential away.
