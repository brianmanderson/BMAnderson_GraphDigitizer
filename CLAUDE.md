# CLAUDE.md

## What this is

A fully client-side graph digitizer: load a chart image, calibrate X/Y axes from two known
points each (linear, log10, ln, reciprocal, date/time) — by hand or with "Auto-detect axes"
(tick-label OCR) — place points on one or more lines, export a table. Vite + React + TypeScript
(strict). Images never leave the browser.

- [docs/SPEC.md](docs/SPEC.md) — the source of truth: workflow, calibration math, data model,
  decisions. If a change alters a decision, update SPEC.md in the same change.
- [docs/prompts.md](docs/prompts.md) — the build phases; all six are done.

## Layout

- `src/core/` — pure-TS calibration engine, **no DOM**: `scales.ts`, `dates.ts` (UTC),
  `calibrate.ts` (affine fit, typed errors), `project.ts`, `projectFile.ts` (validate + migrate).
- `src/auto/` — pure-TS, **no DOM**: axis/tick detection (`detectAxes`) and auto-calibration
  (`autoCalibrate`: labels → OCR → scale → cross-checked refs; OCR injected). `src/ocr/pool.ts` —
  Tesseract.js worker pool (app + benchmark); `src/workers/auto.worker.ts` runs the pipeline.
  `src/auto/trace/` — `traceLine`: one click on a series → its centreline/markers → points.
- `bench/axes/` — 70 generated charts + `real/manifest.json`, scored for detection and end-to-end
  calibration against `baseline.json`. `bench/lines/` — 140 charts (375 series) + real figures,
  scored for line tracing against its own `baseline.json`.
- `src/state/` — `doc.ts` (`DocState` + pure reducer), `history.ts` (undo/redo); `src/ui/` —
  helpers (view, drawing, loupe, snap, table/CSV, autosave, OCR, suggestions); `src/components/`.
- `e2e/` — Playwright specs; `fixtures/real/` (hand-labelled) and `fixtures/synthetic/`.
- `tsconfig.core.json` checks `src/core` + `src/auto` without the DOM lib; `.app` the UI; `.node`
  configs and unit tests; `.e2e` Playwright specs, scripts and the benchmark.

## Commands (npm only — not pnpm/yarn)

- `npm install` once; `npm run dev` serves http://localhost:5173 (launch.json `dev`; `preview`
  serves the build on :4173).
- `npm run build` — type-check + bundle in `dist/` (Tesseract's files go to `dist/tesseract/`).
  `BASE_PATH` (default `/`) sets Vite's `base` for `build`/`preview` only — never for dev or
  e2e, which assume `/`. `.github/workflows/deploy.yml` runs the gate (`verify`) and the privacy
  check (`privacy`, on a `BASE_PATH=/BMAnderson_GraphDigitizer/` build) on every push/PR; on
  `main`, `deploy` needs both and publishes that checked `dist/` to GitHub Pages
  (https://brianmanderson.github.io/BMAnderson_GraphDigitizer/).
- **Verification gate** — a change is done only when `npm run verify` passes: `typecheck`,
  `lint`, `test`, `bench:axes` (~8 s; exits 1 on any regression vs `bench/axes/baseline.json`),
  `bench:lines` (~15 s; same vs `bench/lines/baseline.json`) and `test:e2e`. Never ease a test,
  tolerance, fixture, corpus or baseline to make it pass.
- `test:e2e` needs `npx playwright install chromium` once and runs its own server on :5174.
- `npm run privacy:check` (not in `verify`; own CI job) builds, serves `dist/` on a free port
  and records every request of a scripted session — page and workers, over CDP — into
  `privacy-report.json`; exit 1 on any foreign origin, any request outside `BASE_PATH`, or if
  the worker requests were not seen. Honours `BASE_PATH` (in PowerShell: `$env:BASE_PATH=…`;
  Git Bash rewrites a leading `/` unless `MSYS_NO_PATHCONV=1`).

## The skills are the operational manual

Tracked in `.claude/skills/`; their descriptions say when to load them:

- `calibration-engine` — BEFORE changing `src/core/` or code that calls it: invariants and tests.
- `verify` — running the gate, reading failures, test-environment quirks (`America/New_York`).
- `digitizer-ui` — BEFORE changing `src/state`, `src/ui`, `src/components` or `e2e/`.
- `axis-detection` — BEFORE changing detection in `src/auto/` or `bench/axes/`.
- `auto-calibration` — BEFORE changing label finding, OCR, parsing or suggestions (`src/auto/`
  labels/parse/suggest/auto, `src/ocr`, the worker, the Auto-detect UI) or calibration scoring.
- `line-tracing` — BEFORE changing `src/auto/trace/` (`traceLine`, its fixed contract) or `bench/lines/`.

## Pitfalls

- When searching, exclude `node_modules/`, `dist/` and `.claude/worktrees/`.
- `src/core` and `src/auto` must stay DOM-free (workers import them); don't add the DOM lib.
- Dates are UTC unless the text carries a zone. Never `new Date(string)` or local getters in core.
- By design: `log10` ≡ `ln` in output; ambiguous dates (`03/04/2024`) are rejected; a suggestion is
  never applied without "Accept"; OCR runs offline from `/tesseract/` (never a CDN).
- UI says "line", the data model says `datasets` (no format bump). A Project schema change bumps
  `PROJECT_VERSION` and adds a migration (`src/core/projectFile.ts`).
- Integer pixel coordinates are pixel *centres* (SPEC → Pixel convention); keep it in fixtures.
- Windows: stop a running `npm run dev` before deleting `node_modules` or `dist`.
- Reloading the app restores its IndexedDB autosave; clear site data for a clean start.
- Colours are tokens in `src/index.css` with a `:root[data-theme='dark']` value; no hard-coded UI
  colours (the canvas is not themed — SPEC → Theme).
