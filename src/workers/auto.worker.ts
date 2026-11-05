/**
 * Web Worker for auto-calibration (Phase 5) and auto-trace: runs the pure pipelines (src/auto)
 * off the main thread. OCR requests go back to the page, which owns the Tesseract.js workers
 * (nested workers are not available everywhere), as `{ type: 'ocr' }` messages answered by
 * `ocr-result`. A trace finds the plot box with `detectAxes` first and passes its corners on.
 *
 * Messages in:  { type: 'run', image: RgbaImage } | { type: 'ocr-result', id, result }
 *               | { type: 'trace', image, seed, mode, maxPoints }
 * Messages out: { type: 'progress', stage } | { type: 'ocr', id, image, request }
 *               | { type: 'done', result: AutoCalibration } | { type: 'traced', result: TraceResult }
 *               | { type: 'error', message }
 */

import { autoCalibrate, detectAxes, type OcrEngine, type OcrLabel, type OcrRequest, type RgbaImage } from '../auto/index.ts';
import type { TraceRequest, TraceResult } from '../auto/trace/types.ts';
import { traceLine } from './traceImpl.ts';

export type WorkerIn =
  | { type: 'run'; image: RgbaImage }
  | { type: 'ocr-result'; id: number; result: OcrLabel }
  | { type: 'trace'; image: RgbaImage & { data: Uint8ClampedArray }; seed: TraceRequest['seed']; mode: TraceRequest['mode']; maxPoints: number };
export type WorkerOut =
  | { type: 'progress'; stage: string }
  | { type: 'ocr'; id: number; image: RgbaImage; request: OcrRequest }
  | { type: 'done'; result: Awaited<ReturnType<typeof autoCalibrate>> }
  | { type: 'traced'; result: TraceResult }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  postMessage: (message: WorkerOut) => void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let nextId = 0;
const pending = new Map<number, (r: OcrLabel) => void>();

const ocr: OcrEngine = {
  recognize: (image: RgbaImage, request: OcrRequest) =>
    new Promise<OcrLabel>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      scope.postMessage({ type: 'ocr', id, image, request });
    }),
};

const fail = (err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });

/** The trace request for an image: the detected plot box's corners, or null when none was found. */
function traceRequest(m: Extract<WorkerIn, { type: 'trace' }>): TraceRequest {
  const box = detectAxes(m.image).plotBox;
  const plotBox: [number, number][] | null = box
    ? [box.topLeft, box.topRight, box.bottomRight, box.bottomLeft].map((p): [number, number] => [p.x, p.y])
    : null;
  const { width, height, data } = m.image;
  return { rgba: data, width, height, plotBox, seed: m.seed, mode: m.mode, maxPoints: m.maxPoints };
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ocr-result') {
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
    return;
  }
  if (m.type === 'trace') {
    // The engine may be synchronous or return a promise.
    Promise.resolve()
      .then(() => traceLine(traceRequest(m)))
      .then((result) => scope.postMessage({ type: 'traced', result }), fail);
    return;
  }
  autoCalibrate(m.image, ocr, {
    now: () => performance.now(),
    onProgress: (stage) => scope.postMessage({ type: 'progress', stage }),
  }).then((result) => scope.postMessage({ type: 'done', result }), fail);
};
