/**
 * Stroke markers ("x", "+", asterisks): told apart by where their ink lies around the centre, not
 * by which pixels are "on". A small "x" and a dot of about its size are the same 3×3 block of
 * on-pixels, but the "x" is ink along its two diagonals and nearly background between them, and
 * the dot is ink all round. The ink profile — mean coverage along DIRS rays from the centre over
 * the marker's arms — has four (or more) peaks and troughs for a stroke marker and none for a dot
 * or a filled shape; a "+" has its peaks where an "x" has its troughs.
 * Pure TS, no DOM (runs in the worker).
 */

/** Rays around the centre (every 22.5°). */
export const DIRS = 16;
const COS = new Float64Array(DIRS);
const SIN = new Float64Array(DIRS);
for (let i = 0; i < DIRS; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / DIRS);
  SIN[i] = Math.sin((2 * Math.PI * i) / DIRS);
}

/** Coverage (0–1) of the series at pixel (x, y); anything else (unknown, other colours) 0. */
export type Coverage = (x: number, y: number) => number;

function sample(val: Coverage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  return (val(x0, y0) * (1 - fx) + val(x0 + 1, y0) * fx) * (1 - fy) + (val(x0, y0 + 1) * (1 - fx) + val(x0 + 1, y0 + 1) * fx) * fy;
}

