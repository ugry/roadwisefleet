# RoadwiseFleet — Momentum & Gap Analysis

**Date:** 2026-08-26 · **Author:** engineering review
**Method:** inventory of every artifact vs. what a working EU fleet platform needs, viewed through UI / backend / functionality / process lenses.

---

## 1. Where we are — momentum scorecard

| Domain | Grade | Evidence |
|---|---|---|
| Strategy & market research | **A** | 4 cited regional reports, beachhead logic, honest scope (EU, free, small fleets) |
| Product definition | **A** | Menus, personas, trip lifecycle, ER model, state machine, 12 pain→fix pairs |
| Public web & domain | **A−** | Live HTTPS site on VPS + Pages, CI lint/deploy, waitlist in production, hardening done |
| Backend | **D+** | Fastify+Prisma scaffold committed — but never installed, never run, zero tests, zero staging |
| Android app | **F** | Zero code, zero wireframes for product screens (only a menu tree) |
| Customer validation | **F** | Zero hauler conversations; no interview script designed |
| Email & legal infra | **F** | No mailbox at the domain (SPF is `-all` = nothing can send), no Privacy Policy / ToS while already collecting personal data |
| Process & QA | **F** | No test strategy, no staging env, no incident runbook, no error tracking |

**Momentum verdict:** we have an unusually strong *specification* and a credible *front door* — but the product itself is still 100% unbuilt, and two silent killers are already live: the waitlist collects emails without a privacy policy, and the domain can't send any email.

---

## 2. What is designed (functionality inventory)

| Layer | Designed ✅ | Where |
|---|---|---|
| Product | 3 personas, 3 menu trees, trip lifecycle, status state machine | menu plan · diagrams |
| Driver app | 5 tabs + offline queue, detention, SOS, rest-time, ledger, chat | solutions design |
| FM dashboard | 10 menus incl. dispatch, compliance, finance-lite, scorecards | menu plan |
| Customer | portal + WhatsApp booking/tracking/documents | menu plan |
| API | `/v1` surface, scoped keys, idempotency, webhooks, sandbox, OpenAPI | spec v1 §5 |
| Auth | signup/verify/lockout/2FA, 3 registration paths | spec v1 §6 |
| Security | Turnstile+honeypot, rate-limit table, key hashing, audit log | spec v1 §7 (waitlist part **shipped**) |
| Infra | Phase 0–2 scaling, PostGIS/Timescale, presigned uploads, event spine | infra plan |
| Data model | 18 Prisma models incl. API keys/webhooks/verification | prisma/schema.prisma |

**Shipped in production:** landing/dashboard/diagrams pages (HTTPS), waitlist service, ufw+fail2ban, deploy.sh, CI (HTML lint + Pages).

---

## 3. What is MISSING — never mentioned anywhere

### 3.1 UI/UX gaps
1. **No product screens designed at all.** We have a static dashboard mock and a menu tree — zero wireframes for driver app, customer portal, or FM screens beyond the front page. The next design artifacts should be product screens, not marketing pages.
2. **Onboarding & empty states** — first-run wizard for a new org, driver first-trip tutorial, empty dashboard with a guided "create your first trip" — unmentioned.
3. **Owner-operator mode** — a 1-truck owner is FM *and* driver in one login; the whole UX assumes two roles. The majority of EU carriers are exactly this.
4. **Exception states** — truck breakdown, load refused, driver sick, re-assignment, rerouting. The state machine only knows CANCELLED.
5. **FM on mobile** — dispatchers use desktops, but 5-truck owners live on phones; no responsive/mobile FM decision made.
6. **Accessibility & i18n depth** — WCAG plan absent; pluralization/date/currency formats per locale unplanned.
7. **Notification center** — in-app inbox for FM (beyond the alerts strip) unmentioned.
8. **Design system for the product UI** — we have a *marketing* brand spec; the product component/token system is undefined.

