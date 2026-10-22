# Off-platform share links — transport runbook (board eila/tasks#75, UXF-O1)

Status: **tracking live; guest document/invoice app half built (2026-10-22).**
The `/track/` location is applied on the host. The guest document + invoice
views were built on their own `/g/<scope>/<token>` prefix (board #132,
UXF-O1a) — the app route exists in `main`'s PR line, and the `/g/` nginx block
is config-as-code behind the owner change window (protected path
`infra/nginx/**`). Until that block is installed, `/g/` is not reachable on the
public URL; the API itself answers correctly on the loopback port.

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
| `GET /s/<64-hex>` | **200** `text/html` — the solo-driver shell (board #77/#87) answers here; see the board #91 update below |
| `GET /g/document/<64-hex>` | **404** `application/json` `invalid_token`; no `Set-Cookie` — the guest document surface (board #132) |

So the **F8 tracking link is already live and correct** for the tracking surface:
the HTML shell is public, the data endpoint rejects an unknown token with a clear
404 and a JSON error, and no cookie is set. The `/track/` nginx location is
applied on the host (it serves the pilot CSP header set).

**Board #91 update (2026-09-30).** `/s/` is no longer the surface this task
specified. The solo-driver shell (board #77) answers there — live measured
2026-09-30: `GET /s/` **200** `text/html` with the strict **app** CSP,
`GET /s` **301** → `/s/` (PR #73 / board #87). The document/invoice share token
was **never implemented under `/s/`** (the app half was requested from Max and
not built there). **Board #132 (2026-10-22)** then built that half on its own
prefix, `/g/<scope>/<token>` — see §2 — because `/s/` and `/track/` each belong
to another surface. Two consequences for this runbook:

* the `/s/` nginx location now includes `roadwisefleet-headers-app.conf`, not the
  pilot snippet — the solo shell declares no inline `<script>`/`<style>`;
* the location is still kept on the `rwf_share` zone and the PII-free log
  (§3/§4). The board #75 review decided **not** to relax the merged
  `share-link-check` guard, so `SHARE_LOCATIONS=("/track/" "/s/" "/g/")` reads
  as "locations that can carry a share token", not "the three original #75
  surfaces". §3 below carries the corrected wording.

**Board #132 update (2026-10-22).** The `/g/` app half is built (§2) and the
`--live` probe was corrected: it used to FAIL `GET /s/<random> -> 200` even
though that 200 is the solo shell by design (§3), and it asserted nothing about
a document surface. It now (a) accepts `/s/` only when the answer is the
solo shell itself (`text/html`, no `Content-Disposition`, no cookie) and keeps
everything else a FAIL, and (b) probes `/g/document/<random>` and
`/g/invoice/<random>` for **404/410, never 200**, with no `Set-Cookie`. The
`/api/track/` and rate-limit assertions are unchanged. The document/invoice
**send** actions (WhatsApp/SMS) stay with #75's provider decision.

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
| POD / eCMR download | `/g/document/<token>` | `document:<id>` | **built** (board #132; `/g/` nginx block pending install) |
| invoice view | `/g/invoice/<token>` | `invoice:<id>` | **built** (board #132; `/g/` nginx block pending install) |

**Prefix decision (board #132, 2026-10-22).** `/s/` belongs to the solo-driver
shell (board #91) and `/track/` to the F8 tracking link, so the guest document
surface has its **own** prefix: `/g/<scope>/<token>`, `scope ∈ {document,
invoice}`. A token route is never folded into `/s/` or `/track/`.

Route shape (app half, `apps/api/src/routes/guest-share.ts`):

* `GET /g/document/<token>` → the stored POD / eCMR bytes as an **attachment**
  (`Content-Disposition: attachment`), `GET /g/invoice/<token>` → **inline**;
  both `X-Robots-Tag: noindex`, `Cache-Control: no-store`, and never a cookie;
* the token reuses `apps/api/src/track-link.js`: `share:document:<id>~<version>`
  / `share:invoice:<id>~<version>`, the same HMAC-SHA256 key (derived from
  `AUTH_SECRET` / `TRACK_LINK_SECRET`), the same 30-day TTL, and the owning
  trip's `trackLinkVersion` — so revoking the shipment link revokes its
  document links, and no schema column was added;
* a document is only served while its status is `UPLOADED` / `VERIFIED` (the
  per-document revoke); `PENDING` and `REJECTED` are a flat 404;
* minting is `POST /api/documents/:id/share-link` (bearer, `trip:*`,
  org-scoped through the trip) and needs a **live** shipment link — the guest
  link lives inside that share window; `GET` returns the same link (HMAC over
  the persisted window is deterministic).

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
  * **`location /g/` (board #132):** `limit_req zone=rwf_share burst=20 nodelay`,
    `access_log … rwf_share`, the **API** header snippet (the response is a file
    or a JSON 404, never HTML), proxy to `127.0.0.1:8080`, `proxy_read_timeout
    30s`. No no-slash redirect: `/g` alone is not a surface.
  * `limit_req_status 429` (already present) keeps the rate-limit answer a clear
    retryable status.

Install order matters: the conf.d file **must** be installed before the site
file, or `nginx -t` refuses the reload (`unknown limit_req_zone` / `unknown log
format`). Preflight: `bash infra/checks/nginx-limits-preflight.sh`; the guarded
pairing is also checked in CI by `share-link-check.sh`.

The `/s/` location serves the solo shell; the guest document route lives under
`/g/` (board #132). The `--live` probe asserts, for **both**:
`/s/<random>` is either a 404/410 or the solo shell itself (`text/html`, no
`Content-Disposition`, no cookie) — a 200 carrying document bytes or a cookie is
a FAIL; and `/g/document/<random>` / `/g/invoice/<random>` are **404/410, never
200**, with no cookie.

## 4. Request logging without PII

The capability lives in the URL **path**, and the share page's own same-origin
`fetch('/api/track/<token>')` sends that path back in the `Referer`. A stock
`combined` access log therefore writes a live capability token in clear text,
where it outlives the link's expiry and its revocation.

Two defences, both in conf.d:

```
map $uri $rwf_share_path { default $uri; ~^/(track|s|g)/ /$1/<token>; }
log_format rwf_share '… "$request_method $rwf_share_path $server_protocol" $status $body_bytes_sent';
```

and all three share locations set
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
  (`/var/lib/roadwisefleet/uploads`, 0750 dirs / 0640 files) and the guest route
  reads them through the same `resolveWithin` + `createReadStream` path the app
  uses — there is **no second storage root**. The `--live` probe of
  `infra/checks/uploads-perms-check.sh` must still pass (`failures: 0`), and
  `share-link-check.sh --live` asserts the document surface answers 404/410 for
  an unknown token — i.e. no document is reachable without a valid capability.
* Backups unchanged: `pilot-uploads-backup.timer` and `roadwise-pg-backup.timer`
  keep covering the same bytes. Nothing in #75 writes new persistent state, so a
  restore drill's expected row/file counts do not change.

## 6. Acceptance mapping

| Acceptance criterion | Status | Evidence / gap |
| --- | --- | --- |
| link opens in a clean browser profile with no account | **tracking: met live**; docs/invoice: **built, awaiting the `/g/` nginx apply** (board #132) | `/track/` is a 200 shell with no cookie and no session. `/g/document/…` and `/g/invoice/…` are cookie-free `app.inject()` 200s with the exact stored bytes (real POD + invoice fixtures, `test/guest-share.test.ts`); live HTTP needs the `/g/` block installed. The "clean browser profile" step stays a manual check. |
| revoked/expired link returns a clear 404/410 page | **tracking: met**; docs/invoice: **met in code** | `/api/track/<random>` → 404 JSON today; `--live` asserts 404/410 and never 200 for `/track/`, `/api/track/` and both `/g/` scopes. `track-link.test.js`/`guest-share.test.js` prove expiry + version + secret-rotation rejection, and the HTTP suite proves a shipment revoke and a `REJECTED` document both 404. |
| token ≥32 bytes of entropy | **met** | HMAC-SHA256 MAC = 32 bytes, asserted for the new scopes in `apps/api/src/guest-share.test.js` (signature decodes to exactly 32 bytes, different bytes per document and per scope, tamper/expiry/rotation rejection). Reuses `track-link.js`, not a new format. |
| rate limit holds under a simple loop | **met live (2026-10-22)** | Team Leader's `share-link-check.sh --live` on `main` `1df6506`: `ok rate limit holds: 14 of 60 rapid requests to /track/ were 429`. The same zone applies to `/g/` once its location is installed. |
| uploads storage and backups still pass their checks | **unchanged by design** | §5; `uploads-perms-check.sh` unchanged and still gated in CI; the guest route reads the existing root. |

## 7. Role split and routing

* **Infra (this PR, me):** nginx rate limit + rules, PII-free logging, the
  `<token>`-path contract, the CI guard, this runbook. Board #132 added the
  `/g/` location + the map's `g` alternative + the corrected `--live` probe.
* **App (software development → Max, max.cooper@elilaltd.com):** the scoped
  `document`/`invoice` share endpoints — **delivered 2026-10-22 on board #132**
  in `apps/api/src/routes/guest-share.ts` + `apps/api/src/guest-share.js`,
  reusing `track-link.js`, with `apps/api/src/guest-share.test.js` (contract) and
  `apps/api/test/guest-share.test.ts` (HTTP + real bytes). Prefix `/g/` (above).
  The WhatsApp/SMS **send** actions remain the provider-gated half of #75.
* **Owner / Team Leader:** the nginx change window (protected path
  `infra/nginx/**`) and, if a formal log-retention position is wanted, a written
  period.

## 8. Blockers

* **B1 — nginx reload window (owner).** The repo change is inert until installed
  on elilavps2; `nginx -t` and the reload are host/root work in an approved
  window. Exact order: §3 / `nginx-limits-preflight.sh`.
* **B2 — app endpoints (Max): CLEARED 2026-10-22.** Delivered on `/g/<scope>/<token>`
  (board #132) — its own prefix, so neither the solo shell nor the tracking link was
  reused. The remaining gate is B1 (the `/g/` location must be installed before the
  public URL serves it); the loopback API route is already exercised by the tests.
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
