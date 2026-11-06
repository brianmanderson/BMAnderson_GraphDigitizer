/**
 * Line candidates from projection profiles in the skew-corrected frame.
 *
 * For every whole-pixel offset across a family (each row, for horizontal lines) we walk along the
 * line and record the *longest run* of ink, bridging gaps of a couple of pixels (JPEG noise,
 * a marker's white edge). Using the longest run rather than the total darkness is what keeps text
 * from winning: a caption row or a rotated axis title holds lots of dark pixels but no long
 * unbroken stretch, while an axis line is one continuous run. Adjacent offsets with long runs
 * form one band (a line is 1–3 px thick, more at high DPI).
 *
 * Sub-pixel position: at each pixel along the band we take the darkness profile across it and,
 * where that profile is clean (back to background on both sides — no bar, tick, label or data
 * touching the line there), its centroid. The line's offset is the median of those centroids, so
 * bars standing on an axis or ticks hanging off it cannot drag it. A regression of the centroids
 * along the line also measures any remaining tilt (used to refine the skew angle).
 */

import { INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, frameBounds, type Frame } from './frame.ts';
import type { LineCandidate } from './types.ts';

export type Family = LineCandidate['family'];

/** A candidate plus its fit (kept inside the detector; not part of the public result). */
export type FoundLine = LineCandidate & { fit: LineFit | null };

interface Run {
  start: number;
  end: number;
  mass: number;
  ink: number;
}

export interface LineOptions {
  /** Minimum run length as a fraction of the image's extent along the family. */
  minFraction: number;
  /** Absolute minimum run length, px. */
  minLength: number;
}

export const DEFAULT_LINE_OPTIONS: LineOptions = { minFraction: 0.15, minLength: 30 };

/**
 * Continuing a line past an occlusion: a marker or error-bar cap drawn on top of an axis (a white
 * face hides the line under it) leaves a hole far wider than the gap bridging allows, and the
 * line would end there (the plot box with it). A found line's run is extended across a hole of
 * at most `maxGap` px when the pieces on both sides are long (≥ `minPiece` and ≥ 3× the hole: a
 * dashed line's dashes, a text row's glyphs are not) and about as dark as each other. Only a
 * line already found is extended — joining every row would chain the rows through side-by-side
 * bars into one thick band and lose the axis they stand on.
 */
export interface Occlusion {
  maxGap: number;
  minPiece: number;
}

/** Pieces joined across an occlusion must be within this ratio of each other's mean darkness. */
const OCCLUSION_CONTRAST = 0.6;

/** Limits scale with the image's short side, like a marker's size (it does not depend on the axis). */
export function occlusionFor(width: number, height: number, gap: number): Occlusion {
  const short = Math.min(width, height);
  return { maxGap: Math.max(gap, Math.round(0.04 * short)), minPiece: Math.max(4 * gap, Math.round(0.04 * short)) };
}

/** Longest ink run along one line of a family (at a whole-pixel offset). */
export function longestRun(
  map: DarknessMap,
  frame: Frame,
  family: Family,
  offset: number,
  from: number,
  to: number,
  gap: number,
): Run | null {
  let best: Run | null = null;
  for (const r of inkRuns(map, frame, family, offset, from, to, gap)) {
    if (!best || r.end - r.start > best.end - best.start) best = r;
  }
  return best;
}

/** The gap-bridged ink runs along one line of a family, in order. */
function inkRuns(map: DarknessMap, frame: Frame, family: Family, offset: number, from: number, to: number, gap: number): Run[] {
  const runs: Run[] = [];
  let start = NaN;
  let last = NaN;
  let mass = 0;
  let ink = 0;
  const close = () => {
    if (!Number.isNaN(start)) runs.push({ start, end: last, mass, ink });
    start = NaN;
  };
  for (let t = Math.ceil(from); t <= to; t++) {
    const p = familyPoint(frame, family, t, offset);
    const v = sample(map, p.x, p.y);
    if (v >= INK_THRESHOLD) {
      if (Number.isNaN(start) || t - last > gap + 1) {
        close();
        start = t;
        mass = 0;
        ink = 0;
      }
      last = t;
      mass += v;
      ink++;
    }
  }
  close();
  return runs;
}

