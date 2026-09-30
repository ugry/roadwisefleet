# RoadwiseFleet — UI/UX State Inventory

**Purpose:** the single answer to "what UI exists today, what menus/functions are defined, and how does information flow?"
**Legend:** 🟢 built (static artifact, live) · 🟡 designed (documented, no screen yet) · 🔴 not designed

**Live artifacts:** [roadwisefleet.com](https://roadwisefleet.com) · `/dashboard` · `/diagrams` · `/driver-beacon-screen.html` · `/connect-load-posting.html`

---

## 1. Surfaces at a glance

| Surface | Role | Status | Where |
|---|---|---|---|
| Marketing site | visitors | 🟢 built + live (waitlist wired to API) | `web/index.html` |
| Diagrams viewer | internal | 🟢 built + live (7 schemes) | `web/diagrams.html` |
| **Fleet dashboard** (web SaaS) | FM/owner/dispatcher | 🟡🟢 front page built; sub-screens designed | `web/dashboard.html` + `docs/product-menu-plan.md` §2 |
| **Connect driver app** (Android) | solo driver / employed driver | 🟡🟢 beacon screen built; 4 other tabs designed | `web/driver-beacon-screen.html` + `docs/product-two-versions.md` §1.1 |
| **Connect company web** | small company | 🟡🟢 load-posting screen built | `web/connect-load-posting.html` + §1.2 |
| Customer portal | shipper | 🟡 designed only | `docs/product-menu-plan.md` §3 |
| Registration & onboarding | all | 🔴 no screens (flows defined in spec §6) | `docs/product-spec-v1.md` |
| WhatsApp flows | customers | 🟡 designed (state machines pending) | `docs/solutions-design.md` #7, #9 |

---

## 2. Menu items & functions per surface

### 2.1 Marketing site 🟢
Nav (Product · Drivers · Fleets · Pricing) → hero → stats strip → problem → driver-app features → dashboard features → regional compliance strip → how-it-works → pricing teaser → **waitlist form** (email → `POST /api/waitlist`) → footer.

### 2.2 Fleet dashboard 🟢 front page / 🟡 rest
| Menu | Functions | Screen status |
|---|---|---|
| Dashboard | KPI cards (active trips, on-time, pending pay, empty miles) · live map · alerts strip | 🟢 built |
| Dispatch | drag load→driver · create trip · load offers · return-load matching | 🟡 designed |
| Trips | list/filters · timeline · detention log · trip P&L · invoice draft | 🟡 (table appears on built front page) |
| Drivers | files & expiry · scorecards · advances/settlements · invites | 🟡 |
| Customers | shipper directory · rates · order intake + WhatsApp inbox | 🟡 |
| Compliance | eCMR vault · tacho reminders · expiry calendar | 🟡 |
| Vehicles | registry · maintenance · toll tags | 🟡 |
| Finance-lite | receivables · manual settlements · expenses | 🟡 |
| Analytics | utilisation · empty-mile % · cost/km | 🟡 |
| Settings | users/roles · **API keys & webhooks** · language | 🟡 |

### 2.3 Connect — driver app 🟢 beacon / 🟡 rest
| Tab | Functions | Screen status |
|---|---|---|
| Loads | loads near me (map/list) · filters · saved-search alerts · return loads · offer/accept | 🟡 |
| **Beacon** | "Empty & available" toggle · location → heading · availability time · truck chip · route strip · matched loads · accept | 🟢 built |
| Chat | negotiation · structured quote cards · voice notes | 🟡 |
| Wallet | accepted loads · payment status · guaranteed payment · history | 🟡 |
| Community | parking sharing · fuel prices · road/border alerts · SOS · Q&A | 🟡 |

### 2.4 Connect — company web 🟢 posting / 🟡 rest
| Menu | Functions | Screen status |
|---|---|---|
| Find trucks | post load form (route + stops, cargo, dates, price, docs) · broadcasting state · offers list w/ best-match · award dialog | 🟢 built |
| Find drivers | relief/recruit postings · verified profiles | 🟡 |
| Orders | posted loads · offers · award · live tracking | 🟡 |
| Partners | trusted carriers · ratings · subcontracting history | 🟡 |
| Payments | payment guarantee per load · disputes | 🟡 |
| Community | same boards as drivers | 🟡 |
| Company profile | fleet specs · verification badge · availability beacons | 🟡 |

### 2.5 Customer portal 🟡
Book a load (saved addresses, instant quote) · Shipments (live map + ETA, timeline) · Documents (POD/eCMR) · Payments (P1) · Account (+ API keys for their ERP).

---

## 3. Information flow (what we actually have)

### 3.1 The spine: one trip lifecycle
`Customer books → FM dispatches → Driver executes → Customer tracks → POD → FM invoices → Customer pays → Driver settles`
Rendered as a sequence diagram in `docs/diagrams-data-menu-flow.md` §4 (+ SVG/PNG export), with the GPS ping loop and WhatsApp/portal fan-out.

### 3.2 Status state machine (the single source of truth)
`DRAFT → ASSIGNED → LOADED → IN_TRANSIT → DELIVERED → POD_UPLOADED → INVOICED → SETTLED` (exits: `CANCELLED`) — §7 of the same doc; every notification, filter and KPI derives from it.

### 3.3 Data model
`ORG → USER/TRUCK/CUSTOMER → ORDER → TRIP → {DOCUMENT, STATUS_EVENT, GPS_PING, EXPENSE, SETTLEMENT, TRIP_STOP, TRIP_DRIVER}` + `WHATSAPP_THREAD`, `GEOFENCE`, `RATE_CARD`, `API_KEY`, `WEBHOOK`, `AUDIT_LOG` — ER diagrams §5–6 (+ SVG/PNG) and `prisma/schema.prisma`.

### 3.4 Event fan-out (one event → many consumers)
| Event | Consumers |
|---|---|
| `trip.status_changed` | customer WhatsApp/portal · FM dashboard · webhooks · audit |
| `trip.delivered` | POD/eCMR render + send · invoice draft · webhook |
| geofence enter/exit | detention timer start/stop → claim line item |
| GPS batch | Timescale → live map · ETA · empty-truck flags → matching |

---

## 4. UX flows that exist as designed journeys

| # | Journey | Where defined | Screen exists? |
|---|---|---|---|
| 1 | Driver beacon → matched loads → accept → chat | two-versions §1.1, §1.3 | 🟢 beacon built |
| 2 | Company posts load → offers → award | §1.2, brief-connect-company-posting | 🟢 posting built |
| 3 | FM dispatch: load → driver → live board | solutions #11, menu plan §2 | 🟡 |
| 4 | Detention: geofence → timer → claim → invoice line | solutions #2, #14 | 🟡 |
| 5 | Documents: photo-once → POD → auto-invoice | solutions #1, #8, #14 | 🟡 |
| 6 | Customer tracking: portal map + WhatsApp milestones | solutions #7 | 🟡 |
| 7 | Registration: FM signup → verify → invite driver (SMS code + OTP) | spec §6 | 🔴 no screens |
| 8 | Owner-operator dual mode (driver tabs + Fleet tab) | critique C2 | 🔴 |

---

## 5. What is missing from the UI layer (honest gaps)

1. 🔴 **No interactive product UI** — everything shipped is static HTML mocks. React app and Android app are unbuilt (see `docs/gap-analysis.md`).
2. 🔴 **Registration/onboarding screens** — flows defined, zero visuals (and email infra still blocked).
3. 🔴 **Empty/loading/error states** across all screens; no first-run wizard for a new org, no driver first-trip tutorial.
4. 🔴 **Customer portal UI** — 5 menus designed, no wireframe at all.
5. 🔴 **Driver tabs 1, 3, 4, 5** (Loads, Chat, Wallet, Community) — designed, not drawn. Community/parking is the P0 install-wedge and has no screen.
6. 🟡 **FM sub-screens** (dispatch board, compliance vault, driver files) — designed in text only.
7. 🔴 **Product design system** — brand spec exists for marketing; no component/token system for the app UI.
8. 🔴 **Mobile FM view** — dispatchers on phones unaddressed.

## 6. Recommended next UI steps (in order)
1. **Driver: Loads + Community (parking) screens** — Loads is the "find work" counterpart to the built beacon; Community/parking is the P0 wedge.
2. **FM: Dispatch board screen** — the highest-value FM surface and the payer's daily home.
3. **Registration flow screens** (signup → verify → invite) — unblocks the whole funnel.
4. **Customer portal: Book a load** — the demand-side entry point.
5. Then the design system + empty/error states pass across everything.
