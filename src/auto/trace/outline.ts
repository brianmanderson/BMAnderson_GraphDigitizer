/**
 * A marker's outline as radii: from its centre along RAYS directions to where its ink ends (a
 * filled shape) or begins (the inside of an open one), located to sub-pixel where the coverage
 * crosses ½. Unlike a pixel-by-pixel overlap, the radii do not depend on where the marker sits on
 * the pixel grid, so two outlines can be compared to a fraction of a pixel: a circle and a square
 * of one size differ by 0.4 radii along the diagonals and agree along the axes, a marker partly
 * under another one agrees over the arc that shows.
 */

export const RAYS = 72;
const STEP = 0.5;
const COS = new Float64Array(RAYS);
const SIN = new Float64Array(RAYS);
for (let i = 0; i < RAYS; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / RAYS);
  SIN[i] = Math.sin((2 * Math.PI * i) / RAYS);
}

/**
 * Coverage (0–1) of pixel (x, y) by the series; NaN when unknown (outside the plot); HIDDEN where
 * ink of another colour lies (no ink of the series shows, whatever is under it).
 */
export type Soft = (x: number, y: number) => number;
export const HIDDEN = -1;

function sample(val: Soft, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = val(x0, y0);
  const b = fx > 0 ? val(x0 + 1, y0) : a;
  const c = fy > 0 ? val(x0, y0 + 1) : a;
  const d = fx > 0 && fy > 0 ? val(x0 + 1, y0 + 1) : fx > 0 ? b : c;
  // Hidden pixels count as no ink; the sample is hidden when most of it is.
  const A = a < 0 ? 0 : a;
  const B = b < 0 ? 0 : b;
  const C = c < 0 ? 0 : c;
  const D = d < 0 ? 0 : d;
  const v = (A * (1 - fx) + B * fx) * (1 - fy) + (C * (1 - fx) + D * fx) * fy;
  if (Number.isNaN(v)) return v;
  const h = ((a < 0 ? 1 : 0) * (1 - fx) + (b < 0 ? 1 : 0) * fx) * (1 - fy) + ((c < 0 ? 1 : 0) * (1 - fx) + (d < 0 ? 1 : 0) * fx) * fy;
  return h > 0.5 ? HIDDEN : v;
}

/** A stroke at most this share of `rmax` thick crossing an open marker's inside is a line through it. */
const CROSSING = 0.3;

/**
 * Radii from (cx, cy), px: where the shape the centre lies in ends — ink for a filled shape,
 * background for `open` (the hole of a ring). 0 when the centre itself is not in it, `rmax` when
 * it runs on, NaN when the ray leaves the known pixels first; negative (minus the radius) when it
 * ends at ink of another colour: the shape may go on under it.
 * `beyond` (open only): where the ray meets ink again after crossing a thin stroke of the series'
 * colour inside the hole (a line through an open marker), NaN when it does not. A centre on such
 * a stroke starts each ray where the stroke ends.
 */
export function outline(val: Soft, cx: number, cy: number, rmax: number, open: boolean, beyond: Float32Array | null = null): Float32Array {
  const out = new Float32Array(RAYS);
  if (beyond) beyond.fill(NaN);
  const start = sample(val, cx, cy);
  const cross = CROSSING * rmax;
  for (let i = 0; i < RAYS; i++) {
    if (Number.isNaN(start) || start === HIDDEN) {
      out[i] = NaN;
      continue;
    }
    let r0 = 0;
    let prev = start;
    if (open && start >= 0.5) {
      // On a stroke through the hole: out of it first.
      for (r0 = STEP; r0 <= cross; r0 += STEP) {
        prev = sample(val, cx + r0 * COS[i]!, cy + r0 * SIN[i]!);
        if (Number.isNaN(prev) || prev === HIDDEN || prev < 0.5) break;
      }
      if (Number.isNaN(prev) || prev === HIDDEN) {
        out[i] = NaN;
        continue;
      }
      if (prev >= 0.5) continue;
    } else if (open ? start >= 0.5 : start < 0.5) continue;
    let res = rmax;
    let hit = -1;
    for (let r = r0 + STEP; r <= rmax; r += STEP) {
      const v = sample(val, cx + r * COS[i]!, cy + r * SIN[i]!);
      if (Number.isNaN(v)) {
        res = NaN;
        break;
      }
      if (v === HIDDEN) {
        res = -(r - STEP / 2);
        break;
      }
      if (open ? v >= 0.5 : v < 0.5) {
        res = r - STEP + (STEP * (prev - 0.5)) / (prev - v);
        hit = r;
        break;
      }
      prev = v;
    }
    out[i] = res;
    if (!beyond || !open || hit < 0) continue;
    // Through the ink, if it is a thin stroke, to the next ink.
    let r = hit;
    let v = 1;
    for (; r <= Math.min(rmax, hit + cross); r += STEP) {
      v = sample(val, cx + r * COS[i]!, cy + r * SIN[i]!);
      if (Number.isNaN(v) || v === HIDDEN || v < 0.5) break;
    }
    if (Number.isNaN(v) || v === HIDDEN || v >= 0.5) continue;
    for (r += STEP; r <= rmax; r += STEP) {
      const w = sample(val, cx + r * COS[i]!, cy + r * SIN[i]!);
      if (Number.isNaN(w) || w === HIDDEN) break;
      if (w >= 0.5) {
        beyond[i] = r - STEP + (STEP * (v - 0.5)) / (v - w);
        break;
      }
      v = w;
    }
  }
  return out;
}

