/**
 * The area the tracer may use: the plot box (a quadrilateral, possibly rotated) or the whole
 * image. Its edges are where the axis and frame lines are drawn; `excludeEdgeLines` removes such a
 * line from the coverage map only when it has the series' own colour (a black curve on black
 * axes), because a coloured curve may legitimately run along a black axis (a Kaplan–Meier curve
 * sitting on y = 0) and the colour model already ignores the axis there.
 */

import { ON_ALPHA } from './color.ts';

export interface Region {
  width: number;
  height: number;
  /** Inclusive integer bounding box of the usable pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 1 where a pixel may belong to the series (image-sized). */
  mask: Uint8Array;
  /** The quadrilateral (TL, TR, BR, BL), or null for the whole image. */
  quad: [number, number][] | null;
}

/** How far outside an edge without a line of the series' colour pixels are still used, px. */
const OUTSIDE_SLACK = 1.5;

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit normal pointing into the quadrilateral. */
  nx: number;
  ny: number;
}

function edges(quad: [number, number][]): Edge[] {
  const cx = quad.reduce((s, p) => s + p[0], 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p[1], 0) / quad.length;
  return quad.map((a, i) => {
    const b = quad[(i + 1) % quad.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { ax: a[0], ay: a[1], bx: b[0], by: b[1], nx, ny };
  });
}

/** Signed distances into the quadrilateral from each edge. */
const inward = (e: Edge, x: number, y: number) => (x - e.ax) * e.nx + (y - e.ay) * e.ny;

function fill(region: Region, margins: number[]): void {
  const { width: w, height: h, quad, mask } = region;
  mask.fill(0);
  if (!quad) {
    mask.fill(1);
    region.x0 = 0;
    region.y0 = 0;
    region.x1 = w - 1;
    region.y1 = h - 1;
    return;
  }
  const es = edges(quad);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  const bx0 = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[0])) - OUTSIDE_SLACK));
  const bx1 = Math.min(w - 1, Math.ceil(Math.max(...quad.map((p) => p[0])) + OUTSIDE_SLACK));
  const by0 = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[1])) - OUTSIDE_SLACK));
  const by1 = Math.min(h - 1, Math.ceil(Math.max(...quad.map((p) => p[1])) + OUTSIDE_SLACK));
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      let ok = true;
      for (let i = 0; i < es.length && ok; i++) ok = inward(es[i]!, x, y) >= margins[i]!;
      if (!ok) continue;
      mask[y * w + x] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) {
    x0 = y0 = 0;
    x1 = y1 = -1;
  }
  Object.assign(region, { x0, y0, x1, y1 });
}

export function makeRegion(width: number, height: number, quad: [number, number][] | null): Region {
  const region: Region = { width, height, x0: 0, y0: 0, x1: -1, y1: -1, mask: new Uint8Array(width * height), quad };
  fill(region, quad ? quad.map(() => -OUTSIDE_SLACK) : []);
  return region;
}

/**
 * For each edge, look for a straight line of the series' colour along it (at offsets −4…+8 px
 * from the edge, inward positive): offsets where at least half of the samples along the edge are
 * "on". When found, everything up to one pixel inside the line is dropped from the region and
 * from `alpha`. Returns how many edges were excluded.
 */
export function excludeEdgeLines(region: Region, alpha: Float32Array): number {
  const { quad, width: w, height: h } = region;
  if (!quad) return 0;
  const es = edges(quad);
  const margins: number[] = [];
  let excluded = 0;
  for (const e of es) {
    const len = Math.hypot(e.bx - e.ax, e.by - e.ay);
    const samples = Math.max(8, Math.floor(len / 2));
    let lastOn = Number.NEGATIVE_INFINITY;
    for (let k = -4; k <= 8; k++) {
      let on = 0;
      let n = 0;
      for (let s = 0; s < samples; s++) {
        const f = 0.05 + (0.9 * (s + 0.5)) / samples;
        const x = Math.round(e.ax + f * (e.bx - e.ax) + k * e.nx);
        const y = Math.round(e.ay + f * (e.by - e.ay) + k * e.ny);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        n++;
        if ((alpha[y * w + x] ?? -1) >= ON_ALPHA) on++;
      }
      const isLine = n > 0 && on >= 0.5 * n;
      // The band must start at the edge (|k| ≤ 2) and be contiguous.
      if (isLine && (lastOn === k - 1 || (lastOn === Number.NEGATIVE_INFINITY && Math.abs(k) <= 2))) lastOn = k;
      else if (lastOn !== Number.NEGATIVE_INFINITY) break;
    }
    if (lastOn === Number.NEGATIVE_INFINITY) margins.push(-OUTSIDE_SLACK);
    else {
      margins.push(lastOn + 1);
      excluded++;
    }
  }
  if (!excluded) return 0;
  fill(region, margins);
  for (let k = 0; k < alpha.length; k++) if (!region.mask[k]) alpha[k] = -1;
  return excluded;
}

/** Whether a point lies inside the quadrilateral (within `slack` px), or true without one. */
export function insideQuad(quad: [number, number][] | null, x: number, y: number, slack = 0): boolean {
  if (!quad) return true;
  return edges(quad).every((e) => inward(e, x, y) >= -slack);
}
