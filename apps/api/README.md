# RoadwiseFleet API (Phase 0 scaffold)

Fastify + Prisma + PostgreSQL (TimescaleDB/PostGIS), per `docs/backend-infrastructure-plan.md`.

## Status
Boots against the pilot Postgres. Prisma client generation, migrations, the
pilot seed, minimal token auth and the core trip loop are wired.

## Layout
- `src/` — API (TypeScript, run with `tsx`).
- `prisma.config.ts` — points Prisma at the repo-root schema (`../prisma/schema.prisma`)
  and loads the schema-dir `.env`. A Prisma config file makes the CLI stop
  auto-loading `.env`, which also avoids the "conflict between env vars" error
  from having both `apps/api/.env` and `prisma/.env` on disk.
- `scripts/seed-pilot.ts`, `scripts/smoke-pilot.ts` — pilot seed and end-to-end smoke.
  The seed also supports `--reset` (see "Pilot demo reset" below).
- `scripts/waitlist-handoff.ts` — manual waitlist → account handoff (see below).
- `../../pilot/` — the pilot-only web surface served by this API under `/pilot/`
  (repo-root dir, separate from the production `web/`). Its UI strings — EN/DE/PL/TR
  — live in `pilot/locales/` (see "Internationalisation" below).
- `../../app/` — the Fleet Manager application served by this API under `/app/`
  (board task #32, see "Fleet Manager app" below). Its English catalogue lives in
  `app/locales/en.json`.

## Run
```bash
pnpm install                          # from repo root; postinstall generates the Prisma client
# set AUTH_SECRET in apps/api/.env (required — see below)
pnpm --filter @roadwisefleet/api db:migrate
pnpm --filter @roadwisefleet/api db:seed -- --password=...
pnpm dev                              # API on 127.0.0.1:8080
```
`DATABASE_URL` is read from `apps/api/.env` (or the repo-root `.env`); Node 20
`process.loadEnvFile` loads it, no dotenv dependency.

`AUTH_SECRET` signs pilot session tokens and is **required** — there is no
committed fallback. The operator sets a strong value in the environment or
`apps/api/.env`; the API fails fast at startup when it is missing. For local
development and tests only, `ALLOW_INSECURE_AUTH_SECRET=1` (or `NODE_ENV=test`)
uses an ephemeral random secret for that process. Never commit a secret.

## Pilot demo reset
QA/acceptance runs leave extra trips in the pilot org, so the public demo shows
more rows than the seed defines (GitHub issue #12). The reset path removes every
pilot-org trip the seed does **not** own — together with its dependent rows
(documents, status events, GPS pings, expenses, settlement, stops, driver links)
— and then re-applies the idempotent seed. The seeded `pilot-trip-1` and
`pilot-trip-2` are never touched.

```bash
# wipe residual demo trips, then re-seed to exactly the two seeded trips
pnpm --filter @roadwisefleet/api db:reset -- --password=...

# equivalent, explicit form
pnpm --filter @roadwisefleet/api db:seed -- --reset --password=...
```

The decision logic is pure and dependency-free (`src/demo-reset.js`, covered by
`src/demo-reset.test.js`); the script only performs the writes. The reset is
scoped to the pilot org (`pilot-org`) — it never touches another org's data.

## Test
Pure logic (state machine, scrypt password hashing, token signing/verification,
RBAC capability checks, AUTH_SECRET resolution, trip-loop core against a fake
Prisma client, create-trip reference loaders, trip detail shaping/P&L, pilot
demo-reset planning, tracking-link signing/shaping, document capture validation,
driver-PWA tour card/checklist/offline queue, Fleet Manager routing/role guard and
static-serving rules, the Fleet Manager dispatch form (option labels, validation,
payload and error mapping), trip-list filter validation, trips-view filter/query/CSV
shaping, the dashboard KPIs/alerts/activity shaping and its view model, user/driver
credential-field stripping, trip read visibility (the `trip:*` org-wide rule vs.
the driver scope), the delivery-timestamp writer (`deliveredAt` on the
DELIVERED transition, the optional `plannedAt` on dispatch), driver assign/reassign
(`trip:assign` gating, driver availability, the same-status timeline event),
the tracking-link view model (link state, per-trip path, one-action copy target,
error mapping), locale
resolution and the pilot i18n catalogues) runs on the
Node.js native test runner with no install:

```bash
pnpm test                            # or: node --test apps/api/src/
```

The HTTP-level router regression test needs the API dependencies but **no
database**: it mints a real tracking token (~203 chars) and drives the real
`buildServer()` through `app.inject()`, proving `/track/:token` and
`/api/track/:token` are served rather than rejected with `414
FST_ERR_MAX_PARAM_LENGTH` (the PR #25 review finding — Fastify's default
`maxParamLength` is 100). It also checks that the driver PWA's assets are served
with the MIME types a browser and an install prompt require (the manifest as
`application/manifest+json`, `sw.js` and `lib/driver-core.js` as JavaScript, the
icons as PNG) and that the static root cannot be walked out of. It also proves the
Fleet Manager surface: `/app` redirects to `/app/`, the shell is served as HTML,
a deep link returns the shell, the assets carry their real content types and a
missing asset or a traversal attempt is a `404`. Finally it drives the trips-list
filters (board task #34) against the pilot database: filter counts and the P&L are
re-derived with direct Prisma queries, and the CSV export is checked row-for-row.
It also asserts the credential discipline (board task #63): the raw DB row still
holds a driver `passwordHash`, while no credential key appears anywhere in the
`/api/trips`, trip-detail, `/api/drivers` or `/api/reference` responses.
Finally it re-derives every dashboard KPI with its own Prisma query (board task #33)
and proves the on-time / pending-pay arithmetic is non-vacuous by creating real rows
inside a transaction that is rolled back, so the pilot is never mutated. It also drives
the delivery-timestamp writer (board task #66) through the real status-transition path
and asserts the KPI sample/value move and equal a direct DB query, all inside a rolled-back
transaction. It also proves the trip read isolation (board task #68) with two
driver tokens and one `trip:*` token: each driver's list contains only their own
trips, a driver with no trips gets 0 rows, another driver's trip is `404` (never
`403`), a client-supplied `?driverId=` cannot widen a driver's scope, and the
owner still reads the whole org. Finally it drives driver assignment (board task #36)
through the real route against a throwaway org and proves the before/after driver
views — the previous driver is refused on the trip and no longer sees it, the new
driver does — plus the timeline actor and the suspended-driver refusal, deleting
its fixtures afterwards.
It also drives the tracking-link UI (board task #39) against the DB in an isolated
org: mint → `GET` returns the identical URL → an anonymous fetch is `200` →
a tampered token `404` → `DELETE` revokes it (the old link `404`, `GET` `link:
null`) → a re-mint works while another trip's link is untouched, and a driver
token gets `403` on all three verbs.
That database-backed block prints a diagnostic and skips its assertions when no
database is reachable, so the command still runs on a bare checkout:

```bash
pnpm --filter @roadwisefleet/api test:router
```

The DB-backed smoke test needs a migrated + seeded database:
```bash
pnpm --filter @roadwisefleet/api smoke -- --password=...
```

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | liveness |
| `POST /api/auth/login` | — | email + password login for pre-created users; returns a bearer token plus `user.locale` (org default), `user.lang` (the person's own preference) and `user.locales` (supported list) |
| `GET /api/auth/me` | bearer | the current principal |
| `GET /api/trips` | bearer, `trip:read` | trip list for the token's org; filterable by `status` (comma-separated), `driverId`, `from`/`to` (created-at window, `YYYY-MM-DD` or ISO) and `q` (free text over route/customer/driver); an invalid value is a `400 invalid_filter` naming the field, and the applied filters are echoed back as `filters` (board task #34); **a caller without `trip:*` (a driver) is narrowed to their own trips — a client-supplied `driverId` cannot widen it** (board task #68); driver objects never carry credential fields (board task #63) |
| `GET /api/trips/:id` | bearer, `trip:read` | trip detail for the dashboard drawer: order/customer (with the promised `plannedAt`), driver, truck, status timeline (from/to/at/actor + `kind`), documents, expenses, settlement and P&L (`rateEur − Σ expenses`); the trip's `deliveredAt` is included (board tasks #33/#40); a timeline event with `kind: "reassignment"` (from === to) is a driver change, not a lifecycle move (board task #36); a trip in another org is `404`, never a leak; **a caller without `trip:*` reads only their own trip — somebody else's trip is `404`, never `403`** (board task #68) |
| `GET /api/dashboard` | bearer, `reports:read` | the app-home payload: the KPI strip (active trips, on-time %, pending pay), the alerts strip and today's status-event feed — every number is a database aggregate over the token's org (board task #33); a driver holds no `reports:read` and gets a `403` |
| `POST /api/trips` | bearer, `trip:create` | create a `DRAFT` trip (`orderId` required); the optional `plannedAt` (ISO-8601) records the promised delivery time on the order in the same transaction (board task #66) |
| `POST /api/trips/:id/status` | bearer, `trip:status` + assigned driver or `trip:*` | advance status; moving into `DELIVERED` also writes `Trip.deliveredAt` (board task #66), in the same transaction as the status event; rejects illegal moves with `400 invalid_transition` (state machine §7), RBAC denials with `403` |
| `POST /api/trips/:id/assign` | bearer, `trip:*` (owner/dispatcher) | assign or reassign the trip's driver (`driverId` required). The change keeps the trip's status and is recorded as a status event naming the acting user (board task #36). `403` for a driver, `409 trip_closed` on a terminal trip, `409 already_assigned` for the current driver, `409 driver_unavailable` for a suspended/locked (or non-driver) assignee, `400 driver_not_found` for an unknown one |
| `GET /api/driver/trips` | bearer, `trip:read` | live trip state for the logged-in driver |
| `GET /api/reference` | bearer, `trip:create` | every create-trip option list in one call (orders, drivers, trucks, customers) |
| `GET /api/orders` | bearer, `trip:create` | org orders with the customer name folded in |
| `GET /api/drivers` | bearer, `trip:create` | active org drivers (`id`, `name`, `phone`) |
| `GET /api/trucks` | bearer, `trip:create` | org trucks (`id`, `plate`, `dimensions`, `euroClass`) |
| `GET /api/customers` | bearer, `trip:create` | org customers (`id`, `name`) |
| `POST /api/trips/:id/documents` | bearer, `trip:*` or `pod:upload` + assigned driver | upload a document as JSON base64 (`docType`, `filename`, `mimeType`, `dataBase64`, plus the optional driver capture `capturedAt` + `geo`); stored under `UPLOAD_DIR` with a generated `storageKey`, row `PENDING` → `UPLOADED`; `400` on a bad type/mime/size or a malformed capture (`invalid_capture`), `403` on the wrong role |
| `GET /api/trips/:id/documents` | bearer, `trip:*` or `trip:read` + assigned driver | the trip's document checklist (`id`, `docType`, `status`, `uploadedAt`, `expiresAt`, `capturedAt`, `capture` — never the `storageKey`) |
| `PATCH /api/documents/:id` | bearer, `trip:*` | set a document to `VERIFIED` or `REJECTED`; any other status is `400 invalid_status`, a foreign-org document is `404` |
| `POST /api/trips/:id/track-link` | bearer, `trip:*` | mint a signed customer tracking link for one trip (`201` with `token`, `url`, `expiresAt`, `ttlSeconds`); the mint parameters are persisted on the trip (never the token), so the link survives a reload and can be revoked per trip (board task #39); a foreign-org trip is `404` |
| `GET /api/trips/:id/track-link` | bearer, `trip:*` | the trip's current link, recomputed byte-for-byte from the persisted mint parameters (`{ link }`, or `{ link: null }` when none is live); a foreign-org trip is `404` |
| `DELETE /api/trips/:id/track-link` | bearer, `trip:*` | revoke this trip's link: bumps `Trip.trackLinkVersion`, so every token already handed out for this trip `404`s while other trips are untouched; `{ revoked: true, link: null }` |
| `GET /api/track/:token` | — | public tracking payload — route, status, timeline, last known position, ETA placeholder, POD flag; **no PII**; invalid/expired/rotated/revoked token → `404 invalid_token` |
| `GET /track/:token` | — | public tracking HTML page (self-contained, no build step) for the shared link; `x-robots-tag: noindex, nofollow` |
| `GET /pilot/*` | — | pilot-only web surface from `<repo>/pilot` (same origin, no build step) |
| `GET /app` | — | `302` to `/app/` (the Fleet Manager mount point) |
| `GET /app/*` | — | Fleet Manager app from `<repo>/app`: a real file when it exists, otherwise the SPA shell for a deep link (a missing asset is a `404`, never HTML); `x-robots-tag: noindex, nofollow` |
| `POST /api/waitlist` | — | landing-page waitlist (honeypot + validation) |
| `GET /api/waitlist` | `X-Admin-Token` | admin list |

Tenancy comes from the signed token's `org` claim — the old `x-org-id` header
stub is gone. Capabilities come from the token's `roleId` resolved against the
seeded `Role.permissions` (`auth/permissions.js`); a denied action returns
`403 forbidden`.

The reference endpoints expose org-wide data (customer names, other drivers'
phone numbers), so they require `trip:create` — owner/dispatcher pass, drivers
get `403`, exactly like `POST /api/trips`. The loaders live in
`src/reference-data.js` (pure, covered by `src/reference-data.test.js`); the
route layer is `src/routes/reference.ts`. `User` has no `active` column, so
"active drivers" maps to the schema's lock state: a driver whose `lockedUntil`
is in the future is excluded.

### Credential-free user payloads (board task #63)
`GET /api/trips` used to load the driver relation with a bare include, so every
`trips[].driver` object carried `passwordHash` (scrypt), `totpSecret`,
`failedLoginCount` and `lockedUntil` — credential material no role should ever
read. The schema is unchanged; the fix has two layers, both in
`src/user-payload.js` (pure, covered by `src/user-payload.test.js`):

1. `publicUserSelect()` — an explicit Prisma `select` (all `User` columns except
   the four credential fields) used by `listOrgTrips`, so the columns are never
   read out of the database in the first place;
2. `stripCredentialFields()` — a recursive route-boundary serialiser applied to the
   `/api/trips`, `/api/trips/:id`, `/api/driver/trips`, `/api/drivers` and
   `/api/reference` responses, so a future user `include` cannot reintroduce the
   leak unnoticed. It copies plain objects/arrays only, so `Date`/`Decimal`
   values are preserved and the dispatcher payload is otherwise unchanged.

`findCredentialFields()` returns every credential key path in a payload (empty
means clean) and backs the DB-backed assertion in
`apps/api/test/user-payload.test.ts`.

### Trip read isolation (board task #68, UG#38)
Writes were already correct, but **reads were not**: a driver token held
`trip:read`, and `GET /api/trips` / `GET /api/trips/:id` were only *org*-scoped,
so any driver could list every trip in the org and read any other driver's trip
detail (driver and customer email included).

The rule now lives in `src/trip-visibility.js` (pure, covered by
`src/trip-visibility.test.js`) and mirrors the write-side rule in
`auth/permissions.js#canTransitionTrip`:

- only a role holding `trip:*` (owner, dispatcher) reads the whole org —
  unchanged;
- every other `trip:read` holder (a driver) is scoped to the trip assigned to
  them. On the list the route forces the query's `driverId` to the caller's own
  id (a client-supplied `?driverId=` cannot widen it, and the echoed `filters`
  shows what was applied); on the detail it passes `driverId` into
  `getTripDetail`, which adds it to the where clause.

A trip assigned to somebody else is therefore **`404 not_found`**, never `403` —
a scoped reader must not be able to probe the org for a trip's existence, the
same rule the org boundary already follows. A scoped reader with no usable
identity is refused rather than falling back to an unscoped query. The seeded
accountant holds no `trip:read` at all, so its behaviour is unaffected. The
DB-backed regression (driver vs driver) is
`apps/api/test/trip-driver-scope.test.ts`.

### Documents / POD (board task #3)
The `Document` model is now used. Uploads are JSON base64 (no multipart
dependency) and land on local disk under `UPLOAD_DIR` (default
`<repo>/var/uploads`, gitignored; MinIO later). `storageKey` is generated
server-side as `<tripId>/<docType>/<documentId>-<sanitised-name>` and every
write goes through `resolveWithin`, so a file can never escape the upload root;
the key is never returned by the API. Limits: `MAX_UPLOAD_BYTES` (default
10 MiB) and a MIME allowlist (JPEG, PNG, WebP, HEIC, HEIF, PDF). A trip can only
move to `POD_UPLOADED` once it has an `UPLOADED`/`VERIFIED` `pod` or `ecmr`
document (`400 pod_required` otherwise).

### Driver PWA (board task #4)
`pilot/driver.html` is the installable, offline-capable driver app. An upload may
carry the **capture metadata** — when and where the driver took the photo:

```bash
curl -sX POST http://127.0.0.1:8080/api/trips/<tripId>/documents \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"docType":"pod","filename":"pod.jpg","mimeType":"image/jpeg","dataBase64":"...",
       "capturedAt":"2026-09-23T11:59:00Z","geo":{"lat":48.137,"lng":11.575,"accuracy":12}}'
```

Both fields are optional — a driver in a basement loading bay denies the position
and the upload still succeeds — but a *present* value is validated rather than
stored blindly: `normalizeCapture` (`src/documents.js`) rejects a malformed or
out-of-range `geo`, a non-numeric accuracy, an unparseable `capturedAt` and a
timestamp more than 24 h in the future, all with `400 invalid_capture`. GPS is
best-effort; the timestamp is not. The columns are additive and nullable
(`prisma/migrations/20260923120000_add_document_capture`), and
`capturedAt`/`capture` are exposed by `shapeDocument` — never `storageKey`.

The page itself is deliberately framework-free and self-contained:

- `pilot/manifest.webmanifest` — `standalone`, scoped to `/pilot/`, with 192/512
  and maskable icons, so Chrome on Android offers **Install**.
- `pilot/sw.js` — caches only the `/pilot/` app shell (page, `lib/driver-core.js`,
  manifest, icons); `/api/*` is never cached, so no trip or document payload sits
  in a shared HTTP cache. Navigation is network-first; the cached shell is the
  offline fallback.
- `pilot/lib/driver-core.js` — the pure domain core (tour card, checklist, POD
  gate, capture validation, offline queue). It is loaded twice on purpose: as a
  classic script in the browser and by `src/driver-pwa.test.js`, which fails if
  its mirrored transition table or document lists ever drift from the API.
- The **offline queue** persists status changes and captures in IndexedDB (with
  an in-memory fallback for WebViews without it) and replays them oldest-first on
  reconnect — a capture is always sent *before* the `POD_UPLOADED` change that
  depends on it. A 4xx the server will never accept is dropped and surfaced to
  the driver; network/5xx failures stay queued with an attempt count.

The driver page keeps the bearer token in `localStorage` (not `sessionStorage`
like the dashboard) so an installed app reopens offline without a re-login.

> **Operator note:** the three new capture columns ship as an additive migration
> (`20260923120000_add_document_capture`). It has to be applied to the pilot
> database (`pnpm exec prisma migrate deploy`) before a capture upload will
> persist; until then the `POST` fails on the unknown columns. The migration is
> nullable-only, so existing rows stay valid.

### Customer tracking link (board task #5)
A dispatcher can mint a shareable, login-free link for one trip:

```bash
curl -sX POST http://127.0.0.1:8080/api/trips/<tripId>/track-link \
  -H "authorization: Bearer <token>"
# -> 201 { "link": { "token": "...", "url": "/track/<token>", "expiresAt": "...", "ttlSeconds": 2592000 } }
```

Open `<url>` logged out: `/track/:token` serves the self-contained page, which
reads `GET /api/track/:token`. The payload is route (origin/destination/cargo),
current status, the status timeline, the last known GPS ping (or `null`), an ETA
placeholder and a POD-availability flag — **no driver/customer names, phones,
plates or rates**, so a forwarded link leaks nothing personal. Both responses
carry `x-robots-tag: noindex, nofollow` (plus a `robots` meta tag) so a shared
link is never indexed.

The token is an HMAC-SHA256 token bound to one trip id and an expiry; the key is
derived from `AUTH_SECRET` (domain-separated: `HMAC(AUTH_SECRET,
"roadwisefleet/track-link/v1")`), so a tracking token can never be replayed as a
session token and vice versa. A token tampered to point at another trip fails
signature verification, and a token from another org does not exist for the
route — the signed trip id *is* the capability.

- `TRACK_LINK_TTL_SECONDS` — link lifetime, default 30 days (`2592000`).
- `TRACK_LINK_SECRET` — optional override for the derived key. Revocation is
  stateless: rotate this (or `AUTH_SECRET`) and every outstanding link stops
  verifying immediately, without ending anyone's session.
- `PUBLIC_BASE_URL` — optional absolute origin for the returned `url`; empty
  gives the origin-relative `/track/<token>`.

Logic lives in `src/track-link.js` (pure, covered by `src/track-link.test.js`);
the HTML shell is `src/track-page.js`; the routes are `src/routes/track.ts`.

A tracking token is ~203 chars, which is longer than Fastify's default route
parameter cap (`maxParamLength: 100`) — so `buildServer()` configures
`routerOptions.maxParamLength` (512) via `src/server-options.js`, otherwise
`/track/:token` and `/api/track/:token` fail with `414
FST_ERR_MAX_PARAM_LENGTH` before the handler runs. Guarded by
`src/track-router.test.js` (dependency-free, runs in CI) and
`test/track-router.test.ts` (`pnpm test:router`, real `app.inject()`).

> Deployment note: production nginx currently proxies only `/api/` and `/pilot/`
> to the API, so `/track/:token` needs a `location /track/` block (with the
> noindex header) before the link is reachable on roadwisefleet.com. Filed as an
> infra request; the API side is complete and testable on the loopback.

## Pilot web surface (`/pilot/`)
The API serves the static pilot pages from the repo-root `pilot/` directory via
`@fastify/static` (`src/app.ts`, prefix `/pilot/`), so the pages are same-origin
with `/api/*` — no new port and no nginx. Production `web/` is untouched.

- `pilot/index.html` — landing linking to the two pages, with the language
  switcher in the header.
- `pilot/dashboard.html` — owner/dispatcher login, org trip list, create-trip
  form (order/driver/truck dropdowns fed by `GET /api/reference`, plus a rate
  input — no raw IDs), status-transition controls, a click-a-row trip drawer
  (timeline, documents, expenses, P&L) and a "Create tracking link" action
  (board task #5).
- `pilot/driver.html` — the driver PWA (board task #4): mobile-first layout,
  current-trip tour card (route, cargo, truck, rate, an honest ETA placeholder
  and the required-documents checklist), full-width one-thumb actions showing
  only the next legal statuses, camera/file POD capture with timestamp + GPS, and
  an offline queue with a sync chip. Installable and offline-capable via
  `pilot/manifest.webmanifest` + `pilot/sw.js`; its domain rules live in
  `pilot/lib/driver-core.js`.

Open `http://127.0.0.1:8080/pilot/` after `pnpm dev`. The pages use vanilla
`fetch`; no build step and no external CDN. The dashboard keeps the bearer token
in `sessionStorage`, the driver app in `localStorage` (so an installed PWA
reopens offline) — see the driver-PWA section above.

### Internationalisation (board task #6)
The pilot UI ships four locales — **EN / DE / PL / TR** — and no UI string is
hardcoded in `pilot/*.html` any more. Every visible string is a key rendered from
a catalogue:

- `pilot/locales/<lang>.json` — one catalogue per supported locale, keyed against
  the English one. `src/i18n.test.js` fails if a catalogue misses a key, carries an
  empty/placeholder value, drops a `{placeholder}` or is just copied English.
- `pilot/lib/i18n.js` — the pure runtime (dependency-free, ES5 for cheap Android
  WebViews): locale normalisation, `?lang=` parsing, the resolution order below,
  `{name}` interpolation, CLDR plural categories and the date/number/currency
  hooks. Loaded twice on purpose — as a classic script in the browser and by the
  test suite — exactly like `driver-core.js`.
- `pilot/lib/i18n-ui.js` — the only DOM-aware piece: applies the
  `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label`
  / `data-i18n-content` / `data-i18n-value` attributes, renders the
  `<select id="langSwitcher">` into each page's `#langSlot`, and boots the page.
- `src/i18n.js` — the server half of the same contract: normalises `Org.locale`
  (the tenant default) and `User.lang` (the person's preference) — both free-text
  columns — so an unsupported value (`fr`, `de-DE`, `""`) is skipped rather than
  forwarded to the UI.

A page load resolves the locale as "first supported value wins":

1. `?lang=` (an explicit link or switcher choice)
2. the choice remembered in `localStorage` (`rwf.lang`)
3. the user's own language (from the login response)
4. the org's default locale
5. the browser's languages
6. `en`

A `?lang=` choice sticks (it is written to `localStorage`), so navigating between
the pilot pages does not lose it. The login response carries `locale` (org
default), `lang` (the person's preference) and `locales` (the supported list);
the dashboard and driver pages re-apply the org default after sign-in unless the
person already chose a language. A missing translation falls back to English and
then to the key itself, so a catalogue gap can never blank out the UI.

> **Known limitation:** the API's *server-side* error `detail` strings (the
> `400`/`403` bodies, e.g. `invalid_transition`) are still English. Only the pilot
> UI is localised in this task; localising server messages needs the request's
> `Accept-Language` threaded through the route layer.

## Fleet Manager app (`/app/`) — board task #32 (FAv1-F1)
The authenticated dispatcher application. `web/` is the marketing site, `pilot/`
is the driver demo; `app/` is the product surface that every later FAv1 function
(dashboard, trips, dispatch, documents, tracking, finance) plugs into as a route.

Static, dependency-free, no build step and no CDN, served by the API itself
(`src/routes/app.ts`) so it is same-origin with `/api/*`:

- `app/index.html` — the two-view shell: the login view and the authenticated
  app view (header, `#navSlot`, `#outlet`, global error/empty states). Both start
  hidden — neither is rendered before the guard has decided.
- `app/app.css` — the shared layout, responsive at 375px and 1440px.
- `app/lib/app-core.js` — the pure core (route table, role model, guard, nav and
  panel renderers). Loaded twice on purpose: as a classic script in the browser
  and by `src/app-core.test.js` in the no-install CI job, exactly like
  `pilot/lib/driver-core.js`.
- `app/lib/trips.js` — the pure trips view model (board task #34): filter
  normalisation, the `GET /api/trips` query string, CSV export and the flat row
  the table and CSV share. Loaded the same way and covered by
  `src/trips-view.test.js`.
- `app/lib/documents.js` — the pure documents view model (board task #37, F6):
  the shared doc-type/MIME allow-lists, the pre-upload file size check, the
  upload / verify / reject payloads and the API-error-to-catalogue mapping. It
  delegates the checklist and the POD gate to `pilot/lib/driver-core.js`
  (loaded from the pilot beside it), so the app and the driver client cannot
  disagree about what satisfies the gate. Covered by `src/documents-ui.test.js`.
- `app/lib/tracking.js` — the pure tracking-link view model (board task #39, F8):
  the `trip:*` gate, the per-trip endpoint path, the link state
  (`none`/`active`/`expired`), the one-action copy target (the full URL, never a
  bare token) and the API-error-to-catalogue mapping. Covered by
  `src/tracking-ui.test.js`.
- `app/app.js` — the DOM/session half: `boot` → session restore → guard; login via
  `POST /api/auth/login`; `GET /api/auth/me` on every cold load; logout; SPA
  routing (`history.pushState`/`replaceState`) and a re-check on `popstate` /
  `pageshow`. It also renders the implemented views (dispatch, board task #35).
- `app/lib/dispatch.js` — the pure create-trip form logic (board task #35): option
  labels that never leak a raw id, pre-submit validation, the exact
  `POST /api/trips` payload (including the optional `plannedAt`, board task #66),
  and the API-error-to-catalogue-key mapping. Loaded as
  a classic script in the browser and by `src/dispatch-form.test.js` in CI.
- `app/locales/en.json` — the English catalogue. The shell reuses the pilot's
  `pilot/lib/i18n.js` + `pilot/lib/i18n-ui.js` runtime (board task #6), so the
  language hook and switcher already exist; EN ships first and additional
  catalogues are drop-in files.

Behaviour:

- **Auth/roles.** The API is authoritative: the role always comes back from
  `GET /api/auth/me`, so a hand-edited role in storage cannot widen access. The
  client guard mirrors the API's RBAC — `owner` sees everything, `dispatcher`
  trips/dispatch/documents/tracking/fleet, `accountant` finance only, `driver`
  overview + their own trips. An unknown role gets no navigation and no app
  (deny by default).
- **Guard.** Any unauthenticated `/app/*` visit goes to `/app/login` (the URL is
  replaced, so the back button does not bounce); a deep link is remembered and
  restored after login when the role may open it; a signed-in user on a route
  their role does not own is redirected to their role home; logout clears the
  session and a back-button/bfcache restore is refused.
- **Session.** The bearer token lives in `sessionStorage` (keys `rwf.app.token` /
  `rwf.app.user`, distinct from the pilot's) — it must not survive the tab and the
  app must not become CSRF-able. Nothing touches cookies.
- **Servable surface.** `src/app-shell.js` is the pure half of the static
  contract: the resolved real path (symlinks included) must stay inside
  `<repo>/app`, dotfiles are never served, only an explicit extension allow-list
  is served, there are no directory listings, and a missing asset is a real `404`
  (HTML is never served as JavaScript). Deep links return the shell so the client
  router can run.

- **Dispatch (board task #35, F4).** `/app/dispatch` is the create-trip form:
  `/api/reference` returns the org's orders, drivers, trucks and customers in one
  round-trip (`trip:create`, so a driver gets `403`), and the form turns them into
  dropdowns — no raw id is ever typed. The customer is shown read-only, from the
  selected order, and a payload whose customer does not match the order is
  refused. Validation runs before the request (order chosen and known; optional
  driver/truck known; rate a non-negative number; the optional planned delivery a
  real date/time); the body handed to
  `POST /api/trips` is `{ orderId, driverId, truckId, rateEur }` with `null` for the
  unset optionals, plus `plannedAt` (ISO-8601) only when a planned delivery time was
  chosen — the promised time is recorded on the order and feeds the on-time KPI
  (board task #66). Every server failure is mapped to a catalogue
  message that names the field to fix — `invalid_input` keeps the server's
  `detail`. A new trip is created as `DRAFT`; assigning and moving it is the
  trip-detail/status flow, and delivery writes `Trip.deliveredAt` (board task #66).
  **Not in this task:** required-document selection (the F6 documents UI, board #37).

Tests: `src/app-core.test.js` + `src/app-shell.test.js` + `src/dispatch-form.test.js`
+ `src/assign-form.test.js` + `src/documents-ui.test.js` run in the no-install CI
job; `test/app-shell.test.ts` adds the HTTP-level `app.inject()` checks under
`pnpm test:router`.

### Trips list & detail (board task #34, FAv1-F3)
`/app/trips` is the daily workhorse, built on the F1 shell:

- **List + filters.** The list calls `GET /api/trips` with `status`, `driverId`,
  `from`/`to` and `q`. The filter set lives in the URL (`/app/trips?status=DRAFT`),
  so a reload or a shared link restores it; an inverted range is caught in the UI
  before the request and again server-side (`400 invalid_filter`). Invalid filter
  values are never silently dropped.
- **CSV export.** "Export CSV" writes exactly the rows the list is showing, using
  the same `app/lib/trips.js` shaper the table uses (`tripRow`), so the file is
  row-for-row the filtered list by construction. Headers are stable machine names
  (never localised) and values are RFC 4180 quoted.
- **Detail.** `/app/trips/:id` renders `GET /api/trips/:id`: order/customer,
  driver, truck, the chronological status timeline (every entry names its actor,
  or says the history pre-dates actor recording), the documents panel, the
  expenses panel and the P&L (`rateEur − Σ expenses`). A trip with no documents or
  expenses renders an empty state rather than a broken panel.
- **Driver assignment (board task #36, F5).** The same detail screen carries the
  assign/reassign control for owner/dispatcher only. It is one `POST
  /api/trips/:id/assign` (`{ driverId }`), the detail is re-fetched from the
  server afterwards, and the timeline entry is labelled as a reassignment — a
  same-status event would otherwise read as a no-op transition. See "Driver
  assignment" below for the refusals and the timeline shape.

Pure logic lives in `app/lib/trips.js` (filter normalisation, query building, CSV
and row shaping); the dynamic `/app/trips/:id` matching lives in
`app/lib/app-core.js`. The filter validation and Prisma `where` building live in
`src/trip-filters.js`.

Tests: `src/trip-filters.test.js` + `src/trips-view.test.js` in the no-install CI
job; `test/trips-list.test.ts` (`pnpm test:router`) re-derives the filter counts
and P&L from Prisma and checks the CSV; the deterministic DOM harness
`scratch/verify-trips-view.js` drives the real `app.js` end to end.

> **Deployment note:** production nginx proxies only `/api/`, `/pilot/` and
> `/track/` to the API, so `/app/` needs a `location /app/` block before the Fleet
> Manager is reachable on roadwisefleet.com. The API side is complete and testable
> on the loopback; the nginx change is an infra request (not part of this code).

### Dashboard home (board task #33, FAv1-F2)
`/app/` (Overview) is the dashboard: a KPI strip, an alerts strip and today's
activity feed, all from `GET /api/dashboard`. There is no mock data — every number
is a database aggregate over the caller's org, and each KPI reports the aggregate it
came from (`kpis.*.query`) so it can be re-derived:

| KPI | Definition (one DB aggregate) | Drills into |
|---|---|---|
| Active trips | `COUNT(*)` trips in the org whose status is not terminal (`SETTLED`, `CANCELLED`) | `/app/trips?status=…` (all active statuses) |
| On-time % | among delivered trips with both `Trip.deliveredAt` and `Order.plannedAt`, the share delivered at or before the planned time; `null` (shown as `—`) when no trip is comparable | `/app/trips?status=DELIVERED,POD_UPLOADED,INVOICED,SETTLED` |
| Pending pay | `SUM(rateEur)` over the org's `INVOICED` trips (invoiced, not yet settled; F10 extends this to the settlement ledger) | `/app/trips?status=INVOICED` |

Alerts are also DB-derived and each one links to the trip it names: a trip in
`ASSIGNED`/`LOADED`/`IN_TRANSIT` with no driver, a compliance document (not
`REJECTED`) whose `expiresAt` is past or within 30 days, and a `PENDING`
settlement. The activity feed is today's `StatusEvent` rows (UTC), newest first,
each linking to its trip. The whole payload is returned through
`stripCredentialFields()` (board task #63), so the actor names in the feed can never
carry credential columns.

RBAC: `GET /api/dashboard` needs `reports:read` (owner / dispatcher / accountant).
A driver holds `trip:read` but not `reports:read`; their home is `/app/my-trips` and
the app points them there instead of calling the endpoint
(`app-core.js#canReadReports`).

Pure logic lives in `src/dashboard.js` (the queries + shaping) and
`app/lib/dashboard.js` (the view model: KPI cards, alert rows, activity rows).
Tests: `src/dashboard.test.js` + `src/dashboard-view.test.js` in the no-install CI
job; `test/dashboard.test.ts` (`pnpm test:router`) re-derives each KPI from Prisma;
`scratch/verify-dashboard.js` drives the real `app.js` end to end.

### Driver assignment (board task #36, FAv1-F5)
Dispatch without reassignment is not dispatch, so the trip-detail screen has a
driver control: pick a driver from the org's own list and the change is applied
through `POST /api/trips/:id/assign`. Selecting a different driver is a
**reassignment**; selecting the one already on the trip is refused
(`409 already_assigned`) rather than silently doing nothing.

The change is recorded as a **status event naming the acting user**. It does not
move the state machine: the trip keeps its status, so the event has
`fromStatus === toStatus`. `trip-detail.js` derives `kind: 'reassignment'` for
exactly that shape and `kind: 'status'` for a real transition — the API's only
same-status event is a driver change. The trip update and the timeline entry are
written in one transaction, so the trip row and its history cannot disagree.

Refusals are explicit, because a dispatch screen that fails silently is worse
than one that says why:

| Case | Response |
|---|---|
| Actor without `trip:assign` (a driver) | `403 forbidden` |
| Trip in another org / unknown id | `404 not_found` |
| Terminal trip (`SETTLED`/`CANCELLED`) | `409 trip_closed` |
| The driver already on the trip | `409 already_assigned` |
| Locked/suspended driver, or a non-driver user | `409 driver_unavailable` |
| Unknown user in the org | `400 driver_not_found` |

"Suspended/unavailable" is the schema's lock state (`User.lockedUntil` in the
future) — the same signal `reference-data.js#listDrivers` uses for its ACTIVE
driver list, so an assignable-looking driver is always an assignable one.
Nothing in the schema changes and there is no migration.

Pure logic lives in `src/trip-assignment.js` (validation, availability, the
transactional write) and `app/lib/assign.js` (option entries, validation, error
mapping); the role gate is `app-core.js#canManageTrips` (owner/dispatcher hold
`trip:*`). Tests: `src/trip-assignment.test.js` + `src/assign-form.test.js` in
the no-install CI job; `test/trip-assign.test.ts` (`pnpm test:router`) drives the
real route against the DB and proves the before/after driver views (the previous
driver is refused on the trip and no longer sees it, the new driver does) plus
the timeline actor; `scratch/verify-trips-view.js` section 7 drives the real
`app.js` (control rendered, current driver preselected, exact body POSTed,
detail re-fetched, reassignment named on the timeline).

### Documents UI (board task #37, FAv1-F6)
The trip-detail screen now carries the documents panel the API already backed
(`GET`/`POST /api/trips/:id/documents`, `PATCH /api/documents/:id`):

- **Checklist + POD gate.** The required-document checklist and the
  "can this trip move to POD uploaded" answer are `documentChecklist`,
  `requiredMissing`, `podSatisfied` and `canMarkPodUploaded` from
  `pilot/lib/driver-core.js`. The app does not restate the rules — the panel,
  the driver client and `src/driver-pwa.test.js` read the same functions, so an
  eCMR satisfies the requirement exactly once, everywhere.
- **Upload.** A document type (the API's `DOC_TYPES`) plus a file. The file is
  validated in the UI **before any request** against the shared MIME allow-list
  and the 10 MiB limit: an over-limit file gets an in-panel message naming the
  size and the limit (`"Photo is 31 MB — the maximum is 10 MB…"`), so a driver
  never sees a blank page or a raw proxy `413`. The bytes are sent as JSON
  base64 (`{ docType, filename, mimeType, dataBase64 }`) with the capture
  timestamp always and a best-effort GPS fix (`capturedAt` / `geo`, omitted when
  absent) — the same capture contract the driver PWA uses. The list is re-fetched
  from the server after a write, so the panel never shows its own guess.
- **Verify / reject.** Rendered only for a role that holds `trip:*`
  (owner/dispatcher). A driver is never offered the action, and the API refuses
  it with `403 forbidden` even if they tried.
- **Never a storage key.** `shapeDocument` / `shapeTripDetail` already drop the
  internal `storageKey`; the UI asserts its payloads carry none.

The `/app/documents` route is the workspace that gets a dispatcher to a trip's
panel: the trips in the documentation-relevant stages, each linking into its
trip detail.

Refusals the UI maps to a readable message (never a raw status): `unsupported_type`,
`file_too_large`, `invalid_capture`, `invalid_upload`, `forbidden`, `not_found`,
and a proxy `413`.

Pure logic lives in `app/lib/documents.js`; the DOM/network half is
`app.js` (`documentsPanelHtml`, `loadDocumentsControl`, `submitDocument`,
`submitDocumentStatus`). Tests: `src/documents-ui.test.js` in the no-install CI
job (the shared lists, the pre-upload check, the delegation to the driver core,
the payloads, the error mapping and the role gate) and `test/documents-ui.test.ts`
(`pnpm test:router`) which drives the real routes against the DB and proves the
acceptance end to end: the POD gate `400 pod_required` → upload `201` → `200`,
the driver verify `403` (owner `200`), and a rejected MIME `400 unsupported_type`
with its detail — all in an isolated org, cleaned up in `after`. The scratch
harness `scratch/verify-documents-ui.js` renders the real panel module for each
role (checklist/gate present; upload + verify/reject for a managing role only;
the over-limit refusal message).

### Driver client (board task #38, FAv1-F7a)
`/app/my-trips` is the driver's screen, built on the same shared rules as the
pilot PWA (`pilot/lib/driver-core.js`) and the documents module
(`app/lib/documents.js`):

- **Own trips only.** The screen reads `GET /api/driver/trips` (the token scopes
  the rows; board #68) and never the org list. The pure view model exposes the
  single path (`app/lib/driver.js#myTripsPath`), so there is no second literal
  to drift.
- **One tap per legal status.** `statusActions` mirrors `nextLegalStatuses` and
  flags the irreversible one: `DELIVERED` carries the confirm key
  (`driver.confirm.DELIVERED`, shown through `window.confirm`) and a rejected
  transition is a message, never a silent no-op.
- **POD gate.** `POD_UPLOADED` stays visible but **disabled** with the reason
  (`driver.podGate`) until `podSatisfied` is true — the API's `pod_required` gate
  and the UI agree because both read the shared core.
- **Capture with GPS + timestamp.** A camera input (`capture="environment"`)
  reads the real file; `capturedAt` is always set and a best-effort
  `navigator.geolocation` fix is attached when it is usable
  (`normalizeCapture` / `isUsableFix`). A missing or coarse fix is stated, not
  invented.
- **Over-limit photos (owner directive on #38 / #41).** The size is checked
  **before any request** (`documents.js#validateUpload`, 10 MiB cap) and the
  driver gets `docs.error.tooLarge` = *"Photo is {size} — the maximum is {max}.
  Choose a smaller file."* The API's `400 file_too_large` **and** a proxy `413`
  HTML page map to `driver.photo.tooLargeServer` with the limit and the remedy —
  so neither a white screen nor raw JSON can reach the driver, and no request the
  server would reject is ever sent.
- **Offline queue.** A queued change is a `driver-core` queue item; each id is
  stable (`queueId`), `enqueue` refuses a duplicate and `applySyncResults`
  removes what it sent. Reconnecting fires one guarded sync (`syncing`), so the
  same change cannot be replayed twice — the count of queued items before/after
  is the proof. The queue lives in `localStorage`; if a capture would not fit the
  storage budget the driver is told to reconnect and send it now instead of
  losing it.

Pure logic: `app/lib/driver.js` (injects the shared core and the document rules —
it restates neither). DOM/network half: `app.js` (`renderMyTrips`,
`sendDriverStatus`, `handleDriverPhoto`, `syncDriverQueue`). Tests:
`src/driver-client.test.js` in the no-install CI job (role gate, own-only path,
the confirm/gate flags, the delegated checklist, the over-limit message, the
server/proxy mapping, the queue dedupe/idempotent sync) and the scratch harness
`scratch/verify-driver-client.js` (renders the real card for each state).
### Tracking link UI (board task #39, FAv1-F8)
The public tracking page already worked (board task #5), but there was no way to
get a link from the app. The Fleet Manager now carries the per-trip control, and
revocation became **per trip** instead of the global key rotation the original
design had:

- **Per-trip state (one additive migration).** `Trip.trackLinkVersion` (monotonic
  revocation counter), `Trip.trackLinkIssuedAt` and `Trip.trackLinkExpiresAt`
  (`20260925130000_add_track_link_state`, nullable/defaulted — safe on a live DB).
  The signed token itself stays stateless; the version rides in its `sub`
  (`<tripId>` for version 0, `<tripId>~<n>` after a revoke), and the public read
  rejects a token whose version no longer matches the row — a flat `404`, exactly
  like an unknown id.
- **Mint / read-back.** `POST` mints and persists the mint parameters (never the
  token). `GET /api/trips/:id/track-link` recomputes the **identical** token from
  them — HMAC is deterministic — so the trip detail can show the link after a
  reload without the server storing it.
- **Revoke.** `DELETE` increments the version and clears the mint state: every
  token already handed out for this trip stops verifying, other trips are
  unaffected, and a fresh mint works again under the new version. The old token
  never revives.
- **UI.** The trip detail shows a "Tracking link" panel for `trip:*` holders
  (owner/dispatcher): the current link in a read-only field with a one-action
  **Copy link** button, or a **Create tracking link** button, plus **Revoke link**
  behind a confirm. The `/app/tracking` workspace lists the org's trips with their
  link state (the API sends only `{ active, expiresAt }` — **never the token**) and
  offers mint/revoke; a just-minted link appears there with a copy button.
- **Token exposure.** The token is rendered only on the acting trip's own
  authenticated surface (and in the mint response). The list/workspace markup
  never contains it.

Pure logic lives in `app/lib/tracking.js`; the DOM/network half is `app.js`
(`trackingPanelHtml`, `loadTrackingControl`, `mintTrackingLink`,
`copyTrackingLink`, `revokeTrackingLink`, and the `/app/tracking` workspace).

Tests: `src/tracking-ui.test.js` in the no-install CI job (state/path/copy
derivation, the `trip:*` gate, the error mapping, the catalogue keys, and the
"no token in the list markup" guard) and `test/tracking-link.test.ts`
(`pnpm test:router`) which drives the real routes against the DB in an isolated
org: mint `201` → `GET` returns the same URL → anonymous `/track/<token>` `200`
HTML + `/api/track/<token>` `200` JSON → tampered token `404` → revoke `200` →
the old link `404` (and `GET` says `link: null`) → a re-mint works while another
trip's link is untouched, and a driver token gets `403` on all three verbs. The
scratch harness `scratch/verify-tracking-ui.js` renders the real panel/list
modules for each role.

### Delivery timestamps (board tasks #33/#40)
The on-time KPI needs two timestamps that the schema did not have:
`Order.plannedAt` (the promised delivery time) and `Trip.deliveredAt` (the actual
delivery time). They arrive together in ONE migration,
`prisma/migrations/20260924120000_add_delivery_timestamps/migration.sql` — purely
additive and nullable, so existing rows are unaffected and the migration reverses by
dropping the two columns (the rollback statements are in the migration file as a
comment; Prisma has no down migration). It was applied on the pilot DB with
`pnpm --filter @roadwisefleet/api exec prisma migrate deploy`, after which
`prisma migrate status` reports "Database schema is up to date!". Both fields are
surfaced in `GET /api/trips/:id` (trip `deliveredAt`, order `plannedAt`).

**Who writes them (board task #66).** The columns shipped in #40 but nothing wrote
them, so `onTimePct` could never leave its `—` placeholder. Two writers close that:
`trips-core.js#transitionTrip` stamps `Trip.deliveredAt` the moment a trip moves into
`DELIVERED` (same transaction as the status event, so the timeline and the KPI cannot
disagree), and `POST /api/trips` accepts an optional `plannedAt` and writes it to
`Order.plannedAt` (same transaction as the trip). Both stay nullable — the time is
optional data, and the KPI still renders `—` (never a fabricated 0/100) when a trip
has no comparable pair. Covered by `src/trips-core.test.js` (writer + validation,
no install) and `test/delivery-timestamps.test.ts` (the real transition path moved
the KPI, re-derived with a direct DB query, inside a rolled-back transaction).

## Waitlist → account handoff
`scripts/waitlist-handoff.ts` is a manual, email-free handoff: it reads the
waitlist JSONL, upserts every lead into `WaitlistEntry` (dedupe by email), and
for the named leads ensures an `Org` and an `owner` `User` exist. Re-running is
idempotent and never resets a password unless `--password=` is passed. No email
is sent.

```bash
# preview only
pnpm --filter @roadwisefleet/api handoff -- --all --dry-run

# create accounts for named leads (prints a generated password once)
pnpm --filter @roadwisefleet/api handoff -- \
  --email=ops@acme.test --org="Acme Logistics"

# options: --file=<path> (default /var/lib/roadwisefleet/waitlist.jsonl),
#          --email=<addr> (repeatable), --all, --org=<name>, --password=<value>
```

The pure parsing/planning logic lives in `src/waitlist-handoff.js` and is
covered by `src/waitlist-handoff.test.js`.

## Deliberately missing (until the right phase)
- signup, email verification, password reset (email is not live) ·
- server-side session revocation ·
- GPS ingest pipeline (Redis stream → Timescale) · document presigned uploads ·
- WhatsApp bridge · payments (post-free-phase)
