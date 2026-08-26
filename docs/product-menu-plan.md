# RoadwiseFleet — Role Menus & Functions Plan

**Status:** v2 — founder decisions applied (2026-08-26)
**Basis:** market research (docs/market-research.md), regional MVP recommendations, backend plan (docs/backend-infrastructure-plan.md).
**Personas:** Fleet Manager (web SaaS) · Truck Driver (Android) · Customer (web portal + WhatsApp).

> One trip lifecycle ties the three roles together — every menu item below is a screen in that lifecycle:
> **Customer books → Fleet Manager dispatches → Driver executes → Customer tracks → POD generated → FM invoices → Customer pays → Driver settles.**

---

## 1. Truck Driver — Android app

Bottom navigation (5 tabs) + always-visible SOS.

| # | Menu | Functions |
|---|---|---|
| 1 | **Trips** (home) | Current trip card: load details, pickup/delivery, route + ETA, checkpoint list, required documents · one-tap status updates (Loaded → Departed → Arrived → Delivered) · **detention timer** (auto-logs waiting time at shipper, feeds the accessorial claim) · trip history · return-load offers for the way back |
| 2 | **Documents** | Per-trip document checklist (eCMR/CMR, BOL/POD, CT-e/MDF-e, e-way bill, Carta Porte) · photo capture with GPS+timestamp · e-signature proof-of-delivery · offline-first (works on no-signal highways, syncs later) |
| 3 | **Money** | Trip earnings + rate breakdown · cash advances requests · fuel/toll/food expense entries with receipt photos · settlement status ("€860 pending — pays Friday") · payout history |
| 4 | **Messages** | Chat with dispatcher (text + voice notes + quick replies) · load offers (accept/decline) · company announcements |
| 5 | **More** | Profile & license/insurance docs with expiry alerts · driving-hours assistant (tacho/HOS/rest-time countdown) · safety: SOS button, secure-parking directory, cargo-theft alerts · settings: language (PT/ES/HI/EN/TR…), offline mode, notifications, battery-saver GPS |

**Driver UX rules (from research):** one thumb for status updates; paperwork reduced to "photograph it once"; fair-pay transparency on the Money tab (the retention killer feature); app must not drain battery (GPS batching).

---

## 2. Fleet Manager — web SaaS dashboard

Sidebar navigation. Roles within the org: **Owner** (all), **Dispatcher** (Dispatch/Trips/Drivers), **Accountant** (Finance/Documents) — RBAC from the backend plan.

