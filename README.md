# Graph Digitizer

Turn a chart image into numbers. Load a figure (drag, paste or open a file), crop it to one
panel if it has several, calibrate each axis from two known points — linear, log, reciprocal or
date/time, by hand or with **Auto-detect axes** (tick-label OCR) — click a plotted series to
trace it (the Data step's default), or place points by hand on one or more lines, and export
the table as CSV, TSV or a project file you can reopen later.

**Use it here:** https://brianmanderson.github.io/UCSD_GraphEvaluator/

Everything runs in your browser. Images never leave it: there is no upload, no server-side
processing, and OCR runs offline from files bundled with the app.

Built by Brian Anderson, UC San Diego. MIT licensed (see [LICENSE](LICENSE)).

## What the app fetches

Everything the app ever requests comes from the origin it is served from, and all of it is
code or static data shipped with the app:

- the page (`index.html`), its script bundle and stylesheet (`assets/index-*.js`, `assets/index-*.css`);
- the OCR glue chunk (`assets/ocr-*.js`), loaded on the first "Auto-detect axes";
- the detection/tracing module worker (`assets/auto.worker-*.js`), started for each auto-detect and auto-trace run;
- the vendored Tesseract.js files under `tesseract/`: the worker script (`worker.min.js`), one
  LSTM WASM core (`tesseract-core-*-lstm.wasm.js`, picked by CPU features) and the English
  language data (`eng.traineddata.gz`), requested from inside the OCR workers.

Nothing else: no analytics, no fonts, no CDN, no upload. Your image is read into memory, drawn
to a canvas and (for Save project) embedded in the project file as a `data:` URL; the CSV and
project downloads are `blob:` URLs created in the page.

- **Session log** (toolbar, "Session log"): a local `<image>-session.json` download of what was
  done with the current image — timed steps, edits, automatic-suggestion outcomes, exports — kept
  only in the tab's memory, never sent or stored, with no image data (docs/SPEC.md → Session log).

`npm run privacy:check` proves this on the production build, on the record: it builds, serves
`dist/` with `vite preview`, drives a full session in headless Chromium (load the real
Kaplan–Meier figure, Auto-detect axes with OCR, accept, Auto-trace the curve, accept, Download
CSV, Save project and Download session log) while recording every network request over the DevTools Protocol — from
the page *and* from every worker — and writes `privacy-report.json` (requests with origin,
target type, status and bytes; counts by origin; verdict). It exits 1 if any request leaves the
app's origin (`data:` and `blob:` excepted), if one fails, or if the worker-initiated Tesseract
requests were not captured. `-- --no-build` checks the `dist/` already there; `-- --out path`
moves the report. It needs `npx playwright install chromium` once and takes about half a
minute. It is not part of `npm run verify`; CI runs it as its own job (`privacy` in
`.github/workflows/deploy.yml`) and keeps the report as a build artifact.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run verify     # typecheck, lint, unit tests, benchmarks, e2e — the gate every change must pass
```

`npm run test:e2e` (part of `verify`) needs `npx playwright install chromium` once. `npm run
build` writes the production bundle to `dist/`; the GitHub Pages deployment builds it with
`BASE_PATH=/UCSD_GraphEvaluator/` (see `.github/workflows/deploy.yml`).

[docs/SPEC.md](docs/SPEC.md) is the source of truth for the workflow, the calibration maths, the
data model and the design decisions.

## Reproducing the benchmarks

The two benchmarks are part of `npm run verify` and gate every change against a committed
baseline:

```bash
npm run bench:axes              # axis/tick detection + auto-calibration (OCR), ~8 s
npm run bench:lines             # line tracing / find points, ~15 s
npm run bench:axes -- --verbose # per-image lines; --only c12,km for a subset
```

- `bench/axes/` scores `detectAxes` on 60 generated matplotlib charts (`synthetic/`, written by
  `npm run bench:axes:corpus`) and on the real figures in `bench/axes/real/manifest.json`: axes
  and plot box found, tick recall and precision, no ticks invented on axes without tick marks;
  then `autoCalibrate` end to end with Tesseract.js OCR (offline, from `node_modules`): axes
  calibrated correctly, never wrong at medium/high confidence, known values of the real figures.
  `bench/axes/baseline.json` holds the accepted numbers; the run exits 1 when any gated metric is
  worse, overall or in any category.
- `bench/lines/` scores `traceLine` from a seed on every series of 96 generated charts
  (`npm run bench:lines:corpus`) and of the real figures in `bench/lines/real/manifest.json`:
  kind, coverage, centreline error, wrong-series rate, step corners, marker recall/precision and
  wrong group, line style. Gated the same way against `bench/lines/baseline.json`.
- Detection and tracing are deterministic. **OCR is deterministic on one machine only**: on a
  different CPU Tesseract.js may pick a different WASM core and read a label slightly
  differently, so a small calibration change on a new machine is not necessarily a regression —
  compare the `Changed vs baseline` lines per image before concluding anything.
- The baselines are rewritten only with `-- --update`, for an explained improvement, trade-off
  or corpus change, and committed with the reason.
- Every real figure is a CC BY 4.0 journal figure; its source, licence, crop box, attribution and
  labelling are recorded in [fixtures/real/PROVENANCE.md](fixtures/real/PROVENANCE.md). The
  hand-labelled ground truth sits beside each image as `<name>.json`.

## Citing

If you use Graph Digitizer in published work, please cite it. The citation metadata is in
[CITATION.cff](CITATION.cff) (GitHub's "Cite this repository" renders it):

> Anderson BM. Graph Digitizer (version 1.0.0). University of California San Diego, 2026.
> https://github.com/brianmanderson/UCSD_GraphEvaluator. DOI: 10.5281/zenodo.PLACEHOLDER

The DOI is a placeholder until Zenodo mints one for the 1.0.0 release; `CITATION.cff` carries
the same placeholder and is updated with it.
