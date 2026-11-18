/**
 * Marker (scatter) detection. "Find points" (`markerTemplate` + `findMarkers`, below) cuts the
 * clicked marker's shape out of its blob and finds every marker that looks like it; when no shape
 * can be cut out (a marker as thin as its bars), the blob match here is the fallback.
 *
 * Blob match: connected blobs of the series colour, matched against the blob
 * under the seed (the template). Same blob rules as snap-to-marker (src/ui/snap.ts): pixels at
 * least half covered by the colour, 8-connected, centroid weighted by coverage over the blob and
 * the pixels touching it (sub-pixel centres of anti-aliased markers).
 *
 * A blob is a marker when its area, size and fill ratio are close to the template's: lines, text
 * and legend boxes differ in at least one. Overlapping markers merge into a blob a whole multiple
 * of the template's area; it is split by k-means into that many centroids (lower confidence).
 * A partly hidden marker (another series drawn over it) keeps ≥ 45 % of the area and still counts.
 * In a busy scatterplot (many such markers) merged blobs are split by copies of the clicked marker
 * instead (`splitCluster`, below).
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
export function matchMarkers(found: Blobs, template: Blob, width: number, alpha: Float32Array): Marker[] {
  const tw = bw(template);
  const th = bh(template);
  const fill = (b: Blob) => b.area / (bw(b) * bh(b));
  const tf = fill(template);
  let out: Marker[] = [];
  const singles: Blob[] = [];
  const merged: Blob[] = [];
  for (const b of found.blobs) {
    const ratio = b.area / template.area;
    const w = bw(b);
    const h = bh(b);
    if (ratio >= 0.45 && ratio <= 2 && w <= 1.6 * tw + 2 && h <= 1.6 * th + 2 && Math.abs(fill(b) - tf) <= 0.25) {
      singles.push(b);
      out.push({ px: b.cx, py: b.cy, confidence: Math.max(0.3, Math.min(1, 1 - 0.5 * Math.abs(ratio - 1))) });
    } else if (ratio > 2) merged.push(b);
  }
  // A busy scatterplot (many markers like the clicked one): its merged blobs are clusters of them,
  // split by copies of the marker, and a marker standing alone must have its pixels — small shapes
  // of another class ("x" among dots) are as large and as full. Otherwise a merged blob a few
  // markers large is split by area.
  const shape = out.length >= BUSY ? smallShape(found, template, width, alpha) : null;
  if (shape) out = out.filter((_, i) => sameShape(found, width, singles[i]!, shape));
  for (const b of merged) {
    if (shape) out.push(...splitCluster(found, width, b, shape));
    else if (b.area <= 8.5 * template.area && bw(b) <= 4 * tw + 2 && bh(b) <= 4 * th + 2) {
      const k = Math.round(b.area / template.area);
      for (const c of splitBlob(found.labels, width, b, k)) out.push({ px: c.x, py: c.y, confidence: 0.5 });
    }
  }
  return out.sort((a, b) => a.px - b.px || a.py - b.py);
}

/*
 * Clusters of small markers. Hundreds of small markers of one colour ("+", "x", dots) in a busy
 * scatterplot overlap into blobs of many markers, touch the bigger markers of another class drawn
 * among them, and lie beside text of their colour. A merged blob is read as markers only as far as
 * copies of the clicked marker explain it:
 * - a compact part much thicker than the clicked marker is a marker of another, filled shape (a
 *   diamond among "+"): it is cut out, with the strokes of its own size around it, and the small
 *   markers touching it stay;
 * - what is left must be covered by places where the clicked marker's pixels are (nearly) all ink:
 *   a glyph stroke, a ring (a "%"), a line of the colour is thinner than the marker or has
 *   background where the marker has ink, and is no cluster;
 * - the markers are then placed one by one where a copy covers most ink not yet explained, until
 *   what is left is less than a third of a marker.
 */

/** Ink of a black series at most this much covered, with none of its full colour beside it… */
const LIGHTER = 0.75;
const FULL = 0.9;
/** …and runs on for at least this many marker sizes. */
const LIGHTER_RUN = 3;

/**
 * …is a lighter grey of the same hue — a grey curve or gridline among black markers — not the
 * series: taken out of a copy of the coverage map (returns null when there is none). A black
 * marker's anti-aliased edge always has its full colour beside it, and a faint marker is small.
 * `size`: the clicked marker's size, px.
 */
export function withoutLighterInk(alpha: Float32Array, region: Region, size: number): Float32Array | null {
  const { width: w, x0, y0, x1, y1 } = region;
  const light = new Uint8Array(alpha.length);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = y * w + x;
      const a = alpha[k] ?? -1;
      if (a < ON_ALPHA || a > LIGHTER) continue;
      let full = false;
      for (let dy = -1; dy <= 1 && !full; dy++) {
        for (let dx = -1; dx <= 1 && !full; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          full = yy >= y0 && yy <= y1 && xx >= x0 && xx <= x1 && (alpha[yy * w + xx] ?? -1) >= FULL;
        }
      }
      if (!full) light[k] = 1;
    }
  }
  // Only what runs on for several markers' lengths: a faint marker is small.
  let out: Float32Array | null = null;
  const seen = new Uint8Array(alpha.length);
  const reach = LIGHTER_RUN * size;
  for (let k0 = 0; k0 < light.length; k0++) {
    if (!light[k0] || seen[k0]) continue;
    const piece = [k0];
    seen[k0] = 1;
    let bx0 = k0 % w;
    let bx1 = bx0;
    let by0 = (k0 - bx0) / w;
    let by1 = by0;
    for (let i = 0; i < piece.length; i++) {
      const k = piece[i]!;
      const px = k % w;
      const py = (k - px) / w;
      bx0 = Math.min(bx0, px);
      bx1 = Math.max(bx1, px);
      by0 = Math.min(by0, py);
      by1 = Math.max(by1, py);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          const yy = py + dy;
          if (xx < x0 || xx > x1 || yy < y0 || yy > y1) continue;
          const nk = yy * w + xx;
          if (light[nk] && !seen[nk]) {
            seen[nk] = 1;
            piece.push(nk);
          }
        }
      }
    }
    if (Math.max(bx1 - bx0, by1 - by0) + 1 < reach) continue;
    out ??= alpha.slice();
    for (const k of piece) out[k] = -1;
  }
  return out;
}

