/**
 * Line style of the clicked series (solid, dashed, dotted, dash-dot) and the style constraint
 * that keeps a trace on its own series when another series has the same colour.
 *
 * Classification (`classifyStyle`): the blobs of "on" pixels around the seed are chained along
 * the stroke — from the seed's blob to the nearest pattern-sized blob, then onwards with turns of
 * up to ~100° (a dashed step curve is dashed along its verticals too). Gaps are measured pixel to
 * pixel; a gap mostly over ink of another colour is an occlusion (a marker on a solid line), not
 * part of a pattern, and ends the chain (a thin gridline across a gap does not); gaps under 1.5 px
 * join JPEG fragments of one stroke. The stretch around the seed whose gaps agree with the
 * typical one (≥ 5 pieces, evenly gapped) is a pattern: pieces of one length are dots when about
 * one line width long, else dashes; two lengths alternate as dash-dot (`patternOf`). Too few pieces
 * in a row (a short step, a dash merged into another series) → the region's pattern chain the
 * seed belongs to. Gaps too wide for a line pattern (a row of evenly spaced markers) are not one.
 * Otherwise the seed's own blob running on unbroken for a long way → solid; else 'unknown' (no
 * constraint). Rulings taken out of the coverage map (rulings.ts) count as crossings; a gap that is
 * nothing but a ruling joins the two fragments of one stroke it cut (gap 0, measured as one piece).
 *
 * Constraint (`applyStyle`): ink of the series' colour that does not fit the seed's style is
 * treated like ink of another colour — removed from the coverage map and marked as an occluder —
 * so the walker never follows it, and bridges it as a hidden stretch where the series runs under
 * it. For a solid seed that is every blob in a regular pattern chain anywhere in the region (a
 * dashed or dotted series of the same colour); for a patterned seed every blob much longer than
 * its longest dash (a solid series, gridlines). A patterned seed's own gaps are filled in (each
 * piece joined to its neighbours along chains with its gap and piece size, and across the dropped
 * ink where it crosses the other series), so the walker follows it round step corners and along
 * dashed verticals like a solid line; `unfill` then undoes the fill and keeps only real ink.
 */

import { ON_ALPHA } from './color.ts';
import { columnRuns, runCentre, type ColumnEntry } from './curve.ts';
import { blobHeight, blobWidth, type Blob, type Blobs } from './markers.ts';
import type { Region } from './region.ts';
import type { LineStyle } from './types.ts';

export interface StyleSignature {
  style: LineStyle;
  /** Stroke width at the seed, px. */
  thickness: number;
  /** Shortest and longest piece (dot or dash) of the pattern, px; 0 when not patterned. */
  minOn: number;
  maxOn: number;
  /** Mean gap between pieces, px; 0 when not patterned. */
  gap: number;
}

interface Ctx {
  found: Blobs;
  alpha: Float32Array;
  other: Uint8Array;
  region: Region;
  /** Rulings taken out of the coverage map (rulings.ts), or undefined. */
  ruling?: Uint8Array | undefined;
}

/** Minimum pieces (dashes or dots) in a chain for a pattern, and their gaps' allowed spread. */
const MIN_PIECES = 5;
/** The gap length most others agree with (a robust mode: chains pick up odd hops at their ends). */
function typicalGap(gaps: number[]): number {
  let best = 0;
  let support = -1;
  for (const g of gaps) {
    const n = gaps.filter((h) => Math.abs(h - g) <= Math.max(1.5, 0.35 * g)).length;
    if (n > support || (n === support && g < best)) {
      best = g;
      support = n;
    }
  }
  return best;
}
const gapsRegular = (gaps: number[]): boolean => {
  if (gaps.length < MIN_PIECES - 1) return false;
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd <= Math.max(1.5, 0.35 * mean);
};
/**
 * Whether piece lengths come in one or two tight clusters (dashes; dots; dash-dot), allowing a
 * fifth of them to be odd (pieces cut at the plot edge or a crossing, corner pieces, fragments).
 * A thin solid line broken by anti-aliasing or JPEG gives fragments of every length.
 */
function lengthsRegular(lengths: number[]): boolean {
  const s = [...lengths].sort((a, b) => a - b);
  const n = s.length;
  const cut = Math.floor(0.2 * n);
  const tight = (c: number[]) => c.length >= 2 && c[c.length - 1]! <= 1.6 * c[0]!;
  for (let lo = 0; lo <= cut; lo++) {
    for (let hi = n - 1; hi >= n - 1 - (cut - lo); hi--) {
      const core = s.slice(lo, hi + 1);
      if (tight(core)) return true;
      let split = 1;
      for (let i = 2; i < core.length; i++) if (core[i]! / core[i - 1]! > core[split]! / core[split - 1]!) split = i;
      if (tight(core.slice(0, split)) && tight(core.slice(split))) return true;
    }
  }
  return false;
}

