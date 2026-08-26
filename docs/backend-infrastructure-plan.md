# RoadwiseFleet — Backend Infrastructure Plan (100 → 1,000 → 10,000 users)

**Author:** engineering draft · **Status:** proposal for discussion
**Assumption set:** self-hosted start on the current VPS (Debian 13, 40 GB, IP 51.222.139.227), low-COGS-first, global ambition with regional modules (EU eCMR · IN e-way bill/UPI · BR CT-e/Pix · NA ELD).

---

## 0. What "users" means (this decides everything)

| Tier | Users | Driver accounts | Fleet accounts (paying) | Concurrent active trucks | Deliveries/day |
|---|---|---|---|---|---|
| 100 | 100 | ~75 | ~25 | ~30 | ~120 |
| 1,000 | 1,000 | ~750 | ~250 | ~300 | ~1,200 |
| 10,000 | 10,000 | ~7,500 | ~2,500 | ~3,000 | ~12,000 |

Every number below derives from these. The expensive signals are **not** logins — they are GPS pings, trip events, document uploads, and the dispatch board's live view.

### Load math (honest ballparks)

| Signal | Rate | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|---|
| GPS ping (1 / 20 s per active truck) | 3/min/truck | ~1.5 ev/s | ~15 ev/s | ~150 ev/s |
| Trip events (status change, POD, detention) | ~20/trip | 0.03 ev/s | 0.3 ev/s | ~3 ev/s |
| Photo uploads (POD, docs) | 1–3 MB avg | 0.2 GB/day | 2 GB/day | 20 GB/day |
| API requests (app sync + dashboard) | mix | 5–15 req/s | 50–150 req/s | 500–1,500 req/s |
| Live viewers (dispatch board) | 1/active truck | ~30 sockets | ~300 sockets | ~3,000 sockets |

**Verdict:** the whole problem at 10k users is still a *small* system in absolute terms — a single modern box can almost carry it, but the database and the real-time layer need a deliberate design from day 1 so that scaling is "add replicas", not "rewrite".

---

## 1. Phase 0 — 100 users (what you build today, one VPS)

**Goal:** ship the MVP to the first 25 fleets, keep monthly infra cost ≈ €10–15 (the VPS you already own).

### Stack (monolith-first, boring and safe)

- **API:** TypeScript monolith — Fastify (or NestJS if you want batteries). One deployable, one repo. REST for CRUD + a WebSocket gateway for the live dispatch board.
- **Database:** PostgreSQL 17 with three extensions from day 1:
  - `PostGIS` — routes, geofences, "empty trucks near X" queries (a core product feature).
  - `TimescaleDB` — the `truck_positions` hypertable. GPS pings go here, never into a plain table you'll have to migrate later.
  - `pgcrypto`/`citext` — small things that prevent big migrations.
- **Cache & queues:** Redis 7 — session/pub-sub for WebSocket fan-out, job queue (BullMQ) for image processing, rate limiting, and the GPS write buffer (ingest → Redis stream → batch INSERT into Timescale).
- **Object storage:** MinIO (S3-compatible) on the same box, behind the API via **presigned URLs** — drivers upload photos straight to storage, the API never proxies megabytes. Switching to managed S3/R2/B2 later is a config change, not a rewrite.
- **Push notifications:** Firebase Cloud Messaging (FCM) for Android; fall back to Web Push for dashboard browsers.
- **Auth:** JWT (15-min access) + rotating refresh tokens; RBAC roles = `owner`, `dispatcher`, `driver`, `accountant`. One `org_id` on every tenant row (multi-tenancy from row 1 — retrofitting this later is a nightmare).
- **Delivery:** Docker Compose on the VPS (`api`, `worker`, `postgres+timescale`, `redis`, `minio`, `caddy`/`nginx`). Daily `pg_dump` to object storage + offsite (e.g., GitHub Actions artifact or B2 bucket).

