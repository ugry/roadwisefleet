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
| API | `bodyLimit = MAX_UPLOAD_BYTES × 2` (20 MB) and `validateDocumentUpload` rejects `> MAX_UPLOAD_BYTES` (10 MB) | 413 / `file_too_large` JSON (`detail`) | dev |

The 1 MB nginx default is **the #41 defect**: a 2–5 MB phone photo never reaches the API, so the
legally required POD flow is impossible on the live pilot. The fix is pre-staged and verified —

- **PR https://github.com/ugry/roadwisefleet/pull/33** (Victor Nolan, branch
  `infra/nginx-upload-limit-41`, commit `bfb1c64`): a regex location scoped to
  `^/api/trips/[^/]+/documents/?$` with `client_max_body_size 25m;`, so every other `/api/` request
  keeps the 1 MB default. `nginx -t` passes; behavioural proof on a throwaway nginx on
  127.0.0.1:18099 (2 MB → 200 on the upload route, 413 elsewhere; 30 MB → 413). **Owner-gated,
  not applied.** I did not duplicate it here; my changes are the storage/retention/backup half.

**Client-side half still owed:** a readable "this file is too large" message in the driver client
(F7a, Max) rather than a silent failure. The API already answers `413 {"error":"file_too_large",
"detail":"max N bytes"}` and nginx's own 413 is a plain HTML page — the client must render its own
message *before* upload from its local size check, and map a 413 to the same text if it still
happens.

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

## 3. Findings

| # | Severity | Finding | Fix |
|---|---|---|---|
| **U1** | high | **Uploads are world-readable.** Files are `0644`, the directory tree is `0775`. Any local account (including any future co-tenant or agent account on this host) can read every POD photo. Fails #46 acceptance *"no upload is stored world-readable"*. | **This PR:** API writes files `0640` and creates directories `0750` (code + CI test). **Host:** `UMask=0027` on the unit (not yet live, needs approval) + `chmod` sweep of existing files. |
| **U2** | medium | **The data lives inside the deploy checkout.** `/opt/roadwisefleet/api/var/uploads` is under the checkout that the #31 deployer force-checks-out. `var/` is gitignored, so `git checkout --force` leaves it alone — but a re-clone, `git clean -xdf`, or a disk migration destroys every POD photo with no recovery path. Application data does not belong in a deploy checkout. | Move to `/var/lib/roadwisefleet/uploads` (§4). Owner-approved host change. |
| **U3** | high | **Uploads are in no backup set.** The only backup jobs are the Postgres dump (`roadwise-pg-backup.timer`) and the waitlist tarball (`roadwisefleet-backup.timer`, `/var/lib/roadwisefleet`). No archive of the document directory exists, and no script referenced it. | `pilot-uploads-backup.sh` + timer (§7). |
| **U4** | medium | **No disk-headroom alert.** `df` is not monitored by any check I can see (the monitoring stack watches uptime/metrics, threshold list T1–T8). A full `/` takes the API, Postgres **and** the upload path down together. | `pilot-disk-check.sh` + hourly timer (§6, thresholds T9–T10). |
| **U5** | high | **No retention policy.** Nothing defines how long POD/eCMR documents must be kept, so nothing may be deleted safely — and nothing is protected by a written rule either. An implicit "keep forever" is fine legally but is not a policy: there is no documented answer, no expiry data, and no way to prove either. | §5 — policy draft, **legal minimum routed to the secretary, not guessed**. |
| **U6** | low | **No integrity record.** Nothing stores a checksum of a stored document, so silent bit-rot or a truncated file is undetectable. | The backup manifest (sha256 per file) is the beginning of one; a periodic verify can reuse it. |

## 4. Storage contract (target state)

| Property | Target | Why |
|---|---|---|
| Path | `/var/lib/roadwisefleet/uploads` | outside the deploy checkout (U2); the FHS location for service state; the waitlist already uses `/var/lib/roadwisefleet` |
| Directory mode | `0750`, owner = the API service user (`debian`) | group/service access only; **not** world-traversable (U1) |
| File mode | `0640` | owner + service group read; nobody else (U1) |
| `UPLOAD_DIR` | set in `apps/api/.env` (0600, never committed) | explicit beats a computed default that moves when the checkout layout moves |
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
# 4. add UMask=0027 to roadwise-api.service (defence in depth for new files)
sudo systemctl daemon-reload && sudo systemctl restart roadwise-api.service
# 5. verify: upload one real photo through the public URL, then
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
| a >2.5 MB photo uploads from a phone through the public URL and the trip reaches `POD_UPLOADED` | **NOT MET** — needs #41 applied (PR #33, owner sign-off) then a real-device upload (F7a/F7c). No real photo has ever reached the server (§2). |
| an over-limit file produces a readable message rather than a silent no-op | **NOT MET here** — the nginx half is PR #33; the readable client message is the F7a client half (§1). |
| the upload lands on disk with a documented path + permissions | **delivered as documentation + code**; the live directory is still `0775`/`0644` until the host applies §4 (owner approval). |
| disk usage is monitored with an alert before it fills | **scripted** (`pilot-disk-check`, T9/T10) — **not installed**. |
| retention policy written down, matching the business/legal requirement | **draft written**; the requirement is with the secretary (§5) — not guessed, not claimed as met. |
| the upload directory is included in the backup + restore drill | **scripted + CI-validated**; drill not yet run on the host (no `podman`/root from my session). |
| no upload is stored world-readable | **code fix + CI test in this PR**; live tree unchanged until §4 is approved. |

## 9. Blockers

| # | Blocker | Who unblocks |
|---|---|---|
| **B1** | Storage move + `UMask` + installing the disk-check and uploads-backup timers: host change, root on elilavps2. `sudo` is not available to me and production changes need owner approval. | owner window, applied by Victor |
| **B2** | #41 is `awaiting-owner` — without PR #33 applied, no upload > 1 MB can be tested at all. | owner sign-off on PR #33 |
| **B3** | Retention legal minimum (§5). | secretary (isabelle.graves@) |
| **B4** | Running the extended restore drill on the host (needs root + the `postgres:17-alpine` image). | Victor, in the same window as B1 |

Related: `#43` gets the uploads backup + drill from this change; `#44` gets the disk thresholds;
`#41`'s nginx diff stays as pre-staged by Victor. Nothing in this task touches nginx, the API unit,
or the database.
