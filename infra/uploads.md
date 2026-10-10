# Uploads — driver document transport (F7b)

Board: **eila/tasks#46** (FAv1-F7b, transport half of F7). Related: **#41** (F9b — the nginx
`client_max_body_size` defect), **#43** (F9c — backup + restore drill), **#44** (F9d — monitoring),
**#7** (PR #13, headers/www→apex/limits — a *different* change, not the vehicle for #41).

Covers: where uploaded POD/eCMR bytes land, what permissions they get, how long they are kept,
how the disk is watched, and how they are backed up and restored.

**Status: artifacts delivered in the repo; nothing installed on any host.** Host-level items are
marked BLOCKED with the exact blocker, per the board rules.

---

## 1. The transport path

```
driver phone ──HTTPS──▶ nginx (roadwisefleet.com, location /api/)
                         └─ proxy_pass 127.0.0.1:8080
                              └─ POST /api/trips/:id/documents   (apps/api/src/routes/documents.ts)
                                   ├─ createDocument()  → Document row status=PENDING
                                   ├─ writeDocumentFile(env.UPLOAD_DIR, storageKey, bytes)
                                   └─ row → status=UPLOADED   (on write failure the row is deleted)
```

Uploads are JSON+base64 (`{ docType, filename, mimeType, dataBase64 }`), not multipart — the pilot
has no multipart dependency. The storage key is `<tripId>/<docType>/<documentId>-<sanitised-name>`,
built server-side only, and `resolveWithin()` refuses any key that would escape the root.

Two independent limits stand between the phone and the disk:

| Layer | Limit | Behaviour on breach | Owner |
|---|---|---|---|
| nginx | `client_max_body_size` — **default 1 MB**, no directive in the deployed vhost | **413 before the API sees the request** | this task + #41 |
| API | `bodyLimit = MAX_UPLOAD_BYTES × 2` (20 MB) and `validateDocumentUpload` rejects `> MAX_UPLOAD_BYTES` (10 MB) | **400** / `file_too_large` JSON (`detail`) | dev |

The 1 MB nginx default is **the #41 defect**: a 2–5 MB phone photo never reaches the API, so the
legally required POD flow is impossible on the live pilot. The fix is pre-staged and verified —

- **PR https://github.com/ugry/roadwisefleet/pull/33** (Victor Nolan, branch
  `infra/nginx-upload-limit-41`, commit `bfb1c64`): a regex location scoped to
  `^/api/trips/[^/]+/documents/?$` with `client_max_body_size 25m;`, so every other `/api/` request
  keeps the 1 MB default. `nginx -t` passes; behavioural proof on a throwaway nginx on
  127.0.0.1:18099 (2 MB → 200 on the upload route, 413 elsewhere; 30 MB → 413). **Owner-gated,
  not applied.** I did not duplicate it here; my changes are the storage/retention/backup half.

**Client-side half still owed:** a readable "this file is too large" message in the driver client
(F7a, Max) rather than a silent failure. The API answers `400 {"error":"file_too_large",
"detail":"max N bytes"}` when the decoded size exceeds `MAX_UPLOAD_BYTES` (a request body that
exceeds the route's 20 MB `bodyLimit` is rejected earlier by Fastify's generic `413 Payload Too
Large`), and nginx's own 413 is a plain HTML page — the client must render its own message *before*
upload from its local size check, and map the API's `400 file_too_large` and a proxy `413` to the
same text if either still happens.

## 2. Verified live state (2026-09-23 ~22:30–23:00 UTC, read-only, from elilavps2)

| Check | Command | Result |
|---|---|---|
| upload directory | `ls -ld /opt/roadwisefleet/api/var/uploads` | exists, **`drwxrwxr-x` (0775)** `debian:debian`, mtime 2026-09-23 22:22 |
| contents | `find … -type d` / `-type f -printf '%s %TY-…'` | **19 trip directories** (`<tripId>/pod/`), **21 files**, **2 730 bytes total** |
| largest file | `ls -l …/pilot-trip-2/pod` | `-rw-r--r--` (0644) `debian:debian`, **700 B** `…-qa-pod-live.jpg` (20:25 UTC) |
| the rest | `find … -printf '%s …'` | 19 × 70 B `…-pod-photo.png` placeholders |
| disk | `df -h /` | 99 G total, 17 G used, **78 G avail (18 %)** |
| memory | `free -m` | 11 683 MB total / 802 MB free / 8 016 MB available; swap 888/2 047 MB |
| API | `systemctl status roadwise-api.service` | `active (running)` since 2026-09-23 22:22:43 UTC, PID 966093, 129 MB RSS |
| `UPLOAD_DIR` | `apps/api/src/env.ts` default | `resolve(<repo>/apps/api/src/../../../var/uploads)` → `/opt/roadwisefleet/api/var/uploads` |

