# Trimble vs. Samsara — product landscape brief (2026-09-23)

Requested by the owner (Matrix, EILA General) on 2026-09-23: *"Gather details about Trimble
and Samsara products — advantages, functions, menu items, capabilities."*

Method: every claim below is read from the vendor's own public site **today** (2026-09-23), the
Samsara Help Center, or the earlier filing-based evidence file
(`reports/competitor-company-evidence-20260923.md`, SEC EDGAR 10-K + registry filings).
Nothing here is inferred from third-party blogs. No pricing is quoted: both vendors publish
**no list prices** (all "Get pricing" / "Get in touch"); the telematics per-vehicle figures that
circulate online are third-party estimates (see `reports/competitor-site-verification-20260922.md`).

Company scale (already verified from filings, repeated for context):
| | Trimble Inc. (TRMB) | Samsara Inc. (IOT) |
| --- | --- | --- |
| FY revenue | **$3,587.3 M** (FY2025) | **$1,618.6 M** (FY2026) |
| Income-tax expense | $85.4 M | $10.0 M |
| Employees | 11,500 | 4,100 |
| Filing | 10-K acc. 0000864749-26-000015 | 10-K acc. 0001628280-26-018167 |

---

## 1. Trimble Transportation

Source: `transportation.trimble.com` (fetched 2026-09-23). Trimble is an enterprise
TMS / supply-chain software house that also owns **Transporeon** (EU freight platform) and
**Trimble Maps** (PC*Miler commercial map data). It is *not* primarily a hardware-telematics
vendor, and it does not sell a self-serve product.

### 1.1 Product categories and named products (public navigation, today)

| Category | Products | Function |
| --- | --- | --- |
| **Transportation Management** | TruckMate (LTL/intermodal/complex carriers), TMW.Suite (enterprise truckload, brokers/3PL, private fleets), Fuel Dispatch (fuel delivery: degree-day inventory forecasting, automated load building, Tandem Concepts credit validation), TMS for Carriers (AI order entry + dispatch, tender "financial viability" grading, EDI/ELD/accounting integrations), TMS for Shippers (cloud-native, AI/ML, analytics) | Order-to-cash TMS: order entry, dispatch, settlements, billing, margin management |
| **Mapping & Routing** | PC*Miler (mileage/route planning, predictive traffic, weather alerts, HOS planning), CoPilot (in-cab truck-legal navigation: dimensions, load restrictions, speed limits), Appian (route optimisation, what-if modelling), Weather Intelligence, Smart Workflow, Trimble Places (location data), developer APIs (developer.trimblemaps.com) | Commercial-grade routing, mileage and navigation |
| **Asset Maintenance** | TMT Fleet Maintenance (VRMS, PM scheduling, DVIR → work orders, warranty recovery, parts inventory, engine diagnostics, cost analytics), TMT Service Center (shop billing + profit optimisation) | Fleet maintenance / shop management |
| **Planning & Execution** (Transporeon heritage) | Transport Assignment (no-touch carrier allocation, AI Transport Planner), Freight Visibility (ETAs, proactive alerts), Rate Management, Surcharge Management | Freight assignment, ETA visibility |
| **Sourcing & Settlement** | Freight sourcing/procurement, market-rate visibility, freight audit | Procurement + audit/settlement |
| **Dock & Yard Optimization** | Dock scheduling, trailer/asset visibility on premises | Yard and dock scheduling |
| **AI** | **Trimble Arc Agent** | Single governed AI agent with a skill catalogue |

### 1.2 Trimble Arc Agent (their AI play)
- One agent, not many: a **catalogue of ready-to-use skills** — Order Entry, Contract Intake,
  Customer Support, Personal assistant — plus **code-free custom skill building**.
- Model: **Ask → Act → Escalate**; actions run inside the customer's rules, rates and role
  permissions; every action logged; human approves anything outside scope.
- Works across Trimble TMS, TMW.Suite, TruckMate, Transporeon and the Enterprise/Forestry
  divisions; skills must be tested before deployment.

