/**
 * Data points hidden under markers. A polyline chart puts a marker on every vertex, so the
 * vertex itself — the point the user wants — is never traced: the walk bridges the marker.
 *
 * - `insertHiddenKinks`: where the traced path jumps over a gap covered by a compact blob of
 *   another colour (a marker drawn over the line) that the stretches on both sides point at, the
 *   blob's centroid is the hidden vertex — on a straight run as well as at a kink. Without such a
 *   blob, where the straight stretches meet at an angle, their intersection is inserted when it
 *   lies within the gap and on ink — a dash gap is background, so a dashed curve gets no invented
 *   corners. Either needs most of the reconstructed stretch (gap end → vertex → gap end) to run
 *   over ink (a marker's inside), never over background. (Markers of the series' own colour become their centroid in `columnsToPath`.)
 * - `extendHiddenEnds`: a line that ends under a small round blob of another colour (a marker on
 *   the last data point) is extended to that blob's centroid when the line points at it.
 */

import type { PathPoint } from './curve.ts';

/** Fit y = m·x + c to points; null when fewer than 3 or not straight (RMS > 0.75 px). */
function fitLine(pts: PathPoint[]): { m: number; c: number } | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.px, 0) / n;
  const my = pts.reduce((s, p) => s + p.py, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.px - mx) ** 2;
    sxy += (p.px - mx) * (p.py - my);
  }
  if (sxx < 1e-9) return null;
  const m = sxy / sxx;
  const c = my - m * mx;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p.py - (m * p.px + c)) ** 2, 0) / n);
  return rms <= 0.75 ? { m, c } : null;
}

const MIN_TURN_DEGREES = 12;

export interface InkMaps {
  width: number;
  height: number;
  /** Coverage by the series colour (−1 = other colour or outside). */
  alpha: Float32Array;
  /** 1 = ink of another colour. */
  other: Uint8Array;
}

function onInk(maps: InkMaps, x: number, y: number, r: number): boolean {
  for (let yy = Math.max(0, Math.round(y) - r); yy <= Math.min(maps.height - 1, Math.round(y) + r); yy++) {
    for (let xx = Math.max(0, Math.round(x) - r); xx <= Math.min(maps.width - 1, Math.round(x) + r); xx++) {
      const k = yy * maps.width + xx;
      if (maps.other[k] || (maps.alpha[k] ?? -1) >= 0.5) return true;
    }
  }
  return false;
}

export function insertHiddenKinks(path: PathPoint[], thickness: number, maps: InkMaps): PathPoint[] {
  const reach = Math.max(8, 4 * thickness);
  const near = Math.max(2, thickness + 1);
  const out: PathPoint[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    out.push(a);
    const b = path[i + 1];
    if (!b || b.px - a.px < 2 || a.corner || b.corner) continue;
    const left: PathPoint[] = [];
    for (let j = i; j >= 0 && path[j]!.px >= a.px - reach && !path[j]!.corner; j--) left.push(path[j]!);
    const right: PathPoint[] = [];
    for (let j = i + 1; j < path.length && path[j]!.px <= b.px + reach && !path[j]!.corner; j++) right.push(path[j]!);
    const l = fitLine(left);
    const r = fitLine(right);
    const lineDist = (f: { m: number; c: number }, x: number, y: number) => Math.abs(y - (f.m * x + f.c)) / Math.hypot(1, f.m);

    // A marker of another colour over the gap that both stretches point at: the data point.
    const occ = occluderOnChord(maps, a, b);
    if (
      occ &&
      occ.cx > a.px - 1 &&
      occ.cx < b.px + 1 &&
      (l || r) &&
      (!l || lineDist(l, occ.cx, occ.cy) <= near) &&
      (!r || lineDist(r, occ.cx, occ.cy) <= near) &&
      inkFraction(maps, [a, { px: occ.cx, py: occ.cy }, b]) >= 0.6
    ) {
      out.push({ px: occ.cx, py: occ.cy, confidence: 0.7, corner: true });
      continue;
    }
    // Otherwise a kink between two straight stretches, its vertex on ink (not in a dash gap).
    if (!l || !r) continue;
    const turn = (Math.abs(Math.atan(l.m) - Math.atan(r.m)) * 180) / Math.PI;
    if (turn < MIN_TURN_DEGREES) continue;
    const x = (r.c - l.c) / (l.m - r.m);
    if (!(x > a.px - 1 && x < b.px + 1)) continue;
    const y = l.m * x + l.c;
    // Near the gap — a vertex hidden by a marker lies within the triangle the two stretches span
    // over it, farther from the chord the steeper they are — and the stretch to it on ink.
    const gapW = b.px - a.px;
    const chord = Math.abs(gapW * (a.py - y) - (a.px - x) * (b.py - a.py)) / Math.hypot(gapW, b.py - a.py);
    const reachV = (0.5 * Math.max(Math.abs(l.m), Math.abs(r.m)) + 0.75) * gapW + thickness;
    if (chord > reachV || inkFraction(maps, [a, { px: x, py: y }, b]) < 0.6) continue;
    out.push({ px: x, py: y, confidence: 0.7, corner: true });
  }
  return out;
}

