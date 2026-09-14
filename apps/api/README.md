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

## Run
```bash
pnpm install                          # from repo root; postinstall generates the Prisma client
pnpm --filter @roadwisefleet/api db:migrate
pnpm --filter @roadwisefleet/api db:seed -- --password=...
pnpm dev                              # API on 127.0.0.1:8080
```
`DATABASE_URL` is read from `apps/api/.env` (or the repo-root `.env`); Node 20
`process.loadEnvFile` loads it, no dotenv dependency. `AUTH_SECRET` signs pilot
session tokens and should be overridden outside the local pilot.

## Test
Pure logic (state machine, scrypt password hashing, token signing/verification,
trip-loop core against a fake Prisma client) runs on the Node.js native test
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
| `GET /api/trips` | bearer | dashboard trip list for the token's org |
| `POST /api/trips` | bearer | create a `DRAFT` trip (`orderId` required) |
| `POST /api/trips/:id/status` | bearer | advance status; rejects illegal moves with `400 invalid_transition` (state machine §7) |
| `GET /api/driver/trips` | bearer | live trip state for the logged-in driver |
| `POST /api/waitlist` | — | landing-page waitlist (honeypot + validation) |
| `GET /api/waitlist` | `X-Admin-Token` | admin list |

Tenancy comes from the signed token's `org` claim — the old `x-org-id` header
stub is gone.

## Deliberately missing (until the right phase)
- signup, email verification, password reset (email is not live) ·
- RBAC enforcement beyond org scoping · server-side session revocation ·
- GPS ingest pipeline (Redis stream → Timescale) · document presigned uploads ·
- WhatsApp bridge · payments (post-free-phase)
