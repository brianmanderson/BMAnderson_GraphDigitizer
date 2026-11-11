/**
 * The privacy report's shape and verdict (pure: no browser, no filesystem), used by
 * scripts/privacy-check.ts and tested in report.test.ts. The script captures every network
 * request the app makes during a full session — from the page and from its workers — and this
 * module decides whether that list proves the privacy claim: nothing was fetched from anywhere
 * but the app's own origin, and the capture was complete enough to say so (the worker-initiated
 * Tesseract requests are present; without them a passing list could just mean the workers were
 * not observed).
 */

/** One network request, as captured over CDP. */
export interface CapturedRequest {
  /** CDP requestId (unique within one session's Network domain; redirects reuse it). */
  requestId: string;
  url: string;
  method: string;
  /** CDP type of the target whose session reported the request: 'page', 'worker', 'iframe'… */
  target: string;
  /** The target's own URL — a worker's script URL — or null for the page. */
  targetUrl: string | null;
  /** Network.ResourceType: Document, Script, Stylesheet, Fetch, XHR, Image, Other… */
  resourceType: string;
  /** Network.Initiator.type: parser, script, preload, other… */
  initiator: string;
  status: number | null;
  mimeType: string | null;
  /** Bytes received over the wire (CDP encodedDataLength); null when the browser reports none. */
  bytes: number | null;
  fromCache: boolean;
  /** CDP errorText when loading failed, else null. */
  error: string | null;
}

export interface ReportMeta {
  date: string;
  gitHead: string;
  gitDirty: boolean;
  packageVersion: string;
  chromiumVersion: string;
  playwrightVersion: string;
  nodeVersion: string;
  platform: string;
  previewOrigin: string;
  basePath: string;
  fixture: string;
  /** Wall-clock time of the whole script, in milliseconds. */
  durationMs: number;
}

/** What the in-page exports produced (captured by patching the anchor click, never written to disk). */
export interface ExportCapture {
  filename: string;
  bytes: number;
  /** CSV: data rows (excluding the header); project: points in the first line; session log: events. */
  records: number;
}

export interface Verdict {
  pass: boolean;
  /** Requests to any origin other than the preview origin (data: and blob: excluded). */
  foreign: CapturedRequest[];
  /** Failed requests to the app's own origin: a missing vendored file would be a bug, not a leak. */
  failed: CapturedRequest[];
  /**
   * Own-origin requests outside the base path. Under a subpath (GitHub Pages serves the app at
   * /<repo>/ on an origin shared with other sites) anything else on the origin is not the app.
   */
  outsideBase: CapturedRequest[];
  /** True when every expected worker-initiated request was seen. */
  captureComplete: boolean;
  /** Labels of the expected worker-initiated requests that were not seen. */
  missing: string[];
  reasons: string[];
}

export interface PrivacyReport {
  meta: ReportMeta;
  /** Set when the scripted session did not run to completion; the verdict is then a fail. */
  error: string | null;
  /** `sessionLog`: the "Download session log" file (absent in reports written before it existed). */
  exports: { csv: ExportCapture; project: ExportCapture; sessionLog?: ExportCapture } | null;
  requests: CapturedRequest[];
  countsByOrigin: Record<string, number>;
  /** Requests reported by a worker target (the module worker or Tesseract's worker). */
  workerRequests: CapturedRequest[];
  verdict: Verdict;
}

export interface ExpectedWorkerRequest {
  label: string;
  pattern: RegExp;
  /** When set, the request must have been reported by a target of this type. */
  target?: 'worker' | 'page';
}

/**
 * Requests that prove the workers were observed. Tesseract's worker script is requested by the
 * page (it creates the Worker); the WASM core (importScripts) and the language data (fetch) are
 * requested from inside that worker, so they only appear if worker sessions were captured.
 */
export const EXPECTED_WORKER_REQUESTS: readonly ExpectedWorkerRequest[] = [
  { label: 'tesseract/worker.min.js (the OCR worker script)', pattern: /\/tesseract\/worker\.min\.js(\?|$)/ },
  { label: 'tesseract/tesseract-core-*-lstm.wasm.js from the worker (the WASM core)', pattern: /\/tesseract\/tesseract-core-[a-z-]*lstm\.wasm\.js(\?|$)/, target: 'worker' },
  { label: 'tesseract/eng.traineddata.gz from the worker (the language data)', pattern: /\/tesseract\/eng\.traineddata\.gz(\?|$)/, target: 'worker' },
  { label: 'assets/auto.worker-*.js (the detection/tracing module worker)', pattern: /\/assets\/auto\.worker-[\w-]+\.js(\?|$)/ },
];

