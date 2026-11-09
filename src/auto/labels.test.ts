/**
 * Finding tick labels on three real figures (no OCR here: positions, layout and the traps).
 * End-to-end accuracy with OCR is measured by `npm run bench:axes`. Figures and provenance:
 * fixtures/real/PROVENANCE.md.
 */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import glowa from '../../fixtures/real/scatter-errorbars-glowa.json';
import ikawa from '../../fixtures/real/km-sas-frame-ikawa.json';
import pao from '../../fixtures/real/km-pericardial-pao.json';
import { darknessMap } from './darkness.ts';
import { detectAxesInMap } from './detect.ts';
import { findLabels } from './labels.ts';
import type { RgbaImage } from './types.ts';

function load(name: string): RgbaImage {
  const path = name.startsWith('bench/') ? `../../${name}` : `../../fixtures/real/${name}`;
  const buf = readFileSync(new URL(path, import.meta.url));
  if (name.endsWith('.png')) {
    const png = pngjs.PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, data: j.data };
}

/** Mirror top↔bottom (`'v'`) or left↔right (`'h'`): pixel centre k ↦ size − 1 − k. */
function flip(img: RgbaImage, dir: 'v' | 'h'): RgbaImage {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = ((dir === 'v' ? h - 1 - y : y) * w + (dir === 'h' ? w - 1 - x : x)) * 4;
      for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = img.data[j + c] ?? 255;
    }
  }
  return { width: w, height: h, data };
}

function labelsOf(name: string, flips: ('v' | 'h')[] = []) {
  let img = load(name);
  for (const d of flips) img = flip(img, d);
  const map = darknessMap(img);
  const det = detectAxesInMap(map);
  return { det, ...findLabels(map, img, det) };
}

