import { describe, expect, it } from 'vitest';
import { forward, inverse, isInDomain, isScaleType, MAX_EPOCH_MS, SCALE_TYPES } from './scales.ts';

describe('scale transforms', () => {
  it('forward matches the SPEC table', () => {
    expect(forward('linear', -3.5)).toBe(-3.5);
    expect(forward('log10', 1000)).toBeCloseTo(3, 15);
    expect(forward('ln', Math.E ** 2)).toBeCloseTo(2, 15);
    expect(forward('reciprocal', 4)).toBe(0.25);
    expect(forward('date', 1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('inverse undoes forward for in-domain values of every scale', () => {
    const samples: Record<(typeof SCALE_TYPES)[number], number[]> = {
      linear: [-1e6, -1, 0, 0.5, 42, 1e9],
      log10: [1e-12, 0.01, 1, 7.5, 1e12],
      ln: [1e-12, 0.3, 1, Math.E, 1e12],
      reciprocal: [-1e6, -0.01, 1e-6, 2, 1e6],
      date: [-MAX_EPOCH_MS, 0, 951_782_400_000, MAX_EPOCH_MS],
    };
    for (const scale of SCALE_TYPES) {
      for (const v of samples[scale]) {
        const u = forward(scale, v);
        expect(u, `${scale} forward(${v})`).not.toBeNull();
        const back = inverse(scale, u!);
        expect(back, `${scale} inverse(forward(${v}))`).not.toBeNull();
        expect(Math.abs(back! - v)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(v)));
      }
    }
  });

  it('enforces domain rules and never returns NaN or Infinity', () => {
    expect(forward('log10', 0)).toBeNull();
    expect(forward('log10', -1)).toBeNull();
    expect(forward('ln', 0)).toBeNull();
    expect(forward('reciprocal', 0)).toBeNull();
    expect(forward('date', MAX_EPOCH_MS + 1)).toBeNull();
    for (const scale of SCALE_TYPES) {
      expect(forward(scale, NaN)).toBeNull();
      expect(forward(scale, Infinity)).toBeNull();
      expect(inverse(scale, NaN)).toBeNull();
      expect(inverse(scale, -Infinity)).toBeNull();
    }
    expect(inverse('reciprocal', 0)).toBeNull();
    expect(inverse('log10', 400)).toBeNull(); // overflows to Infinity
    expect(inverse('log10', -400)).toBeNull(); // underflows to 0, outside v > 0
    expect(inverse('ln', 1000)).toBeNull();
    expect(inverse('date', MAX_EPOCH_MS * 2)).toBeNull();
  });

  it('isInDomain and isScaleType', () => {
    expect(isInDomain('linear', 0)).toBe(true);
    expect(isInDomain('log10', 1e-300)).toBe(true);
    expect(isInDomain('reciprocal', -2)).toBe(true);
    expect(isScaleType('log10')).toBe(true);
    expect(isScaleType('log2')).toBe(false);
    expect(isScaleType(3)).toBe(false);
  });
});
