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

## Test
Pure logic (state machine, scrypt password hashing, token signing/verification,
RBAC capability checks, AUTH_SECRET resolution, trip-loop core against a fake
Prisma client, create-trip reference loaders) runs on the Node.js native test
runner with no install:

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
| `POST /api/trips` | bearer, `trip:create` | create a `DRAFT` trip (`orderId` required) |
| `POST /api/trips/:id/status` | bearer, `trip:status` + assigned driver or `trip:*` | advance status; rejects illegal moves with `400 invalid_transition` (state machine §7), RBAC denials with `403` |
| `GET /api/driver/trips` | bearer, `trip:read` | live trip state for the logged-in driver |
| `GET /api/reference` | bearer, `trip:create` | every create-trip option list in one call (orders, drivers, trucks, customers) |
| `GET /api/orders` | bearer, `trip:create` | org orders with the customer name folded in |
| `GET /api/drivers` | bearer, `trip:create` | active org drivers (`id`, `name`, `phone`) |
| `GET /api/trucks` | bearer, `trip:create` | org trucks (`id`, `plate`, `dimensions`, `euroClass`) |
| `GET /api/customers` | bearer, `trip:create` | org customers (`id`, `name`) |
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

## Pilot web surface (`/pilot/`)
The API serves the static pilot pages from the repo-root `pilot/` directory via
`@fastify/static` (`src/app.ts`, prefix `/pilot/`), so the pages are same-origin
with `/api/*` — no new port and no nginx. Production `web/` is untouched.

- `pilot/index.html` — landing linking to the two pages.
- `pilot/dashboard.html` — owner/dispatcher login, org trip list, create-trip
  form (order/driver/truck dropdowns fed by `GET /api/reference`, plus a rate
  input — no raw IDs) and status-transition controls.
- `pilot/driver.html` — driver login, assigned trips and the next legal status.

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
