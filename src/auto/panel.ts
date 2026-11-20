/**
 * A filled plot panel: ggplot2's and seaborn's grey panel, plotly's blue-grey one, old Excel's
 * grey plot area — or a white panel on a coloured page. Such charts often draw no axis lines; the
 * panel's bottom and left edges are the axes.
 *
 * The panel is the largest rectangle of one flat grey level that differs from the page's level
 * (the median of the image's outer ring). Candidates are the most common such levels; for each,
 * the rows and columns that hold enough pixels of that level give four edges: per row / column the
 * first and last pixel of the level, and of those the outermost position that a good share of the
 * rows (columns) agree on, spread along the whole edge. Gridlines and data inside the panel do
 * not matter, nor do bars standing on its bottom edge: the columns between the bars still reach
 * it. The edges must enclose a good part of the image. Bars of one colour are no panel (their
 * tops differ), nor is the area under a curve. The page itself is no panel either (a scan's paper tone inside the
 * white corners a rotation leaves, or a screenshot's window): a panel leaves room for the tick
 * labels at its left and below it. Edges are refined to sub-pixel positions from the antialiased
 * boundary pixels.
 */

import type { GrayGrid } from './grid.ts';

/** A panel must differ from the page by at least this many grey levels. */
const MIN_STEP = 6;
/** Pixels within this many grey levels of the panel's level belong to it (JPEG ripple). */
const LEVEL_TOL = 3;
/** The panel's level must cover at least this share of the image. */
const MIN_SHARE = 0.1;
/** The panel must span at least this share of the image in both directions. */
const MIN_SPAN = 0.3;
/** A panel leaves at least this share of the image free at its left and below it (labels). */
const MIN_MARGIN = 0.03;
/** Share of a panel's rows (columns) that must reach an edge (within 1 px) for it to be one. */
const EDGE_SUPPORT = 0.15;
/** Those rows (columns) must be spread over at least this share of the edge's length. */
const EDGE_SPREAD = 0.7;
/** A row's first/last panel pixel is the start/end of a run at least this long. */
const MIN_RUN = 4;

/** Panel edges in frame coordinates (sub-pixel boundaries: between pixel centres). */
export interface Panel {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The panel's grey level and the page's. */
  level: number;
  background: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function findPanel(grid: GrayGrid): Panel | null {
  const { width: W, height: H, data, background } = grid;
  const n = W * H;
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    const g = data[i] as number;
    if (Math.abs(g - background) >= MIN_STEP) {
      const v = Math.round(g);
      hist[v] = (hist[v] as number) + 1;
    }
  }
  // Windowed counts; the best few separate levels are tried, largest first.
  const windowed = new Int32Array(256);
  for (let v = 0; v < 256; v++) {
    let s = 0;
    for (let k = Math.max(0, v - LEVEL_TOL); k <= Math.min(255, v + LEVEL_TOL); k++) s += hist[k] as number;
    windowed[v] = s;
  }
  const levels: number[] = [];
  for (let tries = 0; tries < 3; tries++) {
    let best = -1;
    for (let v = 0; v < 256; v++) {
      if (levels.some((l) => Math.abs(l - v) <= 2 * LEVEL_TOL + 1)) continue;
      if (best < 0 || (windowed[v] as number) > (windowed[best] as number)) best = v;
    }
    if (best < 0 || (windowed[best] as number) < MIN_SHARE * n) break;
    // The exact level: the fullest single bin inside the window.
    let exact = best;
    for (let k = Math.max(0, best - LEVEL_TOL); k <= Math.min(255, best + LEVEL_TOL); k++) {
      if ((hist[k] as number) > (hist[exact] as number)) exact = k;
    }
    levels.push(exact);
  }
  let found: Panel | null = null;
  let foundArea = 0;
  for (const level of levels) {
    const p = panelAt(grid, level);
    if (!p) continue;
    const area = (p.right - p.left) * (p.bottom - p.top);
    if (area > foundArea) {
      found = p;
      foundArea = area;
    }
  }
  return found;
}

