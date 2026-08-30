# RoadwiseFleet — Design Critique & Corrections v1.1

**Method:** adversarial review of every design decision against the field research and first principles. Each item: what's wrong, how serious, and the fix. Fixes marked ✅ are applied to the repo in this commit.

---

## A. Strategic flaws

### A1. The wedge is mismatched with the payer ⚠️ HIGH
**Critique:** We build for drivers but the *customer* is the fleet owner. The driver app is free; the FM pays for the SaaS — and the SaaS (dispatch board) is the least differentiated, weakest part of the design. If the FM sees no value in the first session, the driver app never gets installed. We're selling "driver-first" to people whose first question is "what's in it for me?"
**Solution ✅:** Give the FM a *measurable win in the first 15 minutes*: CSV import (drivers/trucks/customers) → live board immediately. And give the FM one number only we produce: **"detention recovered this month: €X"** — a money-back ROI counter on the dashboard. Detention claims become the FM wedge (money), parking becomes the driver wedge (life quality). The landing page must lead with the FM's ROI, not the driver's happiness.

### A2. Parking-first is un-moated and has a cold-start problem ⚠️ HIGH
**Critique:** Crowdsourced parking needs driver density we don't have (chicken-and-egg), and Truckfly already owns the network. A parking tab with no data is an empty screen that destroys trust.
**Solution ✅:** Don't build a crowdsourced directory from zero. Aggregate existing data (public secure-parking registers, Truckfly/Bosch data where licensed, OSM) and let drivers annotate on top. Make parking **route-embedded**: the app suggests rest stops along the planned route *at the time the driver must stop* (feeding off the rest-time assistant). Parking is the marketing hook, never the revenue hook.

### A3. Two markets at launch (EU + Turkey) is scope suicide ⚠️ HIGH
**Critique:** The launch plan implies EU (4 languages) + Turkey module + e-İrsaliye simultaneously. That's two compliance regimes, two border realities, two support languages — for a one-person team.
**Solution ✅:** **One market at launch.** If the founder's network is Turkish: Turkey-first (TR language only), EU corridor second. Otherwise EU (CEE corridor) first with **EN + one language** (PL). Everything else is v2. Delete "EN/DE/PL/TR at launch" from the plan; keep i18n infrastructure, ship 2 locales.

### A4. The WhatsApp bridge is a slogan, not a design ⚠️ MEDIUM-HIGH
**Critique:** "WhatsApp booking/tracking" appears in every doc but has no conversation design, no session state machine, no provider decision (Meta Cloud API vs 360dialog/Twilio), no template-approval plan, no failure fallback, and no cost model — on a *free* product where every message costs money.
**Solution ✅:** Spec the WhatsApp flows as explicit state machines (booking: ask origin→destination→cargo→dates→quote→confirm; tracking: milestone templates only — ≤4 messages per trip). Choose **Meta Cloud API direct** (cheapest at volume, full control) with **SMS/email fallback**. Absorb message cost until the paid phase; cap at 4 template messages per trip (session messages are free within the 24h window — design flows to exploit that).

---

## B. Data-model flaws (the schema lies)

### B1. The schema cannot express real freight ⚠️ HIGH
**Critique:** `Trip` has one origin/destination, one driver, one truck. Real EU freight = multiple stops, sometimes multiple drivers (relay), LTL partials. The day we meet a real customer we can't model their trip.
**Solution ✅:** Add `TripStop` (sequence, kind: pickup/delivery/checkpoint/rest, address, lat/lng, planned/arrived times) and `TripDriver` (assignment table, role: main/relief). Trips keep single status; stops carry the detail.

### B2. Detention was designed but its data was never modeled ⚠️ HIGH
**Critique:** The detention feature depends on geofences, but there is **no Geofence model** in the schema — the flagship FM feature has no storage.
**Solution ✅:** Add `Geofence` (org/customer-scoped, lat/lng + radius, kind: shipper/yard/rest). Detention sessions derive from `StatusEvent` + geofence hits.

### B3. Compliance vault without expiry ⚠️ MEDIUM
**Critique:** The compliance vault's whole value is expiry alerts, but `Document` has no `expiresAt` column.
**Solution ✅:** Add `expiresAt` + `issuingAuthority` to `Document`.

