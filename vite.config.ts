import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

/**
 * Public base path, from BASE_PATH (default '/'). GitHub Pages serves a project site under
 * /<repo>/, so the deploy workflow builds with BASE_PATH=/UCSD_GraphEvaluator/. It is a
 * build-time (and `vite preview`) setting only: the dev server and the e2e suite assume the
 * app is at '/'. Everything else derives from it — Vite rewrites asset and worker URLs, and
 * src/ui/ocr.ts builds the Tesseract URLs from import.meta.env.BASE_URL.
 */
const base = process.env.BASE_PATH || '/';

/**
 * Tesseract.js runtime files, served by the app itself under <base>tesseract/ (dev server) and
 * copied into dist/tesseract/ (build): its worker script, the LSTM-only WASM cores (Tesseract
 * picks one by CPU features) and the English "best_int" language data. Nothing is fetched from
 * a CDN, so OCR works offline and images never leave the browser.
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
      server.middlewares.use(`${server.config.base}tesseract/`, (req, res, next) => {
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

/**
 * Build facts for the session log's header (src/ui/sessionLog.ts): the package version and the
 * git commit being built — from `git rev-parse HEAD`, else GITHUB_SHA (CI), else "unknown", so a
 * build without git (a source tarball) still works.
 */
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
function gitCommit(): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^[0-9a-f]{40}$/.test(out)) return out;
  } catch {
    // git missing or not a repository: fall through.
  }
  return /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA! : 'unknown';
}

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [react(), tesseractAssets()],
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts', 'bench/**/*.test.ts'],
    environment: 'node',
    // A DST-observing zone, so date tests prove the engine ignores the host time zone.
    env: { TZ: 'America/New_York' },
  },
});
