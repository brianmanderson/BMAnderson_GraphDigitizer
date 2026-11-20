/**
 * Grayscale and adaptive "ink" map: how much darker each pixel is than its neighbourhood.
 *
 * darkness = max(0, localMean − gray), with the mean over a square window (integral image). A
 * thin line on white keeps nearly its full contrast; the inside of a large filled area (a bar)
 * falls to ~0, so bars become outlines instead of solid blocks; a grey page background or
 * scanner tint cancels out. A pixel is "ink" when its darkness reaches `INK_THRESHOLD`.
 *
 * Polarity. A dark theme draws light ink on a dark background, where nothing is darker than its
 * neighbourhood. Such an image is read as its negative (`inverted`): when the image's border and
 * most of the image are dark (both medians below mid-grey) and more pixels stand out lighter than
 * the border than darker. A light chart with dark bars, or a white panel on a dark page, keeps its
 * polarity. `gray` is the luma after this step, so "ink is darker" holds for every consumer.
 */

import type { RgbaImage } from './types.ts';

/** Darkness (0–255 above the local mean) at which a pixel counts as ink. */
export const INK_THRESHOLD = 24;

export interface DarknessMap {
  width: number;
  height: number;
  /** Row-major, 0–255. */
  dark: Float32Array;
  /**
   * The luma the map was computed from (row-major, 0–255; the negative on a dark theme). Optional
   * so a map built by hand (tests) stays valid: without it panel and gridline detection are off.
   */
  gray?: Float32Array;
  /** Light ink on a dark background: `gray` and `dark` are those of the negative. */
  inverted?: boolean;
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

/** Median of the values at `indices` (or of all of `gray`), by histogram. */
function medianLevel(gray: Float32Array, indices: Int32Array | null): number {
  const hist = new Int32Array(256);
  const n = indices ? indices.length : gray.length;
  for (let i = 0; i < n; i++) {
    const v = Math.round(gray[indices ? (indices[i] as number) : i] as number);
    hist[v] = (hist[v] as number) + 1;
  }
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc * 2 >= n) return v;
  }
  return 255;
}

/** Indices of the pixels in the image's outer ring (~1 % of the short side, at least 2 px). */
export function borderRing(w: number, h: number): Int32Array {
  const m = Math.min(Math.max(2, Math.round(0.01 * Math.min(w, h))), Math.floor(Math.min(w, h) / 2));
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    const edgeRow = y < m || y >= h - m;
    for (let x = 0; x < w; x++) if (edgeRow || x < m || x >= w - m) out.push(y * w + x);
  }
  return Int32Array.from(out);
}

/** A pixel stands out from the background by at least this much luma (polarity vote). */
const POLARITY_MARGIN = 50;

/** Whether the image is light ink on a dark background (see the header). */
export function isDarkTheme(gray: Float32Array, w: number, h: number): boolean {
  if (w < 8 || h < 8) return false;
  const bg = medianLevel(gray, borderRing(w, h));
  if (bg >= 128 || medianLevel(gray, null) >= 128) return false;
  let lighter = 0;
  let darker = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i] as number;
    if (g > bg + POLARITY_MARGIN) lighter++;
    else if (g < bg - POLARITY_MARGIN) darker++;
  }
  return lighter > darker;
}

export function darknessMap(img: RgbaImage): DarknessMap {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const inverted = isDarkTheme(gray, w, h);
  if (inverted) for (let i = 0; i < gray.length; i++) gray[i] = 255 - (gray[i] as number);
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
  return inverted ? { width: w, height: h, dark, gray, inverted } : { width: w, height: h, dark, gray };
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
