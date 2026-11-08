/**
 * Data-unit scoring of the line benchmark (bench/lines/values.ts) on a small synthetic truth:
 * an x axis 0–10 over px 100–300 (20 px per unit) and a y axis 0–100 over py 400–200 (2 px per
 * unit), so every pixel displacement has a known value and %-of-range equivalent.
 */

import { describe, expect, it } from 'vitest';
import type { TraceResult } from '../../src/auto/index.ts';
import type { Truth, TruthAxis } from '../axes/truth.ts';
import { scoreTrace } from './score.ts';
import type { SeriesTruth } from './truth.ts';
import { aggregateValues, nearestOnPieces, valueError, valueMapFromTruth, valueStats } from './values.ts';

function axis(which: 'x' | 'y', ticks: [value: number, pixel: number][]): TruthAxis {
  const point = (p: number) => (which === 'x' ? { x: p, y: 400 } : { x: 100, y: p });
  return {
    scale: 'linear',
    line: which === 'x' ? [{ x: 100, y: 400 }, { x: 300, y: 400 }] : [{ x: 100, y: 400 }, { x: 100, y: 200 }],
    lineDrawn: true,
    tickMarks: true,
    ticks: ticks.map(([value, p]) => ({ value, point: point(p), minor: false })),
  };
}

const truth: Truth = {
  id: 't',
  imagePath: 't.png',
  source: 'real',
  tags: ['real'],
  plotBox: null,
  x: axis('x', [[0, 100], [5, 200], [10, 300]]),
  y: axis('y', [[0, 400], [50, 300], [100, 200]]),
  knownValues: null,
};

const pt = (px: number, py: number) => ({ px, py, confidence: 1 });

function result(kind: TraceResult['kind'], path: [number, number][], points = path): TraceResult {
  return {
    ok: true,
    kind,
    style: 'solid',
    color: [0, 0, 0],
    path: path.map(([x, y]) => pt(x, y)),
    points: points.map(([x, y]) => pt(x, y)),
    timings: { totalMs: 1 },
  };
}

function series(partial: Partial<SeriesTruth>): SeriesTruth {
  return {
    id: 's',
    kind: 'line',
    tags: [],
    seed: { x: 200, y: 300 },
    pieces: [],
    markers: [],
    corners: [],
    markerSizePx: 10,
    style: 'solid',
    partial: false,
    ...partial,
  };
}

describe('valueMapFromTruth', () => {
  it('builds the engine calibration from the outermost ticks', () => {
    const map = valueMapFromTruth(truth);
    expect(map).not.toBeNull();
    expect(map!.xRange).toBe(10);
    expect(map!.yRange).toBe(100);
    const v = map!.calibration.pixelToValue(200, 300);
    expect(v.x).toBeCloseTo(5, 9);
    expect(v.y).toBeCloseTo(50, 9);
  });

  it('is null when an axis has no range (no usable ticks)', () => {
    expect(valueMapFromTruth({ ...truth, y: axis('y', [[1, 300], [1, 200]]) })).toBeNull();
    expect(valueMapFromTruth({ ...truth, x: axis('x', [[0, 100]]) })).toBeNull();
  });
});

