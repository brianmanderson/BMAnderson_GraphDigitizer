# Build Prompts

Run each phase in a **fresh Claude Code session** in this repo, in order. Review and merge each
phase before starting the next. Every prompt assumes [SPEC.md](SPEC.md) is the source of truth;
if a phase changes a decision, update SPEC.md in the same change.

| Phase | Delivers                                      |
|-------|-----------------------------------------------|
| 1     | Project scaffold + calibration engine + tests |
| 2     | Core digitizing UI (load → calibrate → points → table/export) |
| 3     | Zoom loupe & precision tools, undo, save/load |
| 4     | Axis-detection benchmark + axis/tick detection |
| 5     | Tick-label OCR, scale inference, auto-calibration UX |
| 6     | Same-colour series: line style (solid vs dashed) and "Find points" by marker shape |

---

## Phase 1 — Scaffold and calibration engine

```
Read docs/SPEC.md. We are building the graph digitizer it describes. This phase is the
foundation only: no UI beyond a placeholder page.

1. Scaffold a Vite + React + TypeScript (strict) app. Add Vitest, ESLint, and npm scripts
   `dev`, `build`, `typecheck`, `lint`, `test`.
2. Create a pure-TS module `src/core/` (no DOM imports) containing:
   - Scale types and their forward/inverse transforms (linear, log10, ln, reciprocal, date/time)
     with domain validation, exactly as in the SPEC table.
   - Date/time parsing and formatting (accept ISO 8601 and common forms like "2024-03-15",
     "2024-03-15 14:30"; UTC unless a zone is given).
   - `calibrate(refs, xScale, yScale)` implementing the affine fit in the SPEC, returning
     either a Calibration object with `pixelToValue` and `valueToPixel`, or a typed error
     explaining what is wrong (singular system, coincident points, equal values,
     out-of-domain value, reciprocal straddling zero).
   - The Project data model types from the SPEC.
3. Unit tests that prove it works, at minimum:
   - Round-trip pixel→value→pixel for every scale type.
   - Known synthetic charts: axis-aligned, rotated 5°, sheared, and flipped (y up vs down).
   - log10 and ln give identical results.
   - Every error case returns the right typed error, never NaN/Infinity.
   - Date axis across a DST boundary and a leap day.
4. Create a root CLAUDE.md (<60 lines) per my global repo-setup conventions: what the repo is,
   layout, build/run/verify commands, pitfalls. Point to docs/SPEC.md and docs/prompts.md.

Done when `npm run typecheck && npm run lint && npm test` passes and `npm run dev` serves the
placeholder page. Do not ease any test to make it pass.
```

## Phase 2 — Core digitizing UI

```
Read CLAUDE.md and docs/SPEC.md. The calibration engine in src/core/ exists and is tested.
Build the main digitizing workflow on top of it.

Layout: large canvas workspace (center), side panel with steps (Image → Axes → Data),
data table below or beside it. Keep it clean and usable on a 1366×768 laptop screen.

1. Image loading: file picker, drag-and-drop onto the workspace, and paste (Ctrl+V).
   Reject non-images with a clear message.
2. Canvas with a view transform: mouse-wheel zoom centred on the cursor, pan with
   space+drag or middle-drag, "fit to window" button. Stored coordinates are always image
   pixels; the view transform never touches them.
3. Calibration step: pick X and Y scale type, then place X1, X2, Y1, Y2 by clicking (guided:
   "Click a point on the X axis with a known value"). Each ref is a labelled, draggable
   marker with a value input beside it in the panel. Date/time axes get a text input that
   shows the parsed interpretation. Show calibration errors from the engine inline.
4. After a valid calibration, draw a faint overlay of the calibrated axes (via
   valueToPixel) so the user can sanity-check it against the image.
5. Data step: click to add a point to the active dataset, drag to move, click to select,
   Delete/Backspace to remove. Datasets: add, rename, recolour, delete, switch active.
   Show live (x, y) of the cursor position in a status bar.
6. Table: per dataset, columns #, X, Y; option to show pixel columns; option to sort by X;
   significant-figures setting; dates formatted per setting. Updates live when points move
   or the calibration changes.
7. Export: CSV download (one file, dataset column), copy as TSV to clipboard, JSON download
   of the full Project.
8. Add Playwright with 2–3 e2e tests using a committed synthetic chart image with known
   values: load → calibrate → place points → assert table values within tolerance.

Keep UI state and core logic separate: components call src/core, never reimplement math.
Done when the verification gate in CLAUDE.md passes, including the new e2e tests.
```

## Phase 3 — Zoom loupe and precision tools

