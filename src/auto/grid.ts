/**
 * Gridlines, found on the grey image itself rather than on the darkness map.
 *
 * Many chart styles draw no axis line and no tick marks at all: the tick positions exist only as
 * gridlines across the plot, often very light (plotly's #EBF0F8 on white is 16 grey levels from
 * its background) or lighter than a filled panel (ggplot2, seaborn: white on grey). The darkness
 * map sees neither. A gridline is, however, a *ridge* along its whole length: every pixel on it
 * is darker (or lighter) than the pixels a few rows above and below it. So for each row (column)
 * of a region we take the ridge height at every position and ask for the height that at least
 * `MIN_VISIBLE` of the positions reach — a percentile, so data drawn over the line, bars hiding
 * most of it, text and JPEG noise do not matter, and a faint line is found as surely as a black
 * one. Rows that reach `MIN_RIDGE` form a line. Its sub-pixel offset and its mass (contrast ×
 * width, the same whether the line falls on one pixel row or is antialiased over two) come from
 * the mean profile across it at its visible pixels; its extent from the stretches of ridge pixels
 * along it, bridged across the lines that cross it, of the line's own darkness (`RIDGE_CAP`: the
 * stroke of a tick label centred on a gridline just beyond the plot, a "1" under its tick, is far
 * darker than a light gridline and does not extend it). (A dotted line's stretches are single pixels; they count when most of
 * the line is made of them. Otherwise a lone pixel is noise.)
 *
 * Gridlines as tick positions. A gridline is a drawn mark at a tick value, so where an axis has
 * no tick marks the gridlines that cross the plot from edge to edge stand in for them
 * (`TickSet.source: 'gridlines'`): the same lattice rules as for tick marks apply (`analyseMarks`:
 * three evenly spaced majors, or two with minors between them; thinner lines between the majors
 * are minor gridlines), so an axis with neither tick marks nor gridlines still gets nothing.
 *
 * The grid's box. Where no axis lines are drawn either, the gridlines' common ends are the plot
 * area's edges: the horizontal ones give its left and right, the vertical ones its top and bottom.
 *
 * Everything here works in the skew-corrected frame: `frameGray` resamples the grey image into
 * frame coordinates once (it is the image itself for an unrotated chart).
 */

import { borderRing, type DarknessMap } from './darkness.ts';
import { frameBounds, toImage, type Frame } from './frame.ts';
import type { Family } from './lines.ts';
import { analyseMarks, type Segment } from './ticks.ts';
import type { LineCandidate, TickSet } from './types.ts';

/** The grey image in frame coordinates: sample (i, j) is frame point (u0 + i, w0 + j). */
export interface GrayGrid {
  width: number;
  height: number;
  u0: number;
  w0: number;
  data: Float32Array;
  /** The page's grey level (median of the image's outer ring). */
  background: number;
}

/**
 * Ridge height (grey levels) a row must reach at `MIN_VISIBLE` of its positions to be a line — or,
 * on a noisy image (a scan's grain, JPEG ripple), `NOISE_FACTOR` times what a typical row of the
 * region reaches, plus `NOISE_MARGIN`: there every row shows some "ridge".
 */
const MIN_RIDGE = 5;
const NOISE_FACTOR = 3;
const NOISE_MARGIN = 2;
/** Share of a row's positions that must show the line (the rest may be hidden by bars or data). */
const MIN_VISIBLE = 0.2;
/**
 * A line's extent is made of stretches of ridge pixels that together are at least this long (px,
 * or this share of the scanned length): the minus sign of a tick label, or the bar of a "4", sits
 * on its gridline's row just outside the plot and must not stretch the line to it.
 */
const END_RUN = 10;
const END_RUN_SHARE = 0.02;
/**
 * Along a line, a pixel belongs to it when its ridge is at least half the line's level and at
 * most this many times it: one line has one colour, and the much darker stroke of a tick label
 * written on the gridline's row (or a data line drawn over it) is something else.
 */
const RIDGE_CAP = 3;
/** A line this much stronger than the grid's own lines, inside the grid, is an axis line. */
const AXIS_OVER_GRID = 1.4;

