/**
 * Snap-to-marker: find the centroid of the small dark or coloured blob nearest to a click, for
 * placing points on scatter markers. Pure (works on raw RGBA pixels) so it is unit-tested in Node.
 *
 * 1. The background colour is the per-channel median of the border of a window around the click.
 * 2. The seed is the nearest "ink" pixel (far enough from the background colour) within
 *    `searchRadius`, moved to a neighbouring stronger shade of the same colour so an anti-aliased
 *    edge does not set the colour (but never onto a different colour, such as a line through it).
 * 3. The blob is every pixel 8-connected to the seed that is at least half covered by the seed's
 *    colour: writing a pixel as background + α·(seed − background) + residual, α ≥ ½ and a small
 *    residual. A marker drawn over a line of another colour therefore separates from the line.
 * 4. A blob wider or taller than `maxSize` is a line, curve, axis or text, not a marker: no snap.
 *    A '+' sitting on a curve of the same colour is part of the curve, so it is rejected too.
 * 5. The centroid weights each blob pixel, and each pixel touching the blob, by its coverage α
 *    (clipped to [0, 1]); that recovers sub-pixel centres of anti-aliased markers.
 *
 * Coordinates are image pixels with integer = pixel centre (docs/SPEC.md → Pixel convention).
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel (ImageData.data). */
  data: ArrayLike<number>;
}

export interface SnapOptions {
  /** How far from the click (image px) the blob's nearest pixel may be. */
  searchRadius: number;
  /** Largest blob width/height (image px) that still counts as a marker. */
  maxSize: number;
}

export interface SnapTarget {
  px: number;
  py: number;
  /** Bounding box size of the blob (image px), for drawing the preview. */
  width: number;
  height: number;
}

/** Snap search radius and largest marker size in CSS px; converted to image px at the view scale. */
const SNAP_RADIUS = 12;
const SNAP_MAX_SIZE = 48;

/**
 * Options for a view scale (CSS px per image px): "near" and "small" mean what they look like on
 * screen, with floors in image px so a zoomed-in view still finds markers.
 */
export function snapOptions(viewScale: number): SnapOptions {
  return { searchRadius: Math.max(1.5, SNAP_RADIUS / viewScale), maxSize: Math.max(24, SNAP_MAX_SIZE / viewScale) };
}

/** Minimum RGB distance from the background for a pixel to count as ink. */
const INK_MIN = 48;
/** Coverage at or above which a pixel belongs to the blob. */
const CORE_ALPHA = 0.5;

type RGB = [number, number, number];