/** The clicked small marker's pixels, for splitting clusters. */
interface SmallShape {
  /** (dx, dy) offsets of its ink from its anchor pixel; the centre relative to the anchor. */
  pix: number[];
  ox: number;
  oy: number;
  /** Its deepest pixel's distance to background, in thirds of a pixel (chamfer). */
  depth: number;
  size: number;
}

/** A plot with at least this many markers standing alone like the clicked one is busy. */
const BUSY = 25;
/** A single blob of a busy plot is the marker when its pixels overlap the marker's this much (IoU). */
const SAME_SHAPE = 0.45;
/** Share of a copy's pixels that must be ink for it to explain them. */
const FIT = 0.8;
/** Weight of a copy's pixels on background against the new ink it explains. */
const MISFIT = 2;
/** Share of a cluster that copies must explain. */
const EXPLAINED = 0.75;
/** A copy is placed while it explains at least this share of a marker's new ink. */
const PLACE = 0.35;
/** A part thicker than the clicked marker by this many px (and compact) is another marker… */
const THICKER = 1.5;
/** …and at least this deep (px)… */
const THICK_MIN = 1.5;
/** …and covering at least this many small markers' area. */
const BIGGER = 2.5;
/** Clusters larger than this many markers are not split (the work grows with the square). */
const MAX_CLUSTER = 400;

function smallShape(found: Blobs, t: Blob, W: number, alpha: Float32Array): SmallShape | null {
  const w = bw(t) + 2;
  const h = bh(t) + 2;
  const B = new Uint8Array(w * h);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = t.y0; y <= t.y1; y++) {
    for (let x = t.x0; x <= t.x1; x++) {
      if (found.labels[y * W + x] !== t.label) continue;
      B[(y - t.y0 + 1) * w + x - t.x0 + 1] = 1;
      const a = Math.min(1, Math.max(0, alpha[y * W + x] ?? 0));
      sw += a;
      sx += a * x;
      sy += a * y;
    }
  }
  if (!sw) return null;
  const cx = sx / sw;
  const cy = sy / sw;
  const ax = Math.round(cx);
  const ay = Math.round(cy);
  const pix: number[] = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) if (found.labels[y * W + x] === t.label) pix.push(x - ax, y - ay);
  const d = chamfer(B, w, h);
  let depth = 0;
  for (let i = 0; i < w * h; i++) depth = Math.max(depth, d[i]!);
  return { pix, ox: cx - ax, oy: cy - ay, depth, size: Math.max(bw(t), bh(t)) };
}

/** Whether a single blob has the marker's pixels: overlap / union ≥ SAME_SHAPE at the best shift (±1 px). */
function sameShape(found: Blobs, W: number, b: Blob, t: SmallShape): boolean {
  const ax = Math.round(b.cx - t.ox);
  const ay = Math.round(b.cy - t.oy);
  const n = t.pix.length / 2;
  let best = 0;
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      let both = 0;
      for (let k = 0; k < t.pix.length; k += 2) {
        const x = ax + sx + t.pix[k]!;
        const y = ay + sy + t.pix[k + 1]!;
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && found.labels[y * W + x] === b.label) both++;
      }
      best = Math.max(best, both / (n + b.area - both));
    }
  }
  return best >= SAME_SHAPE;
}

