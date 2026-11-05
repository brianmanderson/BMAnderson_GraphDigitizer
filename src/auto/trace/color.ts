/**
 * Colour model of the clicked series. Every pixel is written as
 *
 *   colour = background + α · (ink − background) + residual
 *
 * where `ink` is the series colour sampled at the seed. α is how much of the pixel the series
 * covers (anti-aliased edges and JPEG blur give fractions), the residual how far the pixel is from
 * that blend: a pixel of another colour has a large residual whatever its α. This is the same
 * model as snap-to-marker (src/ui/snap.ts), applied to the whole plot area at once.
 *
 * A black series against a white page has α = darkness, so a grey gridline lighter than half the
 * series' contrast is not "on"; other colours (blue, red, green…) are rejected by the residual.
 */

export type RGB = [number, number, number];

export interface Img {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Pixels that belong to the series are at least this much covered by its colour. */
export const ON_ALPHA = 0.5;
/** Minimum RGB distance from the background for the seed to count as ink. */
export const INK_MIN = 40;

/** RGB of pixel index `k` (= y·width + x), transparency composited onto white. */
export function rgbAt(img: Img, k: number): RGB {
  const d = img.data;
  const a = (d[k * 4 + 3] ?? 255) / 255;
  return [
    (d[k * 4] ?? 0) * a + 255 * (1 - a),
    (d[k * 4 + 1] ?? 0) * a + 255 * (1 - a),
    (d[k * 4 + 2] ?? 0) * a + 255 * (1 - a),
  ];
}

export const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface ColorModel {
  bg: RGB;
  ink: RGB;
  /** ink − bg and its squared length. */
  dir: RGB;
  len2: number;
  /** Allowed residual as a fraction of the pixel's own contrast (see `coverage`). */
  tol: number;
}

export function colorModel(bg: RGB, ink: RGB): ColorModel {
  const dir: RGB = [ink[0] - bg[0], ink[1] - bg[1], ink[2] - bg[2]];
  const len2 = Math.max(1e-9, dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
  // Saturation of the series against the background: 0 for black/grey, ~0.6 for orange.
  const mean = (dir[0] + dir[1] + dir[2]) / 3;
  const chroma = Math.hypot(dir[0] - mean, dir[1] - mean, dir[2] - mean) / Math.sqrt(len2);
  return { bg, ink, dir, len2, tol: 0.12 + 0.3 * chroma };
}

/**
 * Coverage α of a colour by the series, or −1 when it is another colour. The residual allowed
 * grows with the pixel's own contrast and with the series' saturation: a saturated thin line in a
 * JPEG loses much of its chroma (4:2:0 subsampling), while a dull brown or a black series must
 * stay distinguishable from a dark grey gridline (≈ 10° apart) and from other colours.
 */
export function coverage(m: ColorModel, c: RGB): number {
  const v0 = c[0] - m.bg[0];
  const v1 = c[1] - m.bg[1];
  const v2 = c[2] - m.bg[2];
  const a = (v0 * m.dir[0] + v1 * m.dir[1] + v2 * m.dir[2]) / m.len2;
  const r = Math.hypot(v0 - a * m.dir[0], v1 - a * m.dir[1], v2 - a * m.dir[2]);
  return r <= Math.max(20, m.tol * Math.hypot(v0, v1, v2)) ? a : -1;
}

/** Per-channel median over pixels where `allowed(k)` holds, sampled on a grid of about 4000 points. */
export function backgroundColor(img: Img, x0: number, y0: number, x1: number, y1: number, allowed: (k: number) => boolean): RGB {
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const step = Math.max(1, Math.floor(Math.sqrt(area / 4000)));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
  let n = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const k = y * img.width + x;
      if (!allowed(k)) continue;
      const c = rgbAt(img, k);
      for (let ch = 0; ch < 3; ch++) hist[ch]![Math.round(c[ch]!)]!++;
      n++;
    }
  }
  if (n === 0) return [255, 255, 255];
  const med = (h: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v]!;
      if (acc * 2 >= n) return v;
    }
    return 255;
  };
  return [med(hist[0]), med(hist[1]), med(hist[2])];
}

/**
 * The seed pixel: the nearest ink pixel within `radius` of the click, then moved (a few steps at
 * most) onto stronger shades of the same colour, so an anti-aliased edge does not set the colour
 * and a darker line of another colour crossing nearby cannot capture it.
 */
export function refineSeed(
  img: Img,
  bg: RGB,
  px: number,
  py: number,
  radius: number,
  allowed: (k: number) => boolean,
): { x: number; y: number } | null {
  const { width: w, height: h } = img;
  let seed: { x: number; y: number } | null = null;
  let best = Infinity;
  for (let y = Math.max(0, Math.ceil(py - radius)); y <= Math.min(h - 1, Math.floor(py + radius)); y++) {
    for (let x = Math.max(0, Math.ceil(px - radius)); x <= Math.min(w - 1, Math.floor(px + radius)); x++) {
      const d = Math.hypot(x - px, y - py);
      const k = y * w + x;
      if (d <= radius && d < best && allowed(k) && dist(rgbAt(img, k), bg) >= INK_MIN) {
        best = d;
        seed = { x, y };
      }
    }
  }
  if (!seed) return null;
  for (let n = 0; n < 4; n++) {
    const m = colorModel(bg, rgbAt(img, seed.y * w + seed.x));
    let bestA = 1.05;
    let next: { x: number; y: number } | null = null;
    for (let y = Math.max(0, seed.y - 1); y <= Math.min(h - 1, seed.y + 1); y++) {
      for (let x = Math.max(0, seed.x - 1); x <= Math.min(w - 1, seed.x + 1); x++) {
        const k = y * w + x;
        if (!allowed(k)) continue;
        const a = coverage(m, rgbAt(img, k));
        if (a > bestA) {
          bestA = a;
          next = { x, y };
        }
      }
    }
    if (!next) break;
    seed = next;
  }
  return seed;
}

/**
 * Series colour: the mean of the pixels near the seed that are (almost) as strongly covered as
 * the seed itself — robust to one noisy JPEG pixel, and still the full colour of a thick line.
 */
export function inkColor(img: Img, bg: RGB, seed: { x: number; y: number }, allowed: (k: number) => boolean): RGB {
  const { width: w, height: h } = img;
  const m = colorModel(bg, rgbAt(img, seed.y * w + seed.x));
  const sum: RGB = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, seed.y - 2); y <= Math.min(h - 1, seed.y + 2); y++) {
    for (let x = Math.max(0, seed.x - 2); x <= Math.min(w - 1, seed.x + 2); x++) {
      const k = y * w + x;
      if (!allowed(k)) continue;
      const c = rgbAt(img, k);
      if (coverage(m, c) >= 0.85) {
        sum[0] += c[0];
        sum[1] += c[1];
        sum[2] += c[2];
        n++;
      }
    }
  }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : m.ink;
}