### B4. Pricing service has no storage ⚠️ MEDIUM
**Critique:** "Instant quote from agreed rates" is a headline customer feature, but there is no rate model — quotes would be magic.
**Solution ✅:** Add `RateCard` (customer-scoped, zone/route pricing, free-detention minutes, detention €/hour, fuel surcharge flag).

### B5. Spec vs schema contradiction ⚠️ LOW
**Critique:** Spec §6 says stateless HMAC verification tokens; the schema also has a `VerificationToken` table. Two designs for one thing = drift.
**Solution ✅:** Stateless HMAC wins (no table to leak). Remove `VerificationToken`; invites use the same HMAC pattern with purpose `invite-*`.

---

## C. Security & trust inconsistencies

### C1. Scorecards vs anti-surveillance contradiction ⚠️ MEDIUM
**Critique:** Our own forum research says drivers hate surveillance; our FM plan sells scorecards. Hidden metrics = "big brother" = the thing we promised not to be.
**Solution ✅:** Make scorecards **driver-visible and driver-owned**: the driver sees their own score, exactly what drives it, and what changes it. Framing is bonus-only (never punishment); no metric exists that the driver can't see.

### C2. Owner-operator mode still missing ⚠️ HIGH
**Critique:** Flagged in the gap analysis, still unaddressed: the 1-truck owner is FM *and* driver in one login, and our whole UX assumes two people. That's the majority of EU carriers.
**Solution ✅:** Single-login dual-mode: the owner's app shows driver tabs + a "Fleet" tab that opens the dispatcher dashboard (mobile-first). No separate accounts.

---

## D. Economics of "free" (the unspoken COGS)

### D1. A free product still has per-truck costs ⚠️ HIGH
**Critique:** Maps/routing APIs, translation, OCR, WhatsApp messages, storage, push — every active truck costs real money, and we earn zero. At 1,000 trucks this is a real bill with no revenue.
**Solution ✅:** Set a hard free-tier COGS ceiling of **€2/truck/month** and design against it: self-host routing (GraphHopper/OSRM) instead of HERE/TomTom; lazy OCR (only on FM-requested documents); MinIO self-hosted; WhatsApp ≤4 templates/trip; FCM free. Recompute the ceiling quarterly — the free phase is a marketing budget, not a blank check.

---

## E. Ops & adoption gaps

### E1. "Product is good" trigger is unmeasurable ⚠️ MEDIUM
**Critique:** The free-phase trigger (10 fleets / 100 trips / 60% WAD) needs instrumentation we never planned — no analytics in the P0 backend.
**Solution ✅:** Add a minimal activation funnel to P0: org-created → first-driver-invited → first-trip-created → first-trip-delivered, plus weekly-active-drivers. Five counters, no analytics vendor.

### E2. From waitlist to customer there is no path ⚠️ MEDIUM
**Critique:** The waitlist captures emails and shows "we'll be in touch" — no booking, no demo, no trial. Momentum dies at the form.
**Solution ✅:** Waitlist success state offers **"Book a 20-min setup call"** (calendar link) and a **demo org** (pre-filled data) the FM can click through immediately. The landing page gets a "See the live demo" link.

### E3. Known live-production debts still open ⚠️ MEDIUM
**Critique:** Privacy Policy/Terms missing while collecting emails · `hello@` mailbox + SPF/DKIM/DMARC unfixed (SPF currently `-all`) · waitlist JSONL has no backup. All flagged, none fixed.
**Solution ✅ (committed to plan):** execute in the next work session — these block auth and are legal liabilities, not backlog items.

---

## F. Verdict

The design's **strength** (driver-first story, event-spine architecture, honest scoping) survives the critique. The **fixes** above remove its three real weaknesses: wedge-payer mismatch (A1), unreal model (B1/B2), and unfunded free phase (D1). Everything else was scoping discipline.

**Applied in this commit ✅:** schema amendments (B1–B5), spec amendments (A3 localization reduction, A4 WhatsApp spec, C1 scorecard rule, C2 owner-operator, D1 COGS ceiling, E1 instrumentation, E2 demo path).