/** Gaps narrower than this join fragments of one stroke (JPEG breaks thin lines). */
const FRAGMENT_GAP = 1.5;

/** Width of the stroke through a blob: median over its pixels of the shorter of its two runs. */
function strokeWidth(ctx: Ctx, b: Blob): number {
  const { found, region } = ctx;
  const w = region.width;
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt(b.area / 200)));
  for (let y = b.y0; y <= b.y1; y += step) {
    for (let x = b.x0; x <= b.x1; x += step) {
      if (found.labels[y * w + x] !== b.label) continue;
      let l = x;
      while (l > b.x0 && found.labels[y * w + l - 1] === b.label && x - l < 40) l--;
      let r = x;
      while (r < b.x1 && found.labels[y * w + r + 1] === b.label && r - x < 40) r++;
      let u = y;
      while (u > b.y0 && found.labels[(u - 1) * w + x] === b.label && y - u < 40) u--;
      let d = y;
      while (d < b.y1 && found.labels[(d + 1) * w + x] === b.label && d - y < 40) d++;
      vals.push(Math.min(r - l + 1, d - u + 1));
    }
  }
  vals.sort((a, c) => a - c);
  return Math.max(1, vals[vals.length >> 1] ?? 1);
}

/** Length of a piece along its stroke: its diagonal, or area / width for an L-shaped dash. */
const pieceLength = (b: Blob, t: number) => Math.max(Math.hypot(blobWidth(b), blobHeight(b)), b.area / t);

/** Pixels of a blob (scan of its bounding box). */
function pixelsOf(ctx: Ctx, b: Blob): number[] {
  const w = ctx.region.width;
  const out: number[] = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (ctx.found.labels[y * w + x] === b.label) out.push(y * w + x);
  return out;
}

interface Gap {
  /** Background px between the nearest pixels (0 = touching); −1 = occluded. */
  gap: number;
  /** The nearest pixels (indices) of the two blobs. */
  ka: number;
  kb: number;
  /** The gap runs across other ink of the series' colour (another series crossing). */
  crossing?: boolean;
  /** The gap is all ruling (rulings.ts): two fragments of one stroke cut by a gridline (gap 0). */
  cut?: boolean;
}

/**
 * Gap between two blobs, px of background between their nearest pixels (0 = touching), or −1
 * when the straight gap between them crosses ink of another colour (an occlusion, not a gap).
 */
function gapBetween(ctx: Ctx, a: number[], b: number[]): Gap {
  const { ka: pa, kb: pb, d } = nearestPair(ctx, a, b);
  const w = ctx.region.width;
  const xa = pa % w;
  const ya = (pa - xa) / w;
  const xb = pb % w;
  const yb = (pb - xb) / w;
  // Occluded when much of the gap is ink of another colour (not the faint same-hue fringe JPEG
  // leaves around strokes) or outside the region: a marker over a solid line. A thin line of
  // another colour across the gap (a gridline) is not an occlusion.
  const n = Math.ceil(d);
  let hidden = 0;
  let crossing = false;
  /** Gap pixels on a ruling, and pixels of the gap neither ruling nor its faint fringe. */
  let ruled = 0;
  let open = 0;
  const la = ctx.found.labels[pa];
  const lb = ctx.found.labels[pb];
  for (let i = 1; i < n; i++) {
    const x = Math.round(xa + ((xb - xa) * i) / n);
    const y = Math.round(ya + ((yb - ya) * i) / n);
    const k = y * w + x;
    if (ctx.ruling?.[k]) {
      // A gridline of the series' colour across the gap: a crossing, as when it was ink.
      crossing = true;
      ruled++;
      continue;
    }
    const a = ctx.alpha[k] ?? -1;
    if (a <= 0 || a >= ON_ALPHA) open++;
    if (a < 0 && (ctx.other[k] || !ctx.region.mask[k])) hidden++;
    const l = ctx.found.labels[k];
    if (l && l !== la && l !== lb) crossing = true;
  }
  if (hidden >= Math.max(3, 0.5 * (n - 1))) return { gap: -1, ka: pa, kb: pb };
  // Nothing but a ruling (and its fringe) between them: one stroke the ruling's removal cut.
  if (ruled > 0 && open === 0) return { gap: 0, ka: pa, kb: pb, cut: true };
  return { gap: Math.max(0, d - 1), ka: pa, kb: pb, crossing };
}

