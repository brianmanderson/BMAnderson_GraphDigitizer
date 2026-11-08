/** The session log (src/ui/sessionLog.ts): sequence, clock, grouping, reset, mapping, serialisation. */

import { describe, expect, it } from 'vitest';
import type { AutoCalibration, AxisSuggestion } from '../auto/index.ts';
import { newDoc, type DocState } from '../state/doc.ts';
import {
  SESSION_LOG_FORMAT,
  SessionRecorder,
  autoDetectEvent,
  dataUrlBytes,
  eventsForAction,
  serializeLog,
  sessionLogFilename,
  type SessionHeader,
} from './sessionLog.ts';

const HEADER: SessionHeader = {
  appVersion: '1.0.0',
  commit: 'unknown',
  startedAt: '2026-11-07T12:00:00.000Z',
  userAgent: 'test',
  viewport: { w: 1366, h: 768 },
  devicePixelRatio: 1,
  imageName: 'chart.png',
  imageSize: { w: 640, h: 480, bytes: 1234 },
};

/** A clock the test moves by hand; `tick` is added on every read (a real clock never stands still). */
function fakeClock(start = 1000, tick = 0) {
  let now = start;
  return {
    clock: () => (now += tick) - tick,
    advance: (ms: number) => (now += ms),
  };
}

const IMAGE = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 640, height: 480, name: 'chart.png' };
const doc = (): DocState => newDoc(IMAGE, 'line-1');

describe('SessionRecorder', () => {
  it('records nothing before an image and starts each log with image-loaded at t = 0', () => {
    const c = fakeClock(1000, 0.37);
    const log = new SessionRecorder(c.clock);
    log.record({ type: 'undo' });
    expect(log.file()).toBeNull();
    expect(log.active).toBe(false);
    log.start(HEADER, 'image');
    expect(log.active).toBe(true);
    expect(log.file()).toEqual({ format: SESSION_LOG_FORMAT, version: 1, header: HEADER, events: [{ seq: 0, t: 0, type: 'image-loaded', source: 'image' }] });
  });

  it('numbers events from 0 without gaps and times them from the load', () => {
    const c = fakeClock();
    const log = new SessionRecorder(c.clock);
    log.start(HEADER, 'image');
    c.advance(12.34);
    log.record({ type: 'undo' });
    c.advance(100);
    log.record([
      { type: 'points-deleted', datasetId: 'a', count: 2 },
      { type: 'points-deleted', datasetId: 'b', count: 1 },
    ]);
    const events = log.file()!.events;
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.t)).toEqual([0, 12.3, 112.3, 112.3]);
  });

  it('never lets t go backwards, even if the clock does', () => {
    const c = fakeClock();
    const log = new SessionRecorder(c.clock);
    log.start(HEADER, 'image');
    c.advance(50);
    log.record({ type: 'undo' });
    c.advance(-30);
    log.record({ type: 'redo' });
    const ts = log.file()!.events.map((e) => e.t);
    expect(ts).toEqual([0, 50, 50]);
  });

  it('merges consecutive events of one group into the first, as undo grouping does', () => {
    const c = fakeClock();
    const log = new SessionRecorder(c.clock);
    log.start(HEADER, 'image');
    c.advance(10);
    for (let i = 0; i < 50; i++) {
      log.record({ type: 'points-moved', datasetId: 'a', count: 3, source: 'drag' }, 'drag:7');
      c.advance(16);
    }
    log.record({ type: 'ref-value-set', axis: 'x', which: 2, value: '7' }, 'value:X2');
    log.record({ type: 'ref-value-set', axis: 'x', which: 2, value: '72' }, 'value:X2');
    log.record({ type: 'points-moved', datasetId: 'a', count: 3, source: 'drag' }, 'drag:8');
    const events = log.file()!.events;
    expect(events.map((e) => e.type)).toEqual(['image-loaded', 'points-moved', 'ref-value-set', 'points-moved']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events[1]!.t).toBe(10);
    expect(events[2]).toMatchObject({ value: '72' });
  });

  it('does not merge across an ungrouped event', () => {
    const log = new SessionRecorder(fakeClock().clock);
    log.start(HEADER, 'image');
    log.record({ type: 'points-moved', datasetId: 'a', count: 1, source: 'nudge' }, 'nudge:k');
    log.record({ type: 'undo' });
    log.record({ type: 'points-moved', datasetId: 'a', count: 1, source: 'nudge' }, 'nudge:k');
    expect(log.file()!.events.map((e) => e.type)).toEqual(['image-loaded', 'points-moved', 'undo', 'points-moved']);
  });

  it('starts over on a new image: new header, seq and t from 0, and a new generation', () => {
    const c = fakeClock();
    const log = new SessionRecorder(c.clock);
    log.start(HEADER, 'image');
    c.advance(500);
    log.record({ type: 'undo' });
    const g = log.generation;
    c.advance(1000);
    log.start({ ...HEADER, imageName: 'other.png' }, 'project');
    const file = log.file()!;
    expect(log.generation).toBe(g + 1);
    expect(file.header.imageName).toBe('other.png');
    expect(file.events).toEqual([{ seq: 0, t: 0, type: 'image-loaded', source: 'project' }]);
  });

  it('hands out copies: a later event does not change a file already taken', () => {
    const log = new SessionRecorder(fakeClock().clock);
    log.start(HEADER, 'image');
    const before = log.file()!;
    log.record({ type: 'undo' });
    expect(before.events).toHaveLength(1);
  });
});

