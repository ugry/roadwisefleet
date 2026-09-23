# Competitor websites — direct verification, one by one (2026-09-23)

Companion evidence file for [research-competitor-analysis.md](./research-competitor-analysis.md). The
analysis was written 2026-08 from vendor sites plus third-party reviews; this file records what each
vendor's **own domain** returned when fetched again on **2026-09-23**.

**Method:** each vendor's own domain fetched from EILA infrastructure (direct HTTP with a real browser
user-agent, headless Chromium where the page is JS-rendered, DNS-over-HTTPS for the domain checks).
Third-party pages (Trustpilot, aggregators) are *not* the evidence here. Where a vendor blocks
automated access or publishes no pricing, that is stated as such — blocked/unknown is a valid result.

## Verdict in one line

The doc's **strategic** read still holds. Three vendor descriptions are wrong and are now corrected in
the analysis: **Saloodo! has discontinued its services in Europe**, **Cargonexx is out of business**
(domain dead), and **123cargo is an RO/BG exchange, not Dutch/Benelux**. The per-vehicle telematics
prices are **third-party estimates** — none of those vendors publishes a price. Two vendors
(**Trans.eu**, **Tırport**) block our infrastructure, so their claims remain unverified from here.

## Per-vendor results

| # | Vendor | Site status | Result |
|---|---|---|---|
| 1 | **Trans.eu** | **HTTP 403 from our infrastructure** (browser UA, Googlebot UA and headless Chromium alike) | **Could not verify directly.** The 125k+ firms / >30% of EU freight / SafePay 99.8% / €164-per-month claims are vendor/third-party sourced and unre-checked. Loads4DRIVER app confirmed to exist (Google Play). Needs a normal browser network. |
| 2 | **TIMOCOM** | Live | **Confirmed**: "more than 58,000 verified customers … up to 1,000,000 international freight and vehicle space offers daily"; PL blog confirms €71.62 / €5.88. **Correction:** its company page says **40 countries / 690 employees** — the "46 countries" in the doc is not on the site. |
| 3 | **Transporeon** | Live | Confirmed — "the newest member of the Trimble family". |
| 4 | **sennder** | Live | Confirmed: 40,000+ vetted carriers, platform free for carriers; site now advertises **50,000+ loads/month** (the doc's 1M+/yr comes from the 2024 fact sheet). |
| 5 | **Cargonexx** | **DEAD** — `cargonexx.com` no longer resolves (nameservers REFUSED); `cargonexx.de` 301s into the dead host | **Out of the market.** Every cited URL is unreachable; the last web-archive capture (2026-09-01) is a transport-management platform, not the WAVES/compliance story. Removed from the competitor set. |
| 6 | **Saloodo! (DHL)** | Live, but Europe closed | **Discontinued in Europe** — the site says verbatim *"we have discontinued our services in Europe"* and points European shippers to DHL Freight's quotation tool. MEA only now. Removed from the EU competitor set. |
| 7 | **123cargo** | Live | **Corrected**: EN/RO/BG site with Romanian-market tooling (ANAF checks, BursaTransport); no Benelux-specific content. Not a Dutch/Benelux exchange. |
| 8 | **Qargo** | Live | Pricing model confirmed ("no per-user fees", revenue-tailored, quote). Qi AI confirmed. Driver app and "100+ integrations" **not** confirmed on the pages checked. |
| 9 | **Turvo** | Live | Confirmed — collaborative TMS for 3PLs/brokers/shippers; no public pricing. |
| 10 | **Tırport** | **Cloudflare bot challenge** on `tirport.com` | **Could not verify directly** — needs a browser session from a normal network. |
| 11 | **Navlungo** | Live | Confirmed — Turkish international parcels/e-commerce, not a trucking load platform. |
| 12 | **Yolda.com** | Live, redirects to `muratlojistik.com.tr` | Confirmed — now the acquirer's site. |
| 13 | **Webfleet (Bridgestone)** | Live | Compliance + driver app confirmed; **no public price** — "~£10/vehicle" is third-party. |
| 14 | **Samsara** | Live | **No pricing on samsara.com** — the $39/$94 figures are third-party (source is a hobby aggregator). |
| 15 | **Motive** | Live | **No pricing on the site** — $7–129 third-party. Product/existence confirmed. |
| 16 | **Geotab** | Live | **No pricing on the site**; the "5.8M subscriptions / 1M+ EMEA" figures were **not found** on the public pages checked → need a citable source or removal. |
| 17 | **ABAX** | Live | Confirmed (SME tracking focus); no per-vehicle figure published. |
| 18 | **Trimble** | Live | Confirmed — enterprise layer, Transporeon part of Trimble. |
| 19 | **Trucker Path (EU)** | Live (EU app exists on Google Play) | App confirmed. The US site has since grown into load board + TMS + brokerage, so the doc's "utility only" line may no longer hold for the US product. |

## What changes for us

1. **Competitor set:** drop Saloodo! (left Europe) and Cargonexx (dead) from the active EU set;
   reclassify 123cargo as RO/BG.
2. **Pricing claims:** label the telematics per-vehicle figures as third-party estimates; do not use
   them externally without a primary source. Drop or source the Geotab subscription count.
3. **Re-check from a normal browser network:** Trans.eu and Tırport — everything in the Trans.eu
   section is currently unverified from EILA infrastructure.
4. **Strategy unchanged:** the driver-first operations layer + WhatsApp-native chat + eCMR/photo-POD at
   a flat SME per-truck price with no hardware remains the white space; with Saloodo! gone it is
   marginally wider, and the one to fear is still Trans.eu (network + SafePay + eCMR + driver app).

*No credentials, tokens or PII in this file.*
