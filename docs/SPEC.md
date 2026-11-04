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

## Technical decisions

- **Fully client-side.** Images never leave the browser (research data may be unpublished).
  Static build, deployable anywhere.
- Vite + React + TypeScript (`strict`). Rendering on `<canvas>` with an explicit view transform
  (image ↔ screen) so pan/zoom never alters stored coordinates.
- Calibration/transform code is pure TypeScript with no DOM dependencies, in its own module.
- Tests: Vitest for logic; Playwright for a small set of end-to-end flows (added in Phase 2).
- Automation (Phases 4–5): hand-rolled image analysis in TS/Web Workers first; Tesseract.js
  for OCR. Pull in OpenCV.js only if a benchmark shows the simple approach is insufficient.

## Verification gate

A change is done only when this passes (commands defined in Phase 1, extended later):

```
npm run typecheck && npm run lint && npm test
```

From Phase 4 on, `npm run bench:axes` must also run and not regress against the recorded
baseline.

## Non-goals (for now)

PDF/vector import, automatic curve tracing, polar/ternary/map axes, accounts or cloud storage.

## Test fixtures

`fixtures/real/` holds real-world figures with hand-labelled ground truth (`<name>.json`
beside each image). Use them in e2e tests (Phase 2+) and the axis benchmark (Phase 4+).