function rgb(pix: Pixels, i: number, j: number): RGB {
  const k = (j * pix.width + i) * 4;
  const d = pix.data;
  // Composite transparency onto white, as the page shows it.
  const a = d[k + 3]! / 255;
  return [d[k]! * a + 255 * (1 - a), d[k + 1]! * a + 255 * (1 - a), d[k + 2]! * a + 255 * (1 - a)];
}

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export function findSnapTarget(pix: Pixels, px: number, py: number, opts: SnapOptions): SnapTarget | null {
  const { width: w, height: h } = pix;
  if (w <= 0 || h <= 0 || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  const r = Math.max(0.5, opts.searchRadius);
  const maxSize = Math.max(1, opts.maxSize);

  // 1. Background: median colour of the border of a window that can hold any accepted blob.
  const half = Math.ceil(r + maxSize);
  const x0 = Math.max(0, Math.floor(px) - half);
  const x1 = Math.min(w - 1, Math.ceil(px) + half);
  const y0 = Math.max(0, Math.floor(py) - half);
  const y1 = Math.min(h - 1, Math.ceil(py) + half);
  if (x0 > x1 || y0 > y1) return null;
  const border: RGB[] = [];
  for (let i = x0; i <= x1; i++) border.push(rgb(pix, i, y0), rgb(pix, i, y1));
  for (let j = y0 + 1; j < y1; j++) border.push(rgb(pix, x0, j), rgb(pix, x1, j));
  const bg: RGB = [median(border.map((c) => c[0])), median(border.map((c) => c[1])), median(border.map((c) => c[2]))];

  // 2. Seed: the nearest ink pixel within the search radius…
  let seed: [number, number] | null = null;
  let best = Infinity;
  for (let j = Math.max(0, Math.ceil(py - r)); j <= Math.min(h - 1, Math.floor(py + r)); j++) {
    for (let i = Math.max(0, Math.ceil(px - r)); i <= Math.min(w - 1, Math.floor(px + r)); i++) {
      const d = Math.hypot(i - px, j - py);
      if (d <= r && d < best && dist(rgb(pix, i, j), bg) >= INK_MIN) {
        best = d;
        seed = [i, j];
      }
    }
  }
  if (!seed) return null;
  // …then moved, a few steps at most, to a neighbour that is a stronger shade of the same colour.
  // Only the same colour: a darker line of another colour through the marker must not capture it.
  for (let n = 0; n < 4; n++) {
    const [si, sj] = seed;
    const c0 = rgb(pix, si, sj);
    const d0: RGB = [c0[0] - bg[0], c0[1] - bg[1], c0[2] - bg[2]];
    const l0 = d0[0] ** 2 + d0[1] ** 2 + d0[2] ** 2;
    let bestA = 1.05;
    let next: [number, number] | null = null;
    for (let j = Math.max(0, sj - 1); j <= Math.min(h - 1, sj + 1); j++) {
      for (let i = Math.max(0, si - 1); i <= Math.min(w - 1, si + 1); i++) {
        const c = rgb(pix, i, j);
        const v: RGB = [c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]];
        const a = (v[0] * d0[0] + v[1] * d0[1] + v[2] * d0[2]) / l0;
        const residual = Math.hypot(v[0] - a * d0[0], v[1] - a * d0[1], v[2] - a * d0[2]);
        if (a > bestA && residual <= Math.max(24, 0.35 * Math.hypot(...v))) {
          bestA = a;
          next = [i, j];
        }
      }
    }
    if (!next) break;
    seed = next;
  }
  const ink = rgb(pix, seed[0], seed[1]);
  const dir: RGB = [ink[0] - bg[0], ink[1] - bg[1], ink[2] - bg[2]];
  const len2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
  const tol = Math.max(24, 0.35 * Math.sqrt(len2));

  /** Coverage α of pixel (i, j) by the seed's colour, or null when it is another colour. */
  const coverage = (i: number, j: number): number | null => {
    const c = rgb(pix, i, j);
    const v: RGB = [c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]];
    const a = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / len2;
    const residual = Math.hypot(v[0] - a * dir[0], v[1] - a * dir[1], v[2] - a * dir[2]);
    return residual <= tol ? a : null;
  };

  // 3–4. Flood fill (8-connected) over pixels at least half covered; give up when too large.
  const key = (i: number, j: number) => j * w + i;
  const inBlob = new Set<number>([key(seed[0], seed[1])]);
  const queue: [number, number][] = [seed];
  let minI = seed[0];
  let maxI = seed[0];
  let minJ = seed[1];
  let maxJ = seed[1];
  while (queue.length > 0) {
    const [ci, cj] = queue.pop()!;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= w || j >= h || inBlob.has(key(i, j))) continue;
        const a = coverage(i, j);
        if (a === null || a < CORE_ALPHA) continue;
        inBlob.add(key(i, j));
        minI = Math.min(minI, i);
        maxI = Math.max(maxI, i);
        minJ = Math.min(minJ, j);
        maxJ = Math.max(maxJ, j);
        if (maxI - minI + 1 > maxSize || maxJ - minJ + 1 > maxSize) return null;
        queue.push([i, j]);
      }
    }
  }

  // 5. Coverage-weighted centroid over the blob and the pixels touching it.
  const counted = new Set<number>();
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const k of inBlob) {
    const bi = k % w;
    const bj = (k - bi) / w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = bi + di;
        const j = bj + dj;
        if (i < 0 || j < 0 || i >= w || j >= h || counted.has(key(i, j))) continue;
        counted.add(key(i, j));
        const a = coverage(i, j);
        if (a === null || a <= 0) continue;
        const weight = Math.min(1, a);
        sw += weight;
        sx += weight * i;
        sy += weight * j;
      }
    }
  }
  if (sw <= 0) return null;
  return { px: sx / sw, py: sy / sw, width: maxI - minI + 1, height: maxJ - minJ + 1 };
}
