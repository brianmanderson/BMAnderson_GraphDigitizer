/**
 * Stroke markers ("x", "+") and open markers with a line through them (cross.ts, the open-marker
 * fit in markers.ts), on synthetic RGBA images drawn with exact geometry (4×4 supersampling,
 * integer = pixel centre), as in trace.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { crossAtSeed, crossFits, crossTemplate, findCrosses } from './cross.ts';
import { traceLine, type TraceRequest } from './index.ts';

type RGB = [number, number, number];
interface P {
  x: number;
  y: number;
}

const SS = 4;
const BLACK: RGB = [0, 0, 0];
const BOX: [number, number][] = [
  [40, 20],
  [360, 20],
  [360, 260],
  [40, 260],
];

class Canvas {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }

  paint(rgb: RGB, x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean): void {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.height - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(this.width - 1, Math.ceil(x1)); x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(x - 0.5 + (sx + 0.5) / SS, y - 0.5 + (sy + 0.5) / SS)) hit++;
        if (!hit) continue;
        const a = hit / (SS * SS);
        const k = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) this.data[k + c] = Math.round(this.data[k + c]! * (1 - a) + rgb[c]! * a);
      }
    }
  }

  stroke(poly: P[], width: number, rgb: RGB = BLACK): void {
    const r = width / 2;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    this.paint(rgb, Math.min(...xs) - width, Math.min(...ys) - width, Math.max(...xs) + width, Math.max(...ys) + width, (x, y) =>
      poly.slice(1).some((b, i) => segDist({ x, y }, poly[i]!, b) <= r),
    );
  }

  disc(c: P, diameter: number, rgb: RGB = BLACK): void {
    const r = diameter / 2;
    this.paint(rgb, c.x - r - 1, c.y - r - 1, c.x + r + 1, c.y + r + 1, (x, y) => Math.hypot(x - c.x, y - c.y) <= r);
  }

  ring(c: P, diameter: number, width: number, rgb: RGB = BLACK): void {
    const r = diameter / 2;
    this.paint(rgb, c.x - r - width, c.y - r - width, c.x + r + width, c.y + r + width, (x, y) => Math.abs(Math.hypot(x - c.x, y - c.y) - r) <= width / 2);
  }

  /** An "x" (or, `plus`, a "+") of the given size: two strokes through its centre. */
  cross(c: P, size: number, width: number, plus = false): void {
    const h = size / 2;
    if (plus) {
      this.stroke([{ x: c.x - h, y: c.y }, { x: c.x + h, y: c.y }], width);
      this.stroke([{ x: c.x, y: c.y - h }, { x: c.x, y: c.y + h }], width);
    } else {
      this.stroke([{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y + h }], width);
      this.stroke([{ x: c.x - h, y: c.y + h }, { x: c.x + h, y: c.y - h }], width);
    }
  }

  /** Coverage of black ink. */
  cov = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const k = (y * this.width + x) * 4;
    return 1 - (this.data[k]! + this.data[k + 1]! + this.data[k + 2]!) / 765;
  };

  request(seed: P, extra: Partial<TraceRequest> = {}): TraceRequest {
    return { rgba: this.data, width: this.width, height: this.height, plotBox: BOX, seed: { px: seed.x, py: seed.y }, mode: 'auto', maxPoints: 25, ...extra };
  }
}

function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

const near = (found: { px: number; py: number }[], p: P, tol = 2) => found.some((q) => Math.hypot(q.px - p.x, q.py - p.y) <= tol);

describe('cross.ts: stroke-marker profile', () => {
  it('tells a small "x" from a dot of its size, and from a "+"', () => {
    const c = new Canvas(120, 60);
    const xs = [{ x: 20, y: 20 }, { x: 50, y: 20.5 }];
    for (const p of xs) c.cross(p, 5, 1.1);
    const dot = { x: 80, y: 20 };
    c.disc(dot, 4);
    const plus = { x: 100, y: 20 };
    c.cross(plus, 5, 1.1, true);
    const t = crossTemplate(c.cov, 20, 20, 5);
    expect(t).not.toBeNull();
    expect(crossFits(c.cov, t!, xs[1]!.x, xs[1]!.y)).toBe(true);
    expect(crossFits(c.cov, t!, dot.x, dot.y)).toBe(false);
    expect(crossFits(c.cov, t!, plus.x, plus.y)).toBe(false);
    // A dot has no troughs: no stroke template at all.
    expect(crossTemplate(c.cov, dot.x, dot.y, 4)).toBeNull();
  });

  it('finds "x" markers drawn on a line by their arms, not the line\'s corners or crossings', () => {
    const c = new Canvas(400, 280);
    const xs = [60, 110, 160, 210, 260, 310].map((x, i) => ({ x, y: 140 + (i % 2 ? -35 : 35) }));
    c.stroke(xs, 1.5);
    // A second line crossing the first, with no markers.
    c.stroke([{ x: 50, y: 60 }, { x: 330, y: 230 }], 1.5);
    for (const p of xs) c.cross(p, 9, 1.2);
    const bounds = { x0: 0, y0: 0, x1: 399, y1: 279 };
    const t = crossAtSeed(c.cov, bounds, Math.round(xs[2]!.x + 3), Math.round(xs[2]!.y + 3), 15);
    expect(t).not.toBeNull();
    const found = findCrosses(c.cov, bounds, t!);
    for (const p of xs) expect(near(found, p, 1.5)).toBe(true);
    expect(found.length).toBe(xs.length);
  });
});