/** The markers a merged blob is made of (see above); none when copies of the marker don't explain it. */
function splitCluster(found: Blobs, W: number, b: Blob, t: SmallShape): Marker[] {
  const n = t.pix.length / 2;
  if (b.area > MAX_CLUSTER * n) return [];
  // The blob in a window with a margin of the marker's size (copies may reach out of it).
  const m = t.size + 1;
  const wx0 = b.x0 - m;
  const wy0 = b.y0 - m;
  const w = bw(b) + 2 * m;
  const h = bh(b) + 2 * m;
  const B = new Uint8Array(w * h);
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (found.labels[y * W + x] === b.label) B[(y - wy0) * w + x - wx0] = 1;

  // Compact parts much thicker than the marker: another, filled marker, cut out with its edge.
  const d = chamfer(B, w, h);
  const thick = new Uint8Array(w * h);
  let anyThick = false;
  for (let i = 0; i < w * h; i++) {
    if (d[i]! >= Math.max(t.depth + 3 * THICKER, 3 * THICK_MIN)) {
      thick[i] = 1;
      anyThick = true;
    }
  }
  const other = new Uint8Array(w * h);
  if (anyThick) {
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!thick[i] || seen[i]) continue;
      const c = component(thick, w, h, i, true);
      let x0 = w;
      let y0 = h;
      let x1 = 0;
      let y1 = 0;
      for (const j of c.pixels) {
        seen[j] = 1;
        const x = j % w;
        const y = (j - x) / w;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      const cw = x1 - x0 + 1;
      const ch = y1 - y0 + 1;
      // A thick row of overlapping markers is long; a filled marker is not.
      if (Math.max(cw, ch) > 2 * Math.min(cw, ch) + 2) continue;
      // Its shape: the blob within its depth (+1 px) of the thick part — several small markers'
      // worth (two of them drawn nearly on top of each other are thick only in the middle).
      const shape = new Set<number>();
      for (const j of c.pixels) {
        const x = j % w;
        const y = (j - x) / w;
        const r = d[j]! / 3 + 1;
        const R = Math.ceil(r);
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
          for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
            if (B[yy * w + xx] && (xx - x) ** 2 + (yy - y) ** 2 <= r * r) shape.add(yy * w + xx);
          }
        }
      }
      if (shape.size < BIGGER * n) continue;
      for (const j of shape) other[j] = 1;
    }
  }
  const rest = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) rest[i] = B[i] && !other[i] ? 1 : 0;

  const out: Marker[] = [];
  const done = new Uint8Array(w * h);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!rest[i0] || done[i0]) continue;
    const part = component(rest, w, h, i0, true).pixels;
    for (const j of part) done[j] = 1;
    if (part.length < 0.45 * n) continue;
    const P = new Uint8Array(w * h);
    let px0 = w;
    let py0 = h;
    let px1 = 0;
    let py1 = 0;
    for (const j of part) {
      P[j] = 1;
      const x = j % w;
      const y = (j - x) / w;
      px0 = Math.min(px0, x);
      px1 = Math.max(px1, x);
      py0 = Math.min(py0, y);
      py1 = Math.max(py1, y);
    }
    // Places where a copy of the marker is (nearly) all ink — of this part, or of the cut-out
    // marker it may run under.
    const places: { x: number; y: number; miss: number }[] = [];
    const covered = new Uint8Array(w * h);
    for (let y = Math.max(0, py0 - 1); y <= Math.min(h - 1, py1 + 1); y++) {
      for (let x = Math.max(0, px0 - 1); x <= Math.min(w - 1, px1 + 1); x++) {
        if (!P[y * w + x] && !other[y * w + x]) continue;
        let ink = 0;
        let own = 0;
        for (let k = 0; k < t.pix.length; k += 2) {
          const xx = x + t.pix[k]!;
          const yy = y + t.pix[k + 1]!;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (P[j]) {
            ink++;
            own++;
          } else if (other[j]) ink++;
        }
        if (own && ink >= FIT * n) {
          places.push({ x, y, miss: n - ink });
          for (let k = 0; k < t.pix.length; k += 2) {
            const xx = x + t.pix[k]!;
            const yy = y + t.pix[k + 1]!;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) covered[yy * w + xx] = 1;
          }
        }
      }
    }
    let explained = 0;
    for (const j of part) explained += covered[j]!;
    if (explained < EXPLAINED * part.length) continue;
    // One copy at a time where it explains the most ink not yet explained, less what it would put
    // on background (a copy straddling two markers explains much of both but fits neither).
    const left = P.slice();
    let remaining = part.length;
    while (remaining >= PLACE * n) {
      let best: { x: number; y: number } | null = null;
      let bestNew = 0;
      let bestScore = 0;
      for (const p of places) {
        let fresh = 0;
        for (let k = 0; k < t.pix.length; k += 2) {
          const xx = p.x + t.pix[k]!;
          const yy = p.y + t.pix[k + 1]!;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && left[yy * w + xx]) fresh++;
        }
        const score = fresh - MISFIT * p.miss;
        if (score > bestScore) {
          bestScore = score;
          bestNew = fresh;
          best = p;
        }
      }
      if (!best || bestNew < PLACE * n) break;
      for (let k = 0; k < t.pix.length; k += 2) {
        const xx = best.x + t.pix[k]!;
        const yy = best.y + t.pix[k + 1]!;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && left[yy * w + xx]) {
          left[yy * w + xx] = 0;
          remaining--;
        }
      }
      out.push({ px: best.x + wx0 + t.ox, py: best.y + wy0 + t.oy, confidence: 0.5 });
    }
  }
  return out;
}

export const blobWidth = bw;
export const blobHeight = bh;

/*
 * Markers by shape ("Find points"). A marker with error bars, caps, a reference line or an axis
 * running into it is one blob with all of them, and markers of one colour may differ only in
 * shape or fill (filled vs open circles). So the clicked marker is cut out of its blob by stroke
 * width — a filled shape is what survives an opening wider than the thin strokes attached to it;
 * an open shape is the hole it encloses plus the ring around it — and the rest of the plot is
 * searched for that appearance: ink where the shape has ink, background where it has none (inside
 * an open marker, in a filled one's concave corners, and in a margin around it), with tolerance for
 * a share hidden by another marker or cut off by the plot edge.
 */

