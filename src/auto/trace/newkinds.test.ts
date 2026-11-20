/**
 * The tracer on kinds the column walker cannot do (docs/SPEC.md → Auto-trace → Curves that double
 * back, Bars): a closed loop, a curve that folds over, and bar charts. Synthetic RGBA drawn here
 * with exact geometry (4×4 supersampling, integer = pixel centre); corpus-wide numbers are in
 * `npm run bench:lines` (l200–l229).
 */

import { describe, expect, it } from 'vitest';
import { pickPoints } from './follow.ts';
import { traceLine, type TraceRequest, type TraceResult } from './index.ts';

type RGB = [number, number, number];
interface P {
  x: number;
  y: number;
}

const SS = 4;
const BLUE: RGB = [31, 119, 180];
const ORANGE: RGB = [255, 127, 14];

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

  /** A filled rectangle with its edges at x0, x1, y0, y1 (continuous coordinates). */
  rect(x0: number, y0: number, x1: number, y1: number, rgb: RGB): void {
    this.paint(rgb, x0 - 1, y0 - 1, x1 + 1, y1 + 1, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  }

  /** A round-jointed polyline stroke: supersamples within width/2 of a segment, segment by segment. */
  stroke(poly: P[], width: number, rgb: RGB): void {
    const r = width / 2;
    const W = this.width * SS;
    const hit = new Uint8Array(W * this.height * SS);
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const sx0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r + 0.5) * SS));
      const sx1 = Math.min(W - 1, Math.ceil((Math.max(a.x, b.x) + r + 0.5) * SS));
      const sy0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r + 0.5) * SS));
      const sy1 = Math.min(this.height * SS - 1, Math.ceil((Math.max(a.y, b.y) + r + 0.5) * SS));
      for (let sy = sy0; sy <= sy1; sy++) {
        const y = (sy + 0.5) / SS - 0.5;
        for (let sx = sx0; sx <= sx1; sx++) {
          const x = (sx + 0.5) / SS - 0.5;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
          if (Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= r) hit[sy * W + sx] = 1;
        }
      }
    }
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let n = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) n += hit[(y * SS + sy) * W + x * SS + sx]!;
        if (!n) continue;
        const f = n / (SS * SS);
        const k = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) this.data[k + c] = Math.round(this.data[k + c]! * (1 - f) + rgb[c]! * f);
      }
    }
  }

  /** `box`: the plot box the app would pass (default: none given, so `detectAxes` looks for one). */
  trace(seed: P, mode: TraceRequest['mode'] = 'auto', maxPoints = 25, box: [number, number][] | null = null): TraceResult {
    return traceLine({ rgba: this.data, width: this.width, height: this.height, plotBox: box, seed: { px: seed.x, py: seed.y }, mode, maxPoints });
  }
}

const dist = (p: { px: number; py: number }, poly: P[]): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.px - a.x) * dx + (p.py - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.px - (a.x + t * dx), p.py - (a.y + t * dy)));
  }
  return best;
};

const lengthOf = (pts: { px: number; py: number }[]) => pts.slice(1).reduce((L, p, i) => L + Math.hypot(p.px - pts[i]!.px, p.py - pts[i]!.py), 0);

