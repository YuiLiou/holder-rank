---
name: ui-design-system
description: Use before any UI/visual change to holder-rank's frontend (public/index.html, public/style.css, public/app.js, or the SSR fragments in server.js) — the color tokens, component patterns, and SSR/client mirroring rules already established for this app. Read before adding a color, a component, or a new result-panel section.
version: 0.1.0
---

# holder-rank UI Design System

## Overview

holder-rank's whole product moment is one sentence: **"where do you stand
among this stock's shareholders."** The UI is built around making that
sentence land, not around a generic dashboard layout. This skill captures
the design system built for it — a token-based light/dark theme, three
reusable component patterns (reveal hero, stat tiles, tier ladder), and the
SSR/client mirroring convention this codebase already relies on. Read this
before touching `public/style.css`, `public/index.html`, `public/app.js`,
or the `buildResultFragments`/render-helper functions in `server.js` —
reuse what's here instead of reinventing a color or a card style per
change.

## The one hard rule: server.js and app.js are mirrored, always

This codebase renders the result panel **twice** — once server-side for
the SSR homepage (`server.js`'s `buildResultFragments` and its
`render*Html` helpers), once client-side after a query (`public/app.js`'s
`render*` functions). Every pure-rendering function has a sibling with a
`// Mirrors server.js's X()` / `// Mirrors public/app.js's X()` comment.

**Any new visual feature needs both halves, kept in exact sync**, or the
SSR homepage (what crawlers and first-time visitors see) will silently
diverge from what a live query renders. When adding a template token,
update it in all three places: the `{{TOKEN}}` in `index.html`, the
fragment-building object in `server.js`, and the DOM write in `app.js`.
When a fragment can be legitimately empty (e.g. already top tier, no
upgrade to show), give it a CSS `:empty { display: none; }` rule instead of
a JS-toggled hidden class — see `.tier-upgrade:empty` for the pattern.

## Design tokens (`public/style.css`, `:root`)

All color is CSS custom properties, light values on `:root`, dark
overrides under `@media (prefers-color-scheme: dark)`. There is no manual
theme toggle — it follows the OS setting. If a toggle is ever added, mirror
the dark block under `:root[data-theme="dark"]` / `:root[data-theme="light"]`
so both mechanisms agree.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--paper` | `#f1f4f9` | `#0d1219` | page background |
| `--card` | `#ffffff` | `#151c27` | container, gauge marker bubble |
| `--card-2` | `#f7f9fc` | `#101620` | stat tiles (calmer than `--card`) |
| `--ink` / `--ink-soft` / `--ink-faint` | `#1f2937` / `#5b6472` / `#939fb1` | `#eceff4` / `#9aa5b6` / `#5e6878` | text hierarchy |
| `--line` / `--line-strong` | `#e5e9f0` / `#d3d9e2` | `#232c39` / `#2e3947` | hairlines, table borders |
| `--gold` / `--gold-strong` | `#b45309` / `#92400e` | `#e0b84e` / `#f3d272` | **interactive accent** — buttons, links, active chip, reveal figure, "you" bar in the pyramid |
| `--gold-soft-bg` / `--gold-soft-border` / `--gold-soft-ink` / `--on-gold` | see file | see file | chip default state / text-on-gold |
| `--price-up` / `--price-down` | `#dc2626` / `#16a34a` | `#f2665a` / `#34c084` | **TW market convention only** — 漲=red, 跌=green. Never repurpose for anything else on the page. |
| `--gauge-whale` / `--gauge-retail` | `#9f1239` / `#64748b` | `#e1637e` / `#93a0b4` | percentile gauge + pyramid bars — a third, distinct hue pair for "distribution position" |
| `--highlight-bg` / `--highlight-ink` | `#fef9c3` / `#78350f` | `#2e2510` / `#f3d272` | "你在這裡" table row |
| `--disabled-bg` | `#9ca3af` | `#4b5563` | disabled button |