**Provenance / honest limits.** `apps/api/.env` is 0600 and unreadable from my session, so I cannot
prove whether `UPLOAD_DIR` is set explicitly or falls through to the default; what is certain is
that uploads land in `/opt/roadwisefleet/api/var/uploads` today. `/var/backups/roadwisefleet` is
0700 root and `ls /var/backups/roadwisefleet/postgres` returned **Permission denied**, so the backup
set could not be enumerated directly — the statements in §7 come from the repo's backup scripts and
the installed unit names, not from reading the backup directory.

**The load-bearing fact in that table:** the largest document on disk anywhere is **700 bytes**, and
every file is a placeholder. **No real phone photo has ever been stored on the live pilot** — which
is exactly what the #41 413 predicts. This task cannot be demonstrated with real bytes until #41 is
applied.

## 2b. Post-B1 host state and the board-#62 artifact fixes (2026-09-24)

**Provenance:** the host facts below are quoted from the Team Leader's board comments on
`eila/tasks#46` / `#43` (he holds root on elilavps2) — I did **not** verify them first-hand. The
*artifact* changes are mine and are CI-checked (§6/§7).

The B1/B4 host window was applied 2026-09-24 ~00:00 UTC:

| Host fact | Value |
|---|---|
| Live uploads path | `/var/lib/roadwisefleet/uploads` (`0750 debian:debian`); moved with `rsync`, verified **24 files / 13,476,195 B on both sides before any delete**; the old tree is left in place and receives nothing new |
| New writes | `0640` files / `0750` dirs (`UMask=0027` drop-in on `roadwise-api.service`); `find -perm -o+r` = **0** |
| `UPLOAD_DIR` | appended to the API `.env` (0600; the value was not printed) |
| Timers | `pilot-disk-check.timer` (hourly) and `pilot-uploads-backup.timer` (03:45 UTC) installed and enabled; first archives written 0600 with sha256 manifests |
| Real bytes | a **3,200,120-byte** JPEG through `https://roadwisefleet.com` → **HTTP 201**, stored `0640` in the new tree |
| Drill | **PASSED** (`--with-uploads`): dump 22 tables / 125 rows / 12 trips / 2 documents; uploads archive **25 files / 16,676,315 B / 25-of-25 sha256 OK** |

Three defects in the **merged** install artifacts surfaced while applying that window. They were
patched on the host, so the repo kept shipping the stale versions — board **#62** fixes that:

| # | Defect | Fix (this change) |
|---|---|---|
| **D1** | `pilot-disk-check.service` / `pilot-uploads-backup.service` hardcoded the **pre-move** `UPLOAD_DIR`. A reinstall would make the disk check and the nightly backup operate on an **abandoned** directory — a silent monitoring *and* backup gap. | Units and both scripts now default to `/var/lib/roadwisefleet/uploads`; the units additionally read an optional `/etc/roadwisefleet/uploads.env` (0600, root — settings there win over `Environment=`), so the path is set in one place and cannot drift again. |
| **D2** | the drill's default `SCRATCH_PORT=5433` collided with the host `postgresql@17-main` cluster (`bind: address already in use`; the host ran it with `SCRATCH_PORT=5434`). | Default is now `SCRATCH_PORT=auto`: the first free port in `5440–5479`, never 5432/5433, with automatic retry on the next candidate. A *pinned* port fails with a clear message instead of a bare bind error. |
| **D3** | the drill never created the dump's owner role, so `ON_ERROR_STOP=1` aborted on `ALTER … OWNER TO roadwisefleet` (roles are cluster-level and are not in a database dump). | The drill derives the roles the dump references (`OWNER TO` / `AUTHORIZATION` / `GRANT\|REVOKE … TO\|FROM`) and creates each one with `LOGIN` in the throwaway cluster **before** loading. A reference that is not a simple identifier is skipped with a loud message and is never interpolated into SQL. |