describe('curves that double back (follow.ts)', () => {
  const ellipse = (n: number): P[] => Array.from({ length: n + 1 }, (_, i) => ({ x: 200 + 140 * Math.cos((2 * Math.PI * i) / n), y: 150 + 60 * Math.sin((2 * Math.PI * i) / n + 0.6) }));

  it('follows a closed loop all the way round, in drawing order, ending where it starts', () => {
    const c = new Canvas(400, 300);
    const loop = ellipse(720);
    c.stroke(loop, 2, BLUE);
    const r = c.trace({ x: Math.round(loop[100]!.x), y: Math.round(loop[100]!.y) });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('curve');
    expect(r.path.every((p) => dist(p, loop) <= 1)).toBe(true);
    // The whole loop, once: its length within 3 % of the ellipse's.
    expect(lengthOf(r.path) / lengthOf(loop.map((q) => ({ px: q.x, py: q.y })))).toBeGreaterThan(0.97);
    expect(lengthOf(r.path) / lengthOf(loop.map((q) => ({ px: q.x, py: q.y })))).toBeLessThan(1.03);
    // Closed: the last point is the first; it starts at the leftmost point.
    expect(r.path[0]).toEqual(r.path[r.path.length - 1]);
    expect(r.points[0]).toEqual(r.points[r.points.length - 1]);
    expect(Math.min(...r.path.map((p) => p.px))).toBe(r.path[0]!.px);
    // The suggested points follow the loop in order: no chord cuts across it.
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i]!;
      const b = r.points[i + 1]!;
      expect(dist({ px: (a.px + b.px) / 2, py: (a.py + b.py) / 2 }, loop)).toBeLessThan(4);
    }
  });

  it('follows an S-curve through its folds (x is not a function of y alone)', () => {
    const c = new Canvas(400, 300);
    const s: P[] = Array.from({ length: 601 }, (_, i) => {
      const y = -2 + (4 * i) / 600;
      return { x: 200 + 40 * (y ** 3 - 3 * y), y: 150 - 60 * y };
    });
    c.stroke(s, 2, BLUE);
    const r = c.trace({ x: Math.round(s[300]!.x), y: Math.round(s[300]!.y) });
    expect(r.kind).toBe('curve');
    expect(r.path.every((p) => dist(p, s) <= 1)).toBe(true);
    const span = (pts: { py: number }[]) => Math.max(...pts.map((p) => p.py)) - Math.min(...pts.map((p) => p.py));
    expect(span(r.path)).toBeGreaterThan(0.95 * 240);
  });

  it('leaves a function of x to the column walker', () => {
    const c = new Canvas(400, 300);
    const wave: P[] = Array.from({ length: 301 }, (_, i) => ({ x: 50 + i, y: 150 + 60 * Math.sin(i / 40) }));
    c.stroke(wave, 2, BLUE);
    const r = c.trace({ x: 150, y: Math.round(150 + 60 * Math.sin(100 / 40)) });
    expect(r.kind).toBe('curve');
    // The column walk's path runs left to right.
    for (let i = 0; i + 1 < r.path.length; i++) expect(r.path[i + 1]!.px).toBeGreaterThanOrEqual(r.path[i]!.px);
  });

  it('pickPoints keeps the ends and cusps and spends the rest on the largest deviations', () => {
    const path = Array.from({ length: 101 }, (_, i) => ({ px: i, py: i === 50 ? 40 : Math.abs(i - 50) * 0.8, confidence: 1, corner: i === 50 }));
    const pts = pickPoints(path, 5);
    expect(pts[0]!.px).toBe(0);
    expect(pts[pts.length - 1]!.px).toBe(100);
    expect(pts.some((p) => p.px === 50)).toBe(true);
    expect(pts.length).toBeLessThanOrEqual(5);
  });
});

