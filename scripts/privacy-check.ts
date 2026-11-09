/**
 * Privacy check of the production build: proves, on the record, that the app makes no network
 * request outside its own origin — the page bundle, CSS, the worker chunk and the vendored
 * Tesseract files are everything it fetches — through a full session: load a real figure,
 * Auto-detect axes (OCR in a worker), accept, Auto-trace the curve, accept, Download CSV, Save
 * project and Download session log (all captured in the page, nothing is written to Downloads).
 *
 *   npm run privacy:check                 build, then check; writes ./privacy-report.json
 *   npm run privacy:check -- --no-build   check the dist/ that is already there
 *   npm run privacy:check -- --out path   write the report elsewhere
 *
 * Requests are captured over the Chrome DevTools Protocol on a connection of our own (not
 * Playwright's), with Network.enable on the page target AND on every worker target: the browser
 * auto-attaches new targets paused (waitForDebuggerOnStart), Network is enabled on each before it
 * is resumed, so a worker's very first request is seen. The report lists every request with the
 * type of target that issued it; the check fails unless the worker-initiated Tesseract requests
 * (WASM core, language data) are among them, because a passing list that never saw the workers
 * would prove nothing. Exit code 1 on any request to another origin (data: and blob: excepted),
 * on an incomplete capture, or on a failed own-origin request.
 *
 * BASE_PATH is honoured as for `npm run build`/`preview` (vite.config.ts). Never uses port 5174
 * (the e2e server) or 5173 (the dev server); preview and the debugging endpoint get free ports.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { dropFile, imageToClient } from '../e2e/helpers.ts';
import { buildReport, summarize, type CapturedRequest, type PrivacyReport, type ReportMeta } from './privacy/report.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BASE = process.env.BASE_PATH || '/';
const FIXTURE = 'real/km-pericardial-pao.png';
/**
 * A pixel on the black series' curve: its final plateau (y = 0.680) runs columns 526–648 at row 186
 * (image pixels, integer = pixel centre; see fixtures/real/km-pericardial-pao.json).
 */
const CURVE_PX = { px: 590, py: 186 };
const OCR_TIMEOUT = 60_000;

// ---- arguments ------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const NO_BUILD = flag('--no-build');
const OUT = resolve(option('--out') ?? 'privacy-report.json');

// ---- helpers --------------------------------------------------------------------------------

const log = (msg: string) => console.log(`[privacy] ${msg}`);

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

const binOf = (pkg: string, rel: string) => join(dirname(require.resolve(`${pkg}/package.json`)), rel);
const VITE = binOf('vite', 'bin/vite.js');
const TSC = binOf('typescript', 'bin/tsc');

