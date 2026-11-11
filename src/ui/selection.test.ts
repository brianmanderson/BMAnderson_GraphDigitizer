/** The multi-point selection model (src/ui/selection.ts) and moving a group as one (nudge, drag). */

import { describe, expect, it } from 'vitest';
import { docReducer, newDoc, type DocState } from '../state/doc.ts';
import { hitTest, type Target } from './draw.ts';
import { nudgedAll } from './nudge.ts';
import {
  EMPTY_SELECTION,
  applySelect,
  lastPoint,
  linePoints,
  pointsInRect,
  selectedPoints,
  selectionKeys,
  validSelection,
  withoutHidden,
} from './selection.ts';
import { IDENTITY_VIEW, clampDelta } from './view.ts';

const image = { dataUrl: 'data:image/png;base64,', width: 200, height: 100, name: 'chart.png' };

function doc(): DocState {
  let s = newDoc(image, 'd1');
  s = docReducer(s, { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } });
  s = docReducer(s, { type: 'add-points', datasetId: 'd1', points: [{ id: 'a', px: 10, py: 10 }, { id: 'b', px: 50, py: 40 }] });
  s = docReducer(s, { type: 'add-points', datasetId: 'd2', points: [{ id: 'x', px: 52, py: 42 }, { id: 'y', px: 150, py: 90 }] });
  return s;
}

const pt = (datasetId: string, pointId: string): Target => ({ kind: 'point', datasetId, pointId });
const ids = (sel: readonly Target[]) => sel.map((t) => (t.kind === 'ref' ? t.ref : t.pointId));

describe('selection', () => {
  it('a plain pick replaces, Shift toggles (appending), a Shift+marquee adds', () => {
    let sel = applySelect(EMPTY_SELECTION, [pt('d1', 'a')], 'replace');
    sel = applySelect(sel, [pt('d2', 'x')], 'toggle');
    sel = applySelect(sel, [pt('d1', 'b')], 'toggle');
    expect(ids(sel)).toEqual(['a', 'x', 'b']);
    expect(lastPoint(sel)).toEqual(pt('d1', 'b'));
    sel = applySelect(sel, [pt('d2', 'x')], 'toggle');
    expect(ids(sel)).toEqual(['a', 'b']);
    // Adding keeps what is selected where it is and appends the rest, once.
    sel = applySelect(sel, [pt('d1', 'b'), pt('d2', 'y'), pt('d2', 'y')], 'add');
    expect(ids(sel)).toEqual(['a', 'b', 'y']);
    expect(ids(applySelect(sel, [pt('d2', 'x'), pt('d2', 'x')], 'replace'))).toEqual(['x']);
    expect(applySelect(sel, [], 'replace')).toEqual([]);
  });

  it('keys points by line, so equal point ids in two lines stay apart', () => {
    const sel = applySelect([pt('d1', 'p')], [pt('d2', 'p')], 'toggle');
    expect(sel).toHaveLength(2);
    expect(selectionKeys(sel)).toEqual(new Set(['d1/p', 'd2/p']));
  });

  it('refs are single-select and never mix with points', () => {
    const ref: Target = { kind: 'ref', ref: 'X1' };
    expect(applySelect([pt('d1', 'a'), pt('d1', 'b')], [ref], 'toggle')).toEqual([ref]);
    expect(applySelect([ref], [pt('d1', 'a')], 'toggle')).toEqual([pt('d1', 'a')]);
    expect(selectedPoints([ref])).toEqual([]);
    expect(lastPoint([ref])).toBeNull();
  });

  it('drops points the document no longer has (undo, deleted line), and keeps identity otherwise', () => {
    const d = doc();
    const sel = [pt('d1', 'a'), pt('d2', 'x'), pt('d2', 'y')];
    expect(validSelection(d, sel)).toBe(sel);
    const noLine = docReducer(d, { type: 'delete-dataset', datasetId: 'd2' });
    expect(validSelection(noLine, sel)).toEqual([pt('d1', 'a')]);
    const noPoint = docReducer(d, { type: 'delete-points', points: [{ datasetId: 'd2', pointId: 'y' }] });
    expect(validSelection(noPoint, sel)).toEqual([pt('d1', 'a'), pt('d2', 'x')]);
    expect(validSelection(d, [{ kind: 'ref', ref: 'Y2' }])).toEqual([]);
  });

  it('a marquee takes every point of any line inside it, edges included, from either corner', () => {
    const d = doc();
    expect(ids(pointsInRect(d, { px: 60, py: 50 }, { px: 40, py: 30 }))).toEqual(['b', 'x']);
    expect(ids(pointsInRect(d, { px: 10, py: 10 }, { px: 150, py: 90 }))).toEqual(['a', 'b', 'x', 'y']);
    expect(pointsInRect(d, { px: 60, py: 0 }, { px: 140, py: 100 })).toEqual([]);
    expect(ids(linePoints(d, 'd2'))).toEqual(['x', 'y']);
    expect(linePoints(d, 'nope')).toEqual([]);
  });
});