All three are asserted by `pilot-restore-drill.sh --self-test` in CI (job `restore-drill-selftest`,
stubbed podman + fixture dump + fixture archive: no host, no network, no root) and by `shellcheck`,
so a future reinstall cannot silently regress them.

## 2c. Re-verification, 2026-09-26 (read-only, from elilavps2)

| Check | Command | Result |
|---|---|---|
| live root | `ls -ld /var/lib/roadwisefleet/uploads` | **`drwxr-x---` (0750)** `debian:debian` — not world-readable ✔ |
| backup timer | `systemctl status pilot-uploads-backup.timer` | active (waiting) since 2026-09-23 23:56:42 UTC; next trigger 03:45 UTC |
| disk timer | `systemctl status pilot-disk-check.timer` | active (waiting); last run 2026-09-26 21:59:36 UTC |
| last backup run | `systemctl status pilot-uploads-backup.service` | `code=exited, status=0/SUCCESS` at 2026-09-26 03:45:02 UTC |
| **retired tree** | `ls -ld /opt/roadwisefleet/api/var/uploads` + `find … -printf '%s %m %p'` | **still present, `drwxrwxr-x` (0775)**, 24 files, all `0644`/`0664` → **world-readable**; newest 2026-09-23 23:12; includes the 9,753,570-byte QA JPEG and a 3,719,825-byte one (**U7**) |

**Provenance:** first-hand `ls`/`find` metadata only (`/etc`, the API `.env` and
`/var/backups/roadwisefleet` are not readable from my session). The installed
`/usr/local/bin/pilot-*.sh` copies are dated **2026-09-23 23:56** — the pre-#62 versions — which is
the repo/host divergence §9 B5 describes. The *effective* `UPLOAD_DIR` of the running units could
not be re-read from my session, so B5 still needs the reinstall **and** a post-install verification
in the owner window (the runbook's claim that the running units are correct rests on the B1 hand
patch, not on a first-hand read from here).

## 3. Findings

| # | Severity | Finding | Fix |
|---|---|---|---|
| **U1** | high | **Uploads are world-readable.** Files are `0644`, the directory tree is `0775`. Any local account (including any future co-tenant or agent account on this host) can read every POD photo. Fails #46 acceptance *"no upload is stored world-readable"*. | **This PR:** API writes files `0640` and creates directories `0750` (code + CI test). **Host:** `UMask=0027` on the unit (not yet live, needs approval) + `chmod` sweep of existing files. |
| **U2** | medium | **The data lives inside the deploy checkout.** `/opt/roadwisefleet/api/var/uploads` is under the checkout that the #31 deployer force-checks-out. `var/` is gitignored, so `git checkout --force` leaves it alone — but a re-clone, `git clean -xdf`, or a disk migration destroys every POD photo with no recovery path. Application data does not belong in a deploy checkout. | Move to `/var/lib/roadwisefleet/uploads` (§4). Owner-approved host change. |
| **U3** | high | **Uploads are in no backup set.** The only backup jobs are the Postgres dump (`roadwise-pg-backup.timer`) and the waitlist tarball (`roadwisefleet-backup.timer`, `/var/lib/roadwisefleet`). No archive of the document directory exists, and no script referenced it. | `pilot-uploads-backup.sh` + timer (§7). |
| **U4** | medium | **No disk-headroom alert.** `df` is not monitored by any check I can see (the monitoring stack watches uptime/metrics, threshold list T1–T8). A full `/` takes the API, Postgres **and** the upload path down together. | `pilot-disk-check.sh` + hourly timer (§6, thresholds T9–T10). |
| **U5** | high | **No retention policy.** Nothing defines how long POD/eCMR documents must be kept, so nothing may be deleted safely — and nothing is protected by a written rule either. An implicit "keep forever" is fine legally but is not a policy: there is no documented answer, no expiry data, and no way to prove either. | §5 — policy draft, **legal minimum routed to the secretary, not guessed**. |
| **U6** | low | **No integrity record.** Nothing stores a checksum of a stored document, so silent bit-rot or a truncated file is undetectable. | The backup manifest (sha256 per file) is the beginning of one; a periodic verify can reuse it. |
| **U7** | high | **The retired pre-move tree still leaks.** The B1 window left `/opt/roadwisefleet/api/var/uploads` in place, still `drwxrwxr-x` (0775) with `0644`/`0664` files and real POD photos in it (incl. the 9,753,570-byte QA JPEG). The installed `pilot-disk-check` only scans the live root, so nothing detects it — which is why the acceptance "no upload is stored world-readable" is **not** fully met (§2c, §8). | `infra/checks/uploads-perms-check.sh --live` audits **both** roots; the new CI job keeps the code from binding `UPLOAD_DIR` back to the retired path; and §9 B5 locks the tree down now and removes it after the drill. |

