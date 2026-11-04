/**
 * Grayscale and adaptive "ink" map: how much darker each pixel is than its neighbourhood.
 *
 * darkness = max(0, localMean − gray), with the mean over a square window (integral image). A
 * thin line on white keeps nearly its full contrast; the inside of a large filled area (a bar)
 * falls to ~0, so bars become outlines instead of solid blocks; a grey page background or
 * scanner tint cancels out. A pixel is "ink" when its darkness reaches `INK_THRESHOLD`.
 */

import type { RgbaImage } from './types.ts';

/** Darkness (0–255 above the local mean) at which a pixel counts as ink. */
export const INK_THRESHOLD = 24;

export interface DarknessMap {
  width: number;
  height: number;
  /** Row-major, 0–255. */
  dark: Float32Array;
}

/** Rec. 601 luma; transparent pixels are composited on white (charts are drawn on paper). */
export function toGray(img: RgbaImage): Float32Array {
  const { width, height, data } = img;
  const n = width * height;
  if (data.length < n * 4) throw new Error(`RGBA buffer too small for ${width}×${height}`);
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (data[i * 4 + 3] ?? 255) / 255;
    const l = 0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
    gray[i] = l * a + 255 * (1 - a);
  }
  return gray;
}

/** Window radius for the local mean: ~1/40 of the shorter side, at least 7 px. */
export function windowRadius(width: number, height: number): number {
  return Math.max(7, Math.round(Math.min(width, height) / 40));
}

export function darknessMap(img: RgbaImage): DarknessMap {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const r = windowRadius(w, h);
  // Integral image with a zero first row/column.
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x] ?? 0;
      integral[(y + 1) * W + x + 1] = (integral[y * W + x + 1] ?? 0) + rowSum;
    }
  }
  const dark = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum =
        (integral[y1 * W + x1] ?? 0) -
        (integral[y0 * W + x1] ?? 0) -
        (integral[y1 * W + x0] ?? 0) +
        (integral[y0 * W + x0] ?? 0);
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const d = mean - (gray[y * w + x] ?? 0);
      dark[y * w + x] = d > 0 ? d : 0;
    }
  }
  return { width: w, height: h, dark };
}

/** Bilinear sample at a sub-pixel position (integer = pixel centre); −1 outside the image. */
export function sample(map: DarknessMap, x: number, y: number): number {
  const { width: w, height: h, dark } = map;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return -1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const a = dark[i] ?? 0;
  if (fx === 0 && fy === 0) return a;
  const b = fx > 0 ? (dark[i + 1] ?? 0) : 0;
  const c = fy > 0 ? (dark[i + w] ?? 0) : 0;
  const d = fx > 0 && fy > 0 ? (dark[i + w + 1] ?? 0) : 0;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
