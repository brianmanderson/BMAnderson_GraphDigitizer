/**
 * From read tick labels to a suggested calibration (Phase 5). Pure TS, no DOM.
 *
 * Per axis:
 * 1. Values: each label's OCR text is parsed (`parseLabel.ts`). On a date axis the month names are
 *    dated with `resolveDateLabels`.
 * 2. Scale: the label values are fitted against their positions along the axis — values evenly
 *    spaced in pixels → linear; their logarithms evenly spaced → log10; dated labels → date. The
 *    fit is a consensus (every pair of labels proposes a line; the line most labels agree with,
 *    within `tolerance`, wins), so one misread label is an outlier instead of a bad fit. Log needs
 *    the values to span at least a factor of 4 (over a narrow range both fit). Integer years in
 *    steps of 1–10 (`2016, 2017, …`) are read as a date axis. When linear and log fit equally
 *    (two labels only) the scale is "uncertain".
 * 3. Refs: the two most widely separated agreeing labels whose OCR confidence is high.
 * 4. Cross-check: the line through those two refs must predict every other agreeing label
 *    within 2 × tolerance, and at least 60 % of all read labels; then the full 2-D calibration
 *    (src/core `calibrate`) must succeed and reproduce each label at its tick within 2 ×
 *    tolerance. Anything else rejects the suggestion for that axis (confidence "low").
 *
 * Confidence levels: "high" = ≥ 3 agreeing labels, at most one disagreeing (20 % for long axes),
 * a certain scale and mean OCR confidence ≥ 0.6; "medium" = ≥ 3 agreeing labels otherwise;
 * "low" = no usable calibration — the UI falls back to the manual flow, pre-filled with the tick
 * positions when tick marks were found, or with labelled gridlines without them ("positions").
 */

import { calibrate, formatDateTime, forward, type CalibrationRefs, type ScaleType } from '../core/index.ts';
import type { AxisLabels } from './labels.ts';
import { parseAxisNote, parseNumberLabel, parseDateToken, resolveDateLabels, type LabelToken } from './parseLabel.ts';
import type { AxisDetection, Point } from './types.ts';

/** One label as read, with how it fits the suggestion. */
export interface ReadLabel {
  along: number;
  point: Point;
  tick: number | null;
  /** OCR text as interpreted (`10^-2` for a raised exponent). */
  text: string;
  /** OCR confidence 0–1. */
  confidence: number;
  /** Parsed value (dates as epoch ms), or null when it could not be parsed. */
  value: number | null;
  /** Agrees with the fitted scale. */
  inlier: boolean;
  /** Distance from the tick to where the suggested calibration puts this value, px. */
  residualPx: number | null;
  box: { center: Point; width: number; height: number };
}

