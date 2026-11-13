/**
 * Tick detection along a found axis line.
 *
 * 1. Scan: at each position along the line, walk away from it (on one side) and measure how far
 *    ink continues — a tick is a short perpendicular run that starts at the line and stops within
 *    `maxTickLength`. Adjacent columns are summed in pairs so a thin antialiased tick split over
 *    two columns keeps its full darkness. Ink must reach a fraction of the axis line's own
 *    contrast, so a lighter gridline continuing a tick into the plot ends the walk instead of
 *    making the "tick" look endless. Runs longer than that (gridlines, bar edges, data) and
 *    blobs wider than a tick are not ticks.
 * 2. Pattern: major ticks are evenly spaced. Every pair of long-enough marks proposes a spacing;
 *    the lattice explaining the most marks with the fewest empty slots wins, refined by least
 *    squares. Marks off the lattice are rejected. Shorter marks between the majors are accepted
 *    as minor ticks (linear subdivisions or the uneven 2…9 of a log decade) when there are enough
 *    of them and they have a consistent length. Several reference lengths for "major" are tried
 *    (a log axis may show two long decade ticks among twenty short ones). Minors at log10(2…9)
 *    of each interval mark the set as `pattern: 'log'`.
 * 3. Confidence: from the number of inliers, the fraction of long marks they explain, how full
 *    the lattice is, and the residual (or the log-minor fit). Fewer than three majors (without
 *    minors to back them up) means no ticks and confidence 0 — an axis with labels but no tick
 *    marks must not get invented ones.
 */

import { INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, type Frame } from './frame.ts';
import type { LineCandidate, Point, Tick, TickSet, TickSide } from './types.ts';

interface Segment {
  along: number;
  length: number;
  mass: number;
  /** Ink spreads sideways just beyond the mark's tip: it may be a label glyph touching the line. */
  glyph?: boolean;
}

export interface TickOptions {
  maxTickLength: number;
}

export function defaultTickOptions(width: number, height: number): TickOptions {
  return { maxTickLength: Math.max(12, Math.round(0.035 * Math.min(width, height))) };
}

const EMPTY: TickSet = { ticks: [], spacing: null, pattern: null, side: null, confidence: 0, rejected: [] };

