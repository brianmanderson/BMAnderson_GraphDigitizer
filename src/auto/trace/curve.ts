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
 *    alternatives are walked too and the one that follows the most columns of ink wins.
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
  /** Ends at a ruling (rulings.ts): a stroke's part outside one; thinner than the stroke, a sliver. */
  cut?: boolean;
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
export function runCentre(alpha: Float32Array, width: number, height: number, x: number, run: Run): number {
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
  /**
   * Longest hole in a vertical stroke that is bridged when all of it is ink of another colour or
   * series (by default no more than any hole). A dashed series uses one dash and two gaps: where it
   * crosses a same-colour series, the dash touching that series went with it.
   */
  coveredHole?: number;
  /**
   * Image-sized, 1 on a ruling (rulings.ts: a gridline of the series' colour, taken out of the
   * coverage map). A hole in a column's run that is all ruling is closed: a thick curve crossing a
   * thin gridline stays one run.
   */
  ruling?: Uint8Array | undefined;
  /**
   * Image-sized, 1 on a ruling left in the coverage map (a solid curve's walk): a run that is all
   * ruling is never taken — the walk crosses a ruling but never runs along one.
   */
  rulingInk?: Uint8Array | undefined;
  /**
   * A dashed line: every piece tapers at both ends (scanned dashes, dashes cut by a gridline), so
   * the stroke width is not measured over a piece's first and last columns.
   */
  tips?: boolean;
}
/** Columns at each end of a stretch of ink whose runs don't measure the stroke's width. */
const TIP_COLUMNS = 3;
/** A branch that dies within this many columns of a fork is retried with the alternatives. */
const RETRY_COLUMNS = 25;
const MAX_RETRY_DEPTH = 3;
/**
 * Slope change (px per column) a hidden gap may hide, over at most KINK_COLUMNS columns: enough for
 * a line turning from 45° down to 60° up under a marker, not enough to jump to a curve far away.
 */
const KINK_SLOPE = 3;
const KINK_COLUMNS = 16;

export function defaultMaxGap(region: Region): number {
  return Math.min(40, Math.max(10, Math.round(0.035 * (region.x1 - region.x0 + 1))));
}

/** Hidden stretches: series drawn over each other can coincide for a long way (KM curves). */
export function defaultMaxHiddenGap(region: Region): number {
  return Math.max(4 * defaultMaxGap(region), Math.round(0.3 * (region.x1 - region.x0 + 1)));
}

/**
 * Median slope over the last few consecutive short (shallow, clean) entries, or 0, and how many
 * pairs it rests on.
 */
