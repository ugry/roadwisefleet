# RoadwiseFleet API (Phase 0 scaffold)

Fastify + Prisma + PostgreSQL (TimescaleDB/PostGIS), per `docs/backend-infrastructure-plan.md`.

## Status
Blueprint — **not yet installed or run** (npm registry was flaky at scaffold time; `pnpm install` with retries should succeed).

## Run
```bash
pnpm install                          # from repo root
docker compose up -d                  # postgres(+timescale/postgis), redis, minio
pnpm --filter @roadwisefleet/api db:migrate
pnpm dev                              # API on 127.0.0.1:8080
```

## Test
The trip-status state machine (`src/trip-status.js`) is dependency-free ESM, so
its unit tests run on the Node.js native test runner with no install:

```bash
node --test apps/api/src/            # or, from the repo root: pnpm test
```

## Endpoints (current)
| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /api/waitlist` | landing-page waitlist (honeypot + validation) |
| `GET /api/waitlist` | admin list (`X-Admin-Token`, `ADMIN_TOKEN` env) |
| `GET /api/trips` · `POST /api/trips` | trip CRUD skeleton (header-scoped tenancy stub) |
| `POST /api/trips/:id/status` | advances a trip's status; rejects illegal transitions with `400 invalid_transition` (state machine §7) |

## Deliberately missing (until the right phase)
- JWT/RBAC auth (header stub in place) · GPS ingest pipeline (Redis stream → Timescale) ·
- document presigned uploads · WhatsApp bridge · payments (post-free-phase)
