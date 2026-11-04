/**
 * The skew-corrected frame. A chart rotated by θ (clockwise on screen, y down) has its
 * "horizontal" lines along d = (cos θ, sin θ) and its "vertical" lines along n = (−sin θ, cos θ).
 * Frame coordinates (u, w) are the components along d and n:
 *
 *   image point = u·d + w·n        u = x·cos θ + y·sin θ        w = −x·sin θ + y·cos θ
 *
 * A horizontal line has constant w (its `offset`) and runs along u; a vertical line has constant
 * u and runs along w (top → bottom). With θ = 0, (u, w) = (x, y).
 */

import type { Point } from './types.ts';

export interface Frame {
  cos: number;
  sin: number;
}

export function makeFrame(theta: number): Frame {
  return { cos: Math.cos(theta), sin: Math.sin(theta) };
}

export function toImage(f: Frame, u: number, w: number): Point {
  return { x: u * f.cos - w * f.sin, y: u * f.sin + w * f.cos };
}

export function toFrame(f: Frame, p: Point): { u: number; w: number } {
  return { u: p.x * f.cos + p.y * f.sin, w: -p.x * f.sin + p.y * f.cos };
}

/** Range of u and w covered by the image (pixel centres 0…width−1, 0…height−1). */
export function frameBounds(f: Frame, width: number, height: number) {
  const corners = [
    toFrame(f, { x: 0, y: 0 }),
    toFrame(f, { x: width - 1, y: 0 }),
    toFrame(f, { x: 0, y: height - 1 }),
    toFrame(f, { x: width - 1, y: height - 1 }),
  ];
  return {
    uMin: Math.min(...corners.map((c) => c.u)),
    uMax: Math.max(...corners.map((c) => c.u)),
    wMin: Math.min(...corners.map((c) => c.w)),
    wMax: Math.max(...corners.map((c) => c.w)),
  };
}

/** Image point of a line-family coordinate pair: (along, offset) for that family. */
export function familyPoint(f: Frame, family: 'horizontal' | 'vertical', along: number, offset: number): Point {
  return family === 'horizontal' ? toImage(f, along, offset) : toImage(f, offset, along);
}
