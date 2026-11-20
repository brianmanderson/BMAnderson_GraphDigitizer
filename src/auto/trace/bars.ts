/**
 * Bars: one click on a bar → a point at the value end of every bar of that series, at the middle
 * of the bar's width ("Find points" for bar charts and histograms; docs/SPEC.md → Auto-trace →
 * Bars). Pure TS, no DOM. Entry: `findBars`.
 *
 * Where the point goes:
 * - a bar standing on the baseline: its top edge (a horizontal bar: its right end);
 * - a bar hanging below the baseline (a negative value): its bottom edge (horizontal: left end);
 * - a stacked segment: its edge away from the baseline — the top edge when nothing says otherwise;
 * - a bar with an error bar: still the bar's own end, never the cap;
 * - an outlined bar: the middle of the outline's stroke (where the value is drawn).
 *
 * Two ways in, one reading. A click inside a solid SEED_BLOCK-square of the series' colour is on a
 * fill (filled bars, below); if that finds nothing and the fill has an outline of another colour,
 * or the click is on a thin stroke of the series (an outline, a hatch line), the bars are read as
 * outlined cells (`outlinedReadings`): the insides of the outline's walls, each a rectangle, drawn
 * alike (`sameTexture`) — and those cells are handed to the same reading as solid fills.
 *
 * Filled bars. The series' ink is cut into runs along the value axis, column by column for
 * vertical bars (row by row for horizontal ones; both are tried and the larger family wins). Thin
 * ink of another colour inside a run — hatching, an error bar's cap, a curve drawn over the bars —
 * is bridged. Runs of neighbouring columns that overlap form a chain, and a chain is cut into
 * segments whose two ends stay put: rectangles. A column with more ink beyond its end than the
 * chain's usual outline (an error bar's stem, a curve over the bar's top) says nothing about that
 * end and never cuts a segment. Two segments with the same ends on either side of a thin line of
 * other ink (a mean line drawn through a bar) are one bar when only together they have a bar's
 * width. The unit is the commonest width among the segments that share an end with the clicked
 * one: bars are the segments one unit wide, and in a chain of touching bars a segment n units wide
 * is n bars of equal height (a histogram without outlines). They are bars only as a family:
 *
 * - the baseline is the coordinate the most bar length ends on (a row of legend swatches lined up
 *   by chance is short); a bar ending there has its value at the other end, and a bar away from it
 *   is a stacked segment when ink runs from it to the baseline (the segments under it; a legend
 *   swatch floats). When the bars share their far end instead and stand on other ink (the top
 *   layer of a 100 % stack), or share no end (an upper layer), each must sit on ink all the way to
 *   the plot's edge (never on the edge itself) and has its value at the far end;
 * - bars whose lengths are all alike and small are markers in a row, not bars; a segment with
 *   more of the series' ink attached to its side that is not a bar (a plateau of a thick step
 *   curve between its risers) is not one either;
 * - of one fill colour, only the bars drawn like the clicked one (`alike`: plain, or the same
 *   hatching — texture is other ink inside the fill, read in blocks so a curve crossing a bar is
 *   no pattern).
 *
 * When the plot box cut the bars (a value end on its edge, or the series' ink going on just past an
 * edge a bar ends on: a box stopping at the last gridline), they are looked for again over the
 * whole image.
 *
 * Not found (docs/SPEC.md → Known failures): bars of height zero; outlined bars all of one length
 * (taken for a ruled grid); a thin outline blended into a fill of nearly its colour is read up to
 * ~2 px short.
 */

import { coverage, dist, greySeries, INK_MIN, maxAlpha, ON_ALPHA, rgbAt, type ColorModel, type Img, type RGB } from './color.ts';
import { makeRegion, type Region } from './region.ts';
import type { TracedPoint } from './types.ts';

/** Smallest width and length of a bar, px. */
const MIN_SIDE = 3;
/** A click on a bar is inside a solid block of its fill this big, px (a thin line never is). */
const SEED_BLOCK = 4;
/** Ink of another colour this thick inside a run is bridged (hatching, a cap, a crossing curve). */
const BRIDGE = 10;
/** An outline is at most this thick; the value is at the middle of its stroke. */
const SKIRT = 4;
/** An end hidden under a band of ink up to this thick is estimated at the band's middle. */
const BAND = 14;
/** Fill edges within this are the same edge (one bar's, column to column). */
const END_TOL = 1.25;
/** Ends within this share a baseline. */
const ALIGN = 1.5;
/** Bars of one series: widths within this fraction of the unit (or WIDTH_PX: thin bars in a JPEG bleed). */
const WIDTH_TOL = 0.12;
const WIDTH_PX = 2.5;
/** A stacked segment sits on ink all the way to the baseline, but for seams this wide. */
const SEAM = 3;
/** A line of other ink this wide through a bar does not make it two. */
const SPLIT = 3;
/** A sliver of columns beside a rectangle is its blurred side when its ends are within this of it. */
const SLIVER = 3;
/** Stacked segments that share no baseline are at least this wide, px. */
const MIN_STACKED = 8;
/** The longest bar of a family is at least this long, px (and a quarter of the bars' width). */
const MIN_LONGEST = 8;
/** Bars at least this fraction of the clicked one's length vote for the baseline. */
const VOTE = 0.2;
/** Marker-sized bars are bars only as a family of at least this many. */
const MIN_SMALL_FAMILY = 4;
/** Bars all of one length up to this are markers in a row. */
const UNIFORM_MAX = 30;
/** A family of marker-sized bars none longer than this many unit widths is markers. */
const COMPACT_BARS = 1.5;
/** A straight run of ink this long is an outline, a stem or a ruling — never hatching or a dot, px. */
const WALL_RUN = 7;
/** Texture ink has the bar's fill within this on both sides, px. */
const TEXTURE_REACH = 5;
const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];
/** An outline's ink: coverage of the series' colour at least this (anti-aliased thin strokes). */
const WALL_ALPHA = 0.35;
/** Cells of ruled hatching are at most this far across between their rules, px. */
const RULED_MAX = 24;
/** Within this of the region's edge, px (a frame's thickness and a pixel). */
const EDGE_NEAR = 4;
/** A cell is a bar's inside when other cells take no more than this of its bounding box. */
const FOREIGN = 0.03;
/** Bars whose texture is read from fewer pixels than this are compared loosely. */
const TEXTURE_MIN = 30;

export interface BarsInput {
  /** The image, for a second look beyond the region (see `findBars`) and the faces of outlined bars. */
  img: Img;
  alpha: Float32Array;
  other: Uint8Array;
  region: Region;
  model: ColorModel;
  seed: { x: number; y: number };
  /** 'markers': the user asked for points — a lone bar is accepted. */
  lone: boolean;
  /** Largest size of a marker, px (index.ts): rectangles up to it could be filled square markers. */
  markerMax: number;
}

interface End {
  /** Sub-pixel position of the fill's edge along the value axis. */
  fill: number;
  /** Ink of another colour right beyond it, px (capped at BAND + 1). */
  skirt: number;
  /** Ink of another colour, or the region's edge, right beyond it. */
  attached: boolean;
}

interface Run {
  u: number;
  a: number;
  b: number;
  prev: Run | null;
  next: Run | null;
  overlap: number;
  lo: End;
  hi: End;
}

interface Segment {
  /** First and last column (row, for horizontal bars) of the segment. */
  u0: number;
  u1: number;
  /** Columns at each side that may belong to the neighbour (their ends were covered). */
  amb0: number;
  amb1: number;
  /** The bar's ends along the value axis (an outline: the middle of its stroke). */
  lo: number;
  hi: number;
  loHidden: boolean;
  hiHidden: boolean;
  loAttached: boolean;
  hiAttached: boolean;
  chain: number;
  /** Index within its chain's segments. */
  index: number;
  body: { a: number; b: number };
  /** Sub-pixel sides. */
  left: number;
  right: number;
}

interface Bar {
  centre: number;
  seg: Segment;
}

interface Grid {
  vertical: boolean;
  w: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  on: Uint8Array;
  /** Ink of another colour. */
  occ: Uint8Array;
  alpha: Float32Array;
  mask: Uint8Array;
  /** Outlined bars: the cell of each pixel; a run never bridges a wall into another cell. */
  cell: Int32Array | null;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN;
};

/** What the bar finder sees: the bars' own pixels, other ink, and the texture drawn over the bars. */
interface Masks {
  on: Uint8Array;
  occ: Uint8Array;
  alpha: Float32Array;
  /** Texture inside the bars (hatching, dots): compared between bars to tell series apart. */
  tex: Uint8Array;
  /** Whether a bar's face colour (its pixels outside `tex`) tells series apart too (outlined bars). */
  face: boolean;
  /** Outlined bars: the cell of each pixel (see Grid). */
  cell: Int32Array | null;
}

