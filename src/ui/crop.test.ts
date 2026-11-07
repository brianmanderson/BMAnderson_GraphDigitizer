/** Crop geometry (src/ui/crop.ts): whole-pixel rectangles from drags and from the panel's fields. */

import { describe, expect, it } from 'vitest';
import { MIN_CROP, clampCrop, cropFromDrag, cropHeight, cropWidth, fullCrop, setCropField } from './crop.ts';

describe('clampCrop', () => {
  it('rounds to whole pixels and keeps the rectangle inside the image', () => {
    expect(clampCrop({ x0: 9.6, y0: -3, x1: 20.2, y1: 500 }, 640, 480)).toEqual({ x0: 10, y0: 0, x1: 20, y1: 480 });
    expect(clampCrop(fullCrop(640, 480), 640, 480)).toEqual({ x0: 0, y0: 0, x1: 640, y1: 480 });
  });

  it('enforces the minimum size, growing right/down or pulling back from the far edge', () => {
    expect(clampCrop({ x0: 10, y0: 10, x1: 10, y1: 11 }, 640, 480)).toEqual({ x0: 10, y0: 10, x1: 10 + MIN_CROP, y1: 10 + MIN_CROP });
    expect(clampCrop({ x0: 640, y0: 479, x1: 640, y1: 480 }, 640, 480)).toEqual({ x0: 638, y0: 478, x1: 640, y1: 480 });
    expect(clampCrop({ x0: 700, y0: 0, x1: 900, y1: 10 }, 640, 480)).toEqual({ x0: 638, y0: 0, x1: 640, y1: 10 });
  });

  it('refuses images too small to crop and non-finite input', () => {
    expect(clampCrop(fullCrop(1, 10), 1, 10)).toBeNull();
    expect(clampCrop({ x0: NaN, y0: 0, x1: 5, y1: 5 }, 10, 10)).toBeNull();
  });
});

describe('cropFromDrag', () => {
  it('covers every pixel the drag touched, in either direction', () => {
    // From inside pixel 100 to inside pixel 300: columns 100…300 (edges at 99.5 and 300.5).
    expect(cropFromDrag({ px: 100.3, py: 50 }, { px: 299.8, py: 250.2 }, 640, 480)).toEqual({ x0: 100, y0: 50, x1: 301, y1: 251 });
    expect(cropFromDrag({ px: 299.8, py: 250.2 }, { px: 100.3, py: 50 }, 640, 480)).toEqual({ x0: 100, y0: 50, x1: 301, y1: 251 });
  });

  it('is clamped to the image and never smaller than the minimum', () => {
    expect(cropFromDrag({ px: -40, py: -40 }, { px: 10, py: 10 }, 640, 480)).toEqual({ x0: 0, y0: 0, x1: 11, y1: 11 });
    expect(cropFromDrag({ px: 5, py: 5 }, { px: 5.2, py: 5.1 }, 640, 480)).toEqual({ x0: 5, y0: 5, x1: 5 + MIN_CROP, y1: 5 + MIN_CROP });
    expect(cropFromDrag({ px: 639.4, py: 479.4 }, { px: 700, py: 700 }, 640, 480)).toEqual({ x0: 638, y0: 478, x1: 640, y1: 480 });
  });
});

describe('setCropField', () => {
  const r = { x0: 100, y0: 50, x1: 300, y1: 250 };

  it('moves the rectangle with Left/Top, keeping its size while the image allows', () => {
    const left = setCropField(r, 'left', 200, 640, 480);
    expect(left).toEqual({ x0: 200, y0: 50, x1: 400, y1: 250 });
    // Pushed past the edge: it stops at the edge and shrinks.
    expect(setCropField(r, 'left', 500, 640, 480)).toEqual({ x0: 500, y0: 50, x1: 640, y1: 250 });
    expect(setCropField(r, 'top', -20, 640, 480)).toEqual({ x0: 100, y0: 0, x1: 300, y1: 200 });
    expect(setCropField(r, 'left', 639, 640, 480).x0).toBe(640 - MIN_CROP);
  });

  it('resizes from the top-left with Width/Height, within the image and the minimum', () => {
    const w = setCropField(r, 'width', 50, 640, 480);
    expect([cropWidth(w), cropHeight(w)]).toEqual([50, 200]);
    expect(setCropField(r, 'width', 1000, 640, 480).x1).toBe(640);
    expect(cropWidth(setCropField(r, 'width', 0, 640, 480))).toBe(MIN_CROP);
    expect(setCropField(r, 'height', 70.4, 640, 480).y1).toBe(120);
  });

  it('ignores non-finite values', () => {
    expect(setCropField(r, 'width', NaN, 640, 480)).toBe(r);
  });
});