/** The clicked marker's appearance: pixel offsets from its anchor that must be ink / background. */
export interface MarkerTemplate {
  shape: 'filled' | 'open';
  /**
   * (dx, dy) pairs: ink; background that defines the shape (inside an open marker, a filled one's
   * concave corners); background in a margin 2–3 px around a filled marker, which pins its size.
   */
  on: number[];
  off: number[];
  margin: number[];
  /** Every pixel of the marker (a filled shape; an open one's ring and inside) and a 1-px rim. */
  body: number[];
  /** Filled: ink at least 2 px inside the marker's edge — solid in a marker, not in a cluster of smaller ones. */
  deep: number[];
  /** Anchor pixel in the image and the marker's centre relative to it (sub-pixel). */
  ax: number;
  ay: number;
  ox: number;
  oy: number;
  /** Larger side of the marker's box, px. */
  size: number;
  /** Filled: the opening radius that cut it out of its blob (thin strokes vanish), px. */
  open: number;
  /** Pixels of ink in the marker. */
  area: number;
}

/**
 * Chamfer (3-4) distance to the nearest pixel outside `inside`, in thirds of a pixel. `edge`: the
 * window's surroundings count as outside (a shape's depth), or not (a distance to a set).
 */
function chamfer(inside: Uint8Array, w: number, h: number, edge = true): Uint16Array {
  const E = edge ? 3 : 60000;
  const d = new Uint16Array(w * h);
  const BIG = 60000;
  for (let i = 0; i < w * h; i++) d[i] = inside[i] ? BIG : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      v = Math.min(v, x > 0 ? d[i - 1]! + 3 : E);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + 4);
      } else v = Math.min(v, E);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      v = Math.min(v, x < w - 1 ? d[i + 1]! + 3 : E);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + 4);
      } else v = Math.min(v, E);
      d[i] = v;
    }
  }
  return d;
}

/** The connected component of `mask` containing index `start` (window coordinates). */
function component(mask: Uint8Array, w: number, h: number, start: number, eight: boolean): { pixels: number[]; border: boolean } {
  const pixels: number[] = [];
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  let border = false;
  while (stack.length) {
    const i = stack.pop()!;
    pixels.push(i);
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!eight && dx && dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return { pixels, border };
}

/**
 * Whether the hole next to the seed is a pocket between a long stroke and thinner ink of its
 * colour (a thick curve over gridlines and bar outlines: a dose-response plot), not the inside of an
 * open marker: the seed's stroke — the ink at least ¾ as deep as at the seed, widened back to its
 * edges — runs out of the window and borders less than half of the hole. A ring bounds its whole
 * hole, whatever is attached to it; a thin stroke (1–2 px) is never told from thinner ink.
 * `d`: depth in the blob `B`, `dH`: distance to the hole (both in thirds of a pixel).
 */
function throughStroke(B: Uint8Array, d: Uint16Array, w: number, h: number, sx: number, sy: number, dH: Uint16Array): boolean {
  // The stroke's own depth at the seed (a junction beside it is deeper).
  let depth = 0;
  let core = -1;
  for (let y = Math.max(0, sy - 1); y <= Math.min(h - 1, sy + 1); y++) {
    for (let x = Math.max(0, sx - 1); x <= Math.min(w - 1, sx + 1); x++) {
      if (d[y * w + x]! > depth) {
        depth = d[y * w + x]!;
        core = y * w + x;
      }
    }
  }
  if (core < 0) return false;
  const minDeep = Math.ceil(0.75 * depth);
  const notDeep = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) notDeep[i] = B[i] && d[i]! >= minDeep ? 0 : 1;
  const toDeep = chamfer(notDeep, w, h, false);
  // Widened back to the stroke's edge (depth 1 px), not into the thinner lines it crosses.
  const stroke = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) stroke[i] = B[i] && toDeep[i]! <= minDeep - 2 ? 1 : 0;
  if (!component(stroke, w, h, core, true).border) return false;
  let rim = 0;
  let onStroke = 0;
  for (let i = 0; i < w * h; i++) {
    if (!B[i] || dH[i]! > 4) continue;
    rim++;
    if (stroke[i]) onStroke++;
  }
  return 2 * onStroke < rim;
}

/**
 * Cut the clicked marker out of its blob. Filled: the thickest part of the blob under the seed
 * (the seed inside its inscribed circle), opened by a radius between the attached strokes' half
 * width and the marker's (0.4 × its inscribed radius, ≥ 2 px). Open: a hole enclosed by the blob
 * right next to the seed, and the ring around it. Null when neither is a compact marker.
 * `hole` (a background pixel the click landed on, enclosed by the blob) makes it the open marker
 * around that hole, never the filled marker the ring may be merged with.
 */