```
[Android app] ──▶ API (Fastify) ──▶ PostgreSQL (+PostGIS/Timescale)
[Web dashboard] ─┘        │  ├──▶ Redis (cache · pubsub · queue)
                          │  └──▶ MinIO (photos via presigned URL)
                    Worker (BullMQ) ──▶ thumbs, exports, webhooks
                    WS gateway ──▶ dispatch board live updates
```

### What NOT to build yet
- No microservices, no Kubernetes, no Kafka, no separate auth service, no managed DB.
- No home-grown queue or WebSocket fan-out — Redis pub/sub is enough for 30 sockets.

### Also needed at this phase (product, not infra)
- **Waitlist endpoint** for the landing page (tiny POST `/api/waitlist` + Postgres table) — wire the form on `web/index.html`.
- Health checks, structured logs (JSON), one metrics endpoint (Prometheus format).

---

## 2. Phase 1 — 1,000 users (add boxes, not complexity)

**Trigger:** ~300 fleets, or any single bottleneck (usually Postgres CPU or storage fill) hits ~70% utilization for a week.

| Change | Why |
|---|---|
| Second VPS (or +2) | split **API/worker** from **Postgres/Redis/MinIO** — DB gets its own RAM/IO |
| Postgres read replica | dashboards are read-heavy; send analytics/reports to the replica |
| nginx/HAProxy in front | reverse proxy + TLS + rate limiting + simple load balancing across 2 API instances |
| Redis Streams for GPS ingest | replace the ad-hoc buffer with a durable stream; batch-write Timescale |
| Move photos to managed object storage (B2/R2/Wasabi) | 2 GB/day → 20 GB/day growth; MinIO maintenance becomes its own job |
| CDN for static assets | Cloudflare (free tier) — also gives you DDoS protection + bot management |
| Monitoring | Prometheus + Grafana (self-hosted on the second box); alert on p95 latency, queue depth, disk |
| Logs | Loki (or just JSON logs + `docker logs` shipped to a cheap store) |
| Backups | WAL archiving (`pgBackRest`) + point-in-time recovery; test a restore monthly |

**Decision gates (only do when the metric says so):**
- Split the worker out of the monolith **only** when image-processing jobs starve the API (CPU contention) — not before.
- Add Postgres pooling (PgBouncer) when connections > ~200.
- Consider read-model tables (trip status denormalized) when dashboard queries touch 10+ joins.

**Cost at 1,000 users:** ~€25–60/month self-hosted (2–3 small VPS + B2 + Cloudflare free).

---

## 3. Phase 2 — 10,000 users (the real system, still boring)

**Trigger:** crossing ~3,000 active trucks, or multi-region data-residency requirements (GDPR/LGPD) become contractual.

### Architecture at 10k

```
                          ┌─ API ×N (stateless, autoscaled)
L7 LB (Cloudflare ── nginx)─┼─ WS gateway ×N ──────┐
                          └─ worker ×N (queues)    │
                                                   ▼
  PostgreSQL HA (Patroni ×3 or managed Neon/RDS) ◀─┼─ Redis cluster (pub/sub + cache + streams)
   ├─ Timescale hypertables (GPS)                 │
   ├─ PostGIS queries                             │
   └─ read replicas ×2                            │
  NATS JetStream / Kafka ── event backbone (trip events, payments, compliance)
  S3-compatible storage (managed) · CDN · FCM/APNs
```

### The five changes that actually matter at this scale