/** `run` (one of the runs at `offset`) extended across occlusions on both sides (see `Occlusion`). */
function extendPastOcclusions(
  map: DarknessMap,
  frame: Frame,
  family: Family,
  offset: number,
  run: Run,
  from: number,
  to: number,
  gap: number,
  o: Occlusion,
): Run {
  const runs = inkRuns(map, frame, family, offset, from, to, gap);
  const k = runs.findIndex((r) => r.start === run.start);
  if (k < 0) return run;
  let lo = k;
  let hi = k;
  while (lo > 0 && joins(runs[lo - 1] as Run, runs[lo] as Run, o)) lo--;
  while (hi < runs.length - 1 && joins(runs[hi] as Run, runs[hi + 1] as Run, o)) hi++;
  if (lo === hi) return run;
  const parts = runs.slice(lo, hi + 1);
  return {
    start: parts[0]?.start ?? run.start,
    end: parts[parts.length - 1]?.end ?? run.end,
    mass: parts.reduce((s, r) => s + r.mass, 0),
    ink: parts.reduce((s, r) => s + r.ink, 0),
  };
}

/** Whether run `b` continues run `a` past an occluding mark (see `Occlusion`). */
function joins(a: Run, b: Run, o: Occlusion): boolean {
  const hole = b.start - a.end - 1;
  if (hole > o.maxGap) return false;
  const piece = Math.max(o.minPiece, 3 * hole);
  if (a.end - a.start + 1 < piece || b.end - b.start + 1 < piece) return false;
  const ca = a.mass / Math.max(1, a.ink);
  const cb = b.mass / Math.max(1, b.ink);
  return Math.min(ca, cb) >= OCCLUSION_CONTRAST * Math.max(ca, cb);
}

export interface LineFit {
  offset: number;
  thickness: number;
  /** Clean cross-profile centroids along the line: position along it → offset. */
  samples: { t: number; c: number }[];
}

/**
 * Robust sub-pixel offset of a line near `peakOffset` over [from, to] (see the header). Returns
 * null when fewer than 5 positions along the line have a clean cross-profile.
 */
export function fitLine(
  map: DarknessMap,
  frame: Frame,
  family: Family,
  peakOffset: number,
  from: number,
  to: number,
  radius: number,
): LineFit | null {
  const samples: { t: number; c: number }[] = [];
  const widths: number[] = [];
  const prof = new Float64Array(2 * radius + 1);
  for (let t = Math.ceil(from); t <= to; t++) {
    let max = 0;
    let arg = radius;
    for (let k = -radius; k <= radius; k++) {
      const p = familyPoint(frame, family, t, peakOffset + k);
      const v = Math.max(0, sample(map, p.x, p.y));
      prof[k + radius] = v;
      if (v > max) {
        max = v;
        arg = k + radius;
      }
    }
    if (max < INK_THRESHOLD) continue;
    if ((prof[0] ?? 0) > 0.15 * max || (prof[2 * radius] ?? 0) > 0.15 * max) continue;
    // Contiguous region around the maximum down to a quarter of it: keeps an antialiased line's
    // partial pixels but not the faint adaptive-threshold halo inside a filled bar beside it.
    let lo = arg;
    let hi = arg;
    while (lo > 0 && (prof[lo - 1] ?? 0) >= 0.25 * max) lo--;
    while (hi < 2 * radius && (prof[hi + 1] ?? 0) >= 0.25 * max) hi++;
    let sw = 0;
    let swk = 0;
    for (let i = lo; i <= hi; i++) {
      const v = prof[i] ?? 0;
      sw += v;
      swk += v * (i - radius);
    }
    samples.push({ t, c: peakOffset + swk / sw });
    widths.push(sw / max);
  }
  if (samples.length < 5) return null;
  return { offset: median(samples.map((q) => q.c)), thickness: median(widths), samples };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

/**
 * Tilt of a fitted line relative to the frame, radians (positive = clockwise, like the skew):
 * the slope between the median centroids of its first and last thirds, which ignores anything
 * touching up to a third of the line; null with too few samples.
 */
export function residualTilt(family: Family, fit: LineFit): number | null {
  const n = fit.samples.length;
  if (n < 30) return null;
  const third = Math.floor(n / 3);
  const a = fit.samples.slice(0, third);
  const b = fit.samples.slice(n - third);
  const dt = median(b.map((q) => q.t)) - median(a.map((q) => q.t));
  if (dt <= 0) return null;
  const slope = (median(b.map((q) => q.c)) - median(a.map((q) => q.c))) / dt;
  // Horizontal lines: offset w grows with u by tan δ; vertical lines: u falls with w by tan δ.
  return family === 'horizontal' ? Math.atan(slope) : -Math.atan(slope);
}

/** Ink mass along [from, to] at a (possibly fractional) offset. */
function massAlong(map: DarknessMap, frame: Frame, family: Family, offset: number, from: number, to: number): number {
  let m = 0;
  for (let t = Math.ceil(from); t <= to; t++) {
    const p = familyPoint(frame, family, t, offset);
    const v = sample(map, p.x, p.y);
    if (v > 0) m += v;
  }
  return m;
}

export function gapTolerance(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) / 300));
}