export function markerTemplate(
  found: Blobs,
  alpha: Float32Array,
  region: Region,
  seed: { x: number; y: number },
  markerMax: number,
  clicked: { x: number; y: number } | null = null,
): MarkerTemplate | null {
  const W = region.width;
  const label = found.labels[seed.y * W + seed.x];
  if (!label) return null;
  const R = Math.ceil(1.5 * markerMax);
  const x0 = Math.max(region.x0, seed.x - R);
  const y0 = Math.max(region.y0, seed.y - R);
  const x1 = Math.min(region.x1, seed.x + R);
  const y1 = Math.min(region.y1, seed.y + R);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const B = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (found.labels[y * W + x] === label) B[(y - y0) * w + (x - x0)] = 1;
  const d = chamfer(B, w, h);
  const sx = seed.x - x0;
  const sy = seed.y - y0;

  // The thickest point whose inscribed circle holds the seed.
  let core = -1;
  let coreD = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = d[y * w + x]!;
      if (v > coreD && Math.hypot(x - sx, y - sy) <= v / 3 + 1.5) {
        coreD = v;
        core = y * w + x;
      }
    }
  }
  let M: Uint8Array | null = null;
  let hole: Uint8Array | null = null;
  let k = 0;
  const D = coreD / 3;
  if (D >= 2.5 && !clicked) {
    k = Math.max(2, Math.min(D - 1, 0.4 * D));
    const notE = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) notE[i] = d[i]! >= 3 * k ? 0 : 1;
    const dE = chamfer(notE, w, h, false);
    const O = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) O[i] = B[i] && dE[i]! <= 3 * k + 1 ? 1 : 0;
    if (O[core]) {
      const c = component(O, w, h, core, true);
      if (!c.border) {
        // The shape itself is the blob's ink within a pixel of the opened part: the opening cut
        // the strokes off but also rounded a square's corners (or squared a small circle).
        const notC = new Uint8Array(w * h).fill(1);
        for (const i of c.pixels) notC[i] = 0;
        const dC = chamfer(notC, w, h, false);
        M = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (B[i] && dC[i]! <= 3) M[i] = 1;
      }
    }
  }
  if (!M) {
    // An open marker: the hole the blob encloses next to the seed (4-connected background, so a
    // diagonal step in a thin ring does not leak) — or the hole the click landed in.
    const notB = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) notB[i] = B[i] ? 0 : 1;
    let best: number[] | null = null;
    if (clicked) {
      const hx = clicked.x - x0;
      const hy = clicked.y - y0;
      if (hx >= 0 && hy >= 0 && hx < w && hy < h && notB[hy * w + hx]) {
        const c = component(notB, w, h, hy * w + hx, false);
        if (!c.border && c.pixels.length >= 3) best = c.pixels;
      }
    } else {
      const reach = Math.max(3, (2 * (d[sy * w + sx] ?? 3)) / 3 + 3);
      let bestDist = Infinity;
      const tried = new Uint8Array(w * h);
      for (let y = Math.max(0, Math.floor(sy - reach)); y <= Math.min(h - 1, Math.ceil(sy + reach)); y++) {
        for (let x = Math.max(0, Math.floor(sx - reach)); x <= Math.min(w - 1, Math.ceil(sx + reach)); x++) {
          const i = y * w + x;
          if (!notB[i] || tried[i]) continue;
          const c = component(notB, w, h, i, false);
          for (const j of c.pixels) tried[j] = 1;
          const dist = Math.hypot(x - sx, y - sy);
          if (!c.border && c.pixels.length >= 3 && dist < bestDist) {
            best = c.pixels;
            bestDist = dist;
          }
        }
      }
    }
    if (best) {
      hole = new Uint8Array(w * h);
      for (const i of best) hole[i] = 1;
      const notHole = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) notHole[i] = hole[i] ? 0 : 1;
      const dH = chamfer(notHole, w, h, false);
      // A pocket beside a thick line, walled off by thinner lines of its colour, is no marker.
      if (!clicked && throughStroke(B, d, w, h, sx, sy, dH)) return null;
      // Ring width: twice the half width of the blob just outside the hole.
      const halves: number[] = [];
      for (let i = 0; i < w * h; i++) if (B[i] && dH[i]! <= 6) halves.push(d[i]! / 3);
      halves.sort((a, b) => a - b);
      const ring = 2 * (halves[halves.length >> 1] ?? 1) + 1;
      M = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (hole[i] || (B[i] && dH[i]! <= 3 * ring)) M[i] = 1;
    }
  }
  if (!M) return null;

  let mx0 = w;
  let my0 = h;
  let mx1 = -1;
  let my1 = -1;
  let sw = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!M[y * w + x]) continue;
      mx0 = Math.min(mx0, x);
      mx1 = Math.max(mx1, x);
      my0 = Math.min(my0, y);
      my1 = Math.max(my1, y);
      const a = hole?.[y * w + x] ? 1 : Math.min(1, Math.max(0, alpha[(y + y0) * W + x + x0] ?? 0));
      sw += a;
      cx += a * x;
      cy += a * y;
    }
  }
  const bw = mx1 - mx0 + 1;
  const bh = my1 - my0 + 1;
  if (!sw || bw > markerMax || bh > markerMax || bw > 2.5 * bh || bh > 2.5 * bw || mx0 === 0 || my0 === 0 || mx1 === w - 1 || my1 === h - 1) return null;
  cx /= sw;
  cy /= sw;
  const ax = Math.round(cx);
  const ay = Math.round(cy);
  const notM = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) notM[i] = M[i] ? 0 : 1;
  const inM = chamfer(M, w, h); // depth inside the marker
  const outM = chamfer(notM, w, h, false); // distance outside it
  const inHole = hole ? chamfer(hole, w, h) : null; // depth inside the hole
  const on: number[] = [];
  const off: number[] = [];
  const margin: number[] = [];
  const thin = Math.min(bw, bh) < 6;
  for (let y = Math.max(0, my0 - 4); y <= Math.min(h - 1, my1 + 4); y++) {
    for (let x = Math.max(0, mx0 - 4); x <= Math.min(w - 1, mx1 + 4); x++) {
      const i = y * w + x;
      if (hole?.[i]) {
        // The inside of an open marker, a pixel clear of its ring.
        if (inHole![i]! >= 6) off.push(x - ax, y - ay);
        continue;
      }
      if (M[i]) {
        // Ink well inside a filled shape (its anti-aliased rim is left out); all of a ring.
        if (B[i] && (thin || hole || inM[i]! > 3)) on.push(x - ax, y - ay);
        continue;
      }
      // Outside a filled shape: a margin of background 2–3 px out (matched on the opened image,
      // where the strokes attached to a marker are gone) and its concave corners. An open shape's
      // size is pinned by its ring and inside; strokes attach right outside it.
      const out = outM[i]! / 3;
      const inBox = x >= mx0 && x <= mx1 && y >= my0 && y <= my1;
      if (!hole && out >= 1.5 && inBox) off.push(x - ax, y - ay);
      else if (!hole && out >= 2 && out <= 3.4) margin.push(x - ax, y - ay);
    }
  }
  if (on.length < 8) return null;
  let area = 0;
  for (let i = 0; i < w * h; i++) if (M[i] && B[i]) area++;
  const deep: number[] = [];
  if (!hole) for (let i = 0; i < on.length; i += 2) if (inM[(on[i + 1]! + ay) * w + on[i]! + ax]! >= 6) deep.push(on[i]!, on[i + 1]!);
  const body: number[] = [];
  for (let y = Math.max(0, my0 - 1); y <= Math.min(h - 1, my1 + 1); y++) {
    for (let x = Math.max(0, mx0 - 1); x <= Math.min(w - 1, mx1 + 1); x++) if (outM[y * w + x]! <= 4) body.push(x - ax, y - ay);
  }
  return { shape: hole ? 'open' : 'filled', area, on, off, margin, body, deep, ax: ax + x0, ay: ay + y0, ox: cx - ax, oy: cy - ay, size: Math.max(bw, bh), open: hole ? 0 : k };
}