/**
 * Pixels on a straight run of at least WALL_RUN set pixels across (dir 'h') or down (dir 'v'):
 * an outline, a stem, a gridline — never a diagonal hatch line or a dot.
 */
function longRuns(set: Uint8Array, r: Region, out: Uint8Array): void {
  const w = r.width;
  for (let y = r.y0; y <= r.y1; y++) {
    let x = r.x0;
    while (x <= r.x1) {
      if (!set[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e + 1 <= r.x1 && set[y * w + e + 1]) e++;
      if (e - x + 1 >= WALL_RUN) for (let q = x; q <= e; q++) out[y * w + q] = 1;
      x = e + 1;
    }
  }
  for (let x = r.x0; x <= r.x1; x++) {
    let y = r.y0;
    while (y <= r.y1) {
      if (!set[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e + 1 <= r.y1 && set[(e + 1) * w + x]) e++;
      if (e - y + 1 >= WALL_RUN) for (let q = y; q <= e; q++) out[q * w + x] = 1;
      y = e + 1;
    }
  }
}

function masks(input: BarsInput): Masks {
  const { alpha, other, model, region } = input;
  // A grey series: black continues its colour line (α well above 1) and is another ink.
  const cap = greySeries(model) ? 1 + Math.max(0.35, 0.4 * (maxAlpha(model) - 1)) : Number.POSITIVE_INFINITY;
  const on = new Uint8Array(alpha.length);
  const occ = new Uint8Array(alpha.length);
  for (let k = 0; k < alpha.length; k++) {
    const a = alpha[k]!;
    if (a >= ON_ALPHA && a <= cap) on[k] = 1;
    // A faint blend of the series' own colour (a bar's anti-aliased edge) is not another ink.
    else if ((other[k] && a <= 0) || a > cap) occ[k] = 1;
  }
  // Texture drawn over the fill (hatching, dots, a cross-hatch's crossings): other ink with the
  // bar's fill close on both sides along some direction, and not on a long straight run (an
  // outline, an error bar's stem, a zero line). It stays other ink for the reading (bridged inside a
  // run); it tells bars of one fill colour apart (`alike`).
  const straight = new Uint8Array(alpha.length);
  longRuns(occ, region, straight);
  const tex = new Uint8Array(alpha.length);
  const w = region.width;
  const fillAt = (x: number, y: number, dx: number, dy: number): boolean => {
    for (let t = 1; t <= TEXTURE_REACH; t++) {
      const qx = x + t * dx;
      const qy = y + t * dy;
      if (qx < region.x0 || qx > region.x1 || qy < region.y0 || qy > region.y1) return false;
      const q = qy * w + qx;
      if (on[q]) return true;
      if (!occ[q]) return false;
    }
    return false;
  };
  for (let y = region.y0; y <= region.y1; y++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const k = y * w + x;
      if (!occ[k] || straight[k] || !region.mask[k]) continue;
      for (const [dx, dy] of DIRS) {
        if (fillAt(x, y, dx, dy) && fillAt(x, y, -dx, -dy)) {
          tex[k] = 1;
          break;
        }
      }
    }
  }
  return { on, occ, alpha, tex, face: false, cell: null };
}

function gridOf(input: BarsInput, m: Masks, vertical: boolean): Grid {
  const r = input.region;
  return {
    vertical,
    w: r.width,
    u0: vertical ? r.x0 : r.y0,
    u1: vertical ? r.x1 : r.y1,
    v0: vertical ? r.y0 : r.x0,
    v1: vertical ? r.y1 : r.x1,
    on: m.on,
    occ: m.occ,
    alpha: m.alpha,
    mask: r.mask,
    cell: m.cell,
  };
}

const at = (g: Grid, u: number, v: number): number => (g.vertical ? v * g.w + u : u * g.w + v);
const inside = (g: Grid, u: number, v: number): boolean => u >= g.u0 && u <= g.u1 && v >= g.v0 && v <= g.v1 && g.mask[at(g, u, v)] === 1;
/** The same pixels seen along the other axis. */
const transposed = (g: Grid): Grid => ({ ...g, vertical: !g.vertical, u0: g.v0, u1: g.v1, v0: g.u0, v1: g.u1 });

/** The edge beyond the run's end pixel `v` of column `u`, looking in direction `dir` (±1). */
function endOf(g: Grid, u: number, v: number, dir: number): End {
  const a0 = Math.min(1, g.alpha[at(g, u, v)] ?? 1);
  let q = v + dir;
  let blend = 0;
  if (inside(g, u, q)) {
    const k = at(g, u, q);
    const a = g.alpha[k] ?? -1;
    if (!g.on[k] && !g.occ[k] && a > 0) {
      blend = Math.min(0.5, a);
      q += dir;
    }
  }
  let skirt = 0;
  while (skirt <= BAND && inside(g, u, q) && g.occ[at(g, u, q)]) {
    skirt++;
    q += dir;
  }
  return { fill: v + dir * (a0 - 0.5 + blend), skirt, attached: skirt > 0 || !inside(g, u, q) };
}

/** Runs of the series' ink along the value axis in column `u`, thin ink of another colour bridged. */
function runsAt(g: Grid, u: number): Run[] {
  const out: Run[] = [];
  let v = g.v0;
  while (v <= g.v1) {
    if (!g.on[at(g, u, v)]) {
      v++;
      continue;
    }
    const a = v;
    let b = v;
    for (;;) {
      while (b + 1 <= g.v1 && g.on[at(g, u, b + 1)]) b++;
      let e = b + 1;
      while (e <= g.v1 && e - b <= BRIDGE && g.occ[at(g, u, e)]) e++;
      if (e <= g.v1 && e > b + 1 && e - b - 1 <= BRIDGE && g.on[at(g, u, e)] && (!g.cell || g.cell[at(g, u, e)] === g.cell[at(g, u, b)])) {
        b = e;
        continue;
      }
      break;
    }
    if (b - a + 1 >= MIN_SIDE) {
      out.push({ u, a, b, prev: null, next: null, overlap: 0, lo: endOf(g, u, a, -1), hi: endOf(g, u, b, 1) });
    }
    v = b + 1;
  }
  return out;
}

/** Sub-pixel side of the columns u0…u1 over the rows `body` (dir −1: the first column's outer edge). */
function sideOf(g: Grid, u0: number, u1: number, body: { a: number; b: number }, dir: number): number {
  const u = dir < 0 ? u0 : u1;
  const t = transposed(g);
  const edges: number[] = [];
  const span = body.b - body.a;
  for (let f = 0.25; f <= 0.76; f += 0.125) {
    const v = Math.round(body.a + f * span);
    // From the row's own outermost "on" pixel (a hatch line may cover the column's).
    let q = u;
    let steps = 0;
    while (steps < 4 && !g.on[at(g, q, v)]) {
      q -= dir;
      steps++;
    }
    if (!g.on[at(g, q, v)]) continue;
    const e = endOf(t, v, q, dir);
    edges.push(e.skirt <= SKIRT ? e.fill + (dir * e.skirt) / 2 : e.fill);
  }
  return edges.length ? median(edges) : u + dir * 0.5;
}

/** Every chain of overlapping runs, cut into segments whose ends stay put. */
function segmentsOf(g: Grid): Segment[][] {
  const starts: Run[] = [];
  let before: Run[] = [];
  for (let u = g.u0; u <= g.u1; u++) {
    const runs = runsAt(g, u);
    for (const r of runs) {
      let best: Run | null = null;
      let bestO = 0;
      for (const p of before) {
        const o = Math.min(r.b, p.b) - Math.max(r.a, p.a) + 1;
        if (o >= 0.5 * Math.min(r.b - r.a + 1, p.b - p.a + 1) && o > bestO) {
          best = p;
          bestO = o;
        }
      }
      if (best && (!best.next || bestO > best.next.overlap)) {
        if (best.next) {
          best.next.prev = null;
          starts.push(best.next);
        }
        best.next = r;
        r.prev = best;
        r.overlap = bestO;
      } else starts.push(r);
    }
    before = runs;
  }

  const chains: Segment[][] = [];
  for (const start of starts) {
    if (start.prev) continue;
    const cols: Run[] = [];
    for (let r: Run | null = start; r; r = r.next) cols.push(r);
    // The chain's usual ink beyond each end: an outline, the segment it is stacked on, or none.
    const usualLo = median(cols.map((c) => c.lo.skirt));
    const usualHi = median(cols.map((c) => c.hi.skirt));
    // An end's position, column by column: the outer edge of the fill and its outline — the same
    // in every column of a bar, whatever hatching meets the edge. Against another filled area (a
    // stacked segment) it is the fill's own edge. A column with more ink beyond its end than the
    // chain's usual (an error bar's stem, a curve over the top, a hatch line running into the
    // outline) says nothing about that end: it never cuts a segment and counts for neither side.
    const posLo = (c: Run) => (usualLo <= SKIRT ? c.lo.fill - c.lo.skirt : c.lo.fill);
    const posHi = (c: Run) => (usualHi <= SKIRT ? c.hi.fill + c.hi.skirt : c.hi.fill);
    const oddLo = (c: Run) => usualLo <= SKIRT && c.lo.skirt > usualLo + 1;
    const oddHi = (c: Run) => usualHi <= SKIRT && c.hi.skirt > usualHi + 1;
    const segs: Segment[] = [];
    let i = 0;
    while (i < cols.length) {
      const first = cols[i]!;
      const clearLo: number[] = oddLo(first) ? [] : [posLo(first)];
      const clearHi: number[] = oddHi(first) ? [] : [posHi(first)];
      const short: boolean[] = [oddLo(first) || oddHi(first)];
      let j = i;
      // The reference is the median of the columns seen in the clear (the first one is a bar's
      // blurred side: twice the tolerance until there are more). A stack's boundary wobbles more
      // than a free edge (JPEG).
      const cuts = (pos: number, clear: number[], usual: number) => clear.length > 0 && Math.abs(pos - median(clear)) > (clear.length > 1 && usual <= SKIRT ? END_TOL : 2 * END_TOL);
      const cut = (c: Run) => (!oddLo(c) && cuts(posLo(c), clearLo, usualLo)) || (!oddHi(c) && cuts(posHi(c), clearHi, usualHi));
      for (let k = i + 1; k < cols.length; k++) {
        const c = cols[k]!;
        if (cut(c)) {
          // One column that does not fit between two that do is noise (JPEG).
          const after = cols[k + 1];
          if (!after || cut(after)) break;
          short.push(true);
          j = k;
          continue;
        }
        if (!oddLo(c)) clearLo.push(posLo(c));
        if (!oddHi(c)) clearHi.push(posHi(c));
        short.push(oddLo(c) || oddHi(c));
        j = k;
      }
      const part = cols.slice(i, j + 1);
      // Columns at the sides that say nothing could be the neighbour's.
      let amb0 = 0;
      while (amb0 < part.length && short[amb0]) amb0++;
      let amb1 = 0;
      while (amb1 < part.length - amb0 && short[part.length - 1 - amb1]) amb1++;
      const full = part.filter((_, q) => !short[q]);
      const pool = full.length ? full : part;
      // An end in the clear: the middle of its outline (the outer edge less half the stroke), or
      // the fill's edge. Hidden: the middle of the band of ink over it, when that is thin enough.
      const outline = (usual: number) => (usual <= SKIRT ? usual / 2 : 0);
      const guess = (e: End, dir: number) => (e.skirt <= BAND ? e.fill + (dir * e.skirt) / 2 : e.fill);
      const share = (f: (c: Run) => boolean) => part.filter(f).length >= 0.6 * part.length;
      const body = { a: Math.round(median(pool.map((c) => c.a))), b: Math.round(median(pool.map((c) => c.b))) };
      const u0 = part[0]!.u;
      const u1 = part[part.length - 1]!.u;
      segs.push({
        u0,
        u1,
        amb0: amb0 === part.length ? 0 : amb0,
        amb1: amb0 === part.length ? 0 : amb1,
        lo: clearLo.length ? median(clearLo) + outline(usualLo) : median(pool.map((c) => guess(c.lo, -1))),
        hi: clearHi.length ? median(clearHi) - outline(usualHi) : median(pool.map((c) => guess(c.hi, 1))),
        loHidden: !clearLo.length,
        hiHidden: !clearHi.length,
        loAttached: share((c) => c.lo.attached),
        hiAttached: share((c) => c.hi.attached),
        chain: chains.length,
        index: segs.length,
        body,
        left: sideOf(g, u0, u1, body, -1),
        right: sideOf(g, u0, u1, body, 1),
      });
      i = j + 1;
    }
    // A sliver beside a rectangle whose ends are nearly the rectangle's is its blurred side (JPEG).
    for (let q = 0, pass = 0; pass < 3; q++) {
      if (q >= segs.length) {
        q = -1;
        pass++;
        continue;
      }
      const s = segs[q]!;
      if (s.u1 - s.u0 + 1 >= MIN_SIDE) continue;
      const near = [segs[q - 1], segs[q + 1]].filter((o): o is Segment => !!o && o.u1 - o.u0 + 1 >= MIN_SIDE && Math.abs(o.lo - s.lo) <= SLIVER && Math.abs(o.hi - s.hi) <= SLIVER);
      const host = near[0];
      if (!host) continue;
      if (host.u0 > s.u1) {
        host.u0 = s.u0;
        host.left = s.left;
      } else {
        host.u1 = s.u1;
        host.right = s.right;
      }
      segs.splice(q, 1);
      q--;
    }
    segs.forEach((s, q) => (s.index = q));
    // Columns that may be the neighbour's are in doubt for both.
    for (let q = 0; q + 1 < segs.length; q++) {
      const s = segs[q]!;
      const o = segs[q + 1]!;
      if (o.u0 !== s.u1 + 1) continue;
      const doubt = Math.max(s.amb1, o.amb0);
      s.amb1 = doubt;
      o.amb0 = doubt;
    }
    chains.push(segs);
  }
  return chains;
}

const wide = (s: Segment): boolean => s.u1 - s.u0 + 1 >= MIN_SIDE && s.hi - s.lo >= MIN_SIDE;
const widthOf = (s: Segment): number => s.right - s.left;
const sameEnds = (a: Segment, b: Segment): boolean => Math.abs(a.lo - b.lo) <= ALIGN && Math.abs(a.hi - b.hi) <= ALIGN;

/** The commonest of `widths` (within 1.5 px), the one nearest `near` among equals. */
function commonest(widths: number[], near: number): number {
  let best = near;
  let bestN = 0;
  for (const w of widths) {
    const n = widths.filter((x) => Math.abs(x - w) <= 1.5).length;
    if (n > bestN || (n === bestN && Math.abs(w - near) < Math.abs(best - near))) {
      best = w;
      bestN = n;
    }
  }
  return bestN ? median(widths.filter((x) => Math.abs(x - best) <= 1.5)) : near;
}

interface Found {
  bars: Bar[];
  /** Value end of each bar: true = the high end (larger coordinate along the value axis). */
  valueHigh: boolean[];
}

/** The family of bars the seed's segment belongs to in one orientation, or null. */
function family(g: Grid, chains: Segment[][], seedU: number, seedV: number, lone: boolean, markerMax: number): Found | null {
  const holds = (s: Segment) => seedU >= s.u0 && seedU <= s.u1 && seedV >= s.body.a - 1 && seedV <= s.body.b + 1;
  let seedSeg = chains.flat().find((s) => holds(s) && s.hi - s.lo >= MIN_SIDE) ?? null;
  if (!seedSeg) return null;

  // The unit: the commonest width among the segments sharing an end with the clicked one.
  const tolOf = (unit: number) => Math.max(WIDTH_PX, WIDTH_TOL * unit);
  const mates = (of: Segment) =>
    chains
      .flat()
      .filter((s) => wide(s) && !s.amb0 && !s.amb1 && widthOf(s) >= 0.3 * widthOf(of) && (Math.abs(s.lo - of.lo) <= ALIGN || Math.abs(s.hi - of.hi) <= ALIGN || Math.abs(s.lo - of.hi) <= ALIGN || Math.abs(s.hi - of.lo) <= ALIGN));
  let unit = commonest(mates(seedSeg).map(widthOf), widthOf(seedSeg));
  const fits = (w: number, slack = 0) => {
    const n = Math.max(1, Math.round(w / unit));
    return Math.abs(w - n * unit) <= tolOf(unit) + slack;
  };

  // A bar cut in two by a thin line of other ink (a mean line, a gridline drawn over the bars):
  // two segments with the same ends, neither a bar's width, that together are one.
  const all = chains.flat().sort((a, b) => a.u0 - b.u0);
  const merged = new Map<Segment, Segment>();
  for (const a of all) {
    if (merged.has(a) || a.hi - a.lo < MIN_SIDE) continue;
    for (const b of all) {
      const gap = b.u0 - a.u1 - 1;
      if (b === a || merged.has(b) || gap < 1 || gap > SPLIT || !sameEnds(a, b)) continue;
      if (fits(widthOf(a)) && fits(widthOf(b))) continue;
      if (!fits(b.right - a.left)) continue;
      // What separates them is ink, not background.
      let ink = 0;
      let n = 0;
      for (let u = a.u1 + 1; u < b.u0; u++) {
        for (let v = a.body.a; v <= a.body.b; v++) {
          n++;
          const k = at(g, u, v);
          if (g.occ[k] || g.on[k]) ink++;
        }
      }
      if (ink < 0.7 * n) continue;
      const whole: Segment = { ...a, u1: b.u1, right: b.right, amb1: b.amb1, chain: -1, index: 0 };
      merged.set(a, whole);
      merged.set(b, whole);
      break;
    }
  }
  const segments = [...new Set(all.map((s) => merged.get(s) ?? s))];
  seedSeg = merged.get(seedSeg) ?? seedSeg;
  if (!wide(seedSeg)) return null;
  const seedW = widthOf(seedSeg);
  if (!fits(seedW, seedSeg.amb0 + seedSeg.amb1)) unit = seedW;
  const tol = tolOf(unit);

  const bars: Bar[] = [];
  for (const s of segments) {
    if (!wide(s)) continue;
    const w = widthOf(s);
    // Several units wide: touching bars of one height — only in a chain of touching bars.
    const touching = s.chain >= 0 && chains[s.chain]!.filter(wide).length >= 2;
    const n = touching ? Math.max(1, Math.round(w / unit)) : 1;
    const slack = tol + s.amb0 + s.amb1;
    if (Math.abs(w - n * unit) > (n === 1 ? slack : slack + 0.05 * w)) continue;
    // Sides that are sure anchor the bars; a side whose columns were covered gives way.
    const from = s.amb0 && !s.amb1 ? s.right - n * unit : s.amb0 && s.amb1 ? (s.left + s.right - n * unit) / 2 : s.left;
    const step = s.amb0 || s.amb1 ? unit : w / n;
    for (let k = 0; k < n; k++) bars.push({ centre: from + (k + 0.5) * step, seg: s });
  }
  if (!bars.some((b) => b.seg === seedSeg)) return null;

  // More of the series' ink attached to a bar's side that is no bar: not a bar (a thick step
  // curve's plateau between its risers).
  const member = new Set(bars.map((b) => b.seg));
  const dirty = (s: Segment): boolean => {
    if (s.chain < 0) return false;
    const segs = chains[s.chain]!;
    for (const dir of [-1, 1]) {
      let ragged = 0;
      for (let i = s.index + dir; i >= 0 && i < segs.length; i += dir) {
        const o = merged.get(segs[i]!) ?? segs[i]!;
        // Touching bars share an end (a histogram's baseline); the pieces of a sloping thick
        // line touch too, and share none.
        if (member.has(o) && o !== s && Math.abs(o.lo - s.lo) > ALIGN && Math.abs(o.hi - s.hi) > ALIGN) return true;
        if (member.has(o)) break;
        // A neighbour with nearly the bar's own ends is its ragged side, not other ink (nearly: by
        // the bar's length — next to a thick line's flat stretch everything is near).
        const near = Math.min(2 * SLIVER, 0.15 * (s.hi - s.lo));
        if (Math.abs(o.lo - s.lo) <= near && Math.abs(o.hi - s.hi) <= near) continue;
        ragged += o.u1 - o.u0 + 1;
        if (ragged >= MIN_SIDE) return true;
      }
    }
    return false;
  };

  // The baseline: the coordinate most bars end on. Only bars of some length vote (a fifth of the
  // clicked one): a row of short pieces lined up by chance — a legend's swatches, the risers of a
  // thick step curve — does not outvote the bars standing on it.
  const ends = bars.map((b) => b.seg);
  const voters = ends.filter((s) => s.hi - s.lo >= VOTE * (seedSeg!.hi - seedSeg!.lo));
  let z = Number.NaN;
  let zCount = 0;
  for (const c of voters.flatMap((s) => [s.lo, s.hi])) {
    const n = voters.filter((s) => Math.abs(s.lo - c) <= ALIGN || Math.abs(s.hi - c) <= ALIGN).length;
    if (n > zCount) {
      zCount = n;
      z = c;
    }
  }
  let based = zCount >= 2 && zCount >= 0.5 * voters.length;
  if (based) {
    // A shared far end (top; right for horizontal bars) while the other ends sit on ink is the top
    // of a full stack (a 100 % chart), not a baseline — whether or not a gridline touches it.
    // (Bars hanging from a top baseline have free bottoms.)
    const onBase = ends.filter((s) => Math.abs(s.lo - z) <= ALIGN || Math.abs(s.hi - z) <= ALIGN);
    const far = onBase.filter((s) => (g.vertical ? Math.abs(s.lo - z) <= ALIGN && s.hiAttached : Math.abs(s.hi - z) <= ALIGN && s.loAttached));
    if (far.length > 0.5 * onBase.length) based = false;
  }
  // Whether ink (of any colour) runs from the bar's end at `from` to the baseline, but for seams.
  const stacked = (b: Bar, from: number, to = z): boolean => {
    const z = to;
    const dir = z > from ? 1 : -1;
    const quarter = widthOf(b.seg) / 4 / Math.max(1, Math.round(widthOf(b.seg) / unit));
    for (const u of [b.centre - quarter, b.centre, b.centre + quarter]) {
      let run = 0;
      let bg = 0;
      let n = 0;
      for (let v = Math.round(from) + dir; dir > 0 ? v < z - 1 : v > z + 1; v += dir) {
        n++;
        const k = at(g, Math.round(u), v);
        if (inside(g, Math.round(u), v) && !g.on[k] && !g.occ[k] && (g.alpha[k] ?? 0) < 0.25) {
          run++;
          bg++;
          if (run > SEAM) return false;
        } else run = 0;
      }
      if (bg > 0.25 * n) return false;
    }
    return true;
  };

  // Where the ink a segment sits on ends, walking from its end at `from` away from it (dir ±1): the
  // first background longer than a seam, in its middle column, or the region's edge.
  const floorOf = (b: Bar, from: number, dir: number): number => {
    const u = Math.round(b.centre);
    let run = 0;
    let v = Math.round(from) + dir;
    for (; v >= g.v0 && v <= g.v1; v += dir) {
      const k = at(g, u, v);
      if (inside(g, u, v) && !g.on[k] && !g.occ[k] && (g.alpha[k] ?? 0) < 0.25) {
        if (++run > SEAM) return v - dir * run;
      } else run = 0;
    }
    return v - dir;
  };
  // Without a baseline, the stacks of a chart stand on one floor: the commonest place where the
  // ink under the segments ends. A legend's swatch sits on its frame, with background below.
  const floorFor = (sit: (s: Segment) => boolean, end: (s: Segment) => number, dir: number): Set<Bar> => {
    const at0 = bars.filter((b) => sit(b.seg)).map((b) => ({ b, f: floorOf(b, end(b.seg), dir) }));
    let floor = Number.NaN;
    let best = 0;
    for (const { f } of at0) {
      const n = at0.filter((o) => Math.abs(o.f - f) <= 2).length;
      if (n > best) {
        best = n;
        floor = f;
      }
    }
    return new Set(at0.filter((o) => Math.abs(o.f - floor) <= 2).map((o) => o.b));
  };
  // All the stacks stand (or all hang): whichever explains more segments.
  const low = floorFor((s) => (g.vertical ? s.hiAttached : s.loAttached), (s) => (g.vertical ? s.hi : s.lo), g.vertical ? 1 : -1);
  const high = floorFor((s) => (g.vertical ? s.loAttached : s.hiAttached), (s) => (g.vertical ? s.lo : s.hi), g.vertical ? -1 : 1);
  const sitsLow = (b: Bar) => low.size >= high.size && low.has(b);
  const hangsHigh = (b: Bar) => high.size > low.size && high.has(b);
  const classify = (based: boolean): { out: Bar[]; valueHigh: boolean[] } => {
    const out: Bar[] = [];
    const valueHigh: boolean[] = [];
    for (const b of bars) {
      const s = b.seg;
      if (dirty(s)) continue;
      if (based && Math.abs(s.hi - z) <= ALIGN) {
        out.push(b);
        valueHigh.push(false);
      } else if (based && Math.abs(s.lo - z) <= ALIGN) {
        out.push(b);
        valueHigh.push(true);
      } else if (based) {
        // A segment stacked on others: ink all the way down (or up) to the baseline.
        const baseIsHigh = z > (s.lo + s.hi) / 2;
        if (stacked(b, baseIsHigh ? s.hi : s.lo)) {
          out.push(b);
          valueHigh.push(!baseIsHigh);
        }
      } else if (unit < MIN_STACKED) {
        // No baseline, and narrow: the pieces of a line, not stacked segments.
      } else if (sitsLow(b)) {
        // No baseline: stacked segments, sitting on what is below (to the left of) them, down to
        // the floor the other stacks stand on.
        out.push(b);
        valueHigh.push(!g.vertical);
      } else if (hangsHigh(b)) {
        out.push(b);
        valueHigh.push(g.vertical);
      }
    }
    return { out, valueHigh };
  };
  // Segments of an upper layer can end on one line by chance: a baseline must explain at least as
  // many bars as reading them as stacked segments does.
  let { out, valueHigh } = classify(based);
  if (based) {
    const alt = classify(false);
    if (alt.out.length > out.length) ({ out, valueHigh } = alt);
  }
  if (!out.some((b) => b.seg === seedSeg)) return null;
  if (out.length < 2) return lone && Math.min(seedW, seedSeg.hi - seedSeg.lo) >= 2 * MIN_SIDE ? { bars: out, valueHigh } : null;
  const lengths = out.map((b) => b.seg.hi - b.seg.lo);
  const uniform = Math.max(...lengths) - Math.min(...lengths) <= ALIGN;
  if (uniform && Math.max(...lengths) <= UNIFORM_MAX) return null;
  // Flat stretches of a thick line are long and thin, every one of them; so are dashes.
  if (Math.max(...lengths) < Math.max(MIN_LONGEST, 0.25 * unit)) return null;
  // A few marker-sized rectangles are markers (filled squares), whatever they line up with.
  const small = Math.max(seedW, seedSeg.hi - seedSeg.lo) <= markerMax;
  if (small && new Set(out.map((b) => b.seg)).size < MIN_SMALL_FAMILY) return null;
  // Marker-sized rectangles none of which is clearly longer than wide are the fills of markers
  // (circles, squares, black-edged markers on their error bars), not bars: Find points takes them.
  if (small && Math.max(...lengths) <= COMPACT_BARS * unit) return null;
  return { bars: out, valueHigh };
}

/** The points of a family, in image coordinates, ordered along the category axis. */
function pointsOf(g: Grid, f: Found): TracedPoint[] {
  return f.bars
    .map((b, i) => {
      const high = f.valueHigh[i]!;
      const value = high ? b.seg.hi : b.seg.lo;
      const confidence = (high ? b.seg.hiHidden : b.seg.loHidden) ? 0.5 : 0.9;
      return g.vertical ? { px: b.centre, py: value, confidence } : { px: value, py: b.centre, confidence };
    })
    .filter((p) => Number.isFinite(p.px) && Number.isFinite(p.py))
    .sort((p, q) => (g.vertical ? p.px - q.px : p.py - q.py));
}


// ---------------------------------------------------------------- texture

interface Texture {
  /** Pixels read. */
  n: number;
  /** Texture pixels among them. */
  ink: number;
  /** Median density of the blocks the inside is cut into. */
  density: number;
  /** Blocks read (≥ 8 px each). */
  blocks: number;
  /** Texture all over: at least 3 blocks, ¾ of them marked — a pattern, not a curve crossing. */
  patterned: boolean;
  /** Share of the blocks that are marked. */
  marked: number;
  /** For each of DIRS: how often the next pixel that way is texture too (a hatch's angle). */
  dirs: number[];
  /** Mean colour of the rest (the face of an outlined bar), or null. */
  face: RGB | null;
  /** Outlined bars only: hatched with rules along the axes (cells joined, `outlinedReadings`). */
  ruled?: boolean;
}

/** Texture is read in blocks of about this size, px (a hatch's lines are closer than twice it). */
const TEXTURE_BLOCK = 16;
/** A short bar over a fill this densely marked all over is hatched (a curve crossing it is thinner). */
const HATCH_MIN = 0.1;
/** A block with this much texture is marked. */
const PATTERN_MIN = 0.03;
/** Faces further apart than this are different series. */
const FACE_TOL = 45;

/** The texture inside the rectangle x0…x1 × y0…y1, 2 px in from its sides (an outline's ink stays out). */
function textureIn(tex: Uint8Array, img: Img, x0: number, y0: number, x1: number, y1: number, face: boolean, keep?: (k: number) => boolean): Texture {
  const w = img.width;
  const ax = Math.max(0, Math.ceil(x0) + 2);
  const bx = Math.min(w - 1, Math.floor(x1) - 2);
  const ay = Math.max(0, Math.ceil(y0) + 2);
  const by = Math.min(img.height - 1, Math.floor(y1) - 2);
  let n = 0;
  let ink = 0;
  const pairs = DIRS.map(() => 0);
  // Density per block of ~TEXTURE_BLOCK px: a curve or a line crossing a bar marks a few blocks, a
  // pattern all of them — the median block is the pattern's.
  const nx = Math.max(1, Math.min(8, Math.round((bx - ax + 1) / TEXTURE_BLOCK)));
  const ny = Math.max(1, Math.min(8, Math.round((by - ay + 1) / TEXTURE_BLOCK)));
  const blockN = new Array<number>(nx * ny).fill(0);
  const blockInk = new Array<number>(nx * ny).fill(0);
  const sum = [0, 0, 0];
  let fn = 0;
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      const k = y * w + x;
      if (keep && !keep(k)) continue;
      n++;
      const b = Math.min(ny - 1, Math.floor(((y - ay) * ny) / (by - ay + 1))) * nx + Math.min(nx - 1, Math.floor(((x - ax) * nx) / (bx - ax + 1)));
      blockN[b]!++;
      if (tex[k]) {
        blockInk[b]!++;
        ink++;
        for (let i = 0; i < DIRS.length; i++) {
          const qx = x + DIRS[i]![0];
          const qy = y + DIRS[i]![1];
          if (qx >= ax && qx <= bx && qy >= ay && qy <= by && tex[qy * w + qx]) pairs[i]!++;
        }
      } else if (face) {
        const c = rgbAt(img, k);
        sum[0]! += c[0];
        sum[1]! += c[1];
        sum[2]! += c[2];
        fn++;
      }
    }
  }
  const dens = blockN.map((c, b) => (c >= 8 ? blockInk[b]! / c : -1)).filter((d) => d >= 0);
  return {
    n,
    ink,
    density: dens.length ? median(dens) : n ? ink / n : 0,
    blocks: dens.length,
    patterned: dens.length >= 3 && dens.filter((d) => d >= PATTERN_MIN).length >= 0.75 * dens.length,
    marked: dens.length ? dens.filter((d) => d >= PATTERN_MIN).length / dens.length : 0,
    dirs: pairs.map((p) => (ink ? p / ink : 0)),
    face: face && fn ? [sum[0]! / fn, sum[1]! / fn, sum[2]! / fn] : null,
  };
}

