/**
 * Auto-calibration (Phase 5): detect axes → find tick labels → OCR them → infer scales → suggest
 * refs → cross-check. Pure TS, no DOM: OCR is injected (`OcrEngine`), so the same pipeline runs
 * in the app's worker (Tesseract.js in the browser) and in the benchmark (Tesseract.js in Node).
 *
 * OCR passes. Every label is first read with a numeric character set (digits, sign, point,
 * comma, e/E, ×/x, %). A raised exponent is read on its own and joined as `base^exp`, and a minus
 * sign or decimal point that the layout shows but OCR dropped is restored. When the numeric reading of an axis
 * does not give a confident calibration, its labels are read again as free text (month names,
 * years, full dates) and the better interpretation wins.
 */

import { darknessMap } from './darkness.ts';
import { detectAxesInMap } from './detect.ts';
import { findLabels, type AxisLabels, type FoundLabel } from './labels.ts';
import { parseAxisNote, parseNumberLabel, restorePoints, splitAffixes } from './parseLabel.ts';
import { crossCheck, suggestAxis, type AutoCalibration, type AxisReading, type AxisSuggestion, type OcrLabel } from './suggest.ts';
import type { AxisDetection, RgbaImage } from './types.ts';

export type OcrCharset = 'numeric' | 'text';

export interface OcrRequest {
  charset: OcrCharset;
  /** The image holds a single character (OCR in single-character mode). */
  singleChar: boolean;
}

/** Recognises one line of text; confidence 0–1. */
export interface OcrEngine {
  recognize(image: RgbaImage, request: OcrRequest): Promise<OcrLabel>;
}

export interface AutoOptions {
  /** Clock for the timings (ms); defaults to Date.now. */
  now?: () => number;
  /** Progress callback: a short user-facing description of the current stage. */
  onProgress?: (stage: string) => void;
}

const conf = (c: number) => Math.max(0, Math.min(1, c));

const fixSign = (text: string, minus: boolean) => {
  const t = text.trim();
  return minus && !/^[-−–]/.test(t) ? `-${t}` : t;
};

/** The reading with the layout's marks put back, and the other reading where a point is only possible. */
function withMarks(raw: string, confidence: number, l: FoundLabel, suffix = ''): OcrLabel {
  const text = restorePoints(fixSign(raw, l.minus), l.marks) + suffix;
  // A possible point (small text): the other reading, for the axis's other labels to decide.
  const other = l.marks.uncertain?.length ? restorePoints(fixSign(raw, l.minus), l.marks, true) + suffix : text;
  return other === text ? { text, confidence } : { text, confidence, alternatives: [other] };
}

/**
 * A reading with fewer characters than the label shows dropped one ("20" read as "0", "20k" as
 * "20"): Tesseract does that at 95 % confidence. Points, commas and the leading minus are not
 * counted on either side.
 */
