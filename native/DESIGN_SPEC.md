# TomeSonic RN — Visual Design Spec (source of truth)

> Goal: the React Native app in `native/` must look and behave **identically** to the
> original Vue/Capacitor app (repo root: `pages/`, `components/`, `assets/`).
> This folder is the durable spec — derived from the actual original source, not guesswork.
> It must survive context compaction. When in doubt, the original `.vue` template + its
> CSS classes + `assets/material3-theme.css` are the ground truth.

## Theme identity
**Material 3 Expressive, modern media-player aesthetic, with Material You dynamic color.**
Light / dark / system. **The palette is TEAL / pine-green, seeded from the system wallpaper
(Material You), with a brand-teal `#007988` fallback — NOT the M3 baseline purple.** Reseeding
our purple palette to teal + wiring real dynamic color is the #1 fix (see 00-visual-reference).

## Spec files
- [00 — Visual reference (REAL device screenshots)](DESIGN_SPEC/00-visual-reference.md) — **START HERE.** 19 real screenshots of the shipping app + per-screen targets. When source specs disagree, the screenshots win.
- [01 — Design system & app chrome](DESIGN_SPEC/01-design-system.md) — colors, dynamic color engine, typography, elevation, nav bar, top app bar, side drawer, common UI atoms
- [02 — Home & Library](DESIGN_SPEC/02-home-library.md) — bookshelf home, shelves, library grid/list, cards, covers, progress indicators
- [03 — Player & media modals](DESIGN_SPEC/03-player.md) — full AudioPlayer, mini player, chapters/bookmarks/speed/sleep-timer/cast modals
- [04 — Detail pages](DESIGN_SPEC/04-detail-pages.md) — item/episode detail, series, collections, playlists, authors + their modals
- [05 — Utility screens](DESIGN_SPEC/05-utility-screens.md) — search, stats, settings, account, downloads, logs, connect

## RN port status
Per-screen match status is tracked at the bottom of each spec file (❌ not started / 🟡 partial / ✅ matches).

## Migration rules (Vue → RN + NativeWind)
- `<div>`→`View`, `<p>/<span>`→`Text`, `<img>`→`Image`, `<button>/<nuxt-link>`→`Pressable`.
- Port `class="..."` → `className="..."` verbatim where a NativeWind utility exists.
- NativeWind does NOT support: `hover:`/`active:`/`focus:` variants, `transition`/`duration`/`ease-*`,
  `backdrop-filter`/`backdrop-blur`, CSS grid, scoped `@keyframes`, `::before`/`::after`.
  Substitute: Pressable state style fns, Reanimated for animation, LinearGradient for gradients,
  flex-wrap for grid. Each spec file flags where the original relies on these.
- Colors come from M3 tokens (see 01). Never hardcode hex except where the original does.