/** A short bar marked all over with texture that runs on diagonally (hatching or dots). */
const hatchLike = (t: Texture): boolean => t.marked === 1 && t.density >= HATCH_MIN && Math.max(t.dirs[2]!, t.dirs[3]!) >= 0.5;

/**
 * Whether two bars are drawn alike: face, and whether, how dense and at what angle they are
 * patterned. A bar too short to read a pattern from (under 3 blocks) only differs grossly; one
 * with texture in a few places only (a curve or a line crossing it) is plain.
 */
function sameTexture(a: Texture, b: Texture): boolean {
  if (a.face && b.face && dist(a.face, b.face) > FACE_TOL) return false;
  if (!!a.ruled !== !!b.ruled) return false;
  const dd = Math.abs(a.density - b.density);
  if (Math.min(a.n, b.n) < TEXTURE_MIN) return dd <= 0.3;
  if (Math.min(a.blocks, b.blocks) < 3) {
    // Too short to read a pattern from blocks. Over a fill a curve crossing it looks like texture:
    // it is hatched only when all of it is marked and the marks run on diagonally (hatching, dots
    // — not a shallow curve). On an outlined bar texture is the series' own ink: read as it is.
    if (!a.face) {
      const ta = a.patterned || hatchLike(a);
      if (ta !== (b.patterned || hatchLike(b))) return false;
      if (!ta) return true;
    }
  } else {
    if (a.patterned !== b.patterned) return false;
    if (!a.patterned) return true;
  }
  const hi = Math.max(a.density, b.density);
  if (dd > 0.02 + 0.3 * hi) return false;
  if (hi < 0.04 || Math.min(a.ink, b.ink) < 12) return true;
  return a.dirs.every((v, i) => Math.abs(v - b.dirs[i]!) <= 0.3);
}