/** Marks on one side of the line (`sign` +1 = increasing offset: below / right). */
export function scanSide(map: DarknessMap, frame: Frame, line: LineCandidate, sign: 1 | -1, opts: TickOptions): Segment[] {
  // Walk on whole-pixel offsets just beyond the line's edge (on an unrotated image these are pixel
  // rows/columns, so a faint 1-px tick is not blurred into its white neighbour).
  const edge = line.offset + sign * (line.thickness / 2 + 0.25);
  const base = sign > 0 ? Math.ceil(edge) : Math.floor(edge);
  const maxK = opts.maxTickLength;
  // A mark must start with real ink (relative to the axis's own contrast, so faint ticks on a
  // faint axis count) and continues while it stays at least half as dark as where it started:
  // a black tick running into a lighter gridline stops there.
  const tau = Math.max(INK_THRESHOLD * 0.75, 0.2 * line.contrast);
  const margin = 4;
  const from = Math.ceil(line.start - margin);
  const to = Math.floor(line.end + margin);
  const extents: { along: number; ext: number; mass: number }[] = [];
  const at = (t: number, k: number) => {
    const p = familyPoint(frame, line.family, t, base + sign * k);
    return sample(map, p.x, p.y);
  };
  for (let t = from; t < to; t++) {
    let ext = 0;
    let mass = 0;
    let ref = 0;
    for (let k = 0; k <= maxK; k++) {
      const a = at(t, k);
      const b = at(t + 1, k);
      if (a < 0 || b < 0) break;
      // Adjacent columns summed: a thin antialiased tick split over two keeps its darkness.
      const v = a + b;
      if (v < tau || v < 0.5 * ref) break;
      if (k === 0) ref = v;
      else if (k === 1) ref = Math.min(ref, v);
      ext++;
      mass += v;
    }
    extents.push({ along: t + 0.5, ext, mass });
  }
  const segments: Segment[] = [];
  const maxWidth = Math.max(4, Math.ceil(2 * line.thickness) + 2);
  // A mark must stick out past the line's edge by at least half the line's thickness: a thick
  // hand-ruled or scanned line wobbles by a few pixels along its length, and those bumps are not
  // ticks (a drawn tick is several line widths long).
  const minExt = Math.max(2, 0.5 * line.thickness);
  // A tick ends in a free tip. A tick label written against the line (hand-lettered labels, or
  // labels close to a thick blurred line) also makes a short mark, but there the ink spreads
  // sideways just beyond the mark's far end, where its own columns are empty: the rest of the
  // glyph. (A lighter gridline continuing a tick, or a line parallel to the axis at its tip, runs
  // on through the tick's own columns; neighbouring ticks of the same length end where this one
  // does, and a longer tick beside it starts at the line; none of these counts.)
  const pad = Math.max(2, Math.ceil(line.thickness));
  const isMark = (t: number) => (extents[t - from]?.ext ?? 0) >= minExt || (extents[t - 1 - from]?.ext ?? 0) >= minExt;
  const glyphAtTip = (t0: number, t1: number, longest: number) => {
    let n = 0;
    for (let k = longest + 1; k <= longest + pad; k++) {
      // Something running on through the mark's own columns here (a lighter gridline, or a line
      // parallel to the axis that the tick runs into) is no glyph: skip this depth.
      let own = 0;
      for (let t = t0; t <= t1; t++) own = Math.max(own, at(t, k));
      if (own >= 0.5 * tau) continue;
      for (let d = 1; d <= pad; d++) {
        // A column that starts at the line is another tick (a longer major beside a minor).
        const l = t0 - d;
        const r = t1 + 1 + d;
        if (at(l, k) >= tau && !isMark(l)) n++;
        if (at(r, k) >= tau && !isMark(r)) n++;
      }
    }
    return n >= 2;
  };
  let i = 0;
  while (i < extents.length) {
    const e = extents[i];
    if (!e || e.ext < 2) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < extents.length && (extents[j + 1]?.ext ?? 0) >= 2) j++;
    const group = extents.slice(i, j + 1);
    const longest = Math.max(...group.map((g) => g.ext));
    const t0 = from + i;
    const t1 = from + j + 1; // each extent sums columns t and t + 1
    if (group.length <= maxWidth && longest >= minExt && longest < opts.maxTickLength + 1) {
      let sw = 0;
      let st = 0;
      for (const g of group) {
        sw += g.mass;
        st += g.mass * g.along;
      }
      const seg: Segment = { along: st / sw, length: longest + Math.abs(base - line.offset) - 0.5, mass: sw };
      if (glyphAtTip(t0, t1, longest)) seg.glyph = true;
      segments.push(seg);
    }
    i = j + 1;
  }
  return segments;
}

interface Lattice {
  anchor: number;
  spacing: number;
  inliers: Segment[];
  slots: number;
  rms: number;
}

const tolerance = (spacing: number) => Math.max(1.2, 0.07 * spacing);

function fitLattice(marks: Segment[], anchor: number, spacing: number): Lattice {
  const tol = tolerance(spacing);
  const byIndex = new Map<number, Segment>();
  for (const m of marks) {
    const n = Math.round((m.along - anchor) / spacing);
    const r = Math.abs(m.along - anchor - n * spacing);
    if (r > tol) continue;
    const prev = byIndex.get(n);
    if (!prev || r < Math.abs(prev.along - anchor - n * spacing)) byIndex.set(n, m);
  }
  const ns = [...byIndex.keys()];
  const slots = ns.length ? Math.max(...ns) - Math.min(...ns) + 1 : 0;
  let ss = 0;
  for (const [n, m] of byIndex) ss += (m.along - anchor - n * spacing) ** 2;
  const inliers = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  return { anchor, spacing, inliers, slots, rms: Math.sqrt(ss / Math.max(1, inliers.length)) };
}

function refine(l: Lattice): Lattice {
  if (l.inliers.length < 2) return l;
  // Least squares t = a + n·p over the inliers' lattice indices.
  const ns = l.inliers.map((m) => Math.round((m.along - l.anchor) / l.spacing));
  const ts = l.inliers.map((m) => m.along);
  const k = ns.length;
  const mn = ns.reduce((s, v) => s + v, 0) / k;
  const mt = ts.reduce((s, v) => s + v, 0) / k;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < k; i++) {
    sxy += ((ns[i] ?? 0) - mn) * ((ts[i] ?? 0) - mt);
    sxx += ((ns[i] ?? 0) - mn) ** 2;
  }
  if (sxx === 0) return l;
  const p = sxy / sxx;
  return { ...l, anchor: mt - p * mn, spacing: p };
}

const score = (l: Lattice) => l.inliers.length - 0.5 * (l.slots - l.inliers.length);