/** The nearest pixels of two pixel lists and their distance. */
function nearestPair(ctx: Ctx, a: number[], b: number[]): { ka: number; kb: number; d: number } {
  const w = ctx.region.width;
  let best = Infinity;
  let pa = 0;
  let pb = 0;
  for (const ka of a) {
    const xa = ka % w;
    const ya = (ka - xa) / w;
    for (const kb of b) {
      const xb = kb % w;
      const d = (xb - xa) ** 2 + ((kb - xb) / w - ya) ** 2;
      if (d < best) {
        best = d;
        pa = ka;
        pb = kb;
      }
    }
  }
  return { ka: pa, kb: pb, d: Math.sqrt(best) };
}

/** Gap between two blobs' bounding boxes, px (0 when they touch or overlap): a lower bound. */
function bboxGap(a: Blob, b: Blob): number {
  const gx = Math.max(0, Math.max(b.x0 - a.x1, a.x0 - b.x1) - 1);
  const gy = Math.max(0, Math.max(b.y0 - a.y1, a.y0 - b.y1) - 1);
  return Math.hypot(gx, gy);
}

/** Blobs small enough to be one dash or dot, indexed on a grid for neighbour queries. */
class PieceIndex {
  readonly cell: number;
  private readonly grid = new Map<number, Blob[]>();
  private readonly pix = new Map<number, number[]>();
  private readonly ctx: Ctx;
  readonly maxLen: number;
  constructor(ctx: Ctx, maxLen: number) {
    this.ctx = ctx;
    this.maxLen = maxLen;
    this.cell = Math.max(16, Math.ceil(maxLen));
    for (const b of ctx.found.blobs) {
      if (Math.hypot(blobWidth(b), blobHeight(b)) > maxLen) continue;
      const key = this.key(Math.floor(b.cx / this.cell), Math.floor(b.cy / this.cell));
      const list = this.grid.get(key) ?? [];
      list.push(b);
      this.grid.set(key, list);
    }
  }
  private key(i: number, j: number) {
    return i * 100003 + j;
  }
  pixels(b: Blob): number[] {
    let p = this.pix.get(b.label);
    if (!p) {
      p = pixelsOf(this.ctx, b);
      this.pix.set(b.label, p);
    }
    return p;
  }
  /** Pieces whose centroid lies within `r` of (x, y). */
  near(x: number, y: number, r: number): Blob[] {
    const out: Blob[] = [];
    const n = Math.ceil(r / this.cell);
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(y / this.cell);
    for (let i = ci - n; i <= ci + n; i++) {
      for (let j = cj - n; j <= cj + n; j++) {
        for (const b of this.grid.get(this.key(i, j)) ?? []) if (Math.hypot(b.cx - x, b.cy - y) <= r) out.push(b);
      }
    }
    return out;
  }
}

/** Reach for the next piece from a piece of size `size`: a dotted line's gap is ~2 dot widths. */
const reachOf = (size: number) => 3 * size + 4;

interface Piece {
  blobs: Blob[];
  length: number;
}

/**
 * The chain of pieces through the seed's blob, in order, with the gaps between them. Fragments
 * closer than FRAGMENT_GAP are merged into one piece.
 */