// ---------------------------------------------------------------- outlined bars

interface Cell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** Runs into the region's edge, or too large: the plot's open background. */
  open: boolean;
  /** Reaches from one edge of the region to the opposite one along a third (background between the last bar and a frame). */
  across: boolean;
}

/** A cell that could be a bar's inside: closed, and not reaching across the plot. */
const closed = (c: Cell): boolean => !c.open && !c.across && c.x1 - c.x0 + 1 >= MIN_SIDE - 1 && c.y1 - c.y0 + 1 >= MIN_SIDE - 1;

interface Reading {
  masks: Masks;
  seeds: { x: number; y: number }[];
}

/**
 * Bars drawn as an outline around a face: white (an outlined bar) or hatched / dotted in the
 * outline's colour (the click is on the series' thin ink: `ink` is the series' colour), or a fill
 * of another colour (the click is in the fill: `ink` is the outline's colour, and `blocked` —
 * neither fill nor outline: the background, other colours — closes a cell even where a thin
 * outline blends into the background). Walls: `ink` on long straight runs (outlines, stems, caps,
 * rulings), thickened by a pixel so an anti-aliased corner does not leak. The insides of the walls
 * are cells; a bar is a rectangular cell (no other cell in its bounding box), and its series is
 * every rectangular cell drawn alike (`sameTexture`: face, density and angle of the hatching).
 * Those cells, as their whole boxes inside the walls, become the "fill" of the bars; the walls are
 * other ink around them (an outline: the value is at its middle); cells drawn otherwise are
 * neither fill nor background (what a stacked segment sits on); a run never bridges a wall from
 * one cell into another. The filled-bar reading then runs on that. One reading per cell next to
 * the click (a click on a wall between two bars could mean either). Hatching ruled along the axes
 * ("++", "--", "||") cuts a bar into a grid of small empty cells: lined-up neighbours join into one
 * ruled inside, reaching out past the last rule to the outline. Not a bar's: a wall clicked
 * that is not the cell's own side (a gridline, a flat stretch of a curve), a hatch click in a cell
 * not patterned all over (a dash or a curve crossing an outlined bar), cells all of one length (a
 * ruled grid).
 */
