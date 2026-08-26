# RoadwiseFleet — European Road Freight / Trucking Market Research

**Scope:** EU-27, UK, Turkey · **Data window:** 2023–2025 · **Prepared for:** roadwisefleet.com
**Use:** input to product strategy for the Android driver app + SaaS fleet dashboard.

---

## 1. Market overview

**Size & volumes.** Road freight is the backbone of European goods transport — roughly 75% of all inland freight in the EU moves by road ([Eurostat road freight statistics](https://ec.europa.eu/eurostat/statistics-explained/SEPDF/cache/9217.pdf)). EU-27 road freight volumes grew a modest ~0.6% in 2024 to record levels, driven by international haulage while domestic traffic stagnated ([Eurostat via Cyprus Mail](https://www.cyprus-mail.com/2025/07/16/eu-road-freight-volumes-grow-slightly-in-2024), [Format Research on Eurostat 2024](https://www.formatresearch.com/es/2025/07/09/El-transporte-de-mercanc%C3%ADas-por-carretera-en-la-UE-en-2024-Eurostat/#1)). The EU fleet is roughly **6 million+ trucks (>3.5 t)** ([Eurostat vehicle characteristics](https://ec.europa.eu/eurostat/statistics-explained/SEPDF/cache/11716.pdf)); 2023 truck registrations in Europe jumped ~16% on pre-2022 catching up ([Ruta del Transporte](https://www.rutadeltransporte.com/camiones/matriculaciones-camiones-subieron_0_1843015702.html)).

**Key countries.** Germany is the largest single market and biggest destination for cross-border haulage; Poland is Europe's largest international hauler and the epicentre of CEE capacity; Spain, France and Italy dominate domestic markets; the Netherlands is a dense transit/hub market; Romania and Lithuania are top truck-owning countries whose drivers work pan-European routes; the UK is a large, structurally short-of-drivers island market; Turkey is a giant origin/destination market (2.095 million export truck trips in 2024 alone ([Anadolu Agency](https://www.aa.com.tr/tr/ekonomi/turkiyede-gecen-yil-2-milyon-95-bin-ihracat-seferi-yapildi/3472660))) whose hauliers run deep into the EU.

**Fleet structure.** The market is extremely fragmented: road freight in the EU is "dominated by small companies, having fewer than 6 employees" at the operating level ([Lund University analysis](https://lup.lub.lu.se/luur/download?func=downloadFile&recordOId=9121288&fileOId=9122084)). Owner-operators and 1–20-truck SMEs are the overwhelming majority of carriers by count, though consolidation is rising as small operators struggle with costs ([TrasportoEuropa on consolidation](https://www.trasportoeuropa.it/notizie/autotrasporto/in-europa-aumenta-il-consolidamento-nellautotrasporto/)).

**Driver shortage.** The shortage is structural and worsening. IRU-linked figures put the European gap at **~233,000 truck drivers**, with **half of European operators unable to expand** because they can't hire ([IRU newsroom](https://www.iru.org/news-resources/newsroom/half-european-truck-operators-cant-expand-due-driver-shortages), [CXTMS on IRU's 233,000 deficit](https://cxtms.com/blog/europe-truck-driver-shortage-iru-third-country-recruitment-continental-freight-2026)). Country specifics: Germany expects ~120,000 missing professional drivers ([Eurotransport](https://www.eurotransport.de/logistik/spedition-und-logistik/fachkraeftemangel-haelt-an-bald-fehlen-120-000-berufskraftfahrer/)); the UK lost 117,000 HGV drivers in a single year ([Commercial Motor](https://www.commercialmotor.com/news/article/117000-hgv-drivers-leave-the-industry-in-a-year), [RHA](https://www.rha.uk.net/news/news/detail/driver-shortages-uk-international-hauliers-not-alone)); Romania is recruiting drivers from Asia to fill the gap ([TVR](https://tvrinfo.ro/criza-fortei-de-munca-ii-determina-pe-transportatorii-romani-sa-angajeze-soferi-din-asia/)); Turkey reports an alarm-level TIR/truck driver deficit ([Dünya](https://www.dunya.com/ihracat/tir-ve-kamyon-surucu-acigi-alarm-veriyor-haberi-771499#1)). The workforce is aging — the shortage is a long-term structural threat ([TI Insight](https://ti-insight.com/briefs/europes-truck-drivers-shortage-challenges-and-responses/), [The Loadstar](https://theloadstar.com/truck-driver-shortage-now-a-structural-threat-to-businesses/)).

**Digitalization maturity.** Low but accelerating. e-CMR is legally live in **41 countries** ([TransFollow](https://www.transfollow.com/ecmr-now-live-in-41-countries/)), yet paper still dominates daily operations — most carriers have no digital document workflow at all ([Trans.eu on digital documents](https://tfc.trans.eu/en/blog/for-carrier/the-future-of-digital-transport-documents/)). Telematics penetration is high for tracking, but the driver's daily loop (docs, tacho, parking, communication) remains paper + WhatsApp + phone.

---

## 2. Driver pain points

1. **Paperwork burden.** CMRs, delivery notes, timesheets, expense sheets, customs docs. Digitising the CMR is the industry's biggest paperwork lever ([Transporeon eCMR guide](https://www.transporeon.com/en/community/blog/ecmr-guide-for-shippers), [Trans.eu](https://tfc.trans.eu/en/blog/for-carrier/the-future-of-digital-transport-documents/)).
2. **Tachograph / working-time compliance.** Complex EU driving/rest rules (4.5 h driving → 45 min break; daily/weekly rest) plus mandatory **Smart Tachograph 2** hardware; drivers fear fines and manual rule-tracking ([RHA Smart Tacho 2](https://www.rha.uk.net/news/news/detail/smart-tachograph-2-eu-compliance), [TTCO guide](https://ttco.eu/en/used/blog/smart-tachograph-2-guide), [Webfleet compliance](https://www.webfleet.com/en_gb/webfleet/industries/transport/compliance-support/)).
3. **Parking shortage.** Europe has ~300,000 truck parking spaces but only ~7,000 secure ones; the EU targets secure parking every 100 km on TEN-T core routes ([IRU joint letter](https://www.iru.org/system/files/Joint%20letter%20-%20More%20safe%20and%20secure%20truck%20parking%20areas%20needed%20on%20the%20entire%20TEN-T%20Network.pdf), [Transport Journal](https://m.transportjournal.com/de/artikeldetail/secure-parking-every-100-km-along-the-ten-t-core-roads.html), [TI Insight](https://ti-insight.com/briefs/europe-builds-safe-truck-parking-areas-to-tackle-driver-shortages/)). Drivers routinely burn legal rest time hunting for a safe spot.
4. **Loading/unloading waits.** Unpaid detention at docks and warehouses eats driving windows and pay; it's a top, quantified driver grievance ([Invoitix on empty runs/detention](https://invoitix.com/empty-runs-how-to-avoid-them/), [OOIDA detention survey](https://www.overdriveonline.com/business/article/15665203/ooida-member-surveys-on-detention-time-rates-deliver-ops-insight#1)).
5. **Truck-specific navigation.** Car GPS routes trucks under low bridges or into weight-restricted streets; drivers juggle clunky HGV sat-navs or risky workarounds ([HGV sat-nav debate](https://transportforum.com/viewtopic.php?p=418174&sid=238399a18108ed810a3b4a67c69944df#p418174)).
6. **Dispatcher communication.** Fragmented across phone, WhatsApp and email, with no structured job status; ECTA's driver-app programme shows the appetite for a single driver tool ([ECTA Drivers APP](https://ecta.com/ecta-drivers-app-latest-view-on-chemical-truck-driver-well-being/)).
7. **Payments & compensation.** Late and long payment terms hit drivers and small carriers alike; payment delays are "normalised" in the industry ([Bluestone on late payments](https://bluestonecm.co.uk/news-and-media-credit-management/thrive-not-just-survive-hauliers-must-address-normalised-late-payments/), [Transporte3 on Spain's payment terms](https://transporte3.com/noticia/22958-los-plazos-de-pago-a-los-transportistas-vuelven-a-niveles-historicos/)).
8. **Health & safety.** Long sedentary hours, poor rest quality, and safety risks at insecure stops; driver well-being is a stated industry priority ([ECTA well-being data](https://ecta.com/ecta-drivers-app-this-is-the-european-chemical-industrys-performance/)).
9. **Language barriers cross-border.** Polish, Romanian, Turkish, Lithuanian drivers operate in Germany, France, Benelux, UK — paperwork and instructions arrive in languages they don't read; mistranslation causes delays and fines.
10. **Cargo theft.** Theft losses have roughly **tenfolded since 2021** in Europe ([Warehouse Totaal / TAPA data](https://www.warehousetotaal.nl/nieuws/brute-inbraken-en-cyberaanvallen-vergroten-risico-ladingdiefstal-europa-schade-vertienvoudigd-sinds-2021/140653/)); TAPA EMEA recorded **€36.8M stolen in a single 31-day window** ([TAPA EMEA](https://tapaemea.org/intelligence/e36-8m-of-products-stolen-from-supply-chains-in-emea-in-31-days/)); theft methods are shifting and require vigilance tools ([Trans.eu theft analysis](https://www.trans.eu/en/blog/security/cargo-theft-2022-2025-more-perpetrators-lower-hit-rate-what-changed/)).

---

## 3. Hauler / fleet owner pain points

1. **Empty miles.** A meaningful share of truck-km in Europe is run empty — eliminating backhauls is the single biggest efficiency lever ([Invoitix](https://invoitix.com/empty-runs-how-to-avoid-them/), [truck utilisation research](https://www.sciencedirect.com/science/article/pii/S2210539525000884)).
2. **Fuel costs.** Fuel is the largest variable cost; cost-structure research shows its dominance in international operations ([MDPI cost structure paper](https://www.mdpi.com/2071-1050/18/3/1572/pdf)).
3. **Driver shortage & retention.** Half of operators can't grow due to hiring ([IRU](https://www.iru.org/news-resources/newsroom/half-european-truck-operators-cant-expand-due-driver-shortages)); retention is now a tech problem — better driver tools are marketed as recruitment/retention levers ([Transport & Logistics Magazine](https://tandlonline.com/business/training-recruitment-appointments/the-tech-route-to-driver-recruitment-and-retention/)).
4. **Tolls & vignettes.** Fragmented tolling across ~30 national systems; Germany's LKW-Maut rose **>80%** in Dec 2023 with the CO₂ surcharge ([NAVIS](https://www.navis-ag.com/lkw-maut-erhoehung-zum-1-dezember-2023-durch-co2-aufschlag/), [VN.at](https://www.vn.at/markt/2023/11/20/lkw-maut-in-deutschland-steigt-um-mehr-als-80-prozent-vorarlberger-unternehmen-in-sorge.vn)), and CO₂-class toll increases are rolling out across Europe ([Eurowag](https://www.eurowag.com/blog/decarbonising-transport-the-impact-of-pan-european-toll-increases-due-to-co2-classes), [Freight Perspectives](https://www.freightperspectives.com/p/greening-the-roads-toll-updates-in), [TI Insight tolls](https://ti-insight.com/briefs/europes-toll-roads-take-a-greener-turn/)).
5. **eCMR / paper documents.** Admin staff still re-key paper CMRs; the eCMR protocol is live in 41 countries but adoption is uneven, with pilots like Benelux extended to July 2027 ([TransFollow Benelux](https://www.transfollow.com/benelux-pilot-on-ecmr-extended-until-july-2027/), [TransFollow UNTRR webinar](https://www.transfollow.com/fr/untrr-and-transfollow-webinar-transforming-the-transport-industry-with-the-e-cmr/)).
6. **Cash flow & slow payments.** Hauliers routinely wait 60–90+ days; payment terms in Spain hit historical highs ([Transporte3](https://transporte3.com/noticia/22958-los-plazos-de-pago-a-los-transportistas-vuelven-a-niveles-historicos/), [Bluestone](https://bluestonecm.co.uk/news-and-media-credit-management/thrive-not-just-survive-hauliers-must-address-normalised-late-payments/)).
7. **Maintenance & downtime.** Unplanned breakdowns kill margins; telematics-based maintenance (OEM.connect, trailer data) is the standard fix ([Webfleet](https://www.webfleet.com/en_ie/webfleet/company/updates/press/2024/02/29/), [Webfleet OEM trailer programme](https://www.rutadeltransporte.com/servicios/webfleet-amplia-programa-oem-connect_0_2000004870.html)).
8. **Utilization.** Trucks idle waiting for loads or at docks; data-driven utilisation is a proven lever ([ScienceDirect utilisation study](https://www.sciencedirect.com/science/article/pii/S2210539525000884)).
9. **Cross-border complexity.** Cabotage limits, driver posting rules, and country-specific paperwork; the EU has even extended tachograph/posting rules to vans ([FIDI](https://www.fidi.org/news/new-eu-rules-lcv-operators-now-force-tachographs-driving-hours-and-posting-drivers), [IRU on vans](https://www.iru.org/news-resources/newsroom/eu-cross-border-transport-rules-extend-vans-what-you-need-know)).
10. **Compliance administration.** Managing driver files, tacho downloads, and inspections without software is manual and error-prone ([Webfleet compliance](https://www.webfleet.com/en_gb/webfleet/industries/transport/compliance-support/)).

---

## 4. Regulation & compliance

- **EU Mobility Package (2020–2022).** Reformed cabotage (limit of 3 cabotage operations in 7 days), mandated return of vehicles to the operating centre every 8 weeks, and tightened driver-posting rules for international haulage ([FIDI on new EU rules](https://www.fidi.org/news/new-eu-rules-lcv-operators-now-force-tachographs-driving-hours-and-posting-drivers)).
- **Driving & rest times.** Regulation (EC) 561/2006 as amended: max 4.5 h continuous driving, 45 min break, max 9 h (10 h twice weekly) daily driving, 45 h weekly rest, enforced via tachographs.
- **Smart Tachograph 2.** Mandatory on new vehicles registered from 21 Aug 2023; cross-border vehicles must be retrofitted by end-2025 ([RHA](https://www.rha.uk.net/news/news/detail/smart-tachograph-2-eu-compliance), [TTCO](https://ttco.eu/en/used/blog/smart-tachograph-2-guide), [IDEM](https://www.idemtelematics.com/en/news-rss-en/smart-tacho-2.html)).
- **eFTI.** Regulation (EU) 2020/1056 obliges authorities to accept electronic freight transport information; implementation work is converging on the **2027 deadline** and will make eCMR-style data exchange mandatory in practice ([ESC](https://europeanshippers.eu/efti-implementation-key-developments-ahead-of-the-2027-deadline/), [eFTI4EU flyer](https://efti4eu.eu/wp-content/uploads/2025/06/efti4eu-flyer-transport-V2-web-2.pdf)).
- **eCMR.** UN Protocol on the electronic consignment note; live in 41 countries including key EU markets ([TransFollow](https://www.transfollow.com/ecmr-now-live-in-41-countries/)); Benelux pilot extended to July 2027 ([TransFollow](https://www.transfollow.com/benelux-pilot-on-ecmr-extended-until-july-2027/)).
- **Tolls.** Eurovignette Directive amended 2022 to allow CO₂-based distance charging; Germany's Maut +80%+ (Dec 2023) is the template, with CO₂ classes spreading ([ECG Eurovignette](http://www.ecgassociation.eu/wp-content/uploads/2024/08/Eurovignette.pdf), [Eurowag](https://www.eurowag.com/blog/decarbonising-transport-the-impact-of-pan-european-toll-increases-due-to-co2-classes)).
- **Software haulers are forced to buy:** tachograph download/analysis suites, toll-box/OBU services per country (DKV, Toll4Europe, UTA, Eurowag), eCMR platforms (TransFollow, Transporeon), TMS/dispatch tools for cabotage/posting records, and increasingly telematics for ODRS/compliance evidence.

---

## 5. Existing competitors

**Freight marketplaces / digital forwarders**
- **Transporeon (Trimble) + TIMOCOM/TIM Consult** — shipper-side procurement, TMS and the dominant DACH/CEE freight exchange ([TIMOCOM–Transporeon link-up](https://transport-online.de/news/zusammenschluss-tim-consult-und-transporeon-gemeinsam-am-start-12516.html)). Strength: network scale, eCMR, integration. Weakness: enterprise-priced, shipper-centric; the small carrier gets a load board, not an operating tool.
- **sennder** — Europe's largest digital forwarder; bought **C.H. Robinson's European trucking division** in 2024 ([Automotive Logistics](https://www.automotivelogistics.media/inbound-logistics/sennder-technologies-buys-european-truck-division-from-ch-robinson/214525), [fact sheet](https://a.storyblok.com/f/174762/x/82288fe3d2/sennder-fact-sheet_2024.pdf)). Strength: end-to-end digital matching. Weakness: asset-light broker model squeezes carrier margins; no driver-operations tool.
- **Trans.eu (with TransFollow)** — the CEE freight exchange and eCMR leader; strong in Poland/Romania ([Trans.eu](https://www.trans.eu/en/product/transeu-freight-exchange/), [Trans.eu ranking context](https://aispedytor.com/blog/ranking-gield-transportowych-2026)). Weakness: exchange + docs, but no fleet/dispatch SaaS for the carrier's own operations.
- **Cargonexx, Saloodo (DHL), 123cargo, ZENDEQ-style quote platforms** — digital freight/quote niches, mostly German-market spot freight ([ZENDEQ comparison](https://www.zendeq.com/transport-quote-platforms-compared/)). Weakness: single-feature, market-specific.

**Telematics / fleet management**
- **Webfleet (Bridgestone)** — the European trucking standard: tracking, driver app, compliance, trailer connectivity ([Webfleet](https://www.webfleet.com/en_gb/webfleet/industries/transport/compliance-support/)). Weakness: hardware + per-vehicle subscription cost; no freight, docs or dispatch workflow.
- **Samsara** — US leader expanding in Europe; strong dashcams/AI and DVIR ([Samsara Europe](https://www.samsara.com/uk/customers/gebruder-schroder), [Samsara tools](https://www.samsara.com/uk/blog/new-tools-for-safer-smarter-fleets-unveiled-at-Go-Beyond)). Weakness: US-centric, priced for mid/large fleets; thin EU compliance/docs.
- **ABAX, Geotab** — affordable tracking/telematics ([ABAX](https://www.abax.com/en-gb/more-than-just-vehicle-tracking), [ABAX vs Quartix](https://www.evehicletracking.com/abax-vs-quartix/#Best-choice-by-business-type)). Weakness: pure tracking; no driver workflow or paperwork.
- **Trimble TMS / C.H. Robinson Navisphere** — enterprise TMS/4PL; Navisphere's European truck assets were sold to sennder ([sennder–CHR](https://www.automotivelogistics.media/inbound-logistics/sennder-technologies-buys-european-truck-division-from-ch-robinson/214525)). Weakness: enterprise scale, wrong price/complexity for 1–20-truck SMEs.

**Pattern:** every category solves one slice (loads, tracking, docs, or compliance). **No incumbent combines a driver-first Android app + dispatcher SaaS + eCMR + compliance at SME price**, in the languages of CEE/Turkey carriers.

---

## 6. Market gaps

1. **Small fleets (1–20 trucks) & owner-operators** — the majority of EU carriers ([Lund University](https://lup.lub.lu.se/luur/download?func=downloadFile&recordOId=9121288&fileOId=9122084)) are priced out of enterprise TMS and don't need US-style telematics suites.
2. **SME regional & cross-border haulers in CEE + Turkey** — Poland, Romania, Lithuania, Bulgaria, Turkey moving freight into Germany/Benelux/UK/Scandinavia; they need multilingual, low-cost digitisation (eCMR, tacho, tolls) — exactly what exchanges and telematics don't deliver.
3. **Driver-first UX** — with the driver shortage at 233k+ in Europe ([IRU](https://www.iru.org/news-resources/newsroom/half-european-truck-operators-cant-expand-due-driver-shortages)), the product that makes drivers' daily admin lighter is a retention tool hauliers will pay for.
4. **eCMR for the long tail** — eCMR is live in 41 countries ([TransFollow](https://www.transfollow.com/ecmr-now-live-in-41-countries/)) but SME adoption lags; a cheap eCMR + photo-POD + document vault inside one app is unclaimed.
5. **Parking & detention tools** — no mainstream European product helps drivers find safe parking or log/charge detention; both are top driver complaints ([IRU parking letter](https://www.iru.org/system/files/Joint%20letter%20-%20More%20safe%20and%20secure%20truck%20parking%20areas%20needed%20on%20the%20entire%20TEN-T%20Network.pdf), [detention survey](https://www.overdriveonline.com/business/article/15665203/ooida-member-surveys-on-detention-time-rates-deliver-ops-insight#1)).

---

## 7. Recommended MVP

**Android driver app (offline-first, multi-language: PL, RO, TR, DE, EN, FR, ES) — priority order:**
1. **Job card + eCMR in the cab** — digital CMR creation/acceptance, delivery-note capture, photo POD, e-signature; offline sync.
2. **Tacho/working-time assistant** — rest & driving reminders from EU rules; auto-generated daily log.
3. **Truck navigation** — HGV-aware routing (height/weight/ADR), integrated with the job address.
4. **Dispatcher chat + job status** — structured messaging with photo sharing; replaces WhatsApp chaos.
5. **Parking & detention logging** — safe-parking finder (TEN-T secure spots), demurrage timer to bill waits.

**SaaS dashboard (fleet owner / dispatcher) — priority order:**
1. **Dispatch board** — assign jobs, live map of trucks/drivers, ETA from real position.
2. **Document vault & eCMR status** — signed/unsigned docs per trip, compliance-ready exports (eFTI-ready).
3. **Compliance view** — tacho data, rest compliance alerts, driver files, cabotage/posting tracking.
4. **Cost per km & invoicing prep** — fuel, tolls, driver pay, empty-km share; export-ready invoices to fight slow payments.
5. **Driver retention loop** — driver ratings, pay/expense transparency, safe-parking credits.

**Prioritisation logic:** solve the driver's daily paperwork + compliance + navigation loop first (that's the retention and distribution wedge), then layer dispatcher efficiency and eCMR revenue on top. Target pricing: per-truck/month SaaS with free driver app — built for the 1–20-truck SME, not the enterprise.

---

## Summary

The single biggest opportunity in Europe is **the SME carrier operating layer for the 1–20-truck segment — especially CEE and Turkish cross-border hauliers — that combines a driver-first Android app (eCMR, tacho assistant, truck navigation, dispatcher chat) with a cheap dispatcher SaaS dashboard**, an integrated wedge none of the load exchanges, US telematics vendors, or enterprise TMS players serve; with a structural 233,000-driver shortage ([IRU](https://www.iru.org/news-resources/newsroom/half-european-truck-operators-cant-expand-due-driver-shortages)), eCMR legal everywhere ([TransFollow](https://www.transfollow.com/ecmr-now-live-in-41-countries/)), and eFTI forcing digitisation by 2027 ([ESC](https://europeanshippers.eu/efti-implementation-key-developments-ahead-of-the-2027-deadline/)), the regulatory and market winds all point to that wedge now.
