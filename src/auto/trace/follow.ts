/**
 * Path following: the stroke through the seed as an ordered path, wherever it goes — for curves
 * that are not functions of x (closed loops, spirals, curves that fold back), which the column
 * walker (curve.ts: one y per x) can only follow as far as the first fold. Pure TS, no DOM.
 * docs/SPEC.md → Auto-trace → Curves that double back.
 *
 * The walk (`followStroke`). From the seed, in the stroke's direction there and then the other
 * way: a ring of radius ~1.5 line widths around the current point is cut into arcs of the series'
 * ink, and the walk moves half a radius towards the arc that continues it straightest, then
 * centres itself on the stroke's cross-section. Ink already walked is marked, so the way back is
 * no candidate and the walk passes straight over its own earlier path at a self-crossing. When no
 * arc continues it:
 *
 * 1. straight on, further out: ink ahead within a narrow cone, reached through ink (its own
 *    earlier path at a shallow crossing), through ink of another colour (a series crossing over
 *    it) or a short break; or, when another series is drawn over it along its course, along that
 *    series' ink to where it comes out again (up to the hidden-gap limit);
 * 2. a turn: a single unwalked arc at any angle (a corner; a cusp such as the tip of a hysteresis
 *    loop, where the stroke is first followed to its end so the tip itself is a point). Two
 *    ways on that are equally good end the walk: a junction, not a turn;
 * 3. back along its own path: a stroke that ends where two branches have merged (the saturated
 *    tips of an M–H loop are one line walked twice) is walked back to where an unwalked branch
 *    leaves it in the direction of travel.
 *
 * The walk is closed when it comes back onto its own start, heading the way it set out.
 * Rulings and frame lines (`blocked`) may be crossed but never walked along.
 *
 * Order (`orderPath`): an open path starts at its left end; a closed one at its leftmost point and
 * runs clockwise on screen, ending on its first point again (the loop is closed in the table too).
 *
 * `takesOver` decides whether such a path replaces the column walker's: only when it doubles back
 * (it is closed, or comes back in x by more than a marker's width without having walked back
 * along itself), passes through at least half of the walker's own points, is clearly longer and
 * rarely ran through ink wider than its stroke. Everything the walker already traces — functions
 * of x, steps, lines through markers — stays the walker's. `mayDoubleBack` says, cheaply, whether
 * the follower is worth running at all.
 *
 * `pickPoints`: the suggested points of a path — its ends and cusps always, then the points that
 * keep the polyline through them closest to the path (largest deviation first), then the longest
 * stretches halved, up to `maxPoints`.
 */

import { ON_ALPHA } from './color.ts';
import type { PathPoint } from './curve.ts';
import type { Region } from './region.ts';
import type { TracedPoint } from './types.ts';

export interface FollowInput {
  alpha: Float32Array;
  other: Uint8Array;
  region: Region;
  seed: { x: number; y: number };
  /** Longest stretch hidden under ink of another colour that is bridged, px. */
  maxHiddenGap: number;
  /** Ink the path may cross but not run along (rulings.ts), image-sized, or undefined. */
  blocked?: Uint8Array | undefined;
}

export interface Followed {
  path: PathPoint[];
  closed: boolean;
  /** Part of the path was walked twice (a merged tip). */
  retraced: boolean;
  thickness: number;
  /** How far the path comes back behind a point it had reached in x, px (`backTravelOf`). */
  backTravel: number;
  /** Share of the walk's steps through ink wider than the stroke. */
  fat: number;
  length: number;
}

interface V {
  x: number;
  y: number;
}

interface Arc {
  /** Direction from the centre, unit vector, and the point on the ring. */
  dx: number;
  dy: number;
  x: number;
  y: number;
  /** Share of the arc's samples already walked / on blocked ink. */
  visited: number;
  blocked: number;
  samples: number;
  /** Strongest coverage among its samples (capped at 1): a faint gridline of a similar colour is weak. */
  strength: number;
}

/** Background allowed on a link between two path points, px. */
const LINK_BG = 1;
/** …and where a branch leaves a path being walked back (the two have just separated). */
const BRANCH_BG = 2;
/** A turn sharper than this is a cusp: the stroke is first followed to its tip. */
const CUSP_DEGREES = 100;
/**
 * Radii (in ring radii) at which a way on is looked for when nothing continues the walk: at a sharp
 * cusp the way out is still merged with the way in close to the tip.
 */
const TURN_RADII = [1, 1.6, 2.4, 3.4, 5, 7, 10];
/**
 * A branch leaves a path being walked back within this of the direction of travel: two strands
 * that had merged part at a shallow angle (an error bar or a marker's edge leaves squarely).
 */