describe('bars (bars.ts)', () => {
  /** A bar chart: x-axis at y = 250, bars 30 px wide every 50 px. */
  const chart = (values: number[], rgb: RGB = BLUE, base = 250) => {
    const c = new Canvas(400, 300);
    c.stroke([{ x: 20, y: base + 1 }, { x: 380, y: base + 1 }], 1, [0, 0, 0]);
    values.forEach((v, i) => {
      const x = 50 + 50 * i;
      c.rect(x - 15, Math.min(base - v, base), x + 15, Math.max(base - v, base), rgb);
    });
    return c;
  };

  it('puts one point at the top-centre of every bar, from one click', () => {
    const values = [120, 60, 180, 90, 30, 150];
    const c = chart(values);
    const r = c.trace({ x: 100, y: 230 });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('markers');
    expect(r.points).toHaveLength(values.length);
    r.points.forEach((p, i) => {
      expect(p.px).toBeCloseTo(50 + 50 * i, 0);
      expect(p.py).toBeCloseTo(250 - values[i]!, 0);
    });
  });

  it('puts a bar below the baseline at its bottom edge', () => {
    const values = [80, -50, 120, -90];
    const c = chart(values, BLUE, 150);
    // The zero line runs through the plot: the box is the whole plot (a spine drawn at zero would
    // be taken for the x axis by detectAxes — SPEC → Known failures).
    const r = c.trace({ x: 50, y: 120 }, 'auto', 25, [[10, 10], [390, 10], [390, 290], [10, 290]]);
    expect(r.points).toHaveLength(4);
    r.points.forEach((p, i) => expect(p.py).toBeCloseTo(150 - values[i]!, 0));
  });

  it('finds stacked segments at their top edges, one series per colour', () => {
    const c = new Canvas(400, 300);
    const low = [60, 90, 40, 70];
    const high = [50, 30, 80, 40];
    low.forEach((v, i) => {
      const x = 60 + 70 * i;
      c.rect(x - 20, 250 - v, x + 20, 250, BLUE);
      c.rect(x - 20, 250 - v - high[i]!, x + 20, 250 - v, ORANGE);
    });
    const r = c.trace({ x: 130, y: 250 - 90 - 15 });
    expect(r.kind).toBe('markers');
    expect(r.points).toHaveLength(4);
    r.points.forEach((p, i) => expect(p.py).toBeCloseTo(250 - low[i]! - high[i]!, 0));
  });

  it('cuts touching histogram bars of one colour at their own heights', () => {
    const c = new Canvas(400, 300);
    const counts = [20, 50, 90, 140, 90, 60, 60, 30];
    counts.forEach((v, i) => c.rect(60 + 20 * i - 10, 250 - v, 60 + 20 * i + 10, 250, BLUE));
    const r = c.trace({ x: 120, y: 220 });
    expect(r.points).toHaveLength(counts.length);
    r.points.forEach((p, i) => {
      expect(p.px).toBeCloseTo(60 + 20 * i, 0);
      expect(p.py).toBeCloseTo(250 - counts[i]!, 0);
    });
  });

  it('reads horizontal bars at their right ends', () => {
    const c = new Canvas(400, 300);
    const values = [200, 120, 280, 60];
    values.forEach((v, i) => c.rect(40, 50 + 50 * i - 12.5, 40 + v, 50 + 50 * i + 12.5, BLUE));
    const r = c.trace({ x: 60, y: 100 });
    expect(r.points).toHaveLength(4);
    r.points.forEach((p, i) => {
      expect(p.px).toBeCloseTo(40 + values[i]!, 0);
      expect(p.py).toBeCloseTo(50 + 50 * i, 0);
    });
  });

  /** A bar x0…x1 × y0…y1 with a black outline of width `lw` centred on its edges, face `face`, and hatching "/" every `pitch` px. */
  const outlined = (c: Canvas, x0: number, y0: number, x1: number, y1: number, face: RGB, pitch = 0, lw = 1.5) => {
    c.rect(x0 - lw / 2, y0 - lw / 2, x1 + lw / 2, y1 + lw / 2, [0, 0, 0]);
    c.rect(x0 + lw / 2, y0 + lw / 2, x1 - lw / 2, y1 - lw / 2, face);
    if (pitch) {
      const inside = (x: number, y: number) => x > x0 + lw / 2 && x < x1 - lw / 2 && y > y0 + lw / 2 && y < y1 - lw / 2;
      c.paint([0, 0, 0], x0, y0, x1, y1, (x, y) => inside(x, y) && (((x + y) % pitch) + pitch) % pitch < 1.4);
    }
  };
  /** A pixel of the "/" hatching inside x0…x1 at about row y. */
  const onHatch = (x: number, y: number, pitch: number) => ({ x, y: y - ((((x + y) % pitch) + pitch) % pitch) });

  it('reads outlined bars from their outline and hatched ones from a hatch line, as two series', () => {
    const c = new Canvas(460, 300);
    c.stroke([{ x: 20, y: 251 }, { x: 440, y: 251 }], 1, [0, 0, 0]);
    const plain = [120, 60, 180, 90, 140];
    const hatched = [70, 150, 40, 110, 100];
    plain.forEach((v, i) => outlined(c, 45 + 80 * i, 250 - v, 75 + 80 * i, 250, [255, 255, 255]));
    hatched.forEach((v, i) => outlined(c, 75 + 80 * i, 250 - v, 105 + 80 * i, 250, [255, 255, 255], 8));
    // The plain bars' left outline; a hatch line inside the second hatched bar.
    const a = c.trace({ x: 45 + 80, y: 240 });
    expect(a.kind).toBe('markers');
    expect(a.points).toHaveLength(plain.length);
    a.points.forEach((p, i) => {
      expect(Math.abs(p.px - (60 + 80 * i))).toBeLessThan(1);
      expect(Math.abs(p.py - (250 - plain[i]!))).toBeLessThan(1);
    });
    const b = c.trace(onHatch(170, 200, 8));
    expect(b.kind).toBe('markers');
    expect(b.points).toHaveLength(hatched.length);
    b.points.forEach((p, i) => {
      expect(Math.abs(p.px - (90 + 80 * i))).toBeLessThan(1);
      expect(Math.abs(p.py - (250 - hatched[i]!))).toBeLessThan(1);
    });
  });

  it('tells bars of one fill colour apart by their hatching', () => {
    const c = new Canvas(460, 300);
    const plain = [120, 60, 180, 90, 140];
    const hatched = [70, 150, 40, 110, 100];
    plain.forEach((v, i) => outlined(c, 45 + 80 * i, 250 - v, 75 + 80 * i, 250, BLUE, 0, 1));
    hatched.forEach((v, i) => outlined(c, 75 + 80 * i, 250 - v, 105 + 80 * i, 250, BLUE, 10, 1));
    const a = c.trace({ x: 140, y: 230 });
    expect(a.points.map((p) => Math.round(p.px))).toEqual(plain.map((_, i) => 60 + 80 * i));
    // In the fill between two hatch lines of a hatched bar.
    const h = onHatch(170, 200, 10);
    const b = c.trace({ x: h.x, y: h.y - 5 });
    expect(b.points.map((p) => Math.round(p.px))).toEqual(hatched.map((_, i) => 90 + 80 * i));
    b.points.forEach((p, i) => expect(Math.abs(p.py - (250 - hatched[i]!))).toBeLessThan(1));
  });

  it('reads outlined bars on both sides of a zero line, and their error bars are no bar ends', () => {
    const c = new Canvas(460, 300);
    c.stroke([{ x: 20, y: 151 }, { x: 440, y: 151 }], 1, [0, 0, 0]);
    const values = [80, -50, 120, -90, 60];
    values.forEach((v, i) => {
      const x = 60 + 80 * i;
      outlined(c, x - 15, Math.min(150 - v, 150), x + 15, Math.max(150 - v, 150), [255, 255, 255], 6);
      const end = 150 - v;
      const err = 12;
      c.stroke([{ x, y: end - err }, { x, y: end + err }], 1, [0, 0, 0]);
      c.stroke([{ x: x - 5, y: end - err }, { x: x + 5, y: end - err }], 1, [0, 0, 0]);
      c.stroke([{ x: x - 5, y: end + err }, { x: x + 5, y: end + err }], 1, [0, 0, 0]);
    });
    const r = c.trace(onHatch(150, 160, 6), 'auto', 25, [[10, 10], [450, 10], [450, 290], [10, 290]]);
    expect(r.kind).toBe('markers');
    expect(r.points).toHaveLength(values.length);
    r.points.forEach((p, i) => expect(Math.abs(p.py - (150 - values[i]!))).toBeLessThan(1));
  });

  it('leaves a dashed curve over outlined bars to the curve tracer', () => {
    const c = new Canvas(460, 300);
    c.stroke([{ x: 20, y: 251 }, { x: 440, y: 251 }], 1, [0, 0, 0]);
    [120, 60, 180, 90, 140].forEach((v, i) => outlined(c, 45 + 80 * i, 250 - v, 75 + 80 * i, 250, [255, 255, 255]));
    const f = (x: number) => 230 - 0.4 * (x - 30);
    for (let x = 30; x < 430; x += 12) c.stroke([{ x, y: f(x) }, { x: x + 7, y: f(x + 7) }], 1.5, [0, 0, 0]);
    expect(c.trace({ x: 57, y: Math.round(f(57)) }).kind).toBe('curve');
  });

  it('is not used in curve mode, and leaves a thick line alone', () => {
    const c = chart([120, 60, 180]);
    expect(c.trace({ x: 100, y: 230 }, 'curve').kind).not.toBe('markers');
    const t = new Canvas(400, 300);
    const line: P[] = Array.from({ length: 301 }, (_, i) => ({ x: 50 + i, y: 150 + 40 * Math.sin(i / 50) }));
    t.stroke(line, 5, BLUE);
    expect(t.trace({ x: 150, y: Math.round(150 + 40 * Math.sin(2)) }).kind).toBe('curve');
  });
});
