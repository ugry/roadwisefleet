# Pilot public exposure runbook (roadwisefleet.com on elilavps2)

**Scope:** the public surface of the RoadwiseFleet pilot — nginx routing, the
three upstream services behind it, the deploy/rollback path, health checks, log
and credential locations. Read-only operations unless an owner has approved a
change. **No credential values appear in this document.**

**Status:** pilot. The pilot went public at <https://roadwisefleet.com/pilot/> on
2026-09-22 with a stopgap nginx edit (proxying `/pilot/` and `/api/` to the pilot
API on `127.0.0.1:8080`). This runbook turns that edit into owned configuration:
the reviewed config lives in [`nginx/`](./nginx/), the service units are mirrored
in [`systemd/`](./systemd/) and [`../services/waitlist/`](../services/waitlist/).

**Related:** [`pilot-api.md`](./pilot-api.md) (pilot API unit), [`pilot-db.md`](./pilot-db.md)
(Postgres/Redis/backups), [`README.md`](./README.md) (file index).

---

## 1. Public surface map

Everything terminates on nginx; the upstreams are loopback-only.

| Public path | Upstream | Served by | Notes |
|---|---|---|---|
| `/` and the four other static pages | `/var/www/roadwisefleet` | nginx (static) | Landing site. `Last-Modified: 2026-08-30`. |
| `/dashboard`, `/diagrams` | `/var/www/roadwisefleet/*.html` | nginx (`alias`) | Pretty-URL aliases. |
| `/api/waitlist` | `127.0.0.1:8787` | `roadwisefleet-waitlist.service` | **Legacy** waitlist microservice. Exact-match location. |
| `/pilot/`, `/pilot/*.html` | `127.0.0.1:8080` | `roadwise-api.service` (`@fastify/static`, prefix `/pilot/`) | Non-indexable preview surface. |
| `/pilot` (no slash) | — | nginx `301` → `/pilot/` | |
| `/track/<token>` | `127.0.0.1:8080` | `roadwise-api.service` | Public, unauthenticated customer tracking link (board #5). **Not reachable off-host today** — the prod vhost proxies only `/api/` and `/pilot/`; the `location /track/` block is prepared in [`nginx/roadwisefleet.conf`](./nginx/roadwisefleet.conf) and lands with this change. |
| `/api/*` (except `/api/waitlist`) | `127.0.0.1:8080` | `roadwise-api.service` | Pilot API: `/api/auth/*`, `/api/trips*`, `/api/waitlist` (not reached — see below). |
| `/health` | — | `404` (nginx) | The API's `/health` is **not** exposed publicly, by design. |

Routing rule that matters: nginx longest-prefix wins, so the exact
`location = /api/waitlist` beats `location /api/`. That is what keeps the live
landing-page signup on the old 8787 service while `/api/*` belongs to the pilot
API. The pilot API also implements `POST/GET /api/waitlist`, but that code path
is **unreachable from the internet** until the unification task lands.

### Observed live state (read-only probes, 2026-09-22 ~15:19 UTC)

```
$ curl -sI https://roadwisefleet.com/
HTTP/1.1 200 OK                          Server: nginx
                                         Last-Modified: Sun, 30 Aug 2026 08:33:39 GMT
                                         (no HSTS / CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy)

$ curl -sI https://www.roadwisefleet.com/
HTTP/1.1 200 OK                          <-- NOT redirected to apex (F2, open)

$ curl -sI http://roadwisefleet.com/     HTTP/1.1 301  Location: https://roadwisefleet.com/
$ curl -sI http://www.roadwisefleet.com/ HTTP/1.1 301  Location: https://www.roadwisefleet.com/   <-- www kept

$ curl -sI https://roadwisefleet.com/pilot/
HTTP/1.1 200 OK                          X-Robots-Tag: noindex, nofollow

$ curl -sI https://roadwisefleet.com/pilot       HTTP/1.1 301  Location: https://roadwisefleet.com/pilot/
$ curl -sI https://roadwisefleet.com/api/trips   HTTP/1.1 401  Content-Type: application/json; charset=utf-8   (pilot API)
$ curl -sI https://roadwisefleet.com/api/health  HTTP/1.1 404  Content-Type: application/json; charset=utf-8   (pilot API)
$ curl -sI https://roadwisefleet.com/api/waitlist      HTTP/1.1 404  access-control-allow-origin: *            (8787 service)
$ curl -sI https://roadwisefleet.com/api/waitlist/     HTTP/1.1 404  access-control-allow-origin: *            (8787 service)
$ curl -sI https://roadwisefleet.com/health            HTTP/1.1 404  Content-Type: text/html                  (nginx)
$ curl -sI http://127.0.0.1:8080/health          HTTP/1.1 200  Content-Type: application/json; charset=utf-8
```

The `access-control-allow-origin: *` + `POST, OPTIONS` header set is the
fingerprint of the 8787 waitlist service; `application/json; charset=utf-8` is
the Fastify/pilot-API fingerprint. That is how the split is verified without
reading the host config.

### Observed live state after the application window (2026-09-23 22:51 UTC)

The owner authorised the nginx changes on 2026-09-23; the window was applied by
the Team Leader (backup `/var/backups/nginx-config/20260923T225154Z/`, see §2).
External probes from elilavps1 (`mail.elilaltd.com` — a different host from
elilavps2, so this is not a loopback test):

```
$ curl -sI https://roadwisefleet.com/
HTTP/1.1 200 OK
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
Content-Security-Policy: default-src 'self'; ...             (full policy in nginx/snippets/)

$ curl -sI https://www.roadwisefleet.com/pilot/   301  Location: https://roadwisefleet.com/pilot/   (F2 closed)
$ curl -sI http://roadwisefleet.com/anything      301  Location: https://roadwisefleet.com/anything
$ curl -sI https://roadwisefleet.com/pilot/       200  X-Robots-Tag: noindex, nofollow  + HSTS/XFO/CSP
$ curl -sI https://roadwisefleet.com/api/waitlist 401  (legacy 8787 service; exact-match block)
$ curl -sI https://roadwisefleet.com/api/auth/me  401  (pilot API)
$ POST 2.5 MB /api/trips/X/documents              400  (API answered; was nginx 413)  <-- board #41
$ POST 2.5 MB /api/auth/login                     413  (nginx, 1 MB default kept — scope confined)
```

The landing pages are byte-identical before/after (`/` 65067 B, `/dashboard`
62321 B, `/diagrams` 9386 B), so there is no visible site change. The 2.5 MB
upload probe reaches the API instead of being rejected by nginx, which is the
fix for board #41; a >25 MB body is still refused on that route.

---

## 2. nginx configuration

| Item | Value |
|---|---|
| Host | elilavps2 |
| Site file | `/etc/nginx/sites-available/roadwisefleet.conf` (root:root, `0644`) |
| Enabled | `sites-enabled/roadwisefleet.conf` → symlink to the above |
| Header snippets | `/etc/nginx/snippets/roadwisefleet-headers-{static,pilot,api}.conf` |
| Rate-limit zones | `/etc/nginx/conf.d/roadwisefleet-limits.conf` (http context) |
| Review copies | [`nginx/roadwisefleet.conf`](./nginx/roadwisefleet.conf), [`nginx/snippets/`](./nginx/snippets/), [`nginx/conf.d/`](./nginx/conf.d/) |
| TLS | Let's Encrypt, `CN=roadwisefleet.com` **with www in the SAN**, managed by certbot |
| Certbot lines | `# managed by Certbot` — regenerated on renewal; keep verbatim |
| Pre-change backup | `roadwisefleet.conf.bak-20260922` (the orchestrator's stopgap backup, 2026-09-22 15:05 UTC) |
| **Applied** | **2026-09-23 22:51 UTC** (owner-authorised window). The mirror is byte-identical to the running host file: `sha256 c34193a347f2a6680cbd74af6b7b0023f0ae6aadfef0fa6b8d9a077af265271e` |
| Window backup | `/var/backups/nginx-config/20260923T225154Z/` (`etc-nginx.tgz` + `nginx -T` before + the old site file) |

**Provenance.** Before 2026-09-23 the sandbox could not read `/etc`, so the
review copies in `nginx/` were reconstructed from (a) the observed live
responses in §1 and (b) the previous mirror in this repo. That is no longer the
case: on 2026-09-23 the mirror was installed on the host and the host file was
verified byte-identical (sha256 above), so the mirror *is* the applied
configuration. When editing it, still diff against the live file first —
certbot may have rewritten the `# managed by Certbot` block on renewal.

### Apply (requires owner approval — production change)

```bash
# 1. take a fresh backup and diff
sudo cp /etc/nginx/sites-available/roadwisefleet.conf \
        /etc/nginx/sites-available/roadwisefleet.conf.bak-$(date +%Y%m%d-%H%M)
sudo diff -u /etc/nginx/sites-available/roadwisefleet.conf infra/nginx/roadwisefleet.conf

# 2. install snippets + (optional) rate-limit zones FIRST
sudo install -m 0644 infra/nginx/snippets/roadwisefleet-headers-static.conf /etc/nginx/snippets/
sudo install -m 0644 infra/nginx/snippets/roadwisefleet-headers-pilot.conf  /etc/nginx/snippets/
sudo install -m 0644 infra/nginx/snippets/roadwisefleet-headers-api.conf    /etc/nginx/snippets/
sudo install -m 0644 infra/nginx/conf.d/roadwisefleet-limits.conf           /etc/nginx/conf.d/

# 3. install the site file and validate BEFORE reloading
sudo install -m 0644 infra/nginx/roadwisefleet.conf /etc/nginx/sites-available/roadwisefleet.conf
sudo nginx -t          # MUST print "syntax is ok" / "test is successful"
sudo systemctl reload nginx

# 4. verify (read-only)
bash infra/checks/pilot-exposure-check.sh
```

`nginx -t` fails closed: a bad config leaves the running nginx untouched, so
step 3 cannot take the site down.

### Rollback

```bash
sudo cp /etc/nginx/sites-available/roadwisefleet.conf.bak-<stamp> \
        /etc/nginx/sites-available/roadwisefleet.conf
sudo nginx -t && sudo systemctl reload nginx
```

If a snippet is the problem, delete it and remove the matching `include` line
first — `nginx -t` refuses to start with a dangling `include`.

---

## 3. Service topology and reboot resilience

| Unit | Provides | Listen | Enabled | Ordering / restart |
|---|---|---|---|---|
| `nginx.service` | TLS + routing | `0.0.0.0:80`, `0.0.0.0:443` | yes | distro unit |
| `roadwisefleet-waitlist.service` | legacy waitlist | `127.0.0.1:8787` | yes | `After=network.target`, `Restart=always`, `RestartSec=3` |
| `roadwise-pg.service` | pilot Postgres 17 (podman, rootful) | `127.0.0.1:5432` | yes | `After=`/`Wants=network-online.target`, `ExecStartPre=-podman rm -f roadwise-pg`, `Restart=always`, `RestartSec=5` |
| `roadwise-redis.service` | pilot Redis 7 (podman, rootful) | `127.0.0.1:6379` | yes | `Restart=always` (see gap R1) |
| `roadwise-api.service` | pilot API + `/pilot/` UI | `127.0.0.1:8080` | yes | `After=network-online.target roadwise-pg.service roadwise-redis.service`, `Wants=network-online.target`, `Requires=roadwise-pg.service`, `Restart=always`, `RestartSec=5` |
| `roadwise-pg-backup.timer` | nightly `pg_dump` | — | yes | next trigger 03:15 UTC |

Boot order is therefore `network-online → pg/redis → api`, and every service is
`enabled` and `Restart=always`, so a host reboot brings the whole stack back
without a manual step. Postgres keeps its data in the named volume
`roadwise-pgdata`; Redis in `roadwise-redisdata`.

### Reboot simulation — procedure (NOT yet run: needs a maintenance window)

Restarting the pilot services is a production change, so it has **not** been
executed from this sandbox. Run this in an agreed window; it is expected to be
invisible to the landing page (`/` and `/api/waitlist` do not touch these units):

```bash
# a) containers first
sudo systemctl restart roadwise-pg
sudo systemctl restart roadwise-redis
curl -sI http://127.0.0.1:8080/health        # API should ride through; it reconnects lazily

# b) then the API
sudo systemctl restart roadwise-api
curl -sI http://127.0.0.1:8080/health        # expect 200
curl -sI https://roadwisefleet.com/pilot/    # expect 200 + X-Robots-Tag
curl -sI https://roadwisefleet.com/api/trips # expect 401 (auth guard, not 502)

# c) confirm nothing is left in a restart loop
systemctl status roadwise-api roadwise-pg roadwise-redis
journalctl -u roadwise-api -n 50 --no-pager
```

For a true reboot test, coordinate a window, `sudo reboot`, then re-run
`infra/checks/pilot-exposure-check.sh`. Do **not** reboot the host ad hoc.

### Known resilience gaps (proposed, not applied)

| ID | Gap | Proposed fix | Owner |
|---|---|---|---|
| R1 | `roadwise-redis.service` has no `ExecStartPre=-/usr/bin/podman rm -f roadwise-redis`, unlike the pg unit. If podman dies while the container is still alive, `Restart=always` re-runs `podman run --name roadwise-redis` and fails with a name conflict, giving a restart loop instead of a recovery. | Add the same `ExecStartPre` cleanup line the pg unit already has. | owner approval (unit change) |
| R2 | `roadwise-api.service` starts as soon as pg's *unit* is active — i.e. as soon as `podman run` returns, before Postgres accepts connections. Prisma reconnects lazily, so the first requests after a cold boot can 500. | Add a readiness gate to the API unit (e.g. an `ExecStartPre` that waits for `pg_isready`), or a `Type=notify`/health probe. | owner approval (unit change) |
| R3 | `GET /health` is a liveness probe only — it returns `200 {"ok":true}` even when Postgres/Redis are unreachable, so it cannot be used as a deploy gate. | Add a `/health/ready` that pings the DB, and point monitoring at it. | **developer** (app code) |

---

## 4. Deploy / update — landing site + waitlist (`deploy.sh`)

The sanctioned path is the manual [`deploy.sh`](../deploy.sh) (decision recorded
in Gitea `eila/requests#3`; an Actions-based VPS deploy is deferred). It pushes
`web/*.html` to `/var/www/roadwisefleet`, `services/waitlist/server.js` to
`/opt/roadwisefleet/waitlist/`, reloads nginx and restarts the waitlist unit.

```bash
./deploy.sh                 # RWF_VPS / RWF_DEPLOY_KEY can override the defaults
```

There is **no rollback in the script** — take a snapshot first:

```bash
# pre-deploy snapshot (on elilavps2)
sudo tar czf /var/backups/roadwisefleet/web-$(date +%Y%m%d-%H%M).tgz -C /var/www roadwisefleet
sudo cp /opt/roadwisefleet/waitlist/server.js /opt/roadwisefleet/waitlist/server.js.bak-$(date +%Y%m%d-%H%M)

# rollback
sudo tar xzf /var/backups/roadwisefleet/web-<stamp>.tgz -C /var/www
sudo cp /opt/roadwisefleet/waitlist/server.js.bak-<stamp> /opt/roadwisefleet/waitlist/server.js
sudo systemctl reload nginx && sudo systemctl restart roadwisefleet-waitlist
curl -sI https://roadwisefleet.com/ && curl -sI https://roadwisefleet.com/api/waitlist
```

Post-deploy checks: `/` returns 200 with a fresh `Last-Modified`, `POST
/api/waitlist` still answers (`curl -s -X POST -H 'content-type: application/json'
-d '{"email":"you@example.com"}' https://roadwisefleet.com/api/waitlist` →
`201 {"ok":true}`), and `/pilot/` is unaffected.

> The static site is also published to GitHub Pages by CI (`deploy-pages` job).
> That copy posts to the production waitlist API — see §9 (F3).

## 5. Deploy / update — pilot API + `/pilot/` surface

In-place git checkout on the host; see [`pilot-api.md`](./pilot-api.md) §6. CI
(`api-tests`, `lint`) must be green on `main` first. A pilot web-surface change
only needs the API restart, not `deploy.sh`.

## 6. Health checks and logs

| What | Command / location |
|---|---|
| API liveness (host) | `curl -sI http://127.0.0.1:8080/health` → `200` |
| API liveness (public, expected `404` — not exposed) | `curl -sI https://roadwisefleet.com/health` |
| Pilot surface | `curl -sI https://roadwisefleet.com/pilot/` → `200`, `X-Robots-Tag: noindex, nofollow` |
| Pilot API reachability | `curl -sI https://roadwisefleet.com/api/trips` → `401` (auth guard working; `502` means the API is down) |
| Waitlist reachability | `curl -sI https://roadwisefleet.com/api/waitlist` → `404` + `access-control-allow-origin: *` (GET without token); `502` means 8787 is down |
| Landing page | `curl -sI https://roadwisefleet.com/` → `200` |
| Ports | `ss -ltn` → `127.0.0.1:8080`, `127.0.0.1:8787`, `127.0.0.1:5432`, `127.0.0.1:6379`, `0.0.0.0:80/443` |
| Full sweep | `bash infra/checks/pilot-exposure-check.sh` |
| nginx logs | `/var/log/nginx/access.log`, `/var/log/nginx/error.log` |
| API logs | `journalctl -u roadwise-api -f` |
| Waitlist logs | `journalctl -u roadwisefleet-waitlist -f` |
| Postgres/Redis logs | `journalctl -u roadwise-pg -f` / `journalctl -u roadwise-redis -f` (podman → journald) |
| Backups | `/var/backups/roadwisefleet/` (`postgres/`, waitlist `tar.gz`), 14-day retention |

## 7. Rate limiting (enabled in code; applies with the owner window)

`infra/nginx/conf.d/roadwisefleet-limits.conf` defines per-IP zones
(`rwf_waitlist` 5 r/m, `rwf_api` 30 r/s, `rwf_pilot` 20 r/s, `limit_req_status 429`) and
the four `limit_req zone=... burst=... nodelay;` lines in
`nginx/roadwisefleet.conf` (`/api/waitlist`, `/pilot/`, `/track/`, `/api/`) are now
**uncommented in the repo** (board #45). The live host is unchanged — this lands
in the same owner-approved reload that carries the #7 headers/www→apex change
and the #41 `client_max_body_size` line, because one reload applies all three.

Install order (strict — the zones file first, or `nginx -t` refuses the reload
with `unknown limit_req_zone`):

1. `sudo install -m 0644 infra/nginx/conf.d/roadwisefleet-limits.conf /etc/nginx/conf.d/`
2. `sudo install -m 0644 infra/nginx/roadwisefleet.conf /etc/nginx/sites-available/roadwisefleet.conf`
3. `sudo nginx -t` (must print `test is successful`), then `sudo systemctl reload nginx`

Run `bash infra/checks/nginx-limits-preflight.sh` first: it verifies in the repo
that every enabled `limit_req zone=X` has a declared `limit_req_zone`, checks the
live copies when run on the host, and prints the exact install order. Rollback is
re-commenting the four lines and reloading.

Step 1 is **done** (installed 2026-09-23 22:51 UTC with the exposure window — it
is inert on its own). Step 2 is still pending: it is board `eila/tasks#45` and
needs the owner's go for one more reload. Reversing is just re-commenting the
lines.

**Why both nginx and the app limiter exist (decision, board #45).** The app
limiter in `services/waitlist/server.js` was *fixed*, not removed:

* the nginx zones are not live yet, so removing the app limiter would leave the
  public signup endpoint with **zero** throttling in the meantime;
* the fixed app limiter keys on the real client (`X-Real-IP`, trusted **only**
  from a loopback peer, i.e. our own nginx; a direct caller's headers are
  ignored), so it is per-IP correct and cannot be spoofed around;
* nginx stays the outer layer (`$binary_remote_addr`, 5 r/m + burst), the app
  limiter the inner one — defence in depth on a public, unauthenticated write.

Proof that the app limiter is no longer global: `services/waitlist/server.test.js`
(two client IPs, independent buckets) runs in the `api-tests` CI job.

## 8. Security headers

**Before (observed 2026-09-22):** no `Strict-Transport-Security`,
`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options` or
`Referrer-Policy` on any response; `www` served `200` instead of redirecting
(issue #2, F1/F2).

**Applied 2026-09-23 22:51 UTC** (`nginx` reload in the owner window): the live
responses now carry HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy` and CSP on the static site, the pilot
surface and the API (verified from the live headers). That same window installed
the upload-location snippet include carrying the board-#41
`client_max_body_size 25m` block (this PR).

**Board #65 regression — fixed in the repo and verified live.** The pilot
snippet went live with a "self-contained" template CSP that allowed
`script-src 'unsafe-inline'` but **not `'self'`**, so every
`<script src="lib/i18n.js">` the pilot pages load was blocked and
`/pilot/` + the driver PWA never booted (QA F-surface-1; the same policy also had
no `manifest-src`/`worker-src` for `manifest.webmanifest`/`sw.js`). The snippet
now carries `script-src 'self' 'unsafe-inline'`, `style-src 'self'
'unsafe-inline'`, `worker-src 'self'` and `manifest-src 'self'` while keeping
`default-src 'none'` and the rest of the lockdown. `infra/checks/pilot-csp-check.sh`
asserts the policy against the pilot's real resource inventory in CI
(`pilot-csp-check` job), so this class of failure cannot ship again. **Verified
live 2026-09-24 23:07 UTC:** `https://roadwisefleet.com/pilot/` returns
`script-src 'self' 'unsafe-inline'` (plus `worker-src`/`manifest-src 'self'`), so
the corrected snippet is applied and the P0 is closed on the surface.

**CSP choice and evidence.** The pages are static files with inline `<style>` and
inline `<script>`, so `'unsafe-inline'` is required in `script-src`/`style-src`
unless the markup is changed. The chosen policy therefore allows inline code but
locks everything else down (`default-src 'none'` for the pilot,
`default-src 'self'` for the landing page, `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'none'`/`'self'`, `form-action 'self'`), and
it is derived from the actual resource inventory:

* `web/` has no `<script src=...>`; **`pilot/` loads `lib/i18n.js`,
  `lib/i18n-ui.js` and `lib/driver-core.js` from same-origin paths since the i18n
  change (`d3c9ddc`)** → `script-src`/`style-src` must include `'self'`
  (the original inventory predates that change — board #65);
* no external hosts at all on the pilot pages, and only `fonts.googleapis.com`
  (CSS) + `fonts.gstatic.com` (fonts) from the landing pages;
* `driver.html` declares `manifest.webmanifest` and registers `sw.js` →
  `manifest-src 'self'` + `worker-src 'self'`;
* favicon/icons are same-origin, plus a `data:` URI on the landing pages →
  `img-src 'self' data:`;
* `fetch()` targets are same-origin → `connect-src 'self'`;
* no `eval()` / `new Function()` / `document.write()` → no `'unsafe-eval'`.

**Removing `'unsafe-inline'`** (the real XSS win) needs per-page nonces or
hashes, which means touching the page generation/serving path — the developer's
area, tracked in §9. `preload` on HSTS is deliberately not set: it is a
hard-to-reverse, policy-level decision and needs a subdomain audit first.

## 9. Open items and gaps

| ID | Item | Owner |
|---|---|---|
| O1 | **DONE 2026-09-23 22:51 UTC** — header/redirect/zones window applied and verified from an external host (§1). The zones file is installed (step 1 of §7); enabling the four `limit_req` lines is step 2, still pending the owner's reload (board `eila/tasks#45`). | ops + owner |
| O2 | `www` HTTPS redirect **fixed 2026-09-23** (`301`); the `<link rel="canonical">` tag is still a page change. | dev (canonical) |
| O3 | Waitlist limiter **was** effectively global behind the proxy (`req.socket.remoteAddress` is always `127.0.0.1`). **Fixed in code (board #45):** it keys on `X-Real-IP` when — and only when — the peer is loopback, else on the peer address, with the `node:test` regression in the `api-tests` CI job. nginx-side zones are the outer layer (§7). | ~~developer~~ done (ops) / enable in the owner window |
| O4 | `GET /api/waitlist` with the admin token returns the whole waitlist in one JSON body, unauthenticated-by-default-rate-limit and unthrottled. Acceptable for a pilot; it should move behind the pilot API's auth and get a rate limit before any real launch. | ops (rate limit) / dev (auth) |
| O5 | GitHub Pages publishes a byte-identical copy of the landing pages that posts to the production waitlist API, with no `canonical`/`noindex` (issue #2, F3). | dev / marketing |
| O6 | `/robots.txt` and `/sitemap.xml` are 404 (issue #2, F5). | dev |
| O7 | `deploy.sh` has no rollback and references a hardcoded SSH key path under another user's home; the key itself is correctly outside the repo. | ops (rollback documented §4) |
| O8 | Rootful podman for pg/redis — revisit before production (see `pilot-db.md` §7). | ops + owner |
| O9 | `AUTH_SECRET` / `ADMIN_TOKEN` are pilot values; rotate before real use (see `pilot-api.md` §7). | owner |
