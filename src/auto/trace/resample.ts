/**
 * Suggested points from a traced centreline.
 *
 * Kept always (even beyond `maxPoints`): both ends, every step corner, every local extremum in y
 * whose prominence is at least max(3 px, 2 line widths), and every sharp kink (a vertex of the
 * Douglas–Peucker simplification at tolerance max(0.75 px, ½ line width) where the direction turns
 * by ≥ 30°, e.g. the data points of a polyline chart). The rest of the budget is spread evenly in x
 * over the non-vertical stretches between them, in proportion to their width, each snapped to the
 * nearest traced point (so its confidence is the trace's).
 */

import type { PathPoint } from './curve.ts';
import type { TracedPoint } from './types.ts';

const KINK_DEGREES = 30;

/** Indices of y extrema with at least `prominence` px of rise/fall on both sides (zigzag). */
function extrema(path: PathPoint[], prominence: number): number[] {
  const out: number[] = [];
  let hi = 0;
  let lo = 0;
  let dir = 0; // +1: tracking a maximum of y (lowest on screen), −1: a minimum
  for (let i = 1; i < path.length; i++) {
    const y = path[i]!.py;
    if (dir === 0) {
      if (y > path[hi]!.py) hi = i;
      if (y < path[lo]!.py) lo = i;
      if (path[hi]!.py - path[lo]!.py >= prominence) {
        // The first extreme is the one reached first; the other is now being tracked.
        if (hi > lo) {
          if (lo > 0) out.push(lo);
          dir = 1;
        } else {
          if (hi > 0) out.push(hi);
          dir = -1;
        }
      }
    } else if (dir > 0) {
      if (y > path[hi]!.py) hi = i;
      else if (path[hi]!.py - y >= prominence) {
        out.push(hi);
        dir = -1;
        lo = i;
      }
    } else {
      if (y < path[lo]!.py) lo = i;
      else if (y - path[lo]!.py >= prominence) {
        out.push(lo);
        dir = 1;
        hi = i;
      }
    }
  }
  return out;
}

function douglasPeucker(path: PathPoint[], a: number, b: number, eps: number, out: Set<number>): void {
  const p = path[a]!;
  const q = path[b]!;
  const dx = q.px - p.px;
  const dy = q.py - p.py;
  const len = Math.hypot(dx, dy);
  let worst = -1;
  let worstD = eps;
  for (let i = a + 1; i < b; i++) {
    const r = path[i]!;
    const d = len > 1e-9 ? Math.abs((r.px - p.px) * dy - (r.py - p.py) * dx) / len : Math.hypot(r.px - p.px, r.py - p.py);
    if (d > worstD) {
      worstD = d;
      worst = i;
    }
  }
  if (worst < 0) return;
  out.add(worst);
  douglasPeucker(path, a, worst, eps, out);
  douglasPeucker(path, worst, b, eps, out);
}

function turnDegrees(a: PathPoint, v: PathPoint, b: PathPoint): number {
  const ux = v.px - a.px;
  const uy = v.py - a.py;
  const wx = b.px - v.px;
  const wy = b.py - v.py;
  const nu = Math.hypot(ux, uy);
  const nw = Math.hypot(wx, wy);
  if (nu < 1e-9 || nw < 1e-9) return 0;
  const c = Math.max(-1, Math.min(1, (ux * wx + uy * wy) / (nu * nw)));
  return (Math.acos(c) * 180) / Math.PI;
}

export function resample(path: PathPoint[], maxPoints: number, thickness: number): TracedPoint[] {
  const n = path.length;
  const strip = (p: PathPoint): TracedPoint => ({ px: p.px, py: p.py, confidence: p.confidence });
  if (n <= 2) return path.map(strip);
  const keep = new Set<number>([0, n - 1]);
  path.forEach((p, i) => p.corner && keep.add(i));
  for (const i of extrema(path, Math.max(3, 2 * thickness))) keep.add(i);

  // Kinks: Douglas–Peucker between the points kept so far, then the vertices that turn sharply.
  const fixed = [...keep].sort((a, b) => a - b);
  const dp = new Set<number>(fixed);
  for (let s = 0; s + 1 < fixed.length; s++) douglasPeucker(path, fixed[s]!, fixed[s + 1]!, Math.max(0.75, thickness / 2), dp);
  const verts = [...dp].sort((a, b) => a - b);
  for (let s = 1; s + 1 < verts.length; s++) {
    const i = verts[s]!;
    if (keep.has(i)) continue;
    if (turnDegrees(path[verts[s - 1]!]!, path[i]!, path[verts[s + 1]!]!) >= KINK_DEGREES) keep.add(i);
  }

  const budget = Math.max(2, Math.floor(maxPoints)) - keep.size;
  if (budget > 0) {
    const sorted = [...keep].sort((a, b) => a - b);
    const spans: { a: number; b: number; len: number }[] = [];
    for (let s = 0; s + 1 < sorted.length; s++) {
      const a = sorted[s]!;
      const b = sorted[s + 1]!;
      const len = path[b]!.px - path[a]!.px;
      if (b - a > 1 && len >= 1) spans.push({ a, b, len });
    }
    const total = spans.reduce((s, x) => s + x.len, 0);
    if (total > 0) {
      // Largest-remainder allocation of the budget by width.
      const quotas = spans.map((x) => (budget * x.len) / total);
      const counts = quotas.map(Math.floor);
      let left = budget - counts.reduce((s, c) => s + c, 0);
      const order = quotas.map((q, i) => ({ i, f: q - Math.floor(q) })).sort((p, q) => q.f - p.f || p.i - q.i);
      for (const { i } of order) {
        if (left <= 0) break;
        counts[i]!++;
        left--;
      }
      spans.forEach((sp, si) => {
        const k = Math.min(counts[si]!, sp.b - sp.a - 1);
        const xa = path[sp.a]!.px;
        let from = sp.a + 1;
        for (let j = 1; j <= k; j++) {
          const target = xa + (sp.len * j) / (k + 1);
          // Path x is non-decreasing: walk forward to the nearest point at or after `from`.
          let best = from;
          for (let i = from; i < sp.b; i++) {
            if (Math.abs(path[i]!.px - target) <= Math.abs(path[best]!.px - target)) best = i;
            else if (path[i]!.px > target) break;
          }
          keep.add(best);
          from = Math.min(sp.b - 1, best + 1);
        }
      });
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => strip(path[i]!));
}
