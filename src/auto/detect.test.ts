/**
 * Axis detection on synthetic RGBA images drawn here with exact, known geometry (antialiased by
 * supersampling), plus the real Kaplan–Meier figure. The corpus-wide numbers live in
 * `npm run bench:axes`; these tests pin the behaviours the detector must never lose.
 */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import truth from '../../fixtures/real/km-pericardial-effusion.json';
import { detectAxes } from './detect.ts';
import type { AxisDetection, Point, RgbaImage } from './types.ts';

interface Canvas extends RgbaImage {
  data: Uint8ClampedArray;
}

function canvas(width: number, height: number): Canvas {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

type Xf = (p: Point) => Point;
const identity: Xf = (p) => p;

/** Rotation by `deg` clockwise on screen (y down) about (cx, cy). */
function rotation(deg: number, cx: number, cy: number): Xf {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return ({ x, y }) => ({ x: cx + c * (x - cx) - s * (y - cy), y: cy + s * (x - cx) + c * (y - cy) });
}

/**
 * Paint a straight segment of the given width (px) and grey level, antialiased by 4×4
 * supersampling. Integer coordinates are pixel centres, as everywhere in the app.
 */
function line(img: Canvas, a: Point, b: Point, width: number, gray: number, xf: Xf = identity): void {
  const p = xf(a);
  const q = xf(b);
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const L2 = dx * dx + dy * dy;
  const pad = width + 2;
  const x0 = Math.max(0, Math.floor(Math.min(p.x, q.x) - pad));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(p.x, q.x) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(p.y, q.y) - pad));
  const y1 = Math.min(img.height - 1, Math.ceil(Math.max(p.y, q.y) + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x - 0.375 + sx * 0.25;
          const py = y - 0.375 + sy * 0.25;
          const t = L2 ? Math.max(0, Math.min(1, ((px - p.x) * dx + (py - p.y) * dy) / L2)) : 0;
          const d = Math.hypot(px - (p.x + t * dx), py - (p.y + t * dy));
          if (d <= width / 2) hit++;
        }
      }
      if (!hit) continue;
      const cover = hit / 16;
      const i = (y * img.width + x) * 4;
      const v = Math.min(img.data[i] ?? 255, 255 - cover * (255 - gray));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
}

/** Fill an axis-aligned rectangle (inclusive pixel bounds). */
function rect(img: Canvas, x0: number, y0: number, x1: number, y1: number, gray: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = gray;
    }
  }
}

/** A row of glyph-like strokes (text stand-in): short vertical bars with gaps. */
function text(img: Canvas, x: number, y: number, chars: number, gray: number, xf: Xf = identity): void {
  for (let k = 0; k < chars; k++) {
    const cx = x + k * 6;
    line(img, { x: cx, y }, { x: cx, y: y + 7 }, 1.4, gray, xf);
    line(img, { x: cx + 2.5, y }, { x: cx + 2.5, y: y + 7 }, 1.4, gray, xf);
    if (k % 2) line(img, { x: cx, y: y + 3.5 }, { x: cx + 2.5, y: y + 3.5 }, 1.2, gray, xf);
  }
}

interface ChartOptions {
  xf?: Xf;
  xTicks?: boolean;
  frame?: boolean;
  axisGray?: number;
  /** Axis/frame/tick line width, px. */
  width?: number;
  logY?: boolean;
}

/** 640×420 chart: X axis at row 330 from column 70 to 610, Y axis at column 70 up to row 30. */
const ORIGIN = { x: 70, y: 330 };
const RIGHT = 610;
const TOP = 30;
const X_TICKS = [70, 160, 250, 340, 430, 520, 610];
const Y_TICKS = [330, 270, 210, 150, 90, 30];

