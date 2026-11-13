/**
 * Dash hopping: the walk of a dashed (or dash-dot, dotted) series ends where its gaps were not
 * filled — a hand-drawn line whose dashes and gaps vary too much for one pattern, a gridline
 * crossing that cut a dash, a marker beside it. From each end of the walk, look for the next piece
 * of the line ahead: a blob of the series' colour, not yet walked, the size of a piece (an 'x' or
 * 'o' marker is larger and round), lying ahead of the end along the direction of the walk's last
 * stretch, within a gap and a piece's reach and close to that line; walk on from it. Repeat until
 * nothing fits: that is the series' real end.
 *
 * Works on the walk's column entries (before `unfill`), with the walk's own coverage map and
 * options. Pure TS, no DOM.
 */

import { ON_ALPHA } from './color.ts';
import { traceColumns, type ColumnEntry, type TraceOptions } from './curve.ts';
import type { Blob, Blobs } from './markers.ts';
import type { Region } from './region.ts';
import type { StyleSignature } from './style.ts';

/** Most hops from one end (a long dashed line in a large scan has a few hundred dashes). */
const MAX_HOPS = 400;
/** Pixels of the smallest piece (a dash cut by a gridline still has more; a speck has fewer). */
const MIN_AREA = 4;
/** Columns without ink a walk along one piece crosses (a scanned stroke's pinholes). */
const PIECE_GAP = 2;
/** A piece at least this elongated must run along the line (a short fat dash is 1.5–2). */
const ELONGATED = 1.5;
/** Largest turn between a piece's long axis and the line, as a cosine (~35°). */
const ALIGN_COS = 0.82;

interface Dir {
  x: number;
  y: number;
}

/**
 * Direction of the walk at its end (unit vector pointing out of the end) from the entries within
 * `len` px of path before it, by their principal axis; null when there are too few.
 */
function endDirection(entries: ColumnEntry[], fromEnd: boolean, len: number): Dir | null {
  const pts: [number, number][] = [];
  let arc = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[fromEnd ? entries.length - 1 - i : i]!;
    const p: [number, number] = [e.x, e.cy];
    if (pts.length) {
      const q = pts[pts.length - 1]!;
      arc += Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (arc > len) break;
    }
    pts.push(p);
  }
  if (pts.length < 3) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let d = { x: Math.cos(ang), y: Math.sin(ang) };
  const [ex, ey] = pts[0]!;
  if ((ex - mx) * d.x + (ey - my) * d.y < 0) d = { x: -d.x, y: -d.y };
  return d;
}

/** Unit vector of a blob's long axis (second moments of its pixels). */
function blobAxis(pix: number[], w: number): Dir {
  let mx = 0;
  let my = 0;
  for (const k of pix) {
    mx += k % w;
    my += Math.floor(k / w);
  }
  mx /= pix.length;
  my /= pix.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const k of pix) {
    const x = (k % w) - mx;
    const y = Math.floor(k / w) - my;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: Math.cos(ang), y: Math.sin(ang) };
}

/**
 * Extend a patterned series' walk at both ends by hopping to the next piece (see the file
 * comment). `entries` are the walk's columns, left to right; returns them extended.
 */