const BRANCH_DEGREES = 35;
/** An unwalked branch off a path being walked back must go on for this many ring radii. */
const BRANCH_RUN = 6;
/** Longest straight jump across ink of another colour, px (longer hidden stretches are walked along that ink). */
const MAX_JUMP = 60;
/**
 * The followed path must pass through at least this share of the column walk's points to replace
 * it (a walk that jumped to another series past a fold agrees only up to there).
 */
const AGREE = 0.5;
/** A way on round a bend (reached through ink, not in a straight line) is looked for this many rings out at most. */
const JOIN_RINGS = 2.4;
/** A way on is this strong at least, relative to the strongest one. */
const FAINT = 0.75;
/** Largest share of a path's steps through ink wider than its stroke for it to replace the column walk. */
const MAX_FAT = 0.06;
/** Steps the walk may take (a guard, far beyond any real path). */
const MAX_STEPS = 60000;

const rad = (deg: number) => (deg * Math.PI) / 180;
const norm = (x: number, y: number): V => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};

class Walker {
  readonly w: number;
  readonly h: number;
  readonly alpha: Float32Array;
  readonly other: Uint8Array;
  readonly blocked: Uint8Array | undefined;
  readonly visited: Uint8Array;
  readonly t: number;
  readonly r: number;
  readonly step: number;
  readonly maxHidden: number;
  readonly maxJump: number;
  readonly openGap: number;
  readonly retraceLimit: number;
  retraced = false;
  /** Steps taken through ink wider than the stroke (crossings, merged branches — or a filled marker). */
  fat = 0;

  constructor(input: FollowInput, t: number) {
    this.w = input.region.width;
    this.h = input.region.height;
    this.alpha = input.alpha;
    this.other = input.other;
    this.blocked = input.blocked;
    this.visited = new Uint8Array(this.w * this.h);
    this.t = t;
    this.r = Math.min(10, Math.max(3.5, 1.5 * t + 1.5));
    this.step = Math.max(1.5, 0.5 * this.r);
    this.maxHidden = input.maxHiddenGap;
    this.maxJump = Math.min(MAX_JUMP, input.maxHiddenGap);
    this.openGap = Math.max(3, 1.5 * t);
    this.retraceLimit = 0.4 * Math.max(input.region.x1 - input.region.x0, input.region.y1 - input.region.y0);
  }

  index(x: number, y: number): number {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= this.w || yi >= this.h ? -1 : yi * this.w + xi;
  }

  on(x: number, y: number): boolean {
    const k = this.index(x, y);
    return k >= 0 && this.alpha[k]! >= ON_ALPHA;
  }

