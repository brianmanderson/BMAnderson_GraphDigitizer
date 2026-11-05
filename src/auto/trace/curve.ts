/**
 * Curve following, column by column, on the coverage map (α per pixel, −1 = not the series
 * colour or outside the plot; see color.ts).
 *
 * 1. In each column the "runs" are vertical stretches of pixels at least half covered by the
 *    series colour. A shallow curve gives a run about one line width long; a steep part, a step's
 *    vertical segment, a marker or a crossing line gives a long run.
 * 2. From the seed's run the walk goes right, then left (primed with the right walk's columns so
 *    its slope is known from the start), then right again primed with the left. The next run
 *    touches the previous one (8-connectivity) or, after a gap, lies within a window around the
 *    prediction; the run nearest the prediction wins. The prediction is the previous centre plus
 *    the median recent slope (one step or crossing does not tilt it). After a long run it is
 *    straight through at the slope before it when a run is there (a marker, a crossing line or a
 *    same-colour curve crossing), else the run's end farther from where the walk entered it (a
 *    step's vertical segment). A long run is continued through small holes (a line of another
 *    colour drawn across a vertical). Runs much weaker than the trace's typical peak coverage are
 *    not the series (a related colour in a JPEG). Gaps up to ~3.5 % of the plot width are bridged
 *    over background, and up to 30 % of it where the prediction is covered by ink of another
 *    colour (the curve hidden under another series); a very long run sticking out far on both sides of
 *    the prediction is a crossing gridline of the same colour, treated as a gap.
 * 3. Limited backtracking: when the walk dies within RETRY_COLUMNS of the last column that had
 *    several acceptable runs (the tip of a marker, a censoring mark at a step corner), the
 *    alternatives are walked too and the one that gets farthest wins.
 * 4. Columns become centreline points (`columnsToPath`): a short run's centre is the α-weighted
 *    centroid (sub-pixel). Consecutive long runs that overlap form a group: when the group is a
 *    thin stroke that the curve enters at one end and leaves at the other it is a step's vertical
 *    segment, kept as two corner points at the stroke's centre x; when it sticks out on both sides
 *    of the curve it is a marker or a mark of the same colour, dropped (the path bridges it);
 *    otherwise (a steep curve) each column keeps its centroid.
 */

import { ON_ALPHA } from './color.ts';
import type { Region } from './region.ts';

export interface Run {
  top: number;
  bottom: number;
}

export interface ColumnEntry extends Run {
  x: number;
  /** α-weighted centre of the run (sub-pixel). */
  cy: number;
  /** Columns skipped just before this one in the walk (0 = adjacent). */
  afterGap: number;
  /** Highest coverage in the run. */
  peak: number;
}

export interface PathPoint {
  px: number;
  py: number;
  confidence: number;
  /** A step corner (end of a vertical segment): always kept when resampling. */
  corner: boolean;
}

const runLength = (r: Run) => r.bottom - r.top + 1;

/** Highest coverage in a run (capped: a pixel darker than the ink is just "full"). */
function runPeak(alpha: Float32Array, width: number, x: number, r: Run): number {
  let p = 0;
  for (let y = r.top; y <= r.bottom; y++) p = Math.max(p, alpha[y * width + x] ?? 0);
  return Math.min(1.5, p);
}

/**
 * A run whose strongest pixel is below this fraction of the trace's typical peak is not the
 * series: in a JPEG a thick line of a related colour (pink next to red) can sit on the series'
 * colour blend at α ≈ 0.6 everywhere, but never reaches the series' full strength.
 */
const PEAK_RATIO = 0.65;

/** Runs of "on" pixels in column x between rows y0…y1; single-pixel holes are closed. */
export function columnRuns(alpha: Float32Array, width: number, x: number, y0: number, y1: number): Run[] {
  const runs: Run[] = [];
  let top = -1;
  let last = -10;
  for (let y = y0; y <= y1; y++) {
    if ((alpha[y * width + x] ?? -1) < ON_ALPHA) continue;
    if (top >= 0 && y - last <= 2) last = y;
    else {
      if (top >= 0) runs.push({ top, bottom: last });
      top = y;
      last = y;
    }
  }
  if (top >= 0) runs.push({ top, bottom: last });
  return runs;
}

