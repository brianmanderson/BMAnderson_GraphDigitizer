import { describe, expect, it } from 'vitest';
import { calibrate, calibrateSpec, type Calibration, type CalibrationErrorKind, type Pixel } from './calibrate.ts';
import { formatDateTime, parseDateTime } from './dates.ts';
import type { CalibrationRefs } from './project.ts';
import { forward, SCALE_TYPES, type ScaleType } from './scales.ts';

// ---------------------------------------------------------------------------------------------
// Synthetic charts: a known value → pixel mapping we can generate refs from and check against.
// ---------------------------------------------------------------------------------------------

interface Vec {
  x: number;
  y: number;
}

interface SyntheticChart {
  xScale: ScaleType;
  yScale: ScaleType;
  /** Axis range in data values (dates as epoch ms). */
  xRange: readonly [number, number];
  yRange: readonly [number, number];
  /** Pixel of (xRange[0], yRange[0]). */
  origin: Vec;
  /** Pixel displacement from xRange[0] to xRange[1] / yRange[0] to yRange[1]. */
  xVec: Vec;
  yVec: Vec;
}

function fraction(scale: ScaleType, range: readonly [number, number], v: number): number {
  const lo = forward(scale, range[0])!;
  const hi = forward(scale, range[1])!;
  return (forward(scale, v)! - lo) / (hi - lo);
}

/** Ground-truth pixel of a data value on the synthetic chart. */
function truePixel(chart: SyntheticChart, x: number, y: number): Pixel {
  const s = fraction(chart.xScale, chart.xRange, x);
  const t = fraction(chart.yScale, chart.yRange, y);
  return {
    px: chart.origin.x + s * chart.xVec.x + t * chart.yVec.x,
    py: chart.origin.y + s * chart.xVec.y + t * chart.yVec.y,
  };
}

/** Refs at the given values: X refs along the bottom axis, Y refs along the left axis. */
function refsFor(
  chart: SyntheticChart,
  [x1, x2]: readonly [number, number],
  [y1, y2]: readonly [number, number],
  show: (axis: 'x' | 'y', v: number) => number | string = (_, v) => v,
): CalibrationRefs {
  return {
    X1: { ...truePixel(chart, x1, chart.yRange[0]), value: show('x', x1) },
    X2: { ...truePixel(chart, x2, chart.yRange[0]), value: show('x', x2) },
    Y1: { ...truePixel(chart, chart.xRange[0], y1), value: show('y', y1) },
    Y2: { ...truePixel(chart, chart.xRange[0], y2), value: show('y', y2) },
  };
}