describe('traceLine: stroke markers on lines', () => {
  it('reads thin "x" markers on their polyline as markers (auto mode), not the "+" series beside them', () => {
    const c = new Canvas(400, 280);
    const xs = [70, 120, 170, 220, 270, 320].map((x, i) => ({ x, y: 100 + 12 * Math.sin(i) }));
    const ps = [70, 120, 170, 220, 270, 320].map((x, i) => ({ x: x + 10, y: 200 + 12 * Math.cos(i) }));
    c.stroke(xs, 1.5);
    c.stroke(ps, 1.5);
    for (const p of xs) c.cross(p, 9, 1.2);
    for (const p of ps) c.cross(p, 10, 1.2, true);
    const r = traceLine(c.request({ x: Math.round(xs[3]!.x + 3), y: Math.round(xs[3]!.y - 3) }));
    expect(r.kind).toBe('markers');
    for (const p of xs) expect(near(r.path, p)).toBe(true);
    for (const p of ps) expect(near(r.path, p, 4)).toBe(false);
    expect(r.path.length).toBe(xs.length);
  });
});

describe('traceLine: small "x" among dots of their colour', () => {
  /** A small deterministic generator. */
  const rand = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  it('finds the "x" markers, not the dots (single or in clusters)', () => {
    const c = new Canvas(400, 280);
    const r = rand(11);
    const xs: P[] = [];
    const dots: P[] = [];
    const clear = (p: P, d: number) => [...xs, ...dots].every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= d);
    while (dots.length < 120) {
      const p = { x: 55 + 290 * r(), y: 35 + 210 * r() };
      if (clear(p, 6)) dots.push(p);
    }
    // Clusters of dots: overlapping pairs and threes.
    for (let i = 0; i < 20; i++) dots.push({ x: dots[i]!.x + 2.5, y: dots[i]!.y + (i % 2 ? 1.5 : -1) });
    while (xs.length < 30) {
      const p = { x: 55 + 290 * r(), y: 35 + 210 * r() };
      if (clear(p, 9)) xs.push(p);
    }
    for (const p of dots) c.disc(p, 3.9);
    for (const p of xs) c.cross(p, 4.8, 1.0);
    const res = traceLine(c.request({ x: Math.round(xs[4]!.x), y: Math.round(xs[4]!.y) }, { mode: 'markers' }));
    expect(res.kind).toBe('markers');
    const matched = xs.filter((p) => near(res.path, p)).length;
    expect(matched / xs.length).toBeGreaterThan(0.8);
    const stray = res.path.filter((q) => !xs.some((p) => Math.hypot(q.px - p.x, q.py - p.y) <= 2));
    expect(stray.length).toBeLessThanOrEqual(2);
  });
});

describe('traceLine: open markers with a line through them', () => {
  it('cuts the clicked ring out whole across the line through it, and finds the others with or without one', () => {
    const c = new Canvas(400, 280);
    const rings = [70, 110, 150, 190, 230, 270, 310].map((x, i) => ({ x, y: 80 + 30 * (i % 3) }));
    const filled = [90, 170, 250, 330].map((x) => ({ x, y: 220 }));
    for (const p of rings) c.ring(p, 15, 1.6);
    for (const p of filled) c.disc(p, 16.6);
    // Lines of the series' colour through the clicked ring (off its centre) and two others.
    c.stroke([{ x: 160, y: 104 }, { x: 205, y: 82 }], 1.5);
    c.stroke([{ x: 50, y: 82 }, { x: 95, y: 77 }], 1.5);
    c.stroke([{ x: 290, y: 90 }, { x: 330, y: 125 }], 1.5);
    const r = traceLine(c.request({ x: 190, y: 79 }));
    expect(r.kind).toBe('markers');
    for (const p of rings) expect(near(r.path, p)).toBe(true);
    for (const p of filled) expect(near(r.path, p, 4)).toBe(false);
    expect(r.path.length).toBe(rings.length);
  });
});