function seedChain(ctx: Ctx, index: PieceIndex, template: Blob, t: number, maxLinks: number): { pieces: Piece[]; gaps: number[]; at: number } {
  const used = new Set<number>([template.label]);
  const sides: { blob: Blob; gap: number }[][] = [];
  let firstDir: [number, number] | null = null;
  for (const side of [1, -1]) {
    const links: { blob: Blob; gap: number }[] = [];
    sides.push(links);
    if (side === -1 && !firstDir) break;
    let cur = template;
    let dir: [number, number] | null = side === 1 ? null : [-firstDir![0], -firstDir![1]];
    for (let n = 0; n < maxLinks; n++) {
      const size = Math.max(blobWidth(cur), blobHeight(cur));
      const reach = reachOf(Math.min(size, Math.max(t, index.maxLen / 3)));
      let best: Blob | null = null;
      let bestGap = Infinity;
      let bestCrossing = false;
      for (const b of index.near(cur.cx, cur.cy, reach + index.maxLen)) {
        if (used.has(b.label)) continue;
        const dx = b.cx - cur.cx;
        const dy = b.cy - cur.cy;
        const len = Math.hypot(dx, dy) || 1;
        // Up to ~100° of turn: a dashed step curve turns its corners in dashes.
        if (dir && (dx * dir[0] + dy * dir[1]) / len < -0.2) continue;
        if (bboxGap(cur, b) > reach) continue;
        const gb = gapBetween(ctx, index.pixels(cur), index.pixels(b));
        const g = gb.gap;
        if (g < 0 || g > reach || g >= bestGap) continue;
        bestGap = g;
        best = b;
        bestCrossing = !!gb.crossing;
      }
      if (!best) break;
      const len = Math.hypot(best.cx - cur.cx, best.cy - cur.cy) || 1;
      dir = [(best.cx - cur.cx) / len, (best.cy - cur.cy) / len];
      if (side === 1 && n === 0) firstDir = dir;
      // A gap across another series of the colour is no measure of the pattern (NaN).
      links.push({ blob: best, gap: bestCrossing ? Number.NaN : bestGap });
      used.add(best.label);
      cur = best;
    }
  }
  const [fwd, back] = sides as [{ blob: Blob; gap: number }[], { blob: Blob; gap: number }[] | undefined];
  // Ordered blobs with the gap before each.
  const ordered: { blob: Blob; gap: number }[] = [];
  const rev = (back ?? []).slice().reverse();
  rev.forEach((l, i) => ordered.push({ blob: l.blob, gap: i === 0 ? 0 : rev[i - 1]!.gap }));
  ordered.push({ blob: template, gap: rev.length ? rev[rev.length - 1]!.gap : 0 });
  for (const l of fwd) ordered.push(l);
  const pieces: Piece[] = [];
  const gaps: number[] = [];
  let at = 0;
  for (const [i, o] of ordered.entries()) {
    if (o.blob === template) at = i > 0 && o.gap < FRAGMENT_GAP ? pieces.length - 1 : pieces.length;
    if (i > 0 && o.gap < FRAGMENT_GAP) {
      const p = pieces[pieces.length - 1]!;
      p.blobs.push(o.blob);
      p.length += pieceLength(o.blob, t) + o.gap;
      continue;
    }
    if (i > 0) gaps.push(o.gap);
    pieces.push({ blobs: [o.blob], length: pieceLength(o.blob, t) });
  }
  return { pieces, gaps, at };
}

const NONE = (thickness: number, style: LineStyle): StyleSignature => ({ style, thickness, minOn: 0, maxOn: 0, gap: 0 });

/**
 * The pattern of evenly gapped pieces. Pieces of one length are dots when they are dot-sized (up to
 * 2.5 line widths + 1 px: a JPEG or anti-aliased dot measures about twice its width), else dashes;
 * two lengths, each at least twice, alternate as dash-dot. Ends of a chain may be cut short (the
 * plot edge, an occlusion), so with enough pieces the outer two are left out. Null when the gaps
 * are too wide for a line pattern (a row of evenly spaced markers): a dotted line's gaps are at
 * most 2.5 line widths, a dashed line's at most 1.5 dash lengths.
 */
function patternOf(lengths: number[], gaps: number[], t: number): StyleSignature | null {
  const inner = lengths.length > MIN_PIECES ? lengths.slice(1, -1) : lengths;
  const sorted = [...inner].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.2 * (sorted.length - 1))]!;
  const hi = sorted[Math.ceil(0.8 * (sorted.length - 1))]!;
  let style: LineStyle;
  if (hi <= 1.8 * lo) style = sorted[sorted.length >> 1]! <= 2.5 * t + 1 ? 'dotted' : 'dashed';
  else {
    const split = Math.sqrt(lo * hi);
    const shorts = inner.filter((l) => l < split).length;
    const longs = inner.length - shorts;
    style = shorts >= 2 && longs >= 2 ? 'dash-dot' : longs > shorts ? 'dashed' : 'dotted';
  }
  const gap = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  if (gap > (style === 'dotted' ? 2.5 * t : 1.5 * hi)) return null;
  return { style, thickness: t, minOn: lo, maxOn: Math.max(...lengths), gap };
}

export function classifyStyle(ctx: Ctx, template: Blob, markerMax: number): StyleSignature {
  const t = strokeWidth(ctx, template);
  const seedLen = pieceLength(template, t);
  const index = new PieceIndex(ctx, 1.5 * markerMax);
  if (Math.hypot(blobWidth(template), blobHeight(template)) <= index.maxLen) {
    const chain = seedChain(ctx, index, template, t, 8);
    // The chain runs on into whatever lies beyond the series (a tick, text): keep the stretch
    // around the seed whose gaps are the typical one.
    const m = typicalGap(chain.gaps.filter((g) => !Number.isNaN(g)));
    const fits = (g: number) => Number.isNaN(g) || Math.abs(g - m) <= Math.max(1.5, 0.35 * m);
    let lo = chain.at;
    let hi = chain.at;
    while (lo > 0 && fits(chain.gaps[lo - 1]!)) lo--;
    while (hi < chain.pieces.length - 1 && fits(chain.gaps[hi]!)) hi++;
    const pieces = chain.pieces.slice(lo, hi + 1);
    const gaps = chain.gaps.slice(lo, hi).filter((g) => !Number.isNaN(g));
    const seen = pieces.length >= MIN_PIECES && gapsRegular(gaps) ? patternOf(pieces.map((p) => p.length), gaps, t) : null;
    if (seen) return seen;
    // Too few pieces in a row here (a short step, a dash merged into another series): the
    // region's pattern chain the seed's blob belongs to, if any.
    const own = patternChains(ctx, index, -1).find((c) => c.members.has(template.label));
    if (own) {
      const gapsAll = own.links.filter((e) => e.gap >= FRAGMENT_GAP && !e.crossing).map((e) => e.gap);
      const lengths = [...own.members].map((l) => pieceLength(ctx.found.blobs[l - 1]!, t)).sort((a, b) => a - b);
      const found = patternOf(lengths, gapsAll, t);
      if (found) return found;
    }
  }
  return NONE(t, seedLen >= Math.max(40, 10 * t) ? 'solid' : 'unknown');
}