### 1.3 Public "menu items" (website)
Solutions → *Transportation Management, Mapping & Routing, Asset Maintenance, Planning &
Execution, Sourcing & Settlement, Dock & Yard Optimization*; Who we serve → *Carriers, Shippers,
Service Centers, 3PLs & Brokers*; AI → *Trimble Arc, AI Solutions*; Resources; Partners &
Developers.
> **Gap:** Trimble's **in-product menu structure is not public** — end-user product docs sit
> behind a login (`learn.transportation.trimble.com`). Only product/category-level detail is
> verifiable from outside. Flagged, not guessed.

### 1.4 Advantages (vendor-claimed, where quantified)
- Depth of TMS: order-to-cash, settlements, accounting, fuel tax (Vusion), maintenance, yard —
  one ecosystem; "60% of the top 200 US carriers" use a Trimble TMS; 5% empty-mile reduction.
- **PC*Miler is the de-facto mileage/routing standard**; truck-legal data is its moat.
- Scale: $60 B freight spend managed, **1,000,000 trucks connected globally**.
- Transporeon EU metrics: **80% fewer check calls, 13% fewer empty truck runs** (Transporeon
  user data, EU market; vendor states NA results may differ).
- Audit-grade, governed AI (Arc) rather than a generic chatbot.

### 1.5 Weaknesses relevant to us
- Enterprise-only: long implementations, quote-only pricing, no self-serve/SMB funnel.
- Heavy TMS-shaped UI, back-office-centric; **no driver-first EU operator flow**
  (no WhatsApp-native dispatch, no eCMR-first document flow surfaced).
- In-cab/ELD hardware lineage (PeopleNet/TripNet/Video Intelligence) **does not appear in the
  current transportation navigation** — worth a separate check if ELD matters to us.

---

## 2. Samsara