function mustCalibrate(refs: CalibrationRefs, xScale: ScaleType, yScale: ScaleType): Calibration {
  const r = calibrate(refs, xScale, yScale);
  if (!r.ok) throw new Error(`calibration failed: ${r.error.kind}: ${r.error.message}`);
  return r.calibration;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value sampled uniformly in the scale's linear space between the range ends. */
function sampleValue(scale: ScaleType, range: readonly [number, number], r: number): number {
  const lo = forward(scale, range[0])!;
  const hi = forward(scale, range[1])!;
  const u = lo + r * (hi - lo);
  switch (scale) {
    case 'log10':
      return 10 ** u;
    case 'ln':
      return Math.exp(u);
    case 'reciprocal':
      return 1 / u;
    default:
      return u;
  }
}

function expectValueClose(actual: number | null, expected: number, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(Math.abs(actual! - expected), `${label}: got ${actual}, want ${expected}`).toBeLessThanOrEqual(
    1e-9 * Math.max(1, Math.abs(expected)),
  );
}

function expectPixelClose(actual: Pixel | null, expected: Pixel, label: string, tol = 1e-6): void {
  expect(actual, label).not.toBeNull();
  expect(Math.hypot(actual!.px - expected.px, actual!.py - expected.py), label).toBeLessThanOrEqual(tol);
}

const DATE_RANGE: readonly [number, number] = [Date.UTC(2020, 0, 1), Date.UTC(2024, 5, 30)];

const RANGES: Record<ScaleType, readonly [number, number]> = {
  linear: [-50, 250],
  log10: [0.01, 1000],
  ln: [0.5, 2e4],
  reciprocal: [2, 50],
  date: DATE_RANGE,
};

/** Refs at 20% and 80% of each axis, so checks cover interpolation and extrapolation. */
function innerRefValues(scale: ScaleType): readonly [number, number] {
  return [sampleValue(scale, RANGES[scale], 0.2), sampleValue(scale, RANGES[scale], 0.8)];
}

const deg = (d: number) => (d * Math.PI) / 180;

const GEOMETRIES: Record<string, Pick<SyntheticChart, 'origin' | 'xVec' | 'yVec'>> = {
  'axis-aligned (y up)': { origin: { x: 80, y: 420 }, xVec: { x: 500, y: 0 }, yVec: { x: 0, y: -360 } },
  'rotated 5°': {
    origin: { x: 90, y: 400 },
    xVec: { x: 500 * Math.cos(deg(5)), y: 500 * Math.sin(deg(5)) },
    yVec: { x: 360 * Math.sin(deg(5)), y: -360 * Math.cos(deg(5)) },
  },
  'rotated −5°': {
    origin: { x: 60, y: 440 },
    xVec: { x: 500 * Math.cos(deg(-5)), y: 500 * Math.sin(deg(-5)) },
    yVec: { x: 360 * Math.sin(deg(-5)), y: -360 * Math.cos(deg(-5)) },
  },
  sheared: { origin: { x: 80, y: 420 }, xVec: { x: 500, y: 12 }, yVec: { x: 45, y: -360 } },
  'non-square pixels': { origin: { x: 80, y: 420 }, xVec: { x: 900, y: 0 }, yVec: { x: 0, y: -150 } },
  'flipped y (y down)': { origin: { x: 80, y: 40 }, xVec: { x: 500, y: 0 }, yVec: { x: 0, y: 360 } },
  'flipped x (x right-to-left)': { origin: { x: 600, y: 420 }, xVec: { x: -500, y: 0 }, yVec: { x: 0, y: -360 } },
  'transposed (x vertical)': { origin: { x: 80, y: 420 }, xVec: { x: 0, y: -360 }, yVec: { x: 500, y: 0 } },
};

// ---------------------------------------------------------------------------------------------

describe('calibrate: synthetic charts', () => {
  for (const [name, geometry] of Object.entries(GEOMETRIES)) {
    it(`recovers values and pixels on a ${name} chart`, () => {
      const chart: SyntheticChart = {
        xScale: 'linear',
        yScale: 'linear',
        xRange: [0, 100],
        yRange: [0, 1],
        ...geometry,
      };
      const cal = mustCalibrate(refsFor(chart, [10, 90], [0.2, 0.9]), 'linear', 'linear');
      const random = rng(1);
      for (let i = 0; i < 200; i++) {
        const x = -20 + 140 * random();
        const y = -0.2 + 1.4 * random();
        const p = truePixel(chart, x, y);
        const v = cal.pixelToValue(p.px, p.py);
        expectValueClose(v.x, x, `x at ${i}`);
        expectValueClose(v.y, y, `y at ${i}`);
        expectPixelClose(cal.valueToPixel(x, y), p, `pixel at ${i}`);
      }
    });
  }

  it('reproduces the affine coefficients of an axis-aligned chart exactly', () => {
    const chart: SyntheticChart = {
      xScale: 'linear',
      yScale: 'linear',
      xRange: [0, 100],
      yRange: [0, 1],
      ...GEOMETRIES['axis-aligned (y up)']!,
    };
    const cal = mustCalibrate(refsFor(chart, [0, 100], [0, 1]), 'linear', 'linear');
    const { a, b, c, d, e, g } = cal.affine;
    expect(a).toBeCloseTo(100 / 500, 14);
    expect(b).toBeCloseTo(0, 14);
    expect(c).toBeCloseTo(-80 * (100 / 500), 12);
    expect(d).toBeCloseTo(0, 14);
    expect(e).toBeCloseTo(-1 / 360, 14);
    expect(g).toBeCloseTo(420 / 360, 12);
  });

  it('uses both pixel coordinates on a rotated chart', () => {
    const chart: SyntheticChart = {
      xScale: 'linear',
      yScale: 'linear',
      xRange: [0, 100],
      yRange: [0, 1],
      ...GEOMETRIES['rotated 5°']!,
    };
    const cal = mustCalibrate(refsFor(chart, [0, 100], [0, 1]), 'linear', 'linear');
    expect(Math.abs(cal.affine.b)).toBeGreaterThan(1e-3);
    expect(Math.abs(cal.affine.d)).toBeGreaterThan(1e-6);
  });

  it('works with X refs placed off the axis line, as long as they share a y value', () => {
    const chart: SyntheticChart = {
      xScale: 'linear',
      yScale: 'linear',
      xRange: [0, 100],
      yRange: [0, 1],
      ...GEOMETRIES.sheared!,
    };
    const refs = refsFor(chart, [10, 90], [0.2, 0.9]);
    refs.X1 = { ...truePixel(chart, 10, 0.5), value: 10 };
    refs.X2 = { ...truePixel(chart, 90, 0.5), value: 90 };
    refs.Y1 = { ...truePixel(chart, 70, 0.2), value: 0.2 };
    refs.Y2 = { ...truePixel(chart, 70, 0.9), value: 0.9 };
    const cal = mustCalibrate(refs, 'linear', 'linear');
    const v = cal.pixelToValue(truePixel(chart, 33, 0.77).px, truePixel(chart, 33, 0.77).py);
    expectValueClose(v.x, 33, 'x');
    expectValueClose(v.y, 0.77, 'y');
  });

  it('accepts numeric strings as ref values', () => {
    const chart: SyntheticChart = {
      xScale: 'linear',
      yScale: 'log10',
      xRange: [0, 100],
      yRange: [1, 1000],
      ...GEOMETRIES['axis-aligned (y up)']!,
    };
    const cal = mustCalibrate(
      refsFor(chart, [10, 90], [1, 1000], (_, v) => ` ${v} `),
      'linear',
      'log10',
    );
    expectValueClose(cal.pixelToValue(80 + 250, 420 - 240).y, 100, 'y');
    expectValueClose(cal.pixelToValue(80 + 250, 420).x, 50, 'x');
  });
});

describe('calibrate: every scale type', () => {
  for (const xScale of SCALE_TYPES) {
    for (const yScale of SCALE_TYPES) {
      it(`round-trips pixel → value → pixel with x ${xScale}, y ${yScale}`, () => {
        const chart: SyntheticChart = {
          xScale,
          yScale,
          xRange: RANGES[xScale],
          yRange: RANGES[yScale],
          ...GEOMETRIES['rotated 5°']!,
        };
        // Date refs go in as text, to exercise the parsing path too.
        const show = (axis: 'x' | 'y', v: number) =>
          (axis === 'x' ? xScale : yScale) === 'date' ? new Date(v).toISOString() : v;
        const cal = mustCalibrate(
          refsFor(chart, innerRefValues(xScale), innerRefValues(yScale), show),
          xScale,
          yScale,
        );
        const random = rng(7);
        for (let i = 0; i < 100; i++) {
          // Pixels anywhere in the chart's plot area.
          const s = random();
          const t = random();
          const p: Pixel = {
            px: chart.origin.x + s * chart.xVec.x + t * chart.yVec.x,
            py: chart.origin.y + s * chart.xVec.y + t * chart.yVec.y,
          };
          const v = cal.pixelToValue(p.px, p.py);
          expect(v.x, `x at ${i}`).not.toBeNull();
          expect(v.y, `y at ${i}`).not.toBeNull();
          expectPixelClose(cal.valueToPixel(v.x!, v.y!), p, `pixel ${i}`, 1e-6);

          // And the value matches ground truth.
          expectValueClose(v.x, sampleValue(xScale, RANGES[xScale], s), `x truth at ${i}`);
          expectValueClose(v.y, sampleValue(yScale, RANGES[yScale], t), `y truth at ${i}`);
        }
      });
    }
  }

  it('gives identical results for log10 and ln', () => {
    const chart: SyntheticChart = {
      xScale: 'log10',
      yScale: 'log10',
      xRange: [0.1, 1e4],
      yRange: [1e-3, 10],
      ...GEOMETRIES.sheared!,
    };
    const refs = refsFor(chart, [1, 1000], [0.01, 1]);
    const cal10 = mustCalibrate(refs, 'log10', 'log10');
    const calLn = mustCalibrate(refs, 'ln', 'ln');
    const calMixed = mustCalibrate(refs, 'log10', 'ln');
    const random = rng(3);
    for (let i = 0; i < 200; i++) {
      const px = -100 + 800 * random();
      const py = -100 + 700 * random();
      const a = cal10.pixelToValue(px, py);
      for (const other of [calLn, calMixed]) {
        const b = other.pixelToValue(px, py);
        expectValueClose(b.x, a.x!, `x at (${px}, ${py})`);
        expectValueClose(b.y, a.y!, `y at (${px}, ${py})`);
      }
      const x = sampleValue('log10', chart.xRange, random());
      const y = sampleValue('log10', chart.yRange, random());
      expectPixelClose(calLn.valueToPixel(x, y), cal10.valueToPixel(x, y)!, `pixel for (${x}, ${y})`);
    }
  });

  it('returns null instead of NaN/Infinity where a scale cannot represent a pixel', () => {
    // Reciprocal x: refs at 1/v = 0.5 and 0.25 (binary-exact), so u is exactly 0 at px 512.
    const refs: CalibrationRefs = {
      X1: { px: 0, py: 400, value: 2 },
      X2: { px: 256, py: 400, value: 4 },
      Y1: { px: 0, py: 400, value: 1 },
      Y2: { px: 0, py: 100, value: 1e300 },
    };
    const cal = mustCalibrate(refs, 'reciprocal', 'log10');
    expect(cal.pixelToValue(512, 400).x).toBeNull();
    expect(cal.pixelToValue(512 - 1e-3, 400).x).toBeGreaterThan(1e4);
    expect(cal.pixelToValue(512 + 1e-3, 400).x).toBeLessThan(-1e4); // past the pole: sign flips
    expect(cal.pixelToValue(0, 0).y).toBeNull(); // 10^400 overflows
    expect(cal.pixelToValue(NaN, 0)).toEqual({ x: null, y: null });
    expect(cal.valueToPixel(0, 10)).toBeNull(); // 1/0
    expect(cal.valueToPixel(2, -1)).toBeNull(); // log of a negative
  });

  it('calibrateSpec matches calibrate', () => {
    const refs: CalibrationRefs = {
      X1: { px: 0, py: 100, value: 0 },
      X2: { px: 100, py: 100, value: 10 },
      Y1: { px: 0, py: 100, value: 0 },
      Y2: { px: 0, py: 0, value: 5 },
    };
    const r = calibrateSpec({ xScale: 'linear', yScale: 'linear', refs });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.calibration.pixelToValue(50, 50)).toEqual({ x: 5, y: 2.5 });
  });
});