describe('valueError', () => {
  const map = valueMapFromTruth(truth)!;

  it('converts a pixel displacement to data units and % of the labelled range', () => {
    const e = valueError(map, { x: 200, y: 302 }, { x: 200, y: 300 })!;
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.xPct).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(1, 9); // 2 px at 2 px per unit
    expect(e.yPct).toBeCloseTo(1, 9); // 1 of 100
    const f = valueError(map, { x: 220, y: 300 }, { x: 200, y: 300 })!;
    expect(f.x).toBeCloseTo(1, 9); // 20 px at 20 px per unit
    expect(f.xPct).toBeCloseTo(10, 9);
  });

  it('finds the nearest truth point on the pieces', () => {
    const q = nearestOnPieces({ x: 150, y: 310 }, [
      [
        { x: 120, y: 300 },
        { x: 280, y: 300 },
      ],
    ])!;
    expect(q).toEqual({ x: 150, y: 300 });
    expect(nearestOnPieces({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('scoreTrace with a value map', () => {
  const map = valueMapFromTruth(truth)!;

  it('scores traced points, matched corners and markers in data units', () => {
    const s = series({
      kind: 'step',
      pieces: [
        [
          { x: 120, y: 300 },
          { x: 280, y: 300 },
        ],
      ],
      corners: [{ x: 200, y: 300 }],
    });
    // Path 2 px below the truth (y = 49 instead of 50); the corner is suggested 1 px to the right.
    const path: [number, number][] = [140, 170, 230, 260].map((x) => [x, 302]);
    const score = scoreTrace('chart', ['real'], s, [], result('curve', path, [[201, 300]]), map);
    expect(score.errors.every((d) => Math.abs(d - 2) < 1e-9)).toBe(true);
    expect(score.corners).toEqual({ truth: 1, matched: 1 });
    expect(score.values).not.toBeNull();
    expect(score.values!.points).toHaveLength(4);
    for (const e of score.values!.points) {
      expect(e.y).toBeCloseTo(1, 9);
      expect(e.yPct).toBeCloseTo(1, 9);
      expect(e.x).toBeCloseTo(0, 9);
    }
    expect(score.values!.corners).toHaveLength(1);
    expect(score.values!.corners[0]!.x).toBeCloseTo(0.05, 9); // 1 px at 20 px per unit
    expect(score.values!.corners[0]!.xPct).toBeCloseTo(0.5, 9);
    expect(score.values!.markers).toHaveLength(0);
  });

  it('scores one-to-one matched markers and leaves unmatched ones out', () => {
    const s = series({
      kind: 'scatter',
      style: null,
      markers: [
        { x: 150, y: 300 },
        { x: 250, y: 300 },
        { x: 100, y: 250 },
      ],
    });
    // Two found within max(2, 0.4 × 10) = 4 px; the third true marker is missed.
    const score = scoreTrace('chart', ['real'], s, [], result('markers', [[152, 300], [250, 304]]), map);
    expect(score.markers.matched).toBe(2);
    const m = score.values!.markers;
    expect(m).toHaveLength(2);
    expect(m[0]!.x).toBeCloseTo(0.1, 9); // 2 px
    expect(m[1]!.y).toBeCloseTo(2, 9); // 4 px at 2 px per unit
    expect(m[1]!.yPct).toBeCloseTo(2, 9);
  });

  it('has no values without a map (synthetic charts) and leaves the pixel metrics unchanged', () => {
    const s = series({
      pieces: [
        [
          { x: 120, y: 300 },
          { x: 280, y: 300 },
        ],
      ],
      corners: [{ x: 200, y: 300 }],
    });
    const r = result('curve', [[140, 302], [260, 302]], [[201, 300]]);
    const without = scoreTrace('chart', [], s, [], r);
    const withMap = scoreTrace('chart', [], s, [], r, map);
    expect(without.values).toBeNull();
    expect({ ...withMap, values: null }).toEqual(without);
  });
});

describe('aggregateValues', () => {
  const e = (y: number, yPct: number) => ({ x: 0, y, xPct: 0, yPct });

  it('pools % of range across figures but data units only within one figure', () => {
    const a = { chart: 'a', values: { points: [e(1, 1), e(3, 3)], corners: [], markers: [] } };
    const b = { chart: 'b', values: { points: [e(2, 2)], corners: [], markers: [] } };
    const none = { chart: 'c', values: null };
    const same = aggregateValues([a, none], 'points');
    expect(same.n).toBe(2);
    expect(same.yMedian).toBe(3);
    expect(same.yPctMedian).toBe(3);
    const mixed = aggregateValues([a, b, none], 'points');
    expect(mixed.n).toBe(3);
    expect(mixed.yMedian).toBeNull();
    expect(mixed.yPctMedian).toBe(2);
    expect(aggregateValues([none], 'points').n).toBe(0);
  });

  it('takes the median and p95 of each component', () => {
    const errs = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 2 * i, xPct: i / 10, yPct: i / 5 }));
    const v = valueStats(errs);
    expect(v.xMedian).toBe(50);
    expect(v.xP95).toBe(95);
    expect(v.yP95).toBe(190);
    expect(v.yPctMedian).toBe(10);
  });
});
