# RoadwiseFleet — Two-Version Product Design

**Status:** v1 complete — validated against similar-apps research ([research-freemium-marketplace-apps.md](research-freemium-marketplace-apps.md))
**Decision (founder, 2026-08-26):** two versions.
- **Version A — "RoadwiseFleet Connect" (freemium):** solo truck drivers + small companies find each other (loads ↔ trucks ↔ drivers), plus community mutual help.
- **Version B — "RoadwiseFleet Fleet" (the existing SaaS design):** companies running their own fleet (dispatch, compliance, documents) — menus already specified in [product-menu-plan.md](product-menu-plan.md).

Both share one backend, one auth, one trip object. A load accepted in Connect can be executed in Fleet; a Fleet company with an empty truck can offer capacity in Connect.

---

## 1. Version A — Connect (freemium marketplace + community)

### 1.1 Solo truck driver — Android app menus

| Tab | Functionalities |
|---|---|
| **Loads** (find work) | list + map of loads near me (filters: route, price, date, equipment) · saved searches with push alerts · return-load suggestions based on my position + heading · one-tap "Offer" (bid) or "Accept" · my offers status |
| **My truck** (sell capacity) | availability beacon — "empty in Lyon tonight, heading Warsaw" (the single most important screen for being *found*) · truck specs + documents (verified badge: license, insurance, TIN) · ratings & reviews I received |
| **Chat** | negotiation chat with companies (text/voice notes) · structured quote cards inside the chat · dispute thread archive |
| **Wallet** | accepted loads, payments with status · **guaranteed payment** (escrow — the trust layer) · my payout history |
| **Community** (help each other) | parking spot sharing (add/see real-time spots, like the Facebook group that already wins) · fuel price board · road/border alerts (incl. Kapıkule queue times) · "help nearby" — SOS to other drivers · driver Q&A |

### 1.2 Small company — web + mobile menus

| Menu | Functionalities |
|---|---|
| **Find trucks** | post a load (one form) → receive offers from verified drivers/companies → compare (price, rating, truck position, ETA) → award · or instant-match suggestion |
| **Find drivers** | for my own trucks: relief/recruit postings, verified profiles, availability calendar |
| **Orders** | my posted loads, offers per load, award/decline, live tracking of awarded loads |
| **Partners** | trusted carriers/drivers list, ratings given/received, subcontracting history |
| **Payments** | guaranteed payment (escrow) per load · disputes · invoices |
| **Community** | same mutual-help boards as drivers (parking, fuel, alerts) — companies post too |
| **Company profile** | fleet specs, verification badge, ratings, availability ("3 trucks empty in Poznań on Friday") |

### 1.3 Matching mechanics (the core loop)

1. **Beacons, not browsing.** Both sides declare availability ("empty here, heading there" / "load from A to B on date") — the system matches beacons to loads *before* anyone browses. This is the zero-effort magic that beat phone-call dispatch.
2. **Structured offers.** Chat is free-form, but quotes are cards (price, dates, equipment) — negotiation without chaos, and everything audit-able.
3. **Trust before money:** verification (license, insurance, TIN/company registry) → badge · two-way ratings after every load · **escrow-style guaranteed payment** (money reserved on award, released on POD) — the Trans.eu SafePay pattern, applied to solo drivers.
4. **Freemium split:** free = profile, beacon, N loads/month posting, browse, chat, basic payment. Premium (later) = unlimited posting, priority beacon boost, guaranteed-payment fee, verification package, return-load alerts. *(No pricing until the free phase succeeds — per the existing free-phase rule.)*

### 1.4 The "help each other" layer (community)

Parking sharing (the #1 driver need per our forum research) · fuel price board · road/border alerts (TR corridor) · SOS mutual aid · ratings of shippers/loading places. This layer is the install-wedge for solo drivers and costs us almost nothing — user-generated data with light moderation.

---

## 2. Version B — Fleet (unchanged, reference)

Full menus: [product-menu-plan.md](product-menu-plan.md) + solutions in [solutions-design.md](solutions-design.md). One amendment: Fleet companies get a **Connect toggle** — their empty trucks can publish beacons into the marketplace (capacity sales), and dispatchers can browse Connect loads when their own orders are thin.

---

## 3. Shared architecture (one system, two surfaces)

```
                    ┌─ Android app: solo driver mode (Connect)
One backend ────────┤
(auth · trips ·     ├─ Web dashboard: company mode (Fleet)
 matching · wallet) └─ Web portal: customer mode (existing)
```

- Same `Trip`, `Order`, `User`, `Org` models; new models for the marketplace: `LoadPosting`, `Offer`, `Beacon`, `Rating`, `Escrow/Payout`, `CommunityPost` (parking/fuel/alert).
- One status machine: a marketplace-awarded trip is a normal Trip with `source: connect|fleet|customer`.
- Trust graph (ratings + verification) is shared — a company's Fleet rating follows it into Connect.

## 4. What similar apps taught us (validated + corrections)

From [research-freemium-marketplace-apps.md](research-freemium-marketplace-apps.md) — 15 apps compared:
- **The menu pattern is confirmed** — the top-10 most common features across all apps (load board, mobile driver app, matching, verification, payment guarantee, ratings, tracking, messaging, pricing tools, e-docs/POD) map 1:1 onto our §1 menus. We are not inventing a category, we are bundling it better.
- **Trust architecture choice matters — there are exactly three:** (1) escrow/payment-guarantee on open exchanges (Trans.eu SafePay, 123cargo), (2) merchant-of-record broker (sennder, Uber Freight, Saloodo — they are the payer, carriers bill them), (3) closed verified-network + reputation (TIMOCOM). For Connect we pick **architecture 1 + 3**: open marketplace with verified badges AND guaranteed payment (no money-holding at launch — proof-of-payment + ratings first, escrow when rails allow).
- **Corrections:** SafePay/SmartMatch are Trans.eu features (TIMOCOM has AI-matching + Business Partner Check); Navlungo is e-commerce parcel (irrelevant); Cargonexx exited load matching (pivoted to WAVES compliance).
- **Community today is fragmented:** parking (Trucker Path, LKW.APP/aparkado, Truckfly), fuel boards, border-wait apps (BorderWatcher, Granica), SOS (Rescato) — all standalone, none tied to earning. **Bundling community with the load feed is the differentiation.**
- **The gap confirmed:** nobody offers freemium load board + guaranteed payment + community for solo drivers; the TR↔EU corridor has no trusted affordable marketplace at all.
- **Freemium pattern that works:** free for the liquidity side (drivers), demand side pays later (companies: subscription/commission); trust as a paid add-on; free utility (parking/fuel) converts to premium.

## 5. Open questions (founder) — with research-informed recommendations

1. **Escrow at launch?** → No. Payment *proof* + two-way ratings first; guaranteed-payment (escrow-style) added when regulated rails/partners are in place. sennder's broker model (we become merchant of record) is an alternative to consider later — it converts trust into a product but requires factoring capital.
2. **Which side first?** → Companies. 10–20 known small companies posting real loads pull solo drivers; loads are the scarce side. (Cold-start rule: seed the demand side.)
3. **Same app or separate?** → Same Android app, mode switch (driver mode / company mode / fleet mode). One download, one store ranking, shared trust graph.
