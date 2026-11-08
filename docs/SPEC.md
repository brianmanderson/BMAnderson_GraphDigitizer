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
   A figure with several panels can be **cropped** to the one to digitize ("Crop…" in the toolbar
   or in the Image step; see Crop under Digitizing UI) — at any point of the work, since refs and
   points move with it.
2. **Choose axis scales** — independently for X and Y: `linear`, `log10`, `ln`, `reciprocal`,
   `date/time`.
3. **Calibrate** — click 4 reference points: X1, X2 (points with known x values) and Y1, Y2
   (points with known y values), then type the value for each.
4. **Digitize** — the Data step opens with **Auto-trace line** on (again after "+ Add line"):
   a click on a plotted series proposes its points, to accept or discard. Discarded (or Esc), a
   click places a data point by hand (always, even beside another point); with the
   "Move points" tool on, click to select and drag to move; select one or many points (Shift+click,
   box, a whole line) + delete or nudge them together; multiple named,
   colour-coded **lines** (the UI's word for a dataset: one curve or series).
5. **Output** — live table of (x, y) per line; export CSV, copy as TSV (pastes into Excel),
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
`PROJECT_VERSION` and adds a migration plus a test. **Cropping changes no schema**: a crop
replaces `image` with the cut-out (a PNG data URL of the crop's size, same `name`) and translates
the refs and points; the original image is not kept in the Project (Crop, below).

Points are stored in **image pixel coordinates (sub-pixel floats)**; values are always derived.
Re-calibrating or changing a scale type must update the table instantly without moving points.

**Pixel convention (decided in Phase 2).** Integer coordinates are pixel *centres*: pixel column
`i` spans `[i − ½, i + ½)`, so the image's outer edges are at −½ and `width − ½`. This matches
how `fixtures/real/*.json` labels pixels (an axis line drawn on one pixel column is labelled with that integer column) and makes "the
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
  for OCR (Phase 5: vendored and lazy-loaded, see Auto-calibration). Pull in OpenCV.js only if
  a benchmark shows the simple approach is insufficient (Phase 4: it did not — see below).

## Digitizing UI (decided in Phase 2)

- **Layout** (fits 1366×768): toolbar (open, zoom −/+/%, Fit; Phase 3 adds project open/save,
  undo/redo and the precision toggles, and lets the toolbar wrap on narrow windows) · canvas workspace · 360 px side
  panel with step tabs Image → Axes → Data, the step's controls, and the live table with export
  buttons below · status bar with the cursor's pixel and (x, y).
- **Loading**: file picker, drop onto the workspace, or paste anywhere. Any `image/*` that the
  browser decodes is accepted except SVG (vector input is a non-goal); others are rejected with
  a message naming the file. Loading starts a fresh document (settings are kept); since Phase 3
  it is an undo step instead of asking first (see below).
- **Crop (decided after the Pages deploy)**: "Crop…" is offered whenever an image is loaded — at
  any stage of the work, calibrated or not — in the toolbar beside "Open image…" (on every step)
  and in the Image step under the line "Figure with several panels? Crop to the one you want."
  (The toolbar button was added once the feature was live: loading an image moves straight to the
  Axes step, so a button only in the Image step was never seen.) Pressing either enters *crop
  mode* on the Image step — the toolbar one switches to it first — and pressing either again
  leaves it; the two buttons are one control in two places, pressed together (both show
  `aria-pressed`): a left-drag on the canvas draws the crop rectangle (whole image pixels — every
  pixel the drag touched — clamped to the image; a press-and-release under the click slop draws
  nothing; a new drag replaces it), the image outside the rectangle is dimmed (a fixed translucent
  dark, since the canvas is not themed) and its outline is drawn like the marquee; middle-drag /
  Space+drag pan and wheel zoom keep working, refs and points are not hit-tested, and the cursor
  is a crosshair. The panel shows Left, Top, Width and Height (image px) bound to the rectangle:
  editing them moves or resizes it (clamped inside the image and to at least 2 × 2 px) and a drag
  updates them; they start from the whole image until a rectangle exists. Below them the resulting
  size, "Apply crop" (primary; also Enter, from the inputs too; disabled until a rectangle exists)
  and "Cancel" (also Esc). Crop mode is UI state only — never in the Project, the autosave or the
  prefs — and changing step, loading an image or project, or Esc cancels it. **Decision — the crop
  replaces the image, as one undo step.** The rectangle covers columns `x0 … x1 − 1` and rows
  `y0 … y1 − 1` (`x1 > x0`, `y1 > y0`), so in the pixel convention its edges are at `x0 − ½` and
  `x1 − ½`, a point at `px` becomes `px − x0`, and pixel centres stay on pixel centres. It is cut
  out of the decoded image on a canvas (`src/ui/crop.ts`) and re-encoded as a PNG data URL —
  lossless, so a PNG source is cropped exactly and a JPEG source gets no further loss — into a new
  image of the crop's size with the same `name` (exports keep their names). The `crop` action
  (`src/state/doc.ts`) translates every ref and point by (−x0, −y0) and drops those that land
  outside the new image (outside `[−½, width − ½] × [−½, height − ½]`, the same closed box the
  rest of the UI treats as "on the image"; a dropped ref makes the calibration incomplete, which
  the Axes step already handles); the active line and the settings are unchanged, and an invalid
  action (non-finite offsets, missing image) changes nothing. The original image is not kept in
  the Project (no schema change): Ctrl+Z brings it and its work back in-session; after a reload
  only the crop remains (the autosave caveat under Undo notices). After Apply the view re-fits and
  pending auto-detect / auto-trace suggestions are dropped (they belong to the old image); the user
  stays on the Image step, whose "Current: … W × H px" line shows the new size, and a notice says
  `Cropped to 640 × 480 px.` — with ` 3 points and 1 ref outside the crop were removed.` appended
  when that happened — and offers Undo while the crop is still the newest step.
- **View**: `screen = image · scale + offset` (`src/ui/view.ts`), zoom 5 %–6400 % about the
  cursor (wheel) or the centre (buttons), pan with middle-drag or Space+drag, `F`/Fit. Image
  smoothing is off from 3× so pixel edges show. The view never touches stored coordinates.
- **Step-scoped markers**: refs can be placed/dragged only in the Axes step and points only in
  the Data step, so a click in one step never moves the other's markers. In Axes, a *click* on an
  existing ref still places the pending one (X1 and Y1 usually share the origin); a *drag* moves
  it. Placement and drags are limited to the image area.
- **Place and move modes in the Data step (decided after Phase 6)**: a "Move points" toggle (hand
  icon, `aria-pressed`, shortcut `M`) sits in the toolbar beside Loupe and Snap; it is off by
  default and disabled outside the Data step (Axes ref placement and dragging are unchanged).
  *Off* ("place" mode): every click on the image adds a point to the active line — even on top of
  an existing point of any line — and a pointer drag never moves a point; points are not
  hit-tested or hover-highlighted at all, and the cursor is a crosshair. This replaced Phase 2's
  rule that a press within 9 px of any line's point grabbed it, which made placing a point of one
  line beside another line's point move that point instead. *On* ("move" mode): a click on a point
  selects just it, Shift+click adds or removes it, a drag on a point moves it — or the whole
  selection when it is selected (one undo step) — a drag that starts on empty canvas is a
  rubber-band (marquee) selecting every point of any line inside it (Shift+marquee adds), a click
  on empty canvas clears the selection, and nothing is placed; the cursor is a grab hand over a
  point. **Decision — selection in place mode:** a canvas click never selects an existing point
  (that would make the click near a point do something other than place, which is the bug); in
  place mode the selection comes from the table (row click, Shift/Ctrl+click, "Select all") and
  from the point just placed. The loupe, snap (new points only, so place mode
  only), arrow-key nudging, undo and the status bar work in both modes; an open Auto-trace takes
  clicks in either mode. The setting is a session preference like the loupe and snap (below), not
  part of the Project.
- **Selection (decided after Phase 6)**: in the Data step the selection holds any number of
  points from any lines, in the order they were selected (`src/ui/selection.ts`); in the Axes
  step it is a single ref, as before. The last selected point is the *current* one: the table
  expands its line and scrolls to its row, and the loupe shows it after a nudge; every selected
  row is highlighted, and on the canvas every selected point gets a ring in its line's colour on a
  white halo. A table row click selects just that row; Shift/Ctrl/Cmd+click toggles it. Each line's
  table header has "Select all" (all of that line's points, and the line becomes active).
  Delete/Backspace or the panel button ("Delete 3 points"; "Delete selected points" and disabled
  when nothing is selected) removes every selected point as **one** undo step (`delete-points`;
  a notice offers Undo when it removed more than one). Arrow keys nudge every selected point by
  the same step, and a drag moves them together (`move-points`); a group stops as a whole at the
  image edge, so it keeps its shape. **Decision — active line under a mixed selection:** the
  active line (where new points go) is the line of the point the user picked last by a click —
  canvas click or Shift+click that adds it, a table row, or "Select all"; a marquee, and a
  Shift+click that removes a point, leave it unchanged. The selection is UI state only: never in
  the Project or the autosave (which keeps just `activeDatasetId`). Loading an image or project,
  changing step, Esc, starting or accepting an Auto-trace and deleting clear it; it is validated
  against the document on every render, so an undo/redo or a deleted line drops the points that
  no longer exist.
- **Calibration UX**: guided order X1 → X2 → Y1 → Y2; after a click the value input takes focus.
  "Move" re-places a ref; Delete on a selected ref clears it. Blank values prompt ("Type the
  known value…"); otherwise the engine's error message is shown verbatim. Date inputs show the
  parsed UTC interpretation or the parser's message.
- **Axes step layout (first-time users)**: scale selects · prompt with a "?" button ("How to
  place axis points") that opens an inline help panel (Esc or Close dismiss it, focus returns to
  the button): an inline-SVG example chart with X1/X2 and Y1/Y2 on printed ticks far apart in the
  canvas ref colours, X1 and Y1 sharing a known origin, a "don't" strip (refs too close, a ref
  between labelled ticks) and four short steps · refs list · calibration messages · "Auto-detect
  axes" (and its suggestion panel) **below the refs**. While no calibration is valid its idle
  button is a full-width, 44 px, light-green call to action (`--cta-*` tokens); once calibrated
  or while running it is a normal button, so it does not compete with "Continue to Data →".
- **Theme (light/dark, decided after Phase 5)**: a toolbar toggle, named after the theme it switches to
  ("Dark theme" while light, "Light theme" while dark — the owner's choice over a fixed name with
  `aria-pressed`), switches `data-theme` on `<html>` instantly. With no saved choice the OS preference
  (`prefers-color-scheme`) decides and is followed live; an explicit choice is kept in
  localStorage (`graph-digitizer:theme`, per browser, not in the Project or the autosave) and
  wins on later loads. An inline script in `index.html` applies it before first paint. Every
  colour in `src/index.css` is a token with a dark value. The Auto-detect call to action keeps
  its light-green fill and dark text in both themes (only its border adapts). The canvas is not
  themed: the chart image is never recoloured, and markers, points, ghost labels and overlay
  labels carry white halos or boxes, so they read on light and dark charts alike; only the
  workspace around the image and the loupe frame follow the theme.
- **Overlay**: after a valid fit, dashed gridlines at round values plus the two calibrated axis
  lines, drawn through `linearToPixel` and clipped to the image. Ticks (`src/ui/ticks.ts`) are
  1-2-5 steps for linear, decades for log, values between the refs for reciprocal when the image
  reaches 1/v = 0, and fixed millisecond steps for dates (not calendar-aligned months/years — it
  is a sanity check, not an axis renderer).
- **Lines** (datasets): always at least one; new ones get the next unused name/colour and become
  active. Deleting a line is an undo step (no prompt since Phase 3). Picking another line's point
  makes that line active (Selection, above).
- **Table**: one section per line; `#` is the placement number and stays with its point
  when sorting by X (rows without an x value sort last). Unrepresentable values (`null`) show as
  "—". Significant figures (default 4) and the date format are Project settings; "Sort by X"
  and "Pixel columns" are session view options.
- **Collapsible point lists (decided after Auto-trace)**: each line's section header is a
  disclosure button (colour dot, "Line 1 (66)", chevron; `aria-expanded`/`aria-controls`) that
  collapses or expands its rows; "Collapse all" / "Expand all" sit with the table options. Lines
  start expanded. Collapsing is UI state only — not in the Project (no format bump) — kept in the
  autosave record beside `activeDatasetId`, and it never changes exports: CSV, TSV and JSON hold
  every point. Selecting a point (the last one of a multi-selection) or adding one expands its
  line and scrolls its row into view; collapsing a line whose point is selected keeps it
  collapsed.
- **Panel layout — step controls first (decided after Auto-trace)**: the step's controls (in Data:
  prompt, every line row, "+ Add line", "Delete N points", the Auto-trace buttons and the
  open Auto-trace panel) take their full height and never shrink; the points table gets the rest
  of the panel and scrolls on its own. Fallback for windows too short for both (or the tall Axes
  help panel): the table keeps a minimum of 136 px — its options, the first line's header row and
  the export bar — and only then does the step area scroll. Checked with 6 lines × 200 points
  and the Auto-trace panel open at 1366×768 and 1024×768 (where the toolbar wraps to two rows).
- **Exports follow the table view** (sort, pixel columns, significant figures, date format):
  one CSV for all lines with a `line` column (RFC 4180, CRLF, `<image>-data.csv`); the same
  cells as TSV on the clipboard (LF; tabs/newlines in cells become spaces); the full Project as
  JSON including the image data URL (`<image>-project.json`). Blank cells for `null` values.

**"Lines", not "datasets" (decided in Phase 5).** The UI calls each dataset a *line*: the first
is "Line 1", the button is "+ Add line", new ones are "Line 2", "Line 3"…, and table headings,
aria-labels ("Line name", "Lines") and the CSV/TSV column header (`line`) say so. The data model
keeps the field `datasets` (and the code its `Dataset` names), so saved project files are
unchanged and need no format bump; projects saved earlier keep their "Dataset 1" names.

## Precision tools and persistence (decided in Phase 3)

- **Loupe** (`src/ui/loupe.ts`): a 180 CSS px square inset in the workspace's top-left corner,
  flipping to the top-right when the point it shows is within 24 px of being covered. It ignores
  the pointer (`pointer-events: none`), so it can never swallow a click. It shows the cursor while
  a click would place something (Axes with a ref pending, Data step in place mode) or grab a
  marker, the marker being dragged (centred on the marker, not the cursor), and the selection's
  current point right after a keyboard nudge (until the mouse moves). It copies the decoded source
  image nearest-neighbour, so pixels stay sharp at any main-view zoom. **Magnification is relative to the main view** (2×–16×,
  default 6×: image pixels look six times larger than on the canvas), rounded to a whole number of
  device pixels per image pixel (crisp edges on high-DPI screens) and capped so at least 5 image
  pixels stay visible. A thin translucent crosshair (with a gap, so the line being aligned stays
  visible) marks the exact position; the pixel under it (`Math.round`) is outlined and named in
  the caption. Existing markers and the snap target are drawn in it. `Z` or the toolbar toggles it.
- **Nudging** (`src/ui/nudge.ts`): arrow keys move the selection 1 image px, Shift 10, Alt 0.1
  (Alt wins over Shift); refs only in Axes, points only in Data (same rule as dragging) — every
  selected point together (`nudgedAll`); clamped to the image (a group as a whole) and rounded to
  1e-6 px so repeated 0.1 px steps don't drift. Ignored while a form
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
- **Prompts → Undo notices**: replacing work (load/open over refs or points), deleting a
  dataset and cropping the image (Crop, above) never ask; a notice says what happened and offers
  Undo, shown only while that action is still the newest step. Caveat: the autosave then holds the new state, so after a
  reload the replaced work is gone unless it was saved as a project file.
- **Autosave** (`src/ui/autosave.ts`): IndexedDB database `graph-digitizer`, store `autosave`,
  key `current`: `{ project: toProject(doc), activeDatasetId, collapsed, savedAt }` (`collapsed`:
  ids of lines whose point lists are collapsed), written 400 ms after
  the last change and on `pagehide`/tab hidden. On start it is read through `parseProject` and
  restored unless the user already loaded something — in which case that document is saved as
  soon as the read finishes (it missed the debounced save, which waits for the read); the step
  becomes Data when the restored calibration fits, else Axes; the view is re-fitted. One autosave per browser profile (the last
  tab to write wins). The status bar shows the last save time or a failure.
- **Project files**: "Save project" (Ctrl+S) downloads `<image>-project.json`, the same file as
  "Download JSON". "Open project…" (Ctrl+O), or dropping/pasting a `.json`, reads it through
  `parseProject`, checks that the embedded image decodes to the stated size, and replaces the
  document as an undo step. Plain downloads, not the File System Access API (Chromium-only).
- **Preferences** (loupe on/off and zoom, snap, and the "Move points" tool) are
  remembered per browser in `localStorage` (`graph-digitizer:prefs`); they are not part of the
  project.

## Axis detection and benchmark (decided in Phase 4)

- **Module**: `src/auto/` — pure TS, no DOM (checked by `tsconfig.core.json` and ESLint like
  `src/core`), so Phase 5 can run it in a Web Worker. `detectAxes({ width, height, data })` takes
  RGBA bytes and returns the skew angle, the X/Y axis lines (sub-pixel offset, ends, contrast,
  thickness, confidence), the plot box (four corners; whether top/right are drawn frame lines),
  per-axis tick sets and the strongest line candidates. Phase 5 consumes it (Auto-calibration).
- **Pipeline**: adaptive darkness (pixel darker than the local mean over ~1/40 of the short side;
  ink ≥ 24/255) → skew from a ±5° Hough over ink pixels (sum of squared bins; snapped to 0 unless
  clearly better), refined once from the median tilt of the longest fitted lines → per row/column
  of the skew-corrected frame, the **longest gap-bridged ink run** (text never forms one) →
  bands → each band's run continued past **occlusions** (a white-faced marker drawn on an axis
  hides a stretch of it: a hole ≤ 4 % of the image's short side is crossed when the pieces on
  both sides are ≥ 4 % of the short side and ≥ 3× the hole, of similar darkness; only found
  lines are extended, so rows through side-by-side bars are never chained) → sub-pixel offset = median of clean cross-profile centroids → axis pair = strong
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
  `-- --summary <path>` also writes every row of this table and the calibration table as
  `<path>.csv` and `<path>.json` (`bench/summary.ts`: the console's numbers unrounded, ratios in
  percent, a unit per column; the CSV has one header over the union of both tables' columns).
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
- **Release corpus (2026-11-07)**: the two real figures of Phase 4 and the scatter of Phase 6
  were not CC BY and were replaced before the public release (`fixtures/real/PROVENANCE.md`:
  sources, licences, crop boxes, attribution; git history kept). The real figures are now
  `km-pericardial-pao` (Pao 2020 fig. 1c: L-shaped black axes with the zero lines *inside*
  them, outward ticks, grey + black series, number-at-risk table under the axis title),
  `km-sas-frame-ikawa` (Ikawa 2022 fig. 1a: SAS closed grey frame not at zero, four
  blue/red solid/dashed series, risk table under the axis title), `km-same-colour-styles`
  (Takata 2018 fig. 1) and `scatter-errorbars-glowa` (Glowa 2024 fig. 3a: closed frame with
  outward major and minor ticks on all four sides, the corner majors hidden in the frame; the
  panel downscaled by 2/3 to 960 px wide). Detection on them: every axis and box found (line
  error ≤ 0.3 px; Pao's free-ended box 1.0 px), 4/4 + 5/5, 8/8 + 11/11, 5/5 + 5/5 and 10/10 +
  9/9 majors with 36/36 + 32/32 minors, no false ticks (`bare` 0). Overall (64 images): axes
  95.3 %, tick recall 85.9 %, minor recall 69.5 %, precision 98.7 % (Takata's unlabelled
  10-month minors count against precision, as before). Rebaselined for the corpus change, not
  for a detector change.
- **KM label correction** (history): pixel analysis in Phase 4 found very faint 3-px x tick marks (grey
  ~170–200) at every label of the then-fixture `km-pericardial-effusion.jpg` (removed in the release corpus), which had been labelled
  "no x tick marks"; the label now says `tickMarks: true` (positions unchanged, within 1 px).
  The labels-only case is covered by five synthetic charts (`x-no-tickmarks`).
- **"Axis line" means the line the tick marks hang on**, not where the value 0 is. In a closed
  frame whose zero sits inside it (`km-sas-frame-ikawa`), the detected X/Y axes are the bottom and
  left frame lines; that is correct, and Phase 5 must calibrate from tick positions + labels,
  never assume the axis line is value 0. Labels encode this the same way (`axisLineRow/Col`).

## Auto-calibration (decided in Phase 5)

- **Pipeline** (`autoCalibrate(rgba, ocr)` in `src/auto/auto.ts`, pure TS, OCR injected):
  `detectAxes` → `findLabels` (`labels.ts`) → OCR of each label → `suggestAxis` per axis
  (`suggest.ts`) → `crossCheck` in 2-D. In the app it runs in a module worker
  (`src/workers/auto.worker.ts`); the worker asks the page for OCR, which a Tesseract.js pool
  answers (`src/ui/ocr.ts`, dynamically imported on first use, so it is not in the first-paint
  bundle; nested workers are not available everywhere). The benchmark uses the same pool
  (`src/ocr/pool.ts`) in Node.
- **Tesseract is vendored, not fetched**: `vite.config.ts` (plugin `tesseract-assets`) serves its
  worker script, the three LSTM-only WASM cores and the `@tesseract.js-data/eng` 4.0.0
  `best_int` data (2.9 MB gzipped) under `tesseract/` relative to the app's base URL
  (`/tesseract/` in dev; `src/ui/ocr.ts` builds the URLs from `import.meta.env.BASE_URL`) and
  copies them to `dist/tesseract/` (~15 MB); no CDN at runtime, works offline, no IndexedDB
  copy (`cacheMethod: 'none'`). The e2e spec aborts every non-localhost request and asserts
  none; `npm run privacy:check` (`scripts/privacy-check.ts`) records every request of a full
  session on the production build — page and worker targets, over CDP — into
  `privacy-report.json` and fails on any foreign origin. The base is `BASE_PATH` at build time (default `/`; `/UCSD_GraphEvaluator/` for the
  GitHub Pages deployment in `.github/workflows/deploy.yml`).
- **Finding labels**: the band outside each axis (below X, left of Y), sampled in the
  skew-corrected frame, starting past the outside ticks. Glyphs = 8-connected components at an
  adaptive threshold (30 % of the band's 98th-percentile darkness, clamped to 24–80); dropped:
  too big, solid square blobs (markers, ≥ 80 % filled), colourful ones (mean chroma ≥ 80: data,
  coloured tables — tick labels are black or grey). Rows by vertical overlap, words by gaps under
  half the text height; Y words grow from the axis side, and a much taller glyph sticking out
  above and below (an axis-title letter) starts a new word. **Matching**: with ≥ 2 major ticks,
  X = the row with most words centred on ticks; Y = per tick the axis-nearest word of the level
  row, within 3 text heights of the axis (the number-at-risk tables of the Pao and Ikawa figures fail these tests).
  Without tick marks: the X row nearest the axis with ≥ 3 words, or the right-aligned Y words;
  positions are then label centres (looser tolerance).
- **OCR**: crops are the word box upscaled bilinearly to a 28 px body height (best of 24/28/32/40
  on the corpus), dark on white, contrast-normalised. Pass 1 uses a numeric whitelist
  (`0-9 . , - + e E × x %`), page-segmentation mode 7, falling back to 6 (and 10 for single
  characters) when a read is empty — Tesseract returns nothing for a lone "0" in 7/10 and misreads
  lone exponent digits in 6. A raised trailing group is an exponent, read separately and joined
  as `base^exp`. Pass 2 (free text) runs when pass 1 is not confident or a label did not parse;
  the better interpretation wins.
- **Layout beats OCR for small marks**: Tesseract reads a small "1.0" as "10" at 96 % confidence,
  which would scale an axis by ten with a perfect fit. Decimal points/commas are found from the
  column profile at half the darkest stroke (a run ≤ 0.4 text heights wide with ink only near the
  baseline, empty columns on both sides, digits beyond) and re-inserted by position (digits are
  tabular); a leading minus is restored the same way. A number with a leading zero followed by a
  digit (`08`, `000`) is never a value: it is a lost point.
- **Parsing** (`parseLabel.ts`): sign variants, thousands separators (`10,000`, `1 000`; a single
  comma not followed by exactly three digits is a decimal comma), `1e-3`, `1×10^-3`, `10^3`,
  superscripts, `%` (the number as printed). Dates: full dates via `parseDateTime`, years, and
  month names dated from a year label on the same axis (months increase along the axis; a year
  label means 1 January; walking forward, a month not after the previous one starts a new year).
  Bare day numbers are never dated (their month and year are printed elsewhere): such an axis is
  declined rather than read as numbers.
- **Axis note**: matplotlib's offset/multiplier text (`+1e4` right-aligned under the X labels, or
  above the Y axis top) is found by position and text height and read both ways (`l I o` → `1 0`
  repair); a signed term is added, an unsigned power of ten multiplies. A note read below 50 %
  confidence makes the axis decline — the labels alone are not the values. Text there with two or
  more real letters (a title, units) is not a note.
- **Scale inference**: a consensus fit of value vs position (every label pair proposes a line; the
  one most labels agree with within `max(1.5 px, 3 % of the spacing)` — `max(2.5 px, 8 %)` for
  label centres — wins, then least squares). Linear vs log10: more agreeing labels wins; log needs
  the values to span at least a factor of 4 (on a narrow range both fit). Integer years in steps of
  1–10 → date. A `10^` label whose exponent was not read gets the decade it sits on exactly, else
  nothing is inferred. A tie (two labels) → "uncertain", decided by `10^k` notation or the tick
  pattern.
- **Refs and cross-check**: the two most widely separated agreeing labels with OCR confidence
  ≥ 0.75 (never inferred ones). The line through them must predict every other agreeing label
  within 2 × tolerance and at least 60 % of all read labels; then the engine's `calibrate` with all
  four refs must succeed and reproduce every agreeing label at its tick (2-D residual ≤ 2 ×
  tolerance). A failure makes that axis "low".
- **Confidence**: high = ≥ 3 read labels agree, at most one (or 20 %) disagrees, the scale is
  certain and mean OCR confidence ≥ 0.6; medium = ≥ 3 agree otherwise; low = no usable calibration
  → status `positions` (refs at the outermost major ticks, values blank) or `none`.
- **UI**: "Auto-detect axes" in the Axes step, below the refs (see Axes step layout). The result is drawn as ghost markers
  (dashed axis lines, a box per read label — teal agrees, red disagrees — and dashed refs labelled
  `X1 = 20`) and a panel with the scale, a confidence badge (High/Medium/Low; the score is in its
  tooltip), the reason and editable values per axis. **Never applied silently**: "Accept
  suggestion" applies scales and refs as one undo step (`apply-suggestion`), "Discard" drops it;
  refs it does not mention stay. Partial results are accepted into the manual flow (blank values
  prompt as usual). A suggestion belongs to the image it was made for.
- **Benchmark** (`npm run bench:axes`, ~8 s for 62 images with 4 Tesseract workers): per axis the
  suggested scale and refs predict every labelled true tick that is not a ref; the error is taken
  in the true scale's linear space as a fraction of the labelled range. Every axis ends in exactly
  one of three outcomes: *correct* = suggested at medium/high confidence, scale right and every
  held-out tick within 1 %; *wrong* = suggested at medium/high but not correct; *declined* = no
  medium/high suggestion, left to the user (so calibrated + declined = 100 % and correct + wrong =
  calibrated, per category). Gated against the baseline, overall and per category: correct, wrong,
  wrong-at-high, scale accuracy, images calibrated end to end, known-value error on the real
  figures. *Calibrated* and *declined* are reported, not gated (declining a doubtful suggestion is
  the right trade). `-- --summary <path>` writes both tables as CSV/JSON (see Axis detection). OCR
  output is deterministic on a machine; another CPU may pick a different WASM core.
- **Phase 5 baseline**: 65.3 % of axes correct, **0 wrong**, scale accuracy 97.9 %, median
  held-out error 0.14 % of range, 48.4 % of images end to end. Real figures: both fully correct,
  known values within 0.0009 (pericardial plateau 0.162 → 0.1618; CNS 0.548 / 0.437 / 0.294 /
  0.310 / 0.232 → 0.548 / 0.436 / 0.294 / 0.309 / 0.231). Browser: ~1.3 s per figure on first use
  (loading Tesseract), ~0.3 s warm. **Known failures** (declined, not wrong): ggplot-style charts
  (no axis lines), low-DPI and JPEG labels that OCR misreads (dpi:low 44 % correct), log axes
  whose exponents are 2–4 px tall (x:log10 50 %), date axes labelled with day numbers or without a
  year, offset notes too small to read, axes whose ticks were not detected.
- **Release corpus (2026-11-07)**: with the replaced real figures (see Axis detection → Release
  corpus) 66.4 % of axes correct, 0 wrong, 50.0 % of images end to end; the three KM figures fully
  correct at high confidence (Pao 0.03 / 0.02 % held-out error, Ikawa 0.04 / 0.05 % with one
  misread "0.8" tolerated, Takata as before), every known value within 0.0009 (Pao plateaus
  0.680 / 0.574 / 0.479 / 0.148 / 0.063 / 0.029 / 0 → 0.6803 / 0.5737 / 0.4790 / 0.1481 / 0.0627
  / 0.0291 / 0.0009; Ikawa 0.105 / 0.075 / 0.299 / 0.279 / 0.228 / 0.196 / 0.096 / 0.059 / 0.337
  → 0.1047 / 0.0744 / 0.2991 / 0.2785 / 0.2277 / 0.1960 / 0.0963 / 0.0590 / 0.3374); the Glowa
  scatter both axes high (0.05 / 0.08 %, all ten and nine labels read including the corner
  majors). Every real figure is calibrated end to end.

## Auto-trace (line tracing engine)

One click on a plotted series proposes its points; the Data-step UI (sibling work) shows them and
applies them only on "Accept" — the same rule as axis suggestions. The engine is pure TS in
`src/auto/trace/` (no DOM; it runs in the auto worker and in Node for the benchmark).

- **Contract** (`src/auto/trace/types.ts`, fixed — the UI codes against it; changing a shape means
  updating this section): `traceLine(req: TraceRequest): TraceResult`, re-exported from
  `src/auto/index.ts`. Request: `rgba`, `width`, `height`, `plotBox` (4 corners TL, TR, BR, BL in
  image px, or `null`), `seed` (the clicked pixel, pixel-centre convention), `mode`
  (`'auto' | 'curve' | 'markers'`), `maxPoints` (UI default 25). Result: `ok`, `kind`
  (`'curve' | 'markers' | 'none'`), `color` (series colour at the seed, sRGB), `path` (dense
  centreline or every marker centroid, ordered by px), `points` (the suggestion), optional
  `message` (user-facing, set when `ok` is false), `timings.totalMs`. Each point has a 0–1
  `confidence`. `style` (`'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'unknown'`, added in Phase 6)
  is the clicked series' line style for curves, `'unknown'` for markers, failures, or a stroke too
  short or irregular to tell. `plotBox: null` makes the engine run `detectAxes` and use its box when the seed is
  inside it, else the whole image; a box that does not contain the seed is ignored too. Failures
  never throw: `ok: false, kind: 'none'` with a message (click on background, on the frame, outside
  the image, colour too close to the background, a line clicked in markers mode).
- **Colour model** (`color.ts`): pixel = background + α·(ink − background) + residual.
  Background = median colour of the region; seed = nearest ink pixel within 4 px of the click,
  moved onto the strongest shade of its own colour. In markers and auto mode a click on background
  that ink encloses (inside an open marker: its 4-connected background component stays within
  max(30 px, 6 % of the plot's short side) of the click, so a legend box or the space between
  error bars does not count) seeds on the enclosing ink nearest the click instead, however wide
  the hole, and the template below is the open marker around that hole. Ink = mean of the near-full-strength pixels
  around it, scaled to the typical peak coverage of the line near the seed (a thin or faint line
  never shows its full colour). A pixel is "on" at α ≥ ½ with a residual ≤ max(20, f·|pixel −
  background|) where f = 0.12 + 0.3 × the series' saturation: tight for black, grey and dull
  colours (a dark-grey gridline is ~10° from a brown series), looser for saturated colours that
  JPEG chroma subsampling washes out. Pixels of another colour are marked as possible occluders.
- **Region** (`region.ts`): the plot box (or image). An axis/frame line along a box edge is
  removed only when it has the series' colour (a black curve on black axes); a coloured curve may
  run along a black axis (a KM curve that sits on y = 0 along the x axis) and keeps those pixels.
- **Curves** (`curve.ts`): column-by-column walk from the seed's run (vertical stretch of "on"
  pixels), right, then left primed with the right walk's columns (slope known from the start),
  then right again primed with the left. Next run = touching (8-connected) or within a window of
  the prediction (previous centre + median recent slope); after a long run, straight through first
  (marker, crossing line, same-colour crossing curve), else from the run's far end (a step's
  vertical). Long runs continue through small holes (a line of another colour across a vertical).
  A run whose peak coverage is < 0.65 × the trace's typical peak is not the series (a related
  colour in a JPEG). Gaps: up to ~3.5 % of the plot width over background (dashes, markers of
  other series), up to 30 % where the prediction is covered by another colour (curves drawn over
  each other); a very long run sticking out on both sides is a same-colour crossing gridline.
  **Hidden kinks**: while the prediction is mostly under a marker-sized blob of another colour
  (3–40 px both ways at that spot), the window also allows a slope change of up to 3 px/column
  (a V or Λ reversal under a marker); a run only that allowance reaches must emerge from the hiding
  ink, and is taken only if the gap then runs out with nothing in the plain window and no fork to
  retry. Retry: when a walk dies within 25 accepted columns of the last fork, the alternatives
  are walked (up to depth 3; a retry branch that left a long run does not go straight back
  through it) and the branch that followed the most columns of ink wins (the tip of a diamond
  marker vs the line leaving it). Columns → centreline:
  α-weighted centroids (sub-pixel); a thin stroke entered at one end and left at the other is a
  step's vertical, kept as two **corner** points at the stroke's centre x; a roughly square group
  wider than a stroke that sticks out past the curve is a marker of the series' colour, kept as
  one corner point at its centroid (the data point); a thin group sticking out on both sides
  (censoring '+') is dropped and bridged.
- **Vertices hidden under markers** (`kinks.ts`): a polyline chart's data points sit under its
  markers. Where the path bridges a gap over a compact blob of another colour that the straight
  stretches on both sides point at, the blob's centroid becomes a corner point (also on nearly
  straight runs); otherwise, where the stretches meet at ≥ 12°, their intersection does, if it lies
  near the gap. Either needs the reconstructed stretch (gap end → vertex → gap end) to run over
  ink, so a dash gap gets none. A line ending under a small round blob of another colour that it
  points at is extended to the blob's centroid.
- **Line style and same-colour series** (`style.ts`, Phase 6): colour alone cannot tell apart two
  series of one colour, so the style of the clicked stroke is read and used as a constraint.
  *Classification*: the "on" blobs around the seed are chained along the stroke (nearest pattern-
  sized blob, turns up to ~100° so a dashed step curve turns its corners in dashes). Gaps are
  measured pixel to pixel; a gap mostly over another colour is an occlusion and ends the chain
  (a thin gridline across a gap does not); a gap across other ink of the series' colour is a
  crossing (continues the chain, measures nothing); gaps < 1.5 px join JPEG fragments. The
  stretch around the seed whose gaps agree with the typical one (≥ 5 pieces, gap spread ≤
  max(1.5 px, 35 %)) is a pattern: pieces of one length are dots when ≤ 2.5 line widths + 1 px
  long, else dashes; two lengths alternate as dash-dot. Too few pieces there → the region's
  pattern chain the seed belongs to. Gaps too wide for a line pattern (dotted > 2.5 widths, dashed >
  1.5 dash lengths: a row of evenly spaced markers) are not one. Otherwise a seed blob unbroken
  for ≥ max(40 px, 10 widths) is solid, else `unknown` (no constraint). *Constraint*: ink of the
  series' colour that does not fit the style is treated as another colour (dropped from the
  coverage map, marked as an occluder, bridged as a hidden stretch). A solid seed drops every
  regular pattern chain in the region — ≥ 5 pieces, typical gaps, piece lengths in one or two
  tight clusters (a thin JPEG line broken into fragments of every length is not one) — and, only
  then, bridges thin one-sided spurs (dashes touching it). A patterned seed drops blobs longer than
  2 × its longest dash + 4 widths (the solid series, gridlines) and fills its own gaps: pieces
  linked along chains with its gap and size (dots of a dotted gridline it crosses are too small),
  and chain ends joined across the dropped ink where it crosses the other series; the walker then
  follows it round step corners and along dashed verticals like a solid line, bridging a hole of
  up to a dash and two gaps where the dash touching the other series went with it. After the walk
  the fill is undone; columns that ran mostly over fill are dropped and the rest re-centred on
  real ink. A dotted series' points are the centroids of the dots the walk (or, if it passes more,
  the straight dot chain) went through. In auto mode a patterned seed is a curve, never markers
  (an L-shaped dash at a step corner is compact too).
