/**
 * Axis calibration: an affine fit from image pixels to linear space (docs/SPEC.md →
 * Calibration math).
 *
 *   u = a·px + b·py + c      w = d·px + e·py + g      (u = fx(x), w = fy(y))
 *
 * with u(X1) = fx(x1), u(X2) = fx(x2), u(Y1) = u(Y2), and w(Y1) = fy(y1), w(Y2) = fy(y2),
 * w(X1) = w(X2). Subtracting pairs eliminates c and g, leaving two 2×2 systems that share the
 * determinant cross(X2 − X1, Y2 − Y1): the fit exists exactly when the X refs and the Y refs
 * lie along non-parallel directions.
 */

import { parseDateTime } from './dates.ts';
import { DOMAIN_RULES, forward, inverse, type ScaleType } from './scales.ts';
import type { CalibrationRefs, CalibrationSpec, RefName } from './project.ts';

export type Axis = 'x' | 'y';

export interface Pixel {
  px: number;
  py: number;
}

/** A data value. A component is null where the scale cannot represent it (e.g. 1/0). */
export interface DataValue {
  x: number | null;
  y: number | null;
}

export type CalibrationError =
  /** A ref's pixel coordinates are NaN or infinite. */
  | { kind: 'invalid-pixel'; ref: RefName; message: string }
  /** A ref's value is not a number / not a parseable date. */
  | { kind: 'invalid-value'; ref: RefName; message: string }
  /** A ref's value is valid but outside the scale's domain (e.g. log of 0). */
  | { kind: 'out-of-domain'; ref: RefName; scale: ScaleType; message: string }
  /** Reciprocal axis whose two ref values have opposite signs. */
  | { kind: 'reciprocal-straddles-zero'; axis: Axis; message: string }
  /** The two refs of an axis have the same value, so the axis has no extent. */
  | { kind: 'equal-values'; axis: Axis; message: string }
  /** The two refs of an axis were placed on the same pixel. */
  | { kind: 'coincident-points'; refs: readonly [RefName, RefName]; message: string }
  /** The X refs and Y refs lie along parallel lines, so the fit has no unique solution. */
  | { kind: 'singular-system'; message: string }
  /** The values are so extreme that the fit is not representable in floating point. */
  | { kind: 'numeric-overflow'; message: string };

export type CalibrationErrorKind = CalibrationError['kind'];

/** Pixel → linear-space coefficients: u = a·px + b·py + c, w = d·px + e·py + g. */
export interface AffineCoefficients {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  g: number;
}

export interface Calibration {
  readonly xScale: ScaleType;
  readonly yScale: ScaleType;
  readonly affine: Readonly<AffineCoefficients>;
  /** Ref values resolved to numbers (dates as epoch ms). */
  readonly refValues: Readonly<Record<RefName, number>>;
  pixelToLinear(px: number, py: number): { u: number; w: number };
  linearToPixel(u: number, w: number): Pixel;
  /** Image pixel → data value. Components outside the scale's representable range are null. */
  pixelToValue(px: number, py: number): DataValue;
  /** Data value → image pixel, or null if either value is outside its scale's domain. */
  valueToPixel(x: number, y: number): Pixel | null;
}

export type CalibrationResult =
  | { ok: true; calibration: Calibration }
  | { ok: false; error: CalibrationError };

/** Refs closer than this (image px) are treated as the same point. */
export const COINCIDENT_TOLERANCE_PX = 1e-6;

/**
 * The fit is singular when the sine of the angle between the X-ref and Y-ref directions is
 * below this. Real charts have axes ~90° apart; anything this close to parallel is a mistake.
 */
export const SINGULAR_SINE_TOLERANCE = 1e-9;

const AXIS_REFS: Readonly<Record<Axis, readonly [RefName, RefName]>> = {
  x: ['X1', 'X2'],
  y: ['Y1', 'Y2'],
};

const fail = (error: CalibrationError): CalibrationResult => ({ ok: false, error });

/** Resolve a ref's typed value to a number: dates to epoch ms, numeric strings to numbers. */
function resolveValue(
  ref: RefName,
  scale: ScaleType,
  value: number | string,
): { ok: true; v: number } | { ok: false; error: CalibrationError } {
  let v: number;
  if (typeof value === 'number') {
    v = value;
  } else if (scale === 'date') {
    const parsed = parseDateTime(value);
    if (!parsed.ok) {
      return { ok: false, error: { kind: 'invalid-value', ref, message: `${ref}: ${parsed.message}` } };
    }
    v = parsed.ms;
  } else {
    const text = value.trim();
    v = text === '' ? NaN : Number(text);
  }
  if (!Number.isFinite(v)) {
    const shown = typeof value === 'string' ? `"${value}"` : String(value);
    return {
      ok: false,
      error: { kind: 'invalid-value', ref, message: `${ref}: ${shown} is not a valid number.` },
    };
  }
  return { ok: true, v };
}

/** Values whose difference is lost to rounding count as equal. */
function nearlyEqual(p: number, q: number): boolean {
  return Math.abs(q - p) <= 4 * Number.EPSILON * Math.max(Math.abs(p), Math.abs(q));
}