export interface SuggestedRef {
  px: number;
  py: number;
  /** The value as it would be typed into the ref's field ('' when unknown). */
  value: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface AxisSuggestion {
  axis: 'x' | 'y';
  mode: AxisLabels['mode'];
  /** calibrated = refs with values; positions = refs at tick marks, values unknown; none. */
  status: 'calibrated' | 'positions' | 'none';
  level: ConfidenceLevel;
  /** 0–1, for the badge. */
  confidence: number;
  scale: ScaleType | null;
  scaleCertain: boolean;
  refs: [SuggestedRef, SuggestedRef] | null;
  labels: ReadLabel[];
  /** Largest residual over the agreeing labels, px (null without a fit). */
  maxResidualPx: number | null;
  /** User-facing explanation of the result. */
  message: string;
  /** The detected axis line (image px), if any. */
  line: { p1: Point; p2: Point } | null;
}

export interface AutoCalibration {
  width: number;
  height: number;
  detection: AxisDetection;
  x: AxisSuggestion;
  y: AxisSuggestion;
  /** Both axes calibrated at medium confidence or better and the 2-D fit cross-checks. */
  ok: boolean;
  timings: { detectMs: number; labelsMs: number; ocrMs: number; totalMs: number; ocrCalls: number };
}

/** A label after OCR: the text read and its confidence (0–1); `power` = read as base^exponent. */
export interface OcrLabel {
  text: string;
  confidence: number;
}

interface Fit {
  scale: ScaleType;
  /** along = a + b·f(value) */
  a: number;
  b: number;
  inliers: number[];
  values: (number | null)[];
  power: number;
  /** Labels whose value was inferred, not read (an unread exponent of a 10^k label). */
  inferred: number[];
}

/** Tick positions are exact to a fraction of a pixel; label centres (labels-only) less so. */
export function tolerance(alongs: number[], mode: AxisLabels['mode']): number {
  const s = [...alongs].sort((a, b) => a - b);
  const gaps = s.slice(1).map((v, i) => v - (s[i] as number)).filter((g) => g > 0).sort((a, b) => a - b);
  const spacing = gaps.length ? (gaps[gaps.length >> 1] as number) : 0;
  return mode === 'ticks' ? Math.max(1.5, 0.03 * spacing) : Math.max(2.5, 0.08 * spacing);
}

/** Consensus line along = a + b·t over the points with a finite t. */
function consensus(alongs: number[], ts: (number | null)[], tol: number): { a: number; b: number; inliers: number[] } | null {
  const idx = ts.flatMap((t, i) => (t === null ? [] : [i]));
  let best: { a: number; b: number; inliers: number[]; sse: number } | null = null;
  for (let p = 0; p < idx.length; p++) {
    for (let q = p + 1; q < idx.length; q++) {
      const i = idx[p] as number;
      const j = idx[q] as number;
      const ti = ts[i] as number;
      const tj = ts[j] as number;
      if (ti === tj) continue;
      const b = ((alongs[j] as number) - (alongs[i] as number)) / (tj - ti);
      if (!Number.isFinite(b) || b === 0) continue;
      const a = (alongs[i] as number) - b * ti;
      const inliers: number[] = [];
      let sse = 0;
      for (const k of idx) {
        const r = (alongs[k] as number) - (a + b * (ts[k] as number));
        if (Math.abs(r) <= tol) {
          inliers.push(k);
          sse += r * r;
        }
      }
      if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && sse < best.sse)) {
        best = { a, b, inliers, sse };
      }
    }
  }
  if (!best || best.inliers.length < 2) return null;
  // Least-squares refit on the inliers.
  const n = best.inliers.length;
  const mt = best.inliers.reduce((s, k) => s + (ts[k] as number), 0) / n;
  const ma = best.inliers.reduce((s, k) => s + (alongs[k] as number), 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const k of best.inliers) {
    sxy += ((ts[k] as number) - mt) * ((alongs[k] as number) - ma);
    sxx += ((ts[k] as number) - mt) ** 2;
  }
  if (sxx > 0 && Number.isFinite(sxy / sxx) && sxy !== 0) {
    const b = sxy / sxx;
    return { a: ma - b * mt, b, inliers: best.inliers };
  }
  return { a: best.a, b: best.b, inliers: best.inliers };
}

function fitScale(scale: ScaleType, alongs: number[], values: (number | null)[], tol: number, power: number): Fit | null {
  const ts = values.map((v) => (v === null ? null : forward(scale, v)));
  const c = consensus(alongs, ts, tol);
  return c ? { scale, ...c, values, power, inferred: [] } : null;
}

const isYearSequence = (vals: number[]) => {
  if (vals.length < 3 || !vals.every((v) => Number.isInteger(v) && v >= 1000 && v <= 2999)) return false;
  const s = [...vals].sort((a, b) => a - b);
  const d = (s[1] as number) - (s[0] as number);
  return d >= 1 && d <= 10 && s.every((v, i) => i === 0 || v - (s[i - 1] as number) === d);
};

/**
 * A `10^k` label whose exponent OCR could not read ("10^") still says "a power of ten is here".
 * When the labels that were read fit a log scale, such a label sitting exactly on a whole decade
 * of that fit (within the tolerance) gets that decade as its value, marked as inferred; one that
 * falls between decades means the reading is inconsistent and nothing is inferred.
 */
