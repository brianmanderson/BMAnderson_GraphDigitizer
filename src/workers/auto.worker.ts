/**
 * Web Worker for auto-calibration (Phase 5): runs the pure pipeline (src/auto) off the main
 * thread. OCR requests go back to the page, which owns the Tesseract.js workers (nested workers
 * are not available everywhere), as `{ type: 'ocr' }` messages answered by `ocr-result`.
 *
 * Messages in:  { type: 'run', image: RgbaImage } | { type: 'ocr-result', id, result }
 * Messages out: { type: 'progress', stage } | { type: 'ocr', id, image, request }
 *               | { type: 'done', result: AutoCalibration } | { type: 'error', message }
 */

import { autoCalibrate, type OcrEngine, type OcrLabel, type OcrRequest, type RgbaImage } from '../auto/index.ts';

export type WorkerIn = { type: 'run'; image: RgbaImage } | { type: 'ocr-result'; id: number; result: OcrLabel };
export type WorkerOut =
  | { type: 'progress'; stage: string }
  | { type: 'ocr'; id: number; image: RgbaImage; request: OcrRequest }
  | { type: 'done'; result: Awaited<ReturnType<typeof autoCalibrate>> }
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

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ocr-result') {
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
    return;
  }
  autoCalibrate(m.image, ocr, {
    now: () => performance.now(),
    onProgress: (stage) => scope.postMessage({ type: 'progress', stage }),
  }).then(
    (result) => scope.postMessage({ type: 'done', result }),
    (err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
};