describe('hidden lines (the eye toggle)', () => {
  const hidden = new Set(['d2']);

  it('a marquee skips the points of hidden lines', () => {
    const d = doc();
    expect(ids(pointsInRect(d, { px: 10, py: 10 }, { px: 150, py: 90 }, hidden))).toEqual(['a', 'b']);
    expect(pointsInRect(d, { px: 140, py: 80 }, { px: 160, py: 100 }, hidden)).toEqual([]);
  });

  it('a click never hits a hidden point, even right on it or over a visible neighbour', () => {
    const d = docReducer(doc(), { type: 'set-active-dataset', datasetId: 'd2' });
    // Unhidden, the active line's point wins the overlap at (52, 42); hidden, the other line's does.
    expect(hitTest(d, IDENTITY_VIEW, 52, 42, 'data')).toEqual(pt('d2', 'x'));
    expect(hitTest(d, IDENTITY_VIEW, 52, 42, 'data', hidden)).toEqual(pt('d1', 'b'));
    expect(hitTest(d, IDENTITY_VIEW, 150, 90, 'data', hidden)).toBeNull();
  });

  it('drops the points of hidden lines from a selection, keeping refs and identity otherwise', () => {
    const sel = [pt('d1', 'a'), pt('d2', 'x'), pt('d2', 'y')];
    expect(withoutHidden(sel, hidden)).toEqual([pt('d1', 'a')]);
    expect(withoutHidden(sel, new Set())).toBe(sel);
    expect(withoutHidden(sel, new Set(['d3']))).toBe(sel);
    const ref: Target = { kind: 'ref', ref: 'X1' };
    expect(withoutHidden([ref], hidden)).toEqual([ref]);
  });
});

describe('moving a group', () => {
  it('shortens the move per axis so every point stays on the image (the shape is kept)', () => {
    const ps = [
      { px: 10, py: 10 },
      { px: 190, py: 50 },
    ];
    expect(clampDelta(ps, 20, -5, 200, 100)).toEqual({ dx: 9.5, dy: -5 });
    expect(clampDelta(ps, -20, 80, 200, 100)).toEqual({ dx: -10.5, dy: 49.5 });
    expect(clampDelta([], 3, 4, 200, 100)).toEqual({ dx: 3, dy: 4 });
    // Already at the edge: no further, but back inward is fine.
    expect(clampDelta([{ px: 199.5, py: 0 }], 1, 0, 200, 100)).toEqual({ dx: 0, dy: 0 });
    expect(clampDelta([{ px: 199.5, py: 0 }], -1, 0, 200, 100)).toEqual({ dx: -1, dy: 0 });
  });

  it('nudges a selection together, rounding like a single nudge', () => {
    const ps = [
      { px: 10, py: 10 },
      { px: 199, py: 50 },
    ];
    expect(nudgedAll(ps, [1, 0], 10, 200, 100)).toEqual([
      { px: 10.5, py: 10 },
      { px: 199.5, py: 50 },
    ]);
    let q = ps;
    for (let i = 0; i < 10; i++) q = nudgedAll(q, [0, 1], 0.1, 200, 100);
    expect(q).toEqual([
      { px: 10, py: 11 },
      { px: 199, py: 51 },
    ]);
  });
});
