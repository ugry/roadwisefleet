# RoadwiseFleet — Product & Platform Specification v1

**Status:** v1 · EU-first · free until product-market fit
**Companions:** [product-menu-plan.md](product-menu-plan.md) (menus) · [backend-infrastructure-plan.md](backend-infrastructure-plan.md) (scaling) · [diagrams-data-menu-flow.md](diagrams-data-menu-flow.md) (flows/ER)
**Design goal, stated once:** *make everyone's life easier.* Every feature below exists because it kills a named pain point — anything that doesn't, doesn't ship.

---

## 1. Pain points per role (what we're fixing)

### Truck drivers
| # | Pain | Consequence | Our fix |
|---|---|---|---|
| 1 | Paperwork overload (CMR/eCMR, PODs, expense sheets) | hours/week unpaid admin, fines when wrong | digital trip file: photograph once, auto-filled docs, e-signature POD |
| 2 | Unpaid waiting (detention at docks, 140-min US average; same pattern EU) | lost driving window, unpaid time | automatic detention timer → accessorial claim |
| 3 | Parking shortage & insecurity (EU: ~300k spaces, ~7k secure; cargo theft ~10× since 2021) | unsafe nights, stolen loads | secure-parking directory, SOS, theft-alert feed |
| 4 | Tachograph / rest-time stress (Smart Tacho 2 mandatory) | fines, license risk, mental load | rest-time assistant with countdowns and violation warnings |
| 5 | Slow payment (60–90+ day terms normalised) | cash-flow anxiety, churn | money ledger with transparent settlement status |
| 6 | Dispatch communication chaos (phone + WhatsApp, language barriers) | missed instructions, errors | structured in-app chat with translated quick-replies |
| 7 | Empty backhauls | unpaid fuel burn | return-load offers inside the app |
| 8 | Isolation & health | driver shortage feeds itself | fair-pay transparency + scorecards = retention |

### Customers (shippers / cargo owners)
| # | Pain | Consequence | Our fix |
|---|---|---|---|
| 1 | No visibility — "where is my truck?" | phone calls, angry clients | live map + ETA + milestone notifications (WhatsApp) |
| 2 | Document chasing (POD, eCMR) | audit stress, payment delays | documents delivered automatically on delivery |
| 3 | Booking friction (phone/email chaos, no structured quotes) | slow, error-prone orders | one-form booking (portal or WhatsApp) with instant quote |
| 4 | Surprise delays | no planning capability | ETA updates pushed proactively |
| 5 | Invoice reconciliation | manual matching | invoice bundles documents per shipment |
| 6 | Unknown carrier quality | trust risk | carrier rating visible on repeat orders |

### Fleet managers
| # | Pain | Consequence | Our fix |
|---|---|---|---|
| 1 | Empty miles / low utilization | margin death by 15–20% deadhead | live board + return-load matching |
| 2 | Driver shortage & churn (90%+ turnover NA; EU −233k drivers) | can't grow, hiring cost | driver-first tooling as retention weapon + scorecards |
| 3 | Compliance burden (eCMR, tacho downloads, expiring driver files) | fines, admin hours | compliance vault with expiry alerts |
| 4 | Dispatch chaos (phone-based, no live view) | mistakes, double-booking | drag-and-drop dispatch board fed by driver GPS |
| 5 | Manual invoicing from paper PODs | delayed cash, errors | invoice auto-drafted from POD data |
| 6 | Slow receivables | working-capital squeeze | receivables aging + reminders (quick-pay later) |
| 7 | Customer demands for visibility | admin load | tracking is automatic — customers self-serve |

---

## 2. Fleet Manager — menu items & functionalities

**What the FM needs:** one screen that answers *"where is everything, who's late, what's unpaid, what's expiring"* — then acts from it without switching tools.

| Menu | Functionalities |
|---|---|
| **Dashboard** | KPI cards (active trips, on-time %, pending pay, empty miles) · live map with status colors · alerts (detention logged, document missing, driver file expiring, empty truck returning) · today's activity |
| **Dispatch** | board: drag load → driver · create trip (customer, route, rate, doc checklist) · load offers to drivers · return-load suggestions · geofence + ETA monitoring · bulk assign |
| **Trips** | filters (status/driver/region/date) · trip detail: timeline, documents, detention log, trip P&L (freight vs fuel/tolls/expenses) · invoice draft from POD · export |
| **Drivers** | profiles + license/CPC/medical expiry alerts · scorecards (on-time, care, tenure) · advances & settlements · invite driver (SMS/email link) · suspend/reactivate |
| **Customers** | shipper directory · contracts & agreed rates · order intake (form + WhatsApp inbox + API) · quote templates · credit status |
| **Compliance** | eCMR vault · tacho download reminders · driver-file expiry calendar · audit export · per-country checklists |
| **Vehicles** (P1) | truck/trailer registry · maintenance schedule · toll tags · fuel cards |
| **Finance-lite** | receivables aging + reminders · manual settlements · expense approval · trip profitability · export to accounting |
| **Analytics** (P1) | utilization · empty-mile % · cost/km · driver performance · customer profitability |
| **Settings** | org profile · users & roles (Owner/Dispatcher/Accountant) · **API keys & webhooks** · language (EN/DE/PL/TR) · notification preferences |

