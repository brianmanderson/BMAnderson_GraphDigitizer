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
import { parseAxisNote, parseNumberLabel, restorePoints } from './parseLabel.ts';
import { crossCheck, suggestAxis, type AutoCalibration, type AxisReading, type OcrLabel } from './suggest.ts';
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

/** Numeric reading of one label: exponent joined, a dropped minus sign restored. */
async function readNumeric(ocr: OcrEngine, l: FoundLabel): Promise<OcrLabel> {
  const fixSign = (text: string, minus: boolean) => {
    const t = text.trim();
    return minus && !/^[-−–]/.test(t) ? `-${t}` : t;
  };
  if (l.base && l.exponent) {
    const [b, e] = await Promise.all([
      ocr.recognize(l.base, { charset: 'numeric', singleChar: false }),
      ocr.recognize(l.exponent, { charset: 'numeric', singleChar: l.exponentSingleChar }),
    ]);
    const exp = fixSign(e.text, l.exponentMinus);
    return { text: `${restorePoints(fixSign(b.text, l.minus), l.marks)}^${exp}`, confidence: conf(Math.min(b.confidence, e.confidence)) };
  }
  const r = await ocr.recognize(l.crop, { charset: 'numeric', singleChar: l.singleChar });
  return { text: restorePoints(fixSign(r.text, l.minus), l.marks), confidence: conf(r.confidence) };
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
  const readAxis = async (labels: AxisLabels) => {
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
    // a number may be a month name, which makes this a date axis.
    const incomplete = numeric.some((n) => parseNumberLabel(n.text) === null);
    if ((s.level !== 'high' || incomplete) && labels.labels.length >= 2) {
      const text = await Promise.all(labels.labels.map((l) => readText(counted, l)));
      reading = { ...reading, text };
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