```
Read CLAUDE.md and docs/SPEC.md. The core workflow works. This phase is about placing
points accurately and not losing work.

1. Magnifier loupe: a circular or square inset (configurable 2×–16×, default 6×) that
   follows the cursor while placing/dragging any point or ref, with a crosshair and the
   exact pixel under it. Auto-flip to the opposite corner when it would cover the cursor.
   Toggle with a key (e.g. Z) and a toolbar button. Render it from the source image (not
   the zoomed canvas) so it stays sharp at any main-view zoom; use nearest-neighbour
   sampling so pixel edges are visible.
2. Keyboard nudging: arrow keys move the selected point/ref by 1 image px, Shift+arrow by
   10 px, Alt+arrow by 0.1 px.
3. Optional snap: when enabled, a placed point snaps to the centroid of the nearest
   dark/coloured blob within a small radius (useful for scatter markers). Show the snap
   target before committing.
4. Undo/redo (Ctrl+Z / Ctrl+Shift+Z) covering point, ref, dataset, and scale changes.
5. Persistence: autosave the current project to IndexedDB (images are too large for
   localStorage) and restore on reload; "Save project" / "Open project" as a .json file
   with the image embedded.
6. Unit tests for the snap centroid logic and undo/redo reducer; an e2e test that places a
   point with the loupe and nudges it.

Done when the verification gate passes. Check the loupe manually in the browser at several
main-view zoom levels and on a high-DPI display setting.
```

## Phase 4 — Automation: benchmark and axis/tick detection

```
Read CLAUDE.md and docs/SPEC.md. We are starting to automate calibration. This phase
builds the measuring stick first, then the detector. Do not wire anything into the UI yet.

1. Test corpus in `bench/axes/`:
   - A generator script (Python + matplotlib is fine, run offline; commit the output) that
     produces ~60 charts with ground-truth JSON: plot-area box, axis lines, every tick
     pixel position and value, scale types. Vary: linear/log10/date axes, gridlines on/off,
     fonts, DPI, line/scatter/bar, light rotation (±3°), JPEG compression, and a few with
     axes not at the plot edge.
   - A folder for real-world scans with hand-labelled ground truth (start with whatever I
     provide; document the label format).
2. `src/auto/` (pure TS, runnable in a Web Worker):
   - Axis line detection: grayscale + adaptive threshold, then row/column dark-pixel
     projection profiles (and a Hough fallback for rotated images) to find the X and Y axis
     lines and the plot-area box.
   - Tick detection: short perpendicular segments along each axis; estimate regular
     spacing and reject outliers.
   - Output: candidate axes and ticks with a confidence score.
3. `npm run bench:axes`: runs the detector over the corpus and reports axis-line error (px),
   tick recall/precision, and failures by category. Write the first run's numbers to
   `bench/axes/baseline.json`; later changes must not regress it.

Done when the verification gate and the benchmark both run, with results summarised in the
PR description. Report honestly where detection fails — do not tune the corpus to the
detector.
```

## Phase 5 — Automation: label reading and auto-calibration

```
Read CLAUDE.md, docs/SPEC.md, and bench/axes/. Axis and tick detection exist and are
benchmarked. Now turn them into a suggested calibration.

1. Tick-label OCR with Tesseract.js (in a worker, lazy-loaded so it doesn't slow first
   paint): crop the region beside each detected tick, upscale, OCR with a numeric
   whitelist, and parse numbers including negatives, decimals, scientific notation
   (1e-3, 1×10⁻³, 10³ superscripts), thousands separators, and dates.
2. Match labels to ticks; pick the two most widely separated ticks with high-confidence
   labels per axis as X1/X2 and Y1/Y2.
3. Infer scale type per axis: linear if label values are evenly spaced in pixels, log10 if
   their logs are, date if they parse as dates; otherwise mark "uncertain".
4. Cross-check: fit the calibration, then predict every other labelled tick and reject the
   suggestion if residuals exceed a threshold.
5. Extend `npm run bench:axes` to score end-to-end calibration accuracy (value error at
   held-out ticks, scale-type accuracy) and update the baseline.
6. UI: an "Auto-detect axes" button in the Axes step. Show suggested refs as ghost markers
   with their values and a confidence badge; the user accepts, edits, or discards.
   Never apply a suggestion silently. Low confidence → fall back to the manual flow with
   whatever partial results are reliable (e.g. pre-filled axis lines).

Done when the verification gate and benchmark pass, and the PR description reports
per-category accuracy, including where it fails.
```

---

## Phase 6 — Same-colour series: line style and "Find points"

