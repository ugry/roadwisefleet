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

## Endpoints (current)
| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /api/waitlist` | landing-page waitlist (honeypot + validation) |
| `GET /api/waitlist` | admin list (`X-Admin-Token`, `ADMIN_TOKEN` env) |
| `GET /api/trips` · `POST /api/trips` · `POST /api/trips/:id/status` | trip CRUD skeleton (header-scoped tenancy stub) |

## Deliberately missing (until the right phase)
- JWT/RBAC auth (header stub in place) · GPS ingest pipeline (Redis stream → Timescale) ·
- document presigned uploads · WhatsApp bridge · payments (post-free-phase)
