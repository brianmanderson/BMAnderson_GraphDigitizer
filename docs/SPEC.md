# Graph Digitizer — Project Spec

The durable reference for every build phase. Phase prompts live in [prompts.md](prompts.md).

## Purpose

A browser app that extracts numeric data from an image of a chart. The user loads a graph
image, calibrates the axes by marking two known points on each, places data points on the
curve/markers, and gets a table of real-world (x, y) values they can export.

Functionally similar to tools like plotdigitizer.com or WebPlotDigitizer, but an original
implementation — do not copy their branding, layout, or assets.

## Core user workflow

1. **Load image** — file picker, drag-and-drop, or paste from clipboard (PNG/JPG/GIF/WebP/BMP).
2. **Choose axis scales** — independently for X and Y: `linear`, `log10`, `ln`, `reciprocal`,
   `date/time`.
3. **Calibrate** — click 4 reference points: X1, X2 (points with known x values) and Y1, Y2
   (points with known y values), then type the value for each.
4. **Digitize** — click to place data points; drag to move; select + delete; multiple named,
   colour-coded datasets.
5. **Output** — live table of (x, y) per dataset; export CSV, copy as TSV (pastes into Excel),
   download JSON.

## Calibration math (the correctness core)

Each scale has a forward transform `f` (value → linear space) and inverse `f⁻¹`:

| Scale      | f(v)        | Domain rule                                   |
|------------|-------------|-----------------------------------------------|
| linear     | v           | any                                           |
| log10      | log10(v)    | v > 0                                         |
| ln         | ln(v)       | v > 0                                         |
| reciprocal | 1/v         | v ≠ 0; calibration values must not straddle 0 |
| date/time  | epoch ms    | parseable date/time; UTC unless a zone is given |

Note: `log10` and `ln` produce identical (x, y) output because they differ only by a constant
factor, which the affine fit absorbs. Keep both options for user familiarity; a unit test
should assert they agree.

**Pixel → value mapping.** Fit an affine map from image pixels (px, py) to linear space (u, w),
where u = fx(x), w = fy(y):

```
u = a·px + b·py + c      w = d·px + e·py + g
```

Constraints (3 equations per coordinate → solve two 3×3 systems):

- u(X1) = fx(x1),  u(X2) = fx(x2),  u(Y1) = u(Y2)   ← Y refs share one x value
- w(Y1) = fy(y1),  w(Y2) = fy(y2),  w(X1) = w(X2)   ← X refs share one y value

Then value = (fx⁻¹(u), fy⁻¹(w)). This handles rotated, skewed, and non-square scans; image
y grows downward and the fit absorbs that. Also expose the inverse (value → pixel) for drawing
overlays. Reject degenerate calibrations (singular system, coincident points, X2 = X1 values,
out-of-domain values) with a clear message instead of producing NaN/Infinity.

**Engine contract (decided in Phase 1, `src/core/`).**

- Scale ids: `linear`, `log10`, `ln`, `reciprocal`, `date` (shown as "Date/time").
- Ref values: a number, or text. On numeric scales text must be a plain number (`" 2.5 "`,
  `"1e-3"`). On `date` axes text is parsed as a date/time; a number is taken as epoch ms.
- `calibrate(refs, xScale, yScale)` returns `{ ok: true, calibration }` or
  `{ ok: false, error }`. Error kinds, checked in this order: `invalid-pixel` (non-finite ref
  position), `invalid-value` (unparseable text, NaN/±Infinity), `out-of-domain`,
  `reciprocal-straddles-zero`, `equal-values` (equal after the scale transform, e.g.
  `2` and `"2.0"`), `coincident-points` (the two refs of one axis < 1e-6 px apart; X1 and Y1
  may share a pixel — the usual origin), `singular-system` (X-ref and Y-ref directions within
  sin θ < 1e-9 of parallel), `numeric-overflow` (values so extreme the coefficients are not
  finite). Each error carries a user-facing `message`.
- `pixelToValue` returns `{ x, y }` with a component `null` where the scale cannot represent the
  value (reciprocal at u = 0, log overflow, dates beyond ±8.64e15 ms). `valueToPixel` returns
  `null` for out-of-domain values. Neither ever returns NaN/Infinity.