/**
 * The bucket a request is counted under: 'data:' and 'blob:' by scheme (they never leave the
 * browser), everything else by origin. An unparsable URL is its own bucket so it is never
 * silently allowed.
 */
export function originOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `invalid:${url}`;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol;
  return u.origin;
}

export function countByOrigin(requests: readonly CapturedRequest[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of requests) {
    const key = originOf(r.url);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Whether an own-origin URL's path lies under the base path ('/' contains every path). */
export function underBase(url: string, basePath: string): boolean {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const path = new URL(url).pathname;
  return path.startsWith(base) || `${path}/` === base;
}

export function judge(requests: readonly CapturedRequest[], previewOrigin: string, basePath = '/'): Verdict {
  const foreign = requests.filter((r) => {
    const o = originOf(r.url);
    return o !== previewOrigin && o !== 'data:' && o !== 'blob:';
  });
  const failed = requests.filter((r) => originOf(r.url) === previewOrigin && (r.error !== null || (r.status !== null && r.status >= 400)));
  const outsideBase = requests.filter((r) => originOf(r.url) === previewOrigin && !underBase(r.url, basePath));
  const missing = EXPECTED_WORKER_REQUESTS.filter(
    (e) => !requests.some((r) => e.pattern.test(r.url) && (e.target === undefined || r.target === e.target)),
  ).map((e) => e.label);
  const reasons: string[] = [];
  if (requests.length === 0) reasons.push('no requests were captured at all');
  if (foreign.length > 0) reasons.push(`${foreign.length} request(s) left the app's origin: ${[...new Set(foreign.map((r) => originOf(r.url)))].join(', ')}`);
  if (failed.length > 0) reasons.push(`${failed.length} request(s) to the app's own origin failed: ${failed.map((r) => `${r.url} (${r.error ?? r.status})`).join(', ')}`);
  if (outsideBase.length > 0) reasons.push(`${outsideBase.length} request(s) on the app's origin left its base path ${basePath}: ${outsideBase.map((r) => r.url).join(', ')}`);
  if (missing.length > 0) reasons.push(`capture incomplete, worker-initiated requests not seen: ${missing.join('; ')}`);
  return { pass: reasons.length === 0, foreign, failed, outsideBase, captureComplete: missing.length === 0, missing, reasons };
}

export function buildReport(
  meta: ReportMeta,
  requests: readonly CapturedRequest[],
  exports: PrivacyReport['exports'],
  error: string | null = null,
): PrivacyReport {
  const list = [...requests];
  const verdict = judge(list, meta.previewOrigin, meta.basePath);
  if (error !== null) {
    verdict.pass = false;
    verdict.reasons.unshift(`the session did not complete: ${error}`);
  }
  return {
    meta,
    error,
    exports,
    requests: list,
    countsByOrigin: countByOrigin(list),
    workerRequests: list.filter((r) => r.target === 'worker'),
    verdict,
  };
}

const kb = (n: number | null) => (n === null ? '?' : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`);

/** The short human summary the script prints. */
export function summarize(report: PrivacyReport): string {
  const { meta, verdict } = report;
  const lines: string[] = [];
  lines.push(`Privacy check of ${meta.previewOrigin}${meta.basePath} at ${meta.gitHead.slice(0, 12)}${meta.gitDirty ? ' (dirty)' : ''}, v${meta.packageVersion}, Chromium ${meta.chromiumVersion}`);
  lines.push(`${report.requests.length} requests captured in ${(meta.durationMs / 1000).toFixed(1)} s; by origin:`);
  for (const [origin, n] of Object.entries(report.countsByOrigin)) lines.push(`  ${n.toString().padStart(4)}  ${origin}`);
  lines.push(`${report.workerRequests.length} reported by worker targets:`);
  for (const r of report.workerRequests) lines.push(`  ${r.resourceType.padEnd(8)} ${r.status ?? r.error ?? '-'} ${kb(r.bytes).padStart(9)}  ${r.url}`);
  if (report.exports) {
    lines.push(
      `Exports produced in-page: ${report.exports.csv.filename} (${report.exports.csv.records} rows, ${kb(report.exports.csv.bytes)}), ` +
        `${report.exports.project.filename} (${report.exports.project.records} points, ${kb(report.exports.project.bytes)})` +
        (report.exports.sessionLog
          ? `, ${report.exports.sessionLog.filename} (${report.exports.sessionLog.records} events, ${kb(report.exports.sessionLog.bytes)})`
          : ''),
    );
  }
  lines.push(verdict.pass ? `PASS: every request stayed on the app origin under ${meta.basePath} and the workers were captured.` : `FAIL: ${verdict.reasons.join('; ')}`);
  return lines.join('\n');
}