function cleanSlope(hist: ColumnEntry[], t: number): { slope: number; n: number } {
  const d: number[] = [];
  for (let i = hist.length - 1; i >= 1 && d.length < 8; i--) {
    const a = hist[i - 1]!;
    const b = hist[i]!;
    if (runLength(a) - t < 2.5 && runLength(b) - t < 2.5) d.push((b.cy - a.cy) / Math.max(1, Math.abs(b.x - a.x)));
  }
  return { slope: median(d), n: d.length };
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
  /**
   * Continue a walk (dashes.ts): walk only `dir` from the seed, primed with `lead` (the columns
   * already walked, nearest the seed first) so the slope is known from the start.
   */
  only?: { dir: 1 | -1; lead: ColumnEntry[] },
): ColumnEntry[] | null {
  const { width: w, height: h, y0, y1, x0, x1 } = region;
  const regionH = y1 - y0 + 1;
  const ruling = opts.ruling;
  /** Whether every pixel of run r in column x is a ruling's (`rulingInk`). */
  const allRuling = (x: number, r: Run): boolean => {
    for (let y = r.top; y <= r.bottom; y++) if (!opts.rulingInk![y * w + x]) return false;
    return true;
  };
  /** Whether the pixels just beyond row `y` (going `dir`) are a ruling: the run was cut there. */
  const cutAt = (x: number, y: number, dir: 1 | -1): boolean => {
    for (let k = 1; k <= 2; k++) {
      const yy = y + k * dir;
      if (yy < y0 || yy > y1) return false;
      if (ruling![yy * w + x]) return true;
      if ((alpha[yy * w + x] ?? -1) <= 0) return false;
    }
    return false;
  };
  /**
   * Runs of column x, with holes that are all ruling closed. A run that ends at a ruling is the
   * part of a stroke sticking out of it (`cut`): its length and centre measure nothing.
   */
  const runsOf = (x: number): Run[] => {
    const runs = columnRuns(alpha, w, x, y0, y1);
    if (!ruling) return runs;
    const out: Run[] = [];
    for (const r of runs) {
      const prev = out[out.length - 1];
      let all = !!prev;
      for (let y = prev ? prev.bottom + 1 : r.top; y < r.top && all; y++) all = ruling[y * w + x] === 1 || (alpha[y * w + x] ?? -1) >= ON_ALPHA;
      if (prev && all) out[out.length - 1] = { top: prev.top, bottom: r.bottom };
      else out.push({ ...r });
    }
    for (const r of out) if (cutAt(x, r.top, -1) || cutAt(x, r.bottom, 1)) r.cut = true;
    return out;
  };
  const runs0 = runsOf(seed.x);
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
  /**
   * Whether the ink of another colour at (x, row) is marker-sized there: its vertical and its
   * horizontal extent through that pixel are both between 3 and 40 px. A line of another colour
   * is long in at least one direction (or thin in both); a gridline is long horizontally or
   * vertically even where a marker sits on it, but not where it does not.
   */
  const markerSizedAt = (x: number, row: number): boolean => {
    const other = opts.other!;
    let up = row;
    while (up > y0 && other[(up - 1) * w + x] && row - up < 41) up--;
    let down = row;
    while (down < y1 && other[(down + 1) * w + x] && down - row < 41) down++;
    let left = x;
    while (left > x0 && other[row * w + left - 1] && x - left < 41) left--;
    let right = x;
    while (right < x1 && other[row * w + right + 1] && right - x < 41) right++;
    const v = down - up + 1;
    const hz = right - left + 1;
    return v >= 3 && v <= 40 && hz >= 3 && hz <= 40;
  };

  /** Row of a pixel of another colour (or of a ruling left as ink) within half a line width of (x, y), or −1. */
  const occludedAt = (x: number, y: number, t: number): number => {
    if (!opts.other) return -1;
    const r = Math.max(1, Math.ceil(t / 2));
    for (let yy = Math.max(y0, Math.round(y) - r); yy <= Math.min(y1, Math.round(y) + r); yy++) {
      if (opts.other[yy * w + x] || opts.rulingInk?.[yy * w + x]) return yy;
    }
    return -1;
  };

  interface WalkState {
    hist: ColumnEntry[];
    minLen: number;
    /** Centre of the last short run: where the walk entered the current long stretch. */
    entryY: number;
    /** Column of that run. */
    entryX: number;
    gap: number;
    openGap: number;
    /** Gap columns whose predicted position was under ink of another colour. */
    hiddenCols: number;
    /** Whether that ink is a compact blob (a marker), under which the curve may turn. */
    underMarker: boolean;
    /** Next column to look at. */
    x: number;
    /** Set on a retry branch until the walk is back on a short run: no straight-through. */
    farOnly: boolean;
    /** Columns accepted since the last gap; `minLen` before each of the last accepted columns. */
    sinceGap: number;
    minHist: number[];
  }
  interface Candidate {
    run: Run;
    index: number;
    score: number;
    /** Reached only through the kink allowance of a hidden gap. */
    kinkOnly: boolean;
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
      // through small holes, away from where the walk entered it — wider ones (`coveredHole`) when
      // all of the hole is ink of another colour or of another series (with its anti-aliased edges).
      const hole = Math.max(4, 2 * t + 1);
      const covered = (a: number, b: number) => {
        if (!opts.other) return false;
        for (let y = a; y <= b; y++) if (!opts.other[y * w + st.x] && (alpha[y * w + st.x] ?? -1) >= 0) return false;
        return true;
      };
      const up = Math.abs(best.bottom - from) < Math.abs(best.top - from);
      for (let j = index + (up ? -1 : 1); j >= 0 && j < runs.length; j += up ? -1 : 1) {
        const r = runs[j]!;
        const g = up ? best.top - r.bottom - 1 : r.top - best.bottom - 1;
        if (g > hole && !(g <= (opts.coveredHole ?? hole) && covered(up ? r.bottom + 1 : best.bottom + 1, up ? best.top - 1 : r.top - 1))) break;
        best = up ? { top: r.top, bottom: best.bottom } : { top: best.top, bottom: r.bottom };
      }
    }
    const cy = runCentre(alpha, w, h, st.x, best);
    if (!isLong(best)) {
      st.entryY = cy;
      st.entryX = st.x;
      st.farOnly = false;
    }
    st.hist.push({ ...best, x: st.x, cy, afterGap: st.gap, peak: runPeak(alpha, w, st.x, best) });
    // The stroke's width: the shortest run, but not over a dash's tapering tips (a scanned dash, a
    // dash cut by a gridline): not in the first columns after a gap, and the last ones before a
    // gap are taken back when it opens (`openGapAt`).
    const tip = Math.max(TIP_COLUMNS, Math.ceil(st.minLen / 2));
    st.sinceGap = st.gap > 0 ? 0 : st.sinceGap + 1;
    st.minHist.push(st.minLen);
    if (st.minHist.length > 64) st.minHist.shift();
    if (!opts.tips || st.sinceGap >= tip) st.minLen = Math.min(st.minLen, runLength(best));
    st.gap = 0;
    st.openGap = 0;
    st.hiddenCols = 0;
    st.underMarker = false;
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
      // Hidden under another colour (a marker drawn over the curve), the curve may turn: a
      // V or Λ kink at a data point reverses the slope out of sight. Allow for it.
      const hidden = gap > 0 && st.underMarker && 2 * st.hiddenCols >= gap;
      const kink = hidden ? (Math.min(gap, KINK_COLUMNS) * KINK_SLOPE) / 2 : 0;
      const plainWin = t / 2 + 1.5 + (gap + 1) * (0.3 + 0.3 * Math.abs(slope));
      const win = plainWin + kink;
      // A run only the kink allowance reaches must come out from under the hiding ink: ink of
      // another colour right next to it in the previous column, as where a line leaves a marker.
      const back = st.x - Math.sign(st.x - prev.x);
      const emerges = (r: Run) => {
        if (!opts.other) return false;
        for (let y = Math.max(y0, r.top - 2); y <= Math.min(y1, r.bottom + 2); y++) if (opts.other[y * w + back]) return true;
        return false;
      };
      const out: Candidate[] = [];
      runs.forEach((r, index) => {
        // Where the centre of a stroke covering run r can be. A run thinner than the stroke is
        // measured from its own centre (from `top + half` it would look closer to a prediction
        // below it than it is: a 1-px gridline just above a thick curve would win).
        const mid = (r.top + r.bottom) / 2;
        const lo = Math.min(r.top + half, mid);
        const hi = Math.max(r.bottom - half, mid);
        const dPred = pred < lo ? lo - pred : pred > hi ? pred - hi : 0;
        const touches = gap === 0 && r.top <= prev.bottom + 1 && r.bottom >= prev.top - 1;
        if (!touches && dPred > win) return;
        if (!touches && dPred > plainWin && !emerges(r)) return;
        if (runLength(r) >= crossLen && r.top < pred - crossOut && r.bottom > pred + crossOut) return;
        if (runPeak(alpha, w, st.x, r) < PEAK_RATIO * peakRef) return;
        if (opts.rulingInk && allRuling(st.x, r)) return;
        // A sliver of the stroke beside a ruling (cut by it, thinner than the stroke): the column
        // is hidden by the ruling, like a marker drawn over the curve. (A thin gridline across a
        // thick curve leaves most of the stroke: that run is the curve.)
        if (r.cut && runLength(r) < t) return;
        // Touching runs far from the prediction are kept last, as alternatives for the retry.
        out.push({
          run: r,
          index,
          score: dPred > win ? 1000 + dPred : dPred + 0.01 * runLength(r),
          kinkOnly: !touches && dPred > plainWin,
        });
      });
      return out.sort((a, b) => a.score - b.score);
    };
    if (runLength(prev) - t >= 2.5) {
      // Leaving a long run. Straight through first, at the slope of the shallow curve before it
      // (a line or marker crossing the curve, a same-colour curve crossing it); otherwise from the
      // run's end farther from where the walk came in (a step's vertical, a steep stretch).
      const { slope, n } = cleanSlope(st.hist, t);
      // Straight through from where the walk entered the long stretch, over every column since —
      // a thin line merged with the curve at a shallow angle makes a stretch many columns long.
      // Only over one column when the slope rests on fewer than three clean pairs (a steep
      // stretch): extrapolating a guessed slope across a marker would aim into it.
      const straight = st.entryY + slope * (n >= 3 ? Math.abs(st.x - st.entryX) : gap + 1);
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

  const clone = (st: WalkState): WalkState => ({ ...st, hist: st.hist.slice(), minHist: st.minHist.slice() });

  /** A gap opens: the stroke width measured on the tip just walked is taken back. */
  const openGapAt = (st: WalkState): void => {
    if (!opts.tips) return;
    const tip = Math.max(TIP_COLUMNS, Math.ceil(st.minLen / 2));
    const back = st.minHist[st.minHist.length - tip];
    if (back !== undefined && st.sinceGap >= tip) st.minLen = back;
  };

  /**
   * Walk until the curve is lost. At the last column where more than one run was acceptable, the
   * alternatives are tried too when the chosen branch dies within RETRY_COLUMNS (the tip of a
   * marker, a censoring mark at a step corner): the branch that follows the most ink wins.
   */
  const walkFrom = (st: WalkState, dir: 1 | -1, depth: number): WalkState => {
    let branch: { state: WalkState; runs: Run[]; alts: Candidate[]; at: number } | null = null;
    /**
     * A run reached only by the kink allowance is not taken at once: the gap goes on, and only if
     * it runs out without a run in the plain window, and there is no recent fork to retry, does the
     * walk resume from this one. (Another series' censoring marks are marker-sized too; at a step
     * the plain window, or the fork's other branch, finds the curve.)
     */
    let kinkFallback: { state: WalkState; runs: Run[]; index: number } | null = null;
    for (; st.x >= x0 && st.x <= x1; st.x += dir) {
      const runs = runsOf(st.x);
      const { list, pred, t } = candidates(st, runs);
      const kinkOnly = list.length > 0 && list.every((c) => c.kinkOnly);
      if (kinkOnly && !kinkFallback) kinkFallback = { state: clone(st), runs, index: list[0]!.index };
      if (!list.length || kinkOnly) {
        if (st.gap === 0) openGapAt(st);
        st.gap++;
        const row = occludedAt(st.x, pred, t);
        if (row >= 0) {
          st.hiddenCols++;
          if (!st.underMarker && markerSizedAt(st.x, row)) st.underMarker = true;
        } else st.openGap++;
        if (st.openGap > opts.maxGap || st.gap > (opts.maxHiddenGap ?? opts.maxGap)) break;
        continue;
      }
      // A fork: other acceptable runs (runs only the kink allowance reaches don't make one).
      const alts = list.slice(1).filter((c) => !c.kinkOnly);
      if (alts.length && depth < MAX_RETRY_DEPTH) branch = { state: clone(st), runs, alts, at: st.hist.length };
      accept(st, runs, list[0]!.index);
      kinkFallback = null;
    }
    // The branch that followed the most columns of ink wins (then the farthest): a wrong branch
    // kept alive across hidden gaps gets far without following much.
    const followed = (s: WalkState) => s.hist.length + Math.abs(s.hist[s.hist.length - 1]!.x - seed.x) / 1e6;
    let best = st;
    if (!branch || st.hist.length - branch.at > RETRY_COLUMNS) {
      // No recent fork to retry: resume from a run beyond a hidden kink, if one was seen.
      if (!kinkFallback || depth >= MAX_RETRY_DEPTH) return st;
      const s = kinkFallback.state;
      accept(s, kinkFallback.runs, kinkFallback.index);
      s.x += dir;
      const res = walkFrom(s, dir, depth + 1);
      return followed(res) > followed(st) ? res : st;
    }
    for (const alt of branch.alts) {
      const s = clone(branch.state);
      accept(s, branch.runs, alt.index);
      if (runLength(s.hist[s.hist.length - 1]!) - s.minLen >= 2.5) s.farOnly = true;
      s.x += dir;
      const res = walkFrom(s, dir, depth + 1);
      if (followed(res) > followed(best)) best = res;
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
    // A continued walk keeps the stroke width it had: the piece it starts from may be a sliver.
    const minLen = only && lead.length ? Math.max(runLength(first), Math.min(...lead.map(runLength))) : runLength(first);
    const st = walkFrom({ hist, minLen, entryY: seed.y, entryX: seed.x, gap: 0, openGap: 0, hiddenCols: 0, underMarker: false, x: seed.x + dir, farOnly: false, sinceGap: only ? 0 : 1e9, minHist: [] }, dir, 0);
    return st.hist.slice(lead.length + 1);
  };

  if (only) {
    const on = walk(only.dir, only.lead);
    return only.dir === 1 ? [first, ...on] : [...on.reverse(), first];
  }
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
/**
 * `spurs`: also bridge a thin spur on one side of a curve that runs straight past it — used when
 * another series of the curve's colour is known to be there (its dashes touch the curve).
 */
export function columnsToPath(entries: ColumnEntry[], alpha: Float32Array, width: number, spurs = false): PathPoint[] {
  const t = thicknessOf(entries);
  const half = (t - 1) / 2;
  const long = (e: ColumnEntry) => runLength(e) - t >= 2.5;
  const out: PathPoint[] = [];
  const plain = (e: ColumnEntry, conf: number) =>
    out.push({ px: e.x, py: e.cy, confidence: e.afterGap > 0 ? Math.min(conf, 0.7) : conf, corner: false });
  /**
   * Slope (dy per column, x increasing) of the up to 6 adjacent short entries from index `from`
   * on, walking `dir`; null when fewer than 3 (then that side is no evidence).
   */
  const sideSlope = (from: number, dir: 1 | -1): number | null => {
    const pts: ColumnEntry[] = [];
    for (let k = from; k >= 0 && k < entries.length && pts.length < 6; k += dir) {
      const e = entries[k]!;
      if (long(e) || (pts.length && Math.abs(e.x - pts[pts.length - 1]!.x) !== 1)) break;
      pts.push(e);
    }
    if (pts.length < 3) return null;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    return (b.cy - a.cy) / (b.x - a.x);
  };
  /**
   * The curve's slope through the long group i…j: 0 unless both sides show it and agree (a curve
   * running straight on, not a kink at a data point).
   */
  const slopeAround = (i: number, j: number): number => {
    const before = sideSlope(i - 1, -1);
    const after = sideSlope(j + 1, 1);
    if (before === null || after === null) return 0;
    return Math.abs(before - after) <= 0.5 * Math.max(1, Math.abs(before), Math.abs(after)) ? (before + after) / 2 : 0;
  };
  /** x of entry k, or one column past the group's end when there is none. */
  const xAt = (k: number, dir: 1 | -1): number => entries[k]?.x ?? entries[k - dir]!.x + dir;

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
    const heightFull = Math.max(...group.map((g) => g.bottom)) - Math.min(...group.map((g) => g.top)) + 1;
    // A marker of the series' colour: wider than a stroke, roughly square, and sticking out past
    // the curve on at least one side (a step's vertical runs exactly from one level to the other).
    const markerLike =
      group.length > t + 2 &&
      heightFull <= 1.6 * group.length &&
      group.length <= 1.6 * heightFull &&
      (T < Math.min(yin, yout) - 1.5 || B > Math.max(yin, yout) + 1.5);
    const thin = group.length <= t + 2;
    const stepLike = thin && D >= 2.5 && within(yin) && within(yout) && Math.abs(yout - yin) >= Math.max(2.5, 0.6 * D);
    if (stepLike && group.length >= 2 && Math.abs(yout - yin - slopeAround(i, j) * (xAt(j + 1, 1) - xAt(i - 1, -1))) < Math.max(2.5, 0.6 * D)) {
      // Not a step: the curve's own slope on both sides explains the jump. A thin line of the
      // series' colour merged with a sloping curve where it crosses at a shallow angle (a gridline,
      // a bar's edge). Bridged: the merged runs' centres lean towards that line. (A single long
      // column is a steep line's pixel stair, kept as before: its corner bounds the stretches
      // that `insertHiddenKinks` fits.)
    } else if (stepLike) {
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
    } else if (markerLike) {
      // A roughly square blob wider than a stroke: a marker of the series' colour on the curve.
      // Its centre is the data point (a polyline vertex, possibly a kink), whatever the curve
      // does around it.
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (const g of group) {
        for (let y = g.top; y <= g.bottom; y++) {
          const a = Math.min(1, Math.max(0, alpha[y * width + g.x] ?? 0));
          sw += a;
          sx += a * g.x;
          sy += a * y;
        }
      }
      if (sw > 0) out.push({ px: sx / sw, py: sy / sw, confidence: 0.8, corner: true });
    } else if (T < Math.min(yin, yout) - 1.5 && B > Math.max(yin, yout) + 1.5) {
      // Sticks out on both sides: a marker or a mark of the same colour on the curve. Bridged.
    } else if (spurs && thin && Math.abs(yout - yin) < 1.5 && D >= 2.5) {
      // A thin spur on one side of a curve that runs straight past it: the dash of a same-colour
      // dashed series touching it. Bridged.
    } else {
      for (const g of group) plain(g, 0.8);
    }
    i = j;
  }
  return out;
}
