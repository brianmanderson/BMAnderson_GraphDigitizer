---
name: axis-detection
description: >
  How automatic axis/tick detection (src/auto/) and its benchmark (bench/axes/, npm run
  bench:axes) work: the pipeline, the corpus and its ground-truth label format, how to add a
  real-world figure, how the baseline gates regressions and when it may be updated. Load it
  BEFORE editing anything in src/auto/ or bench/axes/, before Phase 5 work that consumes
  detectAxes(), when bench:axes reports a regression, and when adding or relabelling a figure.
  Skipping it risks DOM code in the worker-safe detector, a "fix" that tunes the corpus or eases
  the baseline instead of the detector, or labels in the wrong pixel convention.
---

# Axis detection and its benchmark

## Rules

1. **`src/auto` is pure TS and worker-safe**, like `src/core`: `tsconfig.core.json` checks it
   without the DOM lib and ESLint bans browser globals there. Input is plain RGBA
   (`RgbaImage`), never `ImageData`/canvas. Nothing in the UI calls it yet (Phase 5 does).
2. **Pixel convention**: integer = pixel centre, origin top-left, y down — in the detector, the
   labels and the generator (`px = xd − 0.5`, `py = H − yd − 0.5` from matplotlib display coords).
3. **Never tune the corpus to the detector.** Don't edit, drop or regenerate charts because the
   detector fails on them; don't loosen `bench/axes/score.ts` thresholds. Fix the detector, or
   accept and document the failure. Correcting a *wrong label* is fine with pixel evidence
   (that is how the KM figure's x ticks got `tickMarks: true`) — say so in the commit.
4. **No invented ticks.** An axis without tick marks must come back with `ticks: []`,
   `confidence: 0` (the `bare` column must stay 0). Two marks never make a pattern.
5. **Gate**: `npm run bench:axes` is part of `npm run verify` and exits 1 if any gated metric
   (axes found, box found, tick recall, minor recall, tick precision; or more ticks on bare axes)
   gets worse than `bench/axes/baseline.json`, overall or in any category. It is deterministic.
   Update the baseline (`npm run bench:axes -- --update`) only when every change is an
   improvement or a deliberate, explained trade-off, and commit it with the reason.

## Pipeline (`detectAxes(rgba)` in `src/auto/detect.ts`)

1. `darkness.ts`: grey → darkness above the local mean (window ≈ 1/40 of the short side). Bars
   become outlines; ink = darkness ≥ 24.
2. `skew.ts`: Hough restricted to ±5° (sum of squared bins), snapped to 0 unless clearly better;
   then `detect.ts` refines it once from the median tilt of the longest fitted lines.
3. `lines.ts`: per row/column of the skew-corrected frame (`frame.ts`), the *longest* ink run
   (gaps ≤ 2 px bridged) — text never makes a long run. Bands → candidates; sub-pixel offset =
   median of clean cross-profile centroids (ignores bars/ticks/labels touching the line).
4. Pair choice: strong horizontal × vertical candidates that meet with the plot above/right
   (L corner or a cross for axes through zero), scored by strength, extent into the plot and
   tick confidence. Plot box = corner to far ends, or to a frame line of similar darkness.
5. `ticks.ts`: short perpendicular marks on each side (adjacent columns summed; a walk stops
   when darkness halves, so ticks don't run into lighter gridlines); a lattice fit picks evenly
   spaced majors (several "major length" references are tried); minors between them; minors at
   log10(2…9) give `pattern: 'log'`. Crossing ticks → `side: 'both'`.

Output: axis lines (`LineCandidate`: offset, ends, contrast, thickness), plot box quad, tick
sets with per-tick and per-set confidence, `rejected` marks and the top candidates of each
family — the inputs Phase 5's OCR and scale inference need.

## Corpus and labels

- `bench/axes/generate.py` (Python 3.12 + matplotlib/numpy/Pillow; `npm run bench:axes:corpus`)
  writes `synthetic/cNN.{png,jpg,json}` — 60 seeded charts. Pixel snapping is off so the truth
  is exact; a self-check fails the run if a drawn axis is > 0.35 px from its label. Committed;
  regenerate only when changing the generator, and then rebaseline in the same commit.
- `real/manifest.json` lists real figures: `{ "truth": "<label.json relative to manifest>",
  "tags": [...] }`. Labels may live in `fixtures/real/` (shared with e2e) or `bench/axes/real/`.
- Label format (parsed by `bench/axes/truth.ts`; extra fields ignored):
  `image` (relative to the JSON), optional `tags`, optional `plotBox` `[[x,y] TL, TR, BR, BL]`,
  and `xAxis` / `yAxis` each with `scale`, `tickMarks` (false = labels only), `ticks`
  `[{ value, px, py?, label?, minor? }]` and either `line: [[x1,y1],[x2,y2]]` or the unrotated
  shorthand `axisLineRow` (x) / `axisLineCol` (y). `lineDrawn: false` = no visible line.

### Adding a real figure

1. Put the image and a label JSON (format above) in `bench/axes/real/` (or `fixtures/real/`).
   Measure positions on the pixels (e.g. Python/PIL or the app's loupe), not by eye; ±1 px.
   Label every tick you can see; set `tickMarks` from what the pixels show, not the style.
2. Add an entry with tags to `real/manifest.json`; add `pitfalls` notes for future readers.
3. Run `npm run bench:axes -- --verbose`. A new figure adds categories, so rebaseline with
   `-- --update` and commit image + label + manifest + baseline together.

## Known failures (Phase 4 baseline)

ggplot-style charts (grey panel, no axis lines: 0/3); ticks hidden behind bars or shorter than a
thick axis line (`kind:bar` tick recall ~62 %); the tick at the corner hides in the other axis;
log axes with only two decades and invisible minors return no ticks; free axis ends with
projecting line caps put box corners ~half a line width out.
