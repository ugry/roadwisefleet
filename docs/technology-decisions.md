# RoadwiseFleet — Technology Decisions (Backend · Frontend · Database · DR/HA)

**Status:** decisions v1 · **Context:** solo founder, one VPS (Debian 13, 40 GB), EU-first, free phase (COGS ceiling €2/truck/month), no funding, scale path 100→1,000→10,000 users per [backend-infrastructure-plan.md](backend-infrastructure-plan.md).
**Format:** each layer = options considered → **our choice** → why → what would make us revisit.

---

## 1. Backend

**Options:** TypeScript monolith (Fastify) · TypeScript (NestJS) · Go · Python (Django/FastAPI) · Frappe/ERPNext base · serverless (Lambda/Cloudflare Workers)

**Our choice: TypeScript modular monolith — Fastify + Prisma + BullMQ worker, one deployable.**

**Why:**
- Already scaffolded in `apps/api`; one language across backend, web frontend, and shared types (`packages/shared`).
- Fastify performance is far beyond our needs (we need ~1,500 req/s at 10k users — Fastify does that on one core).
- The monolith preserves our core architecture — the status-event spine and regional modules are *modules*, not services; splitting them is a config decision later, not a rewrite.
- Solo-founder ops: one process, one deploy, one log file. Serverless rejects itself on cost, cold starts for real-time GPS ingest, and local-first debugging; Go rejects itself on ecosystem friction for a team of one writing CRUD + integrations; Frappe rejects itself on real-time GPS/WebSocket fit (it's an ERP, not a telemetry platform).

**Revisit trigger:** a single module (e.g., GPS ingest) shows sustained, isolated CPU contention — then extract *that one* service; the API stays a monolith.

## 2. Frontend

**Options:** React SPA (Vite) · Next.js · Vue/Nuxt · SvelteKit · HTMX server-rendered · keep everything static HTML

**Our choice:**
- **FM dashboard & customer portal:** React + TypeScript **Vite SPA** (not Next.js — the app is behind login, needs no SSR/SEO; our OpenDesign artifacts are plain HTML/CSS that port directly into components).
- **Marketing site:** stays **static HTML** (already deployed, zero runtime, fastest possible).
- **Driver app:** **native Android (Kotlin + Jetpack Compose)** — the separate mobile decision: background GPS, battery, FCM, offline-first are native strengths; one platform first (Android ≈ 70%+ of EU driver devices).

**Why:** one language end-to-end (TS), SPA avoids SSR complexity we don't need, and native Android wins the battery/background battle that decides driver retention. Flutter/React Native rejected: cross-platform is a benefit we don't use until iOS is a market.

**Revisit trigger:** iOS demand appears in customer interviews (then Flutter only for new screens, never a rewrite).

## 3. Database

**Options:** self-hosted PostgreSQL (+PostGIS/Timescale) · MySQL/MariaDB · MongoDB · managed Postgres (Neon/RDS/Aiven) · SQLite

**Our choice: PostgreSQL 17 + PostGIS + TimescaleDB, self-hosted on the VPS in Phase 0–1 (docker-compose `timescaledb-ha:pg17-all`); switch to managed at the Phase 2 trigger or when ops burden wins.**

**Why:**
- ACID + relational integrity for trips/orders/invoices/settlements (money-adjacent data — non-negotiable).
- **PostGIS is a differentiator, not an option:** geofence-based detention, return-load matching, and "empty trucks near X" are the core features; no other mainstream DB does this as well.
- **TimescaleDB from day 1** for GPS pings — the alternative is migrating a plain `gps_pings` table later, which we explicitly refuse to do.
- Self-hosted = €0 COGS during the free phase (managed Postgres ≈ €50–200/mo at small scale — that's our entire infra budget).
- MongoDB/SQLite rejected: we have relationships, joins, and transactions everywhere.

**Revisit trigger (go managed):** (a) a DB outage costs more in trust/revenue than the managed bill, (b) HA becomes mandatory (Phase 2: Patroni ×3 self-hosted vs managed — decide then by monthly cost + on-call availability), or (c) GDPR/LGPD data-residency needs multi-region without ops staff.

## 4. Disaster Recovery

**Options:** nothing · nightly `pg_dump` · pgBackRest + WAL streaming (PITR) · managed snapshots

**Our choice (layered):**
- **Now (Phase 0):** nightly `pg_dump` → local MinIO **and** offsite copy (B2/backup bucket) · **nightly backup of the waitlist JSONL (implemented this commit — see below)** · nginx/systemd config already in git · monthly **restore drill** (restore into Docker locally, verify row counts).
- **Phase 1+:** pgBackRest with WAL archiving → RPO 5 minutes, point-in-time recovery.

**Targets (honest numbers):** Phase 0: **RPO 24 h / RTO 4 h** (single box rebuilt from git + backups). Phase 1: RPO 5 min / RTO 1 h. Phase 2 (HA): RPO ~0 / RTO minutes.

**Why dumps first:** for a free-phase product the risk is *losing data*, not losing minutes — dumps are simple, verifiable, and testable by one person; WAL streaming adds moving parts that need the monitoring we don't have yet. The restore drill is the actual DR policy — an untested backup is not a backup.

## 5. High Availability

**Options:** single box (accept downtime) · two boxes (app/DB split) · full HA (LB + replicas + Patroni ×3) · cloud-managed HA

**Our choice: single VPS + backups + monitoring in Phase 0. Phase 1: split app/worker and DB onto separate boxes + read replica. Phase 2: stateless API replicas behind nginx + Patroni ×3 (or managed Postgres per §3 trigger).**

**Why:** HA is bought with money and complexity; in the free phase there is no revenue loss from downtime — only trust loss. We mitigate trust with the honest RTO (4 h), an uptime monitor with alerts (add in Phase 0 — UptimeRobot free tier or self-hosted Uptime Kuma), and tested restores. Paying ~€100+/mo for HA before the first paying customer is the wrong order of operations.

**Revisit trigger:** first 10 fleets onboard → immediately do the Phase 1 split; Phase 2 HA when the free-phase exit trigger (10 fleets / 100 trips / 60% WAD) flips or a customer contract demands an SLA.

---

## 6. Decision summary table

| Layer | Choice | One-line why |
|---|---|---|
| Backend | TS monolith (Fastify + Prisma + BullMQ) | one language, one deploy, enough performance, modular enough |
| Web frontend | React + Vite SPA | behind login — no SSR needed; TS end-to-end |
| Marketing site | static HTML | zero runtime, already live |
| Mobile | native Android (Kotlin/Compose) | battery + background GPS + FCM decide retention |
| Database | PostgreSQL + PostGIS + TimescaleDB, self-hosted | geo features are the moat; €0 COGS now; migrate to managed at Phase 2 trigger |
| DR | nightly dumps → offsite + restore drills (now) · pgBackRest/WAL (Phase 1+) | untested backups don't count; RPO 24h→5min as we scale |
| HA | single box now · app/DB split at 10 fleets · Patroni/managed at Phase 2 | downtime costs trust, not revenue — until it costs revenue |

## 7. Immediate DR action items (small, overdue)

1. ✅ **Waitlist backup** — nightly cron on the VPS (tar.gz → `/var/backups/roadwisefleet`), added in this commit.
2. ⏳ Offsite copy (B2 bucket) — needs one credential from the founder; cron is ready to extend.
3. ⏳ Uptime monitor (Uptime Kuma self-hosted or UptimeRobot) — before first fleets.
4. ⏳ First restore drill — within 2 weeks of the first Postgres deployment.