**Dates.** Parsed to epoch ms, UTC unless the text carries a zone (`Z`, `UTC`, `GMT`, `±HH`,
`±HHmm`, `±HH:mm`); the host time zone is never used, so DST cannot shift values. Accepted:
`2024-03-15`, `2024/03/15`, `2024.03.15`, `2024-03`, `2024`, each date form + `[T ]HH:mm[:ss[.fff]]`
with optional `AM/PM` and zone, `15 Mar 2024`, `15-Mar-2024`, `Mar 15, 2024`, `March 15th 2024`,
`Mar 2024`, and numeric `DD/MM/YYYY` or `MM/DD/YYYY` **only when unambiguous** (one part > 12, or
both equal) — `03/04/2024` is rejected as ambiguous. `2024.5` is rejected (it reads as a decimal
year). Named zones other than UTC/GMT (`EST`, `CET`) are rejected as ambiguous. Formatting uses
tokens `YYYY MMM MM DD HH mm ss SSS` (UTC) with `[literal]` text.

## Data model

```ts
Project {
  version: 2                               // schema version, for saved projects
  image: { dataUrl, width, height, name }
  calibration: {
    xScale, yScale,                        // ScaleType
    refs: { X1, X2, Y1, Y2 }               // each { px, py, value: number | string }
  } | null
  draftCalibration?: {                     // version 2+: only while calibration is null
    xScale, yScale, refs: { X1?, X2?, Y1?, Y2? }
  }
  datasets: [{ id, name, color, points: [{ id, px, py }] }]
  settings: { significantFigures, dateFormat }   // defaults: 4, 'YYYY-MM-DD HH:mm'
}
```

