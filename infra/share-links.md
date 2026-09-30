# Off-platform share links — transport runbook (board eila/tasks#75, UXF-O1)

Status: **artifacts only.** Nothing in this document has been applied to a host;
the nginx half is config-as-code behind the owner change window (protected
paths `infra/nginx/**`), and the app half is routed to Max (see §7).

Design specification: `docs/ux-flows/06-offplatform-customers.mmd` (diagram 06) and
the UX Flow Design 2026-09-29. This task is the transport/capability half of the
guest surfaces: signed, unguessable, revocable links for the tracking page, the
POD/eCMR documents and the invoice view — with no login, no cookie, rate limits,
PII-free request logging, and no impact on uploads storage or backups.

---

## 1. What is live today (first-hand, read-only, 2026-09-29 ~20:33 UTC)

HEAD probes from elilavps2 (**vantage point**: same host as nginx — it proves the
response nginx serves, not external reachability):

| Probe | Result |
| --- | --- |
| `GET /track/<64-hex>` | **200** `text/html`; `x-robots-tag: noindex, nofollow`; pilot CSP (`default-src 'none'`…); **no `Set-Cookie`** |
| `GET /api/track/<64-hex>` | **404** `application/json`; `x-robots-tag: noindex`; **no `Set-Cookie`** |
| `GET /s/<64-hex>` | **404** — see the board #91 update below: `/s/` is now the solo-driver shell (board #77/#87), and the #75 document/invoice token route was never implemented |

So the **F8 tracking link is already live and correct** for the tracking surface:
the HTML shell is public, the data endpoint rejects an unknown token with a clear
404 and a JSON error, and no cookie is set. The `/track/` nginx location is
applied on the host (it serves the pilot CSP header set).

