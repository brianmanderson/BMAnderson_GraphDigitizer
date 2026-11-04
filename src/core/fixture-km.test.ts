/**
 * Real-world check: calibrate from the labelled ticks of a journal Kaplan–Meier figure
 * (fixtures/real/km-pericardial-effusion.*) and predict the other ticks and a known value.
 */

import { describe, expect, it } from 'vitest';
import truth from '../../fixtures/real/km-pericardial-effusion.json';
import { calibrate } from './calibrate.ts';

const xTicks = truth.xAxis.ticks;
const yTicks = truth.yAxis.ticks;
const row = truth.xAxis.axisLineRow; // 344.5
const col = truth.yAxis.axisLineCol; // 134

function tick<T extends { value: number }>(ticks: T[], value: number): T {
  const t = ticks.find((k) => k.value === value);
  if (!t) throw new Error(`fixture has no tick at ${value}`);
  return t;
}

describe('fixture: km-pericardial-effusion', () => {
  const result = calibrate(
    {
      X1: { px: tick(xTicks, 0).px, py: row, value: 0 },
      X2: { px: tick(xTicks, 120).px, py: row, value: 120 },
      Y1: { px: col, py: tick(yTicks, 0).py, value: 0 },
      Y2: { px: col, py: tick(yTicks, 1).py, value: 1 },
    },
    'linear',
    'linear',
  );
  if (!result.ok) throw new Error(result.error.message);
  const cal = result.calibration;

  const xRange = 120;
  const yRange = 1;

  it('predicts every other labelled x tick within 1% of the axis range', () => {
    for (const t of xTicks.filter((k) => k.value !== 0 && k.value !== 120)) {
      const x = cal.pixelToValue(t.px, row).x!;
      expect(Math.abs(x - t.value), `x tick ${t.value} → ${x}`).toBeLessThanOrEqual(0.01 * xRange);
    }
  });

  it('predicts every other labelled y tick within 1% of the axis range', () => {
    for (const t of yTicks.filter((k) => k.value !== 0 && k.value !== 1)) {
      const y = cal.pixelToValue(col, t.py).y!;
      expect(Math.abs(y - t.value), `y tick ${t.value} → ${y}`).toBeLessThanOrEqual(0.01 * yRange);
    }
  });

  it('reads the final plateau (row 295) as the annotated 16.2%', () => {
    const plateau = truth.knownValues[0]!;
    if (plateau.py === undefined) throw new Error('fixture plateau has no pixel row');
    expect(plateau.py).toBe(295);
    const y = cal.pixelToValue(400, plateau.py).y!;
    // Labels are ±1 px (≈0.0033 here); allow half a percent of the axis range.
    expect(Math.abs(y - plateau.y)).toBeLessThanOrEqual(0.005 * yRange);
  });

  it('maps the origin back to the axis-line intersection', () => {
    const p = cal.valueToPixel(0, 0)!;
    expect(p.px).toBeCloseTo(col, 9);
    expect(p.py).toBeCloseTo(row, 9);
  });
});