/**
 * Share of a template's ink that must be found, and of its background that must be clear. For a
 * filled shape, down to HIDDEN_SHARE of the ink is enough when what is missing lies to one side
 * (another marker's white inside drawn over it): a different shape misses ink all round (a
 * square's corners). An open shape under another marker of its colour still shows as ink, and two
 * error bars beside a pocket of background would pass for most of a ring: no such allowance.
 */
const ON_SHARE = 0.8;
const HIDDEN_SHARE = 0.65;
const OFF_SHARE = 0.75;
/** Share of a filled marker's inside (2 px from its edge) that may be background. */
const SOLID_HOLES = 0.05;
/** That many small blobs of the colour make a plot busy. */
const BUSY_SMALL = 60;
/** A filled marker's margin need only be half clear: its neighbours in a cluster reach into it. */
const MARGIN_SHARE = 0.5;
const fits = (t: MarkerTemplate, s: { on: number; off: number; margin: number; lopsided: number }) =>
  s.off >= OFF_SHARE && s.margin >= MARGIN_SHARE && (s.on >= ON_SHARE || (t.shape === 'filled' && s.on >= HIDDEN_SHARE && s.lopsided >= 0.15));

/**
 * Every place the plot looks like the template, as marker centres ordered by px. Pixels outside
 * the region (beyond the plot edge, an excluded axis line) are unknown and not counted; at least
 * half of the template must be known. Peaks closer than 0.6 × the marker's size are one marker; the
 * centre is refined to sub-pixel from the agreement at the neighbouring positions.
 */
export function findMarkers(found: Blobs, alpha: Float32Array, other: Uint8Array, region: Region, t: MarkerTemplate): Marker[] {
  const { x0, y0, x1, y1 } = region;
  const { ink, score } = matcher(alpha, other, region, t);
  // Among many small markers of its colour (a busy scatterplot: compact blobs a third of its size or
  // less), a filled marker must be solid inside: background well inside it is a pile of the small
  // ones (overlapping "+" taking a diamond's place).
  const busy = t.shape === 'filled' && found.blobs.filter((b) => b.area >= 4 && b.area <= t.area / 3 && b.elongation < 2).length >= BUSY_SMALL;
  const solid = (x: number, y: number): boolean => {
    let holes = 0;
    for (let i = 0; i < t.deep.length; i += 2) if (ink(x + t.deep[i]!, y + t.deep[i + 1]!, true) === 0) holes++;
    return holes <= SOLID_HOLES * (t.deep.length / 2);
  };
  // A dozen of the template's ink pixels, spread over it, for a quick first look.
  const probe: number[] = [];
  const step = Math.max(1, Math.floor(t.on.length / 2 / 12));
  for (let i = 0; i < t.on.length; i += 2 * step) probe.push(t.on[i]!, t.on[i + 1]!);
  const hits: { x: number; y: number; s: number }[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // The anchor's own pixel first: ink for a filled marker, background inside an open one.
      const c = ink(x, y);
      if (c !== 2 && (t.shape === 'filled' ? c !== 1 : c !== 0)) continue;
      let seen = 0;
      for (let i = 0; i < probe.length; i += 2) if (ink(x + probe[i]!, y + probe[i + 1]!) !== 0) seen++;
      if (2 * seen < probe.length * HIDDEN_SHARE) continue;
      const s = score(x, y, true);
      if (s && fits(t, s) && (!busy || solid(x, y))) hits.push({ x, y, s: s.on + s.off });
    }
  }
  hits.sort((a, b) => b.s - a.s);
  const keep: { x: number; y: number; s: number }[] = [];
  const sep = 0.6 * t.size;
  for (const p of hits) if (keep.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= sep)) keep.push(p);
  const out: Marker[] = [];
  // Two peaks on one marker (part of it under another series) refine to the same centre.
  for (const m of keep.map((p) => refine(found, alpha, region, t, p))) if (out.every((q) => Math.hypot(q.px - m.px, q.py - m.py) >= 0.3 * t.size)) out.push(m);
  if (t.shape === 'filled') out.push(...clustered(ink, region, t, keep));
  return out.filter((m) => !legendSample(alpha, other, region, m, t.size)).sort((p, q) => p.px - q.px || p.py - q.py);
}