function chart(o: ChartOptions = {}): Canvas {
  const img = canvas(640, 420);
  const xf = o.xf ?? identity;
  const g = o.axisGray ?? 0;
  const w = o.width ?? 1;
  line(img, { x: ORIGIN.x, y: ORIGIN.y }, { x: RIGHT, y: ORIGIN.y }, w, g, xf);
  line(img, { x: ORIGIN.x, y: ORIGIN.y }, { x: ORIGIN.x, y: TOP }, w, g, xf);
  if (o.frame) {
    line(img, { x: ORIGIN.x, y: TOP }, { x: RIGHT, y: TOP }, w, g, xf);
    line(img, { x: RIGHT, y: TOP }, { x: RIGHT, y: ORIGIN.y }, w, g, xf);
  }
  if (o.xTicks !== false) {
    for (const x of X_TICKS) line(img, { x, y: ORIGIN.y }, { x, y: ORIGIN.y + 4 + 2 * w }, w, g, xf);
  }
  if (o.logY) {
    // Decades every 150 px from the axis up, minors at log10(2…9).
    for (const base of [330, 180]) {
      line(img, { x: ORIGIN.x - 7, y: base }, { x: ORIGIN.x, y: base }, 1, g, xf);
      for (let k = 2; k <= 9; k++) {
        const y = base - 150 * Math.log10(k);
        line(img, { x: ORIGIN.x - 4, y }, { x: ORIGIN.x, y }, 1, g, xf);
      }
    }
    line(img, { x: ORIGIN.x - 7, y: 30 }, { x: ORIGIN.x, y: 30 }, 1, g, xf);
  } else {
    for (const y of Y_TICKS) line(img, { x: ORIGIN.x - 4 - 2 * w, y }, { x: ORIGIN.x, y }, w, g, xf);
  }
  // Tick labels (no gap to the ticks would be cheating: real labels sit a few px away).
  const pad = 4 + 2 * w + 6;
  for (const x of X_TICKS) text(img, x - 6, ORIGIN.y + pad, 2, 0, xf);
  for (const y of Y_TICKS) text(img, ORIGIN.x - pad - 16, y - 3.5, 3, 0, xf);
  // A data curve.
  for (let x = 80; x < 600; x += 10) {
    line(img, { x, y: 300 - 0.3 * (x - 80) }, { x: x + 10, y: 300 - 0.3 * (x - 70) }, 1.5, 90, xf);
  }
  return img;
}

function allFinite(det: AxisDetection): boolean {
  let ok = true;
  JSON.stringify(det, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) ok = false;
    return v;
  });
  return ok;
}

/** Distance from a point to the infinite line through a detected axis. */
function offLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy);
}