function panelAt(grid: GrayGrid, level: number): Panel | null {
  const { width: W, height: H, data, background } = grid;
  const inLevel = (i: number) => Math.abs((data[i] as number) - level) <= LEVEL_TOL;
  const rowCount = new Int32Array(H);
  const colCount = new Int32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inLevel(y * W + x)) {
        rowCount[y] = (rowCount[y] as number) + 1;
        colCount[x] = (colCount[x] as number) + 1;
      }
    }
  }
  const typical = (counts: Int32Array) => {
    const s = Array.from(counts).filter((c) => c > 0).sort((a, b) => a - b);
    return s.length ? (s[Math.floor(0.9 * (s.length - 1))] as number) : 0;
  };
  const wide = typical(rowCount);
  const tall = typical(colCount);
  if (wide < MIN_SPAN * W || tall < MIN_SPAN * H) return null;

  // First and last panel pixel (as part of a run) along each row / column that holds the panel.
  const ends = (count: number, at: (t: number) => number): [number, number] | null => {
    let first = -1;
    let last = -1;
    let run = 0;
    for (let t = 0; t < count; t++) {
      if (inLevel(at(t))) {
        run++;
        if (run >= MIN_RUN) {
          if (first < 0) first = t - run + 1;
          last = t;
        }
      } else run = 0;
    }
    return first < 0 ? null : [first, last];
  };
  const lefts: number[] = [];
  const rights: number[] = [];
  const rowsUsed: number[] = [];
  for (let y = 0; y < H; y++) {
    if ((rowCount[y] as number) < 0.25 * wide) continue;
    const e = ends(W, (x) => y * W + x);
    if (!e) continue;
    lefts.push(e[0]);
    rights.push(e[1]);
    rowsUsed.push(y);
  }
  const tops: number[] = [];
  const bottoms: number[] = [];
  const colsUsed: number[] = [];
  for (let x = 0; x < W; x++) {
    if ((colCount[x] as number) < 0.25 * tall) continue;
    const e = ends(H, (y) => y * W + x);
    if (!e) continue;
    tops.push(e[0]);
    bottoms.push(e[1]);
    colsUsed.push(x);
  }
  if (rowsUsed.length < MIN_SPAN * H || colsUsed.length < MIN_SPAN * W) return null;
  // The outermost position that enough rows (columns) reach, spread along the edge; NaN if none.
  const outermost = (values: number[], used: number[], dir: 1 | -1): number => {
    const sorted = [...new Set(values)].sort((a, b) => dir * (b - a));
    for (const v of sorted) {
      let count = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < values.length; k++) {
        if (Math.abs((values[k] as number) - v) > 1 || dir * ((values[k] as number) - v) > 0) continue;
        count++;
        lo = Math.min(lo, used[k] as number);
        hi = Math.max(hi, used[k] as number);
      }
      const length = (used[used.length - 1] as number) - (used[0] as number);
      if (count >= EDGE_SUPPORT * values.length && hi - lo >= EDGE_SPREAD * length) return v;
    }
    return NaN;
  };
  const left = outermost(lefts, rowsUsed, -1);
  const right = outermost(rights, rowsUsed, 1);
  const top = outermost(tops, colsUsed, -1);
  const bottom = outermost(bottoms, colsUsed, 1);
  if (Number.isNaN(left) || Number.isNaN(right) || Number.isNaN(top) || Number.isNaN(bottom)) return null;
  if (right - left < MIN_SPAN * W || bottom - top < MIN_SPAN * H) return null;
  if (left < MIN_MARGIN * W || H - 1 - bottom < MIN_MARGIN * H) return null;

  // Sub-pixel edges: the boundary pixel just outside the panel is partly covered by it. Its share
  // is read against the pixel two further out (the page, or a frame line: then no refinement).
  const refine = (edge: number, dir: 1 | -1, used: number[], firsts: number[], pixel: (along: number, across: number) => number): number => {
    const shares: number[] = [];
    for (let k = 0; k < used.length; k++) {
      if (firsts[k] !== edge) continue;
      const along = used[k] as number;
      const partial = pixel(along, edge + dir);
      const outer = pixel(along, edge + 3 * dir);
      if (Number.isNaN(partial) || Number.isNaN(outer) || Math.abs(outer - level) < MIN_STEP) continue;
      const f = (partial - outer) / (level - outer);
      if (f >= -0.1 && f <= 1.1) shares.push(Math.min(1, Math.max(0, f)));
    }
    const share = shares.length >= 5 ? median(shares) : 0;
    return edge + dir * (0.5 + share);
  };
  const px = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? NaN : (data[y * W + x] as number));
  return {
    left: grid.u0 + refine(left, -1, rowsUsed, lefts, (y, x) => px(x, y)),
    right: grid.u0 + refine(right, 1, rowsUsed, rights, (y, x) => px(x, y)),
    top: grid.w0 + refine(top, -1, colsUsed, tops, (x, y) => px(x, y)),
    bottom: grid.w0 + refine(bottom, 1, colsUsed, bottoms, (x, y) => px(x, y)),
    level,
    background,
  };
}
