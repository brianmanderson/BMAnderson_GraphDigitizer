/** Snap-to-marker centroid logic, on synthetic anti-aliased images with known geometry. */

import { describe, expect, it } from 'vitest';
import { findSnapTarget, snapOptions, type Pixels } from './snap.ts';

type RGB = readonly [number, number, number];
const WHITE: RGB = [255, 255, 255];
const PINK: RGB = [214, 51, 108];
const BLUE: RGB = [28, 95, 168];
const BLACK: RGB = [20, 20, 20];

/** A blank RGBA image; `paint` blends shapes in by supersampled coverage (8 × 8 per pixel). */
function canvas(width: number, height: number, bg: RGB = WHITE) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < width * height; k++) data.set([...bg, 255], k * 4);
  const pix: Pixels = { width, height, data };
  const paint = (inside: (x: number, y: number) => boolean, color: RGB) => {
    const n = 8;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        let hits = 0;
        // Pixel (i, j) covers [i − ½, i + ½) × [j − ½, j + ½) (integer = pixel centre).
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (inside(i - 0.5 + (a + 0.5) / n, j - 0.5 + (b + 0.5) / n)) hits++;
        if (hits === 0) continue;
        const c = hits / (n * n);
        const k = (j * width + i) * 4;
        for (let ch = 0; ch < 3; ch++) data[k + ch] = Math.round(data[k + ch]! * (1 - c) + color[ch]! * c);
      }
    }
  };
  return { pix, paint };
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ring = (cx: number, cy: number, r: number, w: number) => (x: number, y: number) =>
  Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2;
/** A thick segment from (x0, y0) to (x1, y1). */
function segment(x0: number, y0: number, x1: number, y1: number, w: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  return (x: number, y: number) => {
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
    return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= w / 2;
  };
}

const OPTS = { searchRadius: 8, maxSize: 24 };