function withUnreadExponents(fit: Fit | null, alongs: number[], texts: OcrLabel[], tol: number): Fit | null {
  if (!fit || fit.inliers.length < 2) return fit;
  const unread = texts.map((t, i) => (/^10\^$/.test(t.text.trim()) ? i : -1)).filter((i) => i >= 0);
  if (unread.length === 0) return fit;
  const values = [...fit.values];
  const inferred: number[] = [];
  for (const i of unread) {
    const k = Math.round(((alongs[i] as number) - fit.a) / fit.b);
    if (Math.abs((alongs[i] as number) - (fit.a + fit.b * k)) > tol) return fit;
    values[i] = Number(`1e${k}`);
    inferred.push(i);
  }
  return { ...fit, values, inliers: [...fit.inliers, ...inferred].sort((a, b) => a - b), inferred };
}

/** The best interpretation of the numeric reading of an axis (after the axis note, if read). */
function numericFit(
  alongs: number[],
  texts: OcrLabel[],
  tol: number,
  logHint: boolean,
  note: { multiplier: number; offset: number } | null,
): { fit: Fit | null; certain: boolean } {
  const parsed = texts.map((t) => parseNumberLabel(t.text));
  const values = parsed.map((p) => {
    if (!p) return null;
    if (!note) return p.value;
    // Like the labels' own decimals: keep the sum free of binary noise (0.02 + 1e4).
    const v = p.value * note.multiplier + note.offset;
    return Number.isFinite(v) ? Number(v.toPrecision(15)) : null;
  });
  const power = parsed.filter((p) => p?.power).length;
  const lin = fitScale('linear', alongs, values, tol, power);
  let log = withUnreadExponents(
    fitScale('log10', alongs, values.map((v) => (v !== null && v > 0 ? v : null)), tol, power),
    alongs,
    texts,
    tol,
  );
  // Over a narrow range (100.00–100.08, 2016–2021) log and linear fit equally well; a log axis
  // spans at least a factor of 4, so only then is log a candidate.
  if (log) {
    const vs = log.inliers.map((k) => log?.values[k] as number);
    if (Math.max(...vs) / Math.min(...vs) < 4) log = null;
  }
  const nl = lin?.inliers.length ?? 0;
  const ng = log?.inliers.length ?? 0;
  if (lin && nl > ng) {
    const years = lin.inliers.map((k) => values[k] as number);
    if (isYearSequence(years)) {
      const dates = values.map((v) => (v !== null && Number.isInteger(v) && v >= 1000 && v <= 2999 ? Date.UTC(v, 0, 1) : null));
      const asDate = fitScale('date', alongs, dates, tol, 0);
      if (asDate && asDate.inliers.length >= nl) return { fit: asDate, certain: true };
    }
    return { fit: lin, certain: nl >= 3 };
  }
  if (log && ng > nl) return { fit: log, certain: ng >= 3 };
  // A tie (e.g. only two labels): the labels' notation or the tick pattern decides, uncertainly.
  if (log && (power >= 2 || logHint)) return { fit: log, certain: false };
  return { fit: lin, certain: false };
}

/** The date reading of an axis (labels read as text). Increasing time = increasing `order`. */
function dateFit(alongs: number[], texts: OcrLabel[], tol: number, ascending: boolean): Fit | null {
  const tokens: (LabelToken | null)[] = texts.map((t) => parseDateToken(t.text));
  if (!tokens.some((t) => t && t.kind !== 'day')) return null;
  const order = alongs.map((_, i) => i).sort((i, j) => (ascending ? 1 : -1) * ((alongs[i] as number) - (alongs[j] as number)));
  const resolved = resolveDateLabels(order.map((i) => tokens[i] ?? null));
  const values: (number | null)[] = alongs.map(() => null);
  order.forEach((i, k) => {
    values[i] = resolved[k] ?? null;
  });
  return fitScale('date', alongs, values, tol, 0);
}

function refValueText(scale: ScaleType, v: number): string {
  if (scale !== 'date') return String(v);
  return v % 86_400_000 === 0 ? formatDateTime(v, 'YYYY-MM-DD') : formatDateTime(v, 'YYYY-MM-DD HH:mm:ss');
}

