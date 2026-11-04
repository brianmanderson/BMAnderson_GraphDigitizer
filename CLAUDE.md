# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A fully client-side graph digitizer: load a chart image, calibrate X/Y axes from two known
points each (linear, log10, ln, reciprocal, date/time), place points, export a table. Vite +
React + TypeScript (strict). Images never leave the browser.

- [docs/SPEC.md](docs/SPEC.md) — the source of truth: workflow, calibration math, data model,
  decisions. If a change alters a decision, update SPEC.md in the same change.
- [docs/prompts.md](docs/prompts.md) — the five build phases, run in order. Phase 1 (scaffold +
  calibration engine) is done.

## Layout

- `src/core/` — pure-TS calibration engine, **no DOM**: `scales.ts` (transforms + domains),
  `dates.ts` (UTC parse/format), `calibrate.ts` (affine fit, typed errors), `project.ts` (data
  model). Tests sit beside the code as `*.test.ts`.
- `src/App.tsx`, `src/main.tsx` — the UI (a placeholder until Phase 2).
- `fixtures/real/` — real journal figures with hand-labelled ground truth (`<name>.json`).
- `tsconfig.core.json` type-checks `src/core` without the DOM lib; `tsconfig.app.json` the UI;
  `tsconfig.node.json` configs and tests.

## Commands (npm only — not pnpm/yarn)

- `npm install` once; `npm run dev` serves on http://localhost:5173 (`.claude/launch.json` →
  `dev` for the Browser pane).
- `npm run build` — type-check + production bundle in `dist/`.
- **Verification gate** — a change is done only when this passes:
  `npm run typecheck && npm run lint && npm test`. Never ease a test, tolerance or fixture to
  make it pass. From Phase 4 on, `npm run bench:axes` must also not regress.

## The skills are the operational manual

Tracked in `.claude/skills/`; their descriptions say when to load them:

- `calibration-engine` — BEFORE changing anything in `src/core/` or code that calls it: the
  invariants (pixels stored, values derived; typed errors, never NaN/Infinity; UTC dates) and
  which tests prove them.
- `verify` — running the gate, reading failures, and the test-environment quirks (the suite
  runs in `America/New_York` on purpose).

## Pitfalls

- When searching, exclude `node_modules/`, `dist/` and `.claude/worktrees/`.
- `src/core` must stay DOM-free (workers in Phase 4–5 import it). `tsc` rejects DOM globals
  there and ESLint flags `window`/`document`; don't "fix" that by adding the DOM lib.
- Dates are UTC unless the text carries a zone. Never use `new Date(string)` or local-time
  getters in `src/core` — they depend on the host zone and DST.
- `log10` and `ln` give identical output by design (the fit absorbs the constant factor).
- Ambiguous numeric dates like `03/04/2024` are rejected on purpose, not a parser bug.
- Windows: stop a running `npm run dev` before deleting `node_modules` or `dist`.
