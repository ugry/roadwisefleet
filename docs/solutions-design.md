# RoadwiseFleet — Solutions Design: UX + Backend per pain point

**Status:** v1 design · implements the pain-point map of [product-spec-v1.md](product-spec-v1.md)
**Convention:** every solution = one UX flow + one backend pipeline. Statuses: 🟢 shipped (waitlist) · 🟡 designed (this doc) · ⚪ later phase.

---

## DRIVERS

### 1. Paperwork → photograph-once digital trip file 🟡
**UX.** Documents tab shows a per-trip checklist with status chips (Missing / Uploaded / Verified). Tap "eCMR" → camera with auto-edge detection → photo gets GPS + timestamp overlay → optional e-signature pad → done. At delivery, one button produces the POD from the already-collected photos. Everything queues offline and syncs later — no paper, no re-typing.
**Backend.**
- Upload path: `POST /v1/trips/:id/documents/upload-ticket` → API returns a **presigned MinIO/S3 URL** → the app uploads bytes directly (the API never proxies megabytes) → `POST /v1/documents/:id/complete` marks it.
- Worker (BullMQ): thumbnail → virus scan → (P1) OCR to pre-fill fields → status `VERIFIED` or manual-review queue.
- Storage keys: `{org}/{trip}/{docType}/{uuid}.jpg` — per-org/region prefixes satisfy data-residency later.
- Offline: local Room/SQLite queue with client-generated UUIDs (idempotent retry), sync-on-connect.

### 2. Unpaid waiting → automatic detention timer → claims 🟡
**UX.** When the driver enters the shipper's geofence (or taps "I'm waiting"), a large timer starts on the Trips screen. Leaving stops it and asks: "1h 40m waiting — add to claim?" One tap: yes. The driver never fills a form.
**Backend.**
- PostGIS: `ST_Within(location, customer_geofence)` on each GPS batch → auto start/stop `DetentionSession` rows.
- Rule engine: billable minutes = total − free time (from the customer contract, e.g., 60 min free) → on POD, a line item is auto-added to the invoice.
- Emits `StatusEvent(DETENTION_LOGGED)` → FM alert + webhook.

### 3. Parking & theft → SOS + secure parking 🟡
**UX.** SOS floats on every screen: long-press → location + trip + driver identity broadcast to the FM (dashboard + notification) and to the driver's emergency contact. The parking screen lists rated secure lots near the route; drivers rate them after a night.
**Backend.**
- `POST /v1/sos` → WS push to the org's dispatchers + FCM + `AuditLog`.
- Parking directory: imported/partner data + driver ratings (avg/ count) — query by route corridor.
- Theft alerts: curated feed published to FCM topics per corridor (e.g., `eu-theft.A1-PL`).

### 4. Tacho stress → rest-time assistant 🟡
**UX.** "More" tab shows big countdowns in the driver's language: driving time left, break due at, weekly rest status, and a warning ("45 min break due in 20 min — next rest area 12 km").
**Backend.**
- Rules engine (EC 561/2006) computes state from driving-session events; projections recomputed on every event (cheap — in-memory rules, persisted projections).
- Cron checks upcoming violations → FCM warnings (not nagging: only actionable ones).
- P1: pair with tachograph data (Smart Tacho 2 download) instead of app-inferred driving.

### 5. Slow pay → transparent money ledger 🟡
**UX.** Money tab: this trip's card breaks down rate − advances − expenses = net, with a settlement timeline ("FM confirmed €860 · pays Friday"). History shows monthly totals. No surprises = no churn.
**Backend.**
- `Trip.rateEur`, `Expense`, `Advance`, `Settlement` rows; net computed **server-side** (never trust client math).
- Free phase: FM marks `PAID` manually → FCM + ledger update. Monetization phase swaps in SEPA quick-pay behind the same status machine.