Types live in `src/core/project.ts`. **Versions and migration (decided in Phase 3).** Version 1
(Phase 2's JSON export) had no `draftCalibration`; version 2 adds it so a project saved
mid-calibration keeps its scales and placed refs. `parseProject` (`src/core/projectFile.ts`)
reads untrusted JSON (opened files and autosaves): it runs the migrations from the file's version
up to `PROJECT_VERSION` (1 → 2 is the identity), validates every field and names the first
damaged one (`datasets[0].points[3].px must be a finite number`), drops unknown fields, falls
back to default settings, and refuses files from a newer version. Any future schema change bumps
`PROJECT_VERSION` and adds a migration plus a test.

Points are stored in **image pixel coordinates (sub-pixel floats)**; values are always derived.
Re-calibrating or changing a scale type must update the table instantly without moving points.

**Pixel convention (decided in Phase 2).** Integer coordinates are pixel *centres*: pixel column
`i` spans `[i − ½, i + ½)`, so the image's outer edges are at −½ and `width − ½`. This matches
how `fixtures/real/*.json` labels pixels (column 134 = the axis line's column) and makes "the
pixel under the cursor" `Math.round(px)` for the Phase 3 loupe. A uniform shift would cancel in
the affine fit anyway; the convention only matters for display and fixtures.

**Project ↔ editor state.** The UI edits a `DocState` (`src/state/doc.ts`): the Project plus
what it cannot hold yet — refs placed so far (as typed text), the chosen scales, and the active
dataset. `toProject` sets `calibration` only once all four refs are placed (values may still be
invalid; `calibrate()` reports that), and otherwise writes `draftCalibration` (the scales and the
refs placed so far); it stores numeric ref text as numbers on numeric axes and date text as
typed. `fromProject` inverts it (numeric text comes back normalised, e.g. `1e3` → `1000`). The
active dataset is not part of the Project; the autosave carries it beside the Project.

## Technical decisions

- **Fully client-side.** Images never leave the browser (research data may be unpublished).
  Static build, deployable anywhere.
- Vite + React + TypeScript (`strict`). Rendering on `<canvas>` with an explicit view transform
  (image ↔ screen) so pan/zoom never alters stored coordinates.
- Calibration/transform code is pure TypeScript with no DOM dependencies, in its own module.
- Tests: Vitest for logic; Playwright for a small set of end-to-end flows (added in Phase 2;
  Phase 3 adds a 2× device-pixel-ratio run for the loupe).
- Automation (Phases 4–5): hand-rolled image analysis in TS/Web Workers first; Tesseract.js
  for OCR. Pull in OpenCV.js only if a benchmark shows the simple approach is insufficient
  (Phase 4: it did not — see below).

## Digitizing UI (decided in Phase 2)

- **Layout** (fits 1366×768): toolbar (open, zoom −/+/%, Fit; Phase 3 adds project open/save,
  undo/redo and the precision toggles, and lets the toolbar wrap on narrow windows) · canvas workspace · 360 px side
  panel with step tabs Image → Axes → Data, the step's controls, and the live table with export
  buttons below · status bar with the cursor's pixel and (x, y).
- **Loading**: file picker, drop onto the workspace, or paste anywhere. Any `image/*` that the
  browser decodes is accepted except SVG (vector input is a non-goal); others are rejected with
  a message naming the file. Loading starts a fresh document (settings are kept); since Phase 3
  it is an undo step instead of asking first (see below).
- **View**: `screen = image · scale + offset` (`src/ui/view.ts`), zoom 5 %–6400 % about the
  cursor (wheel) or the centre (buttons), pan with middle-drag or Space+drag, `F`/Fit. Image
  smoothing is off from 3× so pixel edges show. The view never touches stored coordinates.
- **Step-scoped markers**: refs can be placed/dragged only in the Axes step and points only in
  the Data step, so a click in one step never moves the other's markers. In Axes, a *click* on an
  existing ref still places the pending one (X1 and Y1 usually share the origin); a *drag* moves
  it. Placement and drags are limited to the image area.
- **Calibration UX**: guided order X1 → X2 → Y1 → Y2; after a click the value input takes focus.
  "Move" re-places a ref; Delete on a selected ref clears it. Blank values prompt ("Type the
  known value…"); otherwise the engine's error message is shown verbatim. Date inputs show the
  parsed UTC interpretation or the parser's message.
- **Overlay**: after a valid fit, dashed gridlines at round values plus the two calibrated axis
  lines, drawn through `linearToPixel` and clipped to the image. Ticks (`src/ui/ticks.ts`) are
  1-2-5 steps for linear, decades for log, values between the refs for reciprocal when the image
  reaches 1/v = 0, and fixed millisecond steps for dates (not calendar-aligned months/years — it
  is a sanity check, not an axis renderer).
- **Datasets**: always at least one; new ones get the next unused name/colour and become active.
  Deleting a dataset is an undo step (no prompt since Phase 3). Selecting another dataset's point
  makes that dataset active.
- **Table**: one section per dataset; `#` is the placement number and stays with its point
  when sorting by X (rows without an x value sort last). Unrepresentable values (`null`) show as
  "—". Significant figures (default 4) and the date format are Project settings; "Sort by X"
  and "Pixel columns" are session view options.
- **Exports follow the table view** (sort, pixel columns, significant figures, date format):
  one CSV for all datasets with a `dataset` column (RFC 4180, CRLF, `<image>-data.csv`); the same
  cells as TSV on the clipboard (LF; tabs/newlines in cells become spaces); the full Project as
  JSON including the image data URL (`<image>-project.json`). Blank cells for `null` values.

## Precision tools and persistence (decided in Phase 3)

- **Loupe** (`src/ui/loupe.ts`): a 180 CSS px square inset in the workspace's top-left corner,
  flipping to the top-right when the point it shows is within 24 px of being covered. It ignores
  the pointer (`pointer-events: none`), so it can never swallow a click. It shows the cursor while
  a click would place something (Axes with a ref pending, Data step) or grab a marker, the marker
  being dragged (centred on the marker, not the cursor), and the selection right after a keyboard
  nudge (until the mouse moves). It copies the decoded source image nearest-neighbour, so pixels
  stay sharp at any main-view zoom. **Magnification is relative to the main view** (2×–16×,
  default 6×: image pixels look six times larger than on the canvas), rounded to a whole number of
  device pixels per image pixel (crisp edges on high-DPI screens) and capped so at least 5 image
  pixels stay visible. A thin translucent crosshair (with a gap, so the line being aligned stays
  visible) marks the exact position; the pixel under it (`Math.round`) is outlined and named in
  the caption. Existing markers and the snap target are drawn in it. `Z` or the toolbar toggles it.
- **Nudging** (`src/ui/nudge.ts`): arrow keys move the selection 1 image px, Shift 10, Alt 0.1
  (Alt wins over Shift); refs only in Axes, points only in Data (same rule as dragging); clamped
  to the image and rounded to 1e-6 px so repeated 0.1 px steps don't drift. Ignored while a form
  field has focus. Alt+← is prevented from navigating back.
- **Snap** (`src/ui/snap.ts`): off by default (`S` or the toolbar). It applies only to *new*
  points in the Data step — never to drags, nudges or refs. Algorithm: background = median colour
  of a window border; seed = nearest ink pixel within 12 CSS px, moved onto stronger shades of its
  own colour; blob = pixels 8-connected to it that are at least half covered by that colour
  (so a marker separates from a connecting line of another colour); centroid weighted by coverage
  (sub-pixel). A blob wider or taller than 48 CSS px is a line/curve/axis/text, so there is no
  snap. That is what keeps step lines safe: the Kaplan–Meier '+' censoring marks share the
  curve's colour and touch it, so clicks on the curve land exactly where clicked. Hovering shows
  the target (dashed ring in the view, ring and caption in the loupe) before the click commits.
- **Undo/redo** (`src/state/history.ts`): whole-document snapshots wrapped around `appReducer`,
  200 steps. Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, and toolbar buttons; they act on the app history even
  inside text fields (every edit is in it). Consecutive edits with the same group key are one
  step: a drag (pointerdown → pointerup), typing into one field (ref value, dataset name, colour,
  settings), and repeated presses of one nudge key+modifier. Switching the active dataset is not a
  step. Loading an image and opening a project are steps. The history is not persisted;
  restoring an autosave starts a fresh one.
- **Prompts → Undo notices**: replacing work (load/open over refs or points) and deleting a
  dataset no longer ask; a notice says what happened and offers Undo, shown only while that
  action is still the newest step. Caveat: the autosave then holds the new state, so after a
  reload the replaced work is gone unless it was saved as a project file.
- **Autosave** (`src/ui/autosave.ts`): IndexedDB database `graph-digitizer`, store `autosave`,
  key `current`: `{ project: toProject(doc), activeDatasetId, savedAt }`, written 400 ms after
  the last change and on `pagehide`/tab hidden. On start it is read through `parseProject` and
  restored unless the user already loaded something; the step becomes Data when the restored
  calibration fits, else Axes; the view is re-fitted. One autosave per browser profile (the last
  tab to write wins). The status bar shows the last save time or a failure.
- **Project files**: "Save project" (Ctrl+S) downloads `<image>-project.json`, the same file as
  "Download JSON". "Open project…" (Ctrl+O), or dropping/pasting a `.json`, reads it through
  `parseProject`, checks that the embedded image decodes to the stated size, and replaces the
  document as an undo step. Plain downloads, not the File System Access API (Chromium-only).
- **Preferences** (loupe on/off and zoom, snap) are remembered per browser in `localStorage`;
  they are not part of the project.

## Axis detection and benchmark (decided in Phase 4)

- **Module**: `src/auto/` — pure TS, no DOM (checked by `tsconfig.core.json` and ESLint like
  `src/core`), so Phase 5 can run it in a Web Worker. `detectAxes({ width, height, data })` takes
  RGBA bytes and returns the skew angle, the X/Y axis lines (sub-pixel offset, ends, contrast,
  thickness, confidence), the plot box (four corners; whether top/right are drawn frame lines),
  per-axis tick sets and the strongest line candidates. Not wired into the UI in Phase 4.
- **Pipeline**: adaptive darkness (pixel darker than the local mean over ~1/40 of the short side;
  ink ≥ 24/255) → skew from a ±5° Hough over ink pixels (sum of squared bins; snapped to 0 unless
  clearly better), refined once from the median tilt of the longest fitted lines → per row/column
  of the skew-corrected frame, the **longest gap-bridged ink run** (text never forms one) →
  bands → sub-pixel offset = median of clean cross-profile centroids → axis pair = strong
  horizontal × vertical candidates that meet with the plot above/right (L corner or cross),
  ranked by strength, extent and tick evidence → plot box to the far axis ends or a frame line of
  similar darkness. This is the prompt's "projection profiles + Hough fallback": the Hough only
  estimates the angle; profiles run in the rotated frame. OpenCV.js was not needed.
- **Ticks**: short perpendicular marks on both sides of each axis (adjacent columns summed for
  thin antialiased ticks; a walk ends where darkness halves, so a tick doesn't run into a lighter
  gridline; longer runs and blobs wider than a tick are not ticks); a lattice fit picks evenly
  spaced majors (tolerance max(1.2 px, 7 % of the spacing), which also absorbs month-length
  jitter on date axes); shorter marks between them are minors; minors at log10(2…9) of each
  interval give `pattern: 'log'` (a scale hint for Phase 5). **Fewer than three majors without
  three minors to back them means no ticks and confidence 0** — an axis with labels only must not
  get invented ticks. Confidences are heuristics in 0–1 (documented in `ticks.ts`/`detect.ts`).
- **Corpus** (`bench/axes/`): 60 matplotlib charts from `generate.py` (seeded; Python 3.12 +
  matplotlib 3.10; output committed, ~1.5 MB) varying scale (linear/log10/date), gridlines,
  12 fonts, 72–200 DPI, line/scatter/bar, frame (box, L, axes through zero, ggplot-style with no
  axis lines), tick direction and length, minor and mirrored ticks, x labels without tick marks,
  grey axes, rotation ±0.5–3° (bilinear, white fill) and JPEG q30–90. Agg pixel snapping is off so
  ground truth is exact (snapping moved lines by up to 1 px); about half the charts are "crisp"
  (spines placed on pixel centres, odd whole-pixel widths). A self-check fails generation if a
  drawn axis is > 0.35 px from its label. Real figures are listed in `bench/axes/real/manifest.json`
  (label format: `bench/axes/truth.ts`; the `fixtures/real/` JSON are valid labels).
- **Metrics** (`npm run bench:axes`, ~5 s): an axis is *found* when the detected line is within
  2 px of the true line at both ends; a plot box when every corner is within 4 px; ticks match
  within 2 px along the axis (4 px across); tick recall counts major ticks on axes with tick
  marks, precision all reported ticks there; `bare` counts ticks reported on axes without tick
  marks (must stay 0). Reported overall and per tag (scale, kind, frame, DPI, JPEG, rotation…).
- **Regression gate**: `bench/axes/baseline.json` holds the metrics of the accepted detector
  (timings excluded). `bench:axes` exits 1 when axes-found, box-found, tick recall, minor recall
  or precision drops — or `bare` rises — overall or in any category; it is part of `npm run verify`.
  `-- --update` rewrites the baseline, only for an explained improvement or trade-off.
- **Phase 4 baseline** (62 images: 60 synthetic, 2 real): axes found 95.2 % (all but the three
  ggplot-style charts), median line error 0.02 px, plot box 95.1 %, major-tick recall 85.2 %,
  minor 67.7 %, precision 99.3 %, no ticks on bare axes. Real figures: `km-pericardial-effusion`
  both axes exact, 13/13 ticks; `km-cns-lymphoma` (SAS, closed frame, number-at-risk table inside
  it) lines within 0.02 px, 12/12 ticks, no false ticks, box within 0.4 px. Known failures:
  no drawn axis lines (ggplot), ticks hidden by bars or shorter than a thick axis line (bar
  charts 62.5 % recall), the tick at a corner (inside the other axis), log axes with two decades
  and invisible minors (no ticks), box corners at free axis ends off by half the line width when
  lines have projecting caps.
- **KM label correction**: pixel analysis in Phase 4 found very faint 3-px x tick marks (grey
  ~170–200) at every label of `fixtures/real/km-pericardial-effusion.jpg`, which had been labelled
  "no x tick marks"; the label now says `tickMarks: true` (positions unchanged, within 1 px).
  The labels-only case is covered by five synthetic charts (`x-no-tickmarks`).
- **"Axis line" means the line the tick marks hang on**, not where the value 0 is. In a closed
  frame whose zero sits inside it (`km-cns-lymphoma`), the detected X/Y axes are the bottom and
  left frame lines; that is correct, and Phase 5 must calibrate from tick positions + labels,
  never assume the axis line is value 0. Labels encode this the same way (`axisLineRow/Col`).

## Verification gate

A change is done only when this passes (commands defined in Phase 1, extended later):

```
npm run typecheck && npm run lint && npm test && npm run bench:axes && npm run test:e2e
```

`npm run verify` runs all five. `test:e2e` (Playwright, Chromium, added in Phase 2) starts its own
dev server on port 5174. `bench:axes` (Phase 4) fails on any regression against
`bench/axes/baseline.json` (see above).

## Non-goals (for now)

PDF/vector import, automatic curve tracing, polar/ternary/map axes, accounts or cloud storage.

## Test fixtures

`fixtures/real/` holds real-world figures with hand-labelled ground truth (`<name>.json`
beside each image). Use them in e2e tests (Phase 2+) and the axis benchmark (Phase 4+, listed in
`bench/axes/real/manifest.json`). Label from measured pixels, including whether tick marks exist.

`fixtures/synthetic/` holds generated charts with exact geometry (linear scatter; date × log10)
and their ground truth, written by `npm run fixtures:synthetic`
(`scripts/make-synthetic-charts.ts`, renders in Playwright's Chromium). Regenerate only when
changing the generator, and commit the PNG and JSON together.
