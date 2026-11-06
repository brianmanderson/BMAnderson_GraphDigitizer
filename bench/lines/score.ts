/**
 * Scoring one trace against its series' truth, and aggregating.
 *
 * Curves (line and step series; 'curve' expected):
 * - coverage: the true polyline is sampled every 1 px; a sample is covered when the traced path
 *   (as a polyline) passes within COVER_PX of it. Coverage = covered image columns / columns the
 *   truth spans (the "% of the x-range traced"). Real figures: over their labelled segments only.
 * - centreline error: distance from each traced path point to the true polyline (median, p95,
 *   pooled over traces). Real figures: only points inside a labelled segment's x-range (minus
 *   3 px at each end, where the steps are).
 * - wrong series: more than 20 % of the traced points (those scored for error) are > COVER_PX from
 *   their own series and nearer to another series.
 * - corner recall (steps): true step corners with a suggested point within CORNER_PX.
 * Markers (scatter series; 'markers' expected): true centres matched one-to-one (greedy, nearest
 * first) by traced centroids within max(2, 0.4 × marker size); recall and precision; wrong group:
 * found markers that match no marker of their own series but one of another series (filled taken
 * for open, a square for a circle) within that distance, as a share of all found.
 * kind: whether 'auto' chose the expected kind.
 * style: whether a curve's reported line style (TraceResult.style) is its true style ('unknown'
 * counts as wrong); over curve series with a known style.
 */

import type { TraceResult } from '../../src/auto/index.ts';
import type { P, SeriesTruth } from './truth.ts';

export const COVER_PX = 3;
export const CORNER_PX = 2;
const WRONG_FRACTION = 0.2;

export interface TraceScore {
  chart: string;
  series: string;
  tags: string[];
  expected: 'curve' | 'markers';
  kind: TraceResult['kind'];
  ms: number;
  /** Curves. */
  coverage: number | null;
  errors: number[];
  wrong: boolean;
  corners: { truth: number; matched: number };
  /** Markers. */
  markers: { truth: number; found: number; matched: number; wrongGroup: number };
  points: number;
  /** Curves with a known style: the true style and the reported one. */
  style: { truth: string; got: string } | null;
}

