/**
 * Scale inference, ref choice, the consensus fit and the cross-check, on crafted readings (what
 * the OCR "read" at known positions). OCR itself is measured by `npm run bench:axes`.
 */

import { describe, expect, it } from 'vitest';
import type { AxisLabels, FoundLabel } from './labels.ts';
import { crossCheck, suggestAxis, type AxisReading, type AxisSuggestion, type OcrLabel } from './suggest.ts';

const blank = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

/** Labels at the given positions along a horizontal X axis at y = 400 (or a Y axis at x = 100). */
function reading(axis: 'x' | 'y', at: number[], texts: (string | OcrLabel)[], extra: Partial<AxisReading> = {}): AxisReading {
  const point = (a: number) => (axis === 'x' ? { x: a, y: 400 } : { x: 100, y: a });
  const labels: FoundLabel[] = at.map((a, i) => ({
    along: a,
    point: point(a),
    tick: i,
    crop: blank,
    base: null,
    exponent: null,
    minus: false,
    exponentMinus: false,
    singleChar: false,
    exponentSingleChar: false,
    marks: { start: 0, end: 0, points: [] },
    box: { center: point(a), width: 10, height: 10 },
  }));
  const axisLabels: AxisLabels = { axis, mode: 'ticks', labels, note: null };
  return {
    labels: axisLabels,
    numeric: texts.map((t) => (typeof t === 'string' ? { text: t, confidence: 0.95 } : t)),
    text: null,
    logHint: false,
    line: axis === 'x' ? { p1: { x: 50, y: 400 }, p2: { x: 650, y: 400 } } : { p1: { x: 100, y: 20 }, p2: { x: 100, y: 400 } },
    tickPoints: at.map(point),
    note: null,
    ...extra,
  };
}

const xs = [100, 200, 300, 400, 500, 600];

describe('suggestAxis', () => {
  it('suggests a linear scale with the outermost labels as refs', () => {
    const s = suggestAxis(reading('x', xs, ['0', '20', '40', '60', '80', '100']));
    expect(s).toMatchObject({ status: 'calibrated', level: 'high', scale: 'linear', scaleCertain: true });
    expect(s.refs).toEqual([
      { px: 100, py: 400, value: '0' },
      { px: 600, py: 400, value: '100' },
    ]);
    expect(s.maxResidualPx).toBeCloseTo(0, 9);
    expect(s.labels.every((l) => l.inlier)).toBe(true);
  });

  it('treats one misread label as an outlier and still suggests', () => {
    const s = suggestAxis(reading('x', xs, ['0', '20', '46', '60', '80', '100']));
    expect(s.status).toBe('calibrated');
    expect(s.level).toBe('high');
    expect(s.labels.filter((l) => !l.inlier).map((l) => l.text)).toEqual(['46']);
  });

  it('prefers confident labels as refs', () => {
    const texts: OcrLabel[] = ['0', '20', '40', '60', '80', '100'].map((t, i) => ({ text: t, confidence: i === 5 ? 0.4 : 0.95 }));
    const s = suggestAxis(reading('x', xs, texts));
    expect(s.refs?.map((r) => r.value)).toEqual(['0', '80']);
  });

  it('infers log10 from powers of ten evenly spaced in pixels', () => {
    const s = suggestAxis(reading('x', [100, 300, 500, 700], ['10^-1', '10^0', '10^1', '10^2']));
    expect(s).toMatchObject({ status: 'calibrated', scale: 'log10', scaleCertain: true });
    expect(s.refs?.map((r) => r.value)).toEqual(['0.1', '100']);
  });

  it('infers log10 from plain numbers too', () => {
    expect(suggestAxis(reading('x', [100, 300, 500], ['1', '10', '100'])).scale).toBe('log10');
  });

  it('infers an unread exponent from its position, but never between decades', () => {
    const ok = suggestAxis(reading('x', [100, 300, 500, 700], ['10^-1', '10^', '10^1', '10^2']));
    expect(ok).toMatchObject({ status: 'calibrated', scale: 'log10', level: 'high' });
    expect(ok.labels[1]?.value).toBe(1);
    expect(ok.message).toMatch(/1 unread exponent inferred/);
    const off = suggestAxis(reading('x', [100, 250, 500, 700], ['10^-1', '10^', '10^1', '10^2']));
    expect(off.labels[1]?.value).toBeNull();
  });

  it('reads integer years as a date axis', () => {
    const s = suggestAxis(reading('x', xs, ['2016', '2017', '2018', '2019', '2020', '2021']));
    expect(s.scale).toBe('date');
    expect(s.refs?.map((r) => r.value)).toEqual(['2016-01-01', '2021-01-01']);
    // Real dates: the leap year 2016 is a day longer, so 2017 is not exactly 1/5 of the way.
    expect(s.status).toBe('calibrated');
  });

  it('dates month labels from a year label (read as text)', () => {
    const at = [100, 200, 300, 400, 500];
    const r = reading('x', at, ['0', '', '', '2023', ''], {
      text: ['Oct', 'Nov', 'Dec', '2023', 'Feb'].map((t) => ({ text: t, confidence: 0.9 })),
    });
    // Positions proportional to the real dates, as on a matplotlib date axis.
    const ms = [Date.UTC(2022, 9, 1), Date.UTC(2022, 10, 1), Date.UTC(2022, 11, 1), Date.UTC(2023, 0, 1), Date.UTC(2023, 1, 1)];
    const along = ms.map((m) => 100 + ((m - (ms[0] as number)) / 86_400_000) * 3);
    r.labels.labels.forEach((l, i) => {
      l.along = along[i] as number;
      l.point = { x: along[i] as number, y: 400 };
    });
    const s = suggestAxis(r);
    expect(s).toMatchObject({ status: 'calibrated', scale: 'date' });
    expect(s.refs?.map((q) => q.value)).toEqual(['2022-10-01', '2023-02-01']);
  });

  it('declines a date axis whose labels are day numbers without a year', () => {
    const r = reading('x', xs, ['', '03', '05', '07', '09', '11'], {
      text: ['Sep', '03', '05', '07', '09', '11'].map((t) => ({ text: t, confidence: 0.9 })),
    });
    const s = suggestAxis(r);
    expect(s.status).toBe('positions');
    expect(s.message).toMatch(/no year/);
    expect(s.refs?.map((q) => q.value)).toEqual(['', '']);
  });

  it('applies an offset note, and declines when a note cannot be read', () => {
    const texts = ['0.00', '0.01', '0.02', '0.03', '0.04', '0.05'];
    const applied = suggestAxis(reading('x', xs, texts, { note: { text: '+1e4', confidence: 0.9 } }));
    expect(applied.refs?.map((r) => r.value)).toEqual(['10000', '10000.05']);
    const unread = suggestAxis(reading('x', xs, texts, { note: { text: '+e4', confidence: 0 } }));
    expect(unread.status).toBe('positions');
    expect(unread.message).toMatch(/offset or multiplier/);
  });

  it('falls back to the tick positions when labels disagree or are too few', () => {
    const few = suggestAxis(reading('x', xs, ['0', '', '', '', '', '100']));
    expect(few).toMatchObject({ status: 'positions', level: 'low' });
    expect(few.refs).toEqual([
      { px: 100, py: 400, value: '' },
      { px: 600, py: 400, value: '' },
    ]);
    const lost = suggestAxis(reading('x', xs, ['0', '08', '04', '06', '08', '10']));
    expect(lost.status).toBe('positions');
  });

  it('says so when there is no axis', () => {
    const s = suggestAxis(reading('x', [], [], { line: null, tickPoints: [] }));
    expect(s).toMatchObject({ status: 'none', refs: null });
  });

  it('reports a Y axis with values increasing upwards', () => {
    const s = suggestAxis(reading('y', [50, 120, 190, 260, 330, 400], ['1.0', '0.8', '0.6', '0.4', '0.2', '0.0']));
    expect(s).toMatchObject({ status: 'calibrated', scale: 'linear' });
    expect(s.refs?.map((r) => [r.py, r.value])).toEqual([
      [50, '1'],
      [400, '0'],
    ]);
  });
});