// ---------------------------------------------------------------------------------------------

/** True when every number anywhere inside `value` is finite. */
function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (value !== null && typeof value === 'object') return Object.values(value).every(allFinite);
  return true;
}

const GOOD_REFS: CalibrationRefs = {
  X1: { px: 100, py: 400, value: 1 },
  X2: { px: 500, py: 400, value: 100 },
  Y1: { px: 100, py: 400, value: 2 },
  Y2: { px: 100, py: 50, value: 20 },
};

function withRefs(patch: Partial<CalibrationRefs>): CalibrationRefs {
  return { ...GOOD_REFS, ...patch };
}

describe('calibrate: error cases', () => {
  it('accepts the baseline refs on every scale pair', () => {
    for (const xScale of ['linear', 'log10', 'ln', 'reciprocal'] as const) {
      for (const yScale of ['linear', 'log10', 'ln', 'reciprocal'] as const) {
        expect(calibrate(GOOD_REFS, xScale, yScale).ok).toBe(true);
      }
    }
  });

  const cases: Array<{
    name: string;
    refs: CalibrationRefs;
    xScale?: ScaleType;
    yScale?: ScaleType;
    kind: CalibrationErrorKind;
    detail?: Record<string, unknown>;
  }> = [
    {
      name: 'Y refs parallel to the X refs',
      refs: withRefs({ Y1: { px: 100, py: 200, value: 2 }, Y2: { px: 300, py: 200, value: 20 } }),
      kind: 'singular-system',
    },
    {
      name: 'all four refs on one line',
      refs: withRefs({ Y1: { px: 200, py: 400, value: 2 }, Y2: { px: 400, py: 400, value: 20 } }),
      kind: 'singular-system',
    },
    {
      name: 'X refs nearly parallel to Y refs (1e-12 rad)',
      refs: withRefs({ Y1: { px: 100, py: 400, value: 2 }, Y2: { px: 500, py: 400 - 4e-10, value: 20 } }),
      kind: 'singular-system',
    },
    {
      name: 'X1 and X2 on the same pixel',
      refs: withRefs({ X2: { px: 100, py: 400, value: 100 } }),
      kind: 'coincident-points',
      detail: { refs: ['X1', 'X2'] },
    },
    {
      name: 'Y1 and Y2 on the same pixel',
      refs: withRefs({ Y2: { px: 100, py: 400, value: 20 } }),
      kind: 'coincident-points',
      detail: { refs: ['Y1', 'Y2'] },
    },
    {
      name: 'equal X values',
      refs: withRefs({ X2: { px: 500, py: 400, value: 1 } }),
      kind: 'equal-values',
      detail: { axis: 'x' },
    },
    {
      name: 'equal Y values given as number and string',
      refs: withRefs({ Y2: { px: 100, py: 50, value: '2.0' } }),
      kind: 'equal-values',
      detail: { axis: 'y' },
    },
    {
      name: 'equal date values written differently',
      refs: withRefs({
        X1: { px: 100, py: 400, value: '2024-01-01' },
        X2: { px: 500, py: 400, value: '2024-01-01T00:00Z' },
      }),
      xScale: 'date',
      kind: 'equal-values',
      detail: { axis: 'x' },
    },
    {
      name: 'log10 of 0',
      refs: withRefs({ X1: { px: 100, py: 400, value: 0 } }),
      xScale: 'log10',
      kind: 'out-of-domain',
      detail: { ref: 'X1', scale: 'log10' },
    },
    {
      name: 'log10 of a negative',
      refs: withRefs({ Y2: { px: 100, py: 50, value: -5 } }),
      yScale: 'log10',
      kind: 'out-of-domain',
      detail: { ref: 'Y2', scale: 'log10' },
    },
    {
      name: 'ln of 0',
      refs: withRefs({ Y1: { px: 100, py: 400, value: '0' } }),
      yScale: 'ln',
      kind: 'out-of-domain',
      detail: { ref: 'Y1', scale: 'ln' },
    },
    {
      name: 'reciprocal of 0',
      refs: withRefs({ X2: { px: 500, py: 400, value: 0 } }),
      xScale: 'reciprocal',
      kind: 'out-of-domain',
      detail: { ref: 'X2', scale: 'reciprocal' },
    },
    {
      name: 'date beyond the representable range',
      refs: withRefs({ X2: { px: 500, py: 400, value: 9e15 } }),
      xScale: 'date',
      kind: 'out-of-domain',
      detail: { ref: 'X2', scale: 'date' },
    },
    {
      name: 'reciprocal refs straddling 0',
      refs: withRefs({ Y1: { px: 100, py: 400, value: -2 } }),
      yScale: 'reciprocal',
      kind: 'reciprocal-straddles-zero',
      detail: { axis: 'y' },
    },
    {
      name: 'non-numeric text on a linear axis',
      refs: withRefs({ X1: { px: 100, py: 400, value: 'abc' } }),
      kind: 'invalid-value',
      detail: { ref: 'X1' },
    },
    {
      name: 'empty text',
      refs: withRefs({ Y2: { px: 100, py: 50, value: '  ' } }),
      kind: 'invalid-value',
      detail: { ref: 'Y2' },
    },
    {
      name: 'NaN value',
      refs: withRefs({ X2: { px: 500, py: 400, value: NaN } }),
      kind: 'invalid-value',
      detail: { ref: 'X2' },
    },
    {
      name: 'infinite value',
      refs: withRefs({ Y1: { px: 100, py: 400, value: -Infinity } }),
      kind: 'invalid-value',
      detail: { ref: 'Y1' },
    },
    {
      name: 'non-existent date (2023-02-29)',
      refs: withRefs({ X1: { px: 100, py: 400, value: '2023-02-29' } }),
      xScale: 'date',
      kind: 'invalid-value',
      detail: { ref: 'X1' },
    },
    {
      name: 'ambiguous date',
      refs: withRefs({ X2: { px: 500, py: 400, value: '03/04/2024' } }),
      xScale: 'date',
      kind: 'invalid-value',
      detail: { ref: 'X2' },
    },
    {
      name: 'NaN pixel',
      refs: withRefs({ Y2: { px: NaN, py: 50, value: 20 } }),
      kind: 'invalid-pixel',
      detail: { ref: 'Y2' },
    },
    {
      name: 'infinite pixel',
      refs: withRefs({ X1: { px: 100, py: Infinity, value: 1 } }),
      kind: 'invalid-pixel',
      detail: { ref: 'X1' },
    },
    {
      name: 'values too extreme for float64',
      refs: withRefs({
        X1: { px: 100, py: 400, value: -1e308 },
        X2: { px: 500, py: 400, value: 1e308 },
      }),
      kind: 'numeric-overflow',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.kind}`, () => {
      const r = calibrate(c.refs, c.xScale ?? 'linear', c.yScale ?? 'linear');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe(c.kind);
      if (c.detail) expect(r.error).toMatchObject(c.detail);
      expect(r.error.message.length).toBeGreaterThan(10);
      expect(r).not.toHaveProperty('calibration');
      expect(allFinite(r)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe('calibrate: date axes', () => {
  const HOUR = 3600_000;

  function dateCal(x1: string, x2: string, px1 = 100, px2 = 400): Calibration {
    return mustCalibrate(
      {
        X1: { px: px1, py: 300, value: x1 },
        X2: { px: px2, py: 300, value: x2 },
        Y1: { px: 100, py: 300, value: 0 },
        Y2: { px: 100, py: 0, value: 10 },
      },
      'date',
      'linear',
    );
  }

  it('spans a US DST change as exact 24 h days (UTC, independent of host zone)', () => {
    // US DST began 2024-03-10 02:00 local; the test host runs in America/New_York.
    const cal = dateCal('2024-03-09 00:00', '2024-03-12 00:00'); // 3 days over 300 px
    expect(cal.refValues.X2 - cal.refValues.X1).toBe(72 * HOUR);
    expect(formatDateTime(cal.pixelToValue(200, 300).x!)).toBe('2024-03-10 00:00');
    expect(formatDateTime(cal.pixelToValue(212.5, 300).x!)).toBe('2024-03-10 03:00');
    expect(formatDateTime(cal.pixelToValue(300, 300).x!)).toBe('2024-03-11 00:00');
    expectPixelClose(cal.valueToPixel(parseMs('2024-03-10 02:30'), 0), { px: 210.416666667, py: 300 }, 'pixel', 1e-6);
  });

  it('honours explicit zone offsets across a DST change (a 47 h span)', () => {
    // Noon EST on Mar 9 to noon EDT on Mar 11: 47 real hours.
    const cal = dateCal('2024-03-09 12:00-05:00', '2024-03-11 12:00-04:00', 0, 470);
    expect(cal.refValues.X2 - cal.refValues.X1).toBe(47 * HOUR);
    // 10 px per hour; px 100 is 10 h after 17:00Z.
    expect(formatDateTime(cal.pixelToValue(100, 300).x!, 'YYYY-MM-DD HH:mm[Z]')).toBe('2024-03-10 03:00Z');
  });

  it('spans a European DST change (autumn) as exact days', () => {
    const cal = dateCal('2024-10-26', '2024-10-28', 0, 480);
    expect(cal.refValues.X2 - cal.refValues.X1).toBe(48 * HOUR);
    expect(formatDateTime(cal.pixelToValue(240, 300).x!)).toBe('2024-10-27 00:00');
  });

  it('includes 29 February in a leap year', () => {
    const cal = dateCal('2024-02-28', '2024-03-01', 100, 300);
    expect(cal.refValues.X2 - cal.refValues.X1).toBe(48 * HOUR);
    expect(formatDateTime(cal.pixelToValue(200, 300).x!, 'YYYY-MM-DD')).toBe('2024-02-29');
    expect(formatDateTime(cal.pixelToValue(250, 300).x!)).toBe('2024-02-29 12:00');
    expectPixelClose(cal.valueToPixel(parseMs('2024-02-29'), 0), { px: 200, py: 300 }, 'pixel');
  });

  it('has no 29 February in a non-leap year', () => {
    const cal = dateCal('2023-02-28', '2023-03-01', 100, 300);
    expect(cal.refValues.X2 - cal.refValues.X1).toBe(24 * HOUR);
    expect(formatDateTime(cal.pixelToValue(200, 300).x!)).toBe('2023-02-28 12:00');
  });

  it('spans multiple years including a leap day', () => {
    const cal = dateCal('2023-01-01', '2025-01-01', 0, 731); // 365 + 366 days, 1 px per day
    expect(formatDateTime(cal.pixelToValue(365 + 59, 300).x!, 'YYYY-MM-DD')).toBe('2024-02-29');
    expect(formatDateTime(cal.pixelToValue(365 + 60, 300).x!, 'YYYY-MM-DD')).toBe('2024-03-01');
  });

  it('accepts epoch milliseconds as numeric date values', () => {
    const cal = mustCalibrate(
      {
        X1: { px: 0, py: 0, value: Date.UTC(2024, 0, 1) },
        X2: { px: 100, py: 0, value: '2024-01-11' },
        Y1: { px: 0, py: 0, value: 0 },
        Y2: { px: 0, py: -100, value: 1 },
      },
      'date',
      'linear',
    );
    expect(formatDateTime(cal.pixelToValue(50, 0).x!, 'YYYY-MM-DD')).toBe('2024-01-06');
  });
});

function parseMs(text: string): number {
  const r = parseDateTime(text);
  if (!r.ok) throw new Error(r.message);
  return r.ms;
}
