# Competitor company evidence — registry & financial filings

**Date:** 2026-09-23 · **Author:** Victor Nolan (Team Leader / Overseer)
**Question answered (owner, Matrix 07:08 UTC):** *"Based on what evidence? Check company details — how much tax they have paid, how many employees they have, find me biggest players. Come with evidence."*

**Method:** primary filings only. SEC EDGAR XBRL for US-listed companies; UK Companies House (HTML filing history + the filed statutory accounts PDF, OCR'd where the scan carried no text layer); Norwegian Brønnøysund Register Centre (Regnskapsregisteret JSON API); Polish KRS. Company/press material is labelled as such and never used for a number where a filing exists.

**Definition used for "tax paid":** the income-tax charge in the entity's own statutory accounts (P&L "tax on result" / "income tax expense"). This is the tax *expense recognised*, which can differ from cash tax paid in a year (deferred tax, timing). Labelled per row.

---

## 1. Hard, filing-based evidence

| Company (legal entity) | Country / ID | Fiscal year | Revenue | Tax (income tax charge) | Result | Employees | Source (filed) |
|---|---|---|---|---|---|---|---|
| **Trimble Inc.** — owns **Transporeon** | US, NASDAQ:TRMB, CIK 0000864749 | FY2025 (ended 2026-01-02) | **$3,587.3 M** | **$85.4 M** income tax expense | net income **$424.0 M** | **11,500** (end 2025) | SEC 10-K, accession 0000864749-26-000015, filed 2026-02-25 |
| **Samsara Inc.** | US, NYSE:IOT, CIK 0001642896 | FY2026 (ended 2026-01-31) | **$1,618.6 M** | **$10.0 M** income tax expense | net **−$9.1 M** | **4,100** (2026-01-31) | SEC 10-K, accession 0001628280-26-018167, filed 2026-03-16 |
| **Webfleet Solutions Sales B.V.** (Bridgestone Mobility Solutions; TomTom Telematics until 2019) | NL, KVK Amsterdam 60077972; UK CH **FC031857** | FY2024 | **€164.9 M** net turnover | **€2.32 M** "tax on result" | net result **€4.50 M** (PBT €6.82 M) | **268** (171 outside NL) | Dutch statutory accounts filed with Companies House, 01-05-2026 (38 pp., scanned; OCR) |
| **ABAX AS** (operating co., Larvik) | NO, org **993098736** | FY2025 | **NOK 514.1 M** (~€44 M) operating revenue | **~NOK 21.4 M** (implied: PBT − net) | net **NOK 79.8 M** | not disclosed | Brønnøysund Regnskapsregisteret, receipt 2026654779 |
| **ABAX GROUP AS** (holding, Larvik) | NO, org **918965556** | FY2025 | — (holding) | — | net **NOK 27.4 M** | not disclosed | Brønnøysund Regnskapsregisteret |

Notes:
- Trimble acquired Transporeon in 2023; Transporeon no longer files separately, so Trimble's group 10-K is the only audited number for that business.
- Webfleet's Dutch sales entity is a distributor for the Bridgestone group; ultimate parent is **Bridgestone Corporation, Japan** (listed, TYO:5108). Group-level Bridgestone FY2023: revenue **¥4.11 T**, **129,262 employees** (Bridgestone annual report, as summarised on Wikipedia — group figure, not the fleet-SaaS business).
- ABAX's tax figure is *derived* (pre-tax result minus net result); the Norwegian filing did not expose a separate tax line.

## 2. What the companies say about themselves (own sites / own documents — no financials)

| Company | Claim | Source |
|---|---|---|
| **sennder** (sennder Technologies GmbH, Berlin, HRB 170455 B) | **>1,000 employees**, >73 nationalities, **>40,000 connected trucks**, **>1M FTL shipments/yr**, founded 2015 | sennder own "Company Facts & Figures" fact sheet, July 2024 (PDF) |
| **TIMOCOM** (TIMOCOM GmbH, Erkrath, HRB 34489 Düsseldorf) | **>58,000 verified companies**, up to ~1M freight/vehicle offers per day, 40 countries; **~690 employees** | timocom.com (network stats are JS template values); employee count from company/press statements — see §4 |
| **Tırport** (Turkey) | 100,000+ individual trucks, 10+ countries, 7 languages | Turkish tech press (bütünhaber / turk-internet) |
| **Trans.eu Group S.A.** (Poland, KRS **0000720763**, NIP 8942764658, REGON 932920615, Wrocław) | revenue **263.9 M PLN** (~€62 M) in 2024 | KRS-derived aggregator (rejestr.io). **Not primary-verified** — see §4 |

## 3. Not publicly available (and why)

| Company | Status of financials |
|---|---|
| **Geotab** (Canada) | Private. Its UK entity (GEOTAB (UK) LTD, 07330540) files **total-exemption accounts — no P&L, no tax line**. No public group financials. |
| **Motive** (US, ex-KeepTruckin) | Private. No audited public financials. |
| **Transporeon** | No longer files separately (absorbed into Trimble). |
| **sennder** | German GmbH; no revenue figure in its own fact sheet and not retrievable from the Bundesanzeiger from here. |
| **TIMOCOM** | German GmbH; revenue behind Bundesanzeiger/northdata paywall. |
| **Tırport** | Turkey: MERSIS/trade-registry financials are not published on the open web. |
| **Qargo** (Belgium), **123cargo** (operated by **DacodaSoft SRL**, Romania) | Small private EU entities; no financials retrieved. |
| **Saloodo!** (DHL) | Part of Deutsche Post DHL Group; discontinued European services (2026). |
| **Cargonexx** | Out of business — domain no longer resolves. |

## 4. Honest limitations of this evidence

1. **"Tax paid" is only public for the US-listed and a handful of registry-filed entities.** Trimble, Samsara (SEC) and Webfleet (Dutch accounts filed in the UK) are the only competitors here where a tax number can be quoted from a filed document. For Geotab, Motive, TIMOCOM, sennder, Tırport, Trans.eu and 123cargo no tax figure exists publicly — quoting one would be invention.
2. **Tax *expense* ≠ cash tax paid.** SEC/statutory "income tax expense" includes deferred tax; cash tax paid appears only in the tax footnote and can differ materially.
3. **Trans.eu revenue (263.9 M PLN) is aggregator-derived**, not read from the filed statement; the official Polish financial-statements portal (rdf-przegladarka.ms.gov.pl) is behind an anti-bot layer from this infrastructure. Treat as indicative until verified from MSiG/eKRS.
4. **Bridgestone ¥4.11 T is a group figure** for a tyre conglomerate, not Webfleet's market. For the fleet-SaaS comparison use Webfleet Sales B.V. (€164.9 M) or Bridgestone Mobility Solutions.
5. Currency conversions are approximate and dated: NOK→EUR ≈ 0.086; PLN→EUR ≈ 0.235; JPY→USD ≈ 1/145.

## 5. Biggest players — ranked

**By verifiable (filed) revenue in the trucking/fleet-tech space:**

| # | Player | Filed revenue | Scope |
|---|---|---|---|
| 1 | **Trimble** (Transporeon) | **$3.59 B** FY2025 | group; TMS/visibility |
| 2 | **Samsara** | **$1.62 B** FY2026 | pure-play telematics/IoT |
| 3 | **Bridgestone / Webfleet** | group **¥4.11 T**; Webfleet Sales B.V. **€164.9 M** FY2024 | group vs fleet-SaaS arm |
| 4 | **ABAX** | **NOK 514 M** (~€44 M) FY2025 | telematics (Nordics/EU) |
| 5 | **Trans.eu Group** | **263.9 M PLN** (~€62 M) 2024 *(indicative)* | CEE freight exchange |
| — | **sennder** | not disclosed; **>1,000 employees, >40,000 trucks** | Europe's largest digital forwarder by network |
| — | **TIMOCOM** | not disclosed; **>58,000 companies, ~690 employees** | DACH/CEE freight exchange |
| — | **Geotab / Motive** | not disclosed | telematics (NA-led) |

**Reading of the field:** the two clear *financial* heavyweights among direct players are **Trimble** (owns Transporeon) and **Samsara** — the only ones whose scale is audited and public. **sennder** and **TIMOCOM** are the biggest by *network*, **Trans.eu** by CEE density. Everyone else in the set is private and materially smaller, or a subsidiary of a non-fleet conglomerate (Bridgestone).

---

*No credentials, tokens or PII are contained in this document. All figures are as filed on the dates cited; revenue/tax/employee counts are the entity's own reported numbers, not estimates, except where explicitly marked derived or indicative.*