describe('crossCheck', () => {
  const x = () => suggestAxis(reading('x', xs, ['0', '20', '40', '60', '80', '100']));
  const y = () => suggestAxis(reading('y', [50, 120, 190, 260, 330, 400], ['1.0', '0.8', '0.6', '0.4', '0.2', '0.0']));

  it('accepts refs that reproduce every agreeing label in 2-D', () => {
    const r = crossCheck(x(), y());
    expect(r.ok).toBe(true);
    for (const l of [...r.x.labels, ...r.y.labels]) expect(l.residualPx).toBeLessThan(1e-6);
  });

  it('downgrades both axes when the refs do not make a calibration', () => {
    // Y "axis" along the X axis: parallel refs, a singular system.
    const bad: AxisSuggestion = { ...y(), refs: [{ px: 100, py: 400, value: '0' }, { px: 600, py: 400, value: '1' }] };
    const r = crossCheck(x(), bad);
    expect(r.ok).toBe(false);
    expect(r.x).toMatchObject({ status: 'positions', level: 'low' });
    expect(r.y.message).toMatch(/do not make a calibration/);
  });

  it('does nothing unless both axes are calibrated', () => {
    const few = suggestAxis(reading('x', xs, ['0', '', '', '', '', '100']));
    const r = crossCheck(few, y());
    expect(r.ok).toBe(false);
    expect(r.y.status).toBe('calibrated');
  });
});

describe('suggestAxis on labels written against the axis, and labels-only fallbacks', () => {
  it('never uses the reading of a label that may be cut off ("80" read as "8")', () => {
    const r = reading('y', [100, 200, 300, 400], ['8', '6', '4', '2']);
    const clipped = { ...r, labels: { ...r.labels, mode: 'labels-only' as const, labels: r.labels.labels.map((l) => ({ ...l, clipped: true })) } };
    // The same readings unclipped would agree on a (wrong, ×0.1) linear scale.
    expect(suggestAxis(r).status).toBe('calibrated');
    const s = suggestAxis({ ...clipped, tickPoints: [] });
    expect(s.status).not.toBe('calibrated');
    expect(s.message).toMatch(/4 touch the axis line/);
    expect(s.labels.map((l) => l.text)).toEqual(['8', '6', '4', '2']);
  });

  it('suggests labelled gridlines as positions when a labels-only axis cannot be read', () => {
    const r = reading('x', xs, ['', '?', '', '', '', '']);
    const s = suggestAxis({
      ...r,
      labels: { ...r.labels, mode: 'labels-only' },
      tickPoints: [{ x: 200, y: 400 }, { x: 400, y: 400 }],
      positionsFrom: 'gridlines',
    });
    expect(s.status).toBe('positions');
    expect(s.refs?.map((q) => q.px)).toEqual([200, 400]);
    expect(s.message).toMatch(/labelled gridlines/);
  });

  it('says when the labels look hand-lettered', () => {
    const r = reading('x', xs, ['', '', '', '', '', '']);
    const s = suggestAxis({ ...r, labels: { ...r.labels, labels: r.labels.labels.map((l) => ({ ...l, slanted: true })) } });
    expect(s.message).toMatch(/hand-lettered or italic/);
  });
});