describe('serializeLog', () => {
  it('round-trips through JSON', () => {
    const c = fakeClock();
    const log = new SessionRecorder(c.clock);
    log.start(HEADER, 'image');
    c.advance(3);
    log.record({ type: 'export', kind: 'session-log', filename: 'chart-session.json' });
    expect(JSON.parse(serializeLog(log.file()!))).toEqual(log.file());
  });

  it('can never carry image data: image/dataUrl fields and data:/blob: URLs are removed', () => {
    const log = new SessionRecorder(fakeClock().clock);
    log.start({ ...HEADER, imageName: 'data:image/png;base64,AAAA' }, 'image');
    // A crop action carries the cropped image; its events must not.
    log.record(eventsForAction(doc(), { type: 'crop', image: { ...IMAGE, width: 100, height: 80 }, x0: 5, y0: 6 }));
    // Even an event forced to hold image data loses it on the way out.
    log.record({ type: 'dataset-added', datasetId: 'x', image: IMAGE, dataUrl: IMAGE.dataUrl, note: 'blob:http://localhost/1' } as never);
    const text = serializeLog(log.file()!);
    expect(text).not.toMatch(/data:/i);
    expect(text).not.toMatch(/blob:/i);
    expect(text).not.toMatch(/base64/i);
    expect(text).not.toMatch(/"(image|dataUrl)":/);
    expect(JSON.parse(text).events[1]).toMatchObject({ type: 'crop', rect: { x0: 5, y0: 6, x1: 105, y1: 86 } });
  });

  it('names the file after the image', () => {
    expect(sessionLogFilename('chart')).toBe('chart-session.json');
  });
});

describe('dataUrlBytes', () => {
  it('is the decoded size of a base64 data URL', () => {
    const b64 = (n: number) => btoa(String.fromCharCode(...[1, 2, 3, 4, 5, 6, 7].slice(0, n)));
    expect(dataUrlBytes(`data:image/png;base64,${b64(7)}`)).toBe(7);
    expect(dataUrlBytes(`data:image/png;base64,${b64(6)}`)).toBe(6);
    expect(dataUrlBytes(`data:image/png;base64,${b64(5)}`)).toBe(5);
    expect(dataUrlBytes('data:text/plain,hello')).toBe(0);
  });
});