function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function polyDist(p: P, poly: P[]): number {
  if (poly.length === 1) return Math.hypot(p.x - poly[0]!.x, p.y - poly[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, segDist(p, poly[i]!, poly[i + 1]!));
  return best;
}

const piecesDist = (p: P, pieces: P[][]) => Math.min(...pieces.map((q) => polyDist(p, q)));

function sample(poly: P[]): P[] {
  const out: P[] = [poly[0]!];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

/** Geometry of another series, for the wrong-series test. */
function geometry(s: SeriesTruth): P[][] {
  return s.kind === 'scatter' ? s.markers.map((m) => [m]) : s.pieces;
}

/** One-to-one matches (greedy, nearest first): how many, and which found ones are used. */
function matchMarkers(truth: P[], found: P[], tol: number): { matched: number; used: Set<number> } {
  const pairs: { d: number; i: number; j: number }[] = [];
  truth.forEach((t, i) =>
    found.forEach((f, j) => {
      const d = Math.hypot(t.x - f.x, t.y - f.y);
      if (d <= tol) pairs.push({ d, i, j });
    }),
  );
  pairs.sort((a, b) => a.d - b.d);
  const ti = new Set<number>();
  const fj = new Set<number>();
  for (const p of pairs) {
    if (ti.has(p.i) || fj.has(p.j)) continue;
    ti.add(p.i);
    fj.add(p.j);
  }
  return { matched: ti.size, used: fj };
}

export function scoreTrace(chart: string, chartTags: string[], s: SeriesTruth, others: SeriesTruth[], r: TraceResult): TraceScore {
  const expected = s.kind === 'scatter' ? 'markers' : 'curve';
  const path: P[] = r.path.map((p) => ({ x: p.px, y: p.py }));
  const score: TraceScore = {
    chart,
    series: s.id,
    tags: [...new Set([...chartTags, ...s.tags])],
    expected,
    kind: r.kind,
    ms: r.timings.totalMs,
    coverage: null,
    errors: [],
    wrong: false,
    corners: { truth: s.corners.length, matched: 0 },
    markers: { truth: s.markers.length, found: 0, matched: 0, wrongGroup: 0 },
    points: r.points.length,
    style: expected === 'curve' && s.style ? { truth: s.style, got: r.style } : null,
  };
  if (expected === 'markers') {
    score.markers.truth = s.markers.length;
    if (r.kind === 'markers') {
      const tol = Math.max(2, 0.4 * s.markerSizePx);
      const m = matchMarkers(s.markers, path, tol);
      const theirs = others.flatMap((o) => o.markers);
      score.markers.found = path.length;
      score.markers.matched = m.matched;
      score.markers.wrongGroup = path.filter((p, j) => !m.used.has(j) && theirs.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol)).length;
    }
    return score;
  }
  score.markers.truth = 0;

  // Coverage by image column.
  const all = new Set<number>();
  const covered = new Set<number>();
  for (const piece of s.pieces) {
    for (const q of sample(piece)) {
      const col = Math.round(q.x);
      all.add(col);
      if (path.length && polyDist(q, path.length > 1 ? path : [path[0]!]) <= COVER_PX) covered.add(col);
    }
  }
  score.coverage = all.size ? covered.size / all.size : null;

  // Centreline error and wrong series.
  const scored = s.partial
    ? path.filter((p) => s.pieces.some((q) => p.x >= Math.min(q[0]!.x, q[q.length - 1]!.x) + 3 && p.x <= Math.max(q[0]!.x, q[q.length - 1]!.x) - 3))
    : path;
  let strays = 0;
  for (const p of scored) {
    const d = piecesDist(p, s.pieces);
    score.errors.push(d);
    if (d > COVER_PX && others.some((o) => piecesDist(p, geometry(o)) < d)) strays++;
  }
  score.wrong = scored.length > 0 && strays > WRONG_FRACTION * scored.length;

  // Step corners kept in the suggested points.
  if (s.corners.length) {
    score.corners.matched = s.corners.filter((c) => r.points.some((p) => Math.hypot(p.px - c.x, p.py - c.y) <= CORNER_PX)).length;
  }
  return score;
}

export interface Metrics {
  traces: number;
  /** auto chose the expected kind. */
  kindAccuracy: number | null;
  coverage: number | null;
  medianError: number | null;
  p95Error: number | null;
  wrongRate: number | null;
  cornerRecall: number | null;
  markerRecall: number | null;
  markerPrecision: number | null;
  /** Found markers that belong to another series (see TraceScore). */
  wrongGroupRate: number | null;
  /** Curves whose reported line style is right. */
  styleAccuracy: number | null;
  meanMs: number;
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

export function aggregate(scores: TraceScore[]): Metrics {
  const curves = scores.filter((s) => s.expected === 'curve');
  const marks = scores.filter((s) => s.expected === 'markers');
  const errs = curves.flatMap((s) => s.errors).sort((a, b) => a - b);
  const cov = curves.map((s) => s.coverage).filter((c): c is number => c !== null);
  const cornerTruth = curves.reduce((n, s) => n + s.corners.truth, 0);
  const mTruth = marks.reduce((n, s) => n + s.markers.truth, 0);
  const mFound = marks.reduce((n, s) => n + s.markers.found, 0);
  const mMatched = marks.reduce((n, s) => n + s.markers.matched, 0);
  const styled = curves.filter((s) => s.style);
  return {
    traces: scores.length,
    kindAccuracy: scores.length ? scores.filter((s) => s.kind === s.expected).length / scores.length : null,
    coverage: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : null,
    medianError: quantile(errs, 0.5),
    p95Error: quantile(errs, 0.95),
    wrongRate: curves.length ? curves.filter((s) => s.wrong).length / curves.length : null,
    cornerRecall: cornerTruth ? curves.reduce((n, s) => n + s.corners.matched, 0) / cornerTruth : null,
    markerRecall: mTruth ? mMatched / mTruth : null,
    markerPrecision: mTruth ? (mFound ? mMatched / mFound : 0) : null,
    wrongGroupRate: mTruth ? (mFound ? marks.reduce((n, s) => n + s.markers.wrongGroup, 0) / mFound : 0) : null,
    styleAccuracy: styled.length ? styled.filter((s) => s.style!.got === s.style!.truth).length / styled.length : null,
    meanMs: scores.length ? scores.reduce((n, s) => n + s.ms, 0) / scores.length : 0,
  };
}

/** Metrics the baseline gates: a regression in any of them, overall or per category, fails. */
export const GATED: { key: keyof Metrics; higherIsBetter: boolean }[] = [
  { key: 'kindAccuracy', higherIsBetter: true },
  { key: 'coverage', higherIsBetter: true },
  { key: 'medianError', higherIsBetter: false },
  { key: 'p95Error', higherIsBetter: false },
  { key: 'wrongRate', higherIsBetter: false },
  { key: 'cornerRecall', higherIsBetter: true },
  { key: 'markerRecall', higherIsBetter: true },
  { key: 'markerPrecision', higherIsBetter: true },
  { key: 'styleAccuracy', higherIsBetter: true },
  { key: 'wrongGroupRate', higherIsBetter: false },
];
