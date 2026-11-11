import { describe, expect, it } from 'vitest';
import { buildReport, countByOrigin, judge, originOf, summarize, underBase, type CapturedRequest, type ReportMeta } from './report.ts';

const ORIGIN = 'http://localhost:4173';

function req(url: string, over: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    requestId: Math.random().toString(36).slice(2),
    url,
    method: 'GET',
    target: 'page',
    targetUrl: null,
    resourceType: 'Script',
    initiator: 'parser',
    status: 200,
    mimeType: 'text/javascript',
    bytes: 1000,
    fromCache: false,
    error: null,
    ...over,
  };
}

const OCR_WORKER = `${ORIGIN}/tesseract/worker.min.js`;

/** The request list of a healthy session: page bundle, workers, Tesseract files, exports. */
function healthy(): CapturedRequest[] {
  return [
    req(`${ORIGIN}/`, { resourceType: 'Document', initiator: 'other' }),
    req(`${ORIGIN}/assets/index-CZ8jVhsr.js`),
    req(`${ORIGIN}/assets/index-Bn_MuQcH.css`, { resourceType: 'Stylesheet' }),
    req(`${ORIGIN}/assets/ocr-Cm4rycrE.js`, { initiator: 'script' }),
    req(`${ORIGIN}/assets/auto.worker-O7hHc0Pb.js`, { initiator: 'script' }),
    req(OCR_WORKER, { initiator: 'script' }),
    req(`${ORIGIN}/tesseract/tesseract-core-simd-lstm.wasm.js`, { target: 'worker', targetUrl: OCR_WORKER, initiator: 'script' }),
    req(`${ORIGIN}/tesseract/eng.traineddata.gz`, { target: 'worker', targetUrl: OCR_WORKER, resourceType: 'Fetch', initiator: 'script', mimeType: 'application/octet-stream', bytes: 3_000_000 }),
    req('blob:http://localhost:4173/7f3c-1', { resourceType: 'Image', initiator: 'script', bytes: null }),
    req('data:image/png;base64,iVBORw0KGgo=', { resourceType: 'Image', bytes: null }),
  ];
}

const META: ReportMeta = {
  date: '2026-01-01T00:00:00.000Z',
  gitHead: '0123456789abcdef0123456789abcdef01234567',
  gitDirty: false,
  packageVersion: '0.1.0',
  chromiumVersion: '156.0.0.0',
  playwrightVersion: '1.64.1',
  nodeVersion: 'v24.0.0',
  platform: 'linux',
  previewOrigin: ORIGIN,
  basePath: '/',
  fixture: 'real/km-pericardial-pao.png',
  durationMs: 42_000,
};

describe('originOf', () => {
  it('buckets by origin, with data: and blob: by scheme', () => {
    expect(originOf(`${ORIGIN}/assets/x.js?v=1`)).toBe(ORIGIN);
    expect(originOf('https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js')).toBe('https://cdn.jsdelivr.net');
    expect(originOf('data:text/plain,hi')).toBe('data:');
    expect(originOf('blob:http://localhost:4173/abc')).toBe('blob:');
    expect(originOf('blob:null/abc')).toBe('blob:');
  });
  it('never lets an unparsable URL pass as the app origin', () => {
    expect(originOf('not a url')).toBe('invalid:not a url');
  });
});