/** All line candidates of one family, strongest first. */
export function findLines(
  map: DarknessMap,
  frame: Frame,
  family: Family,
  options: LineOptions = DEFAULT_LINE_OPTIONS,
): FoundLine[] {
  const b = frameBounds(frame, map.width, map.height);
  const [aMin, aMax, oMin, oMax] =
    family === 'horizontal' ? [b.uMin, b.uMax, b.wMin, b.wMax] : [b.wMin, b.wMax, b.uMin, b.uMax];
  const minLen = Math.max(options.minLength, options.minFraction * (aMax - aMin));
  const gap = gapTolerance(map.width, map.height);
  const maxThick = Math.max(6, Math.round(Math.min(map.width, map.height) * 0.012));
  const occlusion = occlusionFor(map.width, map.height, gap);

  const first = Math.ceil(oMin);
  const runs: (Run | null)[] = [];
  for (let o = first; o <= oMax; o++) {
    const r = longestRun(map, frame, family, o, aMin, aMax, gap);
    runs.push(r && r.end - r.start + 1 >= minLen ? r : null);
  }

  const out: FoundLine[] = [];
  let i = 0;
  while (i < runs.length) {
    if (!runs[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < runs.length && runs[j + 1]) j++;
    // Band [i, j]: pick the strongest offset; its run defines the extent.
    let peak = i;
    for (let k = i; k <= j; k++) if ((runs[k]?.mass ?? 0) > (runs[peak]?.mass ?? 0)) peak = k;
    const core = runs[peak] as Run;
    const peakLen = core.end - core.start + 1;
    let thick = 0;
    for (let k = i; k <= j; k++) {
      const r = runs[k];
      if (r && r.end - r.start + 1 >= 0.5 * peakLen) thick++;
    }
    if (thick <= maxThick) {
      // Sub-pixel centroid over contiguous offsets around the peak with real mass.
      const peakOffset = first + peak;
      const run = extendPastOcclusions(map, frame, family, peakOffset, core, aMin, aMax, gap, occlusion);
      const peakMass = massAlong(map, frame, family, peakOffset, run.start, run.end);
      let sw = peakMass;
      let swo = peakMass * peakOffset;
      for (const dir of [-1, 1]) {
        for (let k = 1; k <= maxThick; k++) {
          const o = peakOffset + dir * k;
          const m = massAlong(map, frame, family, o, run.start, run.end);
          if (m < 0.15 * peakMass) break;
          sw += m;
          swo += m * o;
        }
      }
      const fit = fitLine(map, frame, family, peakOffset, run.start, run.end, maxThick);
      const offset = fit ? fit.offset : swo / sw;
      const contrast = run.mass / Math.max(1, run.ink);
      const length = run.end - run.start;
      out.push({
        family,
        offset,
        start: run.start,
        end: run.end,
        p1: familyPoint(frame, family, run.start, offset),
        p2: familyPoint(frame, family, run.end, offset),
        length,
        contrast,
        // Profile mass over its peak: 1 for a crisp 1-px line, ~2 for an antialiased one
        // straddling two rows.
        thickness: fit ? fit.thickness : sw / Math.max(1e-9, peakMass),
        fit,
        strength: (length * contrast) / 255,
      });
    }
    i = j + 1;
  }
  return out.sort((a, b2) => b2.strength - a.strength);
}