  /** Coverage at a sub-pixel position (bilinear; other colours and outside count as 0). */
  cover(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    let s = 0;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        const xi = x0 + i;
        const yi = y0 + j;
        if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) continue;
        const a = this.alpha[yi * this.w + xi]!;
        if (a > 0) s += Math.min(1, a) * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      }
    }
    return s;
  }

  /** Marks the ink around the segment a → b as walked. */
  mark(a: V, b: V): void {
    const m = this.t / 2 + 1;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let i = 0; i <= n; i++) {
      const cx = a.x + ((b.x - a.x) * i) / n;
      const cy = a.y + ((b.y - a.y) * i) / n;
      for (let y = Math.max(0, Math.floor(cy - m)); y <= Math.min(this.h - 1, Math.ceil(cy + m)); y++) {
        for (let x = Math.max(0, Math.floor(cx - m)); x <= Math.min(this.w - 1, Math.ceil(cx + m)); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= m * m) this.visited[y * this.w + x] = 1;
        }
      }
    }
  }

  /** The arcs of series ink (or, `occluder`, of ink of another colour) on the ring of radius `radius` around `p`. */
  arcs(p: V, radius: number, occluder = false): Arc[] {
    const ink = (k: number) => (occluder ? this.other[k] === 1 && this.alpha[k]! < ON_ALPHA : this.alpha[k]! >= ON_ALPHA);
    const n = Math.max(16, Math.ceil(2 * Math.PI * radius * 1.6));
    const flag = new Uint8Array(n);
    const ks = new Int32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const c = Math.cos(th);
      const s = Math.sin(th);
      // Two radii: a ring and a thin diagonal line can cross without sharing a pixel.
      let k = this.index(p.x + radius * c, p.y + radius * s);
      if (!(k >= 0 && ink(k))) k = this.index(p.x + (radius + 0.7) * c, p.y + (radius + 0.7) * s);
      if (k >= 0 && ink(k)) {
        flag[i] = 1;
        ks[i] = k;
        any = true;
      }
    }
    if (!any) return [];
    // Start at a gap so that no arc wraps around.
    let start = 0;
    while (start < n && flag[start]) start++;
    if (start === n) start = 0;
    const out: Arc[] = [];
    let i = 0;
    while (i < n) {
      const a = (start + i) % n;
      if (!flag[a]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && (flag[(start + j + 1) % n] || (j + 2 < n && flag[(start + j + 2) % n]))) j++;
      let sx = 0;
      let sy = 0;
      let visited = 0;
      let blocked = 0;
      let samples = 0;
      let strength = 0;
      for (let q = i; q <= j; q++) {
        const b = (start + q) % n;
        if (!flag[b]) continue;
        const th = (2 * Math.PI * b) / n;
        sx += Math.cos(th);
        sy += Math.sin(th);
        samples++;
        if (this.visited[ks[b]!]) visited++;
        if (this.blocked?.[ks[b]!]) blocked++;
        strength = Math.max(strength, Math.min(1, Math.abs(this.alpha[ks[b]!]!)));
      }
      const d = norm(sx, sy);
      out.push({ dx: d.x, dy: d.y, x: p.x + radius * d.x, y: p.y + radius * d.y, visited: visited / samples, blocked: blocked / samples, samples, strength });
      i = j + 1;
    }
    return out;
  }

  /** Background (px) and ink of another colour (px) on the straight way a → b. */
  between(a: V, b: V): { bg: number; hidden: number } {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 0.5));
    let bg = 0;
    let hidden = 0;
    for (let i = 1; i < n; i++) {
      const k = this.index(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (k < 0) bg++;
      else if (this.alpha[k]! >= ON_ALPHA) continue;
      else if (this.other[k]) hidden++;
      else if (this.alpha[k]! < 0.25) bg++;
    }
    return { bg: (bg * len) / n, hidden: (hidden * len) / n };
  }

  /**
   * Whether `b` is reached from `a` through series ink alone, within the disc around `a` that
   * holds `b`: the way out of a cusp bends, and the straight line to it leaves the ink.
   */
  joined(a: V, b: V): boolean {
    const reach = Math.hypot(b.x - a.x, b.y - a.y) + 2;
    const start = this.index(a.x, a.y);
    if (start < 0) return false;
    const seen = new Set<number>();
    const stack: number[] = [];
    // The ink at `a` (it may sit half a pixel off the stroke).
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = this.index(a.x + dx, a.y + dy);
        if (k >= 0 && this.alpha[k]! >= ON_ALPHA && !seen.has(k)) {
          seen.add(k);
          stack.push(k);
        }
      }
    }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % this.w;
      const y = (k - x) / this.w;
      if (Math.hypot(x - b.x, y - b.y) <= 1.5) return true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h || Math.hypot(xx - a.x, yy - a.y) > reach) continue;
          const q = yy * this.w + xx;
          if (seen.has(q) || this.alpha[q]! < ON_ALPHA) continue;
          seen.add(q);
          stack.push(q);
        }
      }
    }
    return false;
  }

  linked(a: V, b: V, bgMax = LINK_BG): boolean {
    const g = this.between(a, b);
    return g.bg <= bgMax && g.hidden <= 1;
  }

  /** `p` moved onto the middle of the stroke's cross-section (perpendicular to `d`). */
  centre(p: V, d: V): V {
    const nx = -d.y;
    const ny = d.x;
    const reach = this.t + 2;
    const at = (s: number) => this.cover(p.x + s * nx, p.y + s * ny);
    let s0 = 0;
    if (at(0) < 0.5) {
      let found = false;
      for (let s = 0.5; s <= 1.5 && !found; s += 0.5) {
        for (const q of [s, -s]) {
          if (at(q) >= 0.5) {
            s0 = q;
            found = true;
            break;
          }
        }
      }
      if (!found) return p;
    }
    let lo = s0;
    let hi = s0;
    while (lo - 0.5 >= -reach && at(lo - 0.5) >= 0.2) lo -= 0.5;
    while (hi + 0.5 <= reach && at(hi + 0.5) >= 0.2) hi += 0.5;
    // Wider than the stroke: a crossing or two merged branches — no telling where the middle is.
    if (hi - lo > 2.2 * this.t + 2 || lo <= -reach || hi >= reach) {
      this.fat++;
      return p;
    }
    let sw = 0;
    let ss = 0;
    for (let s = lo; s <= hi + 1e-9; s += 0.5) {
      const a = at(s);
      sw += a;
      ss += a * s;
    }
    if (sw <= 0) return p;
    const shift = Math.max(-1.5, Math.min(1.5, ss / sw));
    return { x: p.x + shift * nx, y: p.y + shift * ny };
  }

  /** Ink straight ahead of `p` beyond what the ring sees: across walked ink, an occluder or a short break. */
  ahead(p: V, d: V): { q: V; hidden: boolean } | null {
    const nx = -d.y;
    const ny = d.x;
    const far = this.maxJump + this.r;
    for (let rho = this.r + 1; rho <= far; rho += 1) {
      const lateral = Math.max(1.5, Math.min(0.3 * rho, this.r + 2));
      let best: V | null = null;
      let bestOff = Infinity;
      let bestHidden = false;
      for (let off = -lateral; off <= lateral; off += 0.7) {
        if (Math.abs(off) >= bestOff) continue;
        const q = { x: p.x + rho * d.x + off * nx, y: p.y + rho * d.y + off * ny };
        const k = this.index(q.x, q.y);
        if (k < 0 || this.alpha[k]! < ON_ALPHA || this.visited[k] || this.blocked?.[k]) continue;
        const g = this.between(p, q);
        if (g.bg > this.openGap || g.hidden > this.maxJump) continue;
        best = q;
        bestOff = Math.abs(off);
        bestHidden = g.hidden > 1 || g.bg > LINK_BG;
      }
      if (best) return { q: best, hidden: bestHidden };
    }
    return null;
  }

  /**
   * The series has gone under ink of another colour that runs on its course (two curves drawn
   * over each other for a stretch): the way along that ink, to where the series comes out again.
   * Null when it does not within the hidden-gap limit, or when the other ink turns away at once.
   */
  under(p: V, d: V): { pts: V[]; d: V } | null {
    const pts: V[] = [];
    let cur = p;
    let dir = d;
    for (let len = 0; len <= this.maxHidden; len += this.step) {
      // Out again: unwalked series ink ahead, reached without crossing background.
      if (pts.length) {
        let out: Arc | null = null;
        let outDot = Math.cos(rad(60));
        for (const a of this.arcs(cur, this.r)) {
          const dot = a.dx * dir.x + a.dy * dir.y;
          if (a.visited >= 0.5 || a.blocked >= 0.5 || dot < outDot || this.between(cur, a).bg > LINK_BG) continue;
          out = a;
          outDot = dot;
        }
        if (out) return { pts: [...pts, { x: out.x, y: out.y }], d: norm(out.x - cur.x, out.y - cur.y) };
      }
      let best: Arc | null = null;
      let bestDot = Math.cos(rad(35));
      for (const a of this.arcs(cur, this.r, true)) {
        const dot = a.dx * dir.x + a.dy * dir.y;
        if (dot < bestDot || this.between(cur, a).bg > LINK_BG) continue;
        best = a;
        bestDot = dot;
      }
      if (!best) return null;
      const to = norm(best.x - cur.x, best.y - cur.y);
      cur = { x: cur.x + this.step * to.x, y: cur.y + this.step * to.y };
      dir = norm(0.5 * dir.x + to.x, 0.5 * dir.y + to.y);
      pts.push(cur);
    }
    return null;
  }

  /** The stroke's end straight ahead of `p` (a tip): the last ink on the ray, less the round end. */
  tip(p: V, d: V): V {
    let last = 0;
    for (let s = 0.5; s <= 4 * this.r; s += 0.5) {
      if (this.cover(p.x + s * d.x, p.y + s * d.y) < 0.5) break;
      last = s;
    }
    const s = Math.max(0, last - this.t / 2);
    return { x: p.x + s * d.x, y: p.y + s * d.y };
  }

  /**
   * One walk from `p0` heading `d0`. `home`: the start of the whole path and the direction it set
   * out in — arriving there closes the path.
   */
  walk(p0: V, d0: V, home: { p: V; d: V } | null): { pts: PathPoint[]; closed: boolean } {
    const pts: PathPoint[] = [];
    let p = p0;
    let d = d0;
    let travelled = 0;
    const push = (q: V, confidence: number, corner = false) => {
      pts.push({ px: q.x, py: q.y, confidence, corner });
    };
    const advance = (q: V, confidence: number, corner = false) => {
      this.mark(p, q);
      travelled += Math.hypot(q.x - p.x, q.y - p.y);
      p = q;
      push(q, confidence, corner);
    };
    const usable = (a: Arc) => a.visited < 0.5 && a.blocked < 0.5;
    const turnOf = (a: Arc) => Math.acos(Math.max(-1, Math.min(1, a.dx * d.x + a.dy * d.y)));

    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const ring = this.arcs(p, this.r);
      // Straight on along unwalked ink.
      let best: Arc | null = null;
      for (const a of ring) {
        if (!usable(a) || turnOf(a) > rad(60) || !this.linked(p, a)) continue;
        if (!best || turnOf(a) < turnOf(best)) best = a;
      }
      if (best) {
        const dir = norm(best.x - p.x, best.y - p.y);
        const q = this.centre({ x: p.x + this.step * dir.x, y: p.y + this.step * dir.y }, dir);
        d = norm(0.5 * d.x + dir.x, 0.5 * d.y + dir.y);
        advance(q, 0.9);
        continue;
      }
      // Home: walked ink ahead that is the path's own start, entered the way it set out.
      if (home && travelled > 6 * this.r) {
        const near = Math.hypot(p.x - home.p.x, p.y - home.p.y);
        if (near <= 2.5 * this.r && d.x * home.d.x + d.y * home.d.y >= 0.6 && (home.p.x - p.x) * d.x + (home.p.y - p.y) * d.y >= -this.step) {
          return { pts, closed: true };
        }
      }
      // Straight on, further out.
      const far = this.ahead(p, d);
      if (far) {
        const dir = norm(far.q.x - p.x, far.q.y - p.y);
        d = norm(d.x + 0.5 * dir.x, d.y + 0.5 * dir.y);
        advance(this.centre(far.q, d), far.hidden ? 0.6 : 0.8);
        continue;
      }
      // Under another series drawn over this one, along its course.
      const hidden = this.under(p, d);
      if (hidden) {
        for (const q of hidden.pts) advance(q, 0.4);
        d = hidden.d;
        continue;
      }
      // A turn: one unwalked way on, at any angle; further out when it is still merged with the
      // way back. Seen from the stroke's end ahead (at a cusp the way out leaves from the tip:
      // from short of it, background lies between) or, failing that, from here.
      const end = this.tip(p, d);
      let turn: Arc | null = null;
      let turnFrom = p;
      let ambiguous = false;
      search: for (const origin of Math.hypot(end.x - p.x, end.y - p.y) > 0.5 ? [end, p] : [p]) {
        for (const f of TURN_RADII) {
          const radius = f * this.r;
          // Through ink round a bend only close by (a cusp); further out, ink connects everything.
          const open = this.arcs(origin, radius).filter((a) => usable(a) && turnOf(a) <= rad(175) && (this.linked(origin, a) || (f <= JOIN_RINGS && this.joined(origin, a))));
          // Ink much fainter than the strongest way on is not this stroke (a gridline of a similar colour).
          const strongest = Math.max(0, ...open.map((a) => a.strength));
          // …nor is a fringe of the walked stroke that does not go on.
          const ways = open.filter((a) => a.strength >= FAINT * strongest && this.runsOn(origin, a));
          if (!ways.length) continue;
          ways.sort((a, b) => turnOf(a) - turnOf(b));
          ambiguous = ways.length > 1 && turnOf(ways[1]!) - turnOf(ways[0]!) < rad(30);
          if (!ambiguous) {
            turn = ways[0]!;
            turnFrom = origin;
          }
          break search;
        }
      }
      if (turn && !ambiguous) {
        // A sharp turn is a cusp: its tip is a point of the path.
        const sharp = turnOf(turn) > rad(CUSP_DEGREES);
        if (turnFrom === end) advance(end, 0.9, sharp);
        else if (sharp && pts.length) pts[pts.length - 1]!.corner = true;
        const dir = norm(turn.x - p.x, turn.y - p.y);
        d = dir;
        advance(this.centre({ x: turn.x, y: turn.y }, dir), 0.8);
        continue;
      }
      if (ambiguous) return { pts, closed: false };
      // The stroke ends here. Its tip, then back along the path to where an unwalked branch leaves it.
      const branch = this.branchBack(pts, p0);
      if (!branch) {
        if (Math.hypot(end.x - p.x, end.y - p.y) > 0.5) push(end, 0.9);
        return { pts, closed: false };
      }
      this.retraced = true;
      if (Math.hypot(end.x - p.x, end.y - p.y) > 0.5) push(end, 0.9, true);
      else if (pts.length) pts[pts.length - 1]!.corner = true;
      const n = pts.length;
      for (let i = n - 2; i >= Math.max(0, branch.index); i--) {
        if (pts[i]!.corner) continue;
        pts.push({ ...pts[i]!, corner: false });
      }
      const from = branch.index >= 0 ? { x: pts[branch.index]!.px, y: pts[branch.index]!.py } : p0;
      if (branch.index < 0) push(p0, 0.9);
      d = norm(branch.arc.x - from.x, branch.arc.y - from.y);
      p = from;
      const q = this.centre({ x: branch.arc.x, y: branch.arc.y }, d);
      this.mark(p, q);
      travelled += Math.hypot(q.x - p.x, q.y - p.y);
      p = q;
      push(q, 0.8);
    }
    return { pts, closed: false };
  }

  /**
   * Whether unwalked ink goes on from arc `a` (seen from `from`) for BRANCH_RUN ring radii: a
   * branch, not a fringe of the walked stroke left beside the path.
   */
  runsOn(from: V, a: Arc): boolean {
    let p: V = { x: a.x, y: a.y };
    let d = norm(a.x - from.x, a.y - from.y);
    for (let n = 1; n < BRANCH_RUN; n++) {
      let best: Arc | null = null;
      let bestDot = Math.cos(rad(60));
      for (const b of this.arcs(p, this.r)) {
        const dot = b.dx * d.x + b.dy * d.y;
        if (b.visited >= 0.5 || b.blocked >= 0.5 || dot < bestDot || !this.linked(p, b)) continue;
        best = b;
        bestDot = dot;
      }
      if (!best) return false;
      d = norm(best.x - p.x, best.y - p.y);
      p = { x: best.x, y: best.y };
    }
    return true;
  }

  /**
   * Walking back from the end of `pts`: the first point (index, −1 = the walk's start `p0`) where
   * an unwalked arc leaves in the direction of travel.
   */
  branchBack(pts: PathPoint[], p0: V): { index: number; arc: Arc } | null {
    let back = 0;
    for (let i = pts.length - 2; i >= -1; i--) {
      const here: V = i >= 0 ? { x: pts[i]!.px, y: pts[i]!.py } : p0;
      const prev = pts[i + 1]!;
      back += Math.hypot(prev.px - here.x, prev.py - here.y);
      if (back > this.retraceLimit) return null;
      if (back < this.r) continue;
      const heading = norm(here.x - prev.px, here.y - prev.py);
      for (const radius of [this.r, 1.6 * this.r]) {
        let best: Arc | null = null;
        let bestTurn = rad(BRANCH_DEGREES);
        const fresh = this.arcs(here, radius).filter((a) => a.visited < 0.5 && a.blocked < 0.5);
        for (const a of fresh) {
          const turn = Math.acos(Math.max(-1, Math.min(1, a.dx * heading.x + a.dy * heading.y)));
          if (turn > bestTurn || !this.linked(here, a, BRANCH_BG) || !this.runsOn(here, a)) continue;
          // Unwalked ink leaving the other way too is a line crossing the path, not a branch of it.
          if (fresh.some((o) => o !== a && o.dx * a.dx + o.dy * a.dy <= -0.7)) continue;
          best = a;
          bestTurn = turn;
        }
        if (best) return { index: i, arc: best };
      }
    }
    return null;
  }
}

