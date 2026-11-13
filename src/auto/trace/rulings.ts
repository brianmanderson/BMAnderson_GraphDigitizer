/**
 * Rulings: long straight lines of the series' own colour parallel to an axis — a grid drawn in the
 * series' colour (old printed and scanned figures rule their grids in the same black ink as the
 * curves) and frame lines the plot box missed. A trace must never follow one: where the series
 * crosses a ruling, the ruling is ink drawn over it, like a marker of another colour.
 *
 * Detection, per orientation (horizontal shown; vertical is the same transposed): the region is
 * cut into strips STRIP_FRACTION of its width wide; in each strip, a row is full when at least
 * FULL of its pixels are on (beyond the strip's median row where lines of the other orientation
 * crossing a narrow strip make every row partly full), and consecutive full rows form a band (a ruling's cross-section, at
 * most `maxThickness` thick: a filled bar is no ruling). Bands of neighbouring strips that overlap
 * (a slightly rotated scan drifts a little from strip to strip) are linked, across up to
 * MAX_SKIP missing strips; a chain of bands covering at least MIN_SPAN of the strips, with centres
 * on a straight line (residual ≤ STRAIGHT px) and nearly axis-parallel, is a ruling. A long curve
 * is not straight; a long step plateau is, which is why one line alone is never a ruling:
 *
 * - the rulings are kept only as a grid: two or more in one orientation, or at least one in each;
 * - the ruling under the seed is never one (the clicked series is a long straight line: a bias
 *   line, a plateau).
 *
 * `mask(minThickness)` marks the pixels of the rulings at least that thick (still two or more), with
 * the anti-aliased fringe on either side and the parts of an uneven scanned stroke that reach past
 * its median band. `traceLine` (index.ts) decides which are heavy enough to matter for the clicked
 * series and how they are kept off its trace: taken out of the coverage map as ink drawn over the
 * series (a dashed series, a marker: the walker bridges a crossing as a hidden gap, the style chain
 * counts a gap across one as a crossing, and a gap that is all ruling joins the two halves of one
 * cut stroke), or left in as ink a solid curve's walk may cross but never run along (curve.ts,
 * `rulingInk`).
 *
 * Pure TS, no DOM.
 */

import { ON_ALPHA } from './color.ts';
import type { Region } from './region.ts';

/** Strip width as a fraction of the extent along the ruling (min MIN_STRIP px). */
const STRIP_FRACTION = 1 / 48;
const MIN_STRIP = 12;
/** A row of a strip is full when this fraction of its pixels is on. */
const FULL = 0.8;
/** Rows next to a band that are at least this fraction on belong to it (an uneven scanned stroke). */
const PARTIAL = 0.3;
/** A chain of bands must cover this fraction of the strips. */
const MIN_SPAN = 0.7;
/** Missing strips a chain may jump (a ruling broken by a scan, a dash crossing it). */
const MAX_SKIP = 2;
/** Largest residual of the bands' centres from a straight line, px (or a third of its thickness). */
const STRAIGHT = 2;
/**
 * Pixels beside a ruling's median band that go with it: its partly covered fringe, this many px,
 * and on pixels up to half its thickness (an uneven scanned stroke).
 */
const FRINGE = 2;
/** Largest drift across the region (rotation of a scan), as a fraction of the extent. */
const MAX_TILT = 0.02;

interface Band {
  /** Strip index. */
  s: number;
  /** Rows of the band, with the partly full rows beside it. */
  lo: number;
  hi: number;
  /** Centre of its full rows. */
  mid: number;
}

/** A ruling: its centre across at each position along, its thickness and extent along. */
interface Line {
  centre: (a: number) => number;
  thickness: number;
  from: number;
  to: number;
}

export interface Rulings {
  /** Width of the clicked stroke at the seed, px. */
  stroke: number;
  /**
   * Image-sized mask, 1 on the pixels of the rulings at least `minThickness` thick (and what goes
   * with them), or null when those are no grid (fewer than two).
   */
  mask(minThickness: number): Uint8Array | null;
}

/**
 * The rulings of one orientation: chains of bands. `along` runs a0…a1 (x for horizontal rulings),
 * `across` c0…c1; `on(a, c)` whether that pixel is on.
 */