### 3.2 Backend gaps
1. **Email sending is currently impossible.** DNS SPF is `v=spf1 -all`; no DKIM/DMARC; no mailbox; `hello@roadwisefleet.com` on the landing page doesn't exist. Email confirmation can't ship until this is fixed.
2. **Privacy Policy / Terms pages** — legally required before collecting the emails we're already collecting (GDPR, EU).
3. **No backup of production waitlist data** (JSONL on one disk) — one `rm` away from losing every lead.
4. **nginx config not in the repo** — server state lives only on the VPS; rebuild = redo from memory.
5. **No staging environment** — VPS is production directly; no safe place to deploy the API.
6. **Zero testing strategy** — no unit/integration/e2e/contract tests planned for the public API; CI only lints HTML.
7. **Provider decisions unmade:** WhatsApp Business API (Meta vs Twilio vs 360dialog), maps/routing (GraphHopper/OSRM self-host vs HERE/TomTom), SMS for driver OTP, MT translation for chat, transactional email provider.
8. **No observability** — no uptime monitor, no error tracking (Sentry-like), no Grafana; we'd discover outages from users.
9. **Feature-flag infrastructure** — repeatedly promised ("free→paid is a flag") but no flag system designed.
10. **GDPR rights endpoints** — export/erasure (`right to be forgotten`) endpoints unplanned; cookie/consent on the landing page absent.
11. **Localization backend** — i18n file structure, locale negotiation, per-locale formats unplanned.
12. **Secrets rotation** — the GitHub token story needs a defined rotation path.

### 3.3 Functionality gaps (domain features never discussed)
1. **ADR dangerous-goods and temperature-controlled loads** — real EU freight the platform can't represent yet.
2. **Cross-border customs/TIR/transit documents** — the CEE+Turkey corridor (our target segment!) needs TIR carnets, ATA, transit declarations; only eCMR is in scope.
3. **Multi-leg / relay / LTL partial loads** — the data model only has one origin→destination.
4. **CSV/data import from spreadsheets** — small fleets switching tools will demand import of drivers/trucks/customers; unmentioned and adoption-critical.
5. **Interop with incumbent tools** — Trans.eu, Webfleet, existing TMS exports; no migration path designed.
6. **POD disputes & corrections** — a disputed delivery has no workflow.
7. **Recurring orders / standing contracts lifecycle** — mentioned once, never designed.
8. **Driver onboarding verification** (license checks against authorities) — P1, unplanned.
9. **Support & help** — in-app help, FAQ, ticket flow: zero design.
10. **Product analytics** — activation/retention funnel beyond the 3 flip metrics is undefined.

### 3.4 Process gaps
1. Customer interview script (the 5–10 hauler calls keep being deferred — they need questions, not intentions).
2. Release process (semver, changelog) and incident runbook.
3. Android app store presence, release channels, beta testing plan.

---

## 4. The plan — sequenced

### Immediately (before any more feature work)
1. **Fix email identity:** create `hello@` mailbox, SPF include for the mail provider, DKIM, DMARC — else registration emails will bounce.
2. **Publish Privacy Policy + Terms** (simple, honest pages; link in footer + waitlist).
3. **Back up the waitlist** (nightly cron to object storage/B2) and **commit nginx config + waitlist unit into the repo**.
4. **Decide the five providers** (WhatsApp, maps, SMS, MT, email) — document in one page.

### Next sprint (product begins)
5. **Design the product screens** — driver Trips + Documents, FM dispatch board, customer booking — wireframes first (OpenDesign pipeline), then build.
6. **Install the API scaffold locally + on the VPS as a staging instance** (different port, no public exposure), add `pnpm install` retry workaround.
7. **Auth core** (signup/verify/lockout/Turnstile) — blocked on #1.
8. **Testing + CI for the API** (unit + contract tests on `/v1`), error tracking (Sentry self-host or GlitchTip).

### Then
9. **Android skeleton** — Trips + Documents + offline queue + batched GPS (Kotlin/Compose).
10. **Interview 5–10 haulers** with the script from §3.4-1; reconcile the menu plan with reality.
11. Data import (CSV) — cheap and removes the biggest adoption objection.

### Guardrails
- The "not mentioned" lists in §3 become the backlog: anything we build should trace to a pain point in the spec or a gap here.
- Free-phase discipline: no billing, no marketplace until the 10-fleet / 100-trip / 60% WAD trigger.
- Every production system gets a backup and a monitor before it gets a new feature.