/** Width of the stroke at the seed: its shortest run through the seed over four directions. */
function strokeWidth(alpha: Float32Array, w: number, h: number, seed: V): number {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x]! >= ON_ALPHA;
  let best = Infinity;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const) {
    let n = 1;
    for (const s of [1, -1]) {
      for (let k = 1; k <= 60 && on(seed.x + s * k * dx, seed.y + s * k * dy); k++) n++;
    }
    best = Math.min(best, n * (dx && dy ? Math.SQRT1_2 : 1));
  }
  return Math.max(1, best);
}

/** Direction of the stroke at the seed: the principal axis of the ink connected to it nearby. */
function strokeDirection(alpha: Float32Array, w: number, h: number, seed: V, radius: number): V {
  const R = Math.ceil(radius);
  const seen = new Set<number>([seed.y * w + seed.x]);
  const stack = [seed.y * w + seed.x];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let n = 0;
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    const y = (k - x) / w;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    n++;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || (xx - seed.x) ** 2 + (yy - seed.y) ** 2 > R * R) continue;
        const q = yy * w + xx;
        if (seen.has(q) || alpha[q]! < ON_ALPHA) continue;
        seen.add(q);
        stack.push(q);
      }
    }
  }
  const cxx = sxx / n - (sx / n) ** 2;
  const cyy = syy / n - (sy / n) ** 2;
  const cxy = sxy / n - (sx / n) * (sy / n);
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  return { x: Math.cos(th), y: Math.sin(th) };
}

