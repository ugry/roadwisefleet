# RoadwiseFleet Connect — Company Load-Posting Flow Design Brief (for OpenDesign)

## What to build
One desktop web screen (1440×900, responsive down to 900px) — **the load-posting + offers screen** for a small company. Two columns: left = "Post a load" form; right = "Offers received" list. The promise of this screen: *post one load → verified offers within the hour*. Self-contained HTML file with working form validation, an add-stop button, and realistic offer cards in English.

## Brand (must follow exactly — RoadwiseFleet tokens)
- Deep navy app chrome (left sidebar) + light canvas; single safety-amber accent (primary CTA "Post load" + one status marker). Amber fills carry navy text.
- Type: Barlow Condensed for display/kickers, Inter for body. Flat cards, hairline borders, no gradients.

## Layout
1. **Left sidebar** (navy, 220px): "RoadwiseFleet Connect" mark · menu: Find trucks (active), Find drivers, Orders, Partners, Payments, Community · bottom: company chip "Asif Transport LLP · Verified".
2. **Top bar** (light): page title "Find trucks" + breadcrumb · right: notification bell (2), avatar.
3. **Left column — Post a load form**:
   - Route builder: Pickup (Wrocław, PL) → Delivery (Berlin, DE) with a "+ Add stop" button (adds a row — JS).
   - Cargo: "22 pallets · 18t · curtainsider required" (selects).
   - Dates: "Load ready: Fri 08:00 · Deliver by: Fri 20:00".
   - Price: "Suggested €760 (rate card)" with an editable input.
   - Documents required: checkboxes (eCMR · POD photo · Customs T1).
   - Primary button "Post load" (amber) — validates, then shows a success state: "Posted · Broadcasting to 214 verified drivers" with a pulsing indicator.
4. **Right column — Offers received (3 cards)**:
   - Card: driver name + verified badge + rating stars · truck specs (Curtainsider 24t) · current position ("Now in Poznań, 2h away") · price offer (€780) · one-line note ("Can load Thu evening") · buttons: Accept (amber, one card only) / Message (ghost).
   - One card marked "Best match" (amber corner tag).
5. **Below the form** (subtle): stats strip — "Your last 10 loads: 4.6★ avg offers in 42 min · 100% payment-guaranteed".

## Interactions (JS)
- "+ Add stop" appends a stop row; remove works.
- Post load validates empty fields, shows the broadcasting success state, and reveals a third offer card with a staggered entrance.
- Accept opens a confirm dialog state ("Award to Marta D. for €780?" → Confirm → card flips to 'Awarded' with navy check).

## Output
Single self-contained HTML file in the project directory. Real copy, realistic EUR amounts, no lorem ipsum.
