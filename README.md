# RoadwiseFleet

**The operating system for small trucking fleets and owner-operators.**

RoadwiseFleet is a phone-first fleet operations platform: an **Android app for truck drivers** and a **SaaS web dashboard for fleet owners and dispatchers**. No hardware boxes — the driver's phone is the telematics device. Built for the 1–20-truck fleets and self-employed drivers that enterprise TMS and telematics vendors ignore.

This repository is the **open foundation**: the market research that shaped the product, the design artifacts generated from it, and the briefs used to produce them.

---

## Repository structure

| Path | Contents |
|---|---|
| [`docs/market-research.md`](docs/market-research.md) | Master market research: executive summary, pain-point heat map, cross-region synthesis, product recommendation, risks & next steps |
| [`docs/europe-market-research.md`](docs/europe-market-research.md) | Europe (EU-27 + UK + Turkey) |
| [`docs/asia-pacific-road-freight-market-research.md`](docs/asia-pacific-road-freight-market-research.md) | Asia-Pacific (India, China, SEA, Pakistan, Bangladesh) |
| [`docs/north-america-trucking-market-report.md`](docs/north-america-trucking-market-report.md) | North America (USA, Canada, Mexico) |
| [`docs/latam-road-freight-market-report.md`](docs/latam-road-freight-market-report.md) | Latin America (Brazil, Argentina, Colombia, Chile, Peru) |
| [`web/index.html`](web/index.html) | Landing page — single self-contained HTML file |
| [`web/dashboard.html`](web/dashboard.html) | SaaS dashboard front page (post-login dispatcher view) |
| [`web/brand-spec.md`](web/brand-spec.md) | Brand tokens (OKLch palette, type stacks, usage rules) |
| [`design/`](design/) | The design briefs used to generate both artifacts |

## The idea (from the research, in one paragraph)

Trucking is fragmented everywhere: 95.5% of US carriers run ≤10 trucks, 90%+ of Indian operators run 1–5, 76.5% of Brazilian transporters are self-employed, and small carriers dominate the EU. These fleets run on paper, WhatsApp, and phone calls. Drivers are scarce (233k missing in Europe, ~90k in Mexico, ~1M lost in Brazil in a decade). Paperwork, empty miles (15–20% US, ~35% Brazil, ~69% Colombia), slow payments (30–90+ days), parking/safety, and compliance are universal pain points — and regulation is forcing digitization everywhere (eCMR/eFTI by 2027 in the EU, ELD/IFTA + Carta Porte in North America, e-way bill + FASTag in India, CT-e/MDF-e in Brazil). Incumbents each solve one slice (load boards, telematics hardware, documents, enterprise TMS); **nobody owns the daily operating loop for small carriers**. That's RoadwiseFleet.

Beachhead ranking from the research: **Brazil first, then India, North America third, Europe last** — subject to founder fit (language, network, payment rails).

## Design artifacts

Both web artifacts were generated with **[OpenDesign](https://github.com/nexu-io/open-design)** — the open-source design product by the nexu-io community (v0.21.1, Apache-2.0) — driven by the **DeepSeek Harness** as the native agent runtime (`od agent setup deepseek-harness`), using the `frontend-design` skill and the Linear design system, then tuned to the RoadwiseFleet brand spec (deep navy + safety amber, Barlow Condensed + Inter). Both pass OpenDesign's anti-slop linter with **0 P0 / 0 P1 / 0 P2**.

> This repository ships only RoadwiseFleet's own artifacts (research, briefs, generated HTML). OpenDesign itself lives at [nexu-io/open-design](https://github.com/nexu-io/open-design) — this is not a fork of it.

The landing page includes: dark hero with phone + dashboard mockups, research-grounded stats strip (140-min detention, 15–20% empty miles, 60–90-day payments, 233k driver shortage), problem cards, driver-app and dashboard feature grids, regional compliance strip (eCMR/eFTI · e-way bill/FASTag · CT-e/MDF-e · ELD/HOS), how-it-works, pricing teaser, and a waitlist form (front-end stub — wire to a form service before launch).

## Reproducing the design pipeline

```bash
# 1. Clone OpenDesign and install (Node ~24, pnpm 10.33.x)
git clone --depth 1 https://github.com/nexu-io/open-design.git
cd open-design && corepack enable && pnpm install
pnpm --filter @open-design/daemon build && pnpm --filter @open-design/web build

# 2. Start the daemon (serves UI at http://127.0.0.1:7456)
OD_DATA_DIR=./opendesign-data node apps/daemon/dist/cli.js --port 7456 --no-open

# 3. Connect the DeepSeek Harness (dsh must be installed & authenticated)
node apps/daemon/dist/cli.js agent setup deepseek-harness --daemon-url http://127.0.0.1:7456

# 4. Create a project and send a design turn (see design/ briefs)
curl -s -X POST http://127.0.0.1:7456/api/projects \
  -H 'content-type: application/json' \
  -d '{"id":"my-project","name":"My Project","projectLocationId":"default",
       "skillId":"frontend-design","designSystemId":"linear-app","skipDiscoveryBrief":true}'
# then POST /api/chat with {agentId:"deepseek-harness", projectId, conversationId,
# sessionMode:"design", skillId:"frontend-design", designSystemId:"linear-app",
# model:"deepseek-official/deepseek-v4-pro", message:"<brief>"} and stream the SSE result.
```

Generated artifacts land in `opendesign-data/projects/<id>/` and are previewable in the UI.

## Notes & caveats

- Market research sources are cited inline (2023–2025 data). Where an exact figure could not be verified (e.g., €-denominated EU market size), the reports use volume/truck-count statistics instead of inventing numbers.
- All statistics in the landing page come from the cited research; treat the designs as pre-launch marketing drafts, not legal/financial claims.
- The waitlist form and any "quick-pay" flows shown are UI concepts — no backend is wired.

## License

[MIT](LICENSE) © RoadwiseFleet Contributors