### 6. Dispatch chaos → structured multilingual chat 🟡
**UX.** Messages tab: one thread per trip. Quick-reply buttons ("Loaded", "ETA +30m") send structured statuses, not free text. Voice notes supported (drivers can't type while driving). Auto-translate toggle: dispatcher writes DE, driver reads PL.
**Backend.**
- `ChatMessage` table (tripId, sender, kind: text/voice/quickreply/status, translations JSON).
- Delivery: WebSocket via Redis pub/sub; offline messages queued and replayed.
- Translation: per-message MT call cached by (text, lang-pair); quick-replies are i18n keys — translated for free.

---

## CUSTOMERS

### 7. No visibility → live map + proactive WhatsApp ETAs 🟡
**UX.** Portal Shipments: map with the truck, ETA band, and a timeline. No refresh button — it moves. WhatsApp messages arrive at milestones: "Departed Rennes · ETA Lyon 21:15" · "Arrived".
**Backend.**
- `GET /v1/trips/:id/position` — last GPS from Timescale + ETA from routing service (or median historical for the corridor).
- Live: WS subscribe; fallback: 30 s poll.
- Milestones: `StatusEvent` consumers on the event backbone → WhatsApp Business API template messages → per-customer notification prefs (WhatsApp/email).

### 8. Document chasing → auto-delivered POD/eCMR 🟡
**UX.** On delivery the customer receives the POD and eCMR as WhatsApp files and in the portal's Documents — zero chasing, zero requests.
**Backend.**
- Consumer on `trip.delivered`: fetch `Document(type=pod|ecmr)` → PDF render job → WhatsApp media send + portal visibility + `document.uploaded` webhook.

### 9. Booking friction → one-form booking + instant quote 🟡
**UX.** Portal: origin/destination autofill from saved addresses, cargo presets, date picker → price appears instantly → Book. WhatsApp: same flow as a short conversation ("2 pallets, Wrocław → Berlin, Friday?" → quote → "yes").
**Backend.**
- `POST /v1/orders` → pricing service: customer contract rate cards + zone/distance table + fuel surcharge config → `Order(BOOKED)` + quote stored for audit.
- WhatsApp: session state machine over the Business API with the same order endpoint underneath — one source of truth for both channels.

### 10. Reconciliation → per-shipment invoice bundles 🟡
**UX.** Each shipment's invoice arrives with its POD, eCMR, and detention line items attached — one package per order, matching how the customer's finance team thinks.
**Backend.**
- On `POD_UPLOADED`: invoice-builder job → `Invoice` row + PDF in storage → `invoice.issued` webhook + customer notification.
- Numbering per org/region (fiscal-rule pluggable later); line items reference trip data — never typed twice.

---

## FLEET MANAGERS

### 11. Empty miles → live board + return-load matching 🟡
**UX.** Dispatch board: trucks as cards with status color; empty trucks get a "returning empty" flag. The Return-loads panel suggests loads (own customers first, pool later) matched to where trucks actually are.
**Backend.**
- Matching query (PostGIS): empty/soon-empty trucks + open orders near the planned route; scoring = detour distance + rate + customer priority.
- Assign → `Trip(ASSIGNED)` → driver gets the offer in-app (accept/decline) — no phone calls.

### 12. Driver churn → retention tooling + scorecards 🟡
**UX.** Drivers screen: scorecards (on-time, care, tenure, app usage) with trend; churn-risk flag on at-risk drivers; bonus configuration ("+€50 for 100% on-time this month").
**Backend.**
- Nightly aggregation job: on-time = delivered within ETA window, care = claims/damage inverse, tenure, weekly app opens → scores persisted.
- Thresholds → FM alerts; drivers see their own summary only (fairness is a retention feature, not a nice-to-have).

### 13. Compliance → vault with expiry alerts 🟡
**UX.** Compliance menu: one vault for driver files (license, CPC, medical, insurance), tacho download reminders, and an expiry calendar — red = expiring in 30 days. One-click audit export (zip).
**Backend.**
- `Document` rows typed per category with `expiresAt`; daily cron → alerts (FM dashboard + email).
- eCMR stored under eFTI-ready conventions (P1: real eFTI exchange before the 2027 deadline).

### 14. Manual invoicing → invoice auto-drafted from POD 🟡
**UX.** A delivered trip shows "Draft invoice" with line items already filled (freight, detention, extras). FM reviews and sends — the invoice is an approval, not a typing exercise.
**Backend.**
- Billing job on POD: rate + billable detention (from #2) + expenses marked billable → `Invoice(DRAFT)` → FM approve → `ISSUED` → webhook + customer WhatsApp/email.

---

## Cross-cutting architecture notes (how the pieces connect)

```
Driver app (offline queue, batched GPS)
   │  presigned uploads · events · chat
   ▼
API (Fastify) ── Redis (pub/sub · BullMQ) ── workers (OCR, PDF, billing, alerts)
   │  ▲
   ├── PostgreSQL + PostGIS (geofences, matching) + Timescale (GPS)
   ├── MinIO (documents)        │
   └── NATS (P1: event backbone) ── consumers: WhatsApp · webhooks · FCM · email
```

Three patterns do most of the work:
1. **StatusEvent is the spine** — detention, delivery, POD, invoice all *are* status transitions; every notification, webhook, and alert is a consumer of the same stream.
2. **Presigned uploads + workers** — the API never touches megabytes; heavy work (OCR/PDF) is always a queue job.
3. **Server-side truth** — money math, scorecards, and compliance states are computed by the backend; the apps are dumb-but-pretty clients. That's what makes the free phase → paid phase transition a feature flag, not a rewrite.

**Shipped vs designed:** 🟢 the waitlist (rate limit + honeypot + admin token) is live in production. Everything else above is 🟡 designed, and maps 1:1 to the build order in product-spec-v1.md §9.
