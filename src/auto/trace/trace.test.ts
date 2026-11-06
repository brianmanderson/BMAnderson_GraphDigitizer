/**
 * The line tracer on synthetic RGBA images drawn here with exact geometry (antialiased by 4×4
 * supersampling, integer = pixel centre). Corpus-wide numbers live in `npm run bench:lines`;
 * these tests pin the behaviours the tracer must never lose.
 */

import { describe, expect, it } from 'vitest';
import { traceLine, type TraceRequest, type TraceResult } from './index.ts';
import { resample } from './resample.ts';
import type { PathPoint } from './curve.ts';

type RGB = [number, number, number];
interface P {
  x: number;
  y: number;
}

const SS = 4;

class Canvas {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
    bg: RGB = [255, 255, 255],
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) this.data.set([...bg, 255], i * 4);
  }

  /** Paint where `inside(x, y)` holds for supersamples, blending by the covered fraction. */
  paint(rgb: RGB, x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean): void {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.height - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(this.width - 1, Math.ceil(x1)); x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(x - 0.5 + (sx + 0.5) / SS, y - 0.5 + (sy + 0.5) / SS)) hit++;
          }
        }
        if (!hit) continue;
        const a = hit / (SS * SS);
        const k = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) this.data[k + c] = Math.round(this.data[k + c]! * (1 - a) + rgb[c]! * a);
      }
    }
  }

  /** A polyline stroke of the given width (round joins: distance to the nearest segment). */
  stroke(poly: P[], width: number, rgb: RGB): void {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const pad = width;
    const r = width / 2;
    this.paint(rgb, Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad, (x, y) => {
      for (let i = 0; i + 1 < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[i + 1]!;
        if (x < Math.min(a.x, b.x) - r || x > Math.max(a.x, b.x) + r || y < Math.min(a.y, b.y) - r || y > Math.max(a.y, b.y) + r) continue;
        if (segDist({ x, y }, a, b) <= r) return true;
      }
      return false;
    });
  }

  disc(c: P, diameter: number, rgb: RGB): void {
    const r = diameter / 2;
    this.paint(rgb, c.x - r - 1, c.y - r - 1, c.x + r + 1, c.y + r + 1, (x, y) => Math.hypot(x - c.x, y - c.y) <= r);
  }

  square(c: P, size: number, rgb: RGB): void {
    const h = size / 2;
    this.paint(rgb, c.x - h - 1, c.y - h - 1, c.x + h + 1, c.y + h + 1, (x, y) => Math.abs(x - c.x) <= h && Math.abs(y - c.y) <= h);
  }

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

const polyDist = (p: P, poly: P[]) => Math.min(...poly.slice(1).map((b, i) => segDist(p, poly[i]!, b)));
const pts = (r: TraceResult) => r.path.map((p) => ({ x: p.px, y: p.py }));

/** Plot box used by most tests: frame lines at x = 40 / 360, y = 20 / 260. */
const BOX: [number, number][] = [
  [40, 20],
  [360, 20],
  [360, 260],
  [40, 260],
];
const BLUE: RGB = [31, 119, 180];
const RED: RGB = [214, 39, 40];
const GREEN: RGB = [44, 160, 44];
const BLACK: RGB = [0, 0, 0];

function frame(c: Canvas, rgb: RGB = BLACK): void {
  const [tl, tr, br, bl] = BOX.map(([x, y]) => ({ x, y }));
  c.stroke([tl!, tr!, br!, bl!, tl!], 1.2, rgb);
}

const sine = (amp: number, phase: number, mid = 140): P[] =>
  Array.from({ length: 301 }, (_, i) => {
    const x = 50 + i;
    return { x, y: mid + amp * Math.sin((x - 50) / 45 + phase) };
  });

