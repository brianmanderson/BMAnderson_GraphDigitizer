---
name: verify
description: >
  How to run and interpret this repo's verification gate (npm run typecheck && npm run lint &&
  npm test && npm run test:e2e, i.e. npm run verify) and the dev server. Load it BEFORE declaring any change done, when the gate fails,
  when a date test behaves differently on another machine, or when starting the app to check a
  change by eye. Skipping it means declaring work done without the gate, or "fixing" a failure
  by easing a test, which the owner forbids.
---

# Verify a change

## The gate

```
npm run typecheck && npm run lint && npm test && npm run test:e2e
```

`npm run verify` runs exactly this. All four must pass before a change is done. Never ease a test, tolerance, fixture or lint rule
to get there; fix the code. From Phase 4 on, also `npm run bench:axes` (must not regress against
`bench/axes/baseline.json`).

- `typecheck` is `tsc -b` over three projects: `tsconfig.core.json` (src/core, no DOM lib),
  `tsconfig.app.json` (UI), `tsconfig.node.json` (vite/eslint configs and `*.test.ts`). A
  "Cannot find name 'document'" error in src/core means DOM code crept into the engine — move it
  out, don't add the DOM lib.
- `lint` runs with `--max-warnings 0`; warnings fail the gate too.
- `test` is `vitest run` over `src/**/*.test.ts` (engine, reducer, UI helpers). Focus with
  `npx vitest run src/core/dates.test.ts` or `-t "<name>"`.
- `test:e2e` is `playwright test` (Chromium, 1366×768) over `e2e/*.spec.ts`. First time on a
  machine: `npx playwright install chromium`. It starts `npm run dev` on port **5174** (reusing
  one already there), so a dev server on 5173 doesn't interfere. Focus with
  `npx playwright test e2e/real-km.spec.ts`; on failure read
  `test-results/<test>/error-context.md` or `npx playwright show-trace <trace.zip>`.

## Test-environment quirks

- `vite.config.ts` sets `TZ=America/New_York` for the test workers, so date tests run on a
  DST-observing host. A test asserts this took effect; if it fails, Node ignored `TZ`, and the
  DST tests would be proving nothing.
- Synthetic-chart tests use a seeded PRNG, so failures reproduce exactly.
- Fixture JSON is imported directly (`resolveJsonModule` in `tsconfig.node.json`).

## e2e quirks

- Specs click at image pixels via `imageToClient()` in `e2e/helpers.ts`, which reads the view
  transform from the canvas's `data-scale` / `data-offset-x` / `data-offset-y`. Keep those
  attributes if you change the canvas.
- Clicks land within ~0.5 CSS px, so value tolerances are derived from px-per-unit at the fitted
  zoom (comments in each spec). A tolerance miss means a real offset — e.g. a broken pixel
  convention — not flakiness.
- The Windows clipboard reads back CRLF; compare clipboard text with `split(/?
/)`.
- Drop and paste are simulated with a `DataTransfer` in the page (`dropFile`, `pasteFile`).

## Seeing it run

`npm run dev` → http://localhost:5173, or `preview_start` with the `dev` entry in
`.claude/launch.json`. Check the console for errors. In the Browser pane, load a fixture by
fetching `/fixtures/...` in the page and dispatching a `drop` on `[data-testid=workspace]`
(the dev server serves the repo root). If the pane isn't painting, screenshots can be stale and
the first auto-fit waits for a resize: read state with `get_page_text` instead. Stop the server before deleting
`node_modules`/`dist` on Windows (file locks).

## Proving a new test can fail

When adding a test for a fix, break the code briefly (or check out the parent commit) and
confirm the test fails, then restore. A test that passes on first run against new code has not
yet shown it can catch anything.
