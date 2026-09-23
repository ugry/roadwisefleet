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
  (repo-root dir, separate from the production `web/`).

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
demo-reset planning, tracking-link signing/shaping) runs on the Node.js native
test runner with no install:

```bash
pnpm test                            # or: node --test apps/api/src/
```

The DB-backed smoke test needs a migrated + seeded database:
```bash
pnpm --filter @roadwisefleet/api smoke -- --password=...
```

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | liveness |
| `POST /api/auth/login` | — | email + password login for pre-created users; returns a bearer token |
| `GET /api/auth/me` | bearer | the current principal |
| `GET /api/trips` | bearer, `trip:read` | dashboard trip list for the token's org |
| `GET /api/trips/:id` | bearer, `trip:read` | trip detail for the dashboard drawer: order/customer, driver, truck, status timeline (from/to/at/actor), documents, expenses, settlement and P&L (`rateEur − Σ expenses`); a trip in another org is `404`, never a leak |
| `POST /api/trips` | bearer, `trip:create` | create a `DRAFT` trip (`orderId` required) |
| `POST /api/trips/:id/status` | bearer, `trip:status` + assigned driver or `trip:*` | advance status; rejects illegal moves with `400 invalid_transition` (state machine §7), RBAC denials with `403` |
| `GET /api/driver/trips` | bearer, `trip:read` | live trip state for the logged-in driver |
| `GET /api/reference` | bearer, `trip:create` | every create-trip option list in one call (orders, drivers, trucks, customers) |
| `GET /api/orders` | bearer, `trip:create` | org orders with the customer name folded in |
| `GET /api/drivers` | bearer, `trip:create` | active org drivers (`id`, `name`, `phone`) |
| `GET /api/trucks` | bearer, `trip:create` | org trucks (`id`, `plate`, `dimensions`, `euroClass`) |
| `GET /api/customers` | bearer, `trip:create` | org customers (`id`, `name`) |
| `POST /api/trips/:id/documents` | bearer, `trip:*` or `pod:upload` + assigned driver | upload a document as JSON base64 (`docType`, `filename`, `mimeType`, `dataBase64`); stored under `UPLOAD_DIR` with a generated `storageKey`, row `PENDING` → `UPLOADED`; `400` on a bad type/mime/size, `403` on the wrong role |
| `GET /api/trips/:id/documents` | bearer, `trip:*` or `trip:read` + assigned driver | the trip's document checklist (`id`, `docType`, `status`, `uploadedAt`, `expiresAt` — never the `storageKey`) |
| `PATCH /api/documents/:id` | bearer, `trip:*` | set a document to `VERIFIED` or `REJECTED`; any other status is `400 invalid_status`, a foreign-org document is `404` |
| `POST /api/trips/:id/track-link` | bearer, `trip:*` | mint a signed customer tracking link for one trip (`201` with `token`, `url`, `expiresAt`, `ttlSeconds`); a foreign-org trip is `404` |
| `GET /api/track/:token` | — | public tracking payload — route, status, timeline, last known position, ETA placeholder, POD flag; **no PII**; invalid/expired/rotated token → `404 invalid_token` |
| `GET /track/:token` | — | public tracking HTML page (self-contained, no build step) for the shared link; `x-robots-tag: noindex, nofollow` |
| `GET /pilot/*` | — | pilot-only web surface from `<repo>/pilot` (same origin, no build step) |
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

> Deployment note: production nginx currently proxies only `/api/` and `/pilot/`
> to the API, so `/track/:token` needs a `location /track/` block (with the
> noindex header) before the link is reachable on roadwisefleet.com. Filed as an
> infra request; the API side is complete and testable on the loopback.

## Pilot web surface (`/pilot/`)
The API serves the static pilot pages from the repo-root `pilot/` directory via
`@fastify/static` (`src/app.ts`, prefix `/pilot/`), so the pages are same-origin
with `/api/*` — no new port and no nginx. Production `web/` is untouched.

- `pilot/index.html` — landing linking to the two pages.
- `pilot/dashboard.html` — owner/dispatcher login, org trip list, create-trip
  form (order/driver/truck dropdowns fed by `GET /api/reference`, plus a rate
  input — no raw IDs), status-transition controls, a click-a-row trip drawer
  (timeline, documents, expenses, P&L) and a "Create tracking link" action
  (board task #5).
- `pilot/driver.html` — driver login, assigned trips, the next legal status and
  a POD/eCMR upload control with the trip's document list (used by the driver
  PWA).

Open `http://127.0.0.1:8080/pilot/` after `pnpm dev`. The pages use vanilla
`fetch` and keep the bearer token in `sessionStorage`; no build step and no
external CDN.

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