function outlinedReadings(input: BarsInput, ink: Uint8Array, blocked: Uint8Array | null): Reading[] {
  const { alpha, other, region, seed, img } = input;
  const w = region.width;
  const n = alpha.length;
  const wall = new Uint8Array(n);
  longRuns(ink, region, wall);
  const thick = new Uint8Array(wall);
  for (let y = region.y0; y <= region.y1; y++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const k = y * w + x;
      if (wall[k]) continue;
      if ((x > region.x0 && wall[k - 1]) || (x < region.x1 && wall[k + 1]) || (y > region.y0 && wall[k - w]) || (y < region.y1 && wall[k + w])) thick[k] = 1;
    }
  }
  const free = (k: number) => region.mask[k] === 1 && !thick[k] && !blocked?.[k];

  // The cells next to the click: its own, or those on either side of the wall it is on (the
  // wall pixel nearest the click, and the straight run through it).
  const sk = seed.y * w + seed.x;
  const starts: number[] = [];
  let run: { horizontal: boolean; a: number; b: number } | null = null;
  if (free(sk)) starts.push(sk);
  else {
    let wx = -1;
    let wy = -1;
    for (let r = 0; r <= 2 && wx < 0; r++) {
      for (let dy = -r; dy <= r && wx < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = seed.x + dx;
          const y = seed.y + dy;
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && wall[y * w + x]) {
            wx = x;
            wy = y;
            break;
          }
        }
      }
    }
    if (wx < 0) return [];
    const wk = wy * w + wx;
    let l = wx;
    while (l - 1 >= region.x0 && wall[wk - (wx - l) - 1]) l--;
    let r = wx;
    while (r + 1 <= region.x1 && wall[wk + (r - wx) + 1]) r++;
    let t = wy;
    while (t - 1 >= region.y0 && wall[(t - 1) * w + wx]) t--;
    let b = wy;
    while (b + 1 <= region.y1 && wall[(b + 1) * w + wx]) b++;
    const horizontal = r - l >= b - t;
    run = horizontal ? { horizontal, a: l, b: r } : { horizontal, a: t, b };
    for (const d of [-1, 1]) {
      for (let s = 1; s <= 8; s++) {
        const x = horizontal ? wx : wx + d * s;
        const y = horizontal ? wy + d * s : wy;
        if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) break;
        if (free(y * w + x)) {
          starts.push(y * w + x);
          break;
        }
      }
    }
  }
  if (!starts.length) return [];

  const label = new Int32Array(n);
  const cells: Cell[] = [];
  const stack: number[] = [];
  const cap = 0.25 * (region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1);
  /** Labels the cell at k0; one larger than `cap` pixels is open (the background). */
  const flood = (k0: number): void => {
    const id = cells.length + 1;
    const c: Cell = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1, y1: -1, area: 0, open: false, across: false };
    cells.push(c);
    label[k0] = id;
    stack.length = 0;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % w;
      const y = (k - x) / w;
      c.area++;
      c.x0 = Math.min(c.x0, x);
      c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y);
      c.y1 = Math.max(c.y1, y);
      if (x <= region.x0 || x >= region.x1 || y <= region.y0 || y >= region.y1) c.open = true;
      if (c.area > cap) c.open = true;
      const tall = c.y0 <= region.y0 + EDGE_NEAR && c.y1 >= region.y1 - EDGE_NEAR;
      const wide = c.x0 <= region.x0 + EDGE_NEAR && c.x1 >= region.x1 - EDGE_NEAR;
      const side = (lo: number, hi: number, r0: number, r1: number) => lo <= r0 + EDGE_NEAR || hi >= r1 - EDGE_NEAR;
      if ((tall && side(c.x0, c.x1, region.x0, region.x1)) || (wide && side(c.y0, c.y1, region.y0, region.y1))) c.across = true;
      if (x > region.x0 && !label[k - 1] && free(k - 1)) {
        label[k - 1] = id;
        stack.push(k - 1);
      }
      if (x < region.x1 && !label[k + 1] && free(k + 1)) {
        label[k + 1] = id;
        stack.push(k + 1);
      }
      if (y > region.y0 && !label[k - w] && free(k - w)) {
        label[k - w] = id;
        stack.push(k - w);
      }
      if (y < region.y1 && !label[k + w] && free(k + w)) {
        label[k + w] = id;
        stack.push(k + w);
      }
    }
  };
  for (const k of starts) if (!label[k]) flood(k);
  if (!starts.some((k) => closed(cells[label[k]! - 1]!))) return [];
  // Every other cell of the plot.
  for (let y = region.y0; y <= region.y1; y++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const k = y * w + x;
      if (!label[k] && free(k)) flood(k);
    }
  }
  // The ring the thickening took from a cell goes back to it.
  const grown = new Int32Array(label);
  for (let y = region.y0 + 1; y < region.y1; y++) {
    for (let x = region.x0 + 1; x < region.x1; x++) {
      const k = y * w + x;
      if (!thick[k] || wall[k] || !region.mask[k]) continue;
      const l = label[k - 1] || label[k + 1] || label[k - w] || label[k + w] || 0;
      if (l) grown[k] = l;
    }
  }
  const texMask = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (ink[k] && !wall[k]) texMask[k] = 1;
  const textures = new Map<number, Texture>();
  const ruled = new Set<number>();
  const textureOf = (id: number): Texture => {
    let t = textures.get(id);
    if (!t) {
      const c = cells[id - 1]!;
      t = textureIn(texMask, img, c.x0 - 1, c.y0 - 1, c.x1 + 1, c.y1 + 1, true, (k) => grown[k] === id);
      if (ruled.has(id)) t.ruled = true;
      textures.set(id, t);
    }
    return t;
  };

  // Hatching ruled along the axes ("++", "--", "||") cuts a bar into a grid of empty cells, each
  // walled like a bar. Neighbours across one wall that line up exactly (the same rows, or the same
  // columns), are at most RULED_MAX across that way and empty, join; four or more joined are one
  // bar's inside, ruled (`Texture.ruled`: only like ruled bars are its series).
  const parent = cells.map((_, i) => i + 1);
  const find = (i: number): number => {
    while (parent[i - 1] !== i) i = parent[i - 1]!;
    return i;
  };
  const empty = (id: number) => textureOf(id).density < PATTERN_MIN;
  cells.forEach((c, i) => {
    if (!closed(c) || !empty(i + 1)) return;
    for (const across of [true, false]) {
      if ((across ? c.x1 - c.x0 : c.y1 - c.y0) + 1 > RULED_MAX) continue;
      // Step over the wall from the middle of the cell's far side.
      const mx = across ? c.x1 : Math.round((c.x0 + c.x1) / 2);
      const my = across ? Math.round((c.y0 + c.y1) / 2) : c.y1;
      for (let t = 1; t <= 6; t++) {
        const x = across ? mx + t : mx;
        const y = across ? my : my + t;
        if (x > region.x1 || y > region.y1) break;
        const l = label[y * w + x]!;
        if (!l) continue;
        const o = cells[l - 1]!;
        const lined = across ? Math.abs(o.y0 - c.y0) <= 1 && Math.abs(o.y1 - c.y1) <= 1 : Math.abs(o.x0 - c.x0) <= 1 && Math.abs(o.x1 - c.x1) <= 1;
        if (l !== i + 1 && closed(o) && lined && (across ? o.x1 - o.x0 : o.y1 - o.y0) + 1 <= RULED_MAX && empty(l)) parent[find(l) - 1] = find(i + 1);
        break;
      }
    }
  });
  const members = new Map<number, number[]>();
  for (let id = 1; id <= cells.length; id++) {
    const r = find(id);
    const list = members.get(r);
    if (list) list.push(id);
    else members.set(r, [id]);
  }
  for (const [root, ids] of members) {
    if (ids.length < 4) continue;
    const c = cells[root - 1]!;
    for (const id of ids) {
      if (id === root) continue;
      const o = cells[id - 1]!;
      c.x0 = Math.min(c.x0, o.x0);
      c.x1 = Math.max(c.x1, o.x1);
      c.y0 = Math.min(c.y0, o.y0);
      c.y1 = Math.max(c.y1, o.y1);
      c.area += o.area;
      o.open = true;
    }
    // The rules between them are inside the bar.
    const inside = new Set(ids);
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const k = y * w + x;
        if (inside.has(label[k]!)) label[k] = root;
        if (inside.has(grown[k]!)) grown[k] = root;
        if (!label[k] && region.mask[k] && !blocked?.[k]) c.area++;
      }
    }
    // Partial cells next to the outline may be too thin to be cells: each side moves out to just
    // inside the outermost wall within reach (the outline, past a rule and a sliver).
    const tiny = (l: number) => l !== 0 && (l === root || cells[l - 1]!.area < 4 * RULED_MAX);
    const sides: [number, number, number, number][] = [
      [0, -1, c.x0, c.y0],
      [0, 1, c.x0, c.y1],
      [-1, 0, c.x0, c.y0],
      [1, 0, c.x1, c.y0],
    ];
    const moves = sides.map(([dx, dy, ex, ey]) => {
      const found: number[] = [];
      for (let f = 0.25; f <= 0.76; f += 0.125) {
        const x0 = dx ? ex : Math.round(c.x0 + f * (c.x1 - c.x0));
        const y0 = dy ? ey : Math.round(c.y0 + f * (c.y1 - c.y0));
        let outer = 0;
        for (let t = 1; t <= 10; t++) {
          const x = x0 + dx * t;
          const y = y0 + dy * t;
          if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) break;
          const k = y * w + x;
          if (wall[k]) {
            if (!wall[k - dx - dy * w]) outer = t;
          } else if (!thick[k] && !tiny(label[k]!)) break;
        }
        found.push(outer > 2 ? outer - 2 : 0);
      }
      return median(found);
    });
    c.y0 -= moves[0]!;
    c.y1 += moves[1]!;
    c.x0 -= moves[2]!;
    c.x1 += moves[3]!;
    ruled.add(root);
    textures.delete(root);
  }
  // A rectangle: its bounding box holds (next to) no other cell — walls inside it, an error bar's
  // stem and caps, are part of the bar; a round hole's box takes in what lies around the ring.
  const rect = new Map<number, boolean>();
  const rectangular = (id: number): boolean => {
    let r = rect.get(id);
    if (r === undefined) {
      const c = cells[id - 1]!;
      const area = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
      let foreign = 0;
      if (closed(c) && c.area >= 0.5 * area) {
        for (let y = c.y0; y <= c.y1; y++) {
          for (let x = c.x0; x <= c.x1; x++) {
            const l = label[y * w + x]!;
            if (l && l !== id) foreign++;
          }
        }
      }
      r = closed(c) && c.area >= 0.5 * area && foreign <= FOREIGN * area;
      rect.set(id, r);
    }
    return r;
  };
  // A click on a wall must be on the cell's own side: the run through it covers most of that side
  // and does not go on past both its ends (a gridline, a frame line, a flat stretch of a curve
  // over a bar is no bar's outline).
  const ownSide = (c: Cell): boolean => {
    if (!run) return true;
    const [c0, c1] = run.horizontal ? [c.x0, c.x1] : [c.y0, c.y1];
    const side = c1 - c0 + 1;
    const slack = Math.max(6, 0.15 * side);
    const overlap = Math.min(run.b, c1) - Math.max(run.a, c0) + 1;
    return overlap >= 0.6 * side && !(run.a < c0 - slack && run.b > c1 + slack);
  };
  const seedCells: number[] = [];
  for (const k of starts) {
    const id = find(label[k]!);
    if (rectangular(id) && ownSide(cells[id - 1]!) && !seedCells.includes(id)) seedCells.push(id);
  }
  if (!seedCells.length) return [];

  // A click inside a cell on thin ink of the series (not in a fill) is on its hatching: the cell
  // must be patterned all over (a dash or a curve crossing an outlined bar is not its texture).
  const hatchClick = !run && !blocked;
  return seedCells.filter((id) => !hatchClick || textureOf(id).patterned).map((id) => {
    const mine = textureOf(id);
    const match = new Set<number>();
    for (let id2 = 1; id2 <= cells.length; id2++) if (rectangular(id2) && sameTexture(mine, textureOf(id2))) match.add(id2);
    // A matched cell is its whole bounding box — the rectangle inside the walls (a stem or a cap
    // reaching into it is inside the bar) — so every column of a bar ends where its walls begin;
    // the walls and their thickening around it are the outline (the value is at its middle).
    const on = new Uint8Array(n);
    const occ = new Uint8Array(n);
    const a = new Float32Array(n).fill(-1);
    const box = new Int32Array(n);
    // The box takes back the pixel the thickening took from it on each side: what is left around
    // it is the wall itself.
    cells.forEach((c, i) => {
      if (!rectangular(i + 1)) return;
      const mine = match.has(i + 1);
      for (let y = Math.max(region.y0, c.y0 - 1); y <= Math.min(region.y1, c.y1 + 1); y++) {
        for (let x = Math.max(region.x0, c.x0 - 1); x <= Math.min(region.x1, c.x1 + 1); x++) {
          const k = y * w + x;
          const edge = y < c.y0 || y > c.y1 || x < c.x0 || x > c.x1;
          if (edge && (wall[k] || box[k])) continue;
          box[k] = i + 1;
          on[k] = mine ? 1 : 0;
          a[k] = mine ? 1 : 0.3;
        }
      }
    });
    for (let y = region.y0; y <= region.y1; y++) {
      for (let x = region.x0; x <= region.x1; x++) {
        const k = y * w + x;
        if (!region.mask[k] || box[k]) continue;
        // The wall's ink is the outline; the thickening's pixel beyond it is not (a faint
        // anti-aliased edge: the outline's middle is the middle of its ink).
        if (wall[k] || ink[k] || other[k]) {
          occ[k] = 1;
          a[k] = 1;
        } else a[k] = 0;
      }
    }
    // Where the reading starts: the middle of the clicked cell.
    const c = cells[id - 1]!;
    const seeds = [{ x: Math.round((c.x0 + c.x1) / 2), y: Math.round((c.y0 + c.y1) / 2) }];
    return { masks: { on, occ, alpha: a, tex: texMask, face: true, cell: box }, seeds };
  });
}