function scan(
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  on: (a: number, c: number) => boolean,
  maxThickness: number,
): Line[] {
  const extent = a1 - a0 + 1;
  const strip = Math.max(MIN_STRIP, Math.round(extent * STRIP_FRACTION));
  const n = Math.max(1, Math.floor(extent / strip));
  // counts[s][c - c0]: on pixels of row c in strip s.
  const span = c1 - c0 + 1;
  const counts = new Int32Array(n * span);
  const widths: number[] = [];
  for (let s = 0; s < n; s++) {
    const lo = a0 + s * strip;
    const hi = s === n - 1 ? a1 : lo + strip - 1;
    widths.push(hi - lo + 1);
    for (let a = lo; a <= hi; a++) for (let c = c0; c <= c1; c++) if (on(a, c)) counts[s * span + c - c0]!++;
  }
  const bands: Band[][] = [];
  for (let s = 0; s < n; s++) {
    const list: Band[] = [];
    // Lines crossing the strip (the other orientation's rulings) add the same count to every row:
    // where that makes every row partly full (a narrow strip), rows are measured above that
    // baseline (the median row).
    const row = Array.from(counts.subarray(s * span, (s + 1) * span)).sort((p, q) => p - q);
    const median = row[row.length >> 1]!;
    const base = median >= PARTIAL * widths[s]! ? median : 0;
    const room = widths[s]! - base;
    if (room < 0.5 * widths[s]!) {
      bands.push(list);
      continue;
    }
    const full = (c: number) => counts[s * span + c - c0]! - base >= FULL * room;
    const part = (c: number) => c >= c0 && c <= c1 && counts[s * span + c - c0]! - base >= PARTIAL * room;
    for (let c = c0; c <= c1; c++) {
      if (!full(c)) continue;
      let e = c;
      while (e + 1 <= c1 && full(e + 1)) e++;
      let lo = c;
      let hi = e;
      for (let k = 0; k < 3 && part(lo - 1); k++) lo--;
      for (let k = 0; k < 3 && part(hi + 1); k++) hi++;
      if (hi - lo + 1 <= maxThickness) list.push({ s, lo, hi, mid: (c + e) / 2 });
      c = e;
    }
    bands.push(list);
  }
  // Link bands strip to strip: each band continues the chain whose last band it overlaps.
  const chains: Band[][] = [];
  const open: Band[][] = [];
  for (let s = 0; s < n; s++) {
    for (const b of bands[s]!) {
      let best: Band[] | null = null;
      let bestD = Infinity;
      for (const ch of open) {
        const last = ch[ch.length - 1]!;
        if (s - last.s > MAX_SKIP + 1 || last.s === s) continue;
        if (b.lo > last.hi + 1 || b.hi < last.lo - 1) continue;
        const d = Math.abs(b.lo + b.hi - last.lo - last.hi);
        if (d < bestD) {
          bestD = d;
          best = ch;
        }
      }
      if (best) best.push(b);
      else {
        const ch = [b];
        chains.push(ch);
        open.push(ch);
      }
    }
    // Chains that can no longer continue are closed.
    for (let i = open.length - 1; i >= 0; i--) if (s - open[i]![open[i]!.length - 1]!.s > MAX_SKIP) open.splice(i, 1);
  }
  const out: Line[] = [];
  for (const ch of chains) {
    if (ch.length < MIN_SPAN * n) continue;
    // The ruling's own thickness: the median band (a curve crossing at a shallow angle thickens a
    // few bands a lot, a dash touching it one; a scanned stroke varies by a few px).
    const thick = ch.map((b) => b.hi - b.lo + 1).sort((p, q) => p - q);
    const T = thick[thick.length >> 1]!;
    const core = ch.filter((b) => b.hi - b.lo + 1 <= T + Math.max(2, T / 2));
    // Straight and nearly axis-parallel: a least-squares line through the core bands' centres
    // (strip centres along, band centres across).
    const xs = core.map((b) => b.s + 0.5);
    const ys = core.map((b) => b.mid);
    const mx = xs.reduce((p, v) => p + v, 0) / xs.length;
    const my = ys.reduce((p, v) => p + v, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxx += (xs[i]! - mx) ** 2;
      sxy += (xs[i]! - mx) * (ys[i]! - my);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    if (Math.abs(slope) * n > MAX_TILT * extent) continue;
    // A hand-ruled or scanned line wobbles by a fraction of its width.
    const tol = Math.max(STRAIGHT, T / 3);
    const straight = ys.filter((y, i) => Math.abs(y - (my + slope * (xs[i]! - mx))) <= tol).length;
    if (straight < MIN_SPAN * n) continue;
    // From the first band to the last, out to the region's ends when they are within reach.
    const first = ch[0]!.s <= MAX_SKIP ? a0 : a0 + ch[0]!.s * strip;
    const lastS = ch[ch.length - 1]!.s;
    const last = lastS >= n - 1 - MAX_SKIP ? a1 : Math.min(a1, a0 + (lastS + 1) * strip - 1);
    out.push({ centre: (a) => my + slope * ((a - a0) / strip - mx), thickness: T, from: first, to: last });
  }
  return out;
}

/**
 * The rulings in the region (see the file comment), or null when there are none to remove. `seed`
 * is the clicked pixel: the ruling it lies on is the series, never removed.
 */
export function findRulings(alpha: Float32Array, region: Region, seed: { x: number; y: number }): Rulings | null {
  const { width: w, x0, y0, x1, y1 } = region;
  if (x1 - x0 < 4 * MIN_STRIP || y1 - y0 < 4 * MIN_STRIP) return null;
  const isOn = (x: number, y: number) => (alpha[y * w + x] ?? -1) >= ON_ALPHA;
  // The clicked stroke's width: the shorter of its vertical and horizontal runs through the seed.
  let up = seed.y;
  while (up > y0 && isOn(seed.x, up - 1) && seed.y - up < 200) up--;
  let down = seed.y;
  while (down < y1 && isOn(seed.x, down + 1) && down - seed.y < 200) down++;
  let left = seed.x;
  while (left > x0 && isOn(left - 1, seed.y) && seed.x - left < 200) left--;
  let right = seed.x;
  while (right < x1 && isOn(right + 1, seed.y) && right - seed.x < 200) right++;
  const stroke = Math.min(down - up + 1, right - left + 1);
  const maxThickness = Math.max(8, Math.round(0.025 * Math.min(x1 - x0 + 1, y1 - y0 + 1)));
  /** Rows of a ruling's band at position a along it, or null outside its extent. */
  const bandAt = (r: Line, a: number): [number, number] | null => {
    if (a < r.from || a > r.to) return null;
    const c = r.centre(a);
    return [Math.round(c - (r.thickness - 1) / 2), Math.round(c + (r.thickness - 1) / 2)];
  };
  const onSeed = (r: Line, along: number, across: number) => {
    const b = bandAt(r, along);
    return !!b && across >= b[0] - 2 && across <= b[1] + 2;
  };
  const hs = scan(x0, x1, y0, y1, isOn, maxThickness).filter((r) => !onSeed(r, seed.x, seed.y));
  const vs = scan(y0, y1, x0, x1, (a, c) => isOn(c, a), maxThickness).filter((r) => !onSeed(r, seed.y, seed.x));
  if (hs.length + vs.length < 2) return null;
  /** Mark the band at every position along the ruling, and what goes with it beside it. */
  const paint = (mask: Uint8Array, r: Line, c0: number, c1: number, k: (a: number, c: number) => number) => {
    // An uneven scanned stroke reaches past its median band in places: on pixels up to half its
    // thickness, then the partly covered fringe.
    const extra = Math.max(FRINGE, Math.round(r.thickness / 2));
    for (let a = r.from; a <= r.to; a++) {
      const b = bandAt(r, a)!;
      for (let c = Math.max(c0, b[0]); c <= Math.min(c1, b[1]); c++) {
        const kk = k(a, c);
        if ((alpha[kk] ?? -1) >= 0) mask[kk] = 1;
      }
      for (const [start, step] of [
        [b[0] - 1, -1],
        [b[1] + 1, 1],
      ] as const) {
        let n = 0;
        for (let c = start; c >= c0 && c <= c1; c += step) {
          const v = alpha[k(a, c)] ?? -1;
          if (v <= 0) break;
          if (v >= ON_ALPHA && ++n > extra) break;
          mask[k(a, c)] = 1;
          if (v < ON_ALPHA && Math.abs(c - start) >= extra + FRINGE) break;
        }
      }
    }
  };
  return {
    stroke,
    mask: (minThickness: number) => {
      const h = hs.filter((r) => r.thickness >= minThickness);
      const v = vs.filter((r) => r.thickness >= minThickness);
      if (h.length + v.length < 2) return null;
      const mask = new Uint8Array(alpha.length);
      for (const r of h) paint(mask, r, y0, y1, (a, c) => c * w + a);
      for (const r of v) paint(mask, r, x0, x1, (a, c) => a * w + c);
      return mask;
    },
  };
}