export function frameGray(map: DarknessMap, frame: Frame): GrayGrid | null {
  const gray = map.gray;
  if (!gray) return null;
  const { width: W, height: H } = map;
  const ring = borderRing(W, H);
  const levels: number[] = [];
  for (let i = 0; i < ring.length; i++) levels.push(gray[ring[i] as number] as number);
  levels.sort((a, b) => a - b);
  const background = levels[levels.length >> 1] ?? 255;
  if (frame.sin === 0) return { width: W, height: H, u0: 0, w0: 0, data: gray, background };
  const b = frameBounds(frame, W, H);
  const u0 = Math.floor(b.uMin);
  const w0 = Math.floor(b.wMin);
  const width = Math.ceil(b.uMax) - u0 + 1;
  const height = Math.ceil(b.wMax) - w0 + 1;
  const data = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = toImage(frame, u0 + i, w0 + j);
      let v = background;
      if (p.x >= 0 && p.y >= 0 && p.x <= W - 1 && p.y <= H - 1) {
        const x0 = Math.min(W - 2, Math.floor(p.x));
        const y0 = Math.min(H - 2, Math.floor(p.y));
        const fx = p.x - x0;
        const fy = p.y - y0;
        const k = y0 * W + x0;
        v =
          (gray[k] as number) * (1 - fx) * (1 - fy) +
          (gray[k + 1] as number) * fx * (1 - fy) +
          (gray[k + W] as number) * (1 - fx) * fy +
          (gray[k + W + 1] as number) * fx * fy;
      }
      data[j * width + i] = v;
    }
  }
  return { width, height, u0, w0, data, background };
}

/** A line found as a ridge; frame coordinates like a `LineCandidate` (offset across, start/end along). */
export interface GridLine {
  family: Family;
  offset: number;
  start: number;
  end: number;
  /** Ridge height the line reaches along its visible part, grey levels. */
  contrast: number;
  /** Contrast × width: the mean darkness profile across the line, summed (grey levels × px). */
  mass: number;
  /** +1 = darker than its surroundings, −1 = lighter (white gridlines on a grey panel). */
  polarity: 1 | -1;
}

/** Region in frame coordinates: `a` along the family, `o` across it (inclusive). */
export interface Region {
  a0: number;
  a1: number;
  o0: number;
  o1: number;
}

/** Distance (px) to the rows a ridge is compared with: beyond a gridline's own width. */
export function ridgeReach(width: number, height: number): number {
  return Math.min(5, Math.max(2, Math.round(Math.min(width, height) / 220)));
}