```
Read CLAUDE.md, docs/SPEC.md (Auto-trace and Auto-trace — UI) and load the skills
line-tracing, digitizer-ui and verify before touching code. Work on a new branch; do not
commit to main.

Goal: extend Auto-trace so it tells apart series that share a colour, in two cases.
Test images (journal figures, untrusted downloads; copy the ones you use into the repo,
don't run anything from that folder): C:\Users\BRA008\Downloads\Vitali
  - "Takata fig 1.jpg": two black KM-style step curves, solid (TFT, plateau ≈0.82) and
    dashed (FFT, plateau ≈0.78), interleaving and overlapping from 0–12 months.
  - "Graph.png": two groups of black circles, filled (3 months) and open (12 months),
    with vertical and horizontal error bars and caps, a dashed reference line at y=25
    crossing a filled marker near x≈20, filled/open pairs overlapping near x≈52 and x≈61,
    markers touching the x axis near y≈3–5, and legend samples in a box.
  - Pao fig 1/3 (black vs grey), Takeuchi fig 1/3 (censor ticks on steps; fig 1 is already
    fixtures/real/km-pericardial-effusion.jpg) and Xue fig 1 are extra trial images: they
    must not get worse.

Before designing anything, measure the current behaviour: run traceLine on Takata
(seed on each line, in the overlap and on the plateau) and on Graph.png (seed on a
filled and an open marker, mode markers and auto), draw overlays as the line-tracing skill
describes (scripts in the scratchpad), and write down the failure modes you actually
see. Design from those, not from this prompt's guesses.

Part A — line style (solid vs dashed/dotted)
1. Classify the clicked series' style at the seed (solid / dashed / dotted / dash-dot)
   from the on/off profile along the stroke (dash and gap length, period), robust to
   JPEG and to the short vertical drops of a step curve.
2. Use the style as a constraint while tracing: at overlaps, crossings and retry forks,
   prefer the continuation whose ink matches the seed's style signature, so clicking the
   solid Takata line returns only TFT and clicking the dashed one returns only FFT, with
   their step corners.
3. Report the style in TraceResult (e.g. `style: 'solid' | 'dashed' | 'dotted' |
   'dash-dot' | 'unknown'`). This is a contract change: update types.ts and SPEC →
   Auto-trace in the same change, and show it in the trace panel (digitizer-ui rules; no
   hard-coded colours).
4. Benchmark: append a generator scenario (new charts after the last existing one; earlier
   charts must stay byte-identical) with same-colour solid+dashed (and solid+dotted) pairs:
   KM steps that start together, crossing smooth curves, close plateaus, JPEG and low DPI.
   Add Takata fig 1 to bench/lines/real with measured knownValues plateaus for both
   series. Add a gated style-accuracy metric and make sure wrong-series rate is reported
   for the new category.

Part B — "Find points" (same-colour markers by shape)
1. Clicking one marker finds every marker of the same appearance (shape, filled vs open,
   size) and only those: in Graph.png one click on a filled circle gives every 3-month
   point, one on an open circle every 12-month point. Output centroids = marker centres.
2. Separate markers from thin strokes attached to them (error bars, caps, reference lines,
   axes, gridlines) before matching, e.g. by stroke width, not by colour. Handle
   overlapping filled/open pairs and markers clipped by the axis. Legend samples should be
   excluded or flagged (pick one, document it in SPEC).
3. Prefer extending the existing `markers` mode/markers.ts over a parallel engine. Make it
   a clear, one-click option in the Data step (e.g. a "Find points" action or a renamed
   mode); decide the UI with the digitizer-ui skill and record the decision in SPEC.
   Suggestions are applied only on Accept, as now.
4. Reading error-bar values is a non-goal for now; list it under SPEC → Non-goals or
   Possible later phases.
5. Benchmark: append scatter scenarios with same-colour filled vs open markers (circle,
   square, triangle), vertical and horizontal error bars with caps, overlapping pairs, a
   dashed reference line, legend. Add Graph.png to bench/lines/real with full marker truth
   for both groups (centres measured to ±1 px). If the truth format can't express a
   scatter-only series yet, extend truth.ts and document it. Gate marker recall/precision
   and a wrong-group rate.

Rules
- Engine stays pure TS and worker-safe; pixel-centre convention everywhere.
- Never tune the corpus, seeds, scoring or baseline to make a trace pass. Fix the engine or
  document the failure under SPEC → Auto-trace → Known failures. Rebaseline only for
  improvements or explained trade-offs, and say why in the commit.
- Run both benches (a plot-box change moves bench:lines).
- Each part is its own commit (or PR) and is done only when `npm run verify` passes.
  Include an e2e test per part using the new fixtures.
- At the end, report for each test image: before/after overlays, what's fixed, what still
  fails and why.
```

---

## Possible later phases

- Automatic curve/marker extraction by colour (pick a colour → sample points along the curve).
- PDF import (render a page with pdf.js, then digitize).
- An optional vision-LLM fallback for auto-calibration when OCR confidence is low — needs a
  backend to hold an API key and changes the "images never leave the browser" guarantee, so
  make it explicit opt-in.
