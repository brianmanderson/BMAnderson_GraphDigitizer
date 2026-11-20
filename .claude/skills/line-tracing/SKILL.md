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
   Darker shades: a run peaking above 1.15 × the trace's typical peak (`DARKER_RATIO`, a darker
   shade of a one-hue palette — all shades are "on") ranks behind same-strength runs, never resets
   `entryX/entryY` and gives no slope (`dark` entries; the slope looks back ≤ 30 columns for the
   series' own, else follows the stroke over it). A walk that dies in a gap is retried from where
   the gap opened (`gapStart`, kept when it follows ≥ 8 more columns, ≤ 6 times per direction;
   never for `only` walks — every dash piece would retry — and riding only when the gap began
   under other ink, `gapUnder`: almost every walk "dies" at its real end, watch the `ms` column):
   *riding* — following the stroke of another colour it went under (≤ max(10, 4t + 4) px tall,
   must run the series' way after 6 columns, else its columns are open gap again; ridden centres
   become path points via `ColumnEntry.hidden`) — or *noisy* — a measured signal (`noisySeries`:
   slope MAD ≥ 0.6 px and ≥ 3 reversals over 12 columns) looked for around its last level within
   a random walk's reach, gaps never hidden. Both only as retries: as first choices they broke
   straight chords, steep lines and polylines under markers.
   Fill edges (`curve.ts → traceAreaEdge`, before the style read in `index.ts`): a click inside a
   fill tall and wide enough (≥ max(16 px, 4 % H), ≥ max(64 px, 25 % W) through its middle)
   follows its upper edge (lower when clicked within 12 % of it): a stacked-area layer without an
   outline. The bar finder (`bars.ts`) runs first and keeps a click on bars, unless in auto mode the
   fill's edge is not `flatTopped` (pieces between > 1.5-px steps drift > 2 px: a smooth layer).
   The fold follower (`follow.ts`) takes over only when what it adds has the walk's strength
   (`strengthAlong`, within 1.15×): shades of one hue meeting at a common start.
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
7. `kinks.ts`: patterned step corners (`stepLike` → `withStepCorners` from the walk over the
   filled pattern, checked level on both sides, then `levelCorners` from the levels either side of
   each vertical: the verticals of a dashed/dotted step have no stroke once `unfill` ran);
   vertices hidden under other-colour markers (occluder centroid, or the intersection
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
   Every template hit is then judged by what the fit does not see (`sameMarker`): colour strength
   (a lighter/darker shade of the hue is another series) and the *outline* (`outline.ts`: 72
   sub-pixel radii of the ink, or of an open marker's inside, compared with the clicked marker's;
   rays hidden under other colours, running into neighbours or along attached strokes say
   nothing; a stroke crossing a ring's inside is looked past). Several separate disagreeing
   stretches = another shape; a *rough* fit is kept unless ≥ 2 other failed hits (not legend
   samples) explain it far better. Small (< 5.5 px), stroke-like ("x", "+") and tiny-hole
   templates skip the outline. A small marker on its error bar/line (1.5–2.5 px deep) is cut out
   of it only after the ring test, when clicked on and clearly thicker than the attached strokes.
   `legendSample` also follows a line handle to the label, ignores ink touching the marker and
   needs thin-stroked letters (scan dashes are not letters).
10. Bars (`bars.ts → findBars`, 2026-11-19, outlined/hatched 2026-11-20; not in curve mode; before
    `excludeEdgeLines`, so a row of bars on the bottom edge is no frame line). Two ways in, one
    reading: a click in a solid 4 × 4 block of the series' colour reads *filled bars*; if that finds
    nothing and the fill has an outline of another colour (`edgeColour`: the strongest ink met
    walking out of the fill four ways, ≥ 3 ways nearer it than the background), or the click is on
    a thin stroke (an outline, a hatch line), *outlined cells* (`outlinedReadings`): walls = the
    outline colour's ink on straight runs ≥ 7 px, thickened 1 px; cells = what the walls enclose
    (with an outline colour, everything neither fill nor outline also closes a cell); a bar = a
    closed cell with no other cell in its box (stems and caps inside are walls), and its series =
    every such cell drawn alike (`sameTexture`: face colour, block-median texture density,
    patterned or not, next-pixel continuity in 4 directions = hatch angle, ruled or not). Ruled
    hatching ("++", "--", "||") joins ≥ 4 lined-up empty cells ≤ 24 px across into one ruled inside,
    moved out past the last rule to the outline. The matched cells become solid boxes (others
    neither fill nor background; a run never bridges into another cell) and the filled reading
    runs on them. Guards: a clicked wall must be its cell's own side (covers ≥ 60 % of it, never
    runs on past both ends: a gridline, a flat dash); a hatch click needs a cell patterned all
    over (a dash or curve crossing an outlined bar is not); cells all of one length are a ruled
    grid; cells reaching across the box along a third edge are background beside a frame.
    Filled reading: the series' ink cut into runs along the value
    axis (both orientations tried; thin other ink inside a run — hatching, caps, a curve — bridged),
    chained across columns, cut into rectangles whose ends stay put (columns with more ink beyond
    an end than the chain's usual outline never cut; one odd column between two that fit is
    noise; slivers beside a rectangle are its blurred side). Unit = commonest width among the
    segments sharing an end with the clicked one; a touching chain n units wide is n bars. Family:
    baseline = the end most bars share, voted only by bars ≥ ⅕ of the clicked one's length (legend
    swatches, a thick step curve's risers) (unless it is their far end and the other ends sit on ink: a
    100 % stack's top, gridline or not), else stacked segments sitting on ink down to the floor
    most of them reach (all sitting or all hanging; a swatch on its legend frame is not); a baseline must explain at least as
    many bars as the stacked reading. Of one fill colour only bars textured like the clicked one
    (`alike`: other thin ink inside the fill, not on straight runs; a short bar is hatched only
    when marked all over, ≥ 10 %, running on diagonally — a crossing curve is not). Not bars: lengths all alike and ≤ 30 px, longest bar
    < max(8 px, ¼ width), fewer than 4 marker-sized ones, marker-sized ones none longer than 1.5
    widths (edged markers' fills: left to Find points, which runs only when no bars are found), a bar with non-bar ink of its colour on
    its side or touching pieces that share no end (a thick line's flat stretches). Box cut the
    bars (a value end on its edge, or series ink just past an edge a bar ends on) → looked at
    again over the whole image; so are bars hanging past a baseline on the box's edge (a box
    ending at a zero line: series colour past it away from the bars), kept only if every first
    bar is still there. Up to 3 odd columns are noise when they are a stem of the bars' own colour
    (black error bar on a black bar), 1 always. Returns `kind: 'markers'`, one
    point per bar at its value end's middle.
11. Doubling back (`follow.ts`, 2026-11-19): `followStroke` walks the stroke as a path (ring of
    ~1.5 line widths → arcs of ink; straightest unwalked arc; centred on the cross-section;
    walked ink marked; straight on across crossings, occluders ≤ 60 px or along another series
    drawn over it; sharp turns from the stroke's tip; at a dead end, back along its own path to
    an unwalked tangential branch — a loop's merged tip). Used only where `takesOver` says so:
    closed (back at its start, heading out) or folding back in x by > max(markerMax, 6 widths,
    4 % of the box) without having retraced itself, passing through ≥ ½ of the column walk's
    points, ≥ 1.25× its length, ≤ 6 % of steps through ink wider than the stroke (a line through
    filled markers). Run only on fold evidence (`mayDoubleBack`: a jump, a walk end short of the
    box's left/right edge, own ink behind an end), at most once per trace; in auto mode a closed
    loop through the seed overrides a marker shape found ≥ 3 times.
    Order: open from its left end; closed from its leftmost point, clockwise, first point
    repeated at the end. Points: `pickPoints` (ends, cusps, then largest deviation).

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

- `bench/lines/generate_kinds.py` (called by `generate.py`'s main, or alone: rewrites only its
  own files) → l200–l229 and l240–l247 "new kinds" (`NUMBERS`): `series:path` lines (path in drawing order, not functions
  of x: loops, folds, spirals, parametric; `corners` = tips/cusps/step corners) and
  `kind: "bars"` series (loaded as scatter; `markers` = value ends; tags `bars:*`, `histogram`;
  l240–l247, appended 2026-11-20 (l230–l239 unused): black-and-white hatched / outlined / ruled "++" bars, one face
  colour told apart by hatching, a spine at zero, hatched horizontal bars both sides of zero,
  an outlined histogram, four series with error caps).
  `score.ts` adds `pathCoverage` / `pathPrecision` / `pointsOrder` (gated) for `series:path` only
  — absent from every other category, so earlier entries gain no key.
- `bench/lines/generate.py` → `synthetic/lNN.{png,jpg,json}` (238 charts, 646 series; committed,
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
  offset range frame `detectAxes` boxes from where the extended axes would meet, log-log or linear; `build_busy`; marker truth
  per class, `corners` = the curve's corner), l140–l169 `marker-styles` (`build_marks`, one
  `MARK_CHARTS` entry per chart: 2–4 marker classes — stars, triangles ×4, pentagons, hexagons,
  thin diamonds, filled/thin plus and x, … — filled / open / hollow / edged / semi-transparent,
  4.5–16 px, one colour or similar hues, error bars, on lines, legends, dark / ggplot / seaborn
  themes, JPEG, low dpi; tags `marker:*`, `fill:*`, `edge:*`, `alpha`, `theme:*`,
  `similar-hues`, `one-colour-classes`, `legend:samples`, `layout:*`, `size:*`),
  l170–l199 `styles` (`build_styles`, one variant per
  chart from `STYLE_VARIANTS`: bands, filled / stacked areas — truth = a layer's top edge, seed in
  the fill when it has no edge line —, 6–8 series of one palette, noisy series, curves running
  together, 1-px lines, dark / grey-panel themes, gridlines in the series' colour, annotations
  and a legend over curves, KM pairs with "|" ticks, steep sigmoids, log-x, log-log; seeds by
  `pick_seed_styles`) — so earlier ones stay
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
a faint marker;
marker styles: a filled marker of another class inside two heavily overlapping clicked ones is
taken, markers half under a close colour (JPEG orange on red) or a semi-transparent one are
lost, legend samples with run-together labels or drawn with error bars still count;
styles: a curve hidden under another for more than 30 % of the plot width ends
there, a light shade hidden under a darker one can leave with the darker one (`l184/s1`), a legend
box over a curve ends the trace at the box, noisy JPEG series at 72 DPI fragment, dashed series
among dashed gridlines of their colour are misread / follow the grid, dotted KM steps with "|"
ticks read as dash-dot; a JPEG dashed line touching a thick related-hue curve can switch to it
(`l31/s3`). Scans: keeping a walk off a gridline it only touches (no far-end exit from a run
that is mostly ruling) fixes `l121/s0` but costs steep curves crossing horizontal gridlines —
rejected, see SPEC.
New kinds (l200–l229, l240–l247): a P–E loop whose tips are one merged line leaves its tips
out (the walk stops where the branches merge), a curve folding back that the walk retraces is left
to the column walk (an open path is never trusted after retracing), stress–strain cycles in one
black stroke (crossings at every reload) are not followed, a P–E ellipse among another loop is
taken for markers, a minor loop inside a same-colour major loop follows the major one; bars:
every bar series of the corpus is found (2026-11-20) — left: outlined bars all of one length
read as a ruled grid, a thin outline blended into a fill of its own grey read ~2 px short,
equal-height touching outlined bars of one series with ruled hatching could join. Numbers: docs/SPEC.md → Auto-trace →
Line-chart styles / Baseline / Known failures.