// ---------------------------------------------------------------- finding

/**
 * Bars: the value-end points of every bar like the one under the seed, or null when the seed is
 * not on a bar (the caller goes on as before). A click in a solid block of the series' colour reads
 * filled bars (texture over the fill is part of the fill, and tells series of one fill colour
 * apart); a click on a thin stroke reads outlined bars (`outlinedReadings`).
 */
export function findBars(input: BarsInput): TracedPoint[] | null {
  const first = barsAt(input);
  if (!first || !first.clipped || !input.region.quad) return first?.points ?? null;
  // The plot box cut the bars (a value end on its edge, or the series' ink going on past an edge
  // a bar ends on — a box stopping at the last gridline): bars do not leave the plot area, the box
  // is wrong. Look again over the whole image.
  const { img, model } = input;
  const n = img.width * img.height;
  const alpha = new Float32Array(n);
  const other = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const c = rgbAt(img, k);
    const a = coverage(model, c);
    alpha[k] = a;
    if (a < 0.25 && dist(c, model.bg) >= INK_MIN) other[k] = 1;
  }
  const again = barsAt({ ...input, alpha, other, region: makeRegion(img.width, img.height, null) });
  return again && again.points.length >= first.points.length ? again.points : first.points;
}

type Hit = { points: TracedPoint[]; clipped: boolean };

