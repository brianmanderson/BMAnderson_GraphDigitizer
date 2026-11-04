/**
 * Scoring one detection against its ground truth, and aggregating scores into the metrics the
 * baseline gates on. Thresholds are fixed here so every run is judged the same way.
 */

import type { AxisDetection, DetectedAxis, PlotBox } from '../../src/auto/index.ts';
import type { P, Truth, TruthAxis } from './truth.ts';

/** An axis counts as found when the detected line is within this many px of the true one. */
export const AXIS_TOL_PX = 2;
/** A plot box counts as found when every corner is within this many px. */
export const BOX_TOL_PX = 4;
/** A detected tick matches a true one within this distance along the axis… */
export const TICK_ALONG_TOL_PX = 2;
/** …and this distance across it (absorbs a small axis offset). */
export const TICK_ACROSS_TOL_PX = 4;

export interface AxisScore {
  /** Max perpendicular distance from the true line's ends to the detected line; null = none. */
  error: number | null;
  found: boolean;
  tickMarks: boolean;
  truthMajor: number;
  matchedMajor: number;
  truthMinor: number;
  matchedMinor: number;
  detected: number;
  detectedMatched: number;
  tickConfidence: number;
}

export interface ImageScore {
  id: string;
  tags: string[];
  x: AxisScore;
  y: AxisScore;
  boxError: number | null;
  /** null when the label has no plot box. */
  boxFound: boolean | null;
  ms: number;
}

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const len = (a: P) => Math.hypot(a.x, a.y);

function distanceToLine(p: P, a: P, b: P): number {
  const d = sub(b, a);
  const L = len(d);
  if (L === 0) return len(sub(p, a));
  return Math.abs(d.x * (p.y - a.y) - d.y * (p.x - a.x)) / L;
}

function scoreAxis(truth: TruthAxis, det: DetectedAxis | null): AxisScore {
  const [t1, t2] = truth.line;
  const error = det ? Math.max(distanceToLine(t1, det.line.p1, det.line.p2), distanceToLine(t2, det.line.p1, det.line.p2)) : null;
  const dir = sub(t2, t1);
  const L = len(dir) || 1;
  const u = { x: dir.x / L, y: dir.y / L };
  const detTicks = det?.ticks.ticks ?? [];
  // Greedy one-to-one matching by distance.
  const pairs: { i: number; j: number; d: number }[] = [];
  truth.ticks.forEach((t, i) => {
    detTicks.forEach((k, j) => {
      const diff = sub(k.point, t.point);
      const along = Math.abs(dot(diff, u));
      const across = Math.abs(diff.x * u.y - diff.y * u.x);
      if (along <= TICK_ALONG_TOL_PX && across <= TICK_ACROSS_TOL_PX) pairs.push({ i, j, d: len(diff) });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const usedT = new Set<number>();
  const usedD = new Set<number>();
  for (const p of pairs) {
    if (usedT.has(p.i) || usedD.has(p.j)) continue;
    usedT.add(p.i);
    usedD.add(p.j);
  }
  const majors = truth.ticks.filter((t) => !t.minor).length;
  const matchedMajor = [...usedT].filter((i) => !truth.ticks[i]?.minor).length;
  return {
    error,
    found: error !== null && error <= AXIS_TOL_PX,
    tickMarks: truth.tickMarks,
    truthMajor: truth.tickMarks ? majors : 0,
    matchedMajor: truth.tickMarks ? matchedMajor : 0,
    truthMinor: truth.tickMarks ? truth.ticks.length - majors : 0,
    matchedMinor: truth.tickMarks ? usedT.size - matchedMajor : 0,
    detected: detTicks.length,
    detectedMatched: truth.tickMarks ? usedD.size : 0,
    tickConfidence: det?.ticks.confidence ?? 0,
  };
}

function boxCorners(b: PlotBox): P[] {
  return [b.topLeft, b.topRight, b.bottomRight, b.bottomLeft];
}

export function scoreImage(truth: Truth, det: AxisDetection, ms: number): ImageScore {
  let boxError: number | null = null;
  if (truth.plotBox && det.plotBox) {
    const c = boxCorners(det.plotBox);
    boxError = Math.max(...truth.plotBox.map((p, i) => len(sub(p, c[i] as P))));
  }
  return {
    id: truth.id,
    tags: truth.tags,
    x: scoreAxis(truth.x, det.xAxis),
    y: scoreAxis(truth.y, det.yAxis),
    boxError,
    boxFound: truth.plotBox ? boxError !== null && boxError <= BOX_TOL_PX : null,
    ms,
  };
}

/** Aggregate metrics for a group of images. Rates are 0–1; null when not applicable. */
export interface Metrics {
  images: number;
  /** X and Y axes found, of 2 × images. */
  axesFound: number;
  xFound: number;
  yFound: number;
  /** Median line error over detected axes, px. */
  medianAxisError: number | null;
  boxFound: number | null;
  /** Major ticks matched / true major ticks, on axes that have tick marks. */
  tickRecall: number | null;
  minorRecall: number | null;
  /** Matched detected ticks / detected ticks, on axes that have tick marks. */
  tickPrecision: number | null;
  /** Ticks reported on axes that have no tick marks (should be 0). */
  falseTicksOnBareAxes: number;
  meanMs: number;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function aggregate(scores: ImageScore[]): Metrics {
  const axes = scores.flatMap((s) => [s.x, s.y]);
  const marked = axes.filter((a) => a.tickMarks);
  const bare = axes.filter((a) => !a.tickMarks);
  const boxes = scores.filter((s) => s.boxFound !== null);
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  return {
    images: scores.length,
    axesFound: ratio(axes.filter((a) => a.found).length, axes.length) ?? 0,
    xFound: ratio(scores.filter((s) => s.x.found).length, scores.length) ?? 0,
    yFound: ratio(scores.filter((s) => s.y.found).length, scores.length) ?? 0,
    medianAxisError: median(axes.flatMap((a) => (a.error === null ? [] : [a.error]))),
    boxFound: boxes.length ? boxes.filter((s) => s.boxFound).length / boxes.length : null,
    tickRecall: ratio(sum(marked.map((a) => a.matchedMajor)), sum(marked.map((a) => a.truthMajor))),
    minorRecall: ratio(sum(marked.map((a) => a.matchedMinor)), sum(marked.map((a) => a.truthMinor))),
    tickPrecision: ratio(sum(marked.map((a) => a.detectedMatched)), sum(marked.map((a) => a.detected))),
    falseTicksOnBareAxes: sum(bare.map((a) => a.detected)),
    meanMs: scores.length ? sum(scores.map((s) => s.ms)) / scores.length : 0,
  };
}

/** Metrics the baseline gates on, and which direction is better. */
export const GATED: { key: keyof Metrics; higherIsBetter: boolean }[] = [
  { key: 'axesFound', higherIsBetter: true },
  { key: 'boxFound', higherIsBetter: true },
  { key: 'tickRecall', higherIsBetter: true },
  { key: 'minorRecall', higherIsBetter: true },
  { key: 'tickPrecision', higherIsBetter: true },
  { key: 'falseTicksOnBareAxes', higherIsBetter: false },
];
