/**
 * Scoring end-to-end auto-calibration (Phase 5) against the ground truth: for each axis, the
 * suggested scale and refs predict the value at every labelled true tick that was not used as a
 * ref ("held-out"), and the error is measured in the true scale's linear space as a fraction of
 * the axis's labelled range. Real figures with `knownValues` are also checked at those pixels.
 */

import { calibrate, forward, inverse, parseDateTime, type ScaleType } from '../../src/core/index.ts';
import type { AutoCalibration, AxisSuggestion } from '../../src/auto/index.ts';
import type { P, Truth, TruthAxis } from './truth.ts';

/** An axis is calibrated correctly when every held-out tick is within 1 % of the axis range. */
export const VALUE_TOL = 0.01;
/** A held-out tick is one at least this far (px) from both suggested refs. */
const REF_EXCLUSION_PX = 2;

export interface CalibAxisScore {
  /** A suggestion with values at medium or high confidence. */
  calibrated: boolean;
  level: AxisSuggestion['level'];
  /** Suggested scale (null = none) and whether it matches the truth (ln ≡ log10). */
  scale: ScaleType | null;
  scaleOk: boolean | null;
  /** Largest held-out error as a fraction of the axis range; null when not calibrated. */
  maxError: number | null;
  correct: boolean;
}

export interface KnownValueScore {
  description: string;
  expected: number;
  predicted: number | null;
  error: number | null;
}

export interface CalibImageScore {
  x: CalibAxisScore;
  y: CalibAxisScore;
  /** Both axes correct and the 2-D suggestion cross-checked. */
  auto: boolean;
  known: KnownValueScore[];
  ms: number;
  ocrCalls: number;
}

const norm = (s: string) => (s === 'ln' ? 'log10' : s);

function truthValue(t: TruthAxis['ticks'][number]): number | null {
  if (typeof t.value === 'number') return t.value;
  const d = parseDateTime(t.value);
  return d.ok ? d.ms : null;
}

function truthScale(a: TruthAxis): ScaleType {
  return (['linear', 'log10', 'ln', 'reciprocal', 'date'] as const).find((s) => s === a.scale) ?? 'linear';
}

