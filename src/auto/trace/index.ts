/**
 * Automatic line tracing: from one click on a plotted series, propose its points. Pure TS, no
 * DOM (runs in the auto worker and in Node for `npm run bench:lines`).
 *
 * Pipeline (docs/SPEC.md → Auto-trace):
 * 1. Region: the plot box given, or the one `detectAxes` finds around the seed, or the image.
 * 2. Colour model (color.ts): background = median colour of the region; seed = nearest ink pixel
 *    within 4 px of the click, moved onto the strongest shade of its colour — or, for a click on
 *    background enclosed by ink (inside an open marker), the enclosing ink nearest the click, and
 *    the marker is then cut out as the open shape around that hole; series colour = mean
 *    of the near-full-strength pixels around it, scaled to the typical peak of the line near the
 *    seed (thin lines never show their full colour). Coverage α per pixel; ink of another colour
 *    is marked (occlusion); a frame/axis line along a box edge is removed only when it has the
 *    series colour (region.ts). Rulings (rulings.ts: a grid ruled in the series' colour, frame
 *    lines the box missed) heavy enough to be taken for the series are kept off the trace: taken
 *    out as ink drawn over a dashed series or a marker, left in as ink a solid curve may cross but
 *    never run along.
 * 3. Mode: 'curve' follows the line through the seed (curve.ts) — or, when the seed's blob is one
 *    link of an evenly gapped chain of small blobs (a dotted or dash-dot line), the chain itself;
 *    'markers' ("Find points") cuts the clicked marker's shape out of its blob (error bars and
 *    lines attached to it are thinner) and finds every marker that looks like it (markers.ts).
 *    'auto' takes markers when the seed's blob is small, roughly round and not part of such a
 *    chain or a dashed line, or when a marker shape cut out of it is found three times or more (a
 *    pocket of background beside a thick line, walled off by thinner lines, is no marker shape).
 *    A dashed walk that ends where its gaps were not filled goes on piece by piece to the next
 *    dash ahead on its course (dashes.ts), to the line's real end.
 *    Vertices hidden under markers are restored (kinks.ts): the intersection of the straight
 *    stretches either side of a bridged marker, and a line's end under a marker at its centre.
 * 4. Suggested points (resample.ts): corners and extrema always, then evenly spread to maxPoints;
 *    for markers, every marker.
 */

import { detectAxes } from '../detect.ts';
import { filledBars } from './bars.ts';
import { backgroundColor, colorModel, coverage, dist, enclosedHole, greySeries, INK_MIN, inkColor, markDarkerInk, maxAlpha, neutralBlack, refineSeed, rgbAt, type Img, type RGB } from './color.ts';
import { hopDashes } from './dashes.ts';
import { columnsToPath, defaultMaxGap, defaultMaxHiddenGap, flatTopped, strengthAlong, thicknessOf, traceAreaEdge, traceColumns, type PathPoint } from './curve.ts';
import { followStroke, mayDoubleBack, pickPoints, takesOver } from './follow.ts';
import { extendHiddenEnds, insertHiddenKinks, levelCorners, stepLike, withStepCorners } from './kinks.ts';
import { crossAtSeed, findCrosses } from './cross.ts';
import { blobHeight, blobWidth, findBlobs, findMarkers, markerTemplate, matchMarkers, roomy, withoutLegendSamples, withoutLighterInk, type Blob, type Blobs, type MarkerTemplate } from './markers.ts';
import { excludeEdgeLines, insideQuad, makeRegion } from './region.ts';
import { resample } from './resample.ts';
import { findRulings } from './rulings.ts';
import { applyStyle, classifyStyle, unfill } from './style.ts';
import type { TracedPoint, TraceRequest, TraceResult } from './types.ts';

export type { LineStyle, TraceMode, TracedPoint, TraceRequest, TraceResult } from './types.ts';

/** How far from the click the seed's ink may be, px. */
const SEED_RADIUS = 4;
/** The series colour must differ from the background by at least this (RGB distance). */
const MIN_CONTRAST = 40;
/** A ruling is taken out when at least this many px (a 1-px line is anti-aliasing's business)… */
const MIN_RULING = 2;
/** …and this fraction of the clicked stroke's width… */
const RULING_STROKE = 0.5;
/**
 * …and, for a series read as dotted or dash-dot, at least this many px: a thinner crossing is
 * within the walker's own tolerances once the gridline's ink is dropped with the dashes it touches.
 */