/**
 * Share of a reconstructed stretch (a → hidden vertex → b, ends excluded) that runs over ink of
 * any colour: under a marker it is (nearly) all ink, across a dash gap it is background.
 */
function inkFraction(maps: InkMaps, poly: { px: number; py: number }[]): number {
  let ink = 0;
  let n = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[i + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(q.px - p.px, q.py - p.py)));
    for (let s = i === 0 ? 1 : 0; s < k; s++) {
      n++;
      if (onInk(maps, p.px + ((q.px - p.px) * s) / k, p.py + ((q.py - p.py) * s) / k, 0)) ink++;
    }
  }
  return n ? ink / n : 0;
}

/** The first compact blob of another colour met along the chord a → b, if any. */
function occluderOnChord(maps: InkMaps, a: PathPoint, b: PathPoint): { cx: number; cy: number; size: number } | null {
  const n = Math.ceil(Math.hypot(b.px - a.px, b.py - a.py));
  for (let s = 1; s < n; s++) {
    const x = Math.round(a.px + ((b.px - a.px) * s) / n);
    const y = Math.round(a.py + ((b.py - a.py) * s) / n);
    if (x < 0 || y < 0 || x >= maps.width || y >= maps.height || !maps.other[y * maps.width + x]) continue;
    return occluderAt(maps, x, y, 40);
  }
  return null;
}

/** The 8-connected blob of `other` ink at (x, y), or null when it is large or not compact. */
function occluderAt(maps: InkMaps, x: number, y: number, maxSize: number): { cx: number; cy: number; size: number } | null {
  const { width: w, height: h, other } = maps;
  const k0 = y * w + x;
  if (!other[k0]) return null;
  const seen = new Set<number>([k0]);
  const stack = [k0];
  let x0 = x;
  let x1 = x;
  let y0 = y;
  let y1 = y;
  let sx = 0;
  let sy = 0;
  while (stack.length) {
    const k = stack.pop()!;
    const px = k % w;
    const py = (k - px) / w;
    sx += px;
    sy += py;
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
    if (x1 - x0 >= maxSize || y1 - y0 >= maxSize) return null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (!other[nk] || seen.has(nk)) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Compact: a marker, not a stroke of text or a line.
  if (seen.size < 6 || Math.max(bw, bh) > 1.6 * Math.min(bw, bh) || seen.size < 0.45 * bw * bh) return null;
  return { cx: sx / seen.size, cy: sy / seen.size, size: Math.max(bw, bh) };
}

export function extendHiddenEnds(path: PathPoint[], thickness: number, maps: InkMaps): PathPoint[] {
  if (path.length < 3) return path;
  const reach = Math.max(8, 4 * thickness);
  const extend = (end: PathPoint, inner: PathPoint[], dir: 1 | -1): PathPoint | null => {
    const fit = fitLine(inner);
    if (!fit || end.corner) return null;
    const len = Math.hypot(1, fit.m);
    const ux = dir / len;
    const uy = (dir * fit.m) / len;
    for (let s = 1; s <= 12; s++) {
      const x = Math.round(end.px + s * ux);
      const y = Math.round(fit.m * (end.px + s * ux) + fit.c);
      if (x < 0 || y < 0 || x >= maps.width || y >= maps.height) return null;
      if (!maps.other[y * maps.width + x]) continue;
      const blob = occluderAt(maps, x, y, 40);
      if (!blob) return null;
      // The line must point at the blob's centre, and the centre must lie beyond the end.
      const off = Math.abs(blob.cy - (fit.m * blob.cx + fit.c)) / len;
      const along = (blob.cx - end.px) * ux + (blob.cy - end.py) * uy;
      if (off > Math.max(1.5, thickness) || along <= 0 || along > blob.size) return null;
      return { px: blob.cx, py: blob.cy, confidence: 0.7, corner: true };
    }
    return null;
  };
  const first = path[0]!;
  const last = path[path.length - 1]!;
  const head = extend(first, path.filter((p) => p.px <= first.px + reach && !p.corner), -1);
  const tail = extend(last, path.filter((p) => p.px >= last.px - reach && !p.corner), 1);
  return [...(head ? [head] : []), ...path, ...(tail ? [tail] : [])];
}
