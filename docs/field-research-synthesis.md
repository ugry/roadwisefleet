# RoadwiseFleet — Field Research Synthesis (Forums · Industry · Competitors)

**Status:** COMPLETE — all four streams landed and synthesized (2026-08-26).
**Streams:**
1. EU driver forums — [research-driver-forums-eu.md](research-driver-forums-eu.md)
2. Turkey trucking — [research-turkey-trucking.md](research-turkey-trucking.md)
3. Industry media & reports — [research-industry-media.md](research-industry-media.md)
4. Competitor deep-dive — [research-competitor-analysis.md](research-competitor-analysis.md)

---

## 1. The voice of the driver (forums) — DONE → [research-driver-forums-eu.md](research-driver-forums-eu.md)

Key findings (across EN/DE/PL/TR/RU/NL communities): **parking is the #1 complaint in every language** (EU ~390k-space deficit, ~1% secure, only 9% of drivers feel safe at stops) · unpaid, uncommunicated **waiting/detention** (only ~5% of micro-fleet waiting ever compensated) · **tacho/working-time fear** (Smart Tacho 2 fines up to €3,464 for non-faults) · pay/rate opacity + agency exploitation (blacklist groups like Dziad-Trans) · visa pain (Turkish 8-month Schengen waits, Balkan 90/180 days) · theft/gas attacks · loneliness. **Apps:** drivers *love* crowdsourced tools (a Facebook group is the best parking "app" in PL) and *hate* stale or surveilling corporate tools (Trucker Path 1-star reviews; telematics as "big brother"). **Surprises:** high wages don't fix the shortage (it's retention); tech often punishes drivers for non-faults; even "secure" lots aren't. **The 3 wins:** (1) real-time driver-fed parking + danger alerts + booking, (2) automatic waiting-time evidence → claims, (3) driver-side trip/pay transparency vs employer opacity.

## 2. Turkey & the TR–EU corridor — DONE → [research-turkey-trucking.md](research-turkey-trucking.md)

Key findings: record ~2.095M export truck trips in 2024 (UTİKAD/UND); ~1/3 of Turkish exports by road; 90h+ waits at Kapıkule; visa/Schengen friction severe (green-passport workaround); 4 of 10 trucks return empty; e-İrsaliye mandates through 2025 + e-CMR (41 countries, TR–AZ cooperation) = forced-digitization trigger; incumbents sell loads (Tırport) or parcels (Navlungo/KargomKolay), not a driver operational cockpit — the wedge is a driver-first Turkish Android app + cheap dispatcher SaaS for 1–20-truck hauliers.

## 3. What industry media & reports say — DONE → [research-industry-media.md](research-industry-media.md)

Key findings: EU road freight ≈ $497B; 89% SMEs, 98% of firms <50 employees. Bankruptcy wave (DE 23,900 in 2025 +8.3%, 10-yr peak; FR 809 Q2 2025 +13%; "10 companies disappear per working day", margins 2–3%). Driver shortage: 502k unfilled positions (13%), **15% vacancy at <50-employee firms vs 9% at large**, 660k retirements in 5 years. Costs outran rates (DE toll 34.8 c/km post-CO₂-toll, TCO +24% 2021–24); Spain 62-day payment terms; >20% empty truck-km. Regulatory triggers: Smart Tacho 2 done Aug 2025 · van tacho/posting rules 1 Jul 2026 · **eFTI enforcement 9 Jul 2027** (eCMR today <1% of ~280M ops). Digitalization reality: 61% of small carriers still on email/spreadsheets; only 29% have digital tools in core workflows. Contrarian: first-wave digital freight failed (Convoy, Instafreight, Flexport missed); freight is "surprisingly manual"; industry bodies prioritize policy over tech. **Verdict: the small-fleet driver shortage is the #1 problem — it drives margins, insolvencies, and empty miles, and it is the wedge every software sale must speak to.**

## 4. Competitors: who is chosen, and why — DONE → [research-competitor-analysis.md](research-competitor-analysis.md)