/** `npm run build` without the shell: tsc -b && vite build. */
function build() {
  for (const [label, argv] of [
    ['tsc -b', [TSC, '-b']],
    ['vite build', [VITE, 'build']],
  ] as const) {
    log(label);
    const r = spawnSync(process.execPath, [...argv], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
  }
}

async function startPreview(port: number): Promise<{ child: ChildProcess; origin: string; output: () => string }> {
  const child = spawn(process.execPath, [VITE, 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite preview exited with ${child.exitCode}:\n${out}`);
    try {
      const r = await fetch(origin + BASE);
      if (r.ok) return { child, origin, output: () => out };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vite preview did not answer on ${origin} within 30 s:\n${out}`);
}

// ---- CDP capture ----------------------------------------------------------------------------

interface CdpMessage {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/**
 * Our own CDP connection to the browser endpoint. Every target the browser auto-attaches (the
 * page, then each worker it starts) gets Network enabled and auto-attach of its own before it is
 * allowed to run; request events are merged by requestId into CapturedRequest records.
 */
class Capture {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private readonly sessions = new Map<string, { type: string; url: string }>();
  private readonly byId = new Map<string, CapturedRequest>();
  private readonly inFlight = new Set<string>();
  readonly requests: CapturedRequest[] = [];
  readonly problems: string[] = [];

  static async connect(debugPort: number): Promise<Capture> {
    const version = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const c = new Capture();
    c.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('could not open the CDP WebSocket'));
    });
    c.ws.onmessage = (ev) => c.onMessage(JSON.parse(String(ev.data)) as CdpMessage);
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private onMessage(m: CdpMessage) {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.error) p.rej(new Error(`${m.error.message}`));
      else p.res(m.result);
      return;
    }
    const params = m.params ?? {};
    switch (m.method) {
      case 'Target.attachedToTarget':
        void this.onAttached(params as { sessionId: string; targetInfo: { type: string; url: string }; waitingForDebugger: boolean });
        break;
      case 'Target.detachedFromTarget':
        this.sessions.delete((params as { sessionId: string }).sessionId);
        break;
      case 'Network.requestWillBeSent':
        this.onRequest(m.sessionId ?? '', params as unknown as RequestWillBeSent);
        break;
      case 'Network.responseReceived': {
        const { requestId, response } = params as { requestId: string; response: { status: number; mimeType: string; fromDiskCache?: boolean; fromPrefetchCache?: boolean } };
        const r = this.byId.get(requestId);
        if (!r) break;
        r.status = response.status;
        r.mimeType = response.mimeType || null;
        r.fromCache = !!(response.fromDiskCache || response.fromPrefetchCache);
        break;
      }
      case 'Network.loadingFinished': {
        const { requestId, encodedDataLength } = params as { requestId: string; encodedDataLength: number };
        const r = this.byId.get(requestId);
        if (r) r.bytes = encodedDataLength >= 0 ? encodedDataLength : null;
        this.inFlight.delete(requestId);
        break;
      }
      case 'Network.loadingFailed': {
        const { requestId, errorText, canceled } = params as { requestId: string; errorText: string; canceled?: boolean };
        const r = this.byId.get(requestId);
        if (r) r.error = canceled ? `canceled (${errorText})` : errorText;
        this.inFlight.delete(requestId);
        break;
      }
    }
  }

  private async onAttached(p: { sessionId: string; targetInfo: { type: string; url: string }; waitingForDebugger: boolean }) {
    this.sessions.set(p.sessionId, { type: p.targetInfo.type, url: p.targetInfo.url });
    try {
      await this.send('Network.enable', {}, p.sessionId);
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, p.sessionId);
    } catch (e) {
      // A target that closed before we got to it is harmless; anything else means the capture
      // may have holes, which the verdict reports.
      this.problems.push(`${p.targetInfo.type} ${p.targetInfo.url}: ${(e as Error).message}`);
    } finally {
      if (p.waitingForDebugger) await this.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => undefined);
    }
  }

  private onRequest(sessionId: string, p: RequestWillBeSent) {
    const session = this.sessions.get(sessionId);
    const previous = this.byId.get(p.requestId);
    if (previous && p.redirectResponse) previous.status = p.redirectResponse.status;
    const r: CapturedRequest = {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      target: session?.type ?? 'unknown',
      targetUrl: session && session.type !== 'page' ? session.url : null,
      resourceType: p.type ?? 'Other',
      initiator: p.initiator?.type ?? 'unknown',
      status: null,
      mimeType: null,
      bytes: null,
      fromCache: false,
      error: null,
    };
    this.byId.set(p.requestId, r);
    this.requests.push(r);
    this.inFlight.add(p.requestId);
  }

  /** Resolve once no request has been in flight for `quiet` ms (or give up after `max` ms). */
  async settle(quiet = 1000, max = 15_000): Promise<void> {
    const start = Date.now();
    let quietSince = Date.now();
    while (Date.now() - start < max) {
      if (this.inFlight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= quiet) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.problems.push(`${this.inFlight.size} request(s) still in flight after ${max} ms`);
  }

  close() {
    this.ws.close();
  }
}

interface RequestWillBeSent {
  requestId: string;
  request: { url: string; method: string };
  type?: string;
  initiator?: { type: string };
  redirectResponse?: { status: number };
}

// ---- the session ------------------------------------------------------------------------------

/** What the patched anchor click records in the page. */
interface InPageExport {
  filename: string;
  text: string;
}

declare global {
  interface Window {
    __privacyExports?: InPageExport[];
  }
}

/**
 * Keep exports in the page: remember every object URL's Blob and turn an anchor click into a
 * record of the file name and text instead of a download.
 */
async function captureExports(page: Page) {
  await page.evaluate(() => {
    const blobs = new Map<string, Blob>();
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = createObjectURL(obj);
      if (obj instanceof Blob) blobs.set(url, obj);
      return url;
    };
    window.__privacyExports = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) throw new Error(`anchor click without a known blob: ${this.href}`);
      void blob.text().then((text) => window.__privacyExports!.push({ filename: this.download, text }));
    };
  });
}

async function nextExport(page: Page, n: number): Promise<InPageExport> {
  await page.waitForFunction((n) => (window.__privacyExports?.length ?? 0) >= n, n, { timeout: 10_000 });
  return page.evaluate((n) => window.__privacyExports![n - 1]!, n);
}

