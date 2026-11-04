/**
 * Running auto-calibration from the page (Phase 5): the pipeline runs in a module worker
 * (src/workers/auto.worker.ts) and asks the page for OCR, which a lazily created pool of
 * Tesseract.js workers answers (src/ui/ocr.ts, loaded on first use only). The pool is kept for
 * later runs, so only the first one pays for loading the language data.
 */

import type { AutoCalibration, RgbaImage } from '../auto/index.ts';
import type { TesseractPool } from '../ocr/pool.ts';
import type { WorkerIn, WorkerOut } from '../workers/auto.worker.ts';

let pool: Promise<TesseractPool> | null = null;

function ocrPool(): Promise<TesseractPool> {
  pool ??= import('./ocr.ts').then(({ browserOcrPool }) => {
    const p = browserOcrPool(Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
    return p.ready().then(() => p);
  });
  pool.catch(() => {
    pool = null;
  });
  return pool;
}

export interface AutoRun {
  result: Promise<AutoCalibration>;
  cancel: () => void;
}

/** Start auto-calibration on decoded pixels; `onProgress` gets short user-facing stages. */
export function runAutoDetect(pixels: ImageData, onProgress: (stage: string) => void): AutoRun {
  const worker = new Worker(new URL('../workers/auto.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  const result = new Promise<AutoCalibration>((resolve, reject) => {
    const finish = () => {
      settled = true;
      worker.terminate();
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'The auto-detect worker failed.'));
    };
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.stage);
      else if (m.type === 'done') {
        finish();
        resolve(m.result);
      } else if (m.type === 'error') {
        finish();
        reject(new Error(m.message));
      } else {
        onProgress('Reading the tick labels…');
        ocrPool()
          .then((p) => p.recognize(m.image, m.request))
          .then(
            (r) => !settled && worker.postMessage({ type: 'ocr-result', id: m.id, result: r } satisfies WorkerIn),
            (err: unknown) => {
              finish();
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
      }
    };
    const image: RgbaImage = { width: pixels.width, height: pixels.height, data: pixels.data };
    worker.postMessage({ type: 'run', image } satisfies WorkerIn);
  });
  return {
    result,
    cancel: () => {
      if (!settled) worker.terminate();
      settled = true;
    },
  };
}
