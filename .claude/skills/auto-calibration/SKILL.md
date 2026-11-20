---
name: auto-calibration
description: >
  How "Auto-detect axes" works end to end: tick-label finding (src/auto/labels.ts), OCR with
  Tesseract.js (src/ocr/pool.ts, src/ui/ocr.ts, the vendored /tesseract/ assets in vite.config.ts),
  label parsing (src/auto/parseLabel.ts), scale inference, refs and the cross-check
  (src/auto/suggest.ts, auto.ts), the worker (src/workers/auto.worker.ts), the Auto-detect panel
  and ghost markers, and the calibration scoring in bench/axes (calib.ts). Load it BEFORE changing
  any of these, when bench:axes reports a calibration regression ("calib … correct/wrong"), when
  an auto-detect e2e test fails, or when OCR misreads a figure. Skipping it risks suggestions that
  are confidently wrong (dropped decimal points, unread offset notes), Tesseract fetched from a CDN,
  OCR on the main thread or in the first-paint bundle, or a suggestion applied without the user
  accepting it.
---

# Auto-calibration (Phase 5)

## Rules

1. **Wrong is worse than declined.** The gated `wrong` / `wrong-high` counts must stay 0: an axis
   suggested at medium/high confidence that is not within 1 % at every held-out tick. When a new
   case fails, prefer declining it (status `positions`) to guessing. `calibrated` is not gated.
2. **OCR is not trusted for small marks.** Tesseract drops the point in "1.0" at 96 % confidence.
   Points/commas come from the glyph layout (`profilePoints` → `restorePoints`), minus signs from
   `minusAt`, and `08`/`000` never parse. Don't remove these to "simplify".
3. **The labels may not be the values.** matplotlib's `+1e4` / `1e−3` note changes them; an
   unread note declines the axis. Day-number date axes (`Sep 03 05 …`) are declined too.
4. **Never applied silently.** The UI only applies a suggestion on "Accept suggestion", as one
   `apply-suggestion` undo step. Keep ghost markers and the panel the only effect of a run.
5. **Offline, lazy, off the main thread.** Tesseract's worker, WASM cores and `eng` data are
   served from `/tesseract/` by the `tesseract-assets` plugin (dev) and copied to `dist/tesseract/`
   (build); `cacheMethod: 'none'`. `src/ui/ocr.ts` is dynamically imported (own chunk). The
   pipeline runs in `src/workers/auto.worker.ts`; OCR requests are proxied to the page's pool. The
   e2e spec aborts non-localhost requests and checks Tesseract isn't loaded before use.
6. `src/auto` stays DOM-free (`OcrEngine` is injected); `src/ocr/pool.ts` may use tesseract.js
   types but nothing browser-only, because the benchmark runs it in Node.

## Pipeline map

- `labels.ts` — `findLabels(map, rgba, detection)`: band patch in the skew frame → components
  (adaptive threshold; blobs, colourful glyphs and huge ones dropped — then each colour class of the
  band, and a faint pass at the lowest threshold, may replace that result) → rows → words → matched to
  major ticks (or label centres without ticks) → `FoundLabel` with crops (28 px body height),
  exponent split, minus/point marks; plus the axis `note`.
- `auto.ts` — `autoCalibrate`: pass 1 numeric OCR (exponent joined as `base^exp`, marks
  restored), pass 2 text OCR if not confident or a label didn't parse; note read both ways.
- `suggest.ts` — `suggestAxis`: consensus fit for linear/log10/date, unread `10^` exponents
  inferred only on exact decades, the log lattice (`logLattice`/`latticeFit`: slope from the minor
  ticks when < 3 labels agree), refs = widest confident agreeing pair, 1-D cross-check, levels;
  `crossCheck`: engine `calibrate` + 2-D residuals. Thresholds and reasons are in SPEC →
  Auto-calibration.
- `pool.ts` — PSM 7 → 6 (→ 10 for single chars) when a read is empty; parameters re-sent only on
  change.
- Old scans (hand-lettered labels, heavy grid, no ticks — SPEC → Finding labels / OCR):
  ticks that match < 2 labels → labels-only; labels on a gridline snap to it (`gridline`); a
  label touching the axis is `clipped` and gives no value; italic axes are sheared upright
  (`slanted`). Tesseract cannot really read hand-lettering: declining with labelled-gridline
  positions is the expected result there, not a bug to tune away.