/** α-weighted centre of a run, extended over the partially covered pixels at both ends. */
function runCentre(alpha: Float32Array, width: number, height: number, x: number, run: Run): number {
  let sw = 0;
  let sy = 0;
  const add = (y: number) => {
    const a = alpha[y * width + x] ?? -1;
    if (a <= 0) return false;
    const wgt = Math.min(1, a);
    sw += wgt;
    sy += wgt * y;
    return a < ON_ALPHA;
  };
  for (let y = run.top; y <= run.bottom; y++) add(y);
  for (let y = run.top - 1; y >= Math.max(0, run.top - 2) && add(y); y--);
  for (let y = run.bottom + 1; y <= Math.min(height - 1, run.bottom + 2) && add(y); y++);
  return sw > 0 ? sy / sw : (run.top + run.bottom) / 2;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median slope (dy per column, in walk direction) over the last few entries. */
function recentSlope(hist: ColumnEntry[]): number {
  const d: number[] = [];
  for (let i = Math.max(1, hist.length - 8); i < hist.length; i++) {
    const a = hist[i - 1]!;
    const b = hist[i]!;
    d.push((b.cy - a.cy) / Math.max(1, Math.abs(b.x - a.x)));
  }
  return median(d);
}

export interface TraceOptions {
  /** Longest run of columns without the curve that is bridged over background. */
  maxGap: number;
  /**
   * Image-sized, 1 where a pixel is ink of another colour. A gap whose predicted position is
   * covered by such ink is the curve hidden under something drawn over it, not its end; such
   * columns are bridged up to `maxHiddenGap` in all.
   */
  other?: Uint8Array;
  maxHiddenGap?: number;
}
/** A branch that dies within this many columns of a fork is retried with the alternatives. */
const RETRY_COLUMNS = 25;
const MAX_RETRY_DEPTH = 3;

export function defaultMaxGap(region: Region): number {
  return Math.min(40, Math.max(10, Math.round(0.035 * (region.x1 - region.x0 + 1))));
}

/** Hidden stretches: series drawn over each other can coincide for a long way (KM curves). */
export function defaultMaxHiddenGap(region: Region): number {
  return Math.max(4 * defaultMaxGap(region), Math.round(0.3 * (region.x1 - region.x0 + 1)));
}

/** Median slope over the last few consecutive short (shallow, clean) entries, or 0. */
function cleanSlope(hist: ColumnEntry[], t: number): number {
  const d: number[] = [];
  for (let i = hist.length - 1; i >= 1 && d.length < 8; i--) {
    const a = hist[i - 1]!;
    const b = hist[i]!;
    if (runLength(a) - t < 2.5 && runLength(b) - t < 2.5) d.push((b.cy - a.cy) / Math.max(1, Math.abs(b.x - a.x)));
  }
  return median(d);
}

/**
 * Follow the curve through the seed. Returns the columns left → right, or null when the seed
 * pixel has no run of the series colour within 2 px.
 */
export function traceColumns(
  alpha: Float32Array,
  region: Region,
  seed: { x: number; y: number },
  opts: TraceOptions,
): ColumnEntry[] | null {
  const { width: w, height: h, y0, y1, x0, x1 } = region;
  const regionH = y1 - y0 + 1;
  const runs0 = columnRuns(alpha, w, seed.x, y0, y1);
  let start: Run | null = null;
  let bestD = 2.5;
  for (const r of runs0) {
    const d = seed.y < r.top ? r.top - seed.y : seed.y > r.bottom ? seed.y - r.bottom : 0;
    if (d < bestD) {
      bestD = d;
      start = r;
    }
  }
  if (!start) return null;
  const first: ColumnEntry = {
    ...start,
    x: seed.x,
    cy: runCentre(alpha, w, h, seed.x, start),
    afterGap: 0,
    peak: runPeak(alpha, w, seed.x, start),
  };
  const occludedAt = (x: number, y: number, t: number) => {
    if (!opts.other) return false;
    const r = Math.max(1, Math.ceil(t / 2));
    for (let yy = Math.max(y0, Math.round(y) - r); yy <= Math.min(y1, Math.round(y) + r); yy++) {
      if (opts.other[yy * w + x]) return true;
    }
    return false;
  };

  interface WalkState {
    hist: ColumnEntry[];
    minLen: number;
    /** Centre of the last short run: where the walk entered the current long stretch. */
    entryY: number;
    gap: number;
    openGap: number;
    /** Next column to look at. */
    x: number;
    /** Set on a retry branch until the walk is back on a short run: no straight-through. */
    farOnly: boolean;
  }
  interface Candidate {
    run: Run;
    index: number;
    score: number;
  }

  /** Take run `index` of column `st.x` into the walk. */
  const accept = (st: WalkState, runs: Run[], index: number): void => {
    const prev = st.hist[st.hist.length - 1]!;
    const t = st.minLen;
    const half = (t - 1) / 2;
    const isLong = (r: Run) => runLength(r) - t >= 2.5;
    const m = Math.max(2.5, t);
    const across = (r: Run, y: number) => y - (r.top + half) >= m && r.bottom - half - y >= m;
    let best = runs[index]!;
    const from = isLong(prev) ? st.entryY : prev.cy;
    if (isLong(best) && !across(best, from)) {
      // A vertical stroke interrupted by a line of another colour drawn over it: continue it
      // through small holes, away from where the walk entered it.
      const hole = Math.max(4, 2 * t + 1);
      const up = Math.abs(best.bottom - from) < Math.abs(best.top - from);
      for (let j = index + (up ? -1 : 1); j >= 0 && j < runs.length; j += up ? -1 : 1) {
        const r = runs[j]!;
        const g = up ? best.top - r.bottom - 1 : r.top - best.bottom - 1;
        if (g > hole) break;
        best = up ? { top: r.top, bottom: best.bottom } : { top: best.top, bottom: r.bottom };
      }
    }
    const cy = runCentre(alpha, w, h, st.x, best);
    if (!isLong(best)) {
      st.entryY = cy;
      st.farOnly = false;
    }
    st.hist.push({ ...best, x: st.x, cy, afterGap: st.gap, peak: runPeak(alpha, w, st.x, best) });
    st.minLen = Math.min(st.minLen, runLength(best));
    st.gap = 0;
    st.openGap = 0;
  };

  /** Acceptable runs in column `st.x`, best first. */
  const candidates = (st: WalkState, runs: Run[]): { list: Candidate[]; pred: number; t: number } => {
    const prev = st.hist[st.hist.length - 1]!;
    const t = st.minLen;
    const half = (t - 1) / 2;
    const gap = st.gap;
    const crossLen = Math.max(0.5 * regionH, 12 * t + 10);
    const crossOut = Math.max(6, 3 * t);
    const peakRef = st.hist.length >= 5 ? median(st.hist.slice(-15).map((e) => e.peak)) : 0;
    const rank = (pred: number, slope: number): Candidate[] => {
      const win = t / 2 + 1.5 + (gap + 1) * (0.3 + 0.3 * Math.abs(slope));
      const out: Candidate[] = [];
      runs.forEach((r, index) => {
        const lo = r.top + half;
        const hi = Math.max(lo, r.bottom - half);
        const dPred = pred < lo ? lo - pred : pred > hi ? pred - hi : 0;
        const touches = gap === 0 && r.top <= prev.bottom + 1 && r.bottom >= prev.top - 1;
        if (!touches && dPred > win) return;
        if (runLength(r) >= crossLen && r.top < pred - crossOut && r.bottom > pred + crossOut) return;
        if (runPeak(alpha, w, st.x, r) < PEAK_RATIO * peakRef) return;
        // Touching runs far from the prediction are kept last, as alternatives for the retry.
        out.push({ run: r, index, score: dPred > win ? 1000 + dPred : dPred + 0.01 * runLength(r) });
      });
      return out.sort((a, b) => a.score - b.score);
    };
    if (runLength(prev) - t >= 2.5) {
      // Leaving a long run. Straight through first, at the slope of the shallow curve before it
      // (a line or marker crossing the curve, a same-colour curve crossing it); otherwise from the
      // run's end farther from where the walk came in (a step's vertical, a steep stretch).
      const slope = cleanSlope(st.hist, t);
      const straight = st.entryY + slope * (gap + 1);
      // Not on a retry branch that has just left the long run another way: going straight would
      // pull it back to the curve before the marker it chose not to follow.
      const s = st.farOnly ? [] : rank(straight, slope);
      if (s.length && s[0]!.score < 1000) return { list: s, pred: straight, t };
      const a = prev.top + half;
      const b = prev.bottom - half;
      const far = (Math.abs(a - st.entryY) > Math.abs(b - st.entryY) ? a : b) + slope * gap;
      return { list: rank(far, slope), pred: far, t };
    }
    const slope = recentSlope(st.hist);
    const pred = prev.cy + slope * (gap + 1);
    return { list: rank(pred, slope), pred, t };
  };

  const clone = (st: WalkState): WalkState => ({ ...st, hist: st.hist.slice() });

  /**
   * Walk until the curve is lost. At the last column where more than one run was acceptable, the
   * alternatives are tried too when the chosen branch dies within RETRY_COLUMNS (the tip of a
   * marker, a censoring mark at a step corner): the branch that gets farthest wins.
   */
  const walkFrom = (st: WalkState, dir: 1 | -1, depth: number): WalkState => {
    let branch: { state: WalkState; runs: Run[]; alts: Candidate[]; at: number } | null = null;
    for (; st.x >= x0 && st.x <= x1; st.x += dir) {
      const runs = columnRuns(alpha, w, st.x, y0, y1);
      const { list, pred, t } = candidates(st, runs);
      if (!list.length) {
        st.gap++;
        if (!occludedAt(st.x, pred, t)) st.openGap++;
        if (st.openGap > opts.maxGap || st.gap > (opts.maxHiddenGap ?? opts.maxGap)) break;
        continue;
      }
      if (list.length > 1 && depth < MAX_RETRY_DEPTH) branch = { state: clone(st), runs, alts: list.slice(1), at: st.hist.length };
      accept(st, runs, list[0]!.index);
    }
    if (!branch || st.hist.length - branch.at > RETRY_COLUMNS) return st;
    const reach = (s: WalkState) => Math.abs(s.hist[s.hist.length - 1]!.x - seed.x);
    let best = st;
    for (const alt of branch.alts) {
      const s = clone(branch.state);
      accept(s, branch.runs, alt.index);
      if (runLength(s.hist[s.hist.length - 1]!) - s.minLen >= 2.5) s.farOnly = true;
      s.x += dir;
      const res = walkFrom(s, dir, depth + 1);
      if (reach(res) > reach(best)) best = res;
    }
    return best;
  };

  /**
   * One direction from the seed. `prime` (columns found in the other direction, nearest first)
   * gives the walk its slope from the start, so a dash tip at the seed cannot point it astray.
   */
  const walk = (dir: 1 | -1, prime: ColumnEntry[]): ColumnEntry[] => {
    const lead = prime.slice(0, 8).reverse();
    const hist = [...lead, first];
    const st = walkFrom({ hist, minLen: runLength(first), entryY: seed.y, gap: 0, openGap: 0, x: seed.x + dir, farOnly: false }, dir, 0);
    return st.hist.slice(lead.length + 1);
  };

  const left = walk(-1, walk(1, []));
  const right = walk(1, left);
  return [...left.reverse(), first, ...right];
}

/** Line thickness: the 25th percentile of the run lengths (shallow parts dominate it). */
export function thicknessOf(entries: ColumnEntry[]): number {
  const lens = entries.map(runLength).sort((a, b) => a - b);
  return Math.max(1, lens[Math.floor(lens.length / 4)] ?? 1);
}

const iou = (a: Run, b: Run) => {
  const inter = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 1;
  if (inter <= 0) return 0;
  return inter / (Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) + 1);
};

