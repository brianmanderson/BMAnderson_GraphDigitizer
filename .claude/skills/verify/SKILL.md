---
name: verify
description: >
  How to run and interpret this repo's verification gate (npm run verify: typecheck, lint,
  unit tests, the bench:axes detection and bench:lines tracing benchmarks, e2e) and the dev server. Load it BEFORE declaring any change done, when the gate fails,
  when a date test behaves differently on another machine, or when starting the app to check a
  change by eye. Skipping it means declaring work done without the gate, or "fixing" a failure
  by easing a test, which the owner forbids.
---

# Verify a change

## The gate

```
npm run typecheck && npm run lint && npm test && npm run bench:axes && npm run bench:lines && npm run test:e2e
```

`npm run verify` runs exactly this. All six must pass before a change is done. Never ease a
test, tolerance, fixture, lint rule, corpus or baseline to get there; fix the code.

- `typecheck` is `tsc -b` over three projects: `tsconfig.core.json` (src/core, no DOM lib),
  `tsconfig.app.json` (UI), `tsconfig.node.json` (vite/eslint configs and `*.test.ts`). A
  "Cannot find name 'document'" error in src/core means DOM code crept into the engine — move it
  out, don't add the DOM lib.
- `lint` runs with `--max-warnings 0`; warnings fail the gate too.
- `test` is `vitest run` over `src/**/*.test.ts` (engine, detector, reducer, UI helpers). Focus
  with `npx vitest run src/core/dates.test.ts` or `-t "<name>"`.
- `bench:axes` (~8 s) runs `src/auto` — detection and auto-calibration with Tesseract.js OCR (4
  Node workers, language data from node_modules, no network) — over `bench/axes/` and exits 1 when
  any gated metric, overall or in any category, is worse than `bench/axes/baseline.json`; it lists
  per-image changes. Use `-- --verbose` for per-image lines, `-- --only c12,km` to focus.
  Regressions and baseline updates: load `axis-detection` (detection table) or
  `auto-calibration` (calibration table).
- `bench:lines` (~15 s) runs `traceLine` from the truth seed of every series in `bench/lines/`
  and exits 1 when any gated metric (kind, coverage, centreline error, wrong series, corners,
  markers), overall or per category, is worse than `bench/lines/baseline.json`. Same flags as
  bench:axes (`--verbose`, `--only l31,km`, `--update`). Load `line-tracing` for regressions.
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
- The Windows clipboard reads back CRLF; compare clipboard text with `split(/\r?\n/)`.
- Drop and paste are simulated with a `DataTransfer` in the page (`dropFile`, `pasteFile`).
- `auto-detect.spec.ts` runs real OCR in the browser (first run loads Tesseract, so it waits up to
  60 s), aborts every non-localhost request and asserts none happened. Two inputs share a name
  prefix there (`X1 value` and `Suggested X1 value`): use `getByLabel(…, { exact: true })`.
- `precision.spec.ts` runs one test at `deviceScaleFactor: 2` and compares loupe pixels with the
  source image exactly (any smoothing or off-by-one mapping fails it). Undo specs scope the
  toolbar Undo to the `History` group because a notice can carry its own "Undo" button.
- Autosave tests wait by polling IndexedDB (`readAutosave()` in helpers) before reloading, not
  by sleeping. Downloads are saved under `test.info().outputPath(suggestedFilename)` before
  re-opening, since the temp download path has a GUID name.

## Seeing it run

`npm run dev` → http://localhost:5173, or `preview_start` with the `dev` entry in
`.claude/launch.json`. Check the console for errors. In the Browser pane, load a fixture by
fetching `/fixtures/...` in the page and dispatching a `drop` on `[data-testid=workspace]`
(the dev server serves the repo root). If the pane isn't painting, screenshots can be stale and
the first auto-fit waits for a resize (press F): read state with `get_page_text` instead. Reloads
restore the last autosave (IndexedDB); to check Save project without writing to Downloads,
capture the blob by patching `HTMLAnchorElement.prototype.click` in the page. Stop the server before deleting
`node_modules`/`dist` on Windows (file locks).

## Proving a new test can fail

When adding a test for a fix, break the code briefly (or check out the parent commit) and
confirm the test fails, then restore. A test that passes on first run against new code has not
yet shown it can catch anything.
