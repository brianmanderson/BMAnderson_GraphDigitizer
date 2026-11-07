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