const HEAVY_RULING = 6;
/** A shape cut out of a small long blob is a marker (not a thick dash) when it is less elongated than this. */
const MARKER_ELONGATION = 1.8;
/** Ink this many times stronger or weaker than the series' own is another shade of its hue. */
const SHADE_RATIO = 1.15;

const now = (): number => {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
};

function validQuad(q: unknown): q is [number, number][] {
  return (
    Array.isArray(q) &&
    q.length === 4 &&
    q.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  );
}

/** The plot box `detectAxes` finds, if the seed lies in it. */
function detectedBox(req: TraceRequest): [number, number][] | null {
  const det = detectAxes({ width: req.width, height: req.height, data: req.rgba });
  const b = det.plotBox;
  if (!b) return null;
  const quad: [number, number][] = [b.topLeft, b.topRight, b.bottomRight, b.bottomLeft].map((p) => [p.x, p.y]);
  return insideQuad(quad, req.seed.px, req.seed.py, 2) ? quad : null;
}

/**
 * A thin or faint line never shows its full colour: every pixel is a blend. Scale the ink colour
 * to the typical peak coverage of the columns around the seed, so the line's own pixels count as
 * fully covered and a line split across two pixel rows still has pixels at ≥ ½.
 */
function typicalStrength(img: Img, bg: RGB, ink: RGB, s: { x: number; y: number }, allowed: (k: number) => boolean): RGB {
  const m = colorModel(bg, ink);
  const peaks: number[] = [];
  for (let x = Math.max(0, s.x - 6); x <= Math.min(img.width - 1, s.x + 6); x++) {
    let peak = 0;
    for (let y = Math.max(0, s.y - 4); y <= Math.min(img.height - 1, s.y + 4); y++) {
      const k = y * img.width + x;
      if (allowed(k)) peak = Math.max(peak, coverage(m, rgbAt(img, k)));
    }
    if (peak >= 0.3) peaks.push(Math.min(1, peak));
  }
  if (peaks.length < 3) return ink;
  peaks.sort((a, b) => a - b);
  const p = peaks[Math.floor(peaks.length / 2)]!;
  return p < 0.85 ? [bg[0] + p * m.dir[0], bg[1] + p * m.dir[1], bg[2] + p * m.dir[2]] : ink;
}

/** Gap between two blobs' bounding boxes, px (0 when they touch or overlap). */
function bboxGap(a: Blob, b: Blob): number {
  const gx = Math.max(0, Math.max(b.x0 - a.x1, a.x0 - b.x1) - 1);
  const gy = Math.max(0, Math.max(b.y0 - a.y1, a.y0 - b.y1) - 1);
  return Math.hypot(gx, gy);
}

/**
 * The chain of small blobs through the seed's blob: from the template it grows to the nearest
 * small blob within reach whose direction turns by less than 60°, both ways, up to `maxLinks`
 * links each way. Returned in order along the chain (left end first), with the gaps between links.
 */
function blobChain(found: Blobs, template: Blob, markerMax: number, maxLinks: number): { chain: Blob[]; gaps: number[] } {
  const size = Math.max(blobWidth(template), blobHeight(template));
  const reach = 3 * size + 4;
  const small = found.blobs.filter((b) => blobWidth(b) <= markerMax && blobHeight(b) <= markerMax);
  const used = new Set<number>([template.label]);
  const sides: { blobs: Blob[]; gaps: number[] }[] = [];
  let firstDir: [number, number] | null = null;
  for (const side of [1, -1]) {
    const out = { blobs: [] as Blob[], gaps: [] as number[] };
    sides.push(out);
    if (side === -1 && !firstDir) break;
    let cur = template;
    let dir: [number, number] | null = side === 1 ? null : [-firstDir![0], -firstDir![1]];
    for (let n = 0; n < maxLinks; n++) {
      let best: Blob | null = null;
      let bestGap = reach;
      for (const b of small) {
        if (used.has(b.label)) continue;
        if (Math.abs(b.cx - cur.cx) > reach + markerMax || Math.abs(b.cy - cur.cy) > reach + markerMax) continue;
        const g = bboxGap(cur, b);
        if (g > bestGap) continue;
        const dx = b.cx - cur.cx;
        const dy = b.cy - cur.cy;
        const len = Math.hypot(dx, dy) || 1;
        if (dir && (dx * dir[0] + dy * dir[1]) / len < 0.5) continue;
        bestGap = g;
        best = b;
      }
      if (!best) break;
      const len = Math.hypot(best.cx - cur.cx, best.cy - cur.cy) || 1;
      dir = [(best.cx - cur.cx) / len, (best.cy - cur.cy) / len];
      if (side === 1 && n === 0) firstDir = dir;
      out.blobs.push(best);
      out.gaps.push(bestGap);
      used.add(best.label);
      cur = best;
    }
  }
  const [a, b] = sides as [{ blobs: Blob[]; gaps: number[] }, { blobs: Blob[]; gaps: number[] } | undefined];
  let chain = [...(b?.blobs ?? []).reverse(), template, ...a.blobs];
  const gaps = [...(b?.gaps ?? []).reverse(), ...a.gaps];
  if (chain.length > 1 && chain[0]!.cx > chain[chain.length - 1]!.cx) chain = chain.reverse();
  return { chain, gaps };
}

