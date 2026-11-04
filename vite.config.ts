import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

/**
 * Tesseract.js runtime files, served by the app itself under /tesseract/ (dev server) and copied
 * into dist/tesseract/ (build): its worker script, the LSTM-only WASM cores (Tesseract picks one
 * by CPU features) and the English "best_int" language data. Nothing is fetched from a CDN, so
 * OCR works offline and images never leave the browser.
 */
const TESSERACT_FILES: Record<string, string> = {
  'worker.min.js': join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'),
  'tesseract-core-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'),
  'tesseract-core-simd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'),
  'tesseract-core-relaxedsimd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-relaxedsimd-lstm.wasm.js'),
  // Tesseract gunzips it itself: served as plain bytes, never with Content-Encoding.
  'eng.traineddata.gz': join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
};

function tesseractAssets(): Plugin {
  return {
    name: 'tesseract-assets',
    configureServer(server) {
      server.middlewares.use('/tesseract/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        const file = TESSERACT_FILES[name];
        if (!file) return next();
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.setHeader('Cache-Control', 'max-age=3600');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [name, file] of Object.entries(TESSERACT_FILES)) {
        this.emitFile({ type: 'asset', fileName: `tesseract/${name}`, source: readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tesseractAssets()],
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // A DST-observing zone, so date tests prove the engine ignores the host time zone.
    env: { TZ: 'America/New_York' },
  },
});