interface Link extends Gap {
  a: number;
  b: number;
}

/**
 * The regular pattern chains in the region (≥ MIN_PIECES pieces, evenly gapped): the dashes and
 * dots of patterned series. Each piece links to its nearest neighbour and to the nearest one on
 * its other side; of each linked group only the links with the group's typical gap are kept (a
 * word of text or a stray mark joins a chain through an odd gap) and the chains are what remains
 * linked. Returns each chain's members and links.
 */
function patternChains(ctx: Ctx, index: PieceIndex, exclude: number): { members: Set<number>; links: Link[] }[] {
  const blobs = ctx.found.blobs.filter((b) => b.label !== exclude && b.area >= 2 && Math.hypot(blobWidth(b), blobHeight(b)) <= index.maxLen);
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const links: Link[] = [];
  const known = new Set(blobs.map((b) => b.label));
  for (const b of blobs) {
    const size = Math.max(blobWidth(b), blobHeight(b));
    const reach = reachOf(size);
    const cands: { o: Blob; g: Gap; dir: [number, number] }[] = [];
    for (const o of index.near(b.cx, b.cy, reach + index.maxLen)) {
      if (o.label === b.label || !known.has(o.label)) continue;
      if (bboxGap(b, o) > reach) continue;
      const g = gapBetween(ctx, index.pixels(b), index.pixels(o));
      if (g.gap < 0 || g.gap > reach) continue;
      const len = Math.hypot(o.cx - b.cx, o.cy - b.cy) || 1;
      cands.push({ o, g, dir: [(o.cx - b.cx) / len, (o.cy - b.cy) / len] });
    }
    if (!cands.length) continue;
    cands.sort((p, q) => p.g.gap - q.g.gap);
    const first = cands[0]!;
    links.push({ a: b.label, b: first.o.label, ...first.g });
    const second = cands.find((c) => c.dir[0] * first.dir[0] + c.dir[1] * first.dir[1] < 0);
    if (second) links.push({ a: b.label, b: second.o.label, ...second.g });
  }
  const union = (list: Link[]) => {
    for (const b of blobs) parent.set(b.label, b.label);
    for (const e of list) parent.set(find(e.a), find(e.b));
  };
  union(links);
  const byGroup = new Map<number, number[]>();
  for (const e of links) {
    if (e.gap < FRAGMENT_GAP || e.crossing) continue;
    const r = find(e.a);
    const list = byGroup.get(r) ?? [];
    list.push(e.gap);
    byGroup.set(r, list);
  }
  const typical = new Map<number, number>();
  for (const [r, gaps] of byGroup) typical.set(r, typicalGap(gaps));
  // Links across another series of the colour keep a chain together but measure nothing.
  const kept = links.filter((e) => {
    if (e.gap < FRAGMENT_GAP || e.crossing) return true;
    const m = typical.get(find(e.a));
    return m !== undefined && Math.abs(e.gap - m) <= Math.max(1.5, 0.35 * m);
  });
  union(kept);
  const groups = new Map<number, { members: Set<number>; links: Map<string, Link> }>();
  for (const e of kept) {
    const r = find(e.a);
    const g = groups.get(r) ?? { members: new Set<number>(), links: new Map<string, Link>() };
    g.members.add(e.a);
    g.members.add(e.b);
    g.links.set(e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`, e);
    groups.set(r, g);
  }
  const out: { members: Set<number>; links: Link[] }[] = [];
  for (const g of groups.values()) {
    const list = [...g.links.values()];
    const lengths = pieceSizes(ctx, g.members, list);
    const gaps = list.filter((e) => e.gap >= FRAGMENT_GAP && !e.crossing).map((e) => e.gap);
    if (!(lengths.length >= MIN_PIECES && gapsRegular(gaps) && lengthsRegular(lengths))) continue;
    // A crossing keeps a chain together but measures nothing, so it must not bring in what is no
    // piece of it: a member linked only across crossings and far larger than the typical piece is
    // the other series (a solid curve cut into lengths by a grid of its colour, rulings.ts).
    const sorted = [...lengths].sort((a, b) => a - b);
    const typical = sorted[sorted.length >> 1]!;
    const plain = new Set<number>();
    for (const e of list) {
      if (e.crossing) continue;
      plain.add(e.a);
      plain.add(e.b);
    }
    const odd = new Set<number>();
    for (const m of g.members) {
      const b = ctx.found.blobs[m - 1]!;
      if (!plain.has(m) && Math.hypot(blobWidth(b), blobHeight(b)) > 3 * typical) odd.add(m);
    }
    if (!odd.size) out.push({ members: g.members, links: list });
    else out.push({ members: new Set([...g.members].filter((m) => !odd.has(m))), links: list.filter((e) => !odd.has(e.a) && !odd.has(e.b)) });
  }
  return out;
}

/**
 * Size (bounding-box diagonal) of each piece of a chain: a blob, or the fragments of one stroke a
 * ruling's removal cut apart (`cut` links) taken together.
 */
function pieceSizes(ctx: Ctx, members: Set<number>, links: Link[]): number[] {
  const root = new Map<number, number>();
  for (const m of members) root.set(m, m);
  const find = (a: number): number => {
    let r = a;
    while (root.get(r)! !== r) r = root.get(r)!;
    root.set(a, r);
    return r;
  };
  for (const e of links) if (e.cut) root.set(find(e.a), find(e.b));
  const box = new Map<number, [number, number, number, number]>();
  for (const m of members) {
    const b = ctx.found.blobs[m - 1]!;
    const r = find(m);
    const o = box.get(r);
    box.set(r, o ? [Math.min(o[0], b.x0), Math.min(o[1], b.y0), Math.max(o[2], b.x1), Math.max(o[3], b.y1)] : [b.x0, b.y0, b.x1, b.y1]);
  }
  return [...box.values()].map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0 + 1, y1 - y0 + 1));
}

/** Centre of a piece's end: the coverage-weighted centroid of its pixels within `r` of pixel k. */
function endCentre(ctx: Ctx, label: number, k: number, r: number): [number, number] {
  const { found, alpha, region } = ctx;
  const w = region.width;
  const x0 = k % w;
  const y0 = (k - x0) / w;
  const R = Math.ceil(r);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = Math.max(0, y0 - R); y <= Math.min(region.height - 1, y0 + R); y++) {
    for (let x = Math.max(0, x0 - R); x <= Math.min(w - 1, x0 + R); x++) {
      const kk = y * w + x;
      if (found.labels[kk] !== label || (x - x0) ** 2 + (y - y0) ** 2 > r * r) continue;
      const a = Math.min(1, alpha[kk] ?? 0);
      sw += a;
      sx += a * x;
      sy += a * y;
    }
  }
  return sw > 0 ? [sx / sw, sy / sw] : [x0, y0];
}

/**
 * Full coverage along the gap of a link, `t` px wide, from the centre of one piece's end to the
 * other's: the gap of a dashed line filled in.
 */
function fillGap(ctx: Ctx, e: Link, t: number, fill: Fill, level: number): void {
  const { alpha, region } = ctx;
  const w = region.width;
  const r = Math.max(1.5, t);
  const [xa, ya] = endCentre(ctx, e.a, e.ka, r);
  const [xb, yb] = endCentre(ctx, e.b, e.kb, r);
  const len = Math.hypot(xb - xa, yb - ya);
  const nx = len ? -(yb - ya) / len : 0;
  const ny = len ? (xb - xa) / len : 0;
  const n = Math.max(1, Math.ceil(2 * len));
  const half = (t - 1) / 2;
  for (let i = 0; i <= n; i++) {
    for (let o = -half; o <= half + 1e-9; o += 0.5) {
      const x = Math.round(xa + ((xb - xa) * i) / n + o * nx);
      const y = Math.round(ya + ((yb - ya) * i) / n + o * ny);
      const k = y * w + x;
      if (region.mask[k] && (alpha[k] ?? -1) >= 0 && alpha[k]! < ON_ALPHA) {
        if (!fill.mask[k]) {
          fill.mask[k] = 1;
          fill.k.push(k);
          fill.a.push(alpha[k]!);
        }
        alpha[k] = level;
      }
    }
  }
}

/** Pixels raised to full coverage by `fillGap`, with their real coverage. */
export interface Fill {
  mask: Uint8Array;
  k: number[];
  a: number[];
}

/**
 * Apply the seed's style to the coverage map in place: ink of the series' colour that does not
 * fit it becomes "other" (an occluder); a patterned series' own gaps are filled in. Returns the
 * fill (to be undone once the walk is over, or null) and whether any ink was dropped.
 */
export function applyStyle(ctx: Ctx, template: Blob, sig: StyleSignature, markerMax: number): { fill: Fill | null; dropped: boolean } {
  const { found, alpha, other } = ctx;
  const patterned = sig.style === 'dashed' || sig.style === 'dotted' || sig.style === 'dash-dot';
  if (sig.style !== 'solid' && !patterned) return { fill: null, dropped: false };
  const index = new PieceIndex(ctx, 1.5 * markerMax);
  let foreign: (b: Blob) => boolean;
  let own: Link[] = [];
  if (sig.style === 'solid') {
    const pattern = new Set<number>();
    for (const c of patternChains(ctx, index, template.label)) for (const m of c.members) pattern.add(m);
    foreign = (b) => pattern.has(b.label);
  } else {
    const limit = 2 * sig.maxOn + 4 * sig.thickness;
    foreign = (b) => b.label !== template.label && Math.hypot(blobWidth(b), blobHeight(b)) > limit;
    // Every chain with the seed's pattern: where a dash touches the other series it is part of
    // that series' stroke, which splits the seed's own chain in pieces.
    const chains = patternChains(ctx, index, -1);
    const sameGap = (c: { links: Link[] }) => {
      const m = typicalGap(c.links.filter((e) => e.gap >= FRAGMENT_GAP && !e.crossing).map((e) => e.gap));
      return Math.abs(m - sig.gap) <= Math.max(1.5, 0.35 * sig.gap);
    };
    own = chains.filter((c) => c.members.has(template.label) || sameGap(c)).flatMap((c) => c.links);
  }
  const drop = new Uint8Array(found.blobs.length + 1);
  let any = false;
  for (const b of found.blobs) {
    if (foreign(b)) {
      drop[b.label] = 1;
      any = true;
    }
  }
  const w = ctx.region.width;
  if (any) {
    for (let k = 0; k < alpha.length; k++) {
      const l = found.labels[k]!;
      if (l && drop[l]) {
        alpha[k] = -1;
        other[k] = 1;
      } else if (!l && (alpha[k] ?? -1) > 0 && (alpha[k] ?? 0) < ON_ALPHA) {
        // The anti-aliased fringe of a dropped blob goes with it.
        const x = k % w;
        for (const d of [-1, 1, -w, w]) {
          if ((d === -1 && x === 0) || (d === 1 && x === w - 1)) continue;
          const ln = found.labels[k + d];
          if (ln && drop[ln]) {
            alpha[k] = -1;
            break;
          }
        }
      }
    }
  }
  // The series' own gaps filled in: the walker then follows a dashed or dotted series, round its
  // step corners and along its dashed verticals, like a solid line.
  if (!own.length) return { fill: null, dropped: any };
  const fill: Fill = { mask: new Uint8Array(alpha.length), k: [], a: [] };
  // Only gaps between pieces the size of the seed's own (a dotted gridline the series crosses can
  // join its chain with similar gaps, but not with dashes of its length).
  const fits = (label: number) => {
    const L = pieceLength(found.blobs[label - 1]!, sig.thickness);
    return L >= 0.5 * sig.minOn && L <= 1.5 * sig.maxOn + sig.thickness;
  };
  // Filled at the stroke's own typical peak: a stronger fill would make the faint real runs of a
  // thin line look too weak to be the series (the walker's peak test).
  const peaks: number[] = [];
  for (let x = template.x0; x <= template.x1; x++) {
    let p = 0;
    for (let y = template.y0; y <= template.y1; y++) if (found.labels[y * w + x] === template.label) p = Math.max(p, alpha[y * w + x]!);
    peaks.push(Math.min(1, p));
  }
  peaks.sort((a, b) => a - b);
  const level = Math.max(ON_ALPHA, peaks[peaks.length >> 1] ?? 1);
  for (const e of own) if (e.gap >= FRAGMENT_GAP / 2 && fits(e.a) && fits(e.b)) fillGap(ctx, e, sig.thickness, fill, level);
  // Where the series runs across the other one, its dash touching that stroke went with it and
  // its chain breaks there: join each chain end to the nearest piece of its size across the
  // dropped ink (over no other ink of the series' colour).
  if (any || ctx.ruling) {
    // Links of the pattern between pieces that stay: a link to dropped ink (a marker with its
    // error bars on the line) ends the chain there.
    const degree = new Map<number, number>();
    /** The piece a chain end is linked to: the chain comes from there. */
    const from = new Map<number, number>();
    for (const e of own) {
      if (e.gap < FRAGMENT_GAP || e.crossing || drop[e.a] || drop[e.b]) continue;
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
      from.set(e.a, e.b);
      from.set(e.b, e.a);
    }
    const reach = 2 * (sig.maxOn + sig.gap) + 4 * sig.thickness;
    // A join longer than one gap of the pattern has lost a piece to the dropped ink: at least half
    // a piece of it lies on that ink. Background in its place is past the series' end — a tick
    // label beyond an axis the series ran into, when no plot box keeps the labels out.
    const oneGap = sig.gap + Math.max(1.5, 0.35 * sig.gap) + sig.thickness;
    // A lone piece across (no link of the pattern of its own) must go on the way the chain was
    // going: ahead of its end and off its line by no more than a dash turning a corner — not a tick
    // label beside the crossing (a '1' above a top X axis).
    const offLine = sig.maxOn + 2 * sig.thickness;
    for (const [label, n] of degree) {
      if (n > 1 || !fits(label)) continue;
      const b = found.blobs[label - 1]!;
      const p = found.blobs[from.get(label)! - 1]!;
      const ul = Math.hypot(b.cx - p.cx, b.cy - p.cy) || 1;
      const ux = (b.cx - p.cx) / ul;
      const uy = (b.cy - p.cy) / ul;
      let best: Link | null = null;
      for (const o of index.near(b.cx, b.cy, reach + index.maxLen)) {
        if (o.label === label || drop[o.label] || !fits(o.label) || bboxGap(b, o) > reach) continue;
        // The other side of a break is a chain end too: a piece linked on both sides lies inside
        // an unbroken chain (another dashed series of the colour beyond a third, l106).
        const m = degree.get(o.label) ?? 0;
        if (m > 1) continue;
        const vx = o.cx - b.cx;
        const vy = o.cy - b.cy;
        if (m === 0 && (vx * ux + vy * uy <= 0 || Math.abs(vx * uy - vy * ux) > offLine)) continue;
        const { ka, kb, d } = nearestPair(ctx, index.pixels(b), index.pixels(o));
        if (d > reach || (best && d - 1 >= best.gap)) continue;
        const xa = ka % w;
        const ya = (ka - xa) / w;
        const xb = kb % w;
        const yb = (kb - xb) / w;
        const steps = Math.ceil(d);
        let crossed = 0;
        let blocked = false;
        for (let i = 1; i < steps && !blocked; i++) {
          const k = Math.round(ya + ((yb - ya) * i) / steps) * w + Math.round(xa + ((xb - xa) * i) / steps);
          const l = found.labels[k]!;
          if ((l && drop[l]) || ctx.ruling?.[k]) crossed++;
          else blocked = l !== 0 || !ctx.region.mask[k];
        }
        if (!blocked && crossed > 0 && !(d > oneGap && crossed < 0.5 * sig.minOn)) best = { a: label, b: o.label, ka, kb, gap: d - 1 };
      }
      if (best) fillGap(ctx, best, sig.thickness, fill, level);
    }
  }
  return { fill, dropped: any };
}

/**
 * After the walk: the filled gaps are undone and each column keeps the real run (of the image's
 * own ink) that overlaps its walked run most, re-centred; columns that ran mostly over filled gaps
 * are dropped (the next real column counts the gap).
 */
export function unfill(fill: Fill, entries: ColumnEntry[], alpha: Float32Array, region: Region): ColumnEntry[] {
  fill.k.forEach((k, i) => (alpha[k] = fill.a[i]!));
  const { width: w, height: h } = region;
  const out: ColumnEntry[] = [];
  let skipped = 0;
  for (const e of entries) {
    let best: { top: number; bottom: number } | null = null;
    let bestOverlap = 0;
    for (const r of columnRuns(alpha, w, e.x, Math.max(region.y0, e.top - 2), Math.min(region.y1, e.bottom + 2))) {
      const overlap = Math.min(r.bottom, e.bottom) - Math.max(r.top, e.top) + 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = r;
      }
    }
    // A column that is mostly fill (a dash's tip beside its filled gap) is not evidence either.
    if (!best || 2 * bestOverlap < e.bottom - e.top + 1) {
      skipped++;
      continue;
    }
    const same = best.top === e.top && best.bottom === e.bottom;
    out.push(same && !skipped ? e : { ...e, ...best, cy: same ? e.cy : runCentre(alpha, w, h, e.x, best), afterGap: e.afterGap + skipped });
    skipped = 0;
  }
  return out;
}