/**
 * Filled markers drawn nearly on top of each other are one blob and one peak. Where the ink around
 * found markers is a whole multiple of a marker's area beyond their number, it is split (k-means
 * from the found centres) and the extra centres are markers too, at lower confidence.
 */
function clustered(ink: (x: number, y: number) => number, region: Region, t: MarkerTemplate, found: { x: number; y: number }[]): Marker[] {
  const { width: W } = region;
  const seen = new Set<number>();
  const extra: Marker[] = [];
  const R = 4 * t.size;
  for (const f of found) {
    if (seen.has(f.y * W + f.x) || ink(f.x, f.y) !== 1) continue;
    const pts: { x: number; y: number }[] = [];
    const stack = [f.y * W + f.x];
    seen.add(stack[0]!);
    while (stack.length && pts.length <= 9 * t.area) {
      const k = stack.pop()!;
      const x = k % W;
      const y = (k - x) / W;
      pts.push({ x, y });
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const nk = ny * W + nx;
          if (seen.has(nk) || Math.abs(nx - f.x) > R || Math.abs(ny - f.y) > R || ink(nx, ny) !== 1) continue;
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    const inside = found.filter((q) => seen.has(q.y * W + q.x));
    const k = Math.round(pts.length / t.area);
    if (k <= inside.length || k > 8) continue;
    // k markers drawn over each other span at most k sizes; a marker with a thick error bar that
    // survived the opening spans far more, and is no cluster.
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const p of pts) {
      bx0 = Math.min(bx0, p.x);
      bx1 = Math.max(bx1, p.x);
      by0 = Math.min(by0, p.y);
      by1 = Math.max(by1, p.y);
    }
    if (Math.max(bx1 - bx0, by1 - by0) + 1 > (k + 1) * t.size) continue;
    const centres = inside.map((q) => ({ x: q.x + t.ox, y: q.y + t.oy }));
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
    for (const c of centres.slice(inside.length)) extra.push({ px: c.x, py: c.y, confidence: 0.5 });
  }
  return extra;
}

/**
 * A legend's sample marker: a word right beside it at its height — at least three letter-sized
 * pieces of ink (any colour; at most 1.5 marker sizes wide, at least a third of one high) a little
 * apart, starting within two marker sizes of its edge. An error bar is one long piece, a cap or a
 * neighbouring marker one or two, the dashes of a dashed line are a line width high.
 */