- **Dotted / dash-dot lines** without a readable pattern: when the seed's blob is one link of an
  evenly gapped chain of small blobs (gaps ≥ 1.5 px within max(1.5 px, 35 %) of each other;
  smaller gaps join JPEG fragments of one stroke), the path follows the chain blob to blob (dot
  centroids, per-column centres along dashes).
- **Markers by shape — "Find points"** (`markers.ts`, Phase 6): one click on a marker finds every
  marker of the same appearance (shape, filled or open, size) and only those, although error bars,
  caps, reference lines and axes run into markers and make each one blob with them. *Template*
  (`markerTemplate`): filled — the thickest point of the seed's blob whose inscribed circle holds
  the seed (inscribed radius D ≥ 2.5 px), the blob opened by k = max(2, min(D − 1, 0.4 D)) px (the
  attached thinner strokes vanish), the shape = the blob's ink within 1 px of the opened part (a
  square keeps its corners); open — the hole the blob encloses next to the seed (4-connected
  background not reaching the search window's edge), or the hole the click landed in (then the
  filled shape is never tried: an open marker merged with a filled one of its colour is still the
  open one), plus the ring around it (twice the blob's half
  width there + 1 px). It must be compact (≤ max(30 px, 6 % of the plot's short side), aspect ≤
  2.5). Ink to match: the shape's inside (its 1-px rim left out) or the whole ring; background
  that defines the shape: an open marker's inside (≥ 2 px from the ring), a filled one's concave
  corners within its box (≥ 1.5 px out); for a filled one also a margin 2–3.4 px around it, which
  pins the size. *Matching* (`findMarkers`): at every anchor in the plot, filled shapes on the image
  opened like the template (bars and lines gone), corners on the raw image (the opening would
  round a square's corners; no bar runs through them); pixels outside the plot or under ink of
  another colour are unknown, ≥ half of each set must be known. Accept when ≥ 80 % of the ink is
  found (a filled shape: ≥ 65 % when the missing part lies to one side — half hidden under an open
  marker's white inside — never for a missing ring, which pockets between error bars would fake),
  ≥ 75 % of the defining background clear and ≥ 50 % of the margin (neighbours in a cluster reach
  into it). Peaks closer than 0.6 × the size are one marker; the centre is the template's centre
  plus a sub-pixel parabola through the agreement at the neighbouring anchors; ink around found
  filled markers that is a whole multiple of a marker's area beyond their number is split
  (k-means) into extra markers, provided it spans no more than (that multiple + 1) marker sizes
  (an error bar thick enough to survive the opening is no cluster). *Legend samples are excluded* (decided in Phase 6, rather than
  flagged): a found marker with a word beside it — ≥ 3 letter-sized pieces of ink of any colour
  (≤ 1.5 sizes wide, ≥ max(3 px, a third of a size) high, ≤ 0.6 sizes apart) starting within 2
  sizes of its edge, at its height — is dropped (an error bar is one long piece, a cap one, a
  dashed line's dashes a line width high). When no template can be cut out (a marker as thin as
  its bars, an open marker whose inside is < 3 px), a small seed blob falls back to the blob match
  of Phase 5: 8-connected blobs whose area is 0.45–2× the seed blob's, size ≤ 1.6× + 2 px and fill
  ratio within 0.25, merged blobs of 2–8× the area split by k-means, centroids coverage-weighted.
  `points` = every marker (`maxPoints` does not apply).
- **Auto mode**: markers when the seed's blob is at most max(30 px, 6 % of the plot's short
  side), roughly round (second-moment elongation < 2.5), not part of a regular chain and not read
  as dashed, dotted or dash-dot; or when the seed's blob is larger (a marker joined to its error
  bars) but a marker template is cut out of it and found at least three times; else curve.
- **Suggested points** (`resample.ts`): always both ends, every step corner, every y extremum
  with prominence ≥ max(3 px, 2 line widths) and every sharp kink (Douglas–Peucker vertex at
  max(0.75 px, ½ line width) turning ≥ 30°, e.g. the data points of a polyline chart) — kept even
  beyond `maxPoints` (owner's decision: a KM curve may get 50+ points rather than lose corners); the rest of the budget evenly in x over the non-vertical stretches, snapped
  to traced points.
- **Benchmark** (`npm run bench:lines`, ~22 s, part of `npm run verify`): `bench/lines/generate.py`
  (Python 3.12 + matplotlib; `npm run bench:lines:corpus`) writes 96 seeded charts, 208 series:
  smooth crossing curves, lines with markers, dashed/dotted/dash-dot, KM steps (starting together
  at 1.0, '+' censoring marks), scatter, black series on black axes, mixed kinds, four series on
  dark gridlines, and (l60–l71, appended so the first 60 are unchanged) zigzag polylines with a
  marker on every vertex — sharp V/Λ reversals under markers of the line's own colour or of
  another colour, 4–11 pt; (l72–l83, `scenario:same-colour`, series tag `same-colour`) pairs of
  one colour (black or a palette colour) told apart only by style — solid + dashed / dash-dot KM
  steps starting together, crossing smooth curves, close plateaus (the second staircase a few px
  off the first), solid + dotted; their seeds keep ≥ 3 px from the other series; (l84–l95,
  `scenario:find-points`, series tags `fill:filled|open`, `marker:circle|square|triangle`) pairs of
  scatter series of one colour told apart by fill (filled vs open circles, squares, triangles) or
  shape (filled circles vs filled squares), 5–9 pt, with vertical and/or horizontal error bars and
  caps drawn under the markers, two points of the second series beside the first's, a marker on
  the x axis, a dashed reference line of the same colour (60 %), legends; an open marker's seed
  is on its outline away from the bars. Gridlines,
  legends, frames, line widths, 72–200 DPI and JPEG (every third) vary.
  Truth per series: data points, their pixels, the drawn polyline, step corners, marker centres,
  and a seed on visible ink of the series with no other ink within 3 px (as a user clicks).
  Real figures (`bench/lines/real/manifest.json`; all CC BY, provenance in
  `fixtures/real/PROVENANCE.md`): the three KM fixtures' `knownValues` plateaus as partial truth
  (`km-pericardial-pao.png` = Pao 2020 fig. 1c: black and grey series, 3 + 4 plateaus;
  `km-sas-frame-ikawa.png` = Ikawa 2022 fig. 1a: blue and red, each solid and dashed, 9 plateaus
  of four series, line styles in the label's `styles`; `km-same-colour-styles.jpg` = Takata 2018
  fig. 1: black solid TFT and dashed FFT; all plateaus measured to ±1 px),
  `scatter-errorbars-glowa.png` (Glowa 2024 fig. 3a, downscaled by 2/3: red filled circles and
  blue filled squares of 12–14 px with horizontal and vertical error bars, caps and fit curves
  of their own colour, grey circles and squares of the same shapes on and under them, legend;
  full marker truth per coloured group in the label's `markerSeries`, centres from the centroid
  of each marker after a morphological opening removes the bars, ±0.5 px; category
  `find-points`), and
  `fixtures/synthetic/synthetic-linear.png` (Chromium-rendered polyline with
  pink markers on its five data points; full truth from its `points`, category `fixture`).
  The previous real figures (a CC BY-NC KM figure, a subscription SAS KM figure and the
  subscription `Graph.png` scatter) were removed for licensing on 2026-11-07; the Phase 6
  numbers quoted below for them are history.
  Corner recall also counts the data points of kink polylines (every vertex is a marker). The plot box passed is `detectAxes`'s (once per image), mode `auto`, 25 points.
  **Metrics**: kind accuracy; coverage (% of the true x-range traced within 3 px); median / p95
  centreline error of traced points; wrong-series rate (> 20 % of a trace's points nearer another
  series); corner recall (true step corners within 2 px of a suggested point); marker recall /
  precision (one-to-one within max(2 px, 0.4 × marker size)); wrong-group rate (found markers that
  match none of their own series but one of another series, as a share of all found); style
  accuracy (a curve's reported
  `style` equals its true one, `unknown` counts as wrong); ms per trace (not gated). Gated
  against `bench/lines/baseline.json`, overall and per category (series kind, style, colour,
  crossing, line width, scenario, grid, JPEG, DPI, legend, frame…); `-- --update` only for an
  explained improvement or trade-off.
  **Errors in data units** (`bench/lines/values.ts`; a second table, reported, not gated): for
  figures whose label carries calibrated axes (the real figures and fixtures, bench/axes label
  format) the same errors are also given through the engine's `calibrate` built from the label's
  outermost tick of each axis — as a user would place the two refs; the maths is never
  reimplemented. Each scored traced point is set against its nearest truth point, each matched
  corner and marker against its true position; the displacement is reported per axis (Δx, Δy) as
  median and p95 in data units and as % of the labelled axis range (lowest to highest labelled
  tick, in the scale's linear space). Rows: OVERALL, each category and each figure (`figure:<id>`)
  × points / corners / markers. Data units are only comparable within one figure, so rows pooling
  several figures show them as `–` and keep the % columns; synthetic charts carry no axis ticks or
  limits, so they have no data-unit rows. `-- --summary <path>` writes both tables as
  `<path>.csv` / `<path>.json` (`bench/summary.ts`, see Axis detection).
- **Baseline** (217 traces, after Phase 6 part B — Find points): kind 96.3 % (the misses are 8 of
  the new scatter series: 7 yield no template and become curves, 1 seed lies on the x axis line),
  markers recall 80.1 % / precision 81.3 % / wrong group 6.9 % over all 45 scatter series. The 19
  scatter series from before: 95.7 % recall / 97.2 % precision (91.2 / 96.0 with the blob matcher;
  every change an improvement except one marker fewer in `l30/s1`, a clump of three overlapping
  diamonds); the Graph figure 19/19 markers, each in its own group (none with the blob matcher,
  which took both for lines); the synthetic Find-points charts 54.6 % recall / 55.4 % precision /
  18.2 % wrong group (7.0 / 19.4 / 15.5 % with the blob matcher). Curve metrics unchanged.
- **After the occlusion fix in `detectAxes`** (markers drawn over an axis no longer cut it short;
  `l84`, `l85`, `l88`, `l89`, `l92`, `l93` now get their true plot box): kind 96.8 %, markers
  recall 81.7 % / precision 81.6 % / wrong group 6.8 %; Find-points charts kind 70.8 % (66.7),
  recall 58.8 % / precision 57.2 % / wrong group 17.5 %. Trade-off: `l85/s0` 13 → 12 of 14 markers
  — its seed used to lie outside the wrong box, so the whole image was searched; inside the true
  box the black marker sitting on the black x axis is removed with the axis (`excludeEdgeLines`).
- **Baseline before part B** (191 traces, after Phase 6 part A — line style): kind 100 %, coverage 93.4 %,
  centreline error median 0.03 px / p95 0.84 px, wrong series 1.7 %, corner recall 57.0 % (68.4 %
  before: the new dashed/dotted KM steps lose most corners, see below), markers recall 91.2 % /
  precision 96.0 %, style accuracy 97.6 %, ~60 ms per trace in Node. PNG coverage 96.5 %, JPEG
  87.2 %; kink polylines 86.7 % with 57.9 % of their vertices as points. Same-colour pairs (26
  traces incl. Takata): coverage 88.9 % (74.0 % with the colour-only tracer), p95 error 0.69 px
  (8.27), wrong series 3.8 %, style 96.2 %. On the first 165 traces every change against the
  previous baseline is an improvement (`l45/s1`, a black dashed line beside a black solid step,
  27 → 100 % coverage; JPEG charts with a dashed series: `l31/s1` 58 → 100 %, `l39/s3` 65 →
  100 %, the dash-dot `l58/s1` 17 → 100 %) except `l31/s3` (dotted, coverage −1.2 % with a lower error) and +0.002 px on two
  dashed traces. Real KM figures: 5/5 series, coverage 100 % (Takata TFT and FFT each on its own
  plateaus), median error 0.14 px (labels are ±1 px). `synthetic-linear` fixture traced end to end
  from any segment with all five data points.
- **Known failures**: steps shorter than about two line widths (dense staircases in thick lines)
  lose corners (corner recall of solid series 68 %); kink vertices under small markers in low-DPI JPEGs, and
  polyline vertices where a same-colour marker merges with a steep stretch, are not always found
  (42 % of kink vertices missed); two series drawn over each other along a step (only the one on
  top is visible) end the trace; thin, faint lines in low-DPI JPEGs fragment (`lw:thin` coverage
  81 %); four-series charts on dark gridlines in JPEG still switch series sometimes (dense: 10.7 %
  wrong); in the blob fallback (no marker template) legend samples and same-colour legend text
  still count as markers; markers hidden behind another series below 45 % of their area are missed. Same-colour series (Phase 6):
  where a dashed series touches the solid one its dashes belong to the solid's stroke, so where the
  two run merged for a while (Takata FFT between ~0.25 and ~0.6, KM pairs with close plateaus) the
  dashed trace ends there (`l74/s1`: 29 %, style unread); dashed/dotted KM steps keep few corners
  (a step's vertical falls in a dash gap: corner recall 13 % dashed, 5 % dotted); dotted JPEG
  steps on gridlines are still often cut short (`l79/s1` 44 %). Find points (Phase 6): a marker no
  thicker than its error bars (≲ 10 px at low DPI) gives no template, so the trace falls back to
  the blob match or becomes a curve; filled circles and filled squares of ≲ 13 px in JPEG are
  told apart only partly (their corners are a pixel or two); clumps of 3+ overlapping markers of
  one kind lose some; a filled marker half hidden under an open one is found ~3 px off centre, or
  only from some seeds when little more than a crescent of it shows (the former `Graph.png` fixture, x ≈ 52); an open
  marker merged with a filled one is found ~2 px toward it, and a click on its ring where the two
  merge (not inside it) may cut the filled shape and return that group; a
  marker of the axes' colour sitting on an axis or frame line is removed with it (`l85/s0`).
- **Release corpus (2026-11-07; 220 traces)**: kind 96.8 %, coverage 92.9 %, median error
  0.03 px / p95 0.90 px, wrong series 2.3 %, corner recall 57.0 %, markers 81.5 % / 81.4 %,
  style 96.6 %; the synthetic corpus is unchanged (its numbers moved only by the real figures
  leaving and joining their categories). Real figures: Pao black and grey series 100 % / 99.6 %
  coverage, error 0.00 px, styles right; Ikawa blue solid 100 % and red solid 94.6 % (error
  0.3 px, labels ±1 px), red dashed 100 % (error 0.14 px); Takata as before (100 %, 0.03–0.05
  px); the Glowa scatter 4/4 red circles and 4/4 blue squares from the 141 keV/µm seeds, no
  grey marker and no legend sample among them (recall and precision 100 %; from the 26 keV/µm
  red seed the circle half hidden under a grey one at 66 is missed, 3/4). **Known failures
  added with this corpus** (documented, not fixed — none has a general fix): (1) Ikawa's blue
  dashed series runs 4 px under the blue solid one with no white between them, so its dashes
  belong to the solid stroke and the dashed trace ends after 1.8 % of its range, following the
  solid (the same-colour merged-stretch failure above; `wrong` for `km` 12.5 %); (2) Ikawa's
  red dashed series has SAS short dashes (~6 px on a 3-px line, gap ~6 px): pieces no longer
  than 2.5 line widths read as *dotted*, so its style is wrong (`km` style 75 %) while the
  trace itself is complete. A pixel-doubled 8-px-marker scatter (Kim 2020 fig. 2a) was tried
  as the find-points fixture and withdrawn: markers no thicker than the lines through them
  give no template (0/5 markers, mode `auto` traces a curve), which is the existing "≲ 10 px
  at low DPI" failure, not a new one.

## Auto-trace — UI

The tracing engine (`traceLine` in `src/auto/trace/`) and its benchmark are specified separately;
this is the UI half. The contract between them is `src/auto/trace/types.ts` (`TraceRequest` →
`TraceResult`).

- **Where**: Data step, under the lines: "Auto-trace line" (disabled until the axes calibrate),
  plus "Trace into a new line" once the active line has points. Starting shows "Click on the curve
  or markers to trace" over the canvas; the next click on the image is the seed (the loupe works
  as when placing points; snap does not apply). While a trace is open, clicks re-seed it and
  markers are not grabbed; Escape, Discard or leaving the step closes it.
- **Default tool (decided 2026-11-06)**: "Auto-trace line" opens by itself — picking, into the
  active line, in the session's mode — whenever the Data step is entered (the step tab, "Continue
  to Data", or a restored or opened project that lands there) and after "+ Add line" (for the new
  line, dropping any trace under review), provided the axes are calibrated, as for the button.
  The Data prompt says it is on and how to leave it: Discard or Escape returns to placing by hand,
  and nothing reopens it until the step is entered or a line is added again; accepting a trace
  closes it as before. Uncalibrated, the step behaves as it did (the buttons stay disabled).
- **Off the main thread**: the auto worker (`src/workers/auto.worker.ts`, message `trace`) runs
  `detectAxes` for the plot box (its four corners, or null) and then the tracer, one worker per
  run; a new seed or setting terminates the previous run. The tracer is imported only through
  `src/workers/traceImpl.ts`, which re-exports `traceLine`.
- **Review**: the result is drawn as ghosts in the colour the points will get — the followed path
  dashed, each proposed point a hollow dashed ring, a cross at the seed — and a panel shows the
  kind detected (Curve / Markers / Nothing found), for a curve its line style when read ("Curve,
  dashed line", with a hint that lines of the same colour in another style are skipped), the
  point count and the time. "Points"
  (slider + number, `maxPoints`, 2–200, default 25) and the mode (Auto / Curve / Markers) are
  session settings; changing either re-runs the trace from the same seed (debounced 120 ms).
- **Find points** (decided in Phase 6): a "Find points" button beside "Auto-trace line" (and "Find
  points into a new line" beside "Trace into a new line") starts the same pick-and-review flow in
  markers mode for that trace only — the prompt reads "Click on one marker to find every marker
  like it", the panel "Find points into …" — without changing the session's mode setting; the
  panel's Mode select shows and changes the open trace's mode. One click on a marker proposes every
  marker of its appearance (engine: Markers by shape above); legend samples are left out. Reading
  error-bar values is not part of it (Non-goals).
- **Never applied silently**: "Accept" adds the proposed points (finite, on the image) as one
  undo step — `add-points` to the active line, or `add-dataset` for a new line named like
  "+ Add line" and coloured with the traced series' colour when it is colourful (max − min channel
  ≥ 60; black/grey series keep the palette colour). "Discard" changes nothing. Accepted points
  are ordinary points (drag, nudge, delete, table, exports). A trace belongs to the image it was
  made for and is UI state, not part of the document or autosave.

## Verification gate

A change is done only when this passes (commands defined in Phase 1, extended later):

```
npm run typecheck && npm run lint && npm test && npm run bench:axes && npm run bench:lines && npm run test:e2e
```

`npm run verify` runs all six. `test:e2e` (Playwright, Chromium, added in Phase 2) starts its own
dev server on port 5174. `bench:axes` (Phase 4, extended with calibration scoring in Phase 5) fails
on any regression against `bench/axes/baseline.json`, `bench:lines` (Auto-trace) against
`bench/lines/baseline.json` (see above). `npm test` also covers the benchmarks' scoring and summary
code (`bench/**/*.test.ts`). Either benchmark takes `-- --summary <path>` to write every row of its
tables as `<path>.csv` and `<path>.json` for reporting; `last-run.json` and the baselines are
unchanged by it.

## Non-goals (for now)

PDF/vector import, polar/ternary/map axes, accounts or cloud storage. (Automatic curve tracing
was listed here until the Auto-trace work above.) Reading error-bar values (the bar ends and caps
around a found marker) is not done yet: "Find points" proposes only the marker centres — a
possible later phase.

## Test fixtures

`fixtures/real/` holds real-world figures with hand-labelled ground truth (`<name>.json`
beside each image). Use them in e2e tests (Phase 2+), the axis benchmark (Phase 4+, listed in
`bench/axes/real/manifest.json`) and the line-tracing benchmark (their `knownValues` plateaus,
listed in `bench/lines/real/manifest.json`). Label from measured pixels, including whether tick marks exist.

**Licensing (decided 2026-11-07)**: only figures published under CC BY may be in the public
repository, each with its source, DOI, PMC id, figure/panel and crop box, licence wording and
URL, attribution, date obtained and labeller recorded in
[`fixtures/real/PROVENANCE.md`](../fixtures/real/PROVENANCE.md). The current four:
`km-pericardial-pao.png` (Pao 2020 fig. 1c, KM-style cumulative incidence, black + grey, zero
lines inside L-shaped axes), `km-sas-frame-ikawa.png` (Ikawa 2022 fig. 1a, SAS closed frame not
at zero, four series in two colours × two styles, censor ticks, risk table below),
`km-same-colour-styles.jpg` (Takata 2018 fig. 1, black solid vs dashed) and
`scatter-errorbars-glowa.png` (Glowa 2024 fig. 3a, red circles and blue squares with
horizontal and vertical error bars, minor ticks, grey same-shape distractors; the only
resampled fixture — downscaled by 2/3, recorded in the provenance). Three earlier figures
(CC BY-NC or subscription) were removed from the tree on that date — listed in the same file —
without rewriting git history.

`fixtures/synthetic/` holds generated charts with exact geometry (linear scatter; date × log10)
and their ground truth, written by `npm run fixtures:synthetic`
(`scripts/make-synthetic-charts.ts`, renders in Playwright's Chromium). Regenerate only when
changing the generator, and commit the PNG and JSON together.
