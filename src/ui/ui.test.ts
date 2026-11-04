/** Pure UI helpers: view transform, table rows and exports, overlay ticks. */

import { describe, expect, it } from 'vitest';
import { calibrate, parseDateTime, type Calibration, type Dataset } from '../core/index.ts';
import { datasetRows, exportCells, formatNumber, formatValue, toCsv, toTsv } from './table.ts';
import { axisTicks, niceStep } from './ticks.ts';
import { clampToImage, fitView, imageToScreen, isOnImage, panBy, screenToImage, zoomAt } from './view.ts';

describe('view transform', () => {
  it('round-trips image ↔ screen', () => {
    const v = { scale: 2.5, offsetX: -13.25, offsetY: 40 };
    const s = imageToScreen(v, 12.3, 45.6);
    const back = screenToImage(v, s.x, s.y);
    expect(back.px).toBeCloseTo(12.3, 12);
    expect(back.py).toBeCloseTo(45.6, 12);
  });

  it('zooms about the cursor: the image point under it stays put', () => {
    const v = { scale: 1.3, offsetX: 20, offsetY: 30 };
    const before = screenToImage(v, 400, 300);
    const z = zoomAt(v, 400, 300, 3.7);
    const after = screenToImage(z, 400, 300);
    expect(z.scale).toBeCloseTo(4.81, 12);
    expect(after.px).toBeCloseTo(before.px, 9);
    expect(after.py).toBeCloseTo(before.py, 9);
  });

  it('clamps zoom and pans by screen pixels', () => {
    expect(zoomAt({ scale: 1, offsetX: 0, offsetY: 0 }, 0, 0, 1e6).scale).toBe(64);
    expect(panBy({ scale: 2, offsetX: 1, offsetY: 2 }, 10, -5)).toEqual({ scale: 2, offsetX: 11, offsetY: -3 });
  });

  it('fits and centres the whole image (pixel edges at −½ and size − ½)', () => {
    const v = fitView(709, 424, 1006, 700);
    const tl = imageToScreen(v, -0.5, -0.5);
    const br = imageToScreen(v, 708.5, 423.5);
    expect(tl.x).toBeCloseTo(1006 - br.x, 9);
    expect(tl.y).toBeCloseTo(700 - br.y, 9);
    expect(Math.min(tl.x, tl.y)).toBeGreaterThanOrEqual(16 - 1e-9);
  });

  it('treats integer coordinates as pixel centres', () => {
    expect(isOnImage(-0.5, 0, 10, 10)).toBe(true);
    expect(isOnImage(-0.51, 0, 10, 10)).toBe(false);
    expect(clampToImage(20, -3, 10, 10)).toEqual({ px: 9.5, py: -0.5 });
  });
});

function linearCal(): Calibration {
  const r = calibrate(
    {
      X1: { px: 0, py: 100, value: 0 },
      X2: { px: 100, py: 100, value: 10 },
      Y1: { px: 0, py: 100, value: 0 },
      Y2: { px: 0, py: 0, value: 1 },
    },
    'linear',
    'linear',
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.calibration;
}

const dataset = (name: string, points: [number, number][]): Dataset => ({
  id: name,
  name,
  color: '#000000',
  points: points.map(([px, py], i) => ({ id: `${name}${i}`, px, py })),
});

const opts = { significantFigures: 4, dateFormat: 'YYYY-MM-DD', showPixels: false, sortByX: false };

describe('table', () => {
  it('formats significant figures without trailing zeros', () => {
    expect(formatNumber(0.162345, 4)).toBe('0.1623');
    expect(formatNumber(1234567, 3)).toBe('1230000');
    expect(formatNumber(0.5, 4)).toBe('0.5');
    expect(formatNumber(-0.00001, 1)).toBe('-0.00001');
    expect(formatNumber(-1e-20, 2)).toBe('-1e-20');
    expect(formatValue(null, 'linear', opts)).toBe('');
  });

  it('formats date values in UTC with the chosen format', () => {
    const p = parseDateTime('2024-03-10 07:30');
    if (!p.ok) throw new Error(p.message);
    expect(formatValue(p.ms, 'date', { significantFigures: 4, dateFormat: 'DD MMM YYYY HH:mm' })).toBe('10 Mar 2024 07:30');
  });

  it('derives values from pixels, keeps placement numbers when sorting by X', () => {
    const d = dataset('A', [
      [50, 50],
      [10, 90],
      [80, 20],
    ]);
    const rows = datasetRows(d, linearCal(), true);
    expect(rows.map((r) => r.index)).toEqual([2, 1, 3]);
    expect(rows[0]!.x).toBeCloseTo(1, 12);
    expect(rows[0]!.y).toBeCloseTo(0.1, 12);
    expect(datasetRows(d, null, true).map((r) => [r.index, r.x])).toEqual([
      [1, null],
      [2, null],
      [3, null],
    ]);
  });

  it('exports one CSV with a line column, quoting names that need it', () => {
    const cells = exportCells([dataset('A', [[50, 50]]), dataset('B, "treated"', [[100, 0]])], linearCal(), { xScale: 'linear', yScale: 'linear' }, {
      ...opts,
      showPixels: true,
    });
    expect(toCsv(cells)).toBe(
      'line,#,x,y,px,py\r\nA,1,5,0.5,50.0,50.0\r\n"B, ""treated""",1,10,1,100.0,0.0\r\n',
    );
    expect(toTsv(cells).split('\n')[0]).toBe('line\t#\tx\ty\tpx\tpy');
  });

  it('keeps TSV cells on one line', () => {
    expect(toTsv([['a\tb', 'c\nd']])).toBe('a b\tc d\n');
  });
});

describe('overlay ticks', () => {
  it('picks 1-2-5 steps', () => {
    expect(niceStep(190, 8)).toBe(20);
    expect(niceStep(1.4, 8)).toBe(0.2);
    expect(niceStep(7, 7)).toBe(1);
  });

  it('ticks linear axes at round values', () => {
    expect(axisTicks('linear', -0.3, 1.25, [0, 1])).toEqual([-0.2, 0, 0.2, 0.4, 0.6, 0.8, 1, 1.2]);
  });

  it('ticks log axes at decades, in log10 and ln alike', () => {
    expect(axisTicks('log10', -0.2, 3.1, [1, 1000])).toEqual([1, 10, 100, 1000]);
    expect(axisTicks('ln', Math.log(0.9), Math.log(1100), [1, 1000])).toEqual([1, 10, 100, 1000]);
  });

  it('keeps reciprocal ticks in-domain even when the image reaches 1/v = 0', () => {
    for (const v of axisTicks('reciprocal', -0.1, 1, [1, 10])) expect(v).toBeGreaterThan(0);
    expect(axisTicks('reciprocal', 0.1, 1, [1, 10]).length).toBeGreaterThan(2);
  });

  it('never returns more than a few dozen ticks or non-finite values', () => {
    expect(axisTicks('linear', 0, Infinity, [0, 1])).toEqual([]);
    const dates = axisTicks('date', Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31), [0, 1]);
    expect(dates.length).toBeGreaterThan(3);
    expect(dates.length).toBeLessThanOrEqual(40);
  });
});
