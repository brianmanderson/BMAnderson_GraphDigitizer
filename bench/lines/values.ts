/**
 * Tracing errors in data units and as a fraction of the labelled axis range.
 *
 * A figure whose label carries calibrated axes (tick marks with values — the real figures and the
 * e2e fixtures, format bench/axes/truth.ts) gets a `ValueMap`: the engine's `calibrate` from
 * src/core, built from the outermost labelled tick of each axis exactly as a user would place the
 * two refs, never a reimplementation of the maths. Through it, a pixel displacement between a traced
 * point and the truth becomes a displacement in data units (Δx, Δy) and, in the scale's linear space
 * (`forward`, so log axes are measured in decades), a fraction of the labelled range (the span from
 * the lowest to the highest labelled tick of that axis).
 *
 * Synthetic charts carry data points and their pixels but no axis ticks or limits, so they have no
 * ValueMap and the value columns show `–` for them.
 */

import { calibrate, forward, parseDateTime, type Calibration, type ScaleType } from '../../src/core/index.ts';
import type { Truth, TruthAxis, TruthTick } from '../axes/truth.ts';
import type { P } from './truth.ts';

export interface ValueMap {
  calibration: Calibration;
  xScale: ScaleType;
  yScale: ScaleType;
  /** Labelled range of each axis in the scale's linear space (> 0). */
  xRange: number;
  yRange: number;
}

/** A traced position against its truth: absolute data-unit and %-of-range errors per axis. */
export interface ValueError {
  x: number;
  y: number;
  xPct: number;
  yPct: number;
}

export interface ValueErrors {
  /** Traced path points scored for the centreline error, against their nearest truth point. */
  points: ValueError[];
  /** True corners that a suggested point matched (within CORNER_PX). */
  corners: ValueError[];
  /** True markers matched one-to-one by a found marker. */
  markers: ValueError[];
}

const SCALES: readonly ScaleType[] = ['linear', 'log10', 'ln', 'reciprocal', 'date'];

function scaleOf(a: TruthAxis): ScaleType {
  return SCALES.find((s) => s === a.scale) ?? 'linear';
}

function tickValue(t: TruthTick): number | null {
  if (typeof t.value === 'number') return t.value;
  const d = parseDateTime(t.value);
  return d.ok ? d.ms : null;
}

/** The lowest and highest labelled tick (in linear space) with the range between them. */
function extremes(a: TruthAxis): { lo: TruthTick; hi: TruthTick; range: number } | null {
  const scale = scaleOf(a);
  const ticks = a.ticks.flatMap((t) => {
    const v = tickValue(t);
    const f = v === null ? null : forward(scale, v);
    return f === null ? [] : [{ t, f }];
  });
  if (ticks.length < 2) return null;
  const lo = ticks.reduce((m, c) => (c.f < m.f ? c : m));
  const hi = ticks.reduce((m, c) => (c.f > m.f ? c : m));
  const range = hi.f - lo.f;
  return range > 0 ? { lo: lo.t, hi: hi.t, range } : null;
}

/** The calibration a user would get from the label's outermost ticks, or null when it has none. */
export function valueMapFromTruth(truth: Truth): ValueMap | null {
  const x = extremes(truth.x);
  const y = extremes(truth.y);
  if (!x || !y) return null;
  const ref = (t: TruthTick) => ({ px: t.point.x, py: t.point.y, value: t.value });
  const xScale = scaleOf(truth.x);
  const yScale = scaleOf(truth.y);
  const r = calibrate({ X1: ref(x.lo), X2: ref(x.hi), Y1: ref(y.lo), Y2: ref(y.hi) }, xScale, yScale);
  if (!r.ok) return null;
  return { calibration: r.calibration, xScale, yScale, xRange: x.range, yRange: y.range };
}

/** The error of a traced pixel `got` against the true pixel `truth`, or null outside the scales' domain. */
export function valueError(map: ValueMap, got: P, truth: P): ValueError | null {
  const g = map.calibration.pixelToValue(got.x, got.y);
  const t = map.calibration.pixelToValue(truth.x, truth.y);
  if (g.x === null || g.y === null || t.x === null || t.y === null) return null;
  const gl = map.calibration.pixelToLinear(got.x, got.y);
  const tl = map.calibration.pixelToLinear(truth.x, truth.y);
  return {
    x: Math.abs(g.x - t.x),
    y: Math.abs(g.y - t.y),
    xPct: (100 * Math.abs(gl.u - tl.u)) / map.xRange,
    yPct: (100 * Math.abs(gl.w - tl.w)) / map.yRange,
  };
}

/** Nearest point of a segment a–b to p. */
function nearestOnSegment(p: P, a: P, b: P): P {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Nearest point of a set of polylines to p. */
export function nearestOnPieces(p: P, pieces: P[][]): P | null {
  let best: P | null = null;
  let bestD = Infinity;
  for (const poly of pieces) {
    const consider = (q: P) => {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    };
    if (poly.length === 1) {
      consider(poly[0]!);
      continue;
    }
    for (let i = 0; i + 1 < poly.length; i++) consider(nearestOnSegment(p, poly[i]!, poly[i + 1]!));
  }
  return best;
}

/** Median and p95 of each component, pooled over the given errors. */
export interface ValueStats {
  n: number;
  xMedian: number | null;
  xP95: number | null;
  xPctMedian: number | null;
  xPctP95: number | null;
  yMedian: number | null;
  yP95: number | null;
  yPctMedian: number | null;
  yPctP95: number | null;
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

export function valueStats(errors: ValueError[], withUnits = true): ValueStats {
  const sorted = (pick: (e: ValueError) => number) => errors.map(pick).sort((a, b) => a - b);
  const x = sorted((e) => e.x);
  const y = sorted((e) => e.y);
  const xp = sorted((e) => e.xPct);
  const yp = sorted((e) => e.yPct);
  return {
    n: errors.length,
    xMedian: withUnits ? quantile(x, 0.5) : null,
    xP95: withUnits ? quantile(x, 0.95) : null,
    xPctMedian: quantile(xp, 0.5),
    xPctP95: quantile(xp, 0.95),
    yMedian: withUnits ? quantile(y, 0.5) : null,
    yP95: withUnits ? quantile(y, 0.95) : null,
    yPctMedian: quantile(yp, 0.5),
    yPctP95: quantile(yp, 0.95),
  };
}

export const VALUE_WHATS = ['points', 'corners', 'markers'] as const;
export type ValueWhat = (typeof VALUE_WHATS)[number];

/**
 * Pooled stats of one kind of error over traces. Data units are only comparable within one
 * figure, so `xMedian`… are null when the traces come from more than one chart; % of range pools
 * across figures.
 */
export function aggregateValues(traces: { chart: string; values: ValueErrors | null }[], what: ValueWhat): ValueStats {
  const withValues = traces.filter((t) => t.values);
  const charts = new Set(withValues.map((t) => t.chart));
  return valueStats(
    withValues.flatMap((t) => t.values![what]),
    charts.size === 1,
  );
}
