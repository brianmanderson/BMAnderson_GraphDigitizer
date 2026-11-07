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
