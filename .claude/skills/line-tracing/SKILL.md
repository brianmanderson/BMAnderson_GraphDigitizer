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
   `TraceResult`, `TraceMode`, `LineStyle`; `TraceResult.style` since Phase 6) is what the Data-step
   UI codes against. Doc comments may change;
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
   precision, wrong-group rate or style accuracy gets worse than `bench/lines/baseline.json`, overall or in any category. It is
   deterministic. Rebaseline (`npm run bench:lines -- --update`) only when every change is an
   improvement or an explained trade-off, and say why in the commit. The plot box comes from
   `detectAxes`, so **a detection change can move bench:lines** — run both benches.

## Pipeline (`traceLine` in `src/auto/trace/index.ts`)

1. Region (`region.ts`): given box → else `detectAxes` box if it contains the seed → else image.
2. Colour (`color.ts`): background median; seed = nearest ink within 4 px, hill-climbed to the
   strongest shade — or, in markers/auto mode, a click on background enclosed by ink within
   `markerMax` (`enclosedHole`: inside an open marker, whatever its size) seeds on the enclosing
   ink and hands the hole to `markerTemplate`, which then cuts the open shape around it (never
   the filled marker the ring may be merged with); ink colour, then scaled to the line's typical
   peak (`typicalStrength`).
   Coverage α per pixel with a saturation-dependent residual tolerance (tight for black/grey/brown,
   loose for saturated colours JPEG washes out). `other` marks ink of another colour. A neutral
   grey series among black ink (`greySeries` → `markDarkerInk`, not in markers mode): ink much
   darker than the series (black continues a grey's colour line, α ≈ 2) is an occluder, with its
   rim and the ≤ 12-px pieces left touching it (never the seed's piece); its mask goes to the
   style reading as `darker`, where a gap crossing it is an occlusion, not a pattern gap. A frame line
   along an edge is excluded only when it has the series colour (`excludeEdgeLines`).
   Rulings (`rulings.ts`): straight axis-parallel lines of the series' colour spanning ≥ 70 % of the
   region, only as a grid (≥ 2, never the one under the seed) — a scanned figure's grid ruled in the
   curves' black. Heavy ones (≥ 2 px, ½ the stroke; 6 px for a dotted/dash-dot read; none for a
   series read as dashed or a clean marker seed) are taken out and the seed's blob and style read
   again: kept out for a dashed/dotted series or a marker (an occluder; `cut` gaps join a cut
   dash; slivers beside one are hidden), put back for a solid curve as `rulingInk` (never take a
   run that is all ruling; a prediction on one is a hidden gap).
3. Style (`style.ts → classifyStyle`): the chain of blobs around the seed → solid / dashed /
   dotted / dash-dot / unknown (gaps that agree, piece lengths; occlusions end a chain, crossings
   of same-colour ink don't count). Mode: blobs of "on" pixels (`markers.ts → findBlobs`); seed
   blob small + round and not patterned → markers (also a larger blob from which `markerTemplate`
   cuts a marker found ≥ 3 times: a marker with error bars); a dotted chain whose pattern wasn't read →
   `chainPath`. Otherwise `applyStyle` (same-colour ink of another style becomes an occluder; a
   patterned seed's own gaps are filled — a chain end joined across the dropped ink only to a chain
   end, or to a lone piece on its course, with a lost dash's worth of that ink between a long join
   (never to a tick label beside a top X axis) — `unfill` after the walk) and the column walker.
4. Column walker (`curve.ts → traceColumns`): runs per column; prediction = centre + median
   slope, or after a long run straight-through-then-far-end (straight-through extrapolates from the
   entry column `entryX` over every column since, when the clean slope rests on ≥ 3 pairs — a
   shallow merge with a same-colour gridline is many columns wide); runs thinner than the stroke
   are ranked by their own centre; hole bridging on verticals; peak
   consistency (`PEAK_RATIO`); open gaps ≤ `defaultMaxGap`, hidden (occluded) gaps ≤
   `defaultMaxHiddenGap`; under a marker-sized occluder a kink allowance (`KINK_SLOPE`,
   `KINK_COLUMNS`) whose runs must emerge from the ink and are only a fallback; retry from the last
   fork (`RETRY_COLUMNS`, `MAX_RETRY_DEPTH`; kink-only runs make no fork; the branch that followed
   most ink wins). Walk order: right, left primed with right, right primed with left.
5. Dash hopping (`dashes.ts → hopDashes`, dashed / dash-dot): from each end of the walk, the next
   piece ahead on the walk's course (size, alignment, no series-colour ink between), walked alone
   and primed with the line's direction; repeated to the real end. `traceColumns(…, only)` is the
   one-direction continued walk; `tips` (a ruled figure's dashed walk) keeps a piece's tapering
   ends out of the stroke width.
6. `columnsToPath`: centroids; thin long-run groups entered at one end → two corner points, unless
   ≥ 2 columns wide and the agreeing slope on both sides explains the jump (a shallow crossing:
   bridged; a 1-column stair of a steep line stays, its corner bounds `insertHiddenKinks`); square
   groups wider than a stroke sticking out past the curve (same-colour markers) → one corner at
   their centroid; thin groups sticking out on both sides ('+') dropped.
7. `kinks.ts`: vertices hidden under other-colour markers (occluder centroid, or the intersection
   of the stretches either side, both only over ink) and line ends under a marker.
8. `resample.ts`: ends + corners + extrema + DP kinks always, rest evenly in x up to `maxPoints`.
9. Markers ("Find points", `markers.ts`): `markerTemplate` cuts the clicked marker out of its blob
   (filled: opening wider than the attached strokes; open: the enclosed hole + ring — not a pocket
   beside a thick stroke that runs on and borders under half of it, `throughStroke`), `findMarkers`
   matches its ink / defining background / margin everywhere (filled on the opened image, corners
   raw), splits clumps by area, drops legend samples (`legendSample`). No template → blob match
   (`matchMarkers`): for a black series first without its lighter greys (`withoutLighterInk`: long
   mid-grey pieces — curves, gridlines); in a busy plot (≥ 25 single matches) singles must match
   the seed blob's pixels (IoU ≥ 0.45) and merged blobs are split by copies of it
   (`splitCluster`: compact thick parts covering ≥ 2.5 markers are another class and cut out;
   pieces copies can't explain — text, rings, lines — dropped; copies placed greedily). A filled
   template among ≥ 60 small blobs of its colour must be solid inside (`solid` in `findMarkers`):
   a pile of "+" is no diamond.

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

- `bench/lines/generate.py` → `synthetic/lNN.{png,jpg,json}` (140 charts, 375 series; committed,
  ~6 MB; charts are only ever appended — l60–l71 are the `kinks` scenario, l72–l83
  `same-colour` (solid + dashed/dotted pairs of one colour), l84–l95 `find-points` (filled vs open
  or circle vs square scatter of one colour with error bars), l96–l107 `grid-crossing` (a thick
  solid sigmoid + dashed bounds over outlined bars and gridlines of its own colour, like a
  dose-response figure), l108–l115 `top-axis` (X axis along the top with its labels above, a Γ
  frame `detectAxes` boxes on 6 of 8; solid + dashed fits of one colour from the top-left corner with
  filled/open squares and error bars), l116–l127 `scan-grid` (old black-and-white scans: heavy
  black grid and frame, solid fit + two hand-dashed confidence curves, x/o markers, blur, noise,
  uneven strokes, ≤ 0.5° rotation; `build_scan`; one grey channel), l128–l139 `busy-scatter`
  (300–1000 small black "+"/"x"/dot markers in overlapping clusters, filled diamonds among them,
  grey or coloured curves through the cloud with a corner on the first, percent labels, an
  offset range frame `detectAxes` boxes on none, log-log or linear; `build_busy`; marker truth
  per class, `corners` = the curve's corner) — so earlier ones stay
  byte-identical: check `git status` after regenerating). Per series: `kind` (`line|step|scatter`), `tags`, `color`, `style`, `marker`,
  `lineWidthPx`, `markerSizePx`, `seed`, `data`, `pixels`, and `path` (drawn polyline),
  `markers` (centres), `corners` (step corners; for kink polylines every vertex). Seeds: visible ink of the series (coverage ≥ 0.6),
  no ink of another colour within 3 px (exact-blend test on the render), clear of other series and
  the legend, at a random position in the middle half.
- `bench/lines/real/manifest.json` lists figures beyond the generated corpus; their label JSON's
  `knownValues` (`series`, `x: [x0, x1]` in data units, `y`, optional `py`) become partial truth
  (horizontal segments; x via the labelled x ticks), or a `points` list (`px`, `py`) becomes full
  truth for a polyline with a marker on every point (line + marker series; entry needs
  `markerSizePx`; `source` names its top category, e.g. `fixture`); an optional `styles` map
  (series → line style) feeds the style metric; a `markerSeries` list (`series`, `markerSizePx`,
  `seed`, `markers`) gives full marker truth for scatter groups (`scatter-errorbars-glowa.json`); a
  `curves` list (`series`, `seed`, `path`) gives full truth for measured curve centrelines
  (`dose-response-1928-grid.json`).
  Add a figure: **CC BY or public domain (owner's ruling)**, with its source, licence, crop box and attribution recorded in
  `fixtures/real/PROVENANCE.md` first; label plateaus from measured pixels (±1 px),
  add it to the manifest with tags, run `-- --verbose`, rebaseline (new categories) and commit
  image + label + manifest + baseline + provenance together.

## Known failures (baseline)

Dense staircases in thick lines lose corners (corner recall 68 %); 42 % of kink vertices under
small/JPEG markers are still missed; a series hidden under another
along a step ends the trace; thin faint lines in low-DPI JPEGs fragment; four-series JPEG charts
on dark gridlines still switch series sometimes (dense 10.7 % wrong); legend samples count as
markers; same-colour (Phase 6): a dashed series merged into the solid one for a stretch ends the
dashed trace there, dashed/dotted KM steps keep few corners; grid-crossing: dashed bounds among
own-colour gridlines get their style misread; top X axis: Office dashes (gaps longer than the
dashes) often leave the style unread, a series running inside the axis stroke is lost there with
the axis, a dashed trace stops at an open marker whose cap it entered; scan-grid: x/o markers on a
gridline where curves converge still divert a trace (wrong series 27.8 %), hand-dashed curves cut
by a dense grid often go unread, a marker touching a curve or gridline traces as a curve;
busy-scatter: a minority of thin markers ("x") among dense piles of dots is over-counted, two grey
curves of different shades meeting can send the walk along the darker one, corners hidden under a
marker or next to a fast-turning curve are often not kept, a walk can hop past a curve's end onto
a faint marker. Numbers: docs/SPEC.md → Auto-trace →
Baseline / Known failures.
