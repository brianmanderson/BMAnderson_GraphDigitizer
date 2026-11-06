/**
 * Automatic line tracing: from one click on a plotted series, propose its points. Pure TS, no
 * DOM (runs in the auto worker and in Node for `npm run bench:lines`).
 *
 * Pipeline (docs/SPEC.md → Auto-trace):
 * 1. Region: the plot box given, or the one `detectAxes` finds around the seed, or the image.
 * 2. Colour model (color.ts): background = median colour of the region; seed = nearest ink pixel
 *    within 4 px of the click, moved onto the strongest shade of its colour; series colour = mean
 *    of the near-full-strength pixels around it, scaled to the typical peak of the line near the
 *    seed (thin lines never show their full colour). Coverage α per pixel; ink of another colour
 *    is marked (occlusion); a frame/axis line along a box edge is removed only when it has the
 *    series colour (region.ts).
 * 3. Mode: 'curve' follows the line through the seed (curve.ts) — or, when the seed's blob is one
 *    link of an evenly gapped chain of small blobs (a dotted or dash-dot line), the chain itself;
 *    'markers' ("Find points") cuts the clicked marker's shape out of its blob (error bars and
 *    lines attached to it are thinner) and finds every marker that looks like it (markers.ts).
 *    'auto' takes markers when the seed's blob is small, roughly round and not part of such a
 *    chain or a dashed line, or when a marker shape cut out of it is found three times or more.
 *    Vertices hidden under markers are restored (kinks.ts): the intersection of the straight
 *    stretches either side of a bridged marker, and a line's end under a marker at its centre.
 * 4. Suggested points (resample.ts): corners and extrema always, then evenly spread to maxPoints;
 *    for markers, every marker.
 */

import { detectAxes } from '../detect.ts';
import { backgroundColor, colorModel, coverage, dist, INK_MIN, inkColor, refineSeed, rgbAt, type Img, type RGB } from './color.ts';
import { columnsToPath, defaultMaxGap, defaultMaxHiddenGap, thicknessOf, traceColumns, type PathPoint } from './curve.ts';
import { extendHiddenEnds, insertHiddenKinks } from './kinks.ts';
import { blobHeight, blobWidth, findBlobs, findMarkers, markerTemplate, matchMarkers, type Blob, type Blobs, type MarkerTemplate } from './markers.ts';
import { excludeEdgeLines, insideQuad, makeRegion } from './region.ts';
import { resample } from './resample.ts';
import { applyStyle, classifyStyle, unfill } from './style.ts';
import type { TracedPoint, TraceRequest, TraceResult } from './types.ts';

export type { LineStyle, TraceMode, TracedPoint, TraceRequest, TraceResult } from './types.ts';

/** How far from the click the seed's ink may be, px. */
const SEED_RADIUS = 4;
/** The series colour must differ from the background by at least this (RGB distance). */
const MIN_CONTRAST = 40;

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
  const s = refineSeed(img, bg, seed.px, seed.py, SEED_RADIUS, inRegion);
  if (!s) return fail('No line or marker at the clicked point: click on the series itself.');
  const ink = typicalStrength(img, bg, inkColor(img, bg, s, inRegion), s, inRegion);
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
  excludeEdgeLines(region, alpha);
  if ((alpha[s.y * w + s.x] ?? -1) < 0.5) {
    return fail('The clicked point is on the plot frame or an axis line, not on a series.', color);
  }

  const found = findBlobs(alpha, region);
  const seedLabel = found.labels[s.y * w + s.x] ?? 0;
  const template = seedLabel ? found.blobs[seedLabel - 1] : undefined;
  if (!template) return fail('No line or marker at the clicked point: click on the series itself.', color);
  const regionMin = Math.min(region.x1 - region.x0 + 1, region.y1 - region.y0 + 1);
  const markerMax = Math.max(30, 0.06 * regionMin);
  const small = blobWidth(template) <= markerMax && blobHeight(template) <= markerMax;

  const ctx = { found, alpha, other, region };
  const sig = classifyStyle(ctx, template, markerMax);
  let kind: 'curve' | 'markers' = req.mode === 'markers' ? 'markers' : 'curve';
  const chained = small && template.elongation < 2.5 && regularChain(found, template, markerMax);
  // A piece of a dashed or dotted line (an L-shaped dash at a step corner is compact too, and a
  // dotted step curve is no straight chain) is not a marker.
  const patterned = sig.style === 'dashed' || sig.style === 'dotted' || sig.style === 'dash-dot';
  if (req.mode === 'auto' && small && template.elongation < 2.5 && !chained && !patterned) kind = 'markers';

  // Markers by shape: the clicked marker cut out of its blob (error bars, caps, reference lines and
  // axes attached to it are thinner) and every place that looks the same. In auto mode a large blob
  // is markers too when a marker shape is cut out of it and found at least three times.
  let shape: MarkerTemplate | null = null;
  let found3: TracedPoint[] | null = null;
  if (kind === 'markers') shape = markerTemplate(found, alpha, region, s, markerMax);
  else if (req.mode === 'auto' && !small && !patterned) {
    shape = markerTemplate(found, alpha, region, s, markerMax);
    if (shape) {
      found3 = findMarkers(found, alpha, other, region, shape);
      if (found3.length >= 3) kind = 'markers';
    }
  }
  if (kind === 'markers') {
    if (!shape && !small) return fail('The clicked series is a line, not markers: trace it as a curve.', color);
    const path: TracedPoint[] = shape ? (found3 ?? findMarkers(found, alpha, other, region, shape)) : matchMarkers(found, template, w);
    return result({ ok: path.length > 0, kind: 'markers', style: 'unknown', color, path, points: path.map((p) => ({ ...p })) });
  }

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
    const walked = traceColumns(alpha, region, s, { maxGap: defaultMaxGap(region), maxHiddenGap: defaultMaxHiddenGap(region), other, ...hole });
    const e = walked && fill ? unfill(fill, walked, alpha, region) : walked;
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
      traced = chainPath(found, straight.length > dots.length ? straight : dots, alpha, w);
      thickness = Math.max(1, Math.min(blobWidth(template), blobHeight(template)));
    } else {
      if (!e || e.length < 2) return fail('Could not follow a line from the clicked point.', color);
      thickness = thicknessOf(e);
      // Vertices hidden under markers: kinks between straight stretches, and ends under a marker.
      const maps = { width: w, height: h, alpha, other };
      // A solid line among dashes of its own colour: the dashes touching it stick out as spurs.
      const spurs = sig.style === 'solid' && dropped;
      traced = extendHiddenEnds(insertHiddenKinks(columnsToPath(e, alpha, w, spurs), thickness, maps), thickness, maps);
    }
  }
  if (traced.length < 2) return fail('Could not follow a line from the clicked point.', color);
  const points = resample(traced, req.maxPoints, thickness);
  const path: TracedPoint[] = traced.map((p) => ({ px: p.px, py: p.py, confidence: p.confidence }));
  return result({ ok: true, kind: 'curve', style: sig.style, color, path, points });
}