describe('traceLine: curves', () => {
  it('follows a smooth antialiased curve end to end with sub-pixel centreline accuracy', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const curve = sine(60, 0);
    c.stroke(curve, 1.6, BLUE);
    const r = traceLine(c.request(curve[120]!));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('curve');
    expect(Math.hypot(r.color[0] - BLUE[0], r.color[1] - BLUE[1], r.color[2] - BLUE[2])).toBeLessThan(60);
    const path = pts(r);
    expect(Math.min(...path.map((p) => p.x))).toBeLessThanOrEqual(51);
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThanOrEqual(349);
    const errs = path.map((p) => polyDist(p, curve)).sort((a, b) => a - b);
    expect(errs[Math.floor(errs.length / 2)]!).toBeLessThan(0.15);
    expect(errs[Math.floor(errs.length * 0.95)]!).toBeLessThan(0.5);
    // Ordered by px; suggested points are a subset of the right size, extrema included.
    for (let i = 1; i < r.path.length; i++) expect(r.path[i]!.px).toBeGreaterThanOrEqual(r.path[i - 1]!.px);
    expect(r.points.length).toBeGreaterThanOrEqual(20);
    expect(r.points.length).toBeLessThanOrEqual(30);
    const top = Math.min(...curve.map((p) => p.y));
    expect(r.points.some((p) => Math.abs(p.py - top) < 1)).toBe(true);
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('stays on its own series through a crossing with a curve of another colour', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const a = sine(60, 0);
    const b = sine(60, Math.PI);
    c.stroke(a, 2, BLUE);
    c.stroke(b, 2.5, RED); // drawn on top: hides the blue curve where they cross
    const r = traceLine(c.request(a[60]!));
    const path = pts(r);
    expect(path.every((p) => polyDist(p, a) < 1.5)).toBe(true);
    expect(Math.max(...path.map((p) => p.x)) - Math.min(...path.map((p) => p.x))).toBeGreaterThan(290);
  });

  it('bridges a curve hidden under a long stretch of another series', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const flat = [
      { x: 50, y: 140 },
      { x: 350, y: 140 },
    ];
    c.stroke(flat, 1.5, BLUE);
    c.stroke([{ x: 150, y: 140 }, { x: 240, y: 140 }], 4, RED); // 90 px over the curve
    const r = traceLine(c.request({ x: 80, y: 140 }));
    expect(Math.max(...r.path.map((p) => p.px))).toBeGreaterThan(345);
  });

  it('bridges the gaps of a dashed line', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const curve = sine(50, 0.5);
    for (let i = 0; i + 1 < curve.length; i += 14) c.stroke(curve.slice(i, i + 9), 1.8, GREEN);
    const r = traceLine(c.request(curve[2]!));
    expect(r.kind).toBe('curve');
    expect(Math.max(...r.path.map((p) => p.px))).toBeGreaterThan(330);
    expect(pts(r).every((p) => polyDist(p, curve) < 1)).toBe(true);
  });

  it('keeps step corners and vertical segments of a Kaplan–Meier curve with censoring marks', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const levels = [40, 70, 95, 130, 150, 190];
    const xs = [50, 100, 140, 210, 260, 300, 350];
    const step: P[] = [{ x: xs[0]!, y: levels[0]! }];
    for (let i = 1; i < levels.length; i++) step.push({ x: xs[i]!, y: levels[i - 1]! }, { x: xs[i]!, y: levels[i]! });
    step.push({ x: xs[xs.length - 1]!, y: levels[levels.length - 1]! });
    c.stroke(step, 1.5, RED);
    for (const [x, y] of [
      [75, 40],
      [180, 95],
      [320, 190],
    ] as const) {
      c.stroke([{ x, y: y - 4 }, { x, y: y + 4 }], 1.2, RED); // '+' censoring ticks of the same colour
    }
    const r = traceLine(c.request({ x: 170, y: 95 }));
    expect(r.kind).toBe('curve');
    const corners = step.slice(1, -1);
    for (const k of corners) {
      expect(r.points.some((p) => Math.hypot(p.px - k.x, p.py - k.y) < 1.2)).toBe(true);
    }
    expect(pts(r).every((p) => polyDist(p, step) < 1.5)).toBe(true);
  });

  it('traces a black curve on black axes without running into the frame', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const curve = [
      { x: 41, y: 230 },
      ...sine(40, 0, 150).filter((_, i) => i % 3 === 0),
    ];
    c.stroke(curve, 1.5, BLACK);
    for (const plotBox of [BOX, null]) {
      const r = traceLine(c.request(curve[40]!, { plotBox }));
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('curve');
      const path = pts(r);
      // Every point on the curve: nothing along the frame lines (x = 40 / 360, y = 20 / 260).
      expect(path.every((p) => polyDist(p, curve) < 1.5)).toBe(true);
      expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(345);
    }
  });

  it('does not follow a black frame that a black curve merges into', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const curve = Array.from({ length: 101 }, (_, i) => ({ x: 50 + 2 * i, y: 260 - 200 * Math.exp(-(2 * i) / 30) }));
    c.stroke(curve, 1.5, BLACK);
    const r = traceLine(c.request(curve[10]!));
    expect(r.ok).toBe(true);
    // Never up the right frame line or along the top.
    expect(r.path.every((p) => p.px < 355 && p.py > 25)).toBe(true);
  });

  it('does not take a green line for a black one', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const black = sine(40, 0, 100);
    const green = sine(40, 0, 180);
    c.stroke(black, 1.5, BLACK);
    c.stroke(green, 1.5, GREEN);
    c.stroke([{ x: 200, y: 100 }, { x: 200, y: 180 }], 1.5, GREEN); // green bridge touching both
    const r = traceLine(c.request(black[30]!));
    expect(pts(r).every((p) => polyDist(p, black) < 1.5)).toBe(true);
  });

  it('follows a dotted line in auto mode as a curve', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const curve = sine(50, 0.3);
    for (let i = 0; i < curve.length; i += 5) c.square(curve[i]!, 2, BLUE);
    const r = traceLine(c.request(curve[100]!));
    expect(r.kind).toBe('curve');
    expect(Math.max(...r.path.map((p) => p.px)) - Math.min(...r.path.map((p) => p.px))).toBeGreaterThan(280);
  });
});