const lengthOf = (path: { px: number; py: number }[]): number => {
  let L = 0;
  for (let i = 0; i + 1 < path.length; i++) L += Math.hypot(path[i + 1]!.px - path[i]!.px, path[i + 1]!.py - path[i]!.py);
  return L;
};

/**
 * How far the path doubles back in x: the deepest it comes back behind a point it had reached,
 * whichever way it runs — 0 for a function of x, a marker's width for a line looping round an open
 * marker, the fold's depth for a curve that folds over, the loop's width for a loop.
 */
function backTravelOf(path: PathPoint[]): number {
  let hi = -Infinity;
  let lo = Infinity;
  let down = 0;
  let up = 0;
  for (const p of path) {
    hi = Math.max(hi, p.px);
    lo = Math.min(lo, p.px);
    down = Math.max(down, hi - p.px);
    up = Math.max(up, p.px - lo);
  }
  return Math.min(down, up);
}

/** Open: from its left end. Closed: from its leftmost point, clockwise on screen, ending on it again. */
function orderPath(path: PathPoint[], closed: boolean): PathPoint[] {
  if (path.length < 2) return path;
  if (!closed) {
    const a = path[0]!;
    const b = path[path.length - 1]!;
    return a.px < b.px || (a.px === b.px && a.py <= b.py) ? path : [...path].reverse();
  }
  let start = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i]!;
    const q = path[start]!;
    if (p.px < q.px || (p.px === q.px && p.py < q.py)) start = i;
  }
  let out = [...path.slice(start), ...path.slice(0, start)];
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const p = out[i]!;
    const q = out[(i + 1) % out.length]!;
    area += p.px * q.py - q.px * p.py;
  }
  // y points down: a positive area is clockwise on screen.
  if (area < 0) out = [out[0]!, ...out.slice(1).reverse()];
  return [...out, { ...out[0]! }];
}

