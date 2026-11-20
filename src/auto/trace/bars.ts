/**
 * Bars: one click on a bar → a point at the value end of every bar of that series, at the middle
 * of the bar's width ("Find points" for bar charts and histograms; docs/SPEC.md → Auto-trace →
 * Bars). Pure TS, no DOM.
 *
 * Where the point goes:
 * - a bar standing on the baseline: its top edge (a horizontal bar: its right end);
 * - a bar hanging below the baseline (a negative value): its bottom edge (horizontal: left end);
 * - a stacked segment: its edge away from the baseline — the top edge when nothing says otherwise;
 * - a bar with an error bar: still the bar's own end, never the cap;
 * - an outlined bar: the middle of the outline's stroke (where the value is drawn).
 *
 * Filled bars (`filledBars`). The series' ink is cut into runs along the value axis, column by
 * column for vertical bars (row by row for horizontal ones; both are tried and the larger family
 * wins). Thin ink of another colour inside a run — hatching, an error bar's cap, a curve drawn
 * over the bars — is bridged. Runs of neighbouring columns that overlap form a chain, and a chain
 * is cut into segments whose two ends stay put: rectangles. A column with more ink beyond its end
 * than the chain's usual outline (an error bar's stem, a curve over the bar's top) says nothing
 * about that end and never cuts a segment. Two segments with the same ends on either side of a
 * thin line of other ink (a mean line drawn through a bar) are one bar when only together they
 * have a bar's width. The unit is the commonest width among the segments that share an end with
 * the clicked one: bars are the segments one unit wide, and in a chain of touching bars a segment
 * n units wide is n bars of equal height (a histogram without outlines). They are bars only as a
 * family:
 *
 * - the baseline is the coordinate most of them end on; a bar ending there has its value at the
 *   other end, and a bar away from it is a stacked segment when ink runs from it to the baseline
 *   (the segments under it; a legend swatch floats). When the bars share their far end instead
 *   and stand on other ink (the top layer of a 100 % stack), or share no end (an upper layer),
 *   each must sit on ink and has its value at the far end;
 * - bars whose lengths are all alike and small are markers in a row, not bars; a segment with
 *   more of the series' ink attached to its side that is not a bar (a plateau of a thick step
 *   curve between its risers) is not one either.
 *
 * Only tried when the click is inside a solid SEED_BLOCK-square of the series' ink (a bar's fill).
 * A value end on the plot box's edge (the box cut the bars) → looked at again over the whole image.
 *
 * Not found (docs/SPEC.md → Known failures): bars without fill (their outline is a thin stroke,
 * traced as a line), bars told apart only by their hatching, bars of height zero.
 */

import { coverage, dist, greySeries, INK_MIN, maxAlpha, ON_ALPHA, rgbAt, type ColorModel, type Img } from './color.ts';
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
/** Marker-sized bars are bars only as a family of at least this many. */
const MIN_SMALL_FAMILY = 4;
/** Bars all of one length up to this are markers in a row. */
const UNIFORM_MAX = 30;

export interface BarsInput {
  /** The image, for a second look beyond the region (see `filledBars`). */
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
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN;
};

function masks(input: BarsInput): { on: Uint8Array; occ: Uint8Array } {
  const { alpha, other, model } = input;
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
  return { on, occ };
}

function gridOf(input: BarsInput, m: { on: Uint8Array; occ: Uint8Array }, vertical: boolean): Grid {
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
    alpha: input.alpha,
    mask: r.mask,
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
      if (e <= g.v1 && e > b + 1 && e - b - 1 <= BRIDGE && g.on[at(g, u, e)]) {
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

  // The baseline: the coordinate most bars end on.
  const ends = bars.map((b) => b.seg);
  let z = Number.NaN;
  let zCount = 0;
  for (const c of ends.flatMap((s) => [s.lo, s.hi])) {
    const n = ends.filter((s) => Math.abs(s.lo - c) <= ALIGN || Math.abs(s.hi - c) <= ALIGN).length;
    if (n > zCount) {
      zCount = n;
      z = c;
    }
  }
  let based = zCount >= 2 && zCount >= 0.5 * bars.length;
  if (based) {
    // A shared far end (top; right for horizontal bars) that is free while the other ends sit on
    // ink is the top of a full stack (a 100 % chart), not a baseline.
    const onBase = ends.filter((s) => Math.abs(s.lo - z) <= ALIGN || Math.abs(s.hi - z) <= ALIGN);
    const far = onBase.filter((s) => (g.vertical ? Math.abs(s.lo - z) <= ALIGN && !s.loAttached && s.hiAttached : Math.abs(s.hi - z) <= ALIGN && !s.hiAttached && s.loAttached));
    if (far.length > 0.5 * onBase.length) based = false;
  }
  // Whether ink (of any colour) runs from the bar's end at `from` to the baseline, but for seams.
  const stacked = (b: Bar, from: number): boolean => {
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
      } else if (g.vertical ? s.hiAttached : s.loAttached) {
        // No baseline: stacked segments, sitting on what is below (to the left of) them.
        out.push(b);
        valueHigh.push(!g.vertical);
      } else if (g.vertical ? s.loAttached : s.hiAttached) {
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

/**
 * Filled bars: the value-end points of every bar like the one under the seed, or null when the
 * seed is not on a bar (the caller goes on as before).
 */
export function filledBars(input: BarsInput): TracedPoint[] | null {
  if (!inBlock(input)) return null;
  const first = barsIn(input);
  if (!first || !first.clipped || !input.region.quad) return first?.points ?? null;
  // A bar's value end on the edge of the plot box: bars do not leave the plot area, the box is
  // wrong (or the image is a crop). Look again over the whole image.
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
  const again = barsIn({ ...input, alpha, other, region: makeRegion(img.width, img.height, null) });
  return again && again.points.length >= first.points.length ? again.points : first.points;
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

function barsIn(input: BarsInput): { points: TracedPoint[]; clipped: boolean } | null {
  const m = masks(input);
  const { seed, region } = input;
  if (!m.on[seed.y * region.width + seed.x]) return null;
  let best: { g: Grid; f: Found } | null = null;
  for (const vertical of [true, false]) {
    const g = gridOf(input, m, vertical);
    const f = family(g, segmentsOf(g), vertical ? seed.x : seed.y, vertical ? seed.y : seed.x, input.lone, input.markerMax);
    // The orientation with more rectangles (touching bars of one height count once).
    const count = (x: Found) => new Set(x.bars.map((b) => b.seg)).size;
    if (f && (!best || count(f) > count(best.f))) best = { g, f };
  }
  if (!best) return null;
  const points = pointsOf(best.g, best.f);
  if (!points.length) return null;
  const { g } = best;
  const clipped = points.some((p) => {
    const v = g.vertical ? p.py : p.px;
    return v <= g.v0 + 1 || v >= g.v1 - 1;
  });
  return { points, clipped };
}