export function droppedCharacters(o: OcrLabel, l: FoundLabel): boolean {
  if (l.runs === undefined) return false;
  const base = (o.text.split('^')[0] ?? '').replace(/[.,\s]/g, '');
  const chars = l.minus ? base.replace(/^[-−–]/, '') : base;
  return chars.length < l.runs;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

/**
 * One label's numeric reading after it was also read as free text. The numeric character set
 * cannot show a currency sign or an SI suffix (`$1,000` comes back as `%1,000`, `20k` as `20`
 * with confidence 0): those come from the text reading, with the digits both readings agree on.
 * Otherwise the numeric reading stands unless it dropped a character and the text reading did not.
 */
function reconcile(n: OcrLabel, t: OcrLabel, l: FoundLabel): OcrLabel {
  if (l.base && l.exponent) return n;
  const parts = splitAffixes(t.text);
  if (parts.affixed && /^[-−–+]?[\d.,\s]*\d$/.test(parts.body)) {
    const suffix = parts.multiplier === 1 ? '' : t.text.trim().slice(-1);
    const dt = digitsOf(parts.body);
    const dn = digitsOf(n.text);
    // The numeric pass reads the affix as nothing, or as one more character (`%`, a digit).
    const agree = dn === dt || (dn.length === dt.length + 1 && (dn.startsWith(dt) || dn.endsWith(dt)));
    return withMarks(parts.body.replace(/\s+/g, ''), conf(agree ? t.confidence : 0.5 * t.confidence), l, suffix);
  }
  if (parseNumberLabel(n.text) !== null && !droppedCharacters(n, l)) return n;
  const again = withMarks(t.text, conf(t.confidence), l);
  if (parseNumberLabel(again.text) !== null && !droppedCharacters(again, l)) return again;
  // The numeric reading lost characters that the text reading shows are not digits ("Q1 2000"
  // read as "12000"): the label is not a number, and its digits are no value.
  if (droppedCharacters(n, l) && t.text.trim() !== '' && !droppedCharacters(t, l)) return { text: t.text.trim(), confidence: conf(t.confidence) };
  return n;
}

/** Space between a base and its exponent read together, px of the (upscaled) crops. */
const JOIN_GAP = 8;
/** Confidence cap of an exponent read beside its base (refs need 0.75). */
const JOINED_CONFIDENCE = 0.7;

/** Two crops side by side, vertically centred, `gap` px apart, on white. */
function beside(a: RgbaImage, b: RgbaImage, gap: number): RgbaImage {
  const height = Math.max(a.height, b.height);
  const width = a.width + gap + b.width;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (img: RgbaImage, x0: number) => {
    const y0 = Math.round((height - img.height) / 2);
    for (let j = 0; j < img.height; j++) data.set(img.data.subarray(j * img.width * 4, (j + 1) * img.width * 4), ((j + y0) * width + x0) * 4);
  };
  put(a, 0);
  put(b, a.width + gap);
  return { width, height, data };
}

/** Numeric reading of one label: exponent joined, a dropped minus sign restored. */
async function readNumeric(ocr: OcrEngine, l: FoundLabel): Promise<OcrLabel> {
  if (l.base && l.exponent) {
    const [b, e] = await Promise.all([
      ocr.recognize(l.base, { charset: 'numeric', singleChar: false }),
      ocr.recognize(l.exponent, { charset: 'numeric', singleChar: l.exponentSingleChar }),
    ]);
    // A power's base is 10 (or m×10). Anything else was no base + exponent: a digit standing a
    // little high ("-4993", a monospace "70", "100000") was taken for one. Read the word whole —
    // unless that reads "10…": a power whose base was misread ("10-", "0") reads whole as "102" for
    // 10⁻², and three of those (102, 101, 100) would agree on a line.
    if (!/(^|[x×*·])10$/.test(b.text.trim().replace(/^[-−–]/, ''))) {
      const r = await ocr.recognize(l.crop, { charset: 'numeric', singleChar: l.singleChar });
      if (!/^[-−–+]?10/.test(r.text.trim())) return withMarks(r.text, conf(r.confidence), l);
      return { text: `${b.text.trim()}^${e.text.trim()}`, confidence: 0 };
    }
    let exp = e.text.trim();
    let confidence = Math.min(b.confidence, e.confidence);
    let guessed = false;
    // A lone "1" as an exponent often comes back empty, but not beside its base at the same
    // scale ("10" + "1" reads "101"). A second guess: below the confidence that makes a ref.
    if (exp === '' || exp === '-') {
      const j = await ocr.recognize(beside(l.base, l.exponent, JOIN_GAP), { charset: 'numeric', singleChar: false });
      const t = j.text.trim();
      if (t.startsWith(b.text.trim()) && t.length > b.text.trim().length) {
        exp = t.slice(b.text.trim().length);
        confidence = Math.min(b.confidence, j.confidence, JOINED_CONFIDENCE);
        guessed = true;
      }
    }
    const text = `${restorePoints(fixSign(b.text, l.minus), l.marks)}^${fixSign(exp, l.exponentMinus)}`;
    return guessed ? { text, confidence: conf(confidence), guessed } : { text, confidence: conf(confidence) };
  }
  const r = await ocr.recognize(l.crop, { charset: 'numeric', singleChar: l.singleChar });
  return withMarks(r.text, conf(r.confidence), l);
}

async function readText(ocr: OcrEngine, l: FoundLabel): Promise<OcrLabel> {
  const r = await ocr.recognize(l.crop, { charset: 'text', singleChar: l.singleChar });
  return { text: r.text.trim(), confidence: conf(r.confidence) };
}

/** Minimum OCR confidence for an axis note to be applied. */
const NOTE_CONFIDENCE = 0.5;

/**
 * The axis note, read both ways: the first reading that parses as an offset/multiplier with
 * confidence wins. Text that reads as a word (a title or units above the Y axis: two or more
 * letters other than the lookalikes e, x, l, I, o, O) is no note: null. Otherwise the unusable
 * numeric reading is returned with confidence 0, so the suggestion can say a note is there.
 */
async function readNote(ocr: OcrEngine, l: FoundLabel): Promise<OcrLabel | null> {
  const [n, t] = await Promise.all([readNumeric(ocr, l), readText(ocr, l)]);
  for (const r of [n, t]) if (r.confidence >= NOTE_CONFIDENCE && parseAxisNote(r.text)) return r;
  if ((t.text.match(/[a-df-km-np-wyzA-HJ-NP-Z]/g) ?? []).length >= 2) return null;
  return { text: n.text || t.text, confidence: 0 };
}

function readingBase(det: AxisDetection, labels: AxisLabels): Omit<AxisReading, 'numeric' | 'text' | 'note'> {
  const ax = labels.axis === 'x' ? det.xAxis : det.yAxis;
  const ticks = ax && labels.mode === 'ticks' ? ax.ticks.ticks.filter((t) => t.kind === 'major').sort((a, b) => a.along - b.along) : [];
  // Without tick marks, the labels that sit on gridlines give exact positions to fall back on.
  const onGrid = labels.mode === 'labels-only' ? labels.labels.filter((l) => l.gridline) : [];
  return {
    labels,
    logHint: ax?.ticks.pattern === 'log',
    line: ax ? { p1: ax.line.p1, p2: ax.line.p2 } : null,
    tickPoints: ticks.length ? ticks.map((t) => t.point) : onGrid.length >= 2 ? onGrid.map((l) => l.point) : [],
    positionsFrom: ticks.length ? 'ticks' : 'gridlines',
  };
}

export async function autoCalibrate(img: RgbaImage, ocr: OcrEngine, opts: AutoOptions = {}): Promise<AutoCalibration> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  opts.onProgress?.('Finding the axes…');
  const map = darknessMap(img);
  const detection = detectAxesInMap(map);
  const t1 = now();
  const found = findLabels(map, img, detection);
  const t2 = now();
  let calls = 0;
  const counted: OcrEngine = {
    recognize: (image, request) => {
      calls++;
      return ocr.recognize(image, request);
    },
  };

  opts.onProgress?.('Reading the tick labels…');
  const readAxis = async (labels: AxisLabels): Promise<AxisSuggestion> => {
    const s = await readLabels(labels);
    // Labels that may be rotated text: their rotated reading, if the upright one gives nothing.
    if (s.level !== 'low' || !labels.alternative) return s;
    const r = await readLabels(labels.alternative);
    return r.level !== 'low' ? r : s;
  };
  const readLabels = async (labels: AxisLabels) => {
    const base = readingBase(detection, labels);
    // A note tangled with the other axis's labels is shown as read but never applied.
    const note = labels.note
      ? labels.noteTangled
        ? readNumeric(counted, labels.note).then((r) => ({ text: r.text, confidence: 0 }))
        : readNote(counted, labels.note)
      : Promise.resolve(null);
    const [numeric, noteRead] = await Promise.all([Promise.all(labels.labels.map((l) => readNumeric(counted, l))), note]);
    let reading: AxisReading = { ...base, numeric, text: null, note: noteRead };
    let s = suggestAxis(reading);
    // Read as text too unless the numeric reading is confident and complete: a label that is not
    // a number may be a month name, which makes this a date axis, and one whose reading has fewer
    // characters than the label shows may have a unit suffix (`20k`) that only text mode can read.
    const incomplete = numeric.some((n, i) => parseNumberLabel(n.text) === null || droppedCharacters(n, labels.labels[i] as FoundLabel));
    if ((s.level !== 'high' || incomplete) && labels.labels.length >= 2) {
      const text = await Promise.all(labels.labels.map((l) => readText(counted, l)));
      reading = { ...reading, numeric: numeric.map((n, i) => reconcile(n, text[i] as OcrLabel, labels.labels[i] as FoundLabel)), text };
      s = suggestAxis(reading);
    }
    return s;
  };
  const [sx, sy] = await Promise.all([readAxis(found.x), readAxis(found.y)]);
  const t3 = now();
  const checked = crossCheck(sx, sy);
  const ok = checked.ok && checked.x.level !== 'low' && checked.y.level !== 'low';
  return {
    width: img.width,
    height: img.height,
    detection,
    x: checked.x,
    y: checked.y,
    ok,
    timings: { detectMs: t1 - t0, labelsMs: t2 - t1, ocrMs: t3 - t2, totalMs: now() - t0, ocrCalls: calls },
  };
}
