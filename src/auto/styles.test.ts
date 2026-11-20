/**
 * Chart styles without the classic dark axis line with tick marks (SPEC → Charts without axis
 * lines): a dark theme, a filled panel with white gridlines (ggplot2 / seaborn), light gridlines
 * on white with no lines at all (plotly), and a log axis whose minors barely stick out. Images
 * are drawn here with exact geometry; `npm run bench:axes` measures the styled corpus (c84–c119).
 */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { darknessMap, isDarkTheme, toGray } from './darkness.ts';
import { detectAxes } from './detect.ts';
import { makeFrame } from './frame.ts';
import { findGridLines, frameGray, ridgeReach } from './grid.ts';
import { findPanel } from './panel.ts';
import type { Point, RgbaImage } from './types.ts';

interface Canvas extends RgbaImage {
  data: Uint8ClampedArray;
}

function canvas(width: number, height: number, gray = 255): Canvas {
  const data = new Uint8ClampedArray(width * height * 4).fill(gray);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Paint an antialiased segment (4×4 supersampling) of the given width and grey level. */
function line(img: Canvas, a: Point, b: Point, width: number, gray: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const pad = width + 2;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(a.x, b.x) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad));
  const y1 = Math.min(img.height - 1, Math.ceil(Math.max(a.y, b.y) + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x - 0.375 + sx * 0.25;
          const py = y - 0.375 + sy * 0.25;
          const t = L2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)) : 0;
          if (Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) <= width / 2) hit++;
        }
      }
      if (!hit) continue;
      const i = (y * img.width + x) * 4;
      const cover = hit / 16;
      const v = (img.data[i] ?? 255) * (1 - cover) + gray * cover;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
}

/** Fill a rectangle (inclusive pixel bounds). */
function rect(img: Canvas, x0: number, y0: number, x1: number, y1: number, gray: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = gray;
    }
  }
}

/** Text stand-in: short vertical strokes. */
function text(img: Canvas, x: number, y: number, chars: number, gray: number): void {
  for (let k = 0; k < chars; k++) {
    line(img, { x: x + k * 6, y }, { x: x + k * 6, y: y + 7 }, 1.4, gray);
    line(img, { x: x + k * 6 + 2.5, y }, { x: x + k * 6 + 2.5, y: y + 7 }, 1.4, gray);
  }
}

/** The plot area of every chart below: x 80…600, y 30…330 (pixel edges at the .5 positions). */
const L = 80;
const R = 600;
const T = 30;
const B = 330;
/** Gridline positions (tick values) inside it. */
const GX = [145, 210, 275, 340, 405, 470, 535];
const GY = [80, 130, 180, 230, 280];

interface StyleOptions {
  /** Panel grey (null = no panel). */
  panel?: number | null;
  /** Gridline grey and width; null = no gridlines. */
  grid?: number | null;
  gridWidth?: number;
  /** Data colour. */
  data?: number;
  /** Labels' grey. */
  ink?: number;
  /** Page grey. */
  page?: number;
}

/** A chart with no axis lines: optional filled panel, gridlines, labels at the gridlines, a curve. */
function styled(o: StyleOptions = {}): Canvas {
  const img = canvas(660, 400, o.page ?? 255);
  const ink = o.ink ?? 60;
  if (o.panel !== null) rect(img, L, T, R, B, o.panel ?? 229);
  if (o.grid !== null) {
    const g = o.grid ?? 255;
    const w = o.gridWidth ?? 1.4;
    for (const x of GX) line(img, { x, y: T }, { x, y: B }, w, g);
    for (const y of GY) line(img, { x: L, y }, { x: R, y }, w, g);
  }
  for (const x of GX) text(img, x - 6, B + 8, 2, ink);
  for (const y of GY) text(img, L - 28, y - 3.5, 3, ink);
  for (let x = 90; x < 590; x += 10) {
    line(img, { x, y: 300 - 0.4 * (x - 90) }, { x: x + 10, y: 300 - 0.4 * (x - 80) }, 2, o.data ?? 40);
  }
  return img;
}

const along = (ticks: { along: number }[] | undefined) => (ticks ?? []).map((t) => t.along);
const near = (xs: number[], targets: number[], tol = 1) => targets.filter((t) => xs.some((x) => Math.abs(x - t) <= tol)).length;

