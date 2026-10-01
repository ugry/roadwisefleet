# RoadwiseFleet — End-to-End User Flow Design
**Date:** 2026-09-29 · **Author:** Adrian Cole (VP Products) · **Status:** design proposal for owner review

## What this is
Detailed, end-to-end flowcharts for the four user types of RoadwiseFleet, covering every
menu, decision point and exception path — including the new requirements:

1. **A customer can choose a fleet company OR a solo driver** (or let the platform match).
2. **Customers and small firms find each other** — a two-sided marketplace (**Hauling Market**,
   renamed to it per the owner decision of 2026-10-01) where demand posts loads and
   supply (fleets + solo drivers) declares capacity.
3. **Fleets and solo drivers also serve their own customers who are not registered** on the
   platform — lightweight records plus no-login share links.

## Diagrams
| File | What it shows |
|---|---|
| `00-platform-map.mmd` | The four personas, the surfaces, one shared backend, core rules |
| `01-customer-flow.mmd` | **Customer**: entry → register → book → choose fleet/solo → compare → award → track → POD → pay → rate → rebook |
| `02-fleet-manager-flow.mmd` | **Fleet Manager**: onboarding, all 11 menus in detail, marketplace buying/selling, off-platform customers |
| `03-driver-flow.mmd` | **Employed driver**: activation, 5 tabs, status taps, POD, money, exceptions |
| `04-solo-driver-flow.mmd` | **Solo driver**: signup + verification, beacon, job feed, bids, own customers, wallet, community |
| `05-marketplace-flow.mmd` | The matching engine: demand, supply, offer modes, award, escrow, off-platform bridge |
| `06-offplatform-customers.mmd` | Serving unregistered customers (fleet lane, solo lane, partner lane) and the guest link experience |
| `07-trip-state-machine.mmd` | Every trip status and exit: execution, financial close, exceptions, who may move what |
| `08-menus-overview.mmd` | One-page menu map of all four roles (v2 — menus keyed by account type; Fleet 12 items, Hauling Market + Billing and Plan) |
| `09-information-flow.mmd` | **Master information flow v2** — personas, surfaces, shared backbone, core rules and the 2026-10-01 owner decisions |
| `09-menus-v2.mmd` | Menu map v2 source (same content as `08-menus-overview.mmd`, kept under the #101 source name) |

## The core model (one sentence)
**A customer demand becomes an Order; whoever wins it — fleet or solo driver — turns it into
the same Trip object; every status change is an event that fans out to tracking, documents,
notifications and money.** The customer never re-enters the load; the carrier never re-types it.

## Key design decisions
1. **Supply choice is explicit and side-by-side.** The booking flow asks "how do you want to
   ship?" — find a fleet, find a solo driver, auto-match both, use my own saved carrier,
   recurring contract, or I have my own trucks (routes to Fleet Manager).
2. **Beacons before browsing.** Fleets publish empty-truck beacons; solo drivers flip an
   "empty & available" beacon. The engine matches beacons to loads and pushes both ways, so
   discovery works before anyone searches.
3. **Structured offers only.** Negotiation happens in chat but every quote is a card
   (price, dates, truck). Nothing is agreed verbally-only — that is the audit trail and the
   dispute evidence.
4. **Four ways to transact:** instant rate-card price (repeat lanes), open bidding,
   direct invite (first refusal for a favorite carrier), auto-match (rules: max price, min rating).
5. **Trust stack:** verification is **optional** — a driver profile shows ID / Licence /
   Registration **check marks** when the papers are supplied, and never blocks bidding (q5);
   two-sided reviews sampled **≤1 per 10 actions** (q3); payment per award is **carrier invoice
   OR platform escrow at 3%**, handling between parties is free (q1); credit terms for known
   customers.
6. **Off-platform customers are first-class — but read-only.** A fleet or solo driver adds a
   customer in 30 seconds and sends a **read-only** link by WhatsApp/SMS that carries tracking,
   POD and the invoice. The unregistered party needs no account and **cannot book through the
   link** (registration is mandatory, q3); every off-platform customer carries a conversion CTA.
7. **Off-platform partners too.** A fleet can subcontract to a partner driver who is not on
   the platform via a job-sheet link; if the partner joins later, history is preserved.
8. **Every exit is designed.** Cancellations, refused loads, breakdowns, customs holds,
   delays, claims and no-shows all have defined states, owners and money consequences.

## Trip status model (shared by all roles)
`DRAFT → CONFIRMED → (POSTED → OFFERS → AWARDED) → ASSIGNED → ACCEPTED → EN ROUTE PICKUP →
ARRIVED PICKUP → LOADED → IN TRANSIT → ARRIVED DELIVERY → DELIVERED → POD UPLOADED →
DOCS COMPLETE → INVOICED → PAID → DRIVER SETTLED → CLOSED`
Exits: `EXPIRED · CANCELLED · REFUSED · BREAKDOWN · DELAYED · CUSTOMS HOLD · DAMAGE CLAIM`.
Who may move what is written on diagram 07.

## Menu inventory (summary — full trees in diagram 08 / `09-menus-v2`)
- **Customer (7):** Book a load · Shipments · Documents · Payments (invoice OR escrow 3%) ·
  My carriers · **Reviews (sampled)** · Account.
- **Fleet Manager (12):** Dashboard · Dispatch · Trips · Drivers · Vehicles · Customers ·
  Compliance · Finance · Analytics · **Hauling Market** · **Billing and Plan** (trial, EUR 20/mo) ·
  Settings.
- **Driver (5 + SOS):** Trips · Documents · Money · Messages · More.
- **Solo driver (7):** Loads (Hauling Market feed) · My truck (beacon) · My customers ·
  Chat / Wallet · Community · **Verification check marks (ID / Licence / Registration)** ·
  **Reviews (two-way, ≤1 per 10)**.
- **Unregistered party:** no menu — a read-only link (tracking / POD / invoice / pay-link).

## Decisions in force (2026-10-01)
The owner answered the product questions the design depended on (Gitea `eila/tasks#73`,
Matrix `@ugur` 2026-10-01). These **supersede** the former "assumptions" list:

1. **Payments (q1)** — offer **both**: carrier invoice **and** platform **escrow at 3%**;
   handling between customers, fleets and solo drivers is **free**.
2. **Pricing (q2)** — escrow 3%; **fleet subscription EUR 20/month with a 1-month free trial**.
   The system **detects trial end and asks for payment** (no silent post-trial use).
3. **Registration (q3)** — **registration is mandatory; no guest booking.** Share links are
   **read-only** tracking. A **two-sided review system** is sampled randomly at **≤1 review per
   10 actions**, designed to be fair to both sides.
4. **Carrier of record (q4)** — the platform is **not** the carrier; the **contracted carrier**
   is carrier-of-record and its insurance applies. Comply where the law requires; otherwise
   **flexible, not mandatory**. Exact contract/insurance wording is still to be confirmed by counsel.
5. **Verification (q5)** — **optional**; a driver profile shows **check marks for
   ID / Licence / Registration** when supplied, and drivers without them **can still use the
   platform** (the hard bid gate was relaxed — board #96).
6. **Auto-match (q6)** — **no limits**: auto-match is enabled without a repeat-lane /
   known-carrier restriction (board #97).
7. **Public name (q7)** — the marketplace section is **Hauling Market**;
   the code/UI strings follow in board #100.
8. **Publish timing (q8)** — still open; retained for the owner.

Implementation owners: payments (#99), verification (#96), auto-match (#97), reviews (#98),
this design set (#101, extended by #110).

## Suggested build order (smallest complete slice first)
1. Trip object + status events + tracking link (already live as pilot).
2. Customer booking + choose supply + off-platform customer + link tracking (Fleet-serving).
3. Solo driver: signup + beacon + load feed + offer/accept + POD + escrow-lite (Hauling Market).
4. Fleet: capacity beacons + marketplace load browsing + subcontracting.
5. Ratings, disputes, analytics, auto-match.

## Files per diagram (in this repo)
`NAME.mmd` (source) and `NAME.svg` (rendered). Regenerate with the repo's mermaid tooling
(`tools/mermaid`), or on elilavps2 with `/usr/local/bin/eila-mermaid`. PNG / PDF / editable
`.excalidraw` builds of every diagram are kept alongside the owner's copy
(`~/eilaltd/roadwisefleet-flows/`) and can be added here on request.