---

## 3. Customer — menu items & functionalities

**What the customer needs:** *book without friction, watch without asking, get documents automatically, pay without chasing.* WhatsApp is the primary channel; the portal is the deeper view.

| Channel | Menu / Flow | Functionalities |
|---|---|---|
| **WhatsApp** | Book → Track → Get documents | send load request as a message → receive structured quote → confirm with one word → trip status + ETA messages → POD/eCMR delivered as files on delivery |
| **Portal** | **Book a load** | form with saved addresses/routes, cargo presets, date picker, instant quote from agreed rates, recurring bookings |
| | **Shipments** | list with status filters · live map + ETA · timeline per shipment · rating |
| | **Documents** | PODs, eCMR, invoices per shipment · download/archive |
| | **Payments** (P1) | invoices · pay online · history |
| | **Account** | company profile · saved routes/addresses · team members · **API keys & webhooks** · notification preferences |

---

## 4. Truck Driver — Android menu items & functionalities

**What the driver needs:** *the job, the paperwork, and the money in one place — thumb-friendly, works offline, drains no battery, speaks their language.*

| Tab | Functionalities |
|---|---|
| **Trips** (home) | current trip card (route, ETA, checkpoints, required docs) · one-tap status updates (Loaded → Departed → Arrived → Delivered) · **detention timer** · return-load offers · history |
| **Documents** | per-trip checklist · photo capture with GPS+timestamp · e-signature POD · eCMR view · offline queue with sync-on-connect |
| **Money** | trip earnings + rate · advances request · fuel/toll/food expenses + receipt photos · settlement status · payout history |
| **Messages** | dispatcher chat (text, voice notes, quick replies, auto-translation) · load offers · announcements |
| **More** | profile + license docs (expiry alerts) · **rest-time assistant** (tacho countdowns, violation warnings) · SOS + secure parking + theft alerts · settings (language, offline mode, GPS battery saver) |

---

## 5. Public API for external customers (ERP / automation)

**Principle: API-first.** Everything the UI can do, the API can do. Customers with ERPs, brokers, or automation must be able to run their freight on RoadwiseFleet without opening a browser.

### Authentication & identity
- **API keys** per org, per integration (not per user) — issued in Settings → API keys.
- Scopes: `orders:read/write`, `trips:read`, `tracking:read`, `documents:read`, `webhooks:manage`.
- Keys are shown **once**; stored hashed (prefix visible for identification only).
- Optional **OAuth2 client-credentials** (P1) for enterprises that rotate credentials via IdP.
- Everything over HTTPS; request signing via `Authorization: Bearer rwf_live_<key>`.

### Endpoint surface (v1)
| Area | Endpoints |
|---|---|
| Orders | `POST /v1/orders` (create/quote) · `GET /v1/orders` · `GET /v1/orders/{id}` · `POST /v1/orders/{id}/cancel` |
| Trips | `GET /v1/trips?status=…` · `GET /v1/trips/{id}` (incl. timeline) |
| Tracking | `GET /v1/trips/{id}/position` (last known, ETA) |
| Documents | `GET /v1/trips/{id}/documents` · `GET /v1/documents/{id}` (POD/eCMR/invoice) |
| Webhooks | `POST /v1/webhooks` · `GET /v1/webhooks` · `DELETE /v1/webhooks/{id}` |

### API behaviour contracts (non-negotiable)
- **Versioning:** `/v1` prefix; breaking changes never ship silently.
- **Idempotency:** `Idempotency-Key` header on all POSTs — duplicate orders are impossible.
- **Pagination:** cursor-based (`?cursor=&limit=`), max limit 200.
- **Errors:** machine-readable (`{"error":{"code":"order_not_found","message":"…","requestId":"…"}}`).
- **Sandbox:** every key has a `sandbox` mode against test data before going live.
- **OpenAPI 3.1 spec** published at `/v1/openapi.json`; docs at `/docs/api`.
- **Webhooks** (signed, HMAC-SHA256): `order.created`, `trip.assigned`, `trip.status_changed`, `trip.delivered`, `document.uploaded`, `invoice.issued`. Delivery retries: 1min, 5min, 15min, 1h, 6h, 24h, then disabled with alert. Dead-letter visible in portal.

---

## 6. Registration paths & email confirmation

Three distinct paths — registration is the first security boundary, so every path is verified.

### 6.1 Fleet manager (creates the org)
1. Signup form: name, company, email, phone, password (+ country).
2. **CAPTCHA** (Cloudflare Turnstile — free, privacy-friendly) + honeypot + IP rate limit.
3. **Email confirmation:** single-use token (HMAC-signed, 24 h expiry, 3 resends max) → "verify email" link → org activated.
4. Only after verification: can invite drivers/customers and issue API keys.
5. Sign-in: rate-limited; **account lockout** after 8 failed attempts (15 min) with exponential backoff; optional TOTP 2FA.