/** The on-pieces of a dash pattern (`pattern` = on, off, on, off… in px) along a polyline. */
function dashes(poly: P[], pattern: number[]): P[][] {
  const out: P[][] = [];
  let k = 0;
  let left = pattern[0]!;
  let cur: P[] | null = [poly[0]!];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let t = 0;
    while (len - t > left) {
      t += left;
      const p = { x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len };
      if (cur) {
        cur.push(p);
        out.push(cur);
        cur = null;
      } else cur = [p];
      k = (k + 1) % pattern.length;
      left = pattern[k]!;
    }
    left -= len - t;
    if (cur) cur.push(b);
  }
  if (cur && cur.length > 1) out.push(cur);
  return out;
}

/** A Kaplan–Meier style staircase (steps-post) through the levels at the given x. */
function staircase(xs: number[], levels: number[]): P[] {
  const out: P[] = [{ x: xs[0]!, y: levels[0]! }];
  for (let i = 1; i < levels.length; i++) out.push({ x: xs[i]!, y: levels[i - 1]! }, { x: xs[i]!, y: levels[i]! });
  out.push({ x: xs[xs.length - 1]!, y: levels[levels.length - 1]! });
  return out;
}

describe('traceLine: line style and same-colour series', () => {
  it('reads the line style at the seed', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const solid = sine(15, 0, 50);
    const dashed = sine(15, 0, 100);
    const dotted = sine(15, 0, 150);
    const dashDot = sine(15, 0, 200);
    c.stroke(solid, 2.2, BLACK);
    for (const d of dashes(dashed, [8, 5])) c.stroke(d, 2.2, BLACK);
    for (const d of dashes(dotted, [0.1, 5])) c.stroke(d, 2.2, BLACK);
    for (const d of dashes(dashDot, [11, 5, 0.1, 5])) c.stroke(d, 2.2, BLACK);
    const at = (curve: P[]) => traceLine(c.request(curve[150]!));
    expect(at(solid).style).toBe('solid');
    expect(at(dashed).style).toBe('dashed');
    expect(at(dotted).style).toBe('dotted');
    expect(at(dashDot).style).toBe('dash-dot');
    for (const curve of [solid, dashed, dotted, dashDot]) expect(at(curve).kind).toBe('curve');
  });

  it('keeps a solid and a dashed step curve of one colour apart, with their corners', () => {
    const c = new Canvas(400, 280);
    frame(c);
    // Both start together at the top and interleave: same colour, told apart only by style.
    const solid = staircase([50, 90, 130, 180, 240, 300, 350], [40, 70, 100, 130, 160, 190]);
    const dashed = staircase([50, 110, 150, 200, 260, 320, 350], [40, 80, 112, 145, 178, 210]);
    c.stroke(solid, 1.8, BLACK);
    for (const d of dashes(dashed, [9, 6])) c.stroke(d, 1.8, BLACK);
    const s = traceLine(c.request({ x: 210, y: 130 }));
    expect(s.style).toBe('solid');
    expect(pts(s).every((p) => polyDist(p, solid) < 1.5)).toBe(true);
    expect(Math.max(...s.path.map((p) => p.px)) - Math.min(...s.path.map((p) => p.px))).toBeGreaterThan(280);
    for (const k of solid.slice(3, -1)) expect(s.points.some((p) => Math.hypot(p.px - k.x, p.py - k.y) < 2)).toBe(true);
    const onDash = dashes(dashed, [9, 6]).find((p) => p[0]!.y === 178 && p[p.length - 1]!.y === 178)!;
    const d = traceLine(c.request({ x: (onDash[0]!.x + onDash[onDash.length - 1]!.x) / 2, y: 178 }));
    expect(d.style).toBe('dashed');
    expect(pts(d).every((p) => polyDist(p, dashed) < 1.5)).toBe(true);
    // Across the solid curve four times, to its right end (left of x = 150 the two run together).
    expect(Math.min(...d.path.map((p) => p.px))).toBeLessThan(155);
    expect(Math.max(...d.path.map((p) => p.px))).toBeGreaterThan(345);
  });

  it('keeps a solid and a dashed curve of one colour apart through their crossing', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const a = sine(60, 0);
    const b = sine(60, Math.PI);
    c.stroke(a, 1.8, BLACK);
    for (const d of dashes(b, [9, 5])) c.stroke(d, 1.8, BLACK);
    for (const [curve, style] of [
      [a, 'solid'],
      [b, 'dashed'],
    ] as const) {
      const r = traceLine(c.request(curve[60]!));
      expect(r.style).toBe(style);
      expect(pts(r).every((p) => polyDist(p, curve) < 1.5)).toBe(true);
      expect(Math.max(...r.path.map((p) => p.px)) - Math.min(...r.path.map((p) => p.px))).toBeGreaterThan(280);
    }
  });

  it('takes a dash at a step corner for a line in auto mode, not for a marker', () => {
    const c = new Canvas(400, 280);
    frame(c);
    const dashed = staircase([50, 100, 150, 200, 250, 300, 350], [50, 80, 110, 140, 170, 200]);
    for (const d of dashes(dashed, [9, 6])) c.stroke(d, 1.8, BLACK);
    const corner = dashes(dashed, [9, 6]).find((d) => d.length > 2)!; // a dash that turns a corner
    const r = traceLine(c.request(corner[1]!));
    expect(r.kind).toBe('curve');
    expect(r.style).toBe('dashed');
  });
});