describe('judge', () => {
  it('passes a complete, same-origin session', () => {
    const v = judge(healthy(), ORIGIN);
    expect(v).toMatchObject({ pass: true, foreign: [], failed: [], outsideBase: [], captureComplete: true, missing: [], reasons: [] });
  });

  it('fails on any request to another origin, naming it', () => {
    const cdn = req('https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js', { target: 'worker', targetUrl: OCR_WORKER });
    const v = judge([...healthy(), cdn], ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.foreign).toEqual([cdn]);
    expect(v.reasons.join('\n')).toContain('https://cdn.jsdelivr.net');
  });

  it('a different port is a different origin', () => {
    const v = judge([...healthy(), req('http://localhost:5173/assets/x.js')], ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.foreign.map((r) => r.url)).toEqual(['http://localhost:5173/assets/x.js']);
  });

  it('ignores data: and blob: for the verdict but still counts them', () => {
    const list = healthy();
    expect(judge(list, ORIGIN).foreign).toEqual([]);
    expect(countByOrigin(list)).toEqual({ 'blob:': 1, 'data:': 1, [ORIGIN]: 8 });
  });

  it('fails when the worker-initiated Tesseract requests are missing (incomplete capture)', () => {
    const pageOnly = healthy().filter((r) => r.target !== 'worker');
    const v = judge(pageOnly, ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.captureComplete).toBe(false);
    expect(v.missing).toHaveLength(2);
    expect(v.missing.join('\n')).toMatch(/wasm\.js/);
    expect(v.missing.join('\n')).toMatch(/eng\.traineddata\.gz/);
    expect(v.reasons.join('\n')).toContain('capture incomplete');
  });

  it('a WASM core reported by the page, not the worker, does not count as worker capture', () => {
    const list = healthy().map((r) => (r.target === 'worker' ? { ...r, target: 'page', targetUrl: null } : r));
    expect(judge(list, ORIGIN).captureComplete).toBe(false);
  });

  it('fails when the module worker was never requested', () => {
    const v = judge(healthy().filter((r) => !/auto\.worker/.test(r.url)), ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.missing).toEqual([expect.stringContaining('auto.worker')]);
  });

  it('fails when an own-origin request failed or 404ed', () => {
    const missing = req(`${ORIGIN}/tesseract/eng.traineddata.gz`, { target: 'worker', targetUrl: OCR_WORKER, status: 404, mimeType: 'text/html' });
    const aborted = req(`${ORIGIN}/assets/ocr-Cm4rycrE.js`, { status: null, error: 'net::ERR_ABORTED' });
    const v = judge([...healthy(), missing, aborted], ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.failed).toEqual([missing, aborted]);
    expect(v.reasons.join('\n')).toContain('net::ERR_ABORTED');
  });

  it('under a base path, passes a session that stays inside it', () => {
    const base = '/BMAnderson_GraphDigitizer/';
    const list = healthy().map((r) => (r.url.startsWith(`${ORIGIN}/`) ? { ...r, url: r.url.replace(`${ORIGIN}/`, `${ORIGIN}${base}`) } : r));
    expect(judge(list, ORIGIN, base)).toMatchObject({ pass: true, outsideBase: [], reasons: [] });
  });

  it('under a base path, fails on an own-origin request outside it (another site on a shared origin)', () => {
    const base = '/BMAnderson_GraphDigitizer/';
    const inside = healthy().map((r) => (r.url.startsWith(`${ORIGIN}/`) ? { ...r, url: r.url.replace(`${ORIGIN}/`, `${ORIGIN}${base}`) } : r));
    const root = req(`${ORIGIN}/tesseract/eng.traineddata.gz`, { target: 'worker', targetUrl: OCR_WORKER, resourceType: 'Fetch' });
    const v = judge([...inside, root], ORIGIN, base);
    expect(v.pass).toBe(false);
    expect(v.foreign).toEqual([]);
    expect(v.outsideBase).toEqual([root]);
    expect(v.reasons.join('\n')).toContain(`left its base path ${base}`);
    // The same root request is fine when the app itself is served at '/'.
    expect(judge(healthy(), ORIGIN).outsideBase).toEqual([]);
  });

  it('underBase: the base itself, with or without its trailing slash, and paths below it', () => {
    const base = '/BMAnderson_GraphDigitizer/';
    expect(underBase(`${ORIGIN}/BMAnderson_GraphDigitizer/`, base)).toBe(true);
    expect(underBase(`${ORIGIN}/BMAnderson_GraphDigitizer`, base)).toBe(true);
    expect(underBase(`${ORIGIN}/BMAnderson_GraphDigitizer/assets/x.js?v=1`, base)).toBe(true);
    expect(underBase(`${ORIGIN}/BMAnderson_GraphDigitizerX/x.js`, base)).toBe(false);
    expect(underBase(`${ORIGIN}/favicon.ico`, base)).toBe(false);
    expect(underBase(`${ORIGIN}/anything`, '/')).toBe(true);
  });

  it('fails an empty capture rather than passing vacuously', () => {
    const v = judge([], ORIGIN);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('no requests were captured');
  });
});

describe('buildReport and summarize', () => {
  it('assembles counts, the worker list and the verdict; the summary says PASS', () => {
    const exports = { csv: { filename: 'km.csv', bytes: 2048, records: 61 }, project: { filename: 'km.graph.json', bytes: 45_000, records: 61 } };
    const report = buildReport(META, healthy(), exports);
    expect(report.countsByOrigin).toEqual({ 'blob:': 1, 'data:': 1, [ORIGIN]: 8 });
    expect(report.workerRequests.map((r) => r.url)).toEqual([`${ORIGIN}/tesseract/tesseract-core-simd-lstm.wasm.js`, `${ORIGIN}/tesseract/eng.traineddata.gz`]);
    expect(report.verdict.pass).toBe(true);
    const text = summarize(report);
    expect(text).toContain('PASS');
    expect(text).toContain('0123456789ab');
    expect(text).toContain(`   8  ${ORIGIN}`);
    expect(text).toContain('eng.traineddata.gz');
    expect(text).toContain('61 rows');
    // JSON round-trips (RegExps are not in the report, only in the module).
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('an aborted session fails even when every captured request was fine', () => {
    const report = buildReport(META, healthy(), null, 'timeout waiting for [data-testid=auto-suggestion]');
    expect(report.error).toContain('auto-suggestion');
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.reasons[0]).toContain('did not complete');
  });

  it('the summary says FAIL with the reasons', () => {
    const report = buildReport(META, [...healthy(), req('https://example.com/collect', { method: 'POST', resourceType: 'Fetch' })], null);
    const text = summarize(report);
    expect(text).toContain('FAIL');
    expect(text).toContain('https://example.com');
  });
});