export function legendSample(alpha: Float32Array, other: Uint8Array, region: Region, m: { px: number; py: number }, size: number): boolean {
  const { width: W, x0, x1, y0, y1 } = region;
  const top = Math.max(y0, Math.round(m.py - 0.6 * size));
  const bottom = Math.min(y1, Math.round(m.py + 0.6 * size));
  /** The rows a column has ink in, within the band ([top, bottom] of it), or null. */
  const inkCol = (x: number): [number, number] | null => {
    if (x < x0 || x > x1) return null;
    let a = -1;
    let b = -1;
    for (let y = top; y <= bottom; y++) {
      const k = y * W + x;
      if ((alpha[k] ?? -1) >= ON_ALPHA || other[k]) {
        if (a < 0) a = y;
        b = y;
      }
    }
    return a < 0 ? null : [a, b];
  };
  for (const dir of [1, -1]) {
    const start = Math.round(m.px + dir * (0.5 * size + 1));
    // Pieces: [first, last column offset, top row, bottom row].
    const runs: [number, number, number, number][] = [];
    let run: [number, number, number, number] | null = null;
    for (let i = 0; i <= 8 * size; i++) {
      const c = inkCol(start + dir * i);
      if (c) {
        if (run) {
          run[1] = i;
          run[2] = Math.min(run[2], c[0]);
          run[3] = Math.max(run[3], c[1]);
        } else run = [i, i, c[0], c[1]];
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);
    if (!runs.length || runs[0]![0] > 2 * size) continue;
    let letters = 0;
    for (let j = 0; j < runs.length; j++) {
      const [a, b, t, u] = runs[j]!;
      if (b - a + 1 > 1.5 * size || u - t + 1 < Math.max(3, size / 3)) break;
      if (j > 0 && a - runs[j - 1]![1] - 1 > 0.6 * size) break;
      letters++;
    }
    if (letters >= 3) return true;
  }
  return false;
}

/**
 * How well the template fits with its anchor at (x, y): the share of its ink found and of its
 * background clear, over the known pixels (not outside the plot, not under ink of another colour);
 * null when less than half is known (or, with `early`, as soon as a share can no longer be reached).
 */
export function matcher(alpha: Float32Array, other: Uint8Array, region: Region, t: MarkerTemplate) {
  const { width: W, x0, y0, x1, y1 } = region;
  // A filled marker is looked for in the image opened like its template was: the error bars,
  // caps, reference lines and axes attached to markers are gone, the markers stay.
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  let opened: Uint8Array | null = null;
  if (t.shape === 'filled' && w > 0 && h > 0) {
    const on = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) on[(y - y0) * w + x - x0] = (alpha[y * W + x] ?? -1) >= ON_ALPHA ? 1 : 0;
    const d = chamfer(on, w, h);
    const notE = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) notE[i] = d[i]! >= 3 * t.open ? 0 : 1;
    const dE = chamfer(notE, w, h, false);
    opened = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) opened[i] = on[i] && dE[i]! <= 3 * t.open + 1 ? 1 : 0;
  }
  // 1 = ink, 0 = background, 2 = unknown: outside the plot or ink of another colour (a series
  // drawn over the marker hides what is under it). `raw`: the image itself, not the opened one —
  // for a filled shape's corners, which the opening would round and no error bar runs through.
  const ink = (x: number, y: number, raw = false): number => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return 2;
    const k = y * W + x;
    if (!region.mask[k] || (other[k] && (alpha[k] ?? -1) < 0)) return 2;
    if (opened && !raw) return opened[(y - y0) * w + x - x0]!;
    return (alpha[k] ?? -1) >= ON_ALPHA ? 1 : 0;
  };
  // A thin ring may sit a pixel off: its ink counts when a 4-neighbour is ink.
  const inkNear = (x: number, y: number): number => {
    const v = ink(x, y);
    if (v !== 0 || t.shape !== 'open') return v;
    return ink(x - 1, y) === 1 || ink(x + 1, y) === 1 || ink(x, y - 1) === 1 || ink(x, y + 1) === 1 ? 1 : 0;
  };
  const nOn = t.on.length / 2;
  const nOff = t.off.length / 2;
  const nMargin = t.margin.length / 2;
  const score = (x: number, y: number, early = false): { on: number; off: number; margin: number; lopsided: number } | null => {
    let onHit = 0;
    let onKnown = 0;
    let onMiss = 0;
    // Where the missing ink lies: the mean offset of misses (unknown pixels count as missing here).
    let mx = 0;
    let my = 0;
    let nm = 0;
    for (let i = 0; i < t.on.length; i += 2) {
      const v = inkNear(x + t.on[i]!, y + t.on[i + 1]!);
      if (v !== 1) {
        mx += t.on[i]!;
        my += t.on[i + 1]!;
        nm++;
      }
      if (v === 2) continue;
      onKnown++;
      if (v === 1) onHit++;
      else if (++onMiss > (1 - HIDDEN_SHARE) * nOn && early) return null;
    }
    let offHit = 0;
    let offKnown = 0;
    let offMiss = 0;
    for (let i = 0; i < t.off.length; i += 2) {
      const v = ink(x + t.off[i]!, y + t.off[i + 1]!, true);
      if (v === 2) continue;
      offKnown++;
      if (v === 0) offHit++;
      else if (++offMiss > (1 - OFF_SHARE) * nOff && early) return null;
    }
    let marginHit = 0;
    let marginKnown = 0;
    let marginMiss = 0;
    for (let i = 0; i < t.margin.length; i += 2) {
      const v = ink(x + t.margin[i]!, y + t.margin[i + 1]!);
      if (v === 2) continue;
      marginKnown++;
      if (v === 0) marginHit++;
      else if (++marginMiss > (1 - MARGIN_SHARE) * nMargin && early) return null;
    }
    if (onKnown < 0.5 * nOn || (nOff && offKnown < 0.5 * nOff)) return null;
    const lopsided = nm ? Math.hypot(mx / nm, my / nm) / (t.size / 2) : 1;
    // Unknown pixels count half: a marker partly under another series still fits where it is, not
    // a few pixels off.
    const share = (hit: number, known: number, n: number) => (n ? (hit + 0.5 * (n - known)) / n : 1);
    return { on: share(onHit, onKnown, nOn), off: share(offHit, offKnown, nOff), margin: share(marginHit, marginKnown, nMargin), lopsided };
  };
  return { ink, score };
}

/**
 * Sub-pixel centre. A marker that is a blob of its own (nothing attached) has its blob's centroid,
 * coverage-weighted over the blob and the pixels touching it (as snap and the blob match);
 * otherwise the coverage-weighted centroid of the series' ink over the marker's body and a 1-px
 * rim at the matched anchor (an open marker's inside weighs nothing; pixels outside the plot or of
 * another colour are left out).
 */
function refine(found: Blobs, alpha: Float32Array, region: Region, t: MarkerTemplate, p: { x: number; y: number; s: number }): Marker {
  const { width: W, x0, y0, x1, y1 } = region;
  const confidence = Math.min(1, Math.max(0.3, p.s - 1));
  if (t.shape === 'filled') {
    const b = found.blobs[(found.labels[p.y * W + p.x] ?? 0) - 1];
    if (b && b.area >= 0.6 * t.area && b.area <= 1.6 * t.area && Math.max(bw(b), bh(b)) <= t.size + 2) return { px: b.cx, py: b.cy, confidence };
  }
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < t.body.length; i += 2) {
    const x = p.x + t.body[i]!;
    const y = p.y + t.body[i + 1]!;
    if (x < x0 || y < y0 || x > x1 || y > y1 || !region.mask[y * W + x]) continue;
    const a = Math.max(0, Math.min(1, alpha[y * W + x] ?? 0));
    sw += a;
    sx += a * x;
    sy += a * y;
  }
  const c = sw > 0 ? { px: sx / sw, py: sy / sw } : { px: p.x + t.ox, py: p.y + t.oy };
  return { ...c, confidence };
}
