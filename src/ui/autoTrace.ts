/**
 * Running an auto-trace from the page: the tracer runs in the auto worker
 * (src/workers/auto.worker.ts, `trace` message), never on the main thread. Each run has its own
 * worker, so cancelling (a re-run with other settings, Discard) just terminates it.
 */

import type { TraceMode, TraceResult } from '../auto/trace/types.ts';
import type { WorkerIn, WorkerOut } from '../workers/auto.worker.ts';

export interface TraceRun {
  result: Promise<TraceResult>;
  cancel: () => void;
}

export function runTrace(pixels: ImageData, seed: { px: number; py: number }, mode: TraceMode, maxPoints: number): TraceRun {
  const worker = new Worker(new URL('../workers/auto.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  const result = new Promise<TraceResult>((resolve, reject) => {
    const finish = () => {
      settled = true;
      worker.terminate();
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'The trace worker failed.'));
    };
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'traced') {
        finish();
        resolve(m.result);
      } else if (m.type === 'error') {
        finish();
        reject(new Error(m.message));
      }
    };
    const image = { width: pixels.width, height: pixels.height, data: pixels.data };
    worker.postMessage({ type: 'trace', image, seed, mode, maxPoints } satisfies WorkerIn);
  });
  return {
    result,
    cancel: () => {
      if (!settled) worker.terminate();
      settled = true;
    },
  };
}