function barsAt(input: BarsInput): Hit | null {
  const { alpha, region, img } = input;
  let ink: Uint8Array;
  let blocked: Uint8Array | null = null;
  if (inBlock(input)) {
    const filled = barsIn(input, masks(input), input.seed, input.lone);
    if (filled) return filled;
    // A fill inside an outline of another colour (hatched in it, maybe): the outline's walls.
    const edge = edgeColour(input);
    if (!edge) return null;
    // The outline's ink: at least WALL_ALPHA of the way from the fill to the outline's colour (a
    // thin outline in a JPEG never reaches its colour), and not background.
    const fill = input.model.ink;
    const d: RGB = [edge[0] - fill[0], edge[1] - fill[1], edge[2] - fill[2]];
    const len2 = Math.max(1e-9, d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
    ink = new Uint8Array(alpha.length);
    blocked = new Uint8Array(alpha.length);
    for (let y = region.y0; y <= region.y1; y++) {
      for (let x = region.x0; x <= region.x1; x++) {
        const k = y * region.width + x;
        if (!region.mask[k]) continue;
        const c = rgbAt(img, k);
        const t = ((c[0] - fill[0]) * d[0] + (c[1] - fill[1]) * d[1] + (c[2] - fill[2]) * d[2]) / len2;
        if (t >= WALL_ALPHA && dist(c, edge) < dist(c, input.model.bg)) ink[k] = 1;
        // Neither the fill nor the outline's ink: never inside a bar (the background, other
        // colours) — a thin outline blended into the background closes the cell all the same.
        else if (dist(c, fill) >= INK_MIN) blocked[k] = 1;
      }
    }
  } else {
    ink = new Uint8Array(alpha.length);
    for (let k = 0; k < alpha.length; k++) if (region.mask[k] && alpha[k]! >= WALL_ALPHA) ink[k] = 1;
  }
  let best: Hit | null = null;
  for (const r of outlinedReadings(input, ink, blocked)) {
    for (const s of r.seeds) {
      const hit = barsIn(input, r.masks, s, false);
      if (!hit) continue;
      if (!best || hit.points.length > best.points.length) best = hit;
      break;
    }
  }
  return best;
}

/**
 * The colour of the outline around the fill the seed is in: walking out of the fill four ways, the
 * first ink that is neither the fill nor the background, alike at least three ways. Null when
 * the fill has no outline (it ends on the background or on fills of other colours).
 */
function edgeColour({ alpha, region, seed, img, model }: BarsInput): RGB | null {
  const w = region.width;
  const found: RGB[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    let x = seed.x;
    let y = seed.y;
    // Out of the fill: the first pixel that is not its colour (black continues a grey's colour
    // line, so coverage alone would walk on through a black outline).
    while (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && alpha[y * w + x]! >= ON_ALPHA && dist(rgbAt(img, y * w + x), model.ink) < INK_MIN) {
      x += dx;
      y += dy;
    }
    // The darkest (furthest from the background) of the next 4 px.
    let best: RGB | null = null;
    for (let t = 0; t < 4; t++, x += dx, y += dy) {
      if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) break;
      const c = rgbAt(img, y * w + x);
      if (dist(c, model.bg) >= INK_MIN && dist(c, model.ink) >= INK_MIN && (!best || dist(c, model.bg) > dist(best, model.bg))) best = c;
    }
    if (best) found.push(best);
  }
  // The strongest of them is the outline's colour (the others may be its anti-aliased side or a
  // thin hatch line of it), when at least three are nearer to it than to the background.
  const edge = found.reduce<RGB | null>((b, c) => (!b || dist(c, model.bg) > dist(b, model.bg) ? c : b), null);
  if (!edge) return null;
  return found.filter((o) => dist(o, edge) < dist(o, model.bg)).length >= 3 ? edge : null;
}