/** All ridge lines of one family inside `region` (see the header), in order of offset. */
export function findGridLines(grid: GrayGrid, family: Family, region: Region, reach: number): GridLine[] {
  const { width: W, height: H, data } = grid;
  const horizontal = family === 'horizontal';
  // Grid indices: `o` across (rows for horizontal lines), `t` along.
  const oOrigin = horizontal ? grid.w0 : grid.u0;
  const tOrigin = horizontal ? grid.u0 : grid.w0;
  const oMax = (horizontal ? H : W) - 1;
  const tMax = (horizontal ? W : H) - 1;
  const so = horizontal ? W : 1;
  const st = horizontal ? 1 : W;
  const o0 = Math.max(reach, Math.ceil(region.o0 - oOrigin));
  const o1 = Math.min(oMax - reach, Math.floor(region.o1 - oOrigin));
  const t0 = Math.max(0, Math.ceil(region.a0 - tOrigin));
  const t1 = Math.min(tMax, Math.floor(region.a1 - tOrigin));
  const n = t1 - t0 + 1;
  if (n < 8 || o1 < o0) return [];
  const endRun = Math.max(END_RUN, Math.ceil(END_RUN_SHARE * n));
  const need = Math.max(endRun, Math.ceil(MIN_VISIBLE * n));
  // A crossing line (or a marker) interrupts the ridge for about its own width.
  const bridge = 2 * reach + 2;
  const rows = o1 - o0 + 1;
  const level = [new Float32Array(rows), new Float32Array(rows)]; // dark, light
  const darkHist = new Int32Array(256);
  const lightHist = new Int32Array(256);
  const hist = [darkHist, lightHist];
  for (let o = o0; o <= o1; o++) {
    darkHist.fill(0);
    lightHist.fill(0);
    const base = o * so;
    const up = (o - reach) * so;
    const down = (o + reach) * so;
    for (let t = t0; t <= t1; t++) {
      const k = t * st;
      const g = data[base + k] as number;
      const a = data[up + k] as number;
      const b = data[down + k] as number;
      const dark = (a < b ? a : b) - g;
      if (dark >= 1) {
        const v = dark > 255 ? 255 : Math.round(dark);
        darkHist[v] = (darkHist[v] as number) + 1;
      } else {
        const light = g - (a > b ? a : b);
        if (light >= 1) {
          const v = light > 255 ? 255 : Math.round(light);
          lightHist[v] = (lightHist[v] as number) + 1;
        }
      }
    }
    for (let p = 0; p < 2; p++) {
      const h = hist[p] as Int32Array;
      let acc = 0;
      let v = 255;
      for (; v >= 1; v--) {
        acc += h[v] as number;
        if (acc >= need) break;
      }
      (level[p] as Float32Array)[o - o0] = v;
    }
  }

  const out: GridLine[] = [];
  const profile = new Float64Array(2 * reach - 1);
  for (let p = 0; p < 2; p++) {
    const lv = level[p] as Float32Array;
    const sign = p === 0 ? 1 : -1;
    const typical = Float32Array.from(lv).sort()[rows >> 1] ?? 0;
    const minRidge = Math.max(MIN_RIDGE, NOISE_FACTOR * typical + NOISE_MARGIN);
    let i = 0;
    while (i < rows) {
      if ((lv[i] as number) < minRidge) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < rows && (lv[j + 1] as number) >= minRidge) j++;
      let peak = i;
      for (let k = i; k <= j; k++) if ((lv[k] as number) > (lv[peak] as number)) peak = k;
      const top = lv[peak] as number;
      const o = o0 + peak;
      const base = o * so;
      const up = (o - reach) * so;
      const down = (o + reach) * so;
      // Along the peak row: the stretches of ridge pixels, and at those pixels the mean profile
      // across the line against the rows beside it (offset and mass).
      profile.fill(0);
      let visible = 0;
      let single = 0;
      const runs: number[] = []; // start, end pairs
      let runStart = -1;
      for (let t = t0; t <= t1 + 1; t++) {
        let on = false;
        if (t <= t1) {
          const k = t * st;
          const g = data[base + k] as number;
          const a = data[up + k] as number;
          const b = data[down + k] as number;
          const beside = sign > 0 ? (a < b ? a : b) : a > b ? a : b;
          const r = sign * (beside - g);
          on = r >= 0.5 * top && r <= RIDGE_CAP * top;
          if (on) {
            visible++;
            for (let d = -(reach - 1); d <= reach - 1; d++) {
              const v = sign * (beside - (data[(o + d) * so + k] as number));
              if (v > 0) profile[d + reach - 1] = (profile[d + reach - 1] as number) + v;
            }
          }
        }
        if (on) {
          if (runStart < 0) runStart = t;
        } else if (runStart >= 0) {
          runs.push(runStart, t - 1);
          if (t - 1 === runStart) single++;
          runStart = -1;
        }
      }
      // Extent: from the first to the last group of stretches (bridged across crossing lines)
      // that holds enough ridge pixels. Lone pixels count only on a dotted line.
      const dotted = single > 0.5 * (runs.length / 2);
      const minRun = dotted ? 1 : 2;
      let first = -1;
      let last = -1;
      let group: number[] = []; // start, end pairs
      const closeGroup = () => {
        let count = 0;
        for (let k = 0; k < group.length; k += 2) count += (group[k + 1] as number) - (group[k] as number) + 1;
        if (group.length && count >= endRun) {
          if (first < 0) first = group[0] as number;
          last = group[group.length - 1] as number;
        }
        group = [];
      };
      for (let r = 0; r < runs.length; r += 2) {
        const s = runs[r] as number;
        const e = runs[r + 1] as number;
        if (e - s + 1 < minRun) continue;
        if (group.length && s - (group[group.length - 1] as number) - 1 > bridge) closeGroup();
        group.push(s, e);
      }
      closeGroup();
      let mass = 0;
      let moment = 0;
      for (let d = -(reach - 1); d <= reach - 1; d++) {
        const v = (profile[d + reach - 1] as number) / Math.max(1, visible);
        mass += v;
        moment += v * d;
      }
      if (first >= 0 && mass > 0) {
        out.push({
          family,
          offset: oOrigin + o + moment / mass,
          start: tOrigin + first,
          end: tOrigin + last,
          contrast: top,
          mass,
          polarity: sign > 0 ? 1 : -1,
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Tolerance (px) for a gridline's end to count as reaching a plot edge `extent` px long. */
const endTolerance = (extent: number) => Math.max(3, 0.02 * extent);

/**
 * A gridline at least this strong relative to the strongest is a major one; thinner or fainter
 * lines between the majors are minor gridlines (ggplot2 draws them at half the width).
 */
const MAJOR_SHARE = 0.7;

/**
 * Tick positions of `axis` from the gridlines that cross the plot: lines of the other family that
 * reach from one plot edge (`lo`) to the opposite one (`hi`, offsets across the axis), one
 * polarity and darkness, on a lattice. The plot's own edges are never ticks, even where they lie
 * on the lattice (an old figure's frame often stands one step beyond its last label, and a frame
 * is not a mark at a value) — unless `edgeLines` says the edges at the axis's ends are themselves
 * gridlines (a grid of one family only: its outermost lines are all that is known of the plot's
 * extent). Null when there is no such pattern.
 */
export function gridlineTicks(
  grid: GrayGrid,
  frame: Frame,
  axis: LineCandidate,
  lo: number,
  hi: number,
  reach: number,
  edgeLines = false,
): TickSet | null {
  const crossing: Family = axis.family === 'horizontal' ? 'vertical' : 'horizontal';
  const extent = hi - lo;
  if (extent < 20 || axis.end - axis.start < 20) return null;
  // Inset from the plot's edges, so the lines along them are not part of the ridges.
  const inset = Math.max(2, Math.ceil(axis.thickness) + 1);
  const lines = findGridLines(grid, crossing, { a0: lo + inset, a1: hi - inset, o0: axis.start - reach - 1, o1: axis.end + reach + 1 }, reach);
  const tol = endTolerance(extent);
  const edge = edgeLines ? -1.5 : 2 + axis.thickness;
  const spanning = lines.filter(
    (l) =>
      l.start <= lo + inset + tol &&
      l.end >= hi - inset - tol &&
      // Not the frame's own lines at the two ends of the axis.
      l.offset > axis.start + edge &&
      l.offset < axis.end - edge,
  );
  let best: TickSet | null = null;
  for (const polarity of [1, -1] as const) {
    const group = spanning.filter((l) => l.polarity === polarity);
    if (group.length < 3) continue;
    // Gridlines of one grid share a colour: lines much fainter or stronger than the typical one
    // are something else (a data line running straight across, a zero line drawn in black).
    const typical = medianOf(group.map((l) => l.contrast));
    const same = group.filter((l) => l.contrast >= 0.5 * typical && l.contrast <= 2 * typical);
    if (same.length < 3) continue;
    // Strength → "length" classes for the tick-pattern rules: a full-strength line is a major,
    // a thinner one between majors a minor gridline. The reference is the second strongest line:
    // plotly draws its zero line twice as wide as the others.
    const masses = same.map((l) => l.mass).sort((a, b) => b - a);
    const ref = masses[1] ?? masses[0] ?? 1;
    const marks: Segment[] = same.map((l) => ({ along: l.offset, length: l.mass >= MAJOR_SHARE * ref ? 10 : (10 * l.mass) / ref, mass: l.mass }));
    const set = analyseMarks(frame, axis, marks, 'inside');
    if (set.ticks.length && (!best || set.confidence > best.confidence)) best = set;
  }
  if (!best) return null;
  return { ...best, ticks: best.ticks.map((t) => ({ ...t, length: extent })), side: 'inside', source: 'gridlines' };
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

/** A family of gridlines sharing their two ends. */
interface Cluster {
  /** The evenly spaced lines. */
  lines: GridLine[];
  /** Every line that starts and ends with them (the lattice, plus a frame of the same colour). */
  together: GridLine[];
  start: number;
  end: number;
  spacing: number;
}

/**
 * The largest set of evenly spaced lines of one family, polarity and darkness that start and end
 * together: at least three in a row, each a step or two from the next (data can hide a line).
 * Lines that share their ends but stand off the lattice — a frame in the gridlines' colour, half
 * a step beyond the last gridline — are kept beside it (`together`).
 */
function gridCluster(lines: GridLine[], extent: number): Cluster | null {
  let best: Cluster | null = null;
  for (const polarity of [1, -1] as const) {
    const group = lines.filter((l) => l.polarity === polarity && l.end - l.start >= 0.2 * extent);
    const seen = new Set<GridLine>();
    for (const seed of group) {
      if (seen.has(seed)) continue;
      const tol = endTolerance(seed.end - seed.start);
      const together = group.filter(
        (l) =>
          Math.abs(l.start - seed.start) <= tol &&
          Math.abs(l.end - seed.end) <= tol &&
          l.contrast >= 0.5 * seed.contrast &&
          l.contrast <= 2 * seed.contrast,
      );
      if (together.length < 3) continue;
      for (const l of together) seen.add(l);
      const offs = together.map((l) => l.offset);
      const gaps = offs.slice(1).map((v, i) => v - (offs[i] as number));
      // Every gap is tried as the step; the longest chain of lines one or two steps apart wins.
      let chain: [number, number] | null = null;
      let step = 0;
      for (const unit of gaps) {
        if (unit < 6) continue;
        const fits = (g: number) => [1, 2].some((k) => Math.abs(g - k * unit) <= Math.max(1.5, 0.08 * unit));
        let from = 0;
        for (let i = 0; i <= gaps.length; i++) {
          if (i < gaps.length && fits(gaps[i] as number)) continue;
          // Lines from..i form a chain.
          if (i - from + 1 >= 3 && (!chain || i - from > chain[1] - chain[0])) {
            chain = [from, i];
            step = unit;
          }
          from = i + 1;
        }
      }
      if (!chain) continue;
      const members = together.slice(chain[0], chain[1] + 1);
      if (best && members.length <= best.lines.length) continue;
      best = { lines: members, together, start: medianOf(together.map((l) => l.start)), end: medianOf(together.map((l) => l.end)), spacing: step };
    }
  }
  return best;
}

/** The plot area spanned by a grid, frame coordinates. */
export interface GridBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The grid's own evenly spaced lines of each family (empty when that family has no grid). */
  horizontal: GridLine[];
  vertical: GridLine[];
  /**
   * A single line inside the grid that spans it and is clearly stronger than the gridlines: an
   * axis line through the plot (an Excel chart whose X axis crosses at zero). Null without one.
   */
  axisH: GridLine | null;
  axisV: GridLine | null;
}

/**
 * The plot area of a chart from its gridlines alone (see the header), or null without a grid.
 * An edge is where the gridlines end — or the line of the other family that runs there (a frame
 * in the gridlines' colour, or the first gridline itself when it lies on the edge). With
 * gridlines of one family only, the other two edges are that family's outermost lines, including
 * a line just beyond the last one that starts and ends with them (an Excel chart's X axis line
 * below its lowest gridline).
 */
export function gridBox(grid: GrayGrid, reach: number): GridBox | null {
  const whole = (family: Family): Region =>
    family === 'horizontal'
      ? { a0: grid.u0, a1: grid.u0 + grid.width - 1, o0: grid.w0, o1: grid.w0 + grid.height - 1 }
      : { a0: grid.w0, a1: grid.w0 + grid.height - 1, o0: grid.u0, o1: grid.u0 + grid.width - 1 };
  const hAll = findGridLines(grid, 'horizontal', whole('horizontal'), reach);
  const vAll = findGridLines(grid, 'vertical', whole('vertical'), reach);
  let h = gridCluster(hAll, grid.width);
  let v = gridCluster(vAll, grid.height);
  if (!h && !v) return null;
  // Two grids that do not belong together (say, a table's rules beside the chart): keep the larger.
  if (h && v) {
    const tol = Math.max(endTolerance(h.end - h.start), endTolerance(v.end - v.start)) + 2;
    const hc = h;
    const vc = v;
    const hInside = hc.lines.every((l) => l.offset >= vc.start - tol && l.offset <= vc.end + tol);
    const vInside = vc.lines.every((l) => l.offset >= hc.start - tol && l.offset <= hc.end + tol);
    if (!hInside || !vInside) {
      if (hc.lines.length >= vc.lines.length) v = null;
      else h = null;
    }
  }
  /** The outermost lines of a lone family, extended by a line that shares its ends just beyond. */
  const span = (c: Cluster, all: GridLine[]) => {
    const tol = endTolerance(c.end - c.start);
    const fits = (l: GridLine) => Math.abs(l.start - c.start) <= tol && Math.abs(l.end - c.end) <= tol;
    let lo = c.lines[0]?.offset ?? 0;
    let hi = c.lines[c.lines.length - 1]?.offset ?? 0;
    for (const l of all) {
      if (!fits(l)) continue;
      if (l.offset < lo && lo - l.offset <= 1.2 * c.spacing) lo = l.offset;
      if (l.offset > hi && l.offset - hi <= 1.2 * c.spacing) hi = l.offset;
    }
    return { lo, hi };
  };
  /** Where a family's lines end, moved onto a line of the other family that runs right there. */
  const snap = (end: number, others: GridLine[], lo: number, hi: number) => {
    // The line must run along most of the edge (a marker or the other axis may hide its ends).
    const tol = 0.1 * (hi - lo);
    let best: GridLine | null = null;
    for (const l of others) {
      if (Math.abs(l.offset - end) > reach + 3 || l.start > lo + tol || l.end < hi - tol) continue;
      if (!best || Math.abs(l.offset - end) < Math.abs(best.offset - end)) best = l;
    }
    return best ? best.offset : end;
  };
  let box: { left: number; right: number; top: number; bottom: number };
  if (h && v) {
    box = {
      left: snap(h.start, vAll, v.start, v.end),
      right: snap(h.end, vAll, v.start, v.end),
      top: snap(v.start, hAll, h.start, h.end),
      bottom: snap(v.end, hAll, h.start, h.end),
    };
  } else if (h) {
    const s = span(h, hAll);
    box = { left: h.start, right: h.end, top: s.lo, bottom: s.hi };
  } else {
    const c = v as Cluster;
    const s = span(c, vAll);
    box = { left: s.lo, right: s.hi, top: c.start, bottom: c.end };
  }
  /** The one clearly stronger dark line of a family inside the box, spanning it. */
  const axisLine = (all: GridLine[], own: Cluster | null, other: Cluster | null, lo: number, hi: number, from: number, to: number) => {
    const typical = medianOf((own ?? other)?.lines.map((l) => l.contrast) ?? []);
    const tol = endTolerance(to - from);
    const strong = all.filter(
      (l) =>
        l.polarity === 1 &&
        l.contrast >= AXIS_OVER_GRID * typical &&
        l.offset > lo + tol &&
        l.offset < hi - tol &&
        l.start <= from + tol &&
        l.end >= to - tol,
    );
    return strong.length === 1 ? (strong[0] as GridLine) : null;
  };
  return {
    ...box,
    horizontal: h?.lines ?? [],
    vertical: v?.lines ?? [],
    axisH: axisLine(hAll, h, v, box.top, box.bottom, box.left, box.right),
    axisV: axisLine(vAll, v, h, box.left, box.right, box.top, box.bottom),
  };
}