/**
 * Fit a calibration from four reference points. Never produces NaN/Infinity coefficients:
 * every degenerate input is reported as a typed CalibrationError instead.
 */
export function calibrate(
  refs: CalibrationRefs,
  xScale: ScaleType,
  yScale: ScaleType,
): CalibrationResult {
  const scales: Record<Axis, ScaleType> = { x: xScale, y: yScale };

  for (const axis of ['x', 'y'] as const) {
    for (const ref of AXIS_REFS[axis]) {
      const { px, py } = refs[ref];
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        return fail({
          kind: 'invalid-pixel',
          ref,
          message: `${ref} has no valid position on the image.`,
        });
      }
    }
  }

  const refValues = {} as Record<RefName, number>;
  const linear = {} as Record<RefName, number>;
  for (const axis of ['x', 'y'] as const) {
    const scale = scales[axis];
    for (const ref of AXIS_REFS[axis]) {
      const resolved = resolveValue(ref, scale, refs[ref].value);
      if (!resolved.ok) return fail(resolved.error);
      const u = forward(scale, resolved.v);
      if (u === null) {
        return fail({
          kind: 'out-of-domain',
          ref,
          scale,
          message: `${ref}: values on a ${scale} axis must ${DOMAIN_RULES[scale]}.`,
        });
      }
      refValues[ref] = resolved.v;
      linear[ref] = u;
    }

    const [r1, r2] = AXIS_REFS[axis];
    const label = axis.toUpperCase();
    if (scale === 'reciprocal' && Math.sign(refValues[r1]) !== Math.sign(refValues[r2])) {
      return fail({
        kind: 'reciprocal-straddles-zero',
        axis,
        message: `${r1} and ${r2} are on opposite sides of 0; a reciprocal axis cannot cross 0.`,
      });
    }
    if (nearlyEqual(linear[r1], linear[r2])) {
      return fail({
        kind: 'equal-values',
        axis,
        message: `${r1} and ${r2} have the same value; the ${label} refs need two different values.`,
      });
    }
    const dpx = refs[r2].px - refs[r1].px;
    const dpy = refs[r2].py - refs[r1].py;
    if (Math.hypot(dpx, dpy) <= COINCIDENT_TOLERANCE_PX) {
      return fail({
        kind: 'coincident-points',
        refs: [r1, r2],
        message: `${r1} and ${r2} are at the same spot; place them apart along the ${label} axis.`,
      });
    }
  }

  const { X1, X2, Y1, Y2 } = refs;
  const vx = { x: X2.px - X1.px, y: X2.py - X1.py };
  const vy = { x: Y2.px - Y1.px, y: Y2.py - Y1.py };
  const cross = vx.x * vy.y - vx.y * vy.x;
  if (Math.abs(cross) <= SINGULAR_SINE_TOLERANCE * Math.hypot(vx.x, vx.y) * Math.hypot(vy.x, vy.y)) {
    return fail({
      kind: 'singular-system',
      message:
        'The X refs and Y refs lie along parallel lines. Place the X refs along the X axis and the Y refs along the Y axis.',
    });
  }

  const du = linear.X2 - linear.X1;
  const dw = linear.Y2 - linear.Y1;
  const a = (du * vy.y) / cross;
  const b = (-du * vy.x) / cross;
  const c = linear.X1 - a * X1.px - b * X1.py;
  const d = (-dw * vx.y) / cross;
  const e = (dw * vx.x) / cross;
  const g = linear.Y1 - d * Y1.px - e * Y1.py;
  const det = a * e - b * d;
  if (![a, b, c, d, e, g, det].every(Number.isFinite) || det === 0) {
    return fail({
      kind: 'numeric-overflow',
      message: 'The reference values are too extreme to calibrate reliably.',
    });
  }

  const affine: AffineCoefficients = { a, b, c, d, e, g };

  const pixelToLinear = (px: number, py: number) => ({ u: a * px + b * py + c, w: d * px + e * py + g });
  const linearToPixel = (u: number, w: number): Pixel => {
    const su = u - c;
    const sw = w - g;
    return { px: (e * su - b * sw) / det, py: (a * sw - d * su) / det };
  };

  const calibration: Calibration = {
    xScale,
    yScale,
    affine,
    refValues,
    pixelToLinear,
    linearToPixel,
    pixelToValue(px, py) {
      const { u, w } = pixelToLinear(px, py);
      return { x: inverse(xScale, u), y: inverse(yScale, w) };
    },
    valueToPixel(x, y) {
      const u = forward(xScale, x);
      const w = forward(yScale, y);
      if (u === null || w === null) return null;
      const p = linearToPixel(u, w);
      return Number.isFinite(p.px) && Number.isFinite(p.py) ? p : null;
    },
  };
  return { ok: true, calibration };
}

/** calibrate() for a stored CalibrationSpec. */
export function calibrateSpec(spec: CalibrationSpec): CalibrationResult {
  return calibrate(spec.refs, spec.xScale, spec.yScale);
}