Key findings: **Trans.eu** is the incumbent to respect — €164/mo exchange + SmartMatch 1.3% + SafePay (99.8% on-time guarantee is their #1 "why choose" reason), 125k+ firms, >30% of EU freight claim, but user complaints on price/lock-in. **TIMOCOM** from €71.62/mo, 58k firms, "82% of offers allocated ≤15 min". **sennder**: free for carriers, 40k trucks, fast payments — but Trustpilot 2.9/5. **Qargo**: modern TMS, revenue-based pricing. **Telematics**: Webfleet 2.8–2.9/5 Trustpilot despite being the compliance standard (from ~£10/vehicle); Samsara $39/vehicle; Geotab $19.75 gov-pricing; Motive from $7/user; ABAX 4.1–4.2/5 loved by small fleets. **Turkey**: Tırport (100k+ trucks, yükCEPte driver app, Fibabanka-backed) is the real local champion; Navlungo is parcel e-commerce, not trucking (correction). **White space confirmed**: nobody combines driver-first offline Android + dispatch SaaS + tacho/eCMR + WhatsApp-native comms + payments at ~€10–25 flat per-truck, BYOD, PL/RO/TR/DE. **Risk**: Trans.eu then Webfleet. **Survival positioning**: refuse to compete on network; own the driver daily loop + dispatcher workflow at SME price, no hardware, no lock-in.

## 5. Cross-check notes (independent verification)

- Parking remains a live EU policy pain: safe/secure truck parking expansion is still an open European Parliament question ([QECR988307](https://politique.pappers.fr/question/the-need-to-speed-up-development-of-safe-and-secure-truck-parking-areas-across-the-road-network-QECR988307)) and Ti Insight covers the build-out ([ti-insight](https://ti-insight.com/briefs/europe-builds-safe-truck-parking-areas-to-tackle-driver-shortages/)).
- Michelin's Truckfly is the incumbent free truck-navigation/parking app in EU app stores ([App Store](https://apps.apple.com/ie/app/truckfly-truck-gps/id1050082939), [reviews](https://chrome-stats.com/d/com.truckfly.truckfly/reviews)).
- Trans.eu operates driver apps Loads2GO! and Loads4DRIVER — the load board has a driver surface already ([Play Store](https://play.google.com/store/apps/details?id=eu.trans.transexpress), [Play Store TR](https://play.google.com/store/apps/details?id=eu.trans.loads2do&hl=tr)).
- Turkish digital freight matching is its own market with local champions (Navlungo etc.) ([Research and Markets](https://www.researchandmarkets.com/reports/6105208/digital-freight-matching-market-in-turkey#1)).

## 6. What changes in the plan because of this research

1. **Parking is promoted from "More tab" to a P0 launch feature.** Every language community ranks it #1; the incumbent "apps" are a Facebook group and Truckfly. Our driver app ships with a **driver-fed parking layer** (availability votes, danger alerts, secure-lot booking where APIs exist — Bosch Secure Truck Parking / Truckfly partnerships) on day 1. This is the install-wedge for the driver app.
2. **Detention capture must be zero-tap.** Forums show drivers won't fight for waiting pay (only ~5% of micro-fleet waiting is compensated). Geofence auto-start + auto-generated claim draft (not a manual timer the driver must remember) — our design tightens from "tap to claim" to "claim arrives pre-filled".
3. **Anti-surveillance is a differentiation principle, not a footnote.** Drivers describe telematics as "big brother". RoadwiseFleet's GPS/data defaults must be driver-transparent: driver sees exactly what the dispatcher sees, location sharing is trip-scoped, and there is a visible off-duty mode. This is directly counter-positioned against Webfleet/Samsara, and it's a retention story backed by the 15%-small-fleet-vacancy statistic.
4. **The sale is retention, not efficiency.** Industry verdict: the #1 problem is the small-fleet driver shortage (15% vacancy vs 9% at large firms; 660k retirements). Every pitch, landing page, and feature must answer "how does this keep my drivers?". (Our landing copy already says this — now it's the whole product thesis, not just a section.)
5. **Turkey wedge confirmed and sharpened:** border-intelligence (Kapıkule/Hamzabeyli queue times, park sealing), e-İrsaliye/e-CMR capture, and driver pay tracking — timed to the 2025 e-İrsaliye mandate. Tırport owns loads; nobody owns the driver cockpit in Turkish.
6. **Competitive posture vs Trans.eu: partner, don't fight.** They win on network (SafePay, 125k firms) and we can never out-scale that in year 1. We win on the operations layer (driver daily loop + dispatcher workflow at ~€10–25/truck flat, BYOD, no lock-in) — and can later *surface Trans.eu loads inside our board* rather than building a rival exchange. Pricing anchors from research: Trans.eu €164/mo, TIMOCOM €71.62/mo, Webfleet ~£10/vehicle → our price band fits the gap between "free apps" and "enterprise".
7. **Compliance sells as convenience, not compliance.** eCMR adoption is <1% despite eFTI 2027 — carriers don't buy documents, they buy "photograph once, never retype". The eCMR/e-İrsaliye capture is the free by-product of the photo-once trip file, and that's how we pitch it.
8. **Privacy/consent and per-locale formats** move from nice-to-have to P0 (we collect driver location in the EU — GDPR Art. 9 concerns and driver trust depend on it).

## 7. Revised feature priorities & positioning

**Positioning (v3):** *"The driver-first operating layer for 1–20-truck EU & Turkish fleets — parking, paperwork, and pay handled from the driver's pocket; dispatch and compliance for the owner. BYOD, no lock-in, ~€10–25/truck."*

**Driver app P0 (launch):** Trips + status · **Parking layer** (crowdsourced availability, danger alerts, booking) · Documents (photo-once eCMR/e-İrsaliye) · **zero-tap detention capture** · Money ledger · WhatsApp-style dispatch chat · off-duty privacy mode.
**Driver app P1:** rest-time/tacho assistant · return-load offers · translation · SOS network.
**FM SaaS P0:** dispatch board + live map · trips + timeline · drivers (invite, files, scorecards) · customers + WhatsApp inbox · invoice draft from POD · API keys (public API v1).
**FM SaaS P1:** compliance vault + expiry calendar · vehicles · analytics · quick-pay (monetization phase).
**Turkey module P0/P1:** border queue intelligence · e-İrsaliye capture · TR-language app + dispatcher SaaS.

**Sequencing unchanged:** auth core → trips/dispatch → public API → GPS ingest → documents → WhatsApp bridge → (then Android build in parallel with FM SaaS). The free-phase trigger (10 fleets / 100 trips / 60% WAD) and the gap-analysis immediate fixes (email identity, privacy pages, backups) remain binding.