| # | Menu | Functions |
|---|---|---|
| 1 | **Dashboard** | KPI cards (active trips, on-time %, pending pay, empty miles) · live map (all trucks, statuses, geofenced ETAs) · alerts strip (detention logged, document missing, empty truck returning) · today's activity feed |
| 2 | **Dispatch** | Dispatch board: drag & drop load → driver · create trip (customer, route, rate, documents required) · load offers to drivers · **return-load matching** (empty trucks + nearby loads) · geofence/ETA monitoring |
| 3 | **Trips** | All trips with filters (status, driver, region) · trip detail: timeline, documents, detention log, **trip P&L** (freight vs fuel/tolls/expenses) · invoice generation from POD |
| 4 | **Drivers** | Driver profiles (licenses, insurance, expiry alerts) · scorecards (on-time, care, tenure — for retention bonuses) · attendance · advances & settlements · recruitment pipeline (driver shortage is the #1 business risk) |
| 5 | **Customers** | Shipper directory + contracts/agreed rates · order intake (manual form, API, or **WhatsApp Business bridge** — customer books from WhatsApp without installing anything) · credit notes |
| 6 | **Vehicles** | Truck & trailer registry (plates, dimensions, ownership) · maintenance schedule & breakdowns · toll tags, fuel cards, telematics pairing |
| 7 | **Compliance** | Regional modules: eCMR/eFTI (EU) · e-way bill + FASTag (IN) · CT-e/MDF-e + Tabela do Frete (BR) · ELD/HOS/IFTA (NA) · Carta Porte (MX) — document vault, expiry/warning alerts, audit export |
| 8 | **Finance** | Invoicing (auto-built from PODs) · receivables aging + payment reminders · **quick-pay/factoring** flow (Pix/UPI/SEPA) · payables: driver settlements, fuel, tolls · trip-level profitability reports · tax/fiscal reports per region |
| 9 | **Analytics** | Fleet utilization, empty-mile %, cost/km, fuel burn, on-time % · driver performance trends · region & customer profitability · CSV/PDF exports |
| 10 | **Settings** | Org profile & billing plan · users & roles · rate cards & pricing rules · integrations (WhatsApp Business API, accounting tools, customer ERP) · regional module configuration · API keys |

---

## 3. Customer (shipper / cargo owner) — web portal (+ WhatsApp)

Lightweight portal — the customer is not a power user; every screen must be reachable in ≤3 clicks, and every update must also arrive on WhatsApp (the LATAM/Asia distribution channel).

| # | Menu | Functions |
|---|---|---|
| 1 | **Book a load** | New shipment request (pickup/delivery, cargo type/weight, dates, equipment) · instant quote from agreed rates · book + schedule · recurring bookings · also possible from WhatsApp chat |
| 2 | **Shipments** | Live list of all orders with status (Booked → Dispatched → In transit → Delivered) · **live tracking**: map + truck position + ETA · milestone notifications (WhatsApp/email) · rate your experience |
| 3 | **Documents** | PODs with photo + e-signature · transport documents (eCMR/CT-e/invoice copies) · download/archive |
| 4 | **Payments** | Invoices · pay online (Pix/UPI/SEPA/card) · payment history & receipts · credit terms status |
| 5 | **Account** | Company profile, addresses & saved routes · team members & roles · API access for their ERP/TMS integration · notification preferences (WhatsApp/email/SMS) |

---

## 4. The lifecycle that connects the menus (data contract)

```
Customer ──book──▶ Order ──assign──▶ Trip ──execute──▶ Status updates (driver) ──▶ POD
   │                 │                    │
   │           (FM: Dispatch)              └─▶ Detention log ─▶ Accessorial billing
   │                                        └─▶ Money ledger ─▶ Driver settlement
   └─▶ Tracking view (real-time) ◀───────── GPS ◀─ driver app
Order billed (FM: Finance) ──▶ Customer pays (Pix/UPI/SEPA) ──▶ FM pays driver (settlement)
```

The single source of truth is the **trip/order object**; every menu is a projection of it. This is why the backend plan insists on the trip-event backbone (NATS) — status changes fan out to customer tracking, WhatsApp notifications, compliance exports, and finance.

---

## 5. Phased rollout of the menus

| Phase | Driver | Fleet Manager | Customer |
|---|---|---|---|
| **MVP (P0)** — free, EU, get 10 fleets | Trips · Documents (eCMR) · Messages · Money-lite (manual settlements) · More (tacho/rest-time) | Dashboard · Dispatch · Trips · Drivers · Customers (+WhatsApp inbox) · Compliance (eCMR + driver files) · Finance-lite (manual) · Settings (i18n EN/DE/PL/TR) | WhatsApp booking/tracking · Shipments (tracking) · Documents (eCMR/POD) · Account (no payments yet) |
| **Phase 2 (P1)** — 1,000 users | Return-load offers · toll hints · safety dir · PT/ES/RO locales | Vehicles · Analytics · SEPA quick-pay (monetization starts) · eFTI prep | Portal payments (SEPA) · API access |
| **Phase 3 (P2)** — 10,000 users | Scorecards & bonuses · marketplace loads | Factoring marketplace · multi-org groups · regional data-residency views (BR/IN modules) | ERP integrations · self-serve contracts |

**MVP in/out (v1 scope, EU):**
- ✅ In: trips + dispatch, eCMR documents + POD, WhatsApp bridge, i18n (EN/DE/PL/TR), manual money ledger, compliance basics, free orgs.
- ❌ Out: payments/SEPA, marketplace, factoring, vehicles module, analytics depth, mobile FM app, BR/IN compliance modules, pricing pages.

**Prioritization rule:** anything that reduces *driver workload* or *payment delay* outranks everything else — those are the two pain points every region's research ranked first.

---

## 6. Founder decisions (locked)

1. **Beachhead: EU.** Compliance priority = eCMR + tachograph (Smart Tacho 2 / rest-time) + eFTI readiness. CEE + Turkey cross-border SMEs are the target segment (research §2).
2. **Multi-language from day 1.** All strings via i18n keys — never hardcoded. Launch locales: **EN, DE, PL, TR** (CEE/Turkey haulers) + **PT, ES, RO** as fast-follow. Fallback EN. (BR later = PT reuse.)
3. **WhatsApp bridge is a launch feature (P0), not Phase 2.** Customers book and track from WhatsApp; the FM dashboard is the inbox.
4. **Free. No pricing, no payments, no billing in the MVP.** Monetization hooks stay dormant (per-truck SaaS + payment take-rates later). Finance menu = manual settlements tracking only. SEPA quick-pay arrives in the monetization phase, not before.
5. **Priority: a good product + small customers.** Everything else (marketplace, factoring, ERP integrations, analytics depth) waits.

## 7. EU adaptations baked into the menus

- **Driver · Documents:** eCMR (UN protocol — legally live in 41 countries) as the P0 document type; tachograph/rest-time assistant in "More" from day 1 (Smart Tacho 2 retrofit deadline end-2025 forces this).
- **Driver · Trips:** toll/vignette hints (country entries) can be Phase 2 — keep MVP focused.
- **FM · Compliance:** v1 = eCMR vault + tacho download reminders + driver-file expiry alerts (license, CPC, medicals). eFTI automation when the 2027 deadline nears.
- **FM · Customers:** shipper portal + WhatsApp order intake are the *only* intake channels in v1 — no marketplace.
- **Customer portal:** WhatsApp-first (booking, tracking, POD delivery as chat messages + documents), portal as the deeper view. Languages: same locale set.