1. **Telemetry is its own lane.** GPS/timeseries never touches the transactional DB. If Timescale ever strains, a dedicated ClickHouse for analytics is the exit hatch — but do not start there.
2. **Event backbone.** Trip lifecycle events go through NATS JetStream (lighter than Kafka and sufficient at this volume). Consumers: notifications, payments webhooks, compliance exports, analytics. Kafka only if a partner/team demands it.
3. **Multi-tenant data boundaries.** Options, in order of preference: (a) schema-per-region for EU/BR (data residency made easy, still one cluster), (b) Postgres **Row-Level Security** per `org_id`, (c) sharding — almost certainly unnecessary at 10k users; resist it.
4. **Stateless API + distributed sessions.** JWTs already make the API stateless; move Redis to a small cluster (3 nodes) so WS pub/sub survives a node failure.
5. **Edge deployment.** Static assets + TLS at Cloudflare; consider regional API deployments only where *latency* demands it (a dispatch board in Mumbai does not need an API in Frankfurt — but it also works fine with one if p95 < 300 ms; measure before you split regions).

### Managed vs self-hosted decision rules (full-stack honesty)

| Component | Self-host while | Go managed when |
|---|---|---|
| Postgres | cost matters and you do backups religiously | revenue justifies (Neon/RDS/Aiven) — managed Postgres + Timescale exists |
| Object storage | growth < 10 GB/mo | above that — B2/R2 cost ~$5–6/TB/mo, not worth owning |
| Redis/queues | single region, low volume | memory > 16 GB or HA becomes painful |
| Kafka/NATS | never | always NATS first; Kafka is a team-scale decision |
| CDN/DNS/WAF | never | Cloudflare free→pro from day 1 |

**Cost at 10,000 users:** ~€150–400/month self-hosted; ~€500–1,500/month with managed Postgres + NATS cloud. Both are far below what the SaaS revenue should be at this stage — infrastructure is **not** the business risk here; distribution is.

---

## 4. Regional modules (how the "one architecture, regional modules" decision meets the backend)

Each regional compliance/payment module is an **adapter behind an interface**, not a fork:

```
modules/compliance/ecmr-eu/     modules/payments/pix-br/
modules/compliance/ewaybill-in/ modules/payments/upi-in/
modules/compliance/cartaporte-mx/ modules/payments/sepa-eu/
```

- Compliance = document builders + webhook receivers (gov tax-authority APIs are HTTP-first).
- Payments = provider adapters with **idempotency keys** and a single `settlements` ledger table; region = provider config, not code.
- Data-residency flags (`data_region: eu|in|br|na`) on the org → routes storage bucket + DB schema per policy.

---

## 5. Concrete build order (next 90 days)

1. **Week 1–2:** repo scaffold — TS monorepo (`apps/api`, `apps/worker`, `packages/shared`), Docker Compose stack (Postgres+Timescale+PostGIS, Redis, MinIO), migrations (Prisma or Drizzle — pick one and never hand-write SQL migrations), auth + RBAC + `org_id` tenancy.
2. **Week 3–4:** core domain — orgs, drivers, trucks, trips; GPS ingest → Redis stream → Timescale batch; WS dispatch board MVP; FCM push.
3. **Week 5–6:** documents — presigned uploads, POD workflow, image thumbnails (worker); waitlist endpoint on the landing page; Grafana + alerts.
4. **Week 7–8:** first regional module (pick the beachhead — BR Pix adapter or IN e-way bill), webhooks, settlement ledger; load test with 1,000 simulated trucks (k6/Artillery) and fix what breaks.
5. **Week 9–12:** 10-fleet pilot, per the research's next-steps; iterate on p95 latency and driver-app battery cost (GPS batching is a battery feature, not just an infra feature).

## 6. Risks that kill you at each stage (and the mitigations)

- **100 users:** founder/operator risk — if the founder disappears, backups + runbooks must exist (this doc + IaC). Mitigation: everything in Docker Compose + one `make deploy` script.
- **1,000 users:** silent data loss (untested backups) and lock-in to a bad schema. Mitigation: monthly restore drills; tenant-keyed indexes from day 1.
- **10,000 users:** compliance breach (mixing EU/BR data), notification storms, and cost creep. Mitigation: data-region flags, per-org rate limits on push, monthly cost review with the numbers in §3.

---

*Maintain this document as the system grows — the phase triggers in §2/§3 are the engineering review checklist for every scaling decision.*
