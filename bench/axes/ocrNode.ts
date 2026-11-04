/**
 * Tesseract.js in Node for the benchmark: the same pool and language data the app uses
 * (@tesseract.js-data/eng, LSTM "best_int" model), read from node_modules — no network.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pngjs from 'pngjs';
import { createWorker, OEM } from 'tesseract.js';
import type { RgbaImage } from '../../src/auto/index.ts';
import { TesseractPool } from '../../src/ocr/pool.ts';

const require = createRequire(import.meta.url);
export const LANG_PATH = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

function toPng(img: RgbaImage): Buffer {
  const png = new pngjs.PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  return pngjs.PNG.sync.write(png);
}

export function nodeOcrPool(size: number): TesseractPool {
  return new TesseractPool({
    size,
    create: () => createWorker('eng', OEM.LSTM_ONLY, { langPath: LANG_PATH, cacheMethod: 'none' }),
    toImage: toPng,
  });
}