/**
 * Whether the seed's blob is one link of an evenly gapped chain of small blobs: a dotted or
 * dash-dot line (all gaps one length, whatever the dash lengths), not a scatter (irregular gaps,
 * no consistent direction).
 */
function regularChain(found: Blobs, template: Blob, markerMax: number): boolean {
  // Gaps under 1.5 px join fragments of one stroke (JPEG breaks thin dashes), not two strokes.
  const gaps = blobChain(found, template, markerMax, 8).gaps.filter((g) => g > 1.5);
  if (gaps.length < 5) return false;
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd <= Math.max(1.5, 0.35 * mean);
}

/** Centreline of a dotted/dash-dot line: dot centroids, and per-column centres along each dash. */
function chainPath(found: Blobs, chain: Blob[], alpha: Float32Array, width: number): PathPoint[] {
  const out: PathPoint[] = [];
  for (const b of chain) {
    if (b.elongation < 2.5) {
      out.push({ px: b.cx, py: b.cy, confidence: 0.9, corner: false });
      continue;
    }
    for (let x = b.x0; x <= b.x1; x++) {
      let sw = 0;
      let sy = 0;
      for (let y = b.y0; y <= b.y1; y++) {
        const k = y * width + x;
        if (found.labels[k] !== b.label) continue;
        const a = Math.min(1, alpha[k] ?? 0);
        sw += a;
        sy += a * y;
      }
      if (sw > 0) out.push({ px: x, py: sy / sw, confidence: 0.9, corner: false });
    }
  }
  return out.sort((p, q) => p.px - q.px);
}

