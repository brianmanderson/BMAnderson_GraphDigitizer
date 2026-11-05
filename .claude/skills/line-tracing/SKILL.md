---
name: line-tracing
description: >
  How automatic line tracing works — traceLine() in src/auto/trace/ (one click on a plotted
  series → its centreline or markers → suggested points) — and its benchmark (bench/lines/,
  npm run bench:lines): the fixed TraceRequest/TraceResult contract the Data-step UI codes against,
  the colour model, the column walker with gap bridging and retry, step corners, dotted lines,
  markers, resampling, the corpus and its truth format, and how the baseline gates regressions.
  Load it BEFORE editing anything in src/auto/trace/ or bench/lines/, before changing the contract
  or the worker/UI code that calls traceLine, when bench:lines reports a regression, when a trace
  follows the wrong series, loses a step corner or stops early, and when adding a figure to the
  line corpus. Skipping it risks breaking the UI's contract, DOM code in the worker-safe engine,
  "fixing" a failure by tuning the corpus, seeds or baseline instead of the tracer, or a
  suggestion applied without the user's Accept.
---

# Line tracing and its benchmark

## Rules

1. **The contract is fixed**: `src/auto/trace/types.ts` (`TraceRequest`, `TracedPoint`,
   `TraceResult`, `TraceMode`) is what the Data-step UI codes against. Doc comments may change;
   a shape change must update `docs/SPEC.md` → Auto-trace in the same change and be called out to
   whoever owns the UI. `traceLine` never throws: failures are `ok: false, kind: 'none'` with a
   user-facing `message`.
2. **Pure TS, worker-safe**, like the rest of `src/auto` (checked by `tsconfig.core.json`, ESLint
   bans browser globals). Input is plain RGBA. No `performance` global types: timing goes through
   the `globalThis` cast in `index.ts`.
3. **Pixel convention**: integer = pixel centre, in the engine, the generator and the truth.
4. **Suggestions are never applied silently** — the UI shows `points` and adds them on Accept.
5. **Never tune the corpus to the tracer.** Don't edit, drop or regenerate charts, move seeds or
   loosen `bench/lines/score.ts` because a trace fails. Fix the tracer, or accept and document the
   failure (SPEC → Auto-trace → Known failures). Changing the generator is fine for realism (then
   regenerate, rebaseline, explain in the commit), never to dodge a failure.
6. **Gate**: `npm run bench:lines` is in `npm run verify` and exits 1 when kind accuracy,
   coverage, median/p95 centreline error, wrong-series rate, corner recall or marker recall /
   precision gets worse than `bench/lines/baseline.json`, overall or in any category. It is
   deterministic. Rebaseline (`npm run bench:lines -- --update`) only when every change is an
   improvement or an explained trade-off, and say why in the commit. The plot box comes from
   `detectAxes`, so **a detection change can move bench:lines** — run both benches.

## Pipeline (`traceLine` in `src/auto/trace/index.ts`)

1. Region (`region.ts`): given box → else `detectAxes` box if it contains the seed → else image.
2. Colour (`color.ts`): background median; seed = nearest ink within 4 px, hill-climbed to the
   strongest shade; ink colour, then scaled to the line's typical peak (`typicalStrength`).
   Coverage α per pixel with a saturation-dependent residual tolerance (tight for black/grey/brown,
   loose for saturated colours JPEG washes out). `other` marks ink of another colour. A frame line
   along an edge is excluded only when it has the series colour (`excludeEdgeLines`).
3. Mode: blobs of "on" pixels (`markers.ts → findBlobs`); seed blob small + round → markers,
   unless it is a link in an evenly gapped chain (`regularChain`: dotted/dash-dot) → curve along
   the chain (`chainPath`). Otherwise the column walker.
4. Column walker (`curve.ts → traceColumns`): runs per column; prediction = centre + median
   slope, or after a long run straight-through-then-far-end; hole bridging on verticals; peak
   consistency (`PEAK_RATIO`); open gaps ≤ `defaultMaxGap`, hidden (occluded) gaps ≤
   `defaultMaxHiddenGap`; under a marker-sized occluder a kink allowance (`KINK_SLOPE`,
   `KINK_COLUMNS`) whose runs must emerge from the ink and are only a fallback; retry from the last
   fork (`RETRY_COLUMNS`, `MAX_RETRY_DEPTH`; kink-only runs make no fork; the branch that followed
   most ink wins). Walk order: right, left primed with right, right primed with left.
5. `columnsToPath`: centroids; thin long-run groups entered at one end → two corner points; square
   groups wider than a stroke sticking out past the curve (same-colour markers) → one corner at
   their centroid; thin groups sticking out on both sides ('+') dropped.
6. `kinks.ts`: vertices hidden under other-colour markers (occluder centroid, or the intersection
   of the stretches either side, both only over ink) and line ends under a marker.
7. `resample.ts`: ends + corners + extrema + DP kinks always, rest evenly in x up to `maxPoints`.

## Debugging a failing trace

- `npm run bench:lines -- --only l31 --verbose` prints per-trace kind, coverage, error, corners,
  markers. Tags of a series (in the verbose line's category rows) say what it is.
- Draw an overlay: decode the image (`bench/axes/decode.ts`), run `traceLine` with the truth seed
  (`bench/lines/truth.ts → loadCorpus`), paint truth and `path`/`points` into a PNG (pngjs) at
  4–10× zoom — the failure is usually obvious (a dash tip, a marker tip dead end, a gridline
  crossing, colours confused in a JPEG). Keep such scripts in the scratchpad, not the repo.
- A temporary `console.log` per column (x, prediction, runs, candidates) inside `walkFrom` is the
  fastest way to see why a walk stops; `src/auto` has no `console` type (reach it through a
  `globalThis` cast) and the debug line must not be committed.

## Corpus and truth

- `bench/lines/generate.py` → `synthetic/lNN.{png,jpg,json}` (72 charts, 160 series; committed,
  ~2.2 MB; charts are only ever appended — l60–l71 are the `kinks` scenario — so earlier ones stay
  byte-identical: check `git status` after regenerating). Per series: `kind` (`line|step|scatter`), `tags`, `color`, `style`, `marker`,
  `lineWidthPx`, `markerSizePx`, `seed`, `data`, `pixels`, and `path` (drawn polyline),
  `markers` (centres), `corners` (step corners; for kink polylines every vertex). Seeds: visible ink of the series (coverage ≥ 0.6),
  no ink of another colour within 3 px (exact-blend test on the render), clear of other series and
  the legend, at a random position in the middle half.
- `bench/lines/real/manifest.json` lists figures beyond the generated corpus; their label JSON's
  `knownValues` (`series`, `x: [x0, x1]` in data units, `y`, optional `py`) become partial truth
  (horizontal segments; x via the labelled x ticks), or a `points` list (`px`, `py`) becomes full
  truth for a polyline with a marker on every point (line + marker series; entry needs
  `markerSizePx`; `source` names its top category, e.g. `fixture`). Add a figure: label plateaus from measured pixels (±1 px),
  add it to the manifest with tags, run `-- --verbose`, rebaseline (new categories) and commit
  image + label + manifest + baseline together.

## Known failures (baseline)

Dense staircases in thick lines lose corners (corner recall 68 %); 42 % of kink vertices under
small/JPEG markers are still missed; a series hidden under another
along a step ends the trace; thin faint lines in low-DPI JPEGs fragment; four-series JPEG charts
on dark gridlines still switch series sometimes (dense 10.7 % wrong); legend samples count as
markers. Numbers: docs/SPEC.md → Auto-trace → Baseline.
