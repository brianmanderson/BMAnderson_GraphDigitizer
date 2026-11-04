/**
 * "Nice" tick values for the calibration overlay. Given the linear-space range an axis covers
 * on the image, pick a handful of round data values to draw as faint gridlines. Presentation
 * only: positions come from the calibration (forward + linearToPixel), never from here.
 */

import { forward, inverse, type ScaleType } from '../core/index.ts';

const MAX_TICKS = 40;

/** A 1-2-5 step giving about `target` intervals over `span`. */
export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

function stepTicks(lo: number, hi: number, step: number): number[] {
  if (!(step > 0) || !Number.isFinite(lo) || !Number.isFinite(hi) || (hi - lo) / step > MAX_TICKS) return [];
  const out: number[] = [];
  for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
    // Snap k·step to the step's decimal precision so labels read 0.3, not 0.30000000000000004.
    out.push(Number((k * step).toPrecision(12)));
  }
  return out;
}

function linearTicks(lo: number, hi: number, target = 8): number[] {
  if (!(hi > lo)) return [];
  return stepTicks(lo, hi, niceStep(hi - lo, target));
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DATE_STEPS = [
  SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 365 * DAY,
];

function dateTicks(lo: number, hi: number, target = 8): number[] {
  if (!(hi > lo)) return [];
  const raw = (hi - lo) / target;
  const step = DATE_STEPS.find((s) => s >= raw);
  // Beyond a year per tick, fall back to multiples of ~years.
  return stepTicks(lo, hi, step ?? niceStep((hi - lo) / (365 * DAY), target) * 365 * DAY);
}

function logTicks(vLo: number, vHi: number): number[] {
  if (!(vHi > vLo) || !(vLo > 0)) return [];
  const kLo = Math.ceil(Math.log10(vLo) - 1e-9);
  const kHi = Math.floor(Math.log10(vHi) + 1e-9);
  const decades = kHi - kLo;
  const mantissas = decades < 2 ? [1, 2, 5] : [1];
  const every = Math.max(1, Math.ceil((decades + 1) / 12));
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(vLo)); k <= kHi; k++) {
    if ((k - kLo) % every !== 0) continue;
    for (const m of mantissas) {
      const v = Number((m * 10 ** k).toPrecision(12));
      if (v >= vLo * (1 - 1e-9) && v <= vHi * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

/**
 * Round data values within the linear-space interval [uLo, uHi] of an axis. `refValues` are the
 * axis's two calibration values, used to bound reciprocal axes whose range crosses 1/v = 0.
 */
export function axisTicks(scale: ScaleType, uLo: number, uHi: number, refValues: readonly [number, number]): number[] {
  const lo = Math.min(uLo, uHi);
  const hi = Math.max(uLo, uHi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  let ticks: number[];
  switch (scale) {
    case 'linear':
      ticks = linearTicks(lo, hi);
      break;
    case 'date':
      ticks = dateTicks(lo, hi);
      break;
    case 'log10':
    case 'ln': {
      const vLo = inverse(scale, lo);
      const vHi = inverse(scale, hi);
      ticks = vLo === null || vHi === null ? [] : logTicks(vLo, vHi);
      break;
    }
    case 'reciprocal': {
      if (lo > 0 || hi < 0) {
        const a = 1 / lo;
        const b = 1 / hi;
        ticks = linearTicks(Math.min(a, b), Math.max(a, b));
      } else {
        // The image reaches 1/v = 0 (v → ±∞): tick the span between the refs instead.
        ticks = linearTicks(Math.min(...refValues), Math.max(...refValues));
      }
      break;
    }
  }
  return ticks.filter((v) => {
    const u = forward(scale, v);
    return u !== null && u >= lo - 1e-9 * Math.abs(lo) && u <= hi + 1e-9 * Math.abs(hi);
  });
}