describe('traceLine: polylines with a marker on every vertex', () => {
  // Sharp V and Λ reversals at the data points, like fixtures/synthetic/synthetic-linear.png.
  const vertices: P[] = [
    { x: 60, y: 200 },
    { x: 120, y: 120 },
    { x: 170, y: 60 },
    { x: 240, y: 170 },
    { x: 290, y: 40 },
    { x: 340, y: 150 },
  ];
  const segments = vertices.slice(1).map((b, i) => ({ x: (vertices[i]!.x + b.x) / 2, y: (vertices[i]!.y + b.y) / 2 }));

  for (const markerColour of ['another colour', 'its own colour'] as const) {
    it(`traces through markers of ${markerColour} from any segment, with a point on every vertex`, () => {
      const c = new Canvas(400, 280);
      frame(c);
      c.stroke(vertices, 1.5, BLUE);
      for (const v of vertices) c.disc(v, 9, markerColour === 'another colour' ? RED : BLUE);
      for (const seed of segments) {
        const r = traceLine(c.request(seed));
        expect(r.kind).toBe('curve');
        for (const v of vertices) expect(r.points.some((p) => Math.hypot(p.px - v.x, p.py - v.y) <= 1.5)).toBe(true);
        // On the line, or through the body of a marker on it.
        expect(pts(r).every((p) => polyDist(p, vertices) < 1.5 || vertices.some((v) => Math.hypot(p.x - v.x, p.y - v.y) <= 4.5))).toBe(true);
      }
    });
  }
});