/** A radius agrees within this many px, or this share of the radius, of the template's… */
const TOL_PX = 0.5;
const TOL_REL = 0.08;
/** …plus this share of how much the template's radius changes there (a tip is never rendered twice alike). */
const TOL_TIP = 0.3;
/** A filled shape's ray this many times longer than the template's ran into a neighbour or a stroke. */
const RAN_ON = 1.5;

export interface Agreement {
  /** Agreeing rays, as a share of the rays that say something. */
  agree: number;
  /** Those in the longest run no disagreeing ray breaks, same share. */
  arc: number;
  /** Rays shorter than the template's (ink missing), same share. */
  short: number;
  /** Separate stretches of the outline that disagree. */
  sectors: number;
  /** Rays that say something, as a share of all rays. */
  known: number;
}

/**
 * How well outline `c` agrees with the template's `t`. A ray agrees when its radius lies within
 * the template's radii at that direction and the two next to it (a star's tip moves by a ray with
 * the centre). A ray says nothing when it is unknown or — for a filled shape — runs on far past
 * the template's: into a marker drawn against this one, along an error bar or a line attached to
 * it (the template's own such rays say nothing either), and so do the one or two rays beside such
 * a stretch (they graze the neighbour), and a ray that ends early at ink of another colour (the
 * marker goes on under it). A ray longer than the template's by less disagrees — unless it is not
 * in `stripped`, the outline without the thin strokes attached to the marker (an error bar's cap
 * beside it, a thick bar's flank). An open shape's inside must be closed: a ray that finds no ring
 * disagrees.
 * A marker partly under another one disagrees over one stretch of its outline, or two; another
 * shape of about the same size over three or more (a square's four corners stick out of a circle).
 */
export function agreement(t: Float32Array, c: Float32Array, rmax: number, open: boolean, stripped: Float32Array | null = null, beyond: Float32Array | null = null): Agreement {
  // 1 agrees, 0 too long, 2 too short, -1 says nothing.
  const state = new Int8Array(RAYS);
  for (let i = 0; i < RAYS; i++) {
    const tr = Math.abs(t[i]!);
    const cr = Math.abs(c[i]!);
    state[i] = -1;
    if (Number.isNaN(tr) || Number.isNaN(cr) || tr >= rmax) continue;
    let lo = tr;
    let hi = tr;
    for (const j of [(i + RAYS - 1) % RAYS, (i + 1) % RAYS]) {
      const v = Math.abs(t[j]!);
      if (Number.isNaN(v) || v >= rmax) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!open && (cr >= rmax || cr > RAN_ON * hi)) continue;
    const tol = Math.max(TOL_PX, TOL_REL * tr) + TOL_TIP * (hi - lo);
    if (cr < lo - tol) {
      // Ended early at ink of another colour: hidden, not missing. Ended at a stroke through an
      // open marker's inside: agrees when the ink beyond it does.
      const br = beyond ? beyond[i]! : NaN;
      if (!Number.isNaN(br) && br >= lo - tol && br <= hi + tol) state[i] = 1;
      else if (c[i]! >= 0) state[i] = 2;
    } else if (cr > hi + tol) {
      // Too long only if it still is without the thin strokes attached to the marker.
      const sr = stripped ? Math.abs(stripped[i]!) : cr;
      state[i] = stripped && !(sr > hi + tol) ? 1 : 0;
    } else state[i] = 1;
  }
  // Rays grazing a neighbour: too long, within two rays of a stretch that says nothing.
  const graze = state.slice();
  for (let i = 0; i < RAYS; i++) {
    if (state[i] !== 0) continue;
    for (const d of [1, 2, RAYS - 1, RAYS - 2]) {
      if (state[(i + d) % RAYS] === -1) {
        graze[i] = -1;
        break;
      }
    }
  }
  let ok = 0;
  let bad = 0;
  let short = 0;
  for (const g of graze) {
    if (g === 1) ok++;
    else if (g >= 0) bad++;
    if (g === 2) short++;
  }
  const known = ok + bad;
  if (!known) return { agree: 0, arc: 0, short: 0, sectors: 0, known: 0 };
  let run = 0;
  let best = 0;
  for (let i = 0; i < 2 * RAYS; i++) {
    const g = graze[i % RAYS]!;
    if (g === 0 || g === 2) run = 0;
    else if (g === 1) best = Math.max(best, ++run);
  }
  // Stretches that disagree: runs of rays that do not agree holding at least two that disagree,
  // counted from a ray that agrees (none agreeing: one stretch).
  let sectors = 0;
  const start = graze.indexOf(1);
  if (start < 0) sectors = 1;
  else {
    let dis = 0;
    for (let n = 1; n <= RAYS; n++) {
      const g = graze[(start + n) % RAYS]!;
      if (g === 1) {
        if (dis >= 2) sectors++;
        dis = 0;
      } else if (g !== -1) dis++;
    }
  }
  return { agree: ok / known, arc: Math.min(best, ok) / known, short: short / known, sectors, known: known / RAYS };
}