export interface AxisReading {
  labels: AxisLabels;
  /** The numeric-mode OCR result of each label. */
  numeric: OcrLabel[];
  /** The text-mode OCR result of each label, when it was read that way. */
  text: OcrLabel[] | null;
  logHint: boolean;
  line: { p1: Point; p2: Point } | null;
  /**
   * Points for the positions-only fallback, in along order: the major ticks (ticks mode), or the
   * labels that sit on gridlines (labels only).
   */
  tickPoints: Point[];
  /** What `tickPoints` are (default: tick marks). */
  positionsFrom?: 'ticks' | 'gridlines';
  /** The OCR'd offset/multiplier note at the axis end, if one was found. */
  note: OcrLabel | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

interface AxisFit {
  fit: Fit | null;
  certain: boolean;
  texts: OcrLabel[];
  /** Why there is no fit, when the reason is more specific than "too few labels". */
  reason: string | null;
  /** A note was seen but could not be read as an offset/multiplier. */
  unreadNote: string | null;
}

/**
 * Best fit for an axis from its readings: numeric first, then (if read) as dates. Month names
 * among the labels make it a date axis: if those cannot be dated (day numbers, no year printed)
 * there is no fit, rather than a numeric fit of the day numbers.
 */
export function fitAxis(r: AxisReading): AxisFit {
  const alongs = r.labels.labels.map((l) => l.along);
  const tol = tolerance(alongs, r.labels.mode);
  const note = r.note && r.note.confidence > 0 ? parseAxisNote(r.note.text) : null;
  const unreadNote = r.note && !note ? r.note.text : null;
  // A label cut off at the axis ("60" read as "6") is shown as read but gives no value: a few of
  // them can agree on a scale that is off by a factor of ten.
  const usable = (ts: OcrLabel[]) => ts.map((t, i) => (r.labels.labels[i]?.clipped ? { text: '', confidence: 0 } : t));
  const num = numericFit(alongs, usable(r.numeric), tol, r.logHint, note);
  const best: AxisFit = { ...num, texts: r.numeric, reason: null, unreadNote };
  if (r.text) {
    // Dates increase to the right on X; on Y (rare) upwards, i.e. with decreasing w.
    const d = dateFit(alongs, usable(r.text), tol, r.labels.axis === 'x');
    const months = r.text.filter((t) => parseDateToken(t.text)?.kind === 'month').length;
    if (d && d.inliers.length >= 3 && d.inliers.length >= (num.fit?.inliers.length ?? 0)) {
      return { fit: d, certain: true, texts: r.text, reason: null, unreadNote: null };
    }
    if (months > 0) {
      return {
        fit: null,
        certain: false,
        texts: r.text,
        reason: 'The labels look like dates, but no year could be read for them.',
        unreadNote: null,
      };
    }
  }
  return best;
}

/** Turn one axis's reading into a suggestion (before the 2-D cross-check). */
export function suggestAxis(r: AxisReading): AxisSuggestion {
  const axis = r.labels.axis;
  const alongs = r.labels.labels.map((l) => l.along);
  const tol = tolerance(alongs, r.labels.mode);
  const { fit, certain, texts, reason, unreadNote } = fitAxis(r);
  const labels: ReadLabel[] = r.labels.labels.map((l, i) => ({
    along: l.along,
    point: l.point,
    tick: l.tick,
    text: texts[i]?.text ?? '',
    confidence: texts[i]?.confidence ?? 0,
    value: fit?.values[i] ?? null,
    inlier: false,
    residualPx: null,
    box: l.box,
  }));
  const base: AxisSuggestion = {
    axis,
    mode: r.labels.mode,
    status: 'none',
    level: 'low',
    confidence: 0,
    scale: fit?.scale ?? null,
    scaleCertain: certain,
    refs: null,
    labels,
    maxResidualPx: null,
    message: '',
    line: r.line,
  };
  // Hand-lettered or italic labels (sheared upright for OCR, but still read poorly): say so.
  const italic = r.labels.labels.length >= 2 && r.labels.labels.filter((l) => l.slanted).length > 0.5 * r.labels.labels.length;
  const fallback = (why: string): AxisSuggestion => {
    const message = italic ? `${why} The labels look hand-lettered or italic, which OCR reads unreliably.` : why;
    if (r.tickPoints.length >= 2) {
      const a = r.tickPoints[0] as Point;
      const b = r.tickPoints[r.tickPoints.length - 1] as Point;
      return {
        ...base,
        status: 'positions',
        refs: [
          { px: a.x, py: a.y, value: '' },
          { px: b.x, py: b.y, value: '' },
        ],
        message: `${message} The two outermost ${r.positionsFrom === 'gridlines' ? 'labelled gridlines' : 'tick marks'} are suggested as refs; type their values.`,
      };
    }
    return { ...base, message };
  };
  if (!r.line) return { ...base, message: `No ${axis.toUpperCase()} axis line was found.` };
  if (labels.length === 0) return fallback('No tick labels were found next to the axis.');
  if (reason) return fallback(reason);
  if (unreadNote !== null) {
    // The labels alone are not the values.
    return fallback(`There is an offset or multiplier note at the end of the axis ("${unreadNote}") that could not be read.`);
  }
  const readable = fit ? fit.values.filter((v) => v !== null).length : 0;
  const clipped = r.labels.labels.filter((l) => l.clipped).length;
  if (!fit || fit.inliers.length < 3) {
    return fallback(
      readable < 3
        ? `Only ${readable} of ${labels.length} labels could be read as values` +
            (clipped > 0 ? ` (${clipped} touch the axis line and may be cut off, so their readings are not used).` : '.')
        : `The labels read do not agree with each other (best: ${fit?.inliers.length ?? 0} of ${readable}).`,
    );
  }

  // Refs: the most widely separated agreeing labels with confident OCR.
  const read = fit.inliers.filter((k) => !fit.inferred.includes(k));
  const strong = read.filter((k) => (labels[k] as ReadLabel).confidence >= 0.75);
  const pool = strong.length >= 2 ? strong : read;
  let pair: [number, number] = [pool[0] as number, pool[1] as number];
  for (const i of pool) {
    for (const j of pool) {
      if (Math.abs((alongs[j] as number) - (alongs[i] as number)) > Math.abs((alongs[pair[1]] as number) - (alongs[pair[0]] as number))) pair = [i, j];
    }
  }
  if ((alongs[pair[0]] as number) > (alongs[pair[1]] as number)) pair = [pair[1], pair[0]];
  const t = (k: number) => forward(fit.scale, fit.values[k] as number) as number;
  const [i, j] = pair;
  const b = ((alongs[j] as number) - (alongs[i] as number)) / (t(j) - t(i));
  const a = (alongs[i] as number) - b * t(i);
  let agreeing = 0;
  let maxInlierResidual = 0;
  fit.values.forEach((v, k) => {
    const lab = labels[k] as ReadLabel;
    if (v === null) return;
    const res = Math.abs((alongs[k] as number) - (a + b * t(k)));
    lab.residualPx = res;
    lab.inlier = fit.inliers.includes(k);
    if (res <= tol) agreeing++;
    if (lab.inlier) maxInlierResidual = Math.max(maxInlierResidual, res);
  });
  const n = readable;
  const k = fit.inliers.length;
  if (maxInlierResidual > 2 * tol || agreeing < 0.6 * n) {
    return fallback(
      `Cross-check failed: the refs predict only ${agreeing} of ${n} labels (largest error ${maxInlierResidual.toFixed(1)} px).`,
    );
  }
  const ocr = mean(read.map((q) => (labels[q] as ReadLabel).confidence));
  const outliers = n - k;
  const high = outliers <= Math.max(1, Math.floor(0.2 * n)) && certain && ocr >= 0.6 && read.length >= 3;
  const level: ConfidenceLevel = high ? 'high' : 'medium';
  const confidence = Math.min(1, (k / n) * ocr * Math.min(1, k / 4) * (certain ? 1 : 0.7));
  const li = labels[i] as ReadLabel;
  const lj = labels[j] as ReadLabel;
  const scaleWord = fit.scale === 'log10' ? 'log' : fit.scale;
  return {
    ...base,
    status: 'calibrated',
    level,
    confidence,
    scale: fit.scale,
    scaleCertain: certain,
    refs: [
      { px: li.point.x, py: li.point.y, value: refValueText(fit.scale, fit.values[i] as number) },
      { px: lj.point.x, py: lj.point.y, value: refValueText(fit.scale, fit.values[j] as number) },
    ],
    maxResidualPx: maxInlierResidual,
    message:
      `${k} of ${labels.length} labels agree on a ${scaleWord} scale${certain ? '' : ' (scale uncertain)'}` +
      (outliers > 0 ? `; ${outliers} disagree${outliers === 1 ? 's' : ''}` : '') +
      `; largest error ${maxInlierResidual.toFixed(1)} px.` +
      (fit.inferred.length > 0 ? ` ${fit.inferred.length} unread exponent${fit.inferred.length === 1 ? '' : 's'} inferred from position.` : '') +
      (r.note ? ` The axis note "${r.note.text}" is applied.` : ''),
  };
}

/**
 * The 2-D cross-check: calibrate from both axes' refs with the engine and re-predict every
 * agreeing label at its tick. A failure downgrades both axes to "low" (positions fallback).
 */
export function crossCheck(xIn: AxisSuggestion, yIn: AxisSuggestion): { x: AxisSuggestion; y: AxisSuggestion; ok: boolean } {
  // Copies: the residuals below are written into the labels.
  const x = { ...xIn, labels: xIn.labels.map((l) => ({ ...l })) };
  const y = { ...yIn, labels: yIn.labels.map((l) => ({ ...l })) };
  if (x.status !== 'calibrated' || y.status !== 'calibrated' || !x.refs || !y.refs || !x.scale || !y.scale) {
    return { x, y, ok: false };
  }
  const ref = (r: SuggestedRef) => ({ px: r.px, py: r.py, value: r.value });
  const refs: CalibrationRefs = { X1: ref(x.refs[0]), X2: ref(x.refs[1]), Y1: ref(y.refs[0]), Y2: ref(y.refs[1]) };
  const res = calibrate(refs, x.scale, y.scale);
  const downgrade = (s: AxisSuggestion, why: string): AxisSuggestion => ({
    ...s,
    status: s.refs ? 'positions' : 'none',
    level: 'low',
    refs: s.refs ? [{ ...s.refs[0], value: '' }, { ...s.refs[1], value: '' }] : null,
    message: why,
  });
  if (!res.ok) {
    const why = `The suggested refs do not make a calibration: ${res.error.message}`;
    return { x: downgrade(x, why), y: downgrade(y, why), ok: false };
  }
  const cal = res.calibration;
  const tolX = tolerance(x.labels.map((l) => l.along), x.mode);
  const tolY = tolerance(y.labels.map((l) => l.along), y.mode);
  const check = (s: AxisSuggestion, tol: number) => {
    let worst = 0;
    for (const l of s.labels) {
      if (!l.inlier || l.value === null) continue;
      const v = cal.pixelToValue(l.point.x, l.point.y);
      const q = s.axis === 'x' ? (v.y === null ? null : cal.valueToPixel(l.value, v.y)) : v.x === null ? null : cal.valueToPixel(v.x, l.value);
      const r = q ? Math.hypot(q.px - l.point.x, q.py - l.point.y) : Infinity;
      l.residualPx = Number.isFinite(r) ? r : null;
      worst = Math.max(worst, r);
    }
    return worst <= 2 * tol ? null : worst;
  };
  const wx = check(x, tolX);
  const wy = check(y, tolY);
  if (wx !== null || wy !== null) {
    const why = `Cross-check failed: the 2-D fit misses a label by ${Math.max(wx ?? 0, wy ?? 0).toFixed(1)} px.`;
    return { x: downgrade(x, why), y: downgrade(y, why), ok: false };
  }
  return { x, y, ok: true };
}