describe('detectAxes on drawn charts', () => {
  it('finds an L-shaped axis pair, its plot box and evenly spaced ticks', () => {
    const det = detectAxes(chart());
    expect(allFinite(det)).toBe(true);
    expect(det.skewDegrees).toBe(0);
    expect(det.xAxis?.line.offset).toBeCloseTo(ORIGIN.y, 1);
    expect(det.yAxis?.line.offset).toBeCloseTo(ORIGIN.x, 1);
    const xt = det.xAxis?.ticks;
    expect(xt?.side).toBe('outside');
    expect(xt?.pattern).toBe('even');
    expect(xt?.spacing).toBeCloseTo(90, 0);
    expect(xt?.confidence).toBeGreaterThan(0.5);
    // The tick at the corner hides in the Y axis line; the others are found within 0.5 px.
    const found = xt?.ticks.map((t) => t.point.x) ?? [];
    for (const x of X_TICKS.slice(1)) expect(found.some((f) => Math.abs(f - x) < 0.5)).toBe(true);
    expect(det.yAxis?.ticks.ticks.length).toBeGreaterThanOrEqual(5);
    const box = det.plotBox;
    expect(box?.bottomLeft.x).toBeCloseTo(ORIGIN.x, 0);
    expect(box?.bottomLeft.y).toBeCloseTo(ORIGIN.y, 0);
    expect(Math.abs((box?.topRight.x ?? 0) - RIGHT)).toBeLessThan(1.5);
    expect(Math.abs((box?.topRight.y ?? 0) - TOP)).toBeLessThan(1.5);
    expect(box?.framed).toEqual({ top: false, right: false });
  });

  it('reports no ticks (confidence 0) on an axis that has labels but no tick marks', () => {
    const img = chart({ xTicks: false });
    // Two stray marks touching the axis (a step riser, a marker) are not a tick pattern.
    line(img, { x: 205, y: ORIGIN.y }, { x: 205, y: ORIGIN.y + 5 }, 1, 0);
    line(img, { x: 377, y: ORIGIN.y }, { x: 377, y: ORIGIN.y + 5 }, 1, 0);
    const det = detectAxes(img);
    expect(det.xAxis?.line.offset).toBeCloseTo(ORIGIN.y, 1);
    expect(det.xAxis?.ticks.ticks).toEqual([]);
    expect(det.xAxis?.ticks.confidence).toBe(0);
    expect(det.yAxis?.ticks.confidence).toBeGreaterThan(0.5);
  });

  it('is not fooled by text darker than a grey axis line', () => {
    const img = chart({ axisGray: 150 });
    // A dense black caption below the chart and a rotated-title-like column left of the labels.
    text(img, 40, 385, 90, 0);
    text(img, 40, 397, 90, 0);
    for (let y = 40; y < 320; y += 9) line(img, { x: 12, y }, { x: 18, y }, 2, 0);
    const det = detectAxes(img);
    expect(det.xAxis?.line.offset).toBeCloseTo(ORIGIN.y, 1);
    expect(det.yAxis?.line.offset).toBeCloseTo(ORIGIN.x, 1);
  });

  it('keeps the axis position when bars stand on it', () => {
    const img = chart();
    // Dark bars with black outlines on the X axis cover most of its length.
    for (let x = 80; x < 590; x += 40) {
      rect(img, x, 150 + (x % 7) * 15, x + 34, ORIGIN.y, 90);
      line(img, { x, y: ORIGIN.y }, { x, y: 150 + (x % 7) * 15 }, 1, 0);
      line(img, { x: x + 34, y: ORIGIN.y }, { x: x + 34, y: 150 + (x % 7) * 15 }, 1, 0);
    }
    line(img, { x: ORIGIN.x, y: ORIGIN.y }, { x: RIGHT, y: ORIGIN.y }, 1, 0);
    const det = detectAxes(img);
    expect(Math.abs((det.xAxis?.line.offset ?? 0) - ORIGIN.y)).toBeLessThan(0.15);
    expect(Math.abs((det.yAxis?.line.offset ?? 0) - ORIGIN.x)).toBeLessThan(0.15);
  });

  it('picks the bottom-left corner of a box frame and reports the frame', () => {
    const det = detectAxes(chart({ frame: true }));
    expect(det.xAxis?.line.offset).toBeCloseTo(ORIGIN.y, 1);
    expect(det.yAxis?.line.offset).toBeCloseTo(ORIGIN.x, 1);
    expect(det.plotBox?.framed).toEqual({ top: true, right: true });
    expect(det.plotBox?.topRight.x).toBeCloseTo(RIGHT, 0);
    expect(det.plotBox?.topRight.y).toBeCloseTo(TOP, 0);
  });

  it('recognises log-axis minor ticks', () => {
    const det = detectAxes(chart({ logY: true }));
    const yt = det.yAxis?.ticks;
    expect(yt?.pattern).toBe('log');
    expect(yt?.spacing).toBeCloseTo(150, 0);
    expect(yt?.ticks.filter((t) => t.kind === 'minor').length).toBeGreaterThanOrEqual(14);
  });

  it.each([
    [2, 1],
    [-2.5, 1],
    [1.5, 4.5],
  ])('finds the axes of a chart rotated %s° (lines %s px wide)', (deg, width) => {
    const xf = rotation(deg, 320, 210);
    const det = detectAxes(chart({ xf, width, frame: width > 1 }));
    expect(allFinite(det)).toBe(true);
    expect(Math.abs(det.skewDegrees - deg)).toBeLessThan(0.02);
    const x = det.xAxis?.line;
    const y = det.yAxis?.line;
    expect(x && y).toBeTruthy();
    if (!x || !y) return;
    for (const p of [ORIGIN, { x: RIGHT, y: ORIGIN.y }]) expect(offLine(xf(p), x.p1, x.p2)).toBeLessThan(0.5);
    for (const p of [ORIGIN, { x: ORIGIN.x, y: TOP }]) expect(offLine(xf(p), y.p1, y.p2)).toBeLessThan(0.5);
    expect(det.xAxis?.ticks.ticks.length).toBeGreaterThanOrEqual(5);
  });

  it('returns no axes for a blank image, without NaN', () => {
    const det = detectAxes(canvas(200, 150));
    expect(det.xAxis).toBeNull();
    expect(det.yAxis).toBeNull();
    expect(det.plotBox).toBeNull();
    expect(allFinite(det)).toBe(true);
  });

  it('rejects an RGBA buffer that is too small', () => {
    expect(() => detectAxes({ width: 10, height: 10, data: new Uint8Array(10) })).toThrow(/too small/);
  });
});

describe('detectAxes on the real Kaplan–Meier figure', () => {
  const buf = readFileSync(new URL('../../fixtures/real/km-pericardial-effusion.jpg', import.meta.url));
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const det = detectAxes({ width: img.width, height: img.height, data: img.data });

  it('finds both axis lines despite the darker rotated title and caption', () => {
    expect(Math.abs((det.xAxis?.line.offset ?? 0) - truth.xAxis.axisLineRow)).toBeLessThan(0.5);
    expect(Math.abs((det.yAxis?.line.offset ?? 0) - truth.yAxis.axisLineCol)).toBeLessThan(0.5);
  });

  it('finds the faint tick marks on both axes at the labelled positions', () => {
    const xs = det.xAxis?.ticks.ticks.map((t) => t.point.x) ?? [];
    const ys = det.yAxis?.ticks.ticks.map((t) => t.point.y) ?? [];
    expect(xs).toHaveLength(truth.xAxis.ticks.length);
    expect(ys).toHaveLength(truth.yAxis.ticks.length);
    for (const t of truth.xAxis.ticks) expect(xs.some((x) => Math.abs(x - t.px) <= 1.5)).toBe(true);
    for (const t of truth.yAxis.ticks) expect(ys.some((y) => Math.abs(y - t.py) <= 1.5)).toBe(true);
  });
});
