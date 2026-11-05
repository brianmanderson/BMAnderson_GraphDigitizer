/**
 * Marker (scatter) detection: connected blobs of the series colour, matched against the blob
 * under the seed (the template). Same blob rules as snap-to-marker (src/ui/snap.ts): pixels at
 * least half covered by the colour, 8-connected, centroid weighted by coverage over the blob and
 * the pixels touching it (sub-pixel centres of anti-aliased markers).
 *
 * A blob is a marker when its area, size and fill ratio are close to the template's: lines, text
 * and legend boxes differ in at least one. Overlapping markers merge into a blob a whole multiple
 * of the template's area; it is split by k-means into that many centroids (lower confidence).
 * A partly hidden marker (another series drawn over it) keeps ≥ 45 % of the area and still counts.
 */

import { ON_ALPHA } from './color.ts';
import type { Region } from './region.ts';

export interface Blob {
  label: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** Coverage-weighted centroid. */
  cx: number;
  cy: number;
  /** sqrt of the ratio of the second-moment eigenvalues (1 = round, large = a stroke). */
  elongation: number;
}

export interface Blobs {
  /** Image-sized; 0 = not "on", otherwise blob label (index + 1 into `blobs`). */
  labels: Int32Array;
  blobs: Blob[];
}

const bw = (b: Blob) => b.x1 - b.x0 + 1;
const bh = (b: Blob) => b.y1 - b.y0 + 1;

/** Label every 8-connected blob of "on" pixels in the region. */
export function findBlobs(alpha: Float32Array, region: Region): Blobs {
  const { width: w, height: h, x0, y0, x1, y1 } = region;
  const labels = new Int32Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k0 = y * w + x;
      if (labels[k0] || (alpha[k0] ?? -1) < ON_ALPHA) continue;
      const label = blobs.length + 1;
      labels[k0] = label;
      stack.push(k0);
      let bx0 = x;
      let bx1 = x;
      let by0 = y;
      let by1 = y;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      while (stack.length) {
        const k = stack.pop()!;
        const px = k % w;
        const py = (k - px) / w;
        area++;
        sx += px;
        sy += py;
        sxx += px * px;
        syy += py * py;
        sxy += px * py;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < y0 || ny > y1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < x0 || nx > x1) continue;
            const nk = ny * w + nx;
            if (labels[nk] || (alpha[nk] ?? -1) < ON_ALPHA) continue;
            labels[nk] = label;
            stack.push(nk);
          }
        }
      }
      const mx = sx / area;
      const my = sy / area;
      const cxx = sxx / area - mx * mx + 1 / 12;
      const cyy = syy / area - my * my + 1 / 12;
      const cxy = sxy / area - mx * my;
      const tr = cxx + cyy;
      const det = cxx * cyy - cxy * cxy;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + disc;
      const l2 = Math.max(1e-6, tr / 2 - disc);
      blobs.push({ label, x0: bx0, y0: by0, x1: bx1, y1: by1, area, cx: mx, cy: my, elongation: Math.sqrt(l1 / l2) });
    }
  }
  for (const b of blobs) refineCentroid(alpha, labels, w, h, b);
  return { labels, blobs };
}

/** Coverage-weighted centroid over the blob and the partially covered pixels touching it. */
function refineCentroid(alpha: Float32Array, labels: Int32Array, w: number, h: number, b: Blob): void {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = Math.max(0, b.y0 - 1); y <= Math.min(h - 1, b.y1 + 1); y++) {
    for (let x = Math.max(0, b.x0 - 1); x <= Math.min(w - 1, b.x1 + 1); x++) {
      const k = y * w + x;
      const a = alpha[k] ?? -1;
      if (a <= 0) continue;
      let take = labels[k] === b.label;
      if (!take && !labels[k]) {
        for (let dy = -1; dy <= 1 && !take; dy++) {
          for (let dx = -1; dx <= 1 && !take; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            take = nx >= 0 && ny >= 0 && nx < w && ny < h && labels[ny * w + nx] === b.label;
          }
        }
      }
      if (!take) continue;
      const wgt = Math.min(1, a);
      sw += wgt;
      sx += wgt * x;
      sy += wgt * y;
    }
  }
  if (sw > 0) {
    b.cx = sx / sw;
    b.cy = sy / sw;
  }
}

export interface Marker {
  px: number;
  py: number;
  confidence: number;
}

/** Split a merged blob into k centroids (k-means on its pixels, farthest-point start). */
function splitBlob(labels: Int32Array, w: number, b: Blob, k: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (labels[y * w + x] === b.label) pts.push({ x, y });
  const centres = [{ ...pts[0]! }];
  while (centres.length < k) {
    let best = pts[0]!;
    let bestD = -1;
    for (const p of pts) {
      const d = Math.min(...centres.map((c) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    centres.push({ ...best });
  }
  for (let it = 0; it < 12; it++) {
    const acc = centres.map(() => ({ x: 0, y: 0, n: 0 }));
    for (const p of pts) {
      let bi = 0;
      let bd = Infinity;
      centres.forEach((c, i) => {
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      const a = acc[bi]!;
      a.x += p.x;
      a.y += p.y;
      a.n++;
    }
    centres.forEach((c, i) => {
      const a = acc[i]!;
      if (a.n) {
        c.x = a.x / a.n;
        c.y = a.y / a.n;
      }
    });
  }
  return centres;
}

/** Every blob that looks like the template, as marker centroids ordered by px. */
export function matchMarkers(found: Blobs, template: Blob, width: number): Marker[] {
  const tw = bw(template);
  const th = bh(template);
  const fill = (b: Blob) => b.area / (bw(b) * bh(b));
  const tf = fill(template);
  const out: Marker[] = [];
  for (const b of found.blobs) {
    const ratio = b.area / template.area;
    const w = bw(b);
    const h = bh(b);
    if (ratio >= 0.45 && ratio <= 2 && w <= 1.6 * tw + 2 && h <= 1.6 * th + 2 && Math.abs(fill(b) - tf) <= 0.25) {
      out.push({ px: b.cx, py: b.cy, confidence: Math.max(0.3, Math.min(1, 1 - 0.5 * Math.abs(ratio - 1))) });
    } else if (ratio > 2 && ratio <= 8.5 && w <= 4 * tw + 2 && h <= 4 * th + 2) {
      const k = Math.round(ratio);
      for (const c of splitBlob(found.labels, width, b, k)) out.push({ px: c.x, py: c.y, confidence: 0.5 });
    }
  }
  return out.sort((a, b) => a.px - b.px || a.py - b.py);
}

export const blobWidth = bw;
export const blobHeight = bh;
