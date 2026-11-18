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

/**
 * How far along its own line from the background a colour can go before a channel runs out: the α
 * of the darkest shade of the series' hue (1 for black on white; about 2 for a mid grey, whose
 * hue black continues).
 */
export function maxAlpha(m: ColorModel): number {
  let a = Number.POSITIVE_INFINITY;
  for (let c = 0; c < 3; c++) {
    const d = m.dir[c]!;
    if (Math.abs(d) < 1) continue;
    a = Math.min(a, d < 0 ? m.bg[c]! / -d : (255 - m.bg[c]!) / d);
  }
  return Number.isFinite(a) ? a : 1;
}

/** A grey series is told from black ink when black is at least this many times its contrast… */
export const DARKER_MIN = 1.6;
/** …and its colour is a neutral grey (saturation against the background, as in `colorModel`). */
const GREY_CHROMA = 0.1;

/**
 * Whether the series' colour is a grey that black continues (`markDarkerInk` applies): neutral,
 * and black at least DARKER_MIN times its contrast. A coloured series is told from black by its hue.
 */
export function greySeries(m: ColorModel): boolean {
  return chromaOf(m) <= GREY_CHROMA && maxAlpha(m) >= DARKER_MIN;
}

/** Whether the series is black (or near it): neutral, and nothing of its hue is much darker. */
export function neutralBlack(m: ColorModel): boolean {
  return chromaOf(m) <= GREY_CHROMA && maxAlpha(m) < DARKER_MIN;
}

/** Saturation of the series against the background (0 for black and greys). */
function chromaOf(m: ColorModel): number {
  const mean = (m.dir[0] + m.dir[1] + m.dir[2]) / 3;
  return Math.hypot(m.dir[0] - mean, m.dir[1] - mean, m.dir[2] - mean) / Math.sqrt(m.len2);
}
/** Ink at least this much covered is darker than the series' own colour (beyond JPEG noise). */
const DARKER_INK = 1.15;
/** A piece of ink touching darker ink and no larger than this (px) is that ink's fringe. */
const RIM_PIECE = 12;

/**
 * Ink much darker than a grey series' own colour — black markers, text and axes over and around a
 * grey curve — lies on the same colour line, beyond it (α well above 1), so the colour model alone
 * counts it as the series' strongest ink. It is another series: an occluder (α −1, `other`), with
 * its anti-aliased rim (the pixels next to it that are at least half covered, and one more pixel
 * out where they are still clearly darker than the series) and any small piece of ink left
 * touching it — never the seed's own piece). `aMax`: `maxAlpha` of the series' model.
 * Returns the number of pixels taken out.
 */
export function markDarkerInk(
  alpha: Float32Array,
  other: Uint8Array,
  region: { width: number; x0: number; y0: number; x1: number; y1: number },
  aMax: number,
  seed: { x: number; y: number },
): Uint8Array | null {
  const { width: w, x0, y0, x1, y1 } = region;
  const dark = 1 + Math.max(0.35, 0.4 * (aMax - 1));
  const mark = new Uint8Array(alpha.length);
  let any = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = y * w + x;
      if ((alpha[k] ?? -1) >= dark) {
        mark[k] = 1;
        any = true;
      }
    }
  }
  if (!any) return null;
  // The rim: one pixel out into any ink, a second only into ink still clearly darker than the series.
  for (const min of [ON_ALPHA, DARKER_INK]) {
    const was = mark.slice();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * w + x;
        if (was[k] || (alpha[k] ?? -1) < min) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            near = yy >= y0 && yy <= y1 && xx >= x0 && xx <= x1 && was[yy * w + xx] === 1;
          }
        }
        if (near) mark[k] = 1;
      }
    }
  }
  // What is left of the rim — a lighter fringe of a glyph or a marker cut off from the rest — is a
  // small piece of ink touching the dark ink: part of it too. (A piece of the curve between two
  // markers is as small; the walk bridges it as a hidden gap.)
  const seen = new Uint8Array(alpha.length);
  const seedK = seed.y * w + seed.x;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k0 = y * w + x;
      if (seen[k0] || mark[k0] || (alpha[k0] ?? -1) < ON_ALPHA) continue;
      const piece: number[] = [k0];
      seen[k0] = 1;
      let touches = false;
      for (let i = 0; i < piece.length; i++) {
        const k = piece[i]!;
        const px = k % w;
        const py = (k - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx;
            const yy = py + dy;
            if (xx < x0 || xx > x1 || yy < y0 || yy > y1) continue;
            const nk = yy * w + xx;
            if (mark[nk]) touches = true;
            else if (!seen[nk] && (alpha[nk] ?? -1) >= ON_ALPHA) {
              seen[nk] = 1;
              piece.push(nk);
            }
          }
        }
      }
      if (touches && piece.length <= RIM_PIECE && !piece.includes(seedK)) for (const k of piece) mark[k] = 1;
    }
  }
  for (let k = 0; k < mark.length; k++) {
    if (!mark[k]) continue;
    alpha[k] = -1;
    other[k] = 1;
  }
  return mark;
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
  return climb(img, bg, seed, allowed);
}

/** Move a seed, a few 1-px steps at most, onto stronger shades of its own colour. */
function climb(img: Img, bg: RGB, seed: { x: number; y: number }, allowed: (k: number) => boolean): { x: number; y: number } {
  const { width: w, height: h } = img;
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
 * A click inside an open marker: the background at (px, py) is enclosed by ink — its 4-connected
 * background component stays within `reach` px of the click (a legend box or the space between
 * error bars leaks out). The hole pixel and a seed on the enclosing ink nearest the click (moved
 * onto its strongest shade, as `refineSeed`); null when the click is on ink, in open background,
 * or the hole runs past the plot.
 */
export function enclosedHole(
  img: Img,
  bg: RGB,
  px: number,
  py: number,
  reach: number,
  allowed: (k: number) => boolean,
): { hole: { x: number; y: number }; seed: { x: number; y: number } } | null {
  const { width: w, height: h } = img;
  const cx = Math.round(px);
  const cy = Math.round(py);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
  const isInk = (k: number) => dist(rgbAt(img, k), bg) >= INK_MIN;
  const k0 = cy * w + cx;
  if (!allowed(k0) || isInk(k0)) return null;
  const x0 = Math.max(0, cx - reach);
  const y0 = Math.max(0, cy - reach);
  const x1 = Math.min(w - 1, cx + reach);
  const y1 = Math.min(h - 1, cy + reach);
  const seen = new Set<number>([k0]);
  const stack = [k0];
  let seed: { x: number; y: number } | null = null;
  let best = Infinity;
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    const y = (k - x) / w;
    // Reaching the window's edge: not a hole.
    if (x === x0 || x === x1 || y === y0 || y === y1) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const n = ny * w + nx;
      if (seen.has(n)) continue;
      if (!allowed(n)) return null;
      if (isInk(n)) {
        const d = Math.hypot(nx - px, ny - py);
        if (d < best) {
          best = d;
          seed = { x: nx, y: ny };
        }
        continue;
      }
      seen.add(n);
      stack.push(n);
    }
  }
  return seed ? { hole: { x: cx, y: cy }, seed: climb(img, bg, seed, allowed) } : null;
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
