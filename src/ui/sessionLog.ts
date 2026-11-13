/**
 * The session log (docs/SPEC.md → Session log): a per-image record of what the user did — loads,
 * crop, calibration edits, Auto-detect and Auto-trace outcomes, point edits, undo/redo, settings
 * and exports — kept in memory only and downloaded on request as `<image>-session.json`.
 *
 * Pure and DOM-free: the clock and the header's browser facts are injected (App passes
 * `performance.now` and reads `navigator`/`window`), so it is unit-tested in Node. It never
 * holds image data: events carry counts, ids and pixel positions only, and `serializeLog` drops
 * any `image`/`dataUrl` field and any data:/blob: URL as a last line of defence.
 */

import type { AutoCalibration, AxisSuggestion } from '../auto/index.ts';
import type { ScaleType } from '../core/index.ts';
import type { TraceMode } from '../auto/trace/types.ts';
import type { AppAction, DocState } from '../state/doc.ts';

export const SESSION_LOG_FORMAT = 'graph-digitizer-session-log';
export const SESSION_LOG_VERSION = 1;

export interface SessionHeader {
  appVersion: string;
  /** Git commit of the build, or "unknown". */
  commit: string;
  /** Wall-clock time of the image load, ISO 8601. */
  startedAt: string;
  userAgent: string;
  viewport: { w: number; h: number };
  devicePixelRatio: number;
  imageName: string;
  /** The image as loaded (before any crop): pixels and bytes of the file. */
  imageSize: { w: number; h: number; bytes: number };
}

/** How the image of this log arrived: a picked/dropped/pasted image, a project file, or the autosave. */
export type LoadSource = 'image' | 'project' | 'autosave';

type Axis = 'x' | 'y';
type Which = 1 | 2;
type Px = { x: number; y: number };