/** The stroke through the seed as an ordered path, or null when there is none to follow. */
export function followStroke(input: FollowInput): Followed | null {
  const { alpha, region, seed } = input;
  const w = region.width;
  const h = region.height;
  if ((alpha[seed.y * w + seed.x] ?? -1) < ON_ALPHA) return null;
  const t = strokeWidth(alpha, w, h, seed);
  const walker = new Walker(input, t);
  const d0 = strokeDirection(alpha, w, h, seed, Math.max(4, 2 * t + 2));
  const p0 = walker.centre(seed, d0);
  const home = { p: p0, d: d0 };
  const forward = walker.walk(p0, d0, home);
  let path: PathPoint[];
  if (forward.closed) path = [{ px: p0.x, py: p0.y, confidence: 0.9, corner: false }, ...forward.pts];
  else {
    const backward = walker.walk(p0, { x: -d0.x, y: -d0.y }, null);
    path = [...backward.pts.reverse(), { px: p0.x, py: p0.y, confidence: 0.9, corner: false }, ...forward.pts];
  }
  if (path.length < 3) return null;
  const backTravel = backTravelOf(path);
  const ordered = orderPath(path, forward.closed);
  return { path: ordered, closed: forward.closed, retraced: walker.retraced, thickness: t, backTravel, fat: walker.fat / path.length, length: lengthOf(ordered) };
}

