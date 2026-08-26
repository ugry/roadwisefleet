# RoadwiseFleet — SaaS Dashboard "Front Page" Design Brief (for OpenDesign)

## What to build
The front page of the RoadwiseFleet SaaS web app — the screen a fleet owner or dispatcher sees right after login. A dense, real, operational dashboard (not a marketing page). Self-contained HTML file with working interactions (tab switching, filters, hover states) and realistic sample data.

## Brand (must follow exactly — tokens from the RoadwiseFleet brand spec)
- Deep navy base + single safety-amber accent (amber only for the primary CTA and 1–2 key markers; never decorative).
- Type: Barlow Condensed for display numbers/kickers, Inter for UI body.
- Light cool-neutral canvas for the workspace, navy sidebar (or top bar) for app chrome.
- Flat cards, hairline borders, no gradients. Amber fills always carry navy text.

## Layout
1. **App shell**: left sidebar nav — Dispatch, Trips, Documents, Drivers, Compliance, Payments (icons + labels), company switcher "Asif Transport LLP", user chip at bottom. Top bar: search, notification bell with badge, "New trip" primary button.
2. **KPI row** (4 cards): Active trips 12 · On-time 94% · Pending pay €8.4k · Empty miles 18%.
3. **Main grid**:
   - **Live map card** (2/3 width): stylized route map (SVG roads, no external tiles) with truck markers (moving/en-route/loaded/delivering states) and tooltips.
   - **Dispatch board card** (1/3): "Drivers on the road" list — driver name, route, status pill, ETA, payout; click to select.
   - **Trip list card** (full width below): table of trips (id, driver, route, status, detention, documents, payout) with filter tabs All/En route/Delivering/Waiting.
   - **Alerts strip**: detention logged (1h 40m, Trip RWF-2048), document missing (e-way bill, Trip RWF-2049), empty truck returning (Marta, Porto).
4. **Interactions**: filter tabs work, driver rows selectable, status pills colored (amber only for attention states), responsive collapse to stacked cards under 900px.

## Sample data (realistic, mixed regions)
- A Asif K. — Rennes → Lyon — En route — ETA 21:15 — €1,240
- M Marta D. — Porto → Madrid — Loaded — ETA 07:30 — €980
- B Bruno S. — São Paulo → Santos — Delivering — 15:05 — R$2.1k
- P Priya N. — Mumbai → Pune — Waiting — — ₹18.4k
- T Tomasz W. — Wrocław → Berlin — En route — ETA 19:40 — €760
- D Diego R. — Guadalajara → Laredo — Delivering — 14:20 — $1,150

## Tone
Operational precision. No lorem ipsum, no placeholder gray boxes. Every control should feel like the real product.