/** Mean coverage along each ray from (cx, cy) between radii r0 and r1 (½-px steps). */
export function inkProfile(val: Coverage, cx: number, cy: number, r0: number, r1: number): Float32Array {
  const out = new Float32Array(DIRS);
  for (let i = 0; i < DIRS; i++) {
    let s = 0;
    let n = 0;
    for (let r = r0; r <= r1 + 1e-9; r += 0.5) {
      s += sample(val, cx + r * COS[i]!, cy + r * SIN[i]!);
      n++;
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}

export interface CrossTemplate {
  /** The clicked marker's profile, divided by its mean over the arms. */
  prof: Float32Array;
  /** Ray indices of its arms and of the gaps between them. */
  arms: number[];
  gaps: number[];
  /** Mean coverage over the arms. */
  arm: number;
  r0: number;
  r1: number;
}

/** A ray is an arm at this share of the strongest ray or more, a gap at this share or less. */
const ARM = 0.85;
const GAP = 0.65;
/** A stroke marker has at least this many gap rays (four troughs). */
const MIN_GAPS = 4;
/** A place's profile must correlate with the template's this much… */
const SAME_PROFILE = 0.5;
/** …and its arms be at least this share as strong as the template's. */
const ARM_SHARE = 0.5;

/**
 * The clicked marker's ink profile when it is a stroke marker (four troughs at least), else null.
 * `size`: the larger side of its blob of on-pixels, px (the arms' anti-aliased tips reach a pixel
 * further).
 */
export function crossTemplate(val: Coverage, cx: number, cy: number, size: number): CrossTemplate | null {
  const r1 = size / 2 + 1;
  const r0 = Math.max(1, 0.4 * r1);
  const p = inkProfile(val, cx, cy, r0, r1);
  let max = 0;
  for (const v of p) max = Math.max(max, v);
  if (max <= 0) return null;
  const arms: number[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < DIRS; i++) {
    if (p[i]! >= ARM * max) arms.push(i);
    else if (p[i]! <= GAP * max) gaps.push(i);
  }
  if (gaps.length < MIN_GAPS || arms.length < 4) return null;
  let arm = 0;
  for (const i of arms) arm += p[i]!;
  arm /= arms.length;
  const prof = p.map((v) => v / arm);
  return { prof, arms, gaps, arm, r0, r1 };
}

/**
 * Whether a stroke marker like the template is centred at (cx, cy), within ½ px of it: its arms
 * at least ARM_SHARE as strong as the template's, and its profile following the template's
 * (correlation ≥ SAME_PROFILE). A neighbour's arm crossing one gap leaves the four-fold pattern;
 * a dot, or a pile of them, has none.
 */
export function crossFits(val: Coverage, t: CrossTemplate, cx: number, cy: number): boolean {
  for (const dy of [0, -0.5, 0.5]) {
    for (const dx of [0, -0.5, 0.5]) {
      const p = inkProfile(val, cx + dx, cy + dy, t.r0, t.r1);
      let arm = 0;
      for (const i of t.arms) arm += p[i]!;
      arm /= t.arms.length;
      if (arm >= ARM_SHARE * t.arm && corr(p, t.prof) >= SAME_PROFILE) return true;
    }
  }
  return false;
}

/** Pearson correlation of two profiles (0 when either is flat). */
function corr(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < DIRS; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= DIRS;
  mb /= DIRS;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < DIRS; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return aa > 1e-9 && bb > 1e-9 ? ab / Math.sqrt(aa * bb) : 0;
}

/*
 * Stroke markers on lines. An "x" or "+" drawn on the line through the markers, on a gridline or
 * on a dashed curve of its colour is one blob with them: no blob test sees it. As geometry it is
 * still plain: four arms at right angles from one centre, ending at one length, with background
 * between them. A line through it runs on along one arm pair (those two arms do not end) or crosses
 * two of the gaps; a crossing of two lines has arms that never end; a corner of a polyline has two.
 */

export interface Cross {
  /** Centre, px (sub-pixel). */
  cx: number;
  cy: number;
  /** Direction of one arm, radians in [0, π/2); the others at +90°, +180°, +270°. */
  angle: number;
  /** Arm length from the centre to where its ink ends, px. */
  len: number;
  /** Mean coverage along the arms. */
  arm: number;
  /** The arms' stroke width (median across them, halfway out), px. */
  width: number;
}

/** Angles tried for the clicked marker's arms (3° apart). */
const ANGLE_STEP = Math.PI / 60;
/** An arm is at least this long (px), and the arms that end agree within this share of their median. */
const MIN_ARM = 2;
const ARM_AGREE = 0.35;
/** Mean coverage along an arm at least this much (the clicked one); a found one at least ARM_SHARE of it. */
const ARM_INK = 0.5;
/** Beyond an arm's end (1.5–3 px past it), and beside its tip, coverage at most this: the arm ends (freeTip). */
const END_CLEAR = 0.3;
/** Between two arms (45° off, 0.35–0.85 of the arm length out), coverage at most this share of the arms'. */
const GAP_CLEAR = 0.4;
/**
 * The clicked marker: arms that end and clear gaps, at least (two gaps when the other two are one
 * line through it). A found one: ends (one fewer when the two that run on are one line and the
 * two that end have free tips), gaps.
 */
const SEED_ENDS = 3;
const SEED_GAPS = 3;
/** …and of its ending arms, at least this many with free tips (a square's side ends at corners). */
const SEED_FREE = 2;
const FOUND_ENDS = 3;
const FOUND_GAPS = 2;
/** The clicked marker's arms are at most this share of their length wide, and agree in width within this factor. */
const THIN = 0.5;
const WIDTH_AGREE = 2;
/** Offsets of the centres tried per pixel — between pixels too for arms at most HALF_WIDTH px wide. */
const HALF_WIDTH = 2;
const HALF: [number, number][] = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];
/** The clicked marker's centre is looked for this far from the click (px), on ink. */
const SEED_REACH = 8;

function rayMean(val: Coverage, cx: number, cy: number, a: number, r0: number, r1: number, least = false): number {
  const c = Math.cos(a);
  const s = Math.sin(a);
  let sum = 0;
  let n = 0;
  let min = Infinity;
  for (let r = r0; r <= r1 + 1e-9; r += 0.5) {
    const v = sample(val, cx + r * c, cy + r * s);
    sum += v;
    min = Math.min(min, v);
    n++;
  }
  if (!n) return 0;
  return least ? min : sum / n;
}

/** Width of the stroke across direction `a` at distance r from (cx, cy): ink (≥ ½) either side, px. */
function strokeWidth(val: Coverage, cx: number, cy: number, a: number, r: number, max: number): number {
  const px = cx + r * Math.cos(a);
  const py = cy + r * Math.sin(a);
  const nx = -Math.sin(a);
  const ny = Math.cos(a);
  let w = 0;
  for (const side of [1, -1]) {
    let t = 0.25;
    while (t <= max && sample(val, px + side * t * nx, py + side * t * ny) >= 0.5) t += 0.25;
    w += t - 0.25;
  }
  return w + 0.5;
}

/** Length of the ink from (cx, cy) along `a` (coverage ≥ ½; one ½-px dip bridged), up to `max`. */
export function armLength(val: Coverage, cx: number, cy: number, a: number, max: number): number {
  const c = Math.cos(a);
  const s = Math.sin(a);
  let last = 0;
  let dips = 0;
  for (let r = 0.5; r <= max; r += 0.5) {
    if (sample(val, cx + r * c, cy + r * s) >= 0.5) {
      last = r;
      dips = 0;
    } else if (++dips > 1) break;
  }
  return last;
}

interface Judged {
  arm: number;
  minArm: number;
  ends: number;
  /** Ending arms whose tips are free (freeTip). */
  freeEnds: number;
  /** The arms that run on are two opposite ones (a line along one arm pair). */
  lineOn: boolean;
  gaps: number;
  /** The gaps not clear are two opposite ones (a line through the centre between the arms). */
  lineAcross: boolean;
}

/** The four arms at `angle` with length `len` judged at (cx, cy). */
/**
 * Whether an arm's tip is free: background beside it on both sides (half a stroke width and 1.5 px
 * out). A square's side ends at a corner, where the next side runs
 * on beside its tip.
 */
function freeTip(val: Coverage, cx: number, cy: number, a: number, len: number, width: number): boolean {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const off = width / 2 + 1.5;
  for (const r of [len]) {
    for (const side of [1, -1]) {
      const x = cx + r * ux - side * off * uy;
      const y = cy + r * uy + side * off * ux;
      if (sample(val, x, y) > END_CLEAR) return false;
    }
  }
  return true;
}

export function judge(val: Coverage, cx: number, cy: number, angle: number, len: number, width: number): Judged {
  let arm = 0;
  let minArm = Infinity;
  let ends = 0;
  let freeEnds = 0;
  const on: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = angle + (k * Math.PI) / 2;
    // An arm is ink all along (its weakest point): a ray running out of a thick line beside it is not.
    const m = rayMean(val, cx, cy, a, Math.max(0.5, 0.3 * len), 0.85 * len);
    arm += m / 4;
    minArm = Math.min(minArm, rayMean(val, cx, cy, a, Math.max(0.5, 0.3 * len), 0.85 * len, true));
    if (rayMean(val, cx, cy, a, len + 1.5, len + 3) <= END_CLEAR) {
      ends++;
      if (freeTip(val, cx, cy, a, len, width)) freeEnds++;
    } else on.push(k);
  }
  const lineOn = on.length === 2 && on[1]! - on[0]! === 2;
  let gaps = 0;
  const blocked: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = angle + Math.PI / 4 + (k * Math.PI) / 2;
    // From just outside the strokes (half a width off the arm, 45° out) — a filled shape at the
    // centre with thin bars through it (a marker on its error bars) is no gap.
    if (rayMean(val, cx, cy, a, Math.max(1, Math.SQRT1_2 * width + 1), 0.85 * len) <= GAP_CLEAR * arm) gaps++;
    else blocked.push(k);
  }
  const lineAcross = blocked.length === 2 && blocked[1]! - blocked[0]! === 2;
  return { arm, minArm, ends, freeEnds, lineOn, gaps, lineAcross };
}