### 6.2 Driver (invite-first — drivers never self-serve a blank org)
1. FM sends invite (SMS or email) with single-use code/link (72 h expiry).
2. Driver installs app → enters code (or taps link) → phone number verification (SMS OTP).
3. Completes profile: license, language, bank/contact details.
4. Joins org with role `driver` — no org creation, no email required (phone is identity).

### 6.3 Customer (invited by FM, or self-register against an org code)
1. FM invites via email/WhatsApp link — accept → verify email → portal login.
2. Or customer signs up with the FM's org code + their own company details → email confirmation (as 6.1) → limited scope (their own orders only).
3. WhatsApp binding: WhatsApp Business session ties the chat to the customer record.

### Email-confirmation mechanics
- Token: random 32 B + HMAC signature over `{userId, email, purpose, exp}`; no token storage needed.
- Purposes: `verify-email`, `reset-password`, `invite-driver`, `invite-customer`.
- Delivery: transactional provider (P1) — start with system SMTP + SPF/DKIM on the domain.
- Resend cooldown: 60 s; max 3/24 h; expiry 24 h (72 h for invites).

---

## 7. Security basics (registration brute-force & API overload)

### 7.1 Registration protection
| Control | Value |
|---|---|
| CAPTCHA | Cloudflare Turnstile on all public signup forms (free tier, no personal data) |
| Honeypot | hidden field — silent drop (already live in the waitlist) |
| IP rate limit | 5 signups/hour/IP, 3 verification emails/hour/IP |
| Account lockout | 8 failed logins → 15 min lock, doubling to 24 h |
| Email validation | strict RFC-ish regex + length cap + disposable-domain blocklist (P1) |
| Password policy | ≥10 chars; argon2id hashing; breached-password check (P1) |

### 7.2 API rate limiting (protects against overload & abuse)
Token-bucket per scope and per key/IP; all 429s carry `Retry-After` + `X-RateLimit-*` headers.

| Route class | Limit | Rationale |
|---|---|---|
| Waitlist POST | 5 / hour / IP | already live |
| Auth (login/signup/verify) | 10 / min / IP | brute-force ceiling |
| Default API | 120 req / min / key | fair use |
| Orders write | 30 / min / key | create-heavy abuse guard |
| Tracking read | 600 / min / key | dashboards poll a lot |
| GPS ingest (driver device) | 6 / min / device (batched) | one ping per 20 s, headroom ×2 |
| Webhook *delivery* | unlimited inbound, but HMAC-verified | signed events are trusted |

Burst handling: 2× burst for 10 s, then steady-state. Heavy-load response: 429 + `Retry-After`, never silent drops. Global per-IP floor (e.g., 600 req/min) regardless of key count.

### 7.3 Key & secret hygiene
- API keys hashed at rest (argon2id); only 8-char prefix stored for display.
- Secrets injected via env, never in code/repo (`.env` gitignored — already).
- Session JWTs short-lived (15 min) + rotating refresh tokens; revocation on logout.
- All admin endpoints require `X-Admin-Token` (pattern already deployed for waitlist).
- Audit log: auth events, key creation, webhook changes, rate-limit trips.

---

## 8. Schema additions (maps 1:1 to the Prisma model)

New models in `prisma/schema.prisma`:

| Model | Purpose |
|---|---|
| `ApiKey` | per-org integration keys: id, orgId, name, scopes[], prefix, hash, mode (live/sandbox), lastUsedAt, revokedAt |
| `Webhook` | per-org subscription: id, orgId, url, events[], secretHash, active |
| `VerificationToken` | email-confirmation state: userId/email, purpose, hash, expiresAt, consumedAt (fallback when stateless HMAC is replaced) |
| `AuditLog` | id, orgId, actorId, action, target, ip, at |

`User` gains: `passwordHash`, `emailVerifiedAt`, `phoneVerifiedAt`, `failedLoginCount`, `lockedUntil`, `totpSecret`.
`Org` gains: `apiKeyQuota`, `webhookQuota`, `rateTier`.

---

## 9. Build order (updated)

1. **Auth core** — signup + Turnstile + email verification + lockout (replaces the header-stub tenancy).
2. **Org + users + invites** — driver/customer invite flows.
3. **Trips + dispatch + status events** — the lifecycle from the diagrams doc.
4. **Public API v1** — keys, scopes, idempotency, OpenAPI, webhooks.
5. **GPS ingest** — batched device pipeline (Redis stream → Timescale).
6. **Documents** — presigned uploads, eCMR/POD flows.
7. **WhatsApp bridge** — booking/tracking/notifications.
8. **Rate-limit & audit layer** — instrument from day 1, tune with the table in §7.2.

*Reviewed against: the four regional research reports, the menu plan v2, and the backend infrastructure plan. Update this spec — not the chat — when decisions change.*