export function traceLine(req: TraceRequest): TraceResult {
  const t0 = now();
  const result = (r: Omit<TraceResult, 'timings'>): TraceResult => ({ ...r, timings: { totalMs: now() - t0 } });
  const fail = (message: string, color: RGB = [0, 0, 0]): TraceResult =>
    result({ ok: false, kind: 'none', style: 'unknown', color: color.map(Math.round) as RGB, path: [], points: [], message });

  const { width: w, height: h, rgba, seed } = req;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || rgba.length < w * h * 4) {
    return fail('The image data does not match its size.');
  }
  if (!Number.isFinite(seed.px) || !Number.isFinite(seed.py) || seed.px < -0.5 || seed.py < -0.5 || seed.px > w - 0.5 || seed.py > h - 0.5) {
    return fail('The clicked point is outside the image.');
  }
  const img = { width: w, height: h, data: rgba };

  let quad = validQuad(req.plotBox) ? req.plotBox : req.plotBox === null ? detectedBox(req) : null;
  if (quad && !insideQuad(quad, seed.px, seed.py, 2)) quad = null;
  const region = makeRegion(w, h, quad);
  const inRegion = (k: number) => region.mask[k] === 1;
  const bg = backgroundColor(img, region.x0, region.y0, region.x1, region.y1, inRegion);
  const regionMin = Math.min(region.x1 - region.x0 + 1, region.y1 - region.y0 + 1);
  const markerMax = Math.max(30, 0.06 * regionMin);
  let s = refineSeed(img, bg, seed.px, seed.py, SEED_RADIUS, inRegion);
  // A click inside an open marker (its hole is wider than SEED_RADIUS): the seed is its ring, and
  // the marker is cut out as an open shape around that hole.
  let hole: { x: number; y: number } | null = null;
  if (req.mode !== 'curve') {
    const h = enclosedHole(img, bg, seed.px, seed.py, Math.ceil(markerMax), inRegion);
    if (h) {
      s = h.seed;
      hole = h.hole;
    }
  }
  if (!s) return fail('No line or marker at the clicked point: click on the series itself.');
  const raw = inkColor(img, bg, s, inRegion);
  const ink = typicalStrength(img, bg, raw, s, inRegion);
  const color = ink.map(Math.round) as RGB;
  if (dist(ink, bg) < MIN_CONTRAST) return fail('The clicked colour is too close to the background to trace.', color);

  const model = colorModel(bg, ink);
  const alpha = new Float32Array(w * h).fill(-1);
  const other = new Uint8Array(w * h);
  for (let y = region.y0; y <= region.y1; y++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const k = y * w + x;
      if (!region.mask[k]) continue;
      const c = rgbAt(img, k);
      const a = coverage(model, c);
      alpha[k] = a;
      if (a < 0.25 && dist(c, bg) >= INK_MIN) other[k] = 1;
    }
  }
  // A grey curve among black markers: black continues the grey's hue, so it would count as the
  // series' strongest ink. Ink much darker than the series' own colour is another series (color.ts).
  const darker = req.mode !== 'markers' && greySeries(colorModel(bg, raw)) ? markDarkerInk(alpha, other, region, maxAlpha(model), s) : null;
  // A click on a bar of a bar chart or histogram: the value end of every bar of its series
  // (bars.ts). Before lines along the box edges are taken out: a row of bars standing on the
  // bottom edge is no frame line.
  if (req.mode !== 'curve') {
    const bars = filledBars({ img, alpha, other, region, model, seed: s, lone: req.mode === 'markers', markerMax });
    if (bars) {
      // Bars win over a fill's edge (`traceAreaEdge`, below), unless in auto mode the clicked fill's
      // edge is a smooth curve, not level bar tops: a layer of a stacked-area chart standing on
      // the baseline, which the bar finder cuts into narrow "bars".
      const area = req.mode === 'auto' ? traceAreaEdge(alpha, region, s) : null;
      if (area && !flatTopped(area)) {
        const path: TracedPoint[] = area.map((p) => ({ px: p.px, py: p.py, confidence: p.confidence }));
        return result({ ok: true, kind: 'curve', style: 'solid', color, path, points: resample(area, req.maxPoints, 1) });
      }
      return result({ ok: true, kind: 'markers', style: 'unknown', color, path: bars, points: bars.map((p) => ({ ...p })) });
    }
  }
  excludeEdgeLines(region, alpha);
  if ((alpha[s.y * w + s.x] ?? -1) < 0.5) {
    return fail('The clicked point is on the plot frame or an axis line, not on a series.', color);
  }

  let found = findBlobs(alpha, region);
  const seedLabel0 = found.labels[s.y * w + s.x] ?? 0;
  let template = seedLabel0 ? found.blobs[seedLabel0 - 1] : undefined;
  if (!template) return fail('No line or marker at the clicked point: click on the series itself.', color);
  let sig = classifyStyle({ found, alpha, other, region, darker }, template, markerMax);

  // A grid ruled in the series' colour (and frame lines the plot box missed) is never a line to
  // follow (rulings.ts). A ruling much thinner than the stroke is never taken for it, nor a thin
  // one for a dotted series (its ink is dropped with the dots it touches and the gaps are joined
  // across it, applyStyle). A heavier one is taken out of the coverage map and the seed's blob and
  // style read again without it: a dash or a marker that touched it stands alone. For a dashed
  // series or a marker it stays out, ink drawn over the series where they cross. A solid curve
  // keeps it as ink (it crosses rulings as it crosses any line of its colour, curve.ts) but may
  // never walk on one (`rulingInk`): taken out, it would leave slivers of the curve at every
  // crossing and the arms of a marker sitting on one to follow.
  // A series read as dashed is taken as it is (rulings are crossed as before), and so is a marker
  // standing clear of them; one read as dotted or dash-dot may be dashes the rulings chopped
  // short, and is read again without them.
  const patterned0 = sig.style === 'dotted' || sig.style === 'dash-dot';
  const marker0 = !patterned0 && blobWidth(template) <= markerMax && blobHeight(template) <= markerMax && template.elongation < 2.5;
  const rulings = sig.style === 'dashed' || marker0 ? null : findRulings(alpha, region, s);
  let ruling = rulings?.mask(Math.max(MIN_RULING, RULING_STROKE * Math.max(rulings.stroke, sig.thickness), patterned0 ? HEAVY_RULING : 0)) ?? undefined;
  let rulingInk: Uint8Array | undefined;
  if (ruling) {
    const saved: number[] = [];
    for (let k = 0; k < alpha.length; k++) {
      if (!ruling[k]) continue;
      saved.push(k, alpha[k]!, other[k]!);
      alpha[k] = -1;
      other[k] = 1;
    }
    const found2 = findBlobs(alpha, region);
    const l = found2.labels[s.y * w + s.x] ?? 0;
    const template2 = l ? found2.blobs[l - 1] : undefined;
    const sig2 = template2 ? classifyStyle({ found: found2, alpha, other, region, ruling, darker }, template2, markerMax) : null;
    const marker2 = !!template2 && blobWidth(template2) <= markerMax && blobHeight(template2) <= markerMax && template2.elongation < 2.5;
    if (template2 && sig2 && (sig2.style === 'dashed' || sig2.style === 'dotted' || sig2.style === 'dash-dot' || marker2)) {
      found = found2;
      template = template2;
      sig = sig2;
    } else {
      for (let i = 0; i < saved.length; i += 3) {
        alpha[saved[i]!] = saved[i + 1]!;
        other[saved[i]!] = saved[i + 2]!;
      }
      rulingInk = ruling;
      ruling = undefined;
    }
  }
  const small = blobWidth(template) <= markerMax && blobHeight(template) <= markerMax;

  // A click inside a fill (an area chart without an outline, a layer of a stacked-area chart): the
  // fill's edge is the series (curve.ts → `traceAreaEdge`).
  if (req.mode !== 'markers' && !small) {
    const area = traceAreaEdge(alpha, region, s);
    if (area) {
      const path: TracedPoint[] = area.map((p) => ({ px: p.px, py: p.py, confidence: p.confidence }));
      return result({ ok: true, kind: 'curve', style: 'solid', color, path, points: resample(area, req.maxPoints, 1) });
    }
  }

  const ctx = { found, alpha, other, region, ruling, darker };
  let kind: 'curve' | 'markers' = req.mode === 'markers' ? 'markers' : 'curve';
  const chained = small && template.elongation < 2.5 && regularChain(found, template, markerMax);
  // A piece of a dashed or dotted line (an L-shaped dash at a step corner is compact too, and a
  // dotted step curve is no straight chain) is not a marker.
  const patterned = sig.style === 'dashed' || sig.style === 'dotted' || sig.style === 'dash-dot';
  if (req.mode === 'auto' && ((small && template.elongation < 2.5 && !chained && !patterned) || hole)) kind = 'markers';

  // Markers by shape: the clicked marker cut out of its blob (error bars, caps, reference lines and
  // axes attached to it are thinner) and every place that looks the same. In auto mode a large blob
  // is markers too when a marker shape is cut out of it and found at least three times; so is a
  // small long one (a marker with its error bar) when the shape cut out of it is compact — a thick
  // dash is not — and a small one, whatever its style was read as, when the shape is a ring.
  let shape: MarkerTemplate | null = null;
  let found3: TracedPoint[] | null = null;
  // A closed loop through the seed (follow.ts) is a curve, whatever shapes can be cut out of it.
  // Every ruling (rulings.ts), however thin, is a line the follower may cross but not run along.
  // The follower runs at most once per trace, and only when asked.
  let followed: ReturnType<typeof followStroke> | undefined;
  const follow = () => (followed !== undefined ? followed : (followed = followStroke({ alpha, other, region, seed: s, maxHiddenGap: defaultMaxHiddenGap(region), blocked: rulings?.mask(0) ?? rulingInk })));
  if (kind === 'markers') shape = markerTemplate(found, alpha, region, s, markerMax, hole);
  else if (req.mode === 'auto' && (!patterned || small)) {
    shape = markerTemplate(found, alpha, region, s, markerMax, hole);
    const tried = shape && (shape.shape === 'open' ? small || !patterned : !patterned && !chained && (!small || shape.elongation < MARKER_ELONGATION));
    if (shape && tried) {
      found3 = findMarkers(found, alpha, other, region, shape);
      // …unless the stroke through the seed is a closed loop: shapes cut from it are no markers.
      if (found3.length >= 3) {
        const loop = follow();
        if (!(loop && loop.closed && takesOver(loop, null, region.x1 - region.x0 + 1, markerMax))) kind = 'markers';
      }
    }
  }
  // A stroke marker ("x", "+") drawn on a line, a gridline or a dashed curve of its colour is one
  // blob with them and no shape is cut out of it: found by its arms instead (cross.ts) — in auto
  // mode when it is found three times or more.
  // Its arms come first also over a shape cut out of it (a thick "x" opened into a filled shape
  // with concave corners, the tiny pocket between an "x" and its line taken for an open marker),
  // never over an open marker with a real inside, nor a small marker standing alone (the blob
  // match, with its own stroke test for crowded plots).
  if (req.mode !== 'curve' && !(shape && roomy(shape)) && (kind === 'curve' || !small || shape)) {
    const cov = (x: number, y: number) => {
      const a = alpha[y * w + x] ?? -1;
      return a <= 0 ? 0 : a < 1 ? a : 1;
    };
    const cross = crossAtSeed(cov, region, s.x, s.y, markerMax / 2);
    const crosses = cross ? withoutLegendSamples(alpha, other, region, findCrosses(cov, region, cross), 2 * cross.len) : [];
    if (crosses.length >= (req.mode === 'markers' ? 1 : 3)) {
      return result({ ok: true, kind: 'markers', style: 'unknown', color, path: crosses, points: crosses.map((p) => ({ ...p })) });
    }
  }
  if (kind === 'markers') {
    if (!shape && !small) return fail('The clicked series is a line, not markers: trace it as a curve.', color);
    let path: TracedPoint[];
    if (shape) path = found3 ?? findMarkers(found, alpha, other, region, shape);
    else {
      // Small markers matched blob by blob. A black series' lighter greys (curves, gridlines drawn
      // through a cloud of black markers) are not its ink: they would join the markers into one blob.
      let f = found;
      let t = template;
      let a: Float32Array = alpha;
      const lighter = neutralBlack(colorModel(bg, raw)) ? withoutLighterInk(alpha, region, Math.max(blobWidth(template), blobHeight(template))) : null;
      if (lighter) {
        const f2 = findBlobs(lighter, region);
        const l = f2.labels[s.y * w + s.x] ?? 0;
        if (l) {
          f = f2;
          t = f2.blobs[l - 1]!;
          a = lighter;
        }
      }
      path = matchMarkers(f, t, w, a);
    }
    return result({ ok: path.length > 0, kind: 'markers', style: 'unknown', color, path, points: path.map((p) => ({ ...p })) });
  }

  // A stroke that doubles back (a loop, a spiral, a curve that folds over itself) is no function of
  // x: the column walk follows it to the first fold at best. The path follower (follow.ts) takes
  // over only then — when its path doubles back, agrees with the walk and is clearly longer.
  const doublingBack = (walked: PathPoint[] | null, thick: number): TraceResult | null => {
    if (patterned || chained) return null;
    // Only where the walk shows a fold: a jump, or an end where the stroke turns back.
    if (walked && walked.length >= 2 && !mayDoubleBack(walked, alpha, region, thick)) return null;
    const f = follow();
    if (!f || !takesOver(f, walked, region.x1 - region.x0 + 1, markerMax)) return null;
    // What the follower adds beyond the walk must be the series' own ink: where shades of one hue
    // meet (curves of a one-hue palette from a common start), it would turn back along a lighter or
    // darker one (curve.ts → DARKER_RATIO).
    if (walked && walked.length >= 2) {
      const r = Math.max(1, Math.ceil(thick / 2));
      const reach = 2 * thick + 2;
      const added = f.path.filter((p) => !walked.some((q) => Math.hypot(q.px - p.px, q.py - p.py) <= reach));
      const own = strengthAlong(walked, alpha, region, r);
      const theirs = added.length >= 8 ? strengthAlong(added, alpha, region, r) : own;
      if (own > 0 && (theirs > SHADE_RATIO * own || theirs < own / SHADE_RATIO)) return null;
    }
    const path: TracedPoint[] = f.path.map((p) => ({ px: p.px, py: p.py, confidence: p.confidence }));
    return result({ ok: true, kind: 'curve', style: sig.style, color, path, points: pickPoints(f.path, req.maxPoints) });
  };

  let traced: PathPoint[];
  let thickness: number;
  if (chained && !patterned) {
    // A chain of dots whose pattern was not read (too few, uneven): follow the chain itself.
    traced = chainPath(found, blobChain(found, template, markerMax, Number.POSITIVE_INFINITY).chain, alpha, w);
    thickness = Math.max(1, Math.min(blobWidth(template), blobHeight(template)));
  } else {
    // A dotted series' straight chain of dots, before the coverage map is changed (fallback below).
    const straight = sig.style === 'dotted' && chained ? blobChain(found, template, markerMax, Number.POSITIVE_INFINITY).chain : [];
    // Ink of the series' colour that does not fit the seed's style is another series: an occluder.
    const { fill, dropped } = applyStyle(ctx, template, sig, markerMax);
    // Where a dashed series crosses the other one, the dash touching it went with it: a hole of up
    // to a dash and two gaps in a vertical is bridged when all of it is that series' ink.
    const hole = patterned ? { coveredHole: Math.ceil(sig.maxOn + 2 * sig.gap + 2 * sig.thickness) } : {};
    const opts = { maxGap: defaultMaxGap(region), maxHiddenGap: defaultMaxHiddenGap(region), other, ruling, rulingInk, tips: patterned && !!ruling, ...hole };
    let walked = traceColumns(alpha, region, s, opts);
    // A dashed line's walk ends where its gaps were not filled (dashes too uneven for one pattern,
    // a dash cut by a gridline): on from the next piece ahead, to the line's real end (dashes.ts).
    if (walked && (sig.style === 'dashed' || sig.style === 'dash-dot')) walked = hopDashes(walked, found, alpha, region, sig, opts);
    // A patterned step curve has no vertical strokes to take corners from once the fill is undone:
    // they are read from the walk over the filled line, then from the levels either side (kinks.ts).
    const filled = walked && fill ? columnsToPath(walked, alpha, w) : [];
    const filledCorners = filled.filter((p) => p.corner);
    // Only for a step curve (level between its verticals, with the gaps filled or as drawn): a
    // smooth dashed curve gets no corners.
    const steps = (real: PathPoint[]) => patterned && (stepLike(real) || stepLike(filled));
    const e = walked && fill ? unfill(fill, walked, alpha, region) : walked;
    // Level ends either side of one vertical of a patterned step: a gap and a piece apart at most.
    const cornerJoin = sig.gap + sig.maxOn + 2 * sig.thickness + 2;
    // The dots the walk went through (a walk can't start up a steep thin dotted line from one dot).
    const dots: Blob[] = [];
    if (sig.style === 'dotted' && e) {
      const seen = new Set<number>();
      for (const c of e) {
        for (let y = c.top; y <= c.bottom; y++) {
          const l = found.labels[y * w + c.x] ?? 0;
          if (l && !seen.has(l)) {
            seen.add(l);
            dots.push(found.blobs[l - 1]!);
          }
        }
      }
    }
    if (sig.style === 'dotted' && (dots.length >= 2 || straight.length >= 2)) {
      // A dotted line: its points are the centroids of its dots, along the walk or the straight
      // chain, whichever passes through more of them.
      thickness = Math.max(1, Math.min(blobWidth(template), blobHeight(template)));
      traced = chainPath(found, straight.length > dots.length ? straight : dots, alpha, w);
      if (steps(traced)) traced = levelCorners(withStepCorners(traced, filledCorners, thickness), thickness, { width: w, height: h, alpha, other }, cornerJoin);
    } else {
      if (!e || e.length < 2) return doublingBack(null, sig.thickness) ?? fail('Could not follow a line from the clicked point.', color);
      thickness = thicknessOf(e);
      // Vertices hidden under markers: kinks between straight stretches, and ends under a marker.
      const maps = { width: w, height: h, alpha, other };
      // A solid line among dashes of its own colour: the dashes touching it stick out as spurs.
      const spurs = sig.style === 'solid' && dropped;
      let centre = columnsToPath(e, alpha, w, spurs);
      if (steps(centre)) centre = levelCorners(withStepCorners(centre, filledCorners, thickness), thickness, maps, cornerJoin);
      traced = extendHiddenEnds(insertHiddenKinks(centre, thickness, maps), thickness, maps);
    }
  }
  const doubled = doublingBack(traced.length < 2 ? null : traced, thickness);
  if (doubled) return doubled;
  if (traced.length < 2) return fail('Could not follow a line from the clicked point.', color);
  const points = resample(traced, req.maxPoints, thickness);
  const path: TracedPoint[] = traced.map((p) => ({ px: p.px, py: p.py, confidence: p.confidence }));
  return result({ ok: true, kind: 'curve', style: sig.style, color, path, points });
}