/** Turn traced columns into centreline points with step corners (see the file comment). */
export function columnsToPath(entries: ColumnEntry[], alpha: Float32Array, width: number): PathPoint[] {
  const t = thicknessOf(entries);
  const half = (t - 1) / 2;
  const long = (e: ColumnEntry) => runLength(e) - t >= 2.5;
  const out: PathPoint[] = [];
  const plain = (e: ColumnEntry, conf: number) =>
    out.push({ px: e.x, py: e.cy, confidence: e.afterGap > 0 ? Math.min(conf, 0.7) : conf, corner: false });

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!long(e)) {
      plain(e, 1);
      continue;
    }
    let j = i;
    while (j + 1 < entries.length) {
      const n = entries[j + 1]!;
      const c = entries[j]!;
      if (!long(n) || n.x - c.x !== 1 || iou(c, n) < 0.5) break;
      j++;
    }
    const group = entries.slice(i, j + 1);
    const T = Math.min(...group.map((g) => g.top)) + half;
    const B = Math.max(...group.map((g) => g.bottom)) - half;
    const D = B - T;
    let yin = entries[i - 1]?.cy;
    let yout = entries[j + 1]?.cy;
    if (yin === undefined && yout === undefined) {
      for (const g of group) plain(g, 0.6);
      i = j;
      continue;
    }
    const far = (y: number) => (Math.abs(T - y) > Math.abs(B - y) ? T : B);
    yin ??= far(yout!);
    yout ??= far(yin);
    const within = (y: number) => y >= T - 0.75 && y <= B + 0.75;
    const thin = group.length <= t + 2;
    if (thin && D >= 2.5 && within(yin) && within(yout) && Math.abs(yout - yin) >= Math.max(2.5, 0.6 * D)) {
      // A step's vertical segment: its x is the α-weighted centre of the stroke between the ends.
      let sw = 0;
      let sx = 0;
      for (const g of group) {
        for (let y = Math.ceil(T + half + 0.5); y <= Math.floor(B - half - 0.5); y++) {
          const a = alpha[y * width + g.x] ?? -1;
          if (a > 0) {
            sw += Math.min(1, a);
            sx += Math.min(1, a) * g.x;
          }
        }
      }
      const xv = sw > 0 ? sx / sw : group.reduce((s, g) => s + g.x, 0) / group.length;
      out.push({ px: xv, py: yin, confidence: 0.9, corner: true });
      out.push({ px: xv, py: yout, confidence: 0.9, corner: true });
    } else if (T < Math.min(yin, yout) - 1.5 && B > Math.max(yin, yout) + 1.5) {
      // Sticks out on both sides: a marker or a mark of the same colour on the curve. Bridged.
    } else {
      for (const g of group) plain(g, 0.8);
    }
    i = j;
  }
  return out;
}