describe('eventsForAction', () => {
  const d = doc();
  it('maps calibration edits to axis, which and position', () => {
    expect(eventsForAction(d, { type: 'place-ref', ref: 'Y2', px: 3, py: 4.5 })).toEqual([{ type: 'ref-placed', axis: 'y', which: 2, px: { x: 3, y: 4.5 } }]);
    const withRef: DocState = { ...d, refs: { X1: { px: 10, py: 20, value: '0' } } };
    expect(eventsForAction(withRef, { type: 'clear-ref', ref: 'X1' })).toEqual([{ type: 'ref-cleared', axis: 'x', which: 1, px: { x: 10, y: 20 } }]);
    expect(eventsForAction(d, { type: 'set-ref-value', ref: 'X2', value: '72' })).toEqual([{ type: 'ref-value-set', axis: 'x', which: 2, value: '72' }]);
    expect(eventsForAction(d, { type: 'set-scale', axis: 'y', scale: 'log10' })).toEqual([{ type: 'scale-set', axis: 'y', scale: 'log10' }]);
  });

  it('maps point edits with counts per line and their source', () => {
    expect(eventsForAction(d, { type: 'add-point', datasetId: 'line-1', point: { id: 'p', px: 1, py: 2 } })).toEqual([
      { type: 'points-added', datasetId: 'line-1', count: 1, source: 'hand' },
    ]);
    expect(eventsForAction(d, { type: 'add-point', datasetId: 'line-1', point: { id: 'p', px: 1, py: 2 } }, undefined, { snapped: true })[0]).toMatchObject({ source: 'snap' });
    const moves = [
      { datasetId: 'a', pointId: '1', px: 1, py: 1 },
      { datasetId: 'b', pointId: '2', px: 1, py: 1 },
      { datasetId: 'a', pointId: '3', px: 1, py: 1 },
    ];
    expect(eventsForAction(d, { type: 'move-points', moves }, 'drag:3')).toEqual([
      { type: 'points-moved', datasetId: 'a', count: 2, source: 'drag' },
      { type: 'points-moved', datasetId: 'b', count: 1, source: 'drag' },
    ]);
    expect(eventsForAction(d, { type: 'move-points', moves: moves.slice(0, 1) }, 'nudge:a/1:ArrowLeft:1')).toEqual([
      { type: 'points-moved', datasetId: 'a', count: 1, source: 'nudge' },
    ]);
    expect(eventsForAction(d, { type: 'delete-points', points: moves })).toEqual([
      { type: 'points-deleted', datasetId: 'a', count: 2 },
      { type: 'points-deleted', datasetId: 'b', count: 1 },
    ]);
  });

  it('maps line edits, settings and the crop; leaves call-site outcomes and colours out', () => {
    expect(eventsForAction(d, { type: 'add-dataset', dataset: { id: 'n', name: 'Line 2', color: '#000000', points: [] } })).toEqual([{ type: 'dataset-added', datasetId: 'n' }]);
    expect(eventsForAction(d, { type: 'rename-dataset', datasetId: 'n', name: 'Secret name' })).toEqual([{ type: 'dataset-renamed', datasetId: 'n' }]);
    expect(eventsForAction(d, { type: 'delete-dataset', datasetId: 'n' })).toEqual([{ type: 'dataset-deleted', datasetId: 'n' }]);
    expect(eventsForAction(d, { type: 'set-active-dataset', datasetId: 'n' })).toEqual([{ type: 'dataset-activated', datasetId: 'n' }]);
    expect(eventsForAction(d, { type: 'set-settings', settings: { significantFigures: 6 } })).toEqual([{ type: 'setting-changed', key: 'significantFigures', value: 6 }]);
    expect(eventsForAction(d, { type: 'crop', image: { ...IMAGE, width: 300, height: 200 }, x0: 40, y0: 20 })).toEqual([
      { type: 'crop', rect: { x0: 40, y0: 20, x1: 340, y1: 220 } },
    ]);
    expect(eventsForAction(d, { type: 'apply-suggestion', refs: {} })).toEqual([]);
    expect(eventsForAction(d, { type: 'add-points', datasetId: 'line-1', points: [] })).toEqual([]);
    expect(eventsForAction(d, { type: 'recolor-dataset', datasetId: 'line-1', color: '#ff0000' })).toEqual([]);
    expect(eventsForAction(d, { type: 'replace-doc', doc: d })).toEqual([]);
  });
});

describe('autoDetectEvent', () => {
  const axis = (a: 'x' | 'y', over: Partial<AxisSuggestion>): AxisSuggestion => ({
    axis: a,
    mode: 'ticks',
    status: 'calibrated',
    level: 'high',
    confidence: 0.9,
    scale: 'linear',
    scaleCertain: true,
    refs: null,
    labels: [],
    maxResidualPx: null,
    message: 'The axis note "SECRET OCR TEXT" is applied.',
    line: { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } },
    ...over,
  });
  const result = (x: Partial<AxisSuggestion>, y: Partial<AxisSuggestion>) => ({ x: axis('x', x), y: axis('y', y) }) as unknown as AutoCalibration;

  it('reports a suggestion: axes with values, labels read, confidence; no OCR text', () => {
    const labels = new Array(5).fill({}) as AxisSuggestion['labels'];
    const e = autoDetectEvent(result({ labels }, { labels: labels.slice(0, 4), confidence: 0.5, status: 'positions', line: null }), 1234.6);
    expect(e).toEqual({
      type: 'auto-detect-run',
      durationMs: 1235,
      outcome: 'suggested',
      axesSuggested: ['x'],
      declineReason: 'y:no-axis-line',
      labelsRead: 9,
      confidence: { x: 0.9, y: 0.5 },
    });
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });

  it('reports a decline with a code per axis, and a failed run as an error', () => {
    const e = autoDetectEvent(result({ status: 'none' }, { status: 'positions', labels: [{}] as AxisSuggestion['labels'] }), 10);
    expect(e).toMatchObject({ outcome: 'declined', axesSuggested: [], declineReason: 'x:no-tick-labels y:labels-not-usable' });
    expect(autoDetectEvent(null, 5)).toEqual({ type: 'auto-detect-run', durationMs: 5, outcome: 'declined', axesSuggested: [], declineReason: 'error' });
  });
});