describe('polarity', () => {
  it('reads light ink on a dark background as its negative, and a light chart as it is', () => {
    const dark = canvas(200, 120, 17);
    line(dark, { x: 20, y: 100 }, { x: 180, y: 100 }, 1.5, 230);
    line(dark, { x: 20, y: 100 }, { x: 20, y: 10 }, 1.5, 230);
    expect(isDarkTheme(toGray(dark), 200, 120)).toBe(true);
    const map = darknessMap(dark);
    expect(map.inverted).toBe(true);
    // The light line is now ink.
    expect(map.dark[100 * 200 + 100] ?? 0).toBeGreaterThan(100);
    const light = canvas(200, 120);
    line(light, { x: 20, y: 100 }, { x: 180, y: 100 }, 1.5, 20);
    expect(darknessMap(light).inverted).toBeUndefined();
    // Dark bars on a light page are no dark theme.
    const bars = canvas(200, 120);
    rect(bars, 10, 10, 190, 110, 40);
    expect(isDarkTheme(toGray(bars), 200, 120)).toBe(false);
  });

  it('finds the axes and ticks of a dark-theme chart', () => {
    const img = canvas(640, 420, 0);
    line(img, { x: 70, y: 330 }, { x: 610, y: 330 }, 1, 255);
    line(img, { x: 70, y: 330 }, { x: 70, y: 30 }, 1, 255);
    for (const x of [160, 250, 340, 430, 520, 610]) line(img, { x, y: 330 }, { x, y: 336 }, 1, 255);
    for (const y of [270, 210, 150, 90, 30]) line(img, { x: 64, y }, { x: 70, y }, 1, 255);
    const det = detectAxes(img);
    expect(det.xAxis?.line.offset).toBeCloseTo(330, 1);
    expect(det.yAxis?.line.offset).toBeCloseTo(70, 1);
    expect(det.xAxis?.ticks.ticks.length).toBeGreaterThanOrEqual(5);
    expect(det.yAxis?.ticks.ticks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('charts without axis lines', () => {
  it('finds a filled panel and its sub-pixel edges', () => {
    const img = styled({ grid: null });
    const panel = findPanel(frameGray(darknessMap(img), makeFrame(0)) as NonNullable<ReturnType<typeof frameGray>>);
    expect(panel).not.toBeNull();
    // Pixels L…R are filled: the edges lie half a pixel outside their centres.
    expect(panel?.left).toBeCloseTo(L - 0.5, 1);
    expect(panel?.right).toBeCloseTo(R + 0.5, 1);
    expect(panel?.bottom).toBeCloseTo(B + 0.5, 1);
    expect(panel?.top).toBeCloseTo(T - 0.5, 1);
  });

  it('takes the panel edges as virtual axes and the white gridlines as tick positions (ggplot style)', () => {
    const det = detectAxes(styled());
    expect(det.xAxis?.virtual).toBe(true);
    expect(det.yAxis?.virtual).toBe(true);
    expect(det.xAxis?.position).toBe('bottom');
    expect(det.yAxis?.position).toBe('left');
    expect(det.xAxis?.line.offset).toBeCloseTo(B + 0.5, 0);
    expect(det.yAxis?.line.offset).toBeCloseTo(L - 0.5, 0);
    expect(det.xAxis?.line.thickness).toBe(0);
    expect(det.xAxis?.ticks.source).toBe('gridlines');
    expect(det.yAxis?.ticks.source).toBe('gridlines');
    expect(det.xAxis?.ticks.side).toBe('inside');
    expect(near(along(det.xAxis?.ticks.ticks), GX)).toBe(GX.length);
    expect(near(along(det.yAxis?.ticks.ticks), GY)).toBe(GY.length);
    expect(det.xAxis?.ticks.ticks.length).toBe(GX.length);
    expect(det.plotBox?.framed).toEqual({ top: true, right: true, bottom: false, left: false });
  });

  it('gives a panel without gridlines or tick marks no ticks (nothing is invented)', () => {
    const det = detectAxes(styled({ grid: null }));
    expect(det.xAxis?.virtual).toBe(true);
    expect(det.xAxis?.ticks.ticks).toEqual([]);
    expect(det.xAxis?.ticks.confidence).toBe(0);
    expect(det.yAxis?.ticks.ticks).toEqual([]);
    expect(det.plotBox).not.toBeNull();
  });

  it('finds faint gridlines on white as ridges, and boxes the plot where they end (plotly style)', () => {
    // #EBF0F8-like gridlines: 16 grey levels from the page.
    const img = styled({ panel: null, grid: 239, gridWidth: 1 });
    // The frame of the grid: the outermost gridlines at the plot's edges, as plotly draws them.
    line(img, { x: L, y: T }, { x: R, y: T }, 1, 239);
    line(img, { x: L, y: B }, { x: R, y: B }, 1, 239);
    line(img, { x: L, y: T }, { x: L, y: B }, 1, 239);
    line(img, { x: R, y: T }, { x: R, y: B }, 1, 239);
    const grid = frameGray(darknessMap(img), makeFrame(0));
    expect(grid).not.toBeNull();
    const lines = findGridLines(grid as NonNullable<typeof grid>, 'vertical', { a0: T + 3, a1: B - 3, o0: L + 3, o1: R - 3 }, ridgeReach(660, 400));
    expect(near(lines.map((l) => l.offset), GX, 0.3)).toBe(GX.length);
    const det = detectAxes(img);
    expect(det.xAxis?.line.offset).toBeCloseTo(B, 0);
    expect(det.yAxis?.line.offset).toBeCloseTo(L, 0);
    expect(det.xAxis?.ticks.source).toBe('gridlines');
    expect(near(along(det.xAxis?.ticks.ticks), GX)).toBe(GX.length);
    expect(near(along(det.yAxis?.ticks.ticks), GY)).toBe(GY.length);
    expect(Math.abs((det.plotBox?.topRight.x ?? 0) - R)).toBeLessThan(1.5);
    expect(Math.abs((det.plotBox?.topRight.y ?? 0) - T)).toBeLessThan(1.5);
  });

  it('keeps an ordinary axis pair whose plot has a shaded region inside it', () => {
    const img = canvas(640, 420);
    rect(img, 200, 100, 400, 300, 225); // a confidence band, not a panel
    line(img, { x: 70, y: 330 }, { x: 610, y: 330 }, 1, 0);
    line(img, { x: 70, y: 330 }, { x: 70, y: 30 }, 1, 0);
    for (const x of [160, 250, 340, 430, 520, 610]) line(img, { x, y: 330 }, { x, y: 336 }, 1, 0);
    for (const y of [270, 210, 150, 90, 30]) line(img, { x: 64, y }, { x: 70, y }, 1, 0);
    const det = detectAxes(img);
    expect(det.xAxis?.virtual).toBeUndefined();
    expect(det.xAxis?.line.offset).toBeCloseTo(330, 1);
    expect(det.yAxis?.line.offset).toBeCloseTo(70, 1);
    expect(det.xAxis?.ticks.source).toBeUndefined();
  });
});

describe('short log minors', () => {
  it('finds a two-decade log axis whose minor ticks stick out only a pixel past the line', () => {
    const img = canvas(640, 420);
    line(img, { x: 70, y: 330 }, { x: 610, y: 330 }, 1, 0);
    line(img, { x: 70, y: 330 }, { x: 70, y: 30 }, 1, 0);
    for (const x of [160, 250, 340, 430, 520, 610]) line(img, { x, y: 330 }, { x, y: 336 }, 1, 0);
    // Decades at 300 and 150 (two decade ticks, 3.5 px past the line); minors at log10(2…9) of
    // each, only 1.4 px past it (antialiased over two rows).
    for (const base of [300, 150]) {
      line(img, { x: 66.5, y: base }, { x: 70, y: base }, 1, 0);
      for (let k = 2; k <= 9; k++) {
        const y = base - 150 * Math.log10(k);
        if (y > 25) line(img, { x: 68.4, y }, { x: 70, y }, 1, 0);
      }
    }
    const t = detectAxes(img).yAxis?.ticks;
    expect(t?.pattern).toBe('log');
    expect(t?.ticks.filter((k) => k.kind === 'major').length).toBe(2);
    expect(t?.ticks.filter((k) => k.kind === 'minor').length).toBeGreaterThanOrEqual(10);
  });
});

describe('gridlines as tick positions on an old-scan look-alike (synthetic c70: heavy grid, no tick marks)', () => {
  it('takes both axes\' positions from the gridlines, each at a labelled tick, none at the frame', () => {
    const buf = readFileSync(new URL('../../bench/axes/synthetic/c70.jpg', import.meta.url));
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    const det = detectAxes({ width: j.width, height: j.height, data: j.data });
    const truth = JSON.parse(readFileSync(new URL('../../bench/axes/synthetic/c70.json', import.meta.url), 'utf8')) as {
      xAxis: { ticks: { px: number; py: number }[] };
      yAxis: { ticks: { px: number; py: number }[] };
    };
    for (const [ax, at] of [
      [det.xAxis, truth.xAxis.ticks.map((t) => ({ x: t.px, y: t.py }))],
      [det.yAxis, truth.yAxis.ticks.map((t) => ({ x: t.px, y: t.py }))],
    ] as const) {
      expect(ax?.virtual).toBeUndefined(); // the frame is drawn: the axis is that line
      expect(ax?.ticks.source).toBe('gridlines');
      expect(ax?.ticks.side).toBe('inside');
      const ticks = ax?.ticks.ticks ?? [];
      // The heavy grid runs through every second label.
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      for (const t of ticks) {
        expect(Math.min(...at.map((p) => Math.hypot(p.x - t.point.x, p.y - t.point.y)))).toBeLessThan(1.5);
      }
      // No tick at either end of the axis: the frame lines are not gridlines.
      const ends = [ax?.line.start ?? 0, ax?.line.end ?? 0];
      for (const t of ticks) for (const e of ends) expect(Math.abs(t.along - e)).toBeGreaterThan(5);
    }
  });
});