/**
 * The stroke marker ("x", "+", at any angle) the click is on: a centre on ink within SEED_REACH px
 * of it, with four arms whose lengths agree (one pair may run on along a line), at least three of
 * them ending and three gaps clear; the clicked point must lie on the marker (within its arm
 * length of the centre). Null when there is none. `bounds`: the region, inclusive.
 */
export function crossAtSeed(
  val: Coverage,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  sx: number,
  sy: number,
  maxLen: number,
): Cross | null {
  let best: Cross | null = null;
  let bestScore = -Infinity;
  // Centres on pixels and between them (a thin "x" drawn about a pixel corner has its 1-px arms
  // half a pixel off any pixel centre's diagonals).
  for (let y = Math.max(bounds.y0, sy - SEED_REACH); y <= Math.min(bounds.y1, sy + SEED_REACH); y += 0.5) {
    for (let x = Math.max(bounds.x0, sx - SEED_REACH); x <= Math.min(bounds.x1, sx + SEED_REACH); x += 0.5) {
      if (sample(val, x, y) < 0.5 || Math.hypot(x - sx, y - sy) > SEED_REACH) continue;
      for (let angle = 0; angle < Math.PI / 2 - 1e-9; angle += ANGLE_STEP) {
        const lens: number[] = [];
        for (let k = 0; k < 4; k++) lens.push(armLength(val, x, y, angle + (k * Math.PI) / 2, maxLen));
        if (Math.min(...lens) < MIN_ARM) continue;
        // The arm length: the median of the shortest three (a line may run on along one pair).
        const sorted = [...lens].sort((a, b) => a - b);
        const len = sorted[1]!;
        if (sorted[0]! < (1 - ARM_AGREE) * len || sorted[2]! > (1 + ARM_AGREE) * len) continue;
        if (Math.hypot(x - sx, y - sy) > len + 1.5) continue;
        // Strokes alike, thin for their length (a triangle's sides, a filled shape's flanks are
        // not).
        const mid = [0, 1, 2, 3].map((k) => strokeWidth(val, x, y, angle + (k * Math.PI) / 2, 0.55 * len, len)).sort((a, b) => a - b);
        const out = [0, 1, 2, 3].map((k) => strokeWidth(val, x, y, angle + (k * Math.PI) / 2, 0.7 * len, len)).sort((a, b) => a - b);
        const alike = (w: number[]) => 0.5 * (w[1]! + w[2]!) <= THIN * len && w[2]! <= WIDTH_AGREE * w[0]!;
        // All four alike halfway out, or three of them further out (one may run into a line).
        const midOk = alike(mid) && mid[3]! <= WIDTH_AGREE * mid[0]!;
        if (!midOk && !alike(out)) continue;
        const width = midOk ? 0.5 * (mid[1]! + mid[2]!) : 0.5 * (out[1]! + out[2]!);
        const j = judge(val, x, y, angle, len, width);
        if (j.minArm < ARM_INK || j.ends < SEED_ENDS || j.freeEnds < SEED_FREE || (j.gaps < SEED_GAPS && !j.lineAcross)) continue;
        const score = j.arm * 4 + j.ends + j.gaps;
        if (score > bestScore) {
          bestScore = score;
          best = { cx: x, cy: y, angle, len, arm: j.arm, width };
        }
      }
    }
  }
  return best ? refineCross(val, best) : null;
}

