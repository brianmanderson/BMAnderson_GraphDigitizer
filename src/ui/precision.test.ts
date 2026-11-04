/** Keyboard nudging and loupe geometry. */

import { describe, expect, it } from 'vitest';
import { LOUPE_MARGIN, LOUPE_SIZE, loupeCell, loupeCorner, loupeOrigin } from './loupe.ts';
import { nudgeDirection, nudgeStep, nudged } from './nudge.ts';

describe('nudging', () => {
  it('moves 1 px, Shift 10 px, Alt 0.1 px in the arrow direction (y down)', () => {
    expect(nudgeStep({ shiftKey: false, altKey: false })).toBe(1);
    expect(nudgeStep({ shiftKey: true, altKey: false })).toBe(10);
    expect(nudgeStep({ shiftKey: false, altKey: true })).toBe(0.1);
    expect(nudgeStep({ shiftKey: true, altKey: true })).toBe(0.1);
    expect(nudgeDirection('ArrowUp')).toEqual([0, -1]);
    expect(nudgeDirection('ArrowDown')).toEqual([0, 1]);
    expect(nudgeDirection('ArrowLeft')).toEqual([-1, 0]);
    expect(nudgeDirection('ArrowRight')).toEqual([1, 0]);
    expect(nudgeDirection('a')).toBeNull();
  });

  it('ten 0.1 px nudges land exactly 1 px away', () => {
    let p = { px: 400.3, py: 295 };
    for (let i = 0; i < 10; i++) p = nudged(p, [1, 0], 0.1, 709, 424);
    expect(p).toEqual({ px: 401.3, py: 295 });
  });

  it('keeps the marker on the image', () => {
    expect(nudged({ px: 2, py: 3 }, [-1, 0], 10, 100, 50)).toEqual({ px: -0.5, py: 3 });
    expect(nudged({ px: 2, py: 45 }, [0, 1], 10, 100, 50)).toEqual({ px: 2, py: 49.5 });
  });
});

describe('loupe geometry', () => {
  it('sits top-left, and flips to the top-right corner when it would cover the cursor', () => {
    expect(loupeCorner({ x: 600, y: 400 }, 1000)).toBe('top-left');
    expect(loupeCorner({ x: 100, y: 100 }, 1000)).toBe('top-right');
    const edge = LOUPE_MARGIN + LOUPE_SIZE;
    expect(loupeCorner({ x: edge + 10, y: 50 }, 1000)).toBe('top-right'); // inside the clearance
    expect(loupeCorner({ x: edge + 40, y: 50 }, 1000)).toBe('top-left');
    expect(loupeCorner({ x: 50, y: edge + 40 }, 1000)).toBe('top-left');
    // Too narrow for two loupes side by side: stay put rather than jump onto the cursor.
    expect(loupeCorner({ x: 100, y: 100 }, 300)).toBe('top-left');
  });

  it('magnifies relative to the main view in whole device pixels per image pixel', () => {
    expect(loupeCell(1, 6, 1)).toBe(6);
    expect(loupeCell(1.374, 6, 1)).toBe(8);
    expect(loupeCell(1.374, 6, 2)).toBe(16);
    expect(loupeCell(1.374, 6, 1.25)).toBe(10);
    expect(loupeCell(0.1, 2, 1)).toBe(1); // never below one device pixel
    // Never so far that fewer than 5 image pixels show across the loupe.
    expect(loupeCell(20, 16, 1)).toBe(Math.floor(LOUPE_SIZE / 5));
    expect(loupeCell(20, 16, 2)).toBe(Math.floor((2 * LOUPE_SIZE) / 5));
  });

  it('puts the centre point at the loupe centre with pixel edges on device pixels', () => {
    for (const [c, cell, size] of [
      [400, 8, 180],
      [400.37, 8, 180],
      [12.5, 13, 360],
      [0, 6, 225],
    ] as const) {
      const o = loupeOrigin(c, cell, size);
      expect(Number.isInteger(o)).toBe(true);
      // Image coordinate c (pixel centres at integers) lands within half a device pixel of the centre.
      expect(Math.abs(o + (c + 0.5) * cell - size / 2)).toBeLessThanOrEqual(0.5);
    }
  });
});