export type SessionEventBody =
  | { type: 'image-loaded'; source: LoadSource }
  /** Columns x0 … x1 − 1 and rows y0 … y1 − 1 of the image before this crop (src/ui/crop.ts). */
  | { type: 'crop'; rect: { x0: number; y0: number; x1: number; y1: number } }
  | { type: 'ref-placed'; axis: Axis; which: Which; px: Px }
  | { type: 'ref-cleared'; axis: Axis; which: Which; px: Px | null }
  | { type: 'ref-value-set'; axis: Axis; which: Which; value: string }
  | { type: 'scale-set'; axis: Axis; scale: ScaleType }
  | {
      type: 'auto-detect-run';
      durationMs: number;
      outcome: 'suggested' | 'declined';
      /** Axes whose suggestion carries values (status "calibrated"). */
      axesSuggested: Axis[];
      /** Why each axis without values got none (codes, never OCR text); absent when both have values. */
      declineReason?: string;
      labelsRead?: number;
      confidence?: { x: number; y: number };
    }
  /** `editedFields`: suggested refs whose value the user changed before accepting (may be empty). */
  | { type: 'suggestion-accepted'; editedFields: string[] }
  | { type: 'suggestion-discarded' }
  | {
      type: 'trace-run';
      /** The line the points would go to; null for "into a new line" (its id is made on Accept). */
      datasetId: string | null;
      seedPx: Px;
      mode: TraceMode;
      /** What the tracer found ('none' on an error). */
      kind: 'curve' | 'markers' | 'none';
      durationMs: number;
      outcome: 'ok' | 'empty' | 'error';
      pointCount: number;
    }
  | { type: 'trace-accepted'; datasetId: string; pointCount: number }
  | { type: 'trace-discarded'; datasetId: string | null; pointCount: number }
  | { type: 'points-added'; datasetId: string; count: number; source: 'hand' | 'snap' }
  | { type: 'points-moved'; datasetId: string; count: number; source: 'drag' | 'nudge' }
  | { type: 'points-deleted'; datasetId: string; count: number }
  | { type: 'dataset-added'; datasetId: string }
  | { type: 'dataset-renamed'; datasetId: string }
  | { type: 'dataset-deleted'; datasetId: string }
  | { type: 'dataset-activated'; datasetId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setting-changed'; key: string; value: string | number | boolean }
  | { type: 'export'; kind: 'csv' | 'project' | 'session-log'; filename: string }
  /** "Start over" cleared the image and its work (what was lost); the log stays downloadable until the next load. */
  | { type: 'start-over'; lines: number; points: number };

export type SessionEventType = SessionEventBody['type'];

/** `seq` counts from 0 in each log; `t` is milliseconds since the image load (monotonic clock). */
export type SessionEvent = { seq: number; t: number } & SessionEventBody;

export interface SessionLogFile {
  format: typeof SESSION_LOG_FORMAT;
  version: typeof SESSION_LOG_VERSION;
  header: SessionHeader;
  events: SessionEvent[];
}

/** Milliseconds, rounded to 0.1 ms (the clock's useful resolution). */
const tenth = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Holds the log of the current image. `start` begins a new one (a new image, a project, a
 * restored autosave); `record` appends. Events recorded with the same `group` key one after
 * another replace each other — the same rule as undo grouping (src/state/history.ts) — so a drag,
 * a held nudge key or typing into one field is one event (with the time it began).
 */
export class SessionRecorder {
  private log: SessionLogFile | null = null;
  private t0 = 0;
  private lastT = 0;
  private group: string | null = null;
  /** Index in `events` and `t` of the newest group's batch. */
  private batch = { start: 0, t: 0 };
  /** Bumped by every `start`, so an outcome that arrives after a new load can be dropped. */
  generation = 0;

  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  get active(): boolean {
    return this.log !== null;
  }

  start(header: SessionHeader, source: LoadSource): void {
    this.t0 = this.clock();
    this.lastT = 0;
    this.group = null;
    this.generation++;
    // The load is the log's origin: t = 0 exactly.
    this.log = { format: SESSION_LOG_FORMAT, version: SESSION_LOG_VERSION, header: { ...header }, events: [{ seq: 0, t: 0, type: 'image-loaded', source }] };
  }

  /** Milliseconds since the log started (never less than the last event's). */
  now(): number {
    const t = tenth(Math.max(this.lastT, this.clock() - this.t0));
    this.lastT = t;
    return t;
  }

  record(bodies: SessionEventBody | readonly SessionEventBody[], group?: string): void {
    const log = this.log;
    if (!log) return;
    const list = Array.isArray(bodies) ? (bodies as readonly SessionEventBody[]) : [bodies as SessionEventBody];
    if (list.length === 0) return;
    let t: number;
    if (group !== undefined && group === this.group) {
      // The same continuous edit: replace its events, keep when it began.
      log.events.length = this.batch.start;
      t = this.batch.t;
    } else {
      t = this.now();
      this.batch = { start: log.events.length, t };
    }
    this.group = group ?? null;
    for (const body of list) log.events.push({ seq: log.events.length, t, ...body } as SessionEvent);
  }

  /** A copy of the current log, or null before the first image. */
  file(): SessionLogFile | null {
    return this.log && { ...this.log, header: { ...this.log.header }, events: this.log.events.map((e) => ({ ...e })) };
  }
}

const IMAGE_KEYS = new Set(['image', 'dataUrl']);

/** The log as pretty JSON, with no image data whatever an event might carry. */
export function serializeLog(file: SessionLogFile): string {
  return JSON.stringify(
    file,
    (key, value: unknown) => {
      if (IMAGE_KEYS.has(key)) return undefined;
      if (typeof value === 'string' && /^\s*(data|blob):/i.test(value)) return '[removed]';
      return value;
    },
    2,
  );
}

/** "chart.png" → "chart-session.json" (the caller passes `baseName(imageName)`). */
export const sessionLogFilename = (base: string) => `${base}-session.json`;

/** Decoded size of a base64 data URL in bytes (the loaded file's size); 0 when it is not base64. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(dataUrl.slice(0, comma))) return 0;
  const b64 = dataUrl.slice(comma + 1).replace(/\s/g, '');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

const refParts = (ref: string): { axis: Axis; which: Which } => ({
  axis: ref.startsWith('X') ? 'x' : 'y',
  which: ref.endsWith('2') ? 2 : 1,
});

/** Count per line, in order of first appearance. */
function perDataset(items: readonly { datasetId: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const { datasetId } of items) counts.set(datasetId, (counts.get(datasetId) ?? 0) + 1);
  return [...counts];
}

/**
 * The events a document edit stands for, given the document before it and the undo-group key it
 * was dispatched with. Edits whose outcome only the call site knows are recorded there instead:
 * `apply-suggestion` (suggestion-accepted), `add-points` (trace-accepted) and `replace-doc` (a new
 * log). `recolor-dataset` is not recorded.
 */
export function eventsForAction(doc: DocState | null, action: AppAction, group?: string, opts: { snapped?: boolean } = {}): SessionEventBody[] {
  const moveSource = group?.startsWith('nudge:') ? 'nudge' : 'drag';
  switch (action.type) {
    case 'set-scale':
      return [{ type: 'scale-set', axis: action.axis, scale: action.scale }];
    case 'place-ref':
      return [{ type: 'ref-placed', ...refParts(action.ref), px: { x: action.px, y: action.py } }];
    case 'clear-ref': {
      const r = doc?.refs[action.ref];
      return [{ type: 'ref-cleared', ...refParts(action.ref), px: r ? { x: r.px, y: r.py } : null }];
    }
    case 'set-ref-value':
      return [{ type: 'ref-value-set', ...refParts(action.ref), value: action.value }];
    case 'add-point':
      return [{ type: 'points-added', datasetId: action.datasetId, count: 1, source: opts.snapped ? 'snap' : 'hand' }];
    case 'move-point':
      return [{ type: 'points-moved', datasetId: action.datasetId, count: 1, source: moveSource }];
    case 'move-points':
      return perDataset(action.moves).map(([datasetId, count]) => ({ type: 'points-moved', datasetId, count, source: moveSource }));
    case 'delete-point':
      return [{ type: 'points-deleted', datasetId: action.datasetId, count: 1 }];
    case 'delete-points':
      return perDataset(action.points).map(([datasetId, count]) => ({ type: 'points-deleted', datasetId, count }));
    case 'add-dataset':
      return [{ type: 'dataset-added', datasetId: action.dataset.id }];
    case 'rename-dataset':
      return [{ type: 'dataset-renamed', datasetId: action.datasetId }];
    case 'delete-dataset':
      return [{ type: 'dataset-deleted', datasetId: action.datasetId }];
    case 'set-active-dataset':
      return [{ type: 'dataset-activated', datasetId: action.datasetId }];
    case 'set-settings':
      return Object.entries(action.settings).flatMap(([key, value]) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [{ type: 'setting-changed' as const, key, value }] : [],
      );
    case 'crop':
      return [{ type: 'crop', rect: { x0: action.x0, y0: action.y0, x1: action.x0 + action.image.width, y1: action.y0 + action.image.height } }];
    case 'apply-suggestion':
    case 'add-points':
    case 'recolor-dataset':
    case 'replace-doc':
      return [];
  }
}

/** Why an axis got no values, as a code (never the OCR'd text the user-facing message may quote). */
function declineCode(s: AxisSuggestion): string {
  if (!s.line) return 'no-axis-line';
  if (s.labels.length === 0) return 'no-tick-labels';
  return 'labels-not-usable';
}

/** The `auto-detect-run` event for a finished run (`result`) or a failed one (null). */
export function autoDetectEvent(result: AutoCalibration | null, durationMs: number): Extract<SessionEventBody, { type: 'auto-detect-run' }> {
  const ms = Math.round(durationMs);
  if (!result) return { type: 'auto-detect-run', durationMs: ms, outcome: 'declined', axesSuggested: [], declineReason: 'error' };
  const axes = [result.x, result.y];
  const axesSuggested = axes.filter((s) => s.status === 'calibrated').map((s) => s.axis);
  const declined = axes.filter((s) => s.status !== 'calibrated');
  return {
    type: 'auto-detect-run',
    durationMs: ms,
    outcome: axesSuggested.length > 0 ? 'suggested' : 'declined',
    axesSuggested,
    ...(declined.length > 0 && { declineReason: declined.map((s) => `${s.axis}:${declineCode(s)}`).join(' ') }),
    labelsRead: result.x.labels.length + result.y.labels.length,
    confidence: { x: result.x.confidence, y: result.y.confidence },
  };
}