function refValue(scale: ScaleType, text: string): number | null {
  if (scale === 'date') {
    const d = parseDateTime(text);
    return d.ok ? d.ms : null;
  }
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Value predicted at point p by the line through the two refs (1-D along the axis). */
function predict1d(s: AxisSuggestion, p: P): number | null {
  if (!s.refs || !s.scale) return null;
  const [r1, r2] = s.refs;
  const v1 = refValue(s.scale, r1.value);
  const v2 = refValue(s.scale, r2.value);
  if (v1 === null || v2 === null) return null;
  const t1 = forward(s.scale, v1);
  const t2 = forward(s.scale, v2);
  if (t1 === null || t2 === null) return null;
  const dx = r2.px - r1.px;
  const dy = r2.py - r1.py;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return null;
  const k = ((p.x - r1.px) * dx + (p.y - r1.py) * dy) / L2;
  return inverse(s.scale, t1 + k * (t2 - t1));
}

function scoreAxis(truth: TruthAxis, s: AxisSuggestion): CalibAxisScore {
  const calibrated = s.status === 'calibrated' && s.level !== 'low';
  const scale = s.scale;
  const ts = truthScale(truth);
  const scaleOk = scale === null ? null : norm(scale) === norm(ts);
  if (!calibrated || !s.refs) return { calibrated: false, level: s.level, scale, scaleOk, maxError: null, correct: false };
  const ticks = truth.ticks.flatMap((t) => {
    const v = truthValue(t);
    const f = v === null ? null : forward(ts, v);
    return f === null ? [] : [{ point: t.point, f }];
  });
  const fs = ticks.map((t) => t.f);
  const range = Math.max(...fs) - Math.min(...fs);
  const refs = s.refs;
  const held = ticks.filter((t) => refs.every((r) => Math.hypot(r.px - t.point.x, r.py - t.point.y) > REF_EXCLUSION_PX));
  let maxError = 0;
  for (const t of held.length ? held : ticks) {
    const v = predict1d(s, t.point);
    const f = v === null ? null : forward(ts, v);
    const e = f === null || !(range > 0) ? Infinity : Math.abs(f - t.f) / range;
    maxError = Math.max(maxError, e);
  }
  return { calibrated, level: s.level, scale, scaleOk, maxError, correct: maxError <= VALUE_TOL && scaleOk === true };
}

interface KnownValue {
  description?: string;
  x?: [number, number];
  y?: number;
  py?: number;
}

/** knownValues with a `py`: the y predicted by the full 2-D suggestion at that pixel row. */
function scoreKnown(truth: Truth, raw: unknown, auto: AutoCalibration): KnownValueScore[] {
  const list = Array.isArray(raw) ? (raw as KnownValue[]) : [];
  const out: KnownValueScore[] = [];
  const { x, y } = auto;
  const cal =
    auto.ok && x.refs && y.refs && x.scale && y.scale
      ? calibrate({ X1: x.refs[0], X2: x.refs[1], Y1: y.refs[0], Y2: y.refs[1] }, x.scale, y.scale)
      : null;
  // A pixel column inside the known x range, interpolated from the true x ticks.
  const xt = truth.x.ticks.filter((t) => typeof t.value === 'number').sort((a, b) => (a.value as number) - (b.value as number));
  const pxAt = (v: number) => {
    for (let i = 1; i < xt.length; i++) {
      const a = xt[i - 1] as (typeof xt)[number];
      const b = xt[i] as (typeof xt)[number];
      if (v <= (b.value as number) || i === xt.length - 1) {
        const k = (v - (a.value as number)) / ((b.value as number) - (a.value as number));
        return a.point.x + k * (b.point.x - a.point.x);
      }
    }
    return xt[0]?.point.x ?? 0;
  };
  for (const kv of list) {
    if (typeof kv.py !== 'number' || typeof kv.y !== 'number' || !kv.x) continue;
    const px = pxAt((kv.x[0] + kv.x[1]) / 2);
    const v = cal?.ok ? cal.calibration.pixelToValue(px, kv.py).y : null;
    out.push({ description: kv.description ?? '', expected: kv.y, predicted: v, error: v === null ? null : Math.abs(v - kv.y) });
  }
  return out;
}

export function scoreCalibration(truth: Truth, auto: AutoCalibration, knownValues: unknown, ms: number): CalibImageScore {
  const x = scoreAxis(truth.x, auto.x);
  const y = scoreAxis(truth.y, auto.y);
  return { x, y, auto: auto.ok && x.correct && y.correct, known: scoreKnown(truth, knownValues, auto), ms, ocrCalls: auto.timings.ocrCalls };
}

export interface CalibMetrics {
  /** Axes with a medium/high suggestion, of all axes. */
  calibrated: number;
  /** Axes with no medium/high suggestion (left to the user), of all axes: calibrated + declined = 1. */
  declined: number;
  /** Axes calibrated correctly (scale right, held-out error ≤ 1 %), of all axes. */
  correct: number;
  /** Axes suggested at medium/high confidence that are wrong (should stay 0). */
  wrong: number;
  /** Of those, suggested at high confidence. */
  wrongHigh: number;
  /** Axes whose inferred scale matches the truth, of axes where a scale was inferred. */
  scaleAccuracy: number | null;
  /** Median held-out error of correct axes, % of range. */
  medianErrorPct: number | null;
  /** Images calibrated end to end (both axes correct, cross-checked), of all images. */
  autoImages: number;
  /** Largest error on knownValues (real figures), absolute; null when none. */
  knownMaxError: number | null;
  meanOcrMs: number;
}

export function aggregateCalib(scores: CalibImageScore[]): CalibMetrics {
  const axes = scores.flatMap((s) => [s.x, s.y]);
  const scaled = axes.filter((a) => a.scaleOk !== null);
  const errs = axes.filter((a) => a.correct).map((a) => (a.maxError as number) * 100).sort((a, b) => a - b);
  const known = scores.flatMap((s) => s.known);
  const n = Math.max(1, axes.length);
  return {
    calibrated: axes.filter((a) => a.calibrated).length / n,
    declined: axes.filter((a) => !a.calibrated).length / n,
    correct: axes.filter((a) => a.correct).length / n,
    wrong: axes.filter((a) => a.calibrated && !a.correct).length,
    wrongHigh: axes.filter((a) => a.calibrated && !a.correct && a.level === 'high').length,
    scaleAccuracy: scaled.length ? scaled.filter((a) => a.scaleOk).length / scaled.length : null,
    medianErrorPct: errs.length ? Math.round((errs[errs.length >> 1] as number) * 1000) / 1000 : null,
    autoImages: scores.length ? scores.filter((s) => s.auto).length / scores.length : 0,
    knownMaxError: known.length ? (known.some((k) => k.error === null) ? 1 : Math.max(...known.map((k) => k.error as number))) : null,
    meanOcrMs: scores.length ? scores.reduce((s, v) => s + v.ms, 0) / scores.length : 0,
  };
}

/**
 * Calibration metrics the baseline gates on. `calibrated` and `declined` are reported, not gated:
 * declining a doubtful suggestion (fewer calibrated, more declined, fewer wrong) is the right trade.
 */
export const CALIB_GATED: { key: keyof CalibMetrics; higherIsBetter: boolean }[] = [
  { key: 'correct', higherIsBetter: true },
  { key: 'wrong', higherIsBetter: false },
  { key: 'wrongHigh', higherIsBetter: false },
  { key: 'scaleAccuracy', higherIsBetter: true },
  { key: 'autoImages', higherIsBetter: true },
  { key: 'knownMaxError', higherIsBetter: false },
];