**Why three separate color axes (gold / price-up-down / gauge-whale-retail)
instead of one accent reused everywhere**: they encode three different
things that can appear on screen at the same time — "click me" (gold),
"stock moved up/down today" (price), and "where you sit in the holder
distribution" (gauge/pyramid). Collapsing any two into the same hue reads
as the wrong kind of information at a glance. Keep them separate when
adding new UI, don't default to reusing `--gold` for something that isn't
an interactive/accent element.

**The tier-card gradients (`.tier-card--gold/indigo/teal/sky/slate`,
~line 514 of style.css) are deliberately NOT tokenized.** Each is a
saturated, self-contained, always-white-text card whose look shouldn't
shift with the page theme — same reasoning as "a design that commits to
one visual world may stay single-theme" for a component, not just a whole
page. Leave these as literal hex gradients.

Every numeric display (`.reveal-figure`, `.stat-v`, `.tier-grade`, table
`td`, quote line) carries `font-variant-numeric: tabular-nums` — add it to
any new numeric element too, so digits stay column-aligned when they
change.

## Component patterns

**Reveal hero** (`.reveal`, `#reveal-beat` in `index.html`/`app.js`) — when
a result has one number that matters most, give it its own oversized
statement (`clamp(44px, 11vw, 68px)`, `font-weight: 800`) framed as a
sentence ("你的持股，贏過 X% 的全體股東"), not a labeled stat tile next to
other same-weight tiles. Related-but-secondary numbers (rank, total count)
go into flatter `.stat-tile` cards underneath — `--card-2` background, thin
`--line` border, no gradient, so they don't compete with the hero. Don't
add a second hero-weight element to the same section; if a new "big
number" moment is needed, demote the current hero to a stat tile or find a
different section for it.

The hero's number counts up from 0 on load (`renderRevealFigure` in
`app.js`, ~900ms, cubic ease-out) and jumps straight to the final value
under `prefers-reduced-motion: reduce` — check `window.matchMedia` once at
module scope (see `prefersReducedMotion` in `app.js`), don't re-check it
per animation frame. Any future animated reveal should follow the same
respect-reduced-motion shape.

**Tier ladder** (`.tier-ladder`, `.rung`, `renderTierLadder`/
`renderTierLadderHtml`) — a static grade/badge is easy to render but gives
no sense of progress. The ladder lays out every tier from easiest to
hardest, left to right (`SHAREHOLDER_TIERS` is stored hardest-first, so
both renderers `.reverse()` it before walking), marks tiers already
surpassed as `.done`, the current one as `.current` (solid white badge —
works against any of the five gradient tones without per-tone CSS), and
the very next one as `.is-next` (dashed outline) so it visually pairs with
the "再買 N 張升級為..." callout (`.tier-upgrade`) directly below it. If
another graded/leveled feature is ever added to this app, reuse this
done/current/is-next state model rather than inventing a new one.

## Practical notes

- **Contrast-check new color pairs before shipping**, especially
  text-on-`--gold` combinations — compute WCAG relative luminance by hand
  if a browser isn't available to check live (this is how `--gold`
  `#b45309`/white was verified at ~5:1, AA-compliant for normal text, not
  just large/bold text).
- **Responsive overrides are colocated with their component**, not
  collected into one big breakpoint block at the end of the file — each
  `@media (max-width: 480px)` sits right after the rule it overrides (see
  `.chip`, `.stat-tile`, `.rung`, `.tier-card`). Follow that placement for
  new components; it's what makes the ~500-line stylesheet navigable.
- **`test/estimateRank.test.js` only exercises `server.js`'s pure ranking
  functions** (`estimateRank`, `computeTierUpgrade`, `getTier`) — it
  doesn't touch HTML/CSS/rendering, so it won't catch a broken template
  token or a mismatched id between `index.html` and `app.js`. After any
  markup change, grep the changed ids/tokens across all three files and/or
  hit `/` and `/api/rank` with `curl` to confirm no `{{TOKEN}}` leaks
  through unfilled (see `renderIndexHtml` — unmatched tokens are left
  verbatim in the output, not stripped).