/** Whether the seed lies in a solid SEED_BLOCK × SEED_BLOCK block of the series' ink (a bar's fill; never a thin line). */
function inBlock({ alpha, region, seed }: BarsInput): boolean {
  const w = region.width;
  const on = (x: number, y: number) => x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && alpha[y * w + x]! >= ON_ALPHA;
  for (let oy = 1 - SEED_BLOCK; oy <= 0; oy++) {
    for (let ox = 1 - SEED_BLOCK; ox <= 0; ox++) {
      let full = true;
      for (let dy = 0; dy < SEED_BLOCK && full; dy++) for (let dx = 0; dx < SEED_BLOCK && full; dx++) full = on(seed.x + ox + dx, seed.y + oy + dy);
      if (full) return true;
    }
  }
  return false;
}

function barsIn(input: BarsInput, m: Masks, seed: { x: number; y: number }, lone: boolean): Hit | null {
  const { region, img, model } = input;
  if (!m.on[seed.y * region.width + seed.x]) return null;
  let best: { g: Grid; f: Found } | null = null;
  for (const vertical of [true, false]) {
    const g = gridOf(input, m, vertical);
    let f = family(g, segmentsOf(g), vertical ? seed.x : seed.y, vertical ? seed.y : seed.x, lone, input.markerMax);
    if (f && !m.face) f = alike(g, f, m, img, vertical ? seed.x : seed.y, vertical ? seed.y : seed.x);
    if (f && m.face) {
      // Outlined cells all of one length are a grid ruled in the series' colour, not bars.
      const lengths = f.bars.map((b) => b.seg.hi - b.seg.lo);
      if (Math.max(...lengths) - Math.min(...lengths) <= 2 * ALIGN) f = null;
    }
    // The orientation with more rectangles (touching bars of one height count once).
    const count = (x: Found) => new Set(x.bars.map((b) => b.seg)).size;
    if (f && (!best || count(f) > count(best.f))) best = { g, f };
  }
  if (!best) return null;
  const points = pointsOf(best.g, best.f);
  if (!points.length) return null;
  const { g } = best;
  const atEdge = (v: number) => v <= g.v0 + 1 || v >= g.v1 - 1;
  // The series' ink just past the box's edge, in the bar's middle column.
  const beyond = (centre: number, v: number): boolean => {
    const out = v <= g.v0 + 1 ? Math.round(g.v0) - 2 : Math.round(g.v1) + 2;
    const x = g.vertical ? Math.round(centre) : out;
    const y = g.vertical ? out : Math.round(centre);
    return x >= 0 && y >= 0 && x < img.width && y < img.height && coverage(model, rgbAt(img, y * img.width + x)) >= ON_ALPHA;
  };
  const clipped =
    points.some((p) => atEdge(g.vertical ? p.py : p.px)) ||
    best.f.bars.some((b) => [b.seg.lo, b.seg.hi].some((v) => atEdge(v) && beyond(b.centre, v)));
  return { points, clipped };
}

/** The bars of a filled family drawn like the clicked one (the same hatching over the same fill colour). */
function alike(g: Grid, f: Found, m: Masks, img: Img, seedU: number, seedV: number): Found | null {
  const per = new Map<Segment, number>();
  for (const b of f.bars) per.set(b.seg, (per.get(b.seg) ?? 0) + 1);
  const textures = f.bars.map((b) => {
    const half = widthOf(b.seg) / per.get(b.seg)! / 2;
    const u0 = b.centre - half;
    const u1 = b.centre + half;
    return g.vertical ? textureIn(m.tex, img, u0, b.seg.lo, u1, b.seg.hi, false) : textureIn(m.tex, img, b.seg.lo, u0, b.seg.hi, u1, false);
  });
  const off = (b: Bar) => Math.abs(b.centre - seedU) + (seedV < b.seg.lo - 1 || seedV > b.seg.hi + 1 ? 1e6 : 0);
  let mine = 0;
  f.bars.forEach((b, i) => {
    if (off(b) < off(f.bars[mine]!)) mine = i;
  });
  const keep = f.bars.map((_, i) => sameTexture(textures[mine]!, textures[i]!));
  const bars = f.bars.filter((_, i) => keep[i]);
  if (!bars.length) return null;
  return { bars, valueHigh: f.valueHigh.filter((_, i) => keep[i]) };
}
