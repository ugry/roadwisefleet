# RoadwiseFleet Connect — Driver Beacon Screen Design Brief (for OpenDesign)

## What to build
One Android phone screen (portrait mockup, 390×844 CSS) — **the beacon screen**, the screen a solo truck driver uses to be *found* by load posters. This is the single most important screen in the Connect app: it turns "empty today" into "paid tomorrow". Self-contained HTML file with a realistic phone frame (status bar, notch), interactive toggle states, and honest copy in English.

## Brand (must follow exactly — RoadwiseFleet tokens)
- Deep navy base + single safety-amber accent (amber = one primary action + one status marker, never decorative).
- Type: Barlow Condensed for display/kickers, Inter for body. Flat cards, hairline borders, no gradients. Amber fills always carry navy text.
- Light cool-neutral canvas inside the app.

## Screen layout (top → bottom)
1. **App bar**: "RoadwiseFleet Connect" wordmark + driver name/avatar "Asif K." + verified badge (navy shield with amber check).
2. **Beacon card** (the hero): big status toggle — **"Empty & available"** (on, amber) / "Not available". Below it, the beacon itself:
   - "Now in: Lyon, FR" (location chip with pin icon)
   - "Heading to: Warsaw, PL" (editable destination)
   - "Available from: Today 18:00" (time chip)
   - Truck chip: "Curtainsider · 24t · ADR no"
   - Live mini-map strip: Lyon → Warsaw route line with truck marker.
3. **Matching offers** (section title "Matched for you — 3"): 2–3 load cards, each with route (Wrocław → Warsaw), price "€620", distance/ETA to pickup, company name + rating stars, and an amber "Accept" button on one card only (accent discipline).
4. **Quick stats row** (light): "Beacon views 14 · Offers 3 · Rating 4.8".
5. **Bottom nav** (5 items, navy): Loads · Beacon (active, amber dot) · Chat · Wallet · Community.

## Interactions
- The availability toggle switches the beacon card between on (amber glow, visible to companies) and off (muted gray, "Hidden from companies") — implement the state change in JS.
- Accept button shows a confirmation toast state ("Offer accepted — chat opened").
- All copy real, no lorem ipsum. EUR amounts realistic for PL/DE corridors (€500–€900).

## Output
Single self-contained HTML file in the project directory. Mobile-first; the phone frame centered on a light background.