async function drive(page: Page, url: string): Promise<NonNullable<PrivacyReport['exports']>> {
  log(`open ${url}`);
  await page.goto(url);
  await page.getByText('Drop a chart image here').waitFor();

  log(`drop ${FIXTURE}`);
  await dropFile(page, FIXTURE, 'km-pericardial-pao.png', 'image/png');
  await page.getByTestId('notice').filter({ hasText: 'Loaded km-pericardial-pao.png' }).waitFor();

  log('Auto-detect axes (OCR in the worker)');
  await page.getByRole('button', { name: 'Auto-detect axes' }).click();
  await page.getByTestId('auto-suggestion').waitFor({ timeout: OCR_TIMEOUT });
  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await page.getByTestId('calibration-ok').waitFor();
  await page.getByRole('button', { name: 'Continue to Data' }).click();

  log(`Auto-trace from image px (${CURVE_PX.px}, ${CURVE_PX.py})`);
  await page.getByTestId('trace-panel').waitFor();
  await page.getByTestId('trace-prompt').waitFor();
  const at = await imageToClient(page, CURVE_PX.px, CURVE_PX.py);
  await page.mouse.click(at.x, at.y);
  await page.getByTestId('trace-count').waitFor({ timeout: 30_000 });
  const traced = Number(await page.getByTestId('trace-count').textContent());
  if (!(traced > 0)) throw new Error(`Auto-trace proposed ${traced} points`);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.getByTestId('trace-panel').waitFor({ state: 'detached' });

  log('Download CSV, Save project and Download session log (captured in-page)');
  await captureExports(page);
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await nextExport(page, 1);
  await page.getByRole('button', { name: 'Save project' }).click();
  const project = await nextExport(page, 2);
  await page.getByRole('button', { name: 'Download session log' }).click();
  const sessionLog = await nextExport(page, 3);

  const csvRows = csv.text.split(/\r?\n/).filter((l) => l.trim() !== '').length - 1;
  const parsed = JSON.parse(project.text) as { image?: { dataUrl?: string }; datasets?: { points: unknown[] }[] };
  const points = parsed.datasets?.[0]?.points.length ?? 0;
  if (csvRows !== traced || points !== traced) throw new Error(`exports disagree with the ${traced} traced points: CSV ${csvRows} rows, project ${points} points`);
  if (!parsed.image?.dataUrl?.startsWith('data:image/')) throw new Error('the saved project does not embed the image');
  // The session log: ends with its own export, after the CSV and project ones, and holds no image data.
  const events = (JSON.parse(sessionLog.text) as { events?: { type: string; kind?: string }[] }).events ?? [];
  const exportKinds = events.filter((e) => e.type === 'export').map((e) => e.kind);
  if (JSON.stringify(exportKinds) !== JSON.stringify(['csv', 'project', 'session-log']) || events.at(-1)?.kind !== 'session-log') {
    throw new Error(`the session log's exports are ${JSON.stringify(exportKinds)}, not csv, project, session-log (last)`);
  }
  if (/data:|base64/i.test(sessionLog.text)) throw new Error('the session log contains image data');
  return {
    csv: { filename: csv.filename, bytes: Buffer.byteLength(csv.text), records: csvRows },
    project: { filename: project.filename, bytes: Buffer.byteLength(project.text), records: points },
    sessionLog: { filename: sessionLog.filename, bytes: Buffer.byteLength(sessionLog.text), records: events.length },
  };
}

// ---- main -------------------------------------------------------------------------------------

function git(...argv: string[]): string {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function main(): Promise<number> {
  const started = Date.now();
  if (NO_BUILD) log('using the existing dist/ (--no-build)');
  else build();

  const [previewPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const preview = await startPreview(previewPort);
  log(`preview on ${preview.origin}${BASE}`);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
  let capture: Capture | undefined;
  let exports: PrivacyReport['exports'] = null;
  let error: string | null = null;
  try {
    capture = await Capture.connect(debugPort);
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    try {
      exports = await drive(page, preview.origin + BASE);
    } catch (e) {
      error = (e as Error).message;
      console.error(e);
    }
    await capture.settle();
    await context.close();
  } finally {
    capture?.close();
    await browser.close();
    preview.child.kill();
  }

  const meta: ReportMeta = {
    date: new Date().toISOString(),
    gitHead: git('rev-parse', 'HEAD'),
    gitDirty: git('status', '--porcelain') !== '',
    packageVersion: (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version,
    chromiumVersion: browser.version(),
    playwrightVersion: (require('@playwright/test/package.json') as { version: string }).version,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    previewOrigin: preview.origin,
    basePath: BASE,
    fixture: FIXTURE,
    durationMs: Date.now() - started,
  };
  const problems = capture?.problems ?? ['the CDP connection was never established'];
  if (problems.length > 0) error = [error, ...problems].filter((s) => s !== null).join('; ');
  const report = buildReport(meta, capture?.requests ?? [], exports, error);
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(summarize(report));
  log(`report written to ${OUT}`);
  return report.verdict.pass ? 0 : 1;
}

process.exitCode = await main().catch((e) => {
  console.error(e);
  return 1;
});