**Board #91 update (2026-09-30).** `/s/` is no longer the surface this task
specified. The solo-driver shell (board #77) answers there — live measured
2026-09-30: `GET /s/` **200** `text/html` with the strict **app** CSP,
`GET /s` **301** → `/s/` (PR #73 / board #87). The document/invoice share token
under `/s/<token>` was **never implemented** (the app half was requested from Max
and not built; see §7). Two consequences for this runbook:

* the `/s/` nginx location now includes `roadwisefleet-headers-app.conf`, not the
  pilot snippet — the solo shell declares no inline `<script>`/`<style>`;
* the location is still kept on the `rwf_share` zone and the PII-free log
  (§3/§4). The board #75 review decided **not** to relax the merged
  `share-link-check` guard, so the guard's `SHARE_LOCATIONS=("/track/" "/s/")`
  now reads as "locations that can carry a share token", not "the three #75
  surfaces". §3 below carries the corrected wording.

Token model in code (`apps/api/src/track-link.js`, F8/#39):

* stateless **HMAC-SHA256** token binding one trip id to an expiry, signed with a
  key derived from `AUTH_SECRET` (domain-separated: a tracking token can never
  verify as a session token);
* default TTL **30 days**, configurable;
* **two revocation levels** — global (`TRACK_LINK_SECRET` rotation) and per trip
  (`trackLinkVersion`, a token carrying an older version reads as `not_found`);
* the public payload is PII-free by construction (`shapeTrackedTrip` has no
  driver / customer / plate / rate fields).

## 2. The share-link contract (what #75 adds)

Three guest artefacts, one primitive:

| Surface | Path | Token scope | Served by |
| --- | --- | --- | --- |
| tracking page | `/track/<token>` | `trip:<id>` | **live** (F8) |
| POD / eCMR download | `/s/<token>` | `document:<id>` | **never implemented** (board #91: /s/ is the solo shell) |
| invoice view | `/s/<token>` | `invoice:<id>` | **never implemented** (board #91: /s/ is the solo shell) |

If a document/invoice token route is ever built it needs its own prefix decision
(§3): `/s/` currently belongs to the solo-driver shell, so reusing it would put
two unrelated surfaces in one location.

Contract properties, mapped to the acceptance criteria:

* **Unguessable.** The capability is the HMAC-SHA256 MAC (32 bytes) over a
  server-side secret, using the existing signed-token primitive; the token also
  carries the object id + scope + issue/expiry. There is no enumeration surface:
  a wrong or missing MAC is indistinguishable from a non-existent object.
  Entropy claim to verify: the MAC is 32 bytes (256 bits) — `track-link.test.js`
  already proves tamper/expiry/rotation rejection for the tracking scope; the
  same primitive must be reused for `document`/`invoice` (Max), not re-invented.
* **Revocable + expiring.** Global rotation via the dedicated
  `TRACK_LINK_SECRET`; per object via a `version` counter. Expired OR revoked
  must render a clear **404/410** with no data (the tracking surface already
  does this: unknown token → 404 JSON).
* **No cookies, no account.** The share response must not set `Set-Cookie`; the
  page must render with no session. (Enforced by
  `infra/checks/share-link-check.sh --live`, which fails on a `Set-Cookie`.)
* **No PII in logs.** §4.
* **Storage/backup unaffected.** §5.

## 3. nginx rules (config-as-code, owner window)

Files (both protected — reviewed by the Team Leader, merged by the owner):

* `infra/nginx/conf.d/roadwisefleet-limits.conf`
  * new `limit_req_zone $binary_remote_addr zone=rwf_share:10m rate=10r/s;`
    (human-paced guest GETs; the zone exists to stop token enumeration, not to
    throttle real customers),
  * the `map $uri $rwf_share_path` redaction and the `rwf_share` `log_format`
    (§4).
* `infra/nginx/roadwisefleet.conf`
  * `location /track/` moves from `rwf_pilot` to `rwf_share` and logs with the
    redacted format,
  * **`location /s/` today (board #91 correction):** it serves the solo-driver
    shell (board #77/#87) with `rwf_share` + the redacted log and the **app**
    header snippet — the pilot snippet this runbook used to recommend was
    superseded by PR #73; `location = /s` → 301 to `/s/` (not to the site root).
    The zone/log choice is intentionally unchanged: see the board #91 note in §1.
  * `limit_req_status 429` (already present) keeps the rate-limit answer a clear
    retryable status.

Install order matters: the conf.d file **must** be installed before the site
file, or `nginx -t` refuses the reload (`unknown limit_req_zone` / `unknown log
format`). Preflight: `bash infra/checks/nginx-limits-preflight.sh`; the guarded
pairing is also checked in CI by `share-link-check.sh`.

The API route for `/s/<scope>/<token>` does not exist (board #91: it was never
built), so the `/s/` location serves the solo shell and any other `/s/*` path is
the API's own 404 — **nothing is exposed by having the location installed**; the
invariant the `--live` probe checks is that an unknown `/s/*` path never returns
data with a 200.

## 4. Request logging without PII

The capability lives in the URL **path**, and the share page's own same-origin
`fetch('/api/track/<token>')` sends that path back in the `Referer`. A stock
`combined` access log therefore writes a live capability token in clear text,
where it outlives the link's expiry and its revocation.

Two defences, both in conf.d:

```
map $uri $rwf_share_path { default $uri; ~^/(track|s)/ /$1/<token>; }
log_format rwf_share '… "$request_method $rwf_share_path $server_protocol" $status $body_bytes_sent';
```

and both share locations set
`access_log /var/log/nginx/roadwisefleet-share.access.log rwf_share;`
(a location-level `access_log` **replaces** the server default, so the token
never reaches `access.log`).

Never logged: `$request`, `$request_uri`, `$uri`, `$args`/`$query_string`,
`$http_referer`, `$http_user_agent`. `share-link-check.sh` fails CI if any of
them reappear in the `rwf_share` format.

Deliberately retained: `$remote_addr`. A public capability URL needs its client
IP for rate-limit / abuse forensics; that is the single personal-data field kept
on purpose. Keep the share log on a short rotation (see
`infra/logrotate/roadwisefleet`) and document the retention position with the
secretary if the owner wants a formal one.

## 5. Storage, backup and restore impact

Share links are **stateless**: they add no database table and no on-disk store,
so neither the uploads storage nor the backup set changes shape.

* Uploads unchanged: the POD/eCMR bytes live where `infra/uploads.md` puts them
  (`/var/lib/roadwisefleet/uploads`, 0750 dirs / 0640 files). The
  `--live` probe of `infra/checks/uploads-perms-check.sh` must still pass
  (`failures: 0`), and `share-link-check.sh --live` asserts the document
  surface answers 404/410 for an unknown token — i.e. no document is reachable
  without a valid capability.
* Backups unchanged: `pilot-uploads-backup.timer` and `roadwise-pg-backup.timer`
  keep covering the same bytes. Nothing in #75 writes new persistent state, so a
  restore drill's expected row/file counts do not change.

## 6. Acceptance mapping

| Acceptance criterion | Status | Evidence / gap |
| --- | --- | --- |
| link opens in a clean browser profile with no account | **tracking: met live**; docs/invoice: **not implemented** (board #91 — `/s/` is the solo shell) | `/track/` is a 200 shell with no cookie and no session. New `--live` probe asserts cookie-free + noindex. The "clean profile" step is a manual browser check (no browser in my session). |
| revoked/expired link returns a clear 404/410 page | **tracking: met** | `/api/track/<random>` → 404 JSON today; `--live` asserts 404/410 and never 200. `track-link.test.js` proves expiry + version + secret-rotation rejection. |
| token ≥32 bytes of entropy | **primitive exists; not yet asserted for the new scopes** | HMAC-SHA256 MAC = 32 bytes; covered by code + `track-link.test.js` for the trip scope. The `document`/`invoice` scopes must reuse the same primitive (Max) — a CI assertion belongs with that code. |
| rate limit holds under a simple loop | **artifacts + CI guard; live proof pending** | `rwf_share` zone + `share-link-check.sh --live` loop (expects ≥1 × 429). The repo wiring is merged (PR #64); whether the host is actually serving an unthrottled `/track/` is only provable by the `--live` loop after the nginx window. |
| uploads storage and backups still pass their checks | **unchanged by design** | §5; `uploads-perms-check.sh` unchanged and still gated in CI. |

## 7. Role split and routing

* **Infra (this PR, me):** nginx rate limit + rules, PII-free logging, the
  `<token>`-path contract, the CI guard, this runbook.
* **App (software development → Max, max.cooper@elilaltd.com):** the scoped
  `document`/`invoice` share endpoints in `apps/api/src/routes/track.ts` (reusing
  `track-link.js`), the WhatsApp/SMS share actions, and the node test asserting
  the new token scopes' entropy/expiry/revocation. Requested via a ticket
  (`eila/requests#18`); the contract above is the interface. **Status 2026-09-30
  (board #91): never implemented — `/s/` is the solo-driver shell, so any future
  token route needs its own nginx prefix before it can be built.**
* **Owner / Team Leader:** the nginx change window (protected path
  `infra/nginx/**`) and, if a formal log-retention position is wanted, a written
  period.

## 8. Blockers

* **B1 — nginx reload window (owner).** The repo change is inert until installed
  on elilavps2; `nginx -t` and the reload are host/root work in an approved
  window. Exact order: §3 / `nginx-limits-preflight.sh`.
* **B2 — app endpoints (Max).** The `document`/`invoice` route under `/s/<scope>/<token>`
  was never built (board #91); the `/s/` prefix now belongs to the solo-driver shell,
  so the two non-tracking acceptance rows stay unprovable until a prefix decision is
  made (a new prefix is needed — do not fold a token route into the solo location).
* **B3 — manual browser/profile check.** "Opens in a clean browser profile" is a
  human step (my session has no browser); documented so it is not silently
  claimed.

## 9. Verification commands

```
# repo consistency (CI + here)
bash infra/checks/share-link-check.sh
bash infra/checks/share-link-check.sh --self-test
bash infra/checks/nginx-limits-preflight.sh

# after the owner window (on elilavps2 / any host with curl)
bash infra/checks/share-link-check.sh --live
sudo install -m 0644 infra/nginx/conf.d/roadwisefleet-limits.conf /etc/nginx/conf.d/
sudo install -m 0644 infra/nginx/roadwisefleet.conf /etc/nginx/sites-available/roadwisefleet.conf
sudo nginx -t && sudo systemctl reload nginx
bash infra/checks/uploads-perms-check.sh --live   # uploads guard still 0 failures
```
