# RoadwiseFleet — Brand Spec

**One sentence:** A road-signage-flavored, dark-navy-and-safety-amber system that reads as
trustworthy industrial SaaS — precise like fleet software, grounded like asphalt.

## Core tokens (OKLch)

- `--bg`: `oklch(0.985 0.003 250)` — cool near-white page canvas
- `--surface`: `oklch(1 0 0)` — white cards / mockup screens
- `--fg`: `oklch(0.24 0.05 258)` — deep-navy ink for headings on light
- `--muted`: `oklch(0.48 0.02 255)` — secondary slate text
- `--border`: `oklch(0.90 0.006 255)` — hairline on light
- `--accent`: `oklch(0.80 0.165 82)` — safety amber (fills on light, markers on dark)

Extended tokens used in the artifact: navy scale `950→50`, `--accent-deep`
(`oklch(0.47 0.13 62)`, amber for text on light ≥4.5:1), `--accent-soft`,
semantic `--success` / `--danger`, dark-surface text tiers, and border/shadow tokens.

## Type stacks

- Display: `"Barlow Condensed", "Barlow", "Arial Narrow", sans-serif` — weights 500/600/700
- Body: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` — weights 400/500/600/700

## Observed rules

1. Dark navy (`oklch(0.20 0.04 258)`) is the brand base; amber is the only accent and
   appears at most twice per viewport (kicker + primary CTA, or a marker + status).
2. Dark hero / light sections / dark bookends (regional strip, final CTA, footer).
3. Display headlines run slight negative tracking; all-caps kickers run +0.08em.
4. Amber fills always carry navy text; amber text on light uses `--accent-deep`.
5. Cards are flat white with hairline borders and one-step hover lift — no gradients.
