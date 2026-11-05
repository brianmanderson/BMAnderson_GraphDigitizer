import { describe, expect, it } from 'vitest';
import type { TraceResult } from '../auto/trace/types.ts';
import { newDoc, type DocState } from '../state/doc.ts';
import { EMPTY_HISTORY, historyReducer, type History } from '../state/history.ts';
import { acceptTraceAction, clampMaxPoints, lineColorOf, rgbHex, traceColor, traceGhostOf, tracedPoints } from './trace.ts';

const image = { dataUrl: 'data:image/png;base64,', width: 200, height: 100, name: 'chart.png' };

const result = (points: [number, number][], color: [number, number, number] = [28, 95, 168]): TraceResult => ({
  ok: true,
  kind: 'curve',
  style: 'solid',
  color,
  path: points.map(([px, py]) => ({ px, py, confidence: 1 })),
  points: points.map(([px, py]) => ({ px, py, confidence: 1 })),
  timings: { totalMs: 1 },
});

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

const withPoint = (): DocState => {
  const d = newDoc(image, 'd1');
  return { ...d, datasets: [{ ...d.datasets[0]!, points: [{ id: 'p0', px: 1, py: 1 }] }] };
};

describe('auto-trace', () => {
  it('clamps the requested point count', () => {
    expect(clampMaxPoints(25)).toBe(25);
    expect(clampMaxPoints(0)).toBe(2);
    expect(clampMaxPoints(1e6)).toBe(200);
    expect(clampMaxPoints(12.6)).toBe(13);
    expect(clampMaxPoints(NaN)).toBe(25);
  });

  it('uses a colourful series colour for a new line, not a black or grey one', () => {
    expect(rgbHex([28, 95, 168])).toBe('#1c5fa8');
    expect(lineColorOf([28, 95, 168])).toBe('#1c5fa8');
    expect(lineColorOf([20, 20, 20])).toBeNull();
    expect(lineColorOf([128, 140, 130])).toBeNull();
  });

  it('offers only finite points on the image', () => {
    const r = result([
      [10, 10],
      [NaN, 5],
      [250, 10],
      [-0.5, 10],
      [199.4, 99.4],
    ]);
    expect(tracedPoints(newDoc(image, 'd1'), r)).toEqual([
      { px: 10, py: 10 },
      { px: -0.5, py: 10 },
      { px: 199.4, py: 99.4 },
    ]);
  });

  it('accepting appends to the active line, or makes a new line in the series colour', () => {
    const doc = withPoint();
    const r = result([
      [10, 20],
      [30, 40],
    ]);
    expect(acceptTraceAction(doc, 'active', r, ids())).toEqual({
      type: 'add-points',
      datasetId: 'd1',
      points: [
        { id: 'id1', px: 10, py: 20 },
        { id: 'id2', px: 30, py: 40 },
      ],
    });
    expect(acceptTraceAction(doc, 'new', r, ids())).toEqual({
      type: 'add-dataset',
      dataset: {
        id: 'id3',
        name: 'Line 2',
        color: '#1c5fa8',
        points: [
          { id: 'id1', px: 10, py: 20 },
          { id: 'id2', px: 30, py: 40 },
        ],
      },
    });
    const black = acceptTraceAction(doc, 'new', result([[1, 2]], [0, 0, 0]), ids());
    expect(black?.type === 'add-dataset' && black.dataset.color).not.toBe('#000000');
  });

  it('accepts nothing from a failed or empty trace', () => {
    const doc = withPoint();
    expect(acceptTraceAction(doc, 'active', { ...result([[1, 1]]), ok: false, kind: 'none' }, ids())).toBeNull();
    expect(acceptTraceAction(doc, 'active', result([]), ids())).toBeNull();
  });

  it('accepting is one undo step, and undo removes every traced point', () => {
    const loaded: History = historyReducer(EMPTY_HISTORY, { type: 'edit', action: { type: 'replace-doc', doc: withPoint() } });
    const r = result(Array.from({ length: 25 }, (_, i): [number, number] => [5 + i * 7, 50 + Math.sin(i) * 20]));
    const action = acceptTraceAction(loaded.present!, 'active', r, ids())!;
    const accepted = historyReducer(loaded, { type: 'edit', action });
    expect(accepted.present!.datasets[0]!.points).toHaveLength(26);
    expect(accepted.past).toHaveLength(loaded.past.length + 1);
    const undone = historyReducer(accepted, { type: 'undo' });
    expect(undone.present).toBe(loaded.present);

    const intoNew = historyReducer(loaded, { type: 'edit', action: acceptTraceAction(loaded.present!, 'new', r, ids())! });
    expect(intoNew.present!.datasets).toHaveLength(2);
    expect(intoNew.present!.activeDatasetId).toBe(intoNew.present!.datasets[1]!.id);
    expect(historyReducer(intoNew, { type: 'undo' }).present).toBe(loaded.present);
  });

  it('draws the ghost in the colour the points will get', () => {
    const doc = withPoint();
    expect(traceGhostOf(doc, null)).toBeNull();
    expect(traceGhostOf(doc, { status: 'picking', target: 'active' })).toBeNull();
    const seed = { px: 10, py: 20 };
    expect(traceGhostOf(doc, { status: 'running', target: 'active', seed })).toEqual({ color: '#d6336c', seed, path: [], points: [] });
    const done = traceGhostOf(doc, { status: 'done', target: 'new', seed, result: result([[10, 20]]) });
    expect(done?.color).toBe('#1c5fa8');
    expect(done?.points).toEqual([{ px: 10, py: 20 }]);
    expect(traceColor(doc, 'new', null)).toBe('#1c7ed6');
  });
});
