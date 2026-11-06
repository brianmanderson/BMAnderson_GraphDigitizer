/**
 * Tesseract.js in the browser (Phase 5). Imported lazily (dynamic import) by autoDetect.ts, so
 * neither this module nor Tesseract.js is part of the first-paint bundle. Every runtime file
 * comes from this app's own tesseract/ path under its base URL (vite.config.ts →
 * tesseract-assets): no CDN.
 */

import { createWorker, OEM } from 'tesseract.js';
import type { RgbaImage } from '../auto/index.ts';
import { TesseractPool } from '../ocr/pool.ts';

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const pixels = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  c.getContext('2d')?.putImageData(pixels, 0, 0);
  return c;
}

export function browserOcrPool(size: number): TesseractPool {
  const base = new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.href).href;
  return new TesseractPool({
    size,
    create: () =>
      createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base,
        gzip: true,
        // The data is served locally; caching a second copy in IndexedDB would only cost space.
        cacheMethod: 'none',
      }),
    toImage: toCanvas,
  });
}