Source: `samsara.com/products`, `samsara.com/resources/plans`, Samsara Help Center
(fetched 2026-09-23). Samsara is a **hardware + cloud telematics/IoT platform** ("Connected
Operations"): vehicle gateways, dash cams, asset tags, sensors, with a single dashboard.

### 2.1 Product families (public navigation, today)

| Pillar | Products | Function |
| --- | --- | --- |
| **Cameras & Video** | AI Multicam (up to 4 HD cameras, 360°, in-cab monitor alerts), Drowsiness Detection, Site Visibility, Safety ROI calculator | AI dash cams, in-cab alerts, site security, driver exoneration |
| **Fleet Telematics** | GPS Fleet Tracking, Routing & Dispatch, Commercial Navigation (vehicle restrictions + HOS in one tool), ELD Compliance (FMCSA-approved, built-in WiFi hotspot), Electric Vehicles, Fuel & Energy | Real-time GPS, routing, fuel, compliance |
| **Equipment Management** | Maintenance (work orders, AI invoice scanning, AI fault-code intelligence), DVIR, Trailer Tracking, Asset Tracking, Asset Tag (AT11/12/13), Reefer Monitoring | Diagnostics, maintenance, asset location |
| **Workforce Management** | Samsara Apps (Driver App: HOS, DVIR, IFTA), Driver Coaching, Connected Training (AI course creation), Driver Assignment, Samsara Wearable (site worker safety), Safety Reporting & Insights | Driver + worker apps, coaching, training |
| **Platform** | Incident Center, Connected Workflows (digital forms), Reports & Alerts, **Agent Studio** (build/monitor AI chat + voice agents), Ground Intelligence (road-surface defects from dash cams), MEM (mobile device management), Tracking Label, Satellite connectivity, FirstNet | Open platform, workflows, agentic AI |
| **Data & Integrations** | OEM integrations, App Marketplace (**350+ integrations**), open API + webhooks, Experts Marketplace | Integration ecosystem |

### 2.2 In-app menu items (verbatim, Samsara Help Center "Dashboard Menus", updated 2026-09-02)

Left-hand dashboard menu: **Overview, Workforce, Safety, Compliance, Maintenance, Dispatch,
Incident Center, Fuel & Energy, Documents, Training, Reports, Workflows, Issues, Agent Studio,
MEM Overview, Ground Intelligence.**
- Overview = current location/status of drivers and assets.
- Menus appear "depending on your organization's licenses and your user role" (e.g. Maintenance
  requires a Maintenance licence). This is the clearest public statement of Samsara's module
  packaging inside the product.

### 2.3 Packaging (public plans page)
Safety Premier / Safety Enterprise; Telematics Premier / Telematics Enterprise; Standard
Visibility; Advanced Tracking. Every tier says **"Get pricing"** — no list price. (Premier vs
Enterprise is functional, not seat-based: e.g. Enterprise adds 30+ risk detections with context
and patterns, weather risk, AI fuel-lifecycle insights, TMS integrations.)

### 2.4 Advantages (vendor-claimed)
- One integrated platform, **all hardware in-house** (no third-party components), single data set.
- Video-first AI safety: 30+ risk detections, in-cab coaching/nudges, drowsiness detection,
  driver exoneration, incident workflow.
- Largest integration ecosystem (350+ apps) + open API/webhooks; OEM factory-fit options.
- Agentic AI already shipping: Agent Studio (chat/voice agents), driver voice support,
  Ground Intelligence.
- Customer logos: DHL, Sysco, Estes, Home Depot, Ecolab, Sunrun, City of Denver; ROI claims
  (Liberty Energy 50% fewer accidents, DHL 50% lower driver attrition, Primoris $2 M insurance
  savings — vendor-reported).

### 2.5 Weaknesses relevant to us
- **Hardware-dependent and per-vehicle subscription**; opaque quote-only pricing.
- North-America-centric compliance framing (FMCSA/ELD, IFTA, DOT) — EU SME fit is secondary.
- Optimised for fleets that install telematics; **no zero-hardware path**, and no EU
  eCMR/paperwork-first flow.
- Feature surface aimed at safety/compliance departments, heavier than an SME operator needs.

---

## 3. Do we compete with them?

| Dimension | Trimble | Samsara | RoadWiseFleet |
| --- | --- | --- | --- |
| Core proposition | Enterprise TMS + supply-chain suite | Telematics/IoT + video safety platform | Driver-first ops layer (WhatsApp dispatch, eCMR documents) |
| Hardware | None needed | Required (gateways/cams/tags) | **None** |
| Pricing | Quote-only, enterprise | Quote-only, per-vehicle | Published, SME-sized |
| Onboarding | Long implementation | Install + config | Self-serve |
| EU fit | Strong in freight procurement (Transporeon), TMS-heavy | US compliance framing first | **EU compliance + eCMR native** |
| AI | Arc Agent (governed, skill catalogue) | Agent Studio + camera AI | Task-focused automation |

**Read:** we are not head-to-head with either. Trimble owns the enterprise TMS/order-to-cash
layer and the routing data (PC*Miler); Samsara owns the hardware telematics/video layer. The gap
RoadWiseFleet fills is unchanged and slightly sharper: **no hardware, published price, EU-first
document flow, and a driver/WhatsApp-native surface** — while both incumbents stay quote-only
and implementation-heavy.

---

## 4. Evidence and limits
- Vendors' own sites, fetched 2026-09-23: `transportation.trimble.com` (home, transportation-
  management, mapping-and-routing, fleet-maintenance, execution-visibility, arc-ai-agent);
  `samsara.com/products`, `/resources/plans`, and `kb.samsara.com` ("Dashboard Menus",
  updated 2026-09-02).
- Company financials: SEC EDGAR 10-K (see `reports/competitor-company-evidence-20260923.md`).
- **Not public / not verifiable:** list prices (both), Samsara per-vehicle rates, Trimble
  in-product menu structure (login-gated KB), Trimble's current in-cab/ELD product line.
- No credentials, tokens or PII in this file.