/** Sub-pixel centre: the offset (¼-px steps, within ½ px) where the arms are strongest. */
function refineCross(val: Coverage, c: Cross): Cross {
  let best = c;
  let bestArm = -1;
  for (let dy = -0.5; dy <= 0.5; dy += 0.25) {
    for (let dx = -0.5; dx <= 0.5; dx += 0.25) {
      let arm = 0;
      for (let k = 0; k < 4; k++) arm += rayMean(val, c.cx + dx, c.cy + dy, c.angle + (k * Math.PI) / 2, 0, 0.85 * c.len);
      if (arm > bestArm + 1e-6) {
        bestArm = arm;
        best = { ...c, cx: c.cx + dx, cy: c.cy + dy };
      }
    }
  }
  return best;
}

/**
 * Every stroke marker like `t` in the bounds (its angle and arm length, arms at least ARM_SHARE as
 * inked, three arms ending — two when the others are one line running on — and two gaps clear), centres refined, ordered by x. Peaks closer
 * than the arm length are one marker.
 */
export function findCrosses(val: Coverage, bounds: { x0: number; y0: number; x1: number; y1: number }, t: Cross): { px: number; py: number; confidence: number }[] {
  const hits: { x: number; y: number; s: number }[] = [];
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      if (val(x, y) < 0.5) continue;
      // The pixel's centre, and for thin arms the points half a pixel right and below it (see
      // crossAtSeed).
      let best: { x: number; y: number; s: number } | null = null;
      for (const [dx, dy] of t.width <= HALF_WIDTH ? HALF : HALF.slice(0, 1)) {
        if (x + dx > bounds.x1 || y + dy > bounds.y1 || sample(val, x + dx, y + dy) < 0.5) continue;
        const j = judge(val, x + dx, y + dy, t.angle, t.len, t.width);
        if (j.minArm < ARM_SHARE * t.arm || (j.ends < FOUND_ENDS && !(j.ends === FOUND_ENDS - 1 && j.lineOn && j.freeEnds === j.ends)) || j.gaps < FOUND_GAPS) continue;
        const sc = j.arm + 0.1 * (j.ends + j.gaps);
        if (!best || sc > best.s) best = { x: x + dx, y: y + dy, s: sc };
      }
      if (best) hits.push(best);
    }
  }
  hits.sort((a, b) => b.s - a.s);
  const keep: { x: number; y: number; s: number }[] = [];
  for (const h of hits) if (keep.every((k) => Math.hypot(k.x - h.x, k.y - h.y) >= t.len)) keep.push(h);
  return keep
    .map((k) => {
      const c = refineCross(val, { ...t, cx: k.x, cy: k.y });
      return { px: c.cx, py: c.cy, confidence: Math.min(1, k.s / Math.max(1e-6, t.arm)) };
    })
    .sort((a, b) => a.px - b.px || a.py - b.py);
}
