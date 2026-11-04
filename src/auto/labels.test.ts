/**
 * Finding tick labels on the two real figures (no OCR here: positions, layout and the traps).
 * End-to-end accuracy with OCR is measured by `npm run bench:axes`.
 */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import cns from '../../fixtures/real/km-cns-lymphoma.json';
import peri from '../../fixtures/real/km-pericardial-effusion.json';
import { darknessMap } from './darkness.ts';
import { detectAxesInMap } from './detect.ts';
import { findLabels } from './labels.ts';
import type { RgbaImage } from './types.ts';

function load(name: string): RgbaImage {
  const buf = readFileSync(new URL(`../../fixtures/real/${name}`, import.meta.url));
  if (name.endsWith('.png')) {
    const png = pngjs.PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, data: j.data };
}

function labelsOf(name: string) {
  const img = load(name);
  const map = darknessMap(img);
  return findLabels(map, img, detectAxesInMap(map));
}

describe('findLabels on km-pericardial-effusion', () => {
  const f = labelsOf('km-pericardial-effusion.jpg');

  it('finds one label per tick on each axis, at the ticks', () => {
    expect(f.x.mode).toBe('ticks');
    expect(f.x.labels.map((l) => l.along)).toHaveLength(peri.xAxis.ticks.length);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (peri.xAxis.ticks[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    // Y labels in along order = top to bottom.
    const ys = [...peri.yAxis.ticks].sort((a, b) => a.py - b.py);
    expect(f.y.labels).toHaveLength(ys.length);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
  });

  it('keeps the rotated axis title out of the Y labels', () => {
    // "0.60" sits right next to a title letter; the label box must stay near the axis.
    for (const l of f.y.labels) expect(l.box.center.x).toBeGreaterThan(105);
  });

  it('sees the decimal point of most Y labels ("1.00" … "0.00") and none on X', () => {
    // 7 px text in a JPEG: two of the points touch their digit at full strength, so OCR alone has
    // to find those (it does here); none may be invented.
    const seen = f.y.labels.filter((l) => l.marks.points.length === 1 && l.marks.points[0]?.char === '.');
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const l of f.y.labels) expect(l.marks.points.length).toBeLessThanOrEqual(1);
    for (const l of f.x.labels) expect(l.marks.points).toEqual([]);
  });

  it('finds no exponent, minus sign or offset note', () => {
    for (const l of [...f.x.labels, ...f.y.labels]) {
      expect(l.exponent).toBeNull();
      expect(l.minus).toBe(false);
    }
    expect(f.x.note).toBeNull();
    expect(f.y.note).toBeNull();
  });

  it('cuts upscaled crops with dark text on white', () => {
    const c = f.y.labels[0]!.crop;
    expect(c.height).toBeGreaterThan(28);
    const grey = Array.from({ length: c.width * c.height }, (_, i) => c.data[i * 4] ?? 255);
    expect(Math.min(...grey)).toBeLessThan(60);
    expect(grey[0]).toBe(255);
  });
});

describe('findLabels on km-cns-lymphoma', () => {
  const f = labelsOf('km-cns-lymphoma.png');

  it('matches the six labels of each axis to their ticks', () => {
    expect(f.x.labels).toHaveLength(6);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (cns.xAxis.ticks[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    expect(f.y.labels).toHaveLength(6);
    const ys = [...cns.yAxis.ticks].sort((a, b) => a.py - b.py);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
  });

  it("does not take the number-at-risk table's row labels for tick labels", () => {
    // The table's "0"/"1" sit left of the frame below the 0.0 label (rows ~420–450).
    for (const l of f.y.labels) expect(l.box.center.y).toBeLessThan(410);
  });

  it('sees the decimal point of each Y label, even where antialiasing joins it to a digit', () => {
    for (const l of f.y.labels) expect(l.marks.points).toHaveLength(1);
  });
});