describe('findSnapTarget', () => {
  it('finds the sub-pixel centre of an anti-aliased filled marker', () => {
    const { pix, paint } = canvas(60, 50);
    paint(disc(23.3, 17.6, 4), PINK);
    const t = findSnapTarget(pix, 26, 15, OPTS);
    expect(t).not.toBeNull();
    expect(t!.px).toBeCloseTo(23.3, 1);
    expect(t!.py).toBeCloseTo(17.6, 1);
    expect(Math.hypot(t!.px - 23.3, t!.py - 17.6)).toBeLessThan(0.05);
    expect(t!.width).toBeLessThanOrEqual(9);
  });

  it('finds the centre of a hollow marker from a click inside it', () => {
    const { pix, paint } = canvas(60, 60);
    paint(ring(30.5, 28.25, 6, 1.5), BLACK);
    const t = findSnapTarget(pix, 30, 28, OPTS)!;
    expect(Math.hypot(t.px - 30.5, t.py - 28.25)).toBeLessThan(0.05);
  });

  it('separates a marker from a connecting line of another colour', () => {
    // Like fixtures/synthetic: a 1.5 px blue polyline through pink r = 4 markers drawn on top.
    const { pix, paint } = canvas(120, 80);
    paint(segment(10, 60, 50.4, 30.7, 1.5), BLUE);
    paint(segment(50.4, 30.7, 100, 45, 1.5), BLUE);
    paint(disc(50.4, 30.7, 4), PINK);
    paint(disc(10, 60, 4), PINK);
    const t = findSnapTarget(pix, 52, 33, OPTS)!;
    expect(Math.hypot(t.px - 50.4, t.py - 30.7)).toBeLessThan(0.1);
    // From anywhere on the marker, including pixels right next to the (darker) line.
    for (let j = 26; j <= 35; j++) {
      for (let i = 46; i <= 55; i++) {
        if (Math.hypot(i - 50.4, j - 30.7) > 3.6) continue;
        const s = findSnapTarget(pix, i, j, OPTS);
        expect(s, `click at ${i},${j}`).not.toBeNull();
        expect(Math.hypot(s!.px - 50.4, s!.py - 30.7), `click at ${i},${j}`).toBeLessThan(0.1);
      }
    }
    // An end marker, where the line leaves on one side only.
    const end = findSnapTarget(pix, 12, 58, OPTS)!;
    expect(Math.hypot(end.px - 10, end.py - 60)).toBeLessThan(0.15);
  });

  it('does not snap on a line, curve or axis (the blob is too large)', () => {
    const { pix, paint } = canvas(200, 120);
    // A step curve like the Kaplan–Meier figure, with a same-colour '+' censoring mark on it.
    paint(segment(10, 100, 80, 100, 1.2), BLACK);
    paint(segment(80, 100, 80, 60, 1.2), BLACK);
    paint(segment(80, 60, 190, 60, 1.2), BLACK);
    paint(segment(130, 55, 130, 65, 1.2), BLACK);
    paint(segment(125, 60, 135, 60, 1.2), BLACK);
    expect(findSnapTarget(pix, 150, 61, OPTS)).toBeNull(); // on the plateau
    expect(findSnapTarget(pix, 131, 59, OPTS)).toBeNull(); // on the '+'
    expect(findSnapTarget(pix, 80, 80, OPTS)).toBeNull(); // on the riser
  });

  it('returns null when no ink is within the search radius', () => {
    const { pix, paint } = canvas(80, 80);
    paint(disc(60, 60, 3), PINK);
    expect(findSnapTarget(pix, 20, 20, OPTS)).toBeNull();
    expect(findSnapTarget(pix, 60 - 3 - 8.5, 60, OPTS)).toBeNull();
    expect(findSnapTarget(pix, 60 - 3 - 7, 60, OPTS)).not.toBeNull();
  });

  it('picks the nearest of two markers', () => {
    const { pix, paint } = canvas(80, 40);
    paint(disc(20, 20, 3), PINK);
    paint(disc(32, 20, 3), PINK);
    expect(findSnapTarget(pix, 25, 20, OPTS)!.px).toBeCloseTo(20, 1);
    expect(findSnapTarget(pix, 27.5, 20, OPTS)!.px).toBeCloseTo(32, 1);
  });

  it('works for dark markers on a grey background and with transparency', () => {
    const grey = canvas(50, 50, [200, 200, 200]);
    grey.paint(disc(25.5, 24.5, 3), BLACK);
    const t = findSnapTarget(grey.pix, 27, 23, OPTS)!;
    expect(Math.hypot(t.px - 25.5, t.py - 24.5)).toBeLessThan(0.05);

    // Fully transparent pixels read as white (how the page shows them).
    const clear = canvas(30, 30);
    for (let k = 3; k < clear.pix.data.length; k += 4) (clear.pix.data as Uint8ClampedArray)[k] = 0;
    expect(findSnapTarget(clear.pix, 15, 15, OPTS)).toBeNull();
  });

  it('is safe at the image edge and with bad input', () => {
    const { pix, paint } = canvas(20, 20);
    paint(disc(0, 0, 3), PINK);
    expect(findSnapTarget(pix, 1, 1, OPTS)).not.toBeNull();
    expect(findSnapTarget(pix, NaN, 1, OPTS)).toBeNull();
    expect(findSnapTarget({ width: 0, height: 0, data: [] }, 0, 0, OPTS)).toBeNull();
  });

  it('scales its radius with the view so "near" and "small" mean what they look like', () => {
    expect(snapOptions(1)).toEqual({ searchRadius: 12, maxSize: 48 });
    expect(snapOptions(0.25)).toEqual({ searchRadius: 48, maxSize: 192 });
    // Zoomed far in, floors keep a usable radius in image pixels.
    expect(snapOptions(40)).toEqual({ searchRadius: 1.5, maxSize: 24 });
  });
});