- Label variety (c120–c155, SPEC → Auto-calibration → Label variety): small text can hide a
  decimal point, so a label may carry two readings (`OcrLabel.alternatives`) that only the axis's
  unambiguous labels settle; never give such a label a value of its own. A reading with fewer
  characters than `FoundLabel.runs` dropped one (`20k` → `20`, `20` → `0`): the text pass
  reconciles it (`reconcile` in auto.ts). Rotated labels are `AxisLabels.alternative`, read only
  when the upright reading declines. Any re-read of a `10ⁿ` label must not turn into a plain
  number starting with `10` (`102` for 10⁻²): that is the confident-wrong trap. A word that split
  (a lost point) must never leave a trusted digit behind: `FoundLabel.partial` labels give no
  value, like `clipped` ones — never drop the guard to win an axis.
- Colours, faint labels, log exponents (c156–c167, SPEC → Auto-calibration → Label colours):
  coloured labels are a *colour class* of the band (core chroma ≥ 80, clustered by hue), matched
  like the neutral ink and taken only when it beats it (more labels; or, at ticks, half as many
  with twice the ink or clearly nearer the axis). Dropping coloured glyphs without that left
  their colourless fringes to be matched: confidently wrong (c165). A faint pass at threshold 24
  runs when fewer labels than majors were found. Exponent crops mask the other part's ink; a
  16 px re-read is a *guess*. The log lattice (`logLattice`: decade length and direction from the
  minors) lets two agreeing decade labels calibrate (medium): keep its guards — one label read
  outright, no confident contrary reading, slope sign from the minors — a single read exponent
  is never enough.
- Tools that paid off (scratch scripts, outside the repo): an OCR lab that reads every label with
  a `label` in the truth under crop/OCR variants and scores them (1 288 labels, ~25 s); a per-gap
  dump of digit pitch and gap ink against the true text (how the point thresholds were set).

## Debugging a figure

- `npm run bench:axes -- --verbose --only c12,km` prints each axis: `ok/WRONG level scale err%` and
  the labels read (`✗` = disagrees). It never gates or updates.
- To look at crops, write a scratch script (outside the repo) that calls `findLabels` and writes
  `crop`/`base`/`exponent` with pngjs; OCR them with `nodeOcrPool` from `bench/axes/ocrNode.ts`.
- Browser Pane timings are throttled (≈ 5–10× slower); headless Playwright shows real ones
  (~1.3 s first figure incl. loading Tesseract, ~0.3 s warm).

## Benchmark and baseline

`bench/axes/calib.ts` scores each axis's refs against every labelled true tick that is not a ref
(error in the true scale's linear space / labelled range; correct ≤ 1 %), plus `knownValues` of real
figures at their `py` through the 2-D suggestion. OCR is deterministic on one machine; another CPU
can pick another WASM core, so a small change on a new machine is not necessarily a regression —
investigate per image (`Changed vs baseline` lines) before updating. Update the baseline
(`-- --update`) only for an explained improvement or trade-off, in the same commit.

## Known failures (2026-11-20, round two: 84.1 % of 358 axes correct, 0 wrong)

Declined (57 axes): dates without a year, times, categories (by design); range frames without tick
labels; hand-lettered scans; log axes with one exponent read and the other unread or its base
misread (c06, c14, c25, c37, c44 y, c45, c52 y, c57, c62, c30 x), a muted purple that forms no
colour class (c158); tiny/low-DPI labels that lose points (c164 y, c24, c27, c55, c148, c167 y);
offset notes (c03, c34, c63, c136); `m×10ⁿ` read as `10ⁿ` (c134); years on a second label line
(c130). Rejected (SPEC lists the numbers): OCR crop preprocessing, exponent-crop preprocessing,
height-ratio exponent tests, glyph-shape-only rotation, seeding colour classes below chroma 80,
14/18 px exponent re-reads.

### Round one (2026-11-19, merged with the styled corpus: 79.9 % of 334 axes correct, 0 wrong)

Coloured labels (c151) and log exponents 2–4 px tall (c13, c14, c44, c45) were declined; c151 and
c13 are read since round two.

### Earlier (Phase 5 baseline: 65 % of axes correct, 0 wrong)

ggplot-style charts (no axis lines), low-DPI/JPEG labels misread, log exponents 2–4 px tall, date
axes with day numbers or no year, offset notes too small to read, axes whose ticks were not found.
