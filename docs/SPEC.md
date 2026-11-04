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
  version: 1                               // schema version, for saved projects
  image: { dataUrl, width, height, name }
  calibration: {
    xScale, yScale,                        // ScaleType
    refs: { X1, X2, Y1, Y2 }               // each { px, py, value: number | string }
  } | null
  datasets: [{ id, name, color, points: [{ id, px, py }] }]
  settings: { significantFigures, dateFormat }   // defaults: 4, 'YYYY-MM-DD HH:mm'
}
```

Types live in `src/core/project.ts`. `version` was added in Phase 1 so saved projects
(Phase 3) can be migrated.

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
invalid; `calibrate()` reports that), stores numeric ref text as numbers on numeric axes and
date text as typed; `fromProject` inverts it. Scale choices made before all four refs exist are
not saved — Phase 3 may extend the Project if that matters.

## Technical decisions

- **Fully client-side.** Images never leave the browser (research data may be unpublished).
  Static build, deployable anywhere.
- Vite + React + TypeScript (`strict`). Rendering on `<canvas>` with an explicit view transform
  (image ↔ screen) so pan/zoom never alters stored coordinates.
- Calibration/transform code is pure TypeScript with no DOM dependencies, in its own module.
- Tests: Vitest for logic; Playwright for a small set of end-to-end flows (added in Phase 2).
- Automation (Phases 4–5): hand-rolled image analysis in TS/Web Workers first; Tesseract.js
  for OCR. Pull in OpenCV.js only if a benchmark shows the simple approach is insufficient.

## Digitizing UI (decided in Phase 2)

- **Layout** (fits 1366×768): toolbar (open, zoom −/+/%, Fit) · canvas workspace · 360 px side
  panel with step tabs Image → Axes → Data, the step's controls, and the live table with export
  buttons below · status bar with the cursor's pixel and (x, y).
- **Loading**: file picker, drop onto the workspace, or paste anywhere. Any `image/*` that the
  browser decodes is accepted except SVG (vector input is a non-goal); others are rejected with
  a message naming the file. Loading over existing refs/points asks first and starts a fresh
  document (settings are kept).
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
  Deleting a dataset that has points asks first. Selecting another dataset's point makes that
  dataset active. (Phase 3 undo may replace these confirm dialogs.)
- **Table**: one section per dataset; `#` is the placement number and stays with its point
  when sorting by X (rows without an x value sort last). Unrepresentable values (`null`) show as
  "—". Significant figures (default 4) and the date format are Project settings; "Sort by X"
  and "Pixel columns" are session view options.
- **Exports follow the table view** (sort, pixel columns, significant figures, date format):
  one CSV for all datasets with a `dataset` column (RFC 4180, CRLF, `<image>-data.csv`); the same
  cells as TSV on the clipboard (LF; tabs/newlines in cells become spaces); the full Project as
  JSON including the image data URL (`<image>-project.json`). Blank cells for `null` values.

## Verification gate

A change is done only when this passes (commands defined in Phase 1, extended later):

```
npm run typecheck && npm run lint && npm test && npm run test:e2e
```

`npm run verify` runs all four. `test:e2e` (Playwright, Chromium, added in Phase 2) starts its own
dev server on port 5174. From Phase 4 on, `npm run bench:axes` must also run and not regress against the recorded
baseline.

## Non-goals (for now)

PDF/vector import, automatic curve tracing, polar/ternary/map axes, accounts or cloud storage.

## Test fixtures

`fixtures/real/` holds real-world figures with hand-labelled ground truth (`<name>.json`
beside each image). Use them in e2e tests (Phase 2+) and the axis benchmark (Phase 4+).

`fixtures/synthetic/` holds generated charts with exact geometry (linear scatter; date × log10)
and their ground truth, written by `npm run fixtures:synthetic`
(`scripts/make-synthetic-charts.ts`, renders in Playwright's Chromium). Regenerate only when
changing the generator, and commit the PNG and JSON together.
