# RoadwiseFleet — End-to-End User Flow Design
**Date:** 2026-09-29 · **Author:** Adrian Cole (VP Products) · **Status:** design proposal for owner review

## What this is
Detailed, end-to-end flowcharts for the four user types of RoadwiseFleet, covering every
menu, decision point and exception path — including the new requirements:

1. **A customer can choose a fleet company OR a solo driver** (or let the platform match).
2. **Customers and small firms find each other** — a two-sided marketplace (Connect) where
   demand posts loads and supply (fleets + solo drivers) declares capacity.
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
| `08-menus-overview.mmd` | One-page menu map of all four roles |

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
5. **Trust stack:** document verification (ID, licence, insurance, company/TIN) → badge;
   two-way ratings after every load; escrow payment (reserved on award, released on POD) as
   the default for marketplace deals; credit terms for known customers.
6. **Off-platform customers are first-class.** A fleet or solo driver adds a customer in
   30 seconds, sends a tracking link by WhatsApp/SMS, delivers POD + invoice through the same
   link. The customer needs no account. Every off-platform customer carries a conversion CTA.
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

## Menu inventory (summary — full trees in diagram 08)
- **Customer (7):** Book a load · Shipments · Documents · Payments · My carriers · Account · Support.
- **Fleet Manager (11):** Dashboard · Dispatch · Trips · Drivers · Vehicles · Customers ·
  Compliance · Finance · Analytics · Connect · Settings.
- **Driver (5 + SOS):** Trips · Documents · Money · Messages · More.
- **Solo driver (6):** Loads · My truck (beacon) · My customers · Chat · Wallet · Community.

## Assumptions the owner should confirm
1. **Merchant-of-record for escrow:** does RoadwiseFleet hold funds (payment institution /
   partner like Trans.eu SafePay) or act only as a pass-through with the carrier invoicing?
2. **Commission model:** free during the growth phase (current decision); later per-truck SaaS,
   per-load fee and/or escrow fee. The flows show the hooks, not prices.
3. **Guest booking:** can an unregistered shipper book, or only track? (Design shows track
   freely, booking requires a 2-minute account; WhatsApp can create a minimal account.)
4. **Subcontracted jobs:** who is the carrier of record and whose insurance covers a
   subcontracted load — the awarding fleet or the executing partner?
5. **Verification strictness:** minimum documents to bid (ID + licence + insurance), and
   whether ADR/reefer capability must be document-verified before matching.
6. **Auto-match limits:** whether auto-award is allowed for first-time pairings or only for
   repeat lanes / high-rating partners.

## Suggested build order (smallest complete slice first)
1. Trip object + status events + tracking link (already live as pilot).
2. Customer booking + choose supply + off-platform customer + link tracking (Fleet-serving).
3. Solo driver: signup + beacon + load feed + offer/accept + POD + escrow-lite (Connect).
4. Fleet: capacity beacons + marketplace load browsing + subcontracting.
5. Ratings, disputes, analytics, auto-match.

## Files per diagram (in this repo)
`NAME.mmd` (source) and `NAME.svg` (rendered). Regenerate with the repo's mermaid tooling
(`tools/mermaid`), or on elilavps2 with `/usr/local/bin/eila-mermaid`. PNG / PDF / editable
`.excalidraw` builds of every diagram are kept alongside the owner's copy
(`~/eilaltd/roadwisefleet-flows/`) and can be added here on request.
