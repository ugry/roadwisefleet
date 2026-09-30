# RoadwiseFleet — Web Assets

Designed with **OpenDesign** (open-source design agent, v0.21.1) driven by the **DeepSeek Harness** (deepseek-v4-pro), using the `frontend-design` skill and the Linear design system, then tuned to a custom RoadwiseFleet brand spec (deep navy + safety amber, Barlow Condensed + Inter).

## Files

| File | What it is |
|---|---|
| `index.html` | Landing page — single self-contained HTML file (fonts via Google Fonts, no build step). QA: OpenDesign anti-slop linter clean (P0/P1/P2 = 0/0/0). |
| `dashboard.html`, `driver-beacon-screen.html`, `connect-load-posting.html`, `diagrams.html` | Additional public pages, same self-contained pattern. |
| `robots.txt` | Crawl rules for the live origin + `Sitemap:` pointer. |
| `sitemap.xml` | Canonical URL list (apex origin only). |
| `og-image.png` | 1200×630 Open Graph / Twitter social card. |
| `brand-spec.md` | Brand tokens (OKLch palette, type stacks, usage rules) generated during the design run — reuse for the app and future pages. |
| `../design/brief-landing-page.md` | The design brief used to generate the landing page. |
| `../design/brief-dashboard-front-page.md` | The design brief for the SaaS dashboard front page. |

## Preview vs live (GitHub Pages)

`web/` is deployed twice: to the live origin (nginx, `roadwisefleet.com`) and to the
GitHub Pages project preview (`ugry.github.io/roadwisefleet/`). Static hosting cannot
serve different bytes per origin, so every page carries a small inline **preview guard**
in `<head>`:

- on `*.github.io` it rewrites `<meta name="robots">` to `noindex,nofollow`;
- on the preview, `index.html` hides the waitlist form (with a visible notice) and never
  issues the production `POST /api/waitlist`; `window.RWF_PREVIEW` exposes the state.

The live site is unaffected. `<link rel="canonical">` on every page always points at the
apex URL. Note that `robots.txt` only takes effect on the live origin — a Pages project
page serves it at `/roadwisefleet/robots.txt`, which is not the `github.io` origin root.

## Preview / iterate (local)

- OpenDesign app (daemon + UI): `http://127.0.0.1:7456` — projects "RoadwiseFleet Landing Page" and "RoadwiseFleet Dashboard UI" with live preview + chat iteration.
- Daemon is running as a background job; to restart later:
  `cd vendor/open-design && OD_DATA_DIR=/home/semyaza/roadwisefleet/opendesign-data node apps/daemon/dist/cli.js --port 7456 --no-open`

## Deploy to the VPS (landing page)

Simplest: copy `index.html` to your web root, e.g.:

```bash
sudo mkdir -p /var/www/roadwisefleet && sudo cp index.html /var/www/roadwisefleet/
# nginx server block: root /var/www/roadwisefleet; index index.html;
# server_name roadwisefleet.com www.roadwisefleet.com;
```

The page has no backend dependencies — the waitlist form is a front-end stub; wire it to your mailing list endpoint or form service (Formspree/Buttondown/etc.) before launch.