/** Distance from a point to a polyline. */
function distanceTo(px: number, py: number, poly: { px: number; py: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const dx = b.px - a.px;
    const dy = b.py - a.py;
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((px - a.px) * dx + (py - a.py) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - (a.px + u * dx), py - (a.py + u * dy)));
  }
  return best;
}

/**
 * Whether the followed path replaces the column walker's (`walked`, or null when it found none):
 * only a path that doubles back, agrees with the walker where the walker went and is clearly
 * longer. `regionWidth` and `markerMax` (the largest size of a marker) scale what counts as doubling back.
 */
export function takesOver(f: Followed, walked: { px: number; py: number }[] | null, regionWidth: number, markerMax: number): boolean {
  // More than a line makes going round a marker on it.
  const doublesBack = Math.max(markerMax, 6 * f.thickness, 0.04 * regionWidth);
  const box = f.path.reduce(
    (b, p) => ({ x0: Math.min(b.x0, p.px), x1: Math.max(b.x1, p.px), y0: Math.min(b.y0, p.py), y1: Math.max(b.y1, p.py) }),
    { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
  );
  const loop = f.closed && box.x1 - box.x0 >= doublesBack && box.y1 - box.y0 >= Math.max(8, 3 * f.thickness);
  // An open path that walked back along itself to find its way on is a guess (a loop proves it
  // by closing; an open curve cannot): the column walk stands.
  const fold = !f.closed && !f.retraced && f.backTravel >= doublesBack;
  if (!loop && !fold) return false;
  // A line through filled markers of its own colour is ink wider than the stroke at every marker:
  // no path to trust (a loop's crossings and merged tips are a few steps of a long walk).
  if (f.fat > MAX_FAT) return false;
  if (!walked || walked.length < 2) return f.length >= 2 * doublesBack;
  const reach = 2 * f.thickness + 2;
  const agree = walked.filter((p) => distanceTo(p.px, p.py, f.path) <= reach).length;
  return agree >= AGREE * walked.length && f.length >= 1.25 * lengthOf(walked);
}

/**
 * Whether a column walk's path (left to right) shows that the stroke may double back, so the path
 * follower is worth running: a jump between neighbouring points (the walk crossed from one branch
 * of a fold to the other), an end short of the box's left or right edge (the walk may have
 * stopped at a fold: a loop's tip, whose two branches run merged a long way), or ink of the series
 * behind one of its ends — at the same columns as the walk's last ones but off its path (the stroke
 * turned back there). A walk with none of these is a function of x from edge to edge. Cheap: a
 * window of a few dozen columns at each end.
 */
export function mayDoubleBack(walked: { px: number; py: number }[], alpha: Float32Array, region: Region, thickness: number): boolean {
  const w = region.width;
  const jump = 3 * thickness + 3;
  for (let i = 0; i + 1 < walked.length; i++) {
    const a = walked[i]!;
    const b = walked[i + 1]!;
    if (Math.abs(b.py - a.py) > jump && Math.abs(b.px - a.px) <= 2) return true;
  }
  const margin = 3 * thickness + 6;
  if (walked[0]!.px > region.x0 + margin || walked[walked.length - 1]!.px < region.x1 - margin) return true;
  const reach = Math.max(12, 6 * thickness);
  const off = thickness + 3;
  for (const [end, dir] of [
    [walked[walked.length - 1]!, -1],
    [walked[0]!, 1],
  ] as const) {
    let behind = 0;
    for (let d = 1; d <= reach; d++) {
      const x = Math.round(end.px + dir * d);
      if (x < region.x0 || x > region.x1) break;
      // The walk's own centre in that column.
      let own = Number.NaN;
      for (const p of walked) if (Math.round(p.px) === x) own = p.py;
      if (Number.isNaN(own)) continue;
      for (let y = Math.max(region.y0, Math.round(end.py - reach)); y <= Math.min(region.y1, Math.round(end.py + reach)); y++) {
        if (Math.abs(y - own) > off && region.mask[y * w + x] && alpha[y * w + x]! >= ON_ALPHA && Math.abs(y - end.py) <= reach) behind++;
      }
    }
    if (behind >= Math.max(3, reach / 2)) return true;
  }
  return false;
}

/** Suggested points of a followed path (see the header). */
export function pickPoints(path: PathPoint[], maxPoints: number): TracedPoint[] {
  const n = path.length;
  const strip = (p: PathPoint): TracedPoint => ({ px: p.px, py: p.py, confidence: p.confidence });
  if (n <= 2) return path.map(strip);
  const budget = Math.max(2, Math.floor(maxPoints));
  const keep = new Set<number>([0, n - 1]);
  path.forEach((p, i) => p.corner && keep.add(i));
  const segDist = (i: number, a: number, b: number): number => {
    const p = path[a]!;
    const q = path[b]!;
    const dx = q.px - p.px;
    const dy = q.py - p.py;
    const L2 = dx * dx + dy * dy;
    const r = path[i]!;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((r.px - p.px) * dx + (r.py - p.py) * dy) / L2)) : 0;
    return Math.hypot(r.px - (p.px + u * dx), r.py - (p.py + u * dy));
  };
  // Largest deviation first.
  while (keep.size < budget) {
    const sorted = [...keep].sort((a, b) => a - b);
    let worst = -1;
    let worstD = 0.75;
    for (let s = 0; s + 1 < sorted.length; s++) {
      for (let i = sorted[s]! + 1; i < sorted[s + 1]!; i++) {
        const dd = segDist(i, sorted[s]!, sorted[s + 1]!);
        if (dd > worstD) {
          worstD = dd;
          worst = i;
        }
      }
    }
    if (worst < 0) break;
    keep.add(worst);
  }
  // Then the longest stretches, halved.
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1]! + Math.hypot(path[i]!.px - path[i - 1]!.px, path[i]!.py - path[i - 1]!.py));
  while (keep.size < budget) {
    const sorted = [...keep].sort((a, b) => a - b);
    let best = -1;
    let bestLen = 0;
    for (let s = 0; s + 1 < sorted.length; s++) {
      const a = sorted[s]!;
      const b = sorted[s + 1]!;
      if (b - a < 2) continue;
      const len = arc[b]! - arc[a]!;
      if (len > bestLen) {
        bestLen = len;
        const mid = (arc[a]! + arc[b]!) / 2;
        let m = a + 1;
        for (let i = a + 1; i < b; i++) if (Math.abs(arc[i]! - mid) < Math.abs(arc[m]! - mid)) m = i;
        best = m;
      }
    }
    if (best < 0) break;
    keep.add(best);
  }
  return [...keep].sort((a, b) => a - b).map((i) => strip(path[i]!));
}