describe('findLabels on km-pericardial-pao (axes with the zero lines inside, risk table below)', () => {
  const f = labelsOf('km-pericardial-pao.png');

  it('finds one label per tick on each axis, at the ticks', () => {
    expect(f.x.mode).toBe('ticks');
    expect(f.x.labels.map((l) => l.along)).toHaveLength(pao.xAxis.ticks.length);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (pao.xAxis.ticks[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    // Y labels in along order = top to bottom.
    const ys = [...pao.yAxis.ticks].sort((a, b) => a.py - b.py);
    expect(f.y.labels).toHaveLength(ys.length);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
  });

  it('keeps the rotated axis title out of the Y labels', () => {
    // The title "Cumulative incidence" runs down columns 3–30; the labels sit at columns 45–98.
    for (const l of f.y.labels) expect(l.box.center.x).toBeGreaterThan(40);
  });

  it("does not take the number-at-risk table (rows 640–688) or the axis title for the X labels", () => {
    // The X labels sit at rows 499–520; the table's numbers stand under the same ticks lower down.
    for (const l of f.x.labels) expect(l.box.center.y).toBeLessThan(530);
  });

  it('sees the decimal point of every Y label ("1.00" … "0.00") and none on X', () => {
    for (const l of f.y.labels) {
      expect(l.marks.points).toHaveLength(1);
      expect(l.marks.points[0]?.char).toBe('.');
    }
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

describe('findLabels on km-sas-frame-ikawa (closed frame not at zero, risk table under the axis title)', () => {
  const f = labelsOf('km-sas-frame-ikawa.png');

  it('matches the eight X and eleven Y labels to their ticks', () => {
    expect(f.x.labels).toHaveLength(8);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (ikawa.xAxis.ticks[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    expect(f.y.labels).toHaveLength(11);
    const ys = [...ikawa.yAxis.ticks].sort((a, b) => a.py - b.py);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
  });

  it("does not take the number-at-risk table for tick labels", () => {
    // The table's numbers (rows 663–706) stand exactly under the x ticks, below the axis title;
    // its row labels "High dose" / "Standard dose" sit left of the frame, below the 0.0 label.
    for (const l of f.x.labels) expect(l.box.center.y).toBeLessThan(630);
    for (const l of f.y.labels) expect(l.box.center.y).toBeLessThan(580);
  });

  it('sees the decimal point of each Y label ("1.0" … "0.0")', () => {
    for (const l of f.y.labels) expect(l.marks.points).toHaveLength(1);
  });
});

describe('findLabels on scatter-errorbars-glowa (closed frame with minor ticks, corner majors in the frame)', () => {
  const f = labelsOf('scatter-errorbars-glowa.png');
  const majors = (ticks: { minor?: boolean }[]) => ticks.filter((t) => !t.minor);

  it('matches the ten X and nine Y labels to the major ticks, including the ones at the frame corners', () => {
    const xs = majors(glowa.xAxis.ticks) as { px: number }[];
    expect(f.x.labels).toHaveLength(xs.length);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (xs[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    const ys = [...(majors(glowa.yAxis.ticks) as { py: number }[])].sort((a, b) => a.py - b.py);
    expect(f.y.labels).toHaveLength(ys.length);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
  });

  it('sees the decimal point of each Y label ("1.0" … "2.6") and none on X', () => {
    for (const l of f.y.labels) expect(l.marks.points).toHaveLength(1);
    for (const l of f.x.labels) expect(l.marks.points).toEqual([]);
  });
});

describe('findLabels on km-pericardial-pao mirrored: a top X axis and a right Y axis', () => {
  const H = 691;
  const W = 710;

  it('looks above a top X axis, and still not at the risk table (now above the labels)', () => {
    const f = labelsOf('km-pericardial-pao.png', ['v']);
    expect(f.det.xAxis?.position).toBe('top');
    expect(f.x.mode).toBe('ticks');
    expect(f.x.labels).toHaveLength(pao.xAxis.ticks.length);
    f.x.labels.forEach((l, i) => expect(Math.abs(l.point.x - (pao.xAxis.ticks[i]?.px ?? NaN))).toBeLessThanOrEqual(1.5));
    // The labels sat at rows 499–520 (now 170–191), the table at 640–688 (now 2–50).
    for (const l of f.x.labels) {
      expect(l.box.center.y).toBeLessThan(H - 1 - pao.xAxis.axisLineRow);
      expect(l.box.center.y).toBeGreaterThan(H - 1 - 530);
    }
    expect(f.y.labels).toHaveLength(pao.yAxis.ticks.length);
    expect(f.y.note).toBeNull();
  });

  it('looks right of a right Y axis', () => {
    const f = labelsOf('km-pericardial-pao.png', ['h']);
    expect(f.det.yAxis?.position).toBe('right');
    const ys = [...pao.yAxis.ticks].sort((a, b) => a.py - b.py);
    expect(f.y.labels).toHaveLength(ys.length);
    f.y.labels.forEach((l, i) => expect(Math.abs(l.point.y - (ys[i]?.py ?? NaN))).toBeLessThanOrEqual(1.5));
    // Right of the axis, not the mirrored rotated title further out (columns 679–706).
    for (const l of f.y.labels) {
      expect(l.box.center.x).toBeGreaterThan(W - 1 - pao.yAxis.axisLineCol);
      expect(l.box.center.x).toBeLessThan(W - 1 - 40);
    }
  });
});

describe('findLabels under a top X axis: the Y axis offset note (synthetic bench/axes charts)', () => {
  it('does not take the corner X label above the Y axis for a Y note (c67, "−0.050" over the corner)', () => {
    const f = labelsOf('bench/axes/synthetic/c67.jpg');
    expect(f.det.xAxis?.position).toBe('top');
    expect(f.x.labels).toHaveLength(6);
    expect(f.y.note).toBeNull();
  });

  it("flags matplotlib's Y note squeezed under the X labels (c63, \"−5e3\") as tangled, never readable", () => {
    const f = labelsOf('bench/axes/synthetic/c63.png');
    expect(f.det.xAxis?.position).toBe('top');
    expect(f.y.note).not.toBeNull();
    expect(f.y.noteTangled).toBe(true);
  });
});