export function hopDashes(
  entries: ColumnEntry[],
  found: Blobs,
  alpha: Float32Array,
  region: Region,
  sig: StyleSignature,
  opts: TraceOptions,
): ColumnEntry[] {
  if (entries.length < 3) return entries;
  const w = region.width;
  const t = Math.max(1, sig.thickness);
  const reach = 2 * sig.gap + 4 * t;
  const maxPiece = Math.hypot(1.5 * sig.maxOn + 2 * t, 2 * t);
  /** Blobs the walk went through. */
  const walked = new Set<number>();
  const mark = (list: ColumnEntry[]) => {
    for (const e of list) for (let y = e.top; y <= e.bottom; y++) walked.add(found.labels[y * w + e.x] ?? 0);
  };
  mark(entries);
  const pixelsOf = (b: Blob): number[] => {
    const out: number[] = [];
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const k = y * w + x;
        if (found.labels[k] === b.label && (alpha[k] ?? -1) >= ON_ALPHA) out.push(k);
      }
    }
    return out;
  };
  // Pieces by grid cell, for the search around an end.
  const cell = Math.max(16, Math.ceil(reach + maxPiece));
  const grid = new Map<number, Blob[]>();
  for (const b of found.blobs) {
    if (Math.hypot(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) > maxPiece) continue;
    const key = Math.floor(b.cx / cell) * 100003 + Math.floor(b.cy / cell);
    const list = grid.get(key) ?? [];
    list.push(b);
    grid.set(key, list);
  }
  const near = (x: number, y: number): Blob[] => {
    const out: Blob[] = [];
    const ci = Math.floor(x / cell);
    const cj = Math.floor(y / cell);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) out.push(...(grid.get(i * 100003 + j) ?? []));
    return out;
  };

  /** Whether the straight path from (ax, ay) to pixel (bx, by) crosses no ink of the series' colour but its own ends'. */
  const clearPath = (ax: number, ay: number, bx: number, by: number, target: number): boolean => {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let i = 1; i < n; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const y = Math.round(ay + ((by - ay) * i) / n);
      const k = y * w + x;
      // Any blob of the series' colour, also one dropped from the map as another series' ink.
      const l = found.labels[k] ?? 0;
      if (l && l !== target && !walked.has(l)) return false;
    }
    return true;
  };

  let out = entries;
  for (const right of [true, false]) {
    const tried = new Set<number>();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const end = right ? out[out.length - 1]! : out[0]!;
      const dir = endDirection(out, right, 2 * (sig.maxOn + sig.gap) + 2 * t);
      if (!dir) break;
      // The walk's end is the end of its run along the line, not the column's centre.
      const ex = end.x;
      const ey = end.cy;
      let best: { b: Blob; along: number; seed: number } | null = null;
      for (const b of near(ex, ey)) {
        // Not a speck (a frame's corner, scanner noise).
        if (walked.has(b.label) || tried.has(b.label) || b.area < MIN_AREA) continue;
        const pix = pixelsOf(b);
        if (!pix.length) continue; // dropped ink (another series, a ruling)
        let along = Infinity;
        let perp = Infinity;
        let seed = -1;
        for (const k of pix) {
          const x = k % w;
          const y = (k - x) / w;
          const a = (x - ex) * dir.x + (y - ey) * dir.y;
          if (a <= 0) continue;
          const p = Math.abs((y - ey) * dir.x - (x - ex) * dir.y);
          if (a < along) {
            along = a;
            perp = p;
            seed = k;
          }
        }
        if (seed < 0 || along > reach || perp > Math.max(1.5 * t + 1, 0.25 * along)) continue;
        // Across background, ink of another colour or a ruling only: not across ink of the
        // series' colour (an axis, with the tick labels beyond it; another series).
        if (!clearPath(ex, ey, seed % w, Math.floor(seed / w), b.label)) continue;
        // A piece of the line, not a marker: a long piece runs along the line; a short one (a dot,
        // a dash cut by a gridline) is no larger than a dash's width a few times over.
        const size = Math.hypot(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
        if (b.elongation >= ELONGATED) {
          const ax = blobAxis(pix, w);
          if (Math.abs(ax.x * dir.x + ax.y * dir.y) < ALIGN_COS) continue;
        } else if (size > Math.max(2.5 * t + 1, 0.6 * sig.maxOn)) continue;
        if (!best || along < best.along) best = { b, along, seed };
      }
      if (!best) break;
      tried.add(best.b.label);
      // Start from the piece's middle column, on its own run there (the near tip is thin, and a
      // run ending at a ruling is a sliver).
      const b = best.b;
      const order: number[] = [];
      for (let x = b.x0; x <= b.x1; x++) order.push(x);
      order.sort((p, q) => Math.abs(p - b.cx) - Math.abs(q - b.cx));
      for (const x of order) {
        let top = -1;
        let bottom = -1;
        for (let y = b.y0; y <= b.y1; y++) {
          if (found.labels[y * w + x] !== b.label || (alpha[y * w + x] ?? -1) < ON_ALPHA) continue;
          if (top < 0) top = y;
          bottom = y;
        }
        if (top < 0) continue;
        const touches = (y: number) => !!opts.ruling?.[y * w + x];
        if (touches(top - 1) || touches(top - 2) || touches(bottom + 1) || touches(bottom + 2)) continue;
        best.seed = Math.round((top + bottom) / 2) * w + x;
        break;
      }
      const sx = best.seed % w;
      // Walk on from the piece as if across the gap, primed with the line's direction (columns on
      // it behind the piece): a dash's tip at the end of the walk tilts the walk's own last slope.
      const sy = (best.seed - sx) / w;
      const lead: ColumnEntry[] = [];
      if (Math.abs(dir.x) > 1e-3) {
        const slope = dir.y / dir.x;
        const back = right ? -1 : 1;
        for (let k = 1; k <= 8; k++) {
          const cy = sy + slope * back * k;
          lead.push({ x: sx + back * k, cy, top: Math.round(cy - (t - 1) / 2), bottom: Math.round(cy + (t - 1) / 2), afterGap: 0, peak: 1 });
        }
      }
      // The piece only: its end is the next hop's start (every gap after the first hop is bridged
      // by this test, not by the walker's own gap bridging).
      const next = traceColumns(alpha, region, { x: sx, y: sy }, { ...opts, maxGap: PIECE_GAP, maxHiddenGap: PIECE_GAP }, { dir: right ? 1 : -1, lead });
      const beyond = (next ?? []).filter((e) => (right ? e.x > end.x : e.x < end.x));
      if (!beyond.length) continue;
      const gap = Math.max(0, (right ? beyond[0]!.x - end.x : end.x - beyond[beyond.length - 1]!.x) - 1);
      if (right) {
        beyond[0] = { ...beyond[0]!, afterGap: gap };
        out = [...out, ...beyond];
      } else {
        out[0] = { ...out[0]!, afterGap: gap };
        out = [...beyond, ...out];
      }
      mark(beyond);
    }
  }
  return out;
}