/** Best evenly spaced subset of `marks`, or null. */
function bestLattice(marks: Segment[], minSpacing: number, maxSpacing: number): Lattice | null {
  let best: Lattice | null = null;
  const pool = [...marks].sort((a, b) => b.mass - a.mass).slice(0, 60);
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      const a = pool[i] as Segment;
      const b = pool[j] as Segment;
      const p = b.along - a.along;
      if (p < minSpacing || p > maxSpacing) continue;
      const l = fitLattice(marks, a.along, p);
      if (!best || score(l) > score(best) || (score(l) === score(best) && l.rms < best.rms)) best = l;
    }
  }
  if (!best) return null;
  for (let it = 0; it < 3; it++) {
    const r = refine(best);
    best = fitLattice(marks, r.anchor, r.spacing);
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

/** Tick pattern from the marks on one side. */
export function analyseMarks(frame: Frame, line: LineCandidate, marks: Segment[], side: TickSide): TickSet {
  const point = (m: Segment): Point => familyPoint(frame, line.family, m.along, line.offset);
  const none: TickSet = { ...EMPTY, rejected: marks.map(point) };
  if (marks.length < 2) return none;
  // Most marks on this side run into ink beyond their tips: tick labels written against the line
  // (hand-lettered, or close to a thick blurred line), not ticks. A real tick touched by data now
  // and then does not matter.
  if (marks.filter((m) => m.glyph).length > 0.5 * marks.length) return none;
  // Candidate major-tick lengths: the distinct mark lengths, longest first. A log axis often shows
  // only two decade ticks among many minor ones, so the reference cannot simply be the commonest
  // length; and blur can shorten one major by a pixel, so a shorter reference is tried too. The
  // longest reference that gives a confident pattern wins; otherwise the most confident one.
  const refs: number[] = [];
  for (const m of [...marks].sort((a, b) => b.length - a.length)) {
    if (refs.some((r) => Math.abs(m.length - r) < 0.5)) continue;
    refs.push(m.length);
    if (refs.length === 3) break;
  }
  let best = none;
  for (const ref of refs) {
    const r = analyseWith(marks, ref, line, side, point);
    if (r.confidence >= 0.5) return r;
    if (r.confidence > best.confidence) best = r;
  }
  return best;
}

/** Fractions of a decade where the minor ticks 2…9 of a log axis fall. */
const LOG_FRACTIONS = [2, 3, 4, 5, 6, 7, 8, 9].map((k) => Math.log10(k));

/**
 * Share of minor ticks that sit at log10(2…9) of the major interval around them, measured from
 * either end (which end holds the smaller values is unknown here).
 */
function logPatternScore(majors: Segment[], minors: Segment[], p: number): number {
  if (!minors.length || !majors.length) return 0;
  const first = majors[0]?.along ?? 0;
  const tol = Math.max(1.5 / p, 0.012);
  let fwd = 0;
  let back = 0;
  for (const m of minors) {
    const f = ((((m.along - first) / p) % 1) + 1) % 1;
    if (LOG_FRACTIONS.some((l) => Math.abs(f - l) <= tol)) fwd++;
    if (LOG_FRACTIONS.some((l) => Math.abs(1 - f - l) <= tol)) back++;
  }
  return Math.max(fwd, back) / minors.length;
}

function analyseWith(
  marks: Segment[],
  longRef: number,
  line: LineCandidate,
  side: TickSide,
  point: (m: Segment) => Point,
): TickSet {
  const none: TickSet = { ...EMPTY, rejected: marks.map(point) };
  // Lengths come in whole-pixel steps, so one pixel shorter is already another class.
  const majorMin = longRef - Math.max(0.75, 0.15 * longRef);
  const majorClass = marks.filter((m) => m.length >= majorMin);
  const minorClass = marks.filter((m) => m.length < majorMin && m.length >= 0.3 * longRef);
  const lattice = bestLattice(majorClass, 6, (line.end - line.start) / 1.5);
  if (!lattice || lattice.inliers.length < 2) return none;

  const p = lattice.spacing;
  const majors = lattice.inliers;
  const lo = (majors[0]?.along ?? 0) - p;
  const hi = (majors[majors.length - 1]?.along ?? 0) + p;
  const majorAt = new Set(majors);
  // Minor ticks: between the majors (one spacing beyond them at most), consistent length, away
  // from the majors themselves, and at least one per major interval on average.
  let minors = minorClass.filter(
    (m) => m.along > lo && m.along < hi && majors.every((M) => Math.abs(M.along - m.along) > Math.max(2, 0.05 * p)),
  );
  if (minors.length) {
    const ml = median(minors.map((m) => m.length));
    minors = minors.filter((m) => Math.abs(m.length - ml) <= Math.max(1, 0.3 * ml));
  }
  if (minors.length < Math.max(2, majors.length - 1)) minors = [];
  if (majors.length < 3 && minors.length < 3) return none;
  // Ticks run along the whole axis. A few evenly spaced marks on a short stretch of a long line,
  // with most of the lattice's other positions along the line empty, are chance (bumps on a
  // hand-ruled scan), not ticks.
  const axisSlots = Math.floor((line.end - lattice.anchor) / p) - Math.ceil((line.start - lattice.anchor) / p) + 1;
  if (minors.length < 3 && majors.length < 0.5 * axisSlots) return none;

  const tol = tolerance(p);
  const nTerm = Math.min(1, (majors.length - 1) / 4);
  const purity = majors.length / majorClass.length;
  const fill = majors.length / Math.max(1, lattice.slots);
  const regularity = 1 - Math.min(1, lattice.rms / tol);
  let confidence = nTerm * (0.4 + 0.6 * purity) * (0.5 + 0.5 * fill) * (0.6 + 0.4 * regularity);
  // Minors at log10(2…9) of each interval are strong evidence on their own (and tell Phase 5
  // the axis is logarithmic), even with only two decade ticks visible.
  const logScore = minors.length >= 4 ? logPatternScore(majors, minors, p) : 0;
  const pattern = logScore >= 0.8 ? 'log' : 'even';
  if (pattern === 'log') confidence = Math.max(confidence, (0.5 + 0.5 * Math.min(1, minors.length / 16)) * logScore);

  const ticks: Tick[] = [];
  const minorSet = new Set(minors);
  for (const m of marks) {
    if (majorAt.has(m)) {
      const n = Math.round((m.along - lattice.anchor) / p);
      const r = Math.abs(m.along - lattice.anchor - n * p) / tol;
      ticks.push({ point: point(m), along: m.along, length: m.length, kind: 'major', confidence: confidence * (1 - 0.5 * r) });
    } else if (minorSet.has(m)) {
      ticks.push({ point: point(m), along: m.along, length: m.length, kind: 'minor', confidence: confidence * 0.8 });
    }
  }
  return {
    ticks,
    spacing: p,
    pattern,
    side,
    confidence,
    rejected: marks.filter((m) => !majorAt.has(m) && !minorSet.has(m)).map(point),
  };
}

/**
 * Ticks on an axis line, trying both sides. `outsideSign` is the offset direction away from the
 * plot (+1 below the X axis, −1 left of the Y axis). Ticks drawn across the line ("inout") are
 * found on both sides and reported as `both`.
 */
export function detectTicks(map: DarknessMap, frame: Frame, line: LineCandidate, outsideSign: 1 | -1, opts: TickOptions): TickSet {
  const out = analyseMarks(frame, line, scanSide(map, frame, line, outsideSign, opts), 'outside');
  const inn = analyseMarks(frame, line, scanSide(map, frame, line, outsideSign === 1 ? -1 : 1, opts), 'inside');
  if (out.confidence > 0.3 && inn.confidence > 0.3) {
    const agree = inn.ticks.filter((t) => out.ticks.some((o) => Math.abs(o.along - t.along) <= 2)).length;
    if (agree >= 0.7 * Math.min(out.ticks.length, inn.ticks.length)) {
      // Crossing ticks: keep the more confident side and add the other side's majors that it
      // missed (data or a gridline can hide one half of a tick) when they fit its spacing.
      const [best, other] = out.confidence >= inn.confidence ? [out, inn] : [inn, out];
      const p = best.spacing ?? 0;
      const majors = best.ticks.filter((t) => t.kind === 'major');
      const extra = other.ticks.filter(
        (t) =>
          t.kind === 'major' &&
          !best.ticks.some((b) => Math.abs(b.along - t.along) <= 2) &&
          majors.some((m) => {
            const n = Math.round((t.along - m.along) / p);
            return Math.abs(t.along - m.along - n * p) <= tolerance(p);
          }),
      );
      const ticks = [...best.ticks, ...extra].sort((a, b) => a.along - b.along);
      return { ...best, ticks, side: 'both' };
    }
  }
  return out.confidence >= inn.confidence ? out : inn;
}