## 4. Storage contract (target state)

| Property | Target | Why |
|---|---|---|
| Path | `/var/lib/roadwisefleet/uploads` | outside the deploy checkout (U2); the FHS location for service state; the waitlist already uses `/var/lib/roadwisefleet` |
| Directory mode | `0750`, owner = the API service user (`debian`) | group/service access only; **not** world-traversable (U1) |
| File mode | `0640` | owner + service group read; nobody else (U1) |
| `UPLOAD_DIR` | set in `apps/api/.env` (0600, never committed) | explicit beats a computed default that moves when the checkout layout moves |
| `UPLOAD_DIR` for the ops units | default `/var/lib/roadwisefleet/uploads` in `pilot-disk-check.service` / `pilot-uploads-backup.service`, overridable via `/etc/roadwisefleet/uploads.env` (0600, root, optional) | one place to change the path for the check + the backup; **a reinstall cannot point them back at the pre-move directory** (board #62, D1) |
| Transport | never served by nginx, never under a web root | documents are only reachable through the authenticated API |
| Backups | `uploads-*.tar.gz` + `.manifest`, 0600, in `/var/backups/roadwisefleet/uploads` | §7 |

**Install (BLOCKED — host change, needs owner approval + root; nothing below has been run):**

```bash
# 1. create the target and move the existing bytes without losing them
sudo install -d -m 0750 -o debian -g debian /var/lib/roadwisefleet/uploads
sudo rsync -a /opt/roadwisefleet/api/var/uploads/ /var/lib/roadwisefleet/uploads/
# 2. verify BEFORE deleting anything: same file count and total bytes on both sides
sudo find /opt/roadwisefleet/api/var/uploads -type f | wc -l
sudo find /var/lib/roadwisefleet/uploads      -type f | wc -l
# 3. point the API at the new path (0600, edited in place, never committed)
#    UPLOAD_DIR=/var/lib/roadwisefleet/uploads
sudo install -m 0600 -o debian -g debian /dev/null /tmp/.env.new   # or edit with an editor
# 4. optional: one place for the ops units to read the same path (0600, root).
#    The units work without it (their default is the same value); it exists so a
#    future move does not need the units edited. Settings here win over the
#    unit's own Environment= lines.
sudo install -d -m 0750 /etc/roadwisefleet
printf 'UPLOAD_DIR=/var/lib/roadwisefleet/uploads\n' | sudo install -m 0600 /dev/stdin /etc/roadwisefleet/uploads.env
# 5. add UMask=0027 to roadwise-api.service (defence in depth for new files)
sudo systemctl daemon-reload && sudo systemctl restart roadwise-api.service
# 6. verify: upload one real photo through the public URL, then
sudo find /var/lib/roadwisefleet/uploads -type f -printf '%m %u:%g %s %p\n'
```

**Rollback:** restore the old `UPLOAD_DIR`, `systemctl restart roadwise-api`. The old directory is
left in place (step 2 verifies before any delete; this task deletes nothing).

## 5. Retention policy (draft — the legal minimum is NOT guessed)

**Rule R1 — ship safe:** the retention script defaults to `UPLOAD_RETENTION_DAYS=0`, which means
**retention disabled: it deletes nothing**, and it is dry-run unless `--apply` is passed. No
document may be deleted until the legal requirement is confirmed in writing. This is the only
defensible default: deleting evidence on a guess is unrecoverable, keeping it is reversible.

**Rule R2 — never delete alone:** any future deletion removes the file **and** its `Document` row
in one reviewed change, and the manifest of the last backup must still contain the deleted file
(the audit trail lives in the archive, not only in the live tree).

**Rule R3 — expiry is per document type:** the schema already carries `Document.expiresAt`
("drives compliance-vault expiry alerts"). Credential types (`driver_license`, `cpc`, `medical`,
`insurance`, `tacho_file`) expire on a document-specific date; POD/eCMR are trip evidence, likely a
different period. `expiresAt` is currently never populated.

**Pending question — routed to the secretary (isabelle.graves@elilaltd.com), not decided here:**
1. Minimum retention period required for **POD/eCMR** (the legally required delivery proof) and in
   which jurisdictions the pilot operates (TR / EU / US)?
2. Separate periods for driver credential documents (`driver_license`, `cpc`, `medical`,
   `insurance`, `tacho_file`)?
3. Does publication/GDPR data-minimisation discipline require *deletion* after that period, or is
   indefinite retention acceptable and safer?
4. Must deletions themselves be evidenced (deletion log / certificate), or is a policy statement
   enough?
5. Any driver-contract or customer-contract retention obligation that overrides the above?

Until those answers exist, the policy on record is: **retain everything, delete nothing, and say so
explicitly** — with the disk headroom (§6) and the offsite question (F9c) as the real constraints.

## 6. Disk headroom and monitoring

`infra/scripts/pilot-disk-check.sh` + `pilot-disk-check.{service,timer}` (hourly) — ready to apply:

- filesystem used % against **WARN 80 % / CRIT 90 %** and a hard **free-space floor** (2 GB);
- reports uploads **file count and total bytes** each run, so the growth curve is visible long
  before the threshold is hit;
- **continuously enforces U1**: any world-readable (`o+r`) file or directory under the uploads root
  is a failure, so a permission regression is caught without a human looking;
- alert cooldown (6 h) so a persistent condition does not mail every hour.

Thresholds **T9** (uploads filesystem ≥ 80 % warn / ≥ 90 % crit) and **T10** (free space
< 2 GB) are registered with the other owned thresholds in `monitoring/README.md`.

A standalone guard, `infra/checks/uploads-perms-check.sh`, closes the two gaps the disk check cannot
see (U7 / board #62 D1):

- `--live` audits **both** the live root and the retired pre-move root for world-readable files
  (a world-readable *file* fails; a world-traversable *dir* warns; a locked-down leftover warns so it
  is removed after the drill);
- **repo mode** (runs in CI with no host) fails if any of the four storage artifacts
  (`pilot-disk-check.{service,sh}`, `pilot-uploads-backup.{service,sh}`) binds `UPLOAD_DIR` back to
  the retired path — the exact drift board #62 (D1) found on a host *after* merge;
- `--self-test` proves each decision on fixtures (no host, no network).

Both the self-test and the repo check run in the `uploads-perms-check` CI job.

## 7. Backup + restore inclusion (links to F9c / #43)

| Artifact | What it does |
|---|---|
| `scripts/pilot-uploads-backup.sh` | `tar -czf` the upload directory to `<BACKUP_DIR>/uploads-<UTC>.tar.gz` (**0600**) plus `uploads-<UTC>.manifest` (**0600**, every file with size + sha256). Retention `KEEP_DAYS=30`. **Refuses to run on a missing or empty uploads dir** unless `--allow-empty`: an empty archive that looks healthy is worse than no archive. |
| `systemd/pilot-uploads-backup.{service,timer}` | daily **03:45 UTC** — after the 03:15 Postgres dump and its verify — `Persistent=true`, so a missed run catches up. |
| `scripts/pilot-backup-verify.sh` (extended) | now also checks the newest uploads archive: freshness ≤ 26 h, `tar -tzf` integrity, matching manifest present and non-empty. |
| `scripts/pilot-restore-drill.sh` (extended) | after the Postgres restore, restores the uploads archive into a scratch directory, verifies **every file against the manifest sha256**, compares file count and total bytes, asserts none is world-readable, then removes the scratch copy. |

**The restore drill covers the Postgres dump and the upload directory as one operation**, so a
restore proves the *trip and its POD photo* both come back — the acceptance wording in #46 and #43.

Honest limit: the manifest proves the archive matches what was on disk when it was taken; it cannot
prove nothing was already missing. That is what #43's freshness check and deletion detection are for.

## 8. Acceptance mapping (#46)

| Acceptance criterion | Status |
|---|---|
| a >2.5 MB photo uploads from a phone through the public URL and the trip reaches `POD_UPLOADED` | **MET on the live surface** — a **3,200,120-byte** JPEG through `https://roadwisefleet.com` → **HTTP 201**, stored in the new tree (`0640`) when the B1 window ran (§2b; the Team Leader's host evidence, not first-hand). The trip reaching `POD_UPLOADED` still needs the F7a/F7c device flow (#48). |
| an over-limit file produces a readable message rather than a silent no-op | nginx half **applied** (#41 closed, proven with a real 9.75 MB POST); the API answers **`400 file_too_large`** for a decoded size above `MAX_UPLOAD_BYTES` (§1); the readable *client* message is still the F7a client half (§1). |
| the upload lands on disk with a documented path + permissions | **MET** — live path + modes in §2b (`/var/lib/roadwisefleet/uploads`, 0750/0640); enforced for new writes by code + a CI test. |
| disk usage is monitored with an alert before it fills | **MET** — `pilot-disk-check.timer` installed (hourly); first run green (25 files, dir 750, filesystem 19 %). Thresholds T9/T10. |
| retention policy written down, matching the business/legal requirement | **ANSWERED as far as it can be, DECISION PENDING owner + legal** — there is no company/legal position on record (secretary, `eila/requests#14`), so the ship-safe default stands: **retention disabled / delete nothing** until the owner signs off in writing (§5). |
| the upload directory is included in the backup + restore drill | **MET** — nightly archive + manifest (0600), and the drill **PASSED** on the host with the real bytes (25 files / 16,676,315 B / 25-of-25 sha256 OK). |
| no upload is stored world-readable | **NOT fully met (U7)** — the live root is `0750`/`0640` and new writes are 0640 (CI test in this repo), but the **retired pre-move tree is still `0775`/`0644`** (§2c) and holds real POD photos, so any local account can still read them. Fix in the owner window (§9 B5). |

## 9. Blockers

| # | Blocker | Who unblocks |
|---|---|---|
| **B1** | storage move + `UMask` + installing the timers — **CLEARED 2026-09-24 ~00:00 UTC** (host window applied; §2b). The three stale artifacts that window exposed are fixed in the board-#62 change. | done |
| **B2** | #41 nginx limit — **CLEARED** (#41 closed; a 9.75 MB upload reached the API with HTTP 201). | done |
| **B3** | retention legal minimum — **answered as far as possible**: no company/legal position on record, so it is an **owner + legal decision** (already open on `eila/tasks#13` §5). Default stays "delete nothing". | owner + legal |
| **B4** | run the extended drill on the host — **CLEARED**: drill PASSED (`--with-uploads`) in the same window. | done |
| **B5** | **owner window: (a) install the #62-fixed artifacts and (b) stop the U7 leak.** The installed `/usr/local/bin/pilot-*.sh` are still the pre-#62 copies and the host carries a B1 hand patch (§2c), so the repo/host diverge; reinstalling from a clean checkout is a host change. Separately, `/opt/roadwisefleet/api/var/uploads` is still world-readable (`0775`/`0644`) and must be locked down now and deleted once the move is drill-verified. | owner window, applied by the Team Leader |

**B5 remediation — the exact commands (nothing below was run by me):**

```bash
# (a) reinstall the corrected artifacts so the timers + scripts match the repo
sudo install -m 0755 infra/scripts/pilot-disk-check.sh    /usr/local/bin/pilot-disk-check.sh
sudo install -m 0755 infra/scripts/pilot-uploads-backup.sh /usr/local/bin/pilot-uploads-backup.sh
sudo install -m 0644 infra/systemd/pilot-disk-check.service infra/systemd/pilot-uploads-backup.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart pilot-disk-check.timer pilot-uploads-backup.timer

# (b) U7 — stop the leak first (non-destructive), then delete only after the drill
sudo chmod -R o-rwx /opt/roadwisefleet/api/var/uploads
sudo find /opt/roadwisefleet/api/var/uploads -type f | wc -l   # expect the archive's count
#   ... only after the nightly archive (§7) is verified and the restore drill has passed:
sudo rm -rf /opt/roadwisefleet/api/var/uploads

# verify both roots afterwards
bash infra/checks/uploads-perms-check.sh --live
```

The `rm -rf` is destructive and must not happen before the archive + drill prove the move;
the `chmod` is the immediate, reversible stop-gap.

Related: `#43` gets the uploads backup + drill from this change; `#44` gets the disk thresholds;
`#41`'s nginx diff stays as pre-staged by Victor. Nothing in this task touches nginx, the API unit,
or the database.
