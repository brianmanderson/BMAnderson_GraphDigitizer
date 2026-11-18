/**
 * The line tracer on synthetic RGBA images drawn here with exact geometry (antialiased by 4×4
 * supersampling, integer = pixel centre). Corpus-wide numbers live in `npm run bench:lines`;
 * these tests pin the behaviours the tracer must never lose.
 */

import { describe, expect, it } from 'vitest';
import { traceLine, type TraceRequest, type TraceResult } from './index.ts';
import { makeRegion } from './region.ts';
import { resample } from './resample.ts';
import { findRulings } from './rulings.ts';
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

  it('stays on a thick curve where it crosses thin lines of its colour at shallow angles', () => {
    // A dose-response figure: a thick black sigmoid over black gridlines and
    // outlined bars whose tops it crosses at shallow angles — each crossing merges the two into
    // one run for many columns. Neither a gridline nor a bar top is the curve: the trace stays
    // in the stroke end to end (before the fix it left at the first crossing, 80+ px off). Where
    // crossings follow each other within a few dozen columns, as here, they can still leave a
    // corner pair half a stroke off (SPEC → Auto-trace → known failures).
    const c = new Canvas(400, 280);
    frame(c);
    const curve = Array.from({ length: 317 }, (_, i) => ({ x: 42 + i, y: 235 - 170 / (1 + Math.exp(-(i - 200) / 110)) })); // frame to frame
    for (const y of [200, 180, 160, 140, 120]) c.stroke([{ x: 41, y }, { x: 359, y }], 1.5, BLACK);
    // Bar tops halfway between gridlines, as in that figure.
    for (const [x0, x1, top] of [[100, 150, 190], [150, 210, 170], [210, 265, 150], [265, 320, 130]] as const) {
      const at = (x: number) => curve[x - 42]!.y;
      expect(at(x0)).toBeGreaterThan(top); // the curve crosses each bar's top inside the bar
      expect(at(x1)).toBeLessThan(top);
      c.stroke([{ x: x0, y: 259 }, { x: x0, y: top }, { x: x1, y: top }, { x: x1, y: 259 }], 3, BLACK);
    }
    c.stroke(curve, 5, BLACK);
    // Auto mode: the pockets of background between the curve, a bar top and a bar side are no open
    // markers (the curve borders them on one side only and runs on), so it stays a curve.
    for (const seed of [curve[38]!, curve[158]!, curve[288]!]) {
      const r = traceLine(c.request(seed));
      expect(r.kind).toBe('curve');
      expect(r.style).toBe('solid');
      const path = pts(r);
      expect(path.every((p) => polyDist(p, curve) < 5)).toBe(true); // within one stroke width
      expect(Math.min(...path.map((p) => p.x))).toBeLessThan(46);
      expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(354);
      expect(r.points.every((p) => polyDist({ x: p.px, y: p.py }, curve) < 5)).toBe(true);
      const errs = path.map((p) => polyDist(p, curve)).sort((x, y) => x - y);
      expect(errs[errs.length >> 1]!).toBeLessThan(0.5);
    }
  });

  /** A heavy black grid (a scanned figure's ruling) every `step` px inside BOX, 6 px wide. */
  const heavyGrid = (c: Canvas, step = 40) => {
    for (let x = 40 + step; x < 360; x += step) c.stroke([{ x, y: 20 }, { x, y: 260 }], 6, BLACK);
    for (let y = 260 - step; y > 20; y -= step) c.stroke([{ x: 40, y }, { x: 360, y }], 6, BLACK);
  };
  /**
   * A saturating curve from (60, 230) that meets the 100 gridline at x = 300 at 0.4 px per column
   * (as the 1928 scan's fitted curve meets its 100 % gridline), shifted up by `up`.
   */
  const rising = (up = 0): P[] =>
    Array.from({ length: 241 }, (_, i) => ({ x: 60 + i, y: 230 - up - (130 * (1 - Math.exp(-i / 400))) / (1 - Math.exp(-240 / 400)) }));

  it('never runs along a heavy gridline of its colour that a solid curve crosses or ends on', () => {
    // An old scan: grid, frame and curve all one black, the grid as heavy as the curve. The curve
    // ends on a gridline: the trace stops there and never follows a gridline (tester feedback: it
    // ran along the 60 % and 100 % gridlines and down the left axis).
    const c = new Canvas(400, 280);
    c.stroke(BOX.concat([BOX[0]!]).map(([x, y]) => ({ x, y })), 6, BLACK);
    heavyGrid(c);
    const curve = rising();
    c.stroke(curve, 6, BLACK);
    const r = traceLine(c.request(curve[70]!));
    expect(r.kind).toBe('curve');
    const path = pts(r);
    expect(path.every((p) => polyDist(p, curve) < 4)).toBe(true);
    expect(Math.min(...path.map((p) => p.x))).toBeLessThan(70);
    // It may stop where it runs into the gridline's band (no run there is the curve's alone).
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(280);
    expect(Math.max(...path.map((p) => p.x))).toBeLessThan(306);
  });

  it('traces a hand-dashed curve across a heavy grid of its colour to its real end', () => {
    // Half the 1928 scan's scale: 8 px strokes, gridlines 10 px wide every 160 px, dashes and gaps
    // of uneven length (drawn by hand), cut wherever they cross a gridline; the last dashes lie
    // past the last gridline the curve crosses, short of the frame. (Tester feedback: "How do you
    // get it to go the full length of a dashed line?")
    const c = new Canvas(800, 560);
    const box: [number, number][] = [
      [80, 40],
      [720, 40],
      [720, 520],
      [80, 520],
    ];
    c.stroke(box.concat([box[0]!]).map(([x, y]) => ({ x, y })), 10, BLACK);
    for (const x of [240, 400, 560]) c.stroke([{ x, y: 40 }, { x, y: 520 }], 10, BLACK);
    for (const y of [200, 360]) c.stroke([{ x: 80, y }, { x: 720, y }], 10, BLACK);
    const curve = Array.from({ length: 521 }, (_, i) => ({ x: 120 + i, y: 470 - (360 * (1 - Math.exp(-i / 300))) / (1 - Math.exp(-520 / 300)) }));
    const arc = [0];
    for (let i = 1; i < curve.length; i++) arc.push(arc[i - 1]! + Math.hypot(curve[i]!.x - curve[i - 1]!.x, curve[i]!.y - curve[i - 1]!.y));
    const dashes = [32, 44, 27, 38, 46, 30];
    const gaps = [11, 15, 10, 13, 16, 12];
    const mids: P[] = [];
    for (let s = 0, k = 0; s < arc[arc.length - 1]!; k++) {
      const e = Math.min(arc[arc.length - 1]!, s + dashes[k % dashes.length]!);
      // The stroke's round caps reach half its width past the ends: the gaps stay as given.
      const piece = curve.filter((_, i) => arc[i]! >= s + 4 && arc[i]! <= e - 4);
      if (piece.length >= 2) {
        c.stroke(piece, 8, BLACK);
        mids.push(piece[piece.length >> 1]!);
      }
      s = e + gaps[k % gaps.length]!;
    }
    // Clicked on a dash clear of the grid.
    const seed = mids.find((m) => m.x > 300 && [240, 400, 560].every((g) => Math.abs(m.x - g) > 16) && [200, 360].every((g) => Math.abs(m.y - g) > 16))!;
    const r = traceLine(c.request(seed, { plotBox: box }));
    expect(r.kind).toBe('curve');
    expect(r.style).toBe('dashed');
    const path = pts(r);
    // Within half a stroke (a steep dash's end can leave a corner pair that far off, SPEC →
    // Auto-trace → known failures), and on it as a rule.
    expect(path.every((p) => polyDist(p, curve) < 4)).toBe(true);
    const errs = path.map((p) => polyDist(p, curve)).sort((x, y) => x - y);
    expect(errs[errs.length >> 1]!).toBeLessThan(1);
    expect(Math.min(...path.map((p) => p.x))).toBeLessThan(140);
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(610);
    expect(Math.max(...path.map((p) => p.x))).toBeLessThan(645);
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

  it('does not join a dashed line across the other series and a top X axis to a tick label', () => {
    // A clonogenic-survival figure with error bars under an X axis drawn along the top, traced
    // with no plot box (labels in the traced region): the dashed series' chain breaks
    // at an open marker; above it, across the thick solid series and the top axis, sits the '1'
    // label — a piece of a dash's size with enough dropped ink on the way for a lost dash, but off
    // the dashed line's course. The trace keeps to the dashes instead of jumping up to the label.
    const c = new Canvas(320, 220);
    const corner = { x: 30, y: 40 };
    c.stroke([{ x: 30, y: 210 }, corner, { x: 310, y: 40 }], 1.5, BLACK);
    c.stroke([corner, { x: 310, y: 75 }], 8, BLACK); // thick: the way up crosses a lost dash's worth
    const line: P[] = [corner, { x: 310, y: 200 }];
    const pieces = dashes(line, [12, 30]); // Office-style: gaps longer than the dashes
    for (const d of pieces) c.stroke(d, 4, BLACK);
    // An open square with an error bar in the gap after the dash ending nearest x = 104, clear of
    // the next dash (as a data point off the fitted line leaves it).
    const before = pieces.reduce((a, d) => (Math.abs(d[1]!.x - 104) < Math.abs(a[1]!.x - 104) ? d : a));
    const after = pieces[pieces.indexOf(before) + 1]!;
    const m = { x: before[1]!.x + 0.35 * (after[0]!.x - before[1]!.x), y: before[1]!.y + 0.35 * (after[0]!.y - before[1]!.y) };
    c.stroke([{ x: m.x, y: m.y - 12 }, { x: m.x, y: m.y + 12 }], 1.2, BLACK);
    c.square(m, 9, BLACK);
    c.square(m, 6, [255, 255, 255]);
    c.stroke([{ x: m.x, y: 14 }, { x: m.x, y: 30 }], 2.5, BLACK); // the '1' above it
    c.stroke([{ x: m.x - 5, y: 19 }, { x: m.x, y: 14 }], 2.5, BLACK);
    const seedDash = pieces.find((d) => d[0]!.x > 220)!;
    const seed = { x: (seedDash[0]!.x + seedDash[1]!.x) / 2, y: (seedDash[0]!.y + seedDash[1]!.y) / 2 };
    const r = traceLine(c.request(seed, { plotBox: null }));
    expect(r.style).toBe('dashed');
    expect(pts(r).every((p) => polyDist(p, line) < 9)).toBe(true); // on the line (or its marker)
  });

  it('does not join a dashed line across the axis it runs into to the tick label beyond', () => {
    // No plot box (the labels are in the traced region, as in such a figure before a top X axis
    // was detected). The dashed series ends at the Y axis; on its line, past the thin axis, sits the
    // '100' label, as far from the last dash as a lost dash and two gaps would be. Joined across
    // dropped ink it could be, but no dash was lost there: the axis is all the dropped ink between
    // them. The trace ends at its last dash.
    const c = new Canvas(340, 220);
    c.stroke([{ x: 80, y: 210 }, { x: 80, y: 30 }, { x: 330, y: 30 }], 1.5, BLACK);
    c.stroke([{ x: 80, y: 32 }, { x: 330, y: 60 }], 3, BLACK); // the solid series
    const line: P[] = [{ x: 330, y: 200 }, { x: 80, y: 110 }];
    const pieces = dashes(line, [12, 22]).filter((d) => Math.min(...d.map((p) => p.x)) > 92);
    for (const d of pieces) c.stroke(d, 3, BLACK);
    const ring = (cx: number): P[] => Array.from({ length: 25 }, (_, i) => ({ x: cx + 4 * Math.cos((i * Math.PI) / 12), y: 91 + 7 * Math.sin((i * Math.PI) / 12) }));
    c.stroke([{ x: 2, y: 84 }, { x: 2, y: 98 }], 2, BLACK); // '1'
    c.stroke(ring(13), 2, BLACK); // '0'
    c.stroke(ring(25), 2, BLACK); // '0'
    const seedDash = pieces[2]!;
    const seed = { x: (seedDash[0]!.x + seedDash[1]!.x) / 2, y: (seedDash[0]!.y + seedDash[1]!.y) / 2 };
    const r = traceLine(c.request(seed, { plotBox: null }));
    expect(r.style).toBe('dashed');
    expect(Math.min(...r.path.map((p) => p.px))).toBeGreaterThan(85); // not past the axis
    expect(Math.min(...r.path.map((p) => p.px))).toBeLessThan(100); // to its last dash
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

describe('traceLine: busy scatterplots', () => {
  const GREY: RGB = [128, 128, 128];
  /** A small deterministic generator (the tests must not depend on Math.random). */
  const rand = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const plus = (c: Canvas, p: P, size = 5) => {
    c.stroke([{ x: p.x - size / 2, y: p.y }, { x: p.x + size / 2, y: p.y }], 1.2, BLACK);
    c.stroke([{ x: p.x, y: p.y - size / 2 }, { x: p.x, y: p.y + size / 2 }], 1.2, BLACK);
  };
  const diamond = (c: Canvas, p: P, size = 11) =>
    c.paint(BLACK, p.x - size, p.y - size, p.x + size, p.y + size, (x, y) => Math.abs(x - p.x) + Math.abs(y - p.y) <= size / 2);
  /** A grey model curve: a straight steep stretch, a corner, then a falling curve to a plateau. */
  const corner = { x: 110, y: 190 };
  const curve: P[] = [{ x: 70, y: 40 }, corner, ...Array.from({ length: 48 }, (_, i) => {
    const x = 115 + 5 * i;
    return { x, y: 230 - 40 * Math.exp(-(x - 110) / 40) };
  })];
  /** The scene: the grey curve under a cloud of black "+" (some in overlapping pairs and threes), diamonds, a "%"-like label. */
  function scene(): { c: Canvas; plusses: P[]; diamonds: P[] } {
    const c = new Canvas(400, 280);
    frame(c);
    c.stroke(curve, 2.5, GREY);
    const r = rand(7);
    const plusses: P[] = [];
    const diamonds: P[] = [{ x: 150, y: 150 }, { x: 250, y: 120 }, { x: 300, y: 205 }, { x: 200, y: 70 }];
    const clear = (p: P) => plusses.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= 8) && diamonds.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= 14);
    while (plusses.length < 90) {
      const p = { x: 60 + 290 * r(), y: 40 + 200 * r() };
      if (p.x > 300 && p.y < 90) continue; // the label's corner
      if (clear(p)) plusses.push(p);
    }
    // Overlapping pairs and a three, one touching a diamond, and markers on the grey curve.
    const extra: P[] = [];
    for (const [i, dx, dy] of [[0, 3, 1], [5, -2, 3], [9, 3, -2], [12, 2, 2]] as const) extra.push({ x: plusses[i]!.x + dx, y: plusses[i]!.y + dy });
    extra.push({ x: plusses[9]!.x - 2, y: plusses[9]!.y + 3 });
    extra.push({ x: 150 + 7, y: 150 + 1 });
    for (const x of [140, 200, 260]) extra.push({ x, y: 230 - 40 * Math.exp(-(x - 110) / 40) + 0.3 });
    plusses.push(...extra);
    for (const p of plusses) plus(c, p);
    for (const p of diamonds) diamond(c, p);
    // A "%"-like label in black at the top right: two rings and a slash.
    for (const q of [{ x: 318, y: 50 }, { x: 330, y: 64 }]) {
      c.paint(BLACK, q.x - 5, q.y - 5, q.x + 5, q.y + 5, (x, y) => Math.abs(Math.hypot(x - q.x, y - q.y) - 3.2) <= 0.9);
    }
    c.stroke([{ x: 334, y: 44 }, { x: 314, y: 70 }], 1.6, BLACK);
    return { c, plusses, diamonds };
  }

  it('keeps a grey curve on its own colour and course through black markers, with its corner', () => {
    const { c } = scene();
    const r = traceLine(c.request({ x: 300, y: Math.round(230 - 40 * Math.exp(-190 / 40)) }));
    expect(r.kind).toBe('curve');
    const path = pts(r);
    for (const p of path) expect(polyDist(p, curve)).toBeLessThan(1.5);
    expect(Math.min(...path.map((p) => p.x))).toBeLessThan(73);
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(345);
    expect(r.points.some((p) => Math.hypot(p.px - corner.x, p.py - corner.y) <= 2)).toBe(true);
  });

  it('finds clusters of small "+" markers, not the diamonds, the label or the grey curve', () => {
    const { c, plusses, diamonds } = scene();
    const r = traceLine(c.request(plusses[1]!, { mode: 'markers' }));
    expect(r.kind).toBe('markers');
    const found = r.path;
    const matched = plusses.filter((p) => found.some((q) => Math.hypot(q.px - p.x, q.py - p.y) <= 2)).length;
    expect(matched / plusses.length).toBeGreaterThan(0.9);
    const stray = found.filter((q) => !plusses.some((p) => Math.hypot(q.px - p.x, q.py - p.y) <= 2));
    expect(stray.length).toBeLessThanOrEqual(2);
    for (const d of diamonds) expect(found.some((q) => Math.hypot(q.px - d.x, q.py - d.y) <= 3)).toBe(false);
    expect(found.some((q) => q.px > 308 && q.px < 340 && q.py > 40 && q.py < 74)).toBe(false);
  });

  it('finds the diamonds, not piles of "+" markers', () => {
    const { c, diamonds } = scene();
    // A pile of "+" the size of a diamond.
    for (let i = 0; i < 9; i++) plus(c, { x: 90 + 2.4 * (i % 3), y: 240 + 2.4 * Math.floor(i / 3) });
    const r = traceLine(c.request(diamonds[1]!, { mode: 'markers' }));
    expect(r.kind).toBe('markers');
    for (const d of diamonds) expect(r.path.some((q) => Math.hypot(q.px - d.x, q.py - d.y) <= 1)).toBe(true);
    expect(r.path.length).toBe(diamonds.length);
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

    it(`finds every open marker from a click in its white inside, farther from the ring than the seed radius (${mode})`, () => {
      const c = new Canvas(400, 280);
      frame(c);
      const big = (p: P) => {
        withBars(c, p, BLACK);
        c.disc(p, 20, BLACK);
        c.disc(p, 16, WHITE); // a hole 8 px in radius: no ink within 4 px of its centre
      };
      O.forEach(big);
      F.forEach((p) => filled(c, p));
      const r = traceLine(c.request(O[1]!, { mode }));
      expect(r.kind).toBe('markers');
      expect(near(r, O)).toBe(true);
    });
  }

  it('takes a click inside an open marker for that marker, not the filled one it overlaps', () => {
    const c = chart();
    // A filled marker drawn first, an open one over its right half (the open's white inside bites into it).
    const f = { x: 300, y: 200 };
    const o = { x: 308, y: 204 };
    open(c, o);
    const r = traceLine(c.request(o, { mode: 'markers' }));
    expect(r.kind).toBe('markers');
    expect(r.path.some((p) => Math.hypot(p.px - o.x, p.py - o.y) < 2.5)).toBe(true); // pulled toward the merged disc
    for (const q of O) expect(r.path.some((p) => Math.hypot(p.px - q.x, p.py - q.y) < 1)).toBe(true);
    for (const q of F) if (q !== f) expect(r.path.some((p) => Math.hypot(p.px - q.x, p.py - q.y) < 1.5)).toBe(false);
  });

  it('does not take the space between error bars for a marker', () => {
    const c = chart();
    // Between a filled marker's vertical bar and its cap: background that is not enclosed.
    const r = traceLine(c.request({ x: F[0]!.x + 2, y: F[0]!.y - 19 }, { mode: 'markers' }));
    expect(r.ok).toBe(false);
  });
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

describe('findRulings', () => {
  const alphaOf = (c: Canvas) => {
    const a = new Float32Array(c.width * c.height);
    for (let k = 0; k < a.length; k++) a[k] = 1 - c.data[k * 4]! / 255;
    return a;
  };
  const region = (c: Canvas) => makeRegion(c.width, c.height, null);

  it('finds a grid, never one line alone, never the line under the seed', () => {
    const lone = new Canvas(400, 280);
    lone.stroke([{ x: 10, y: 140 }, { x: 390, y: 140 }], 4, BLACK); // a reference line, a plateau
    lone.stroke(sine(60, 0), 2, BLACK);
    expect(findRulings(alphaOf(lone), region(lone), { x: 50, y: 140 })).toBeNull();

    const grid = new Canvas(400, 280);
    for (const y of [40, 100, 160, 220]) grid.stroke([{ x: 5, y }, { x: 395, y }], 5, BLACK);
    const curve = sine(60, 0);
    grid.stroke(curve, 2, BLACK);
    const r = findRulings(alphaOf(grid), region(grid), { x: curve[100]!.x, y: Math.round(curve[100]!.y) })!;
    const mask = r.mask(2)!;
    const at = (x: number, y: number) => mask[y * grid.width + x];
    expect(at(30, 100)).toBe(1);
    expect(at(30, 160)).toBe(1);
    expect(at(30, 130)).toBe(0);
    expect(r.mask(6)).toBeNull(); // none that thick
    // Clicked on a gridline: that one is the series; the other three remain a grid.
    const own = findRulings(alphaOf(grid), region(grid), { x: 30, y: 100 })!.mask(2)!;
    expect(own[100 * grid.width + 30]).toBe(0);
    expect(own[160 * grid.width + 30]).toBe(1);
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