describe('traceLine: markers', () => {
  const centres: P[] = [
    { x: 70.3, y: 200.6 },
    { x: 110.8, y: 80.2 },
    { x: 150.1, y: 170.5 },
    { x: 185.6, y: 60.9 },
    { x: 230.2, y: 120.4 },
    { x: 262.7, y: 220.1 },
    { x: 300.4, y: 90.7 },
    { x: 335.5, y: 150.3 },
  ];

  it('finds every marker of the clicked colour with sub-pixel centroids, and nothing else', () => {
    const c = new Canvas(400, 280);
    frame(c);
    c.stroke(sine(50, 0), 1.5, RED); // a line of another colour through the plot
    for (const p of centres) c.square(p, 7, BLUE);
    c.square({ x: 200, y: 240 }, 7, GREEN); // a marker of another series
    c.stroke([{ x: 60, y: 40 }, { x: 160, y: 40 }], 2, BLUE); // a line of the same colour (legend sample)
    const r = traceLine(c.request({ x: 150, y: 170 }));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('markers');
    expect(r.path).toHaveLength(centres.length);
    for (const p of centres) expect(r.path.some((q) => Math.hypot(q.px - p.x, q.py - p.y) < 0.3)).toBe(true);
    expect(r.points).toEqual(r.path);
    for (let i = 1; i < r.path.length; i++) expect(r.path[i]!.px).toBeGreaterThanOrEqual(r.path[i - 1]!.px);
  });

  it('honours an explicit mode', () => {
    const c = new Canvas(400, 280);
    frame(c);
    for (const p of centres) c.square(p, 7, BLUE);
    expect(traceLine(c.request(centres[2]!, { mode: 'markers' })).kind).toBe('markers');
    const line = new Canvas(400, 280);
    line.stroke(sine(50, 0), 2, BLUE);
    const r = traceLine(line.request(sine(50, 0)[100]!, { mode: 'markers' }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('none');
    expect(r.message).toMatch(/line/);
  });
});

describe('traceLine: find points (markers by shape)', () => {
  const WHITE: RGB = [255, 255, 255];
  /** A marker with vertical and horizontal error bars and caps, drawn under it. */
  const withBars = (c: Canvas, p: P, rgb: RGB) => {
    c.stroke([{ x: p.x, y: p.y - 22 }, { x: p.x, y: p.y + 18 }], 1.6, rgb);
    c.stroke([{ x: p.x - 4, y: p.y - 22 }, { x: p.x + 4, y: p.y - 22 }], 1.6, rgb);
    c.stroke([{ x: p.x - 4, y: p.y + 18 }, { x: p.x + 4, y: p.y + 18 }], 1.6, rgb);
    c.stroke([{ x: p.x - 16, y: p.y }, { x: p.x + 14, y: p.y }], 1.6, rgb);
  };
  const filled = (c: Canvas, p: P) => {
    withBars(c, p, BLACK);
    c.disc(p, 12, BLACK);
  };
  const open = (c: Canvas, p: P) => {
    withBars(c, p, BLACK);
    c.disc(p, 12, BLACK);
    c.disc(p, 8.4, WHITE);
  };
  const F = [
    { x: 80, y: 70 },
    { x: 150, y: 120 },
    { x: 230, y: 90 },
    { x: 300, y: 200 },
  ];
  const O = [
    { x: 110, y: 190 },
    { x: 190, y: 60 },
    { x: 260, y: 160 },
    { x: 330, y: 110 },
  ];
  const chart = () => {
    const c = new Canvas(400, 280);
    frame(c);
    F.forEach((p) => filled(c, p));
    O.forEach((p) => open(c, p));
    for (let x = 45; x < 355; x += 12) c.stroke([{ x, y: 120 }, { x: x + 7, y: 120 }], 1.4, BLACK); // dashed reference line
    // Legend: a sample of each marker with a word beside it.
    c.disc({ x: 70, y: 240 }, 12, BLACK);
    c.disc({ x: 70, y: 220 }, 12, BLACK);
    c.disc({ x: 70, y: 220 }, 8.4, WHITE);
    for (const y of [220, 240]) for (let k = 0; k < 5; k++) c.square({ x: 88 + 9 * k, y }, 6, BLACK);
    return c;
  };
  const near = (r: TraceResult, set: P[]) => set.every((q) => r.path.some((p) => Math.hypot(p.px - q.x, p.py - q.y) < 1)) && r.path.length === set.length;

  for (const mode of ['markers', 'auto'] as const) {
    it(`finds every filled marker and only those, despite error bars and a line through one (${mode})`, () => {
      const r = traceLine(chart().request({ x: F[2]!.x + 2, y: F[2]!.y + 2 }, { mode }));
      expect(r.kind).toBe('markers');
      expect(near(r, F)).toBe(true);
    });

    it(`finds every open marker and only those, from a click on its ring (${mode})`, () => {
      const r = traceLine(chart().request({ x: O[0]!.x + 3, y: O[0]!.y - 3 }, { mode }));
      expect(r.kind).toBe('markers');
      expect(near(r, O)).toBe(true);
    });
  }
});

describe('traceLine: failures', () => {
  it('reports a click on the background or the frame without throwing', () => {
    const c = new Canvas(400, 280);
    frame(c);
    c.stroke(sine(50, 0), 1.5, BLUE);
    const bg = traceLine(c.request({ x: 200, y: 250 }));
    expect(bg).toMatchObject({ ok: false, kind: 'none', path: [], points: [] });
    expect(bg.message).toBeTruthy();
    const out = traceLine(c.request({ x: -5, y: 10 }));
    expect(out.ok).toBe(false);
    const bad = traceLine({ ...c.request({ x: 100, y: 100 }), width: 10 });
    expect(bad.ok).toBe(false);
  });
});

describe('resample', () => {
  const pp = (px: number, py: number, corner = false): PathPoint => ({ px, py, confidence: 1, corner });

  it('spreads maxPoints over a smooth path and keeps its ends and extrema', () => {
    const path = Array.from({ length: 300 }, (_, i) => pp(i, 100 + 40 * Math.sin(i / 50)));
    const out = resample(path, 12, 1.5);
    expect(out.length).toBeGreaterThanOrEqual(11);
    expect(out.length).toBeLessThanOrEqual(13);
    expect(out[0]!.px).toBe(0);
    expect(out[out.length - 1]!.px).toBe(299);
    const peak = Math.round(50 * (Math.PI / 2));
    expect(out.some((p) => Math.abs(p.px - peak) <= 1)).toBe(true);
  });

  it('keeps every corner even beyond maxPoints', () => {
    const path: PathPoint[] = [];
    for (let s = 0; s < 20; s++) {
      for (let x = s * 10; x < s * 10 + 10; x++) path.push(pp(x, 50 + 5 * s, x === s * 10 && s > 0));
    }
    const out = resample(path, 5, 1.5);
    expect(out.length).toBeGreaterThanOrEqual(19);
  });
});
