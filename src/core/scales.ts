/**
 * Axis scale types and their transforms between data values and "linear space".
 *
 * Calibration fits an affine map from image pixels to linear space; each scale supplies the
 * forward transform f (value → linear space) and its inverse. See docs/SPEC.md.
 */

export const SCALE_TYPES = ['linear', 'log10', 'ln', 'reciprocal', 'date'] as const;

export type ScaleType = (typeof SCALE_TYPES)[number];

export const SCALE_LABELS: Readonly<Record<ScaleType, string>> = {
  linear: 'Linear',
  log10: 'Log₁₀',
  ln: 'Natural log (ln)',
  reciprocal: 'Reciprocal (1/v)',
  date: 'Date/time',
};

/** Human-readable domain rule, phrased to complete "Values on a … axis must …". */
export const DOMAIN_RULES: Readonly<Record<ScaleType, string>> = {
  linear: 'be finite numbers',
  log10: 'be greater than 0',
  ln: 'be greater than 0',
  reciprocal: 'be non-zero',
  date: 'be valid dates/times',
};

/** Largest magnitude of a valid JavaScript Date, in epoch milliseconds (±100,000,000 days). */
export const MAX_EPOCH_MS = 8.64e15;

export function isScaleType(value: unknown): value is ScaleType {
  return typeof value === 'string' && (SCALE_TYPES as readonly string[]).includes(value);
}

/** True when `v` is an allowed data value for `scale`. Date values are epoch milliseconds. */
export function isInDomain(scale: ScaleType, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  switch (scale) {
    case 'linear':
      return true;
    case 'log10':
    case 'ln':
      return v > 0;
    case 'reciprocal':
      return v !== 0;
    case 'date':
      return Math.abs(v) <= MAX_EPOCH_MS;
  }
}

/** f(v): data value → linear space. Returns null when `v` is outside the scale's domain. */
export function forward(scale: ScaleType, v: number): number | null {
  if (!isInDomain(scale, v)) return null;
  let u: number;
  switch (scale) {
    case 'linear':
    case 'date':
      u = v;
      break;
    case 'log10':
      u = Math.log10(v);
      break;
    case 'ln':
      u = Math.log(v);
      break;
    case 'reciprocal':
      u = 1 / v;
      break;
  }
  return Number.isFinite(u) ? u : null;
}

/**
 * f⁻¹(u): linear space → data value. Returns null when the result is not a representable
 * in-domain value (e.g. reciprocal at u = 0, log overflow/underflow, dates beyond ±MAX_EPOCH_MS).
 */
export function inverse(scale: ScaleType, u: number): number | null {
  if (!Number.isFinite(u)) return null;
  let v: number;
  switch (scale) {
    case 'linear':
    case 'date':
      v = u;
      break;
    case 'log10':
      v = 10 ** u;
      break;
    case 'ln':
      v = Math.exp(u);
      break;
    case 'reciprocal':
      v = 1 / u;
      break;
  }
  return isInDomain(scale, v) ? v : null;
}
