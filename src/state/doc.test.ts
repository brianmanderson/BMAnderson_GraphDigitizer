import { describe, expect, it } from 'vitest';
import { calibrateSpec } from '../core/index.ts';
import {
  appReducer,
  calibrationSpec,
  docReducer,
  fromProject,
  hasWork,
  newDoc,
  nextDatasetDefaults,
  nextUnplacedRef,
  toProject,
  type DocAction,
  type DocState,
} from './doc.ts';

const image = { dataUrl: 'data:image/png;base64,', width: 200, height: 100, name: 'chart.png' };

function apply(state: DocState, ...actions: DocAction[]): DocState {
  return actions.reduce(docReducer, state);
}

const calibrated = (s: DocState) =>
  apply(
    s,
    { type: 'place-ref', ref: 'X1', px: 10, py: 90 },
    { type: 'set-ref-value', ref: 'X1', value: '0' },
    { type: 'place-ref', ref: 'X2', px: 190, py: 90 },
    { type: 'set-ref-value', ref: 'X2', value: '10' },
    { type: 'place-ref', ref: 'Y1', px: 10, py: 90 },
    { type: 'set-ref-value', ref: 'Y1', value: '0' },
    { type: 'place-ref', ref: 'Y2', px: 10, py: 10 },
    { type: 'set-ref-value', ref: 'Y2', value: '1' },
  );

describe('docReducer', () => {
  it('starts a new image with no refs and one empty, active dataset', () => {
    const s = newDoc(image, 'd1');
    expect(s.refs).toEqual({});
    expect(s.datasets).toHaveLength(1);
    expect(s.activeDatasetId).toBe('d1');
    expect(nextUnplacedRef(s.refs)).toBe('X1');
  });

  it('places refs in guided order and keeps a typed value when a ref is moved', () => {
    let s = apply(newDoc(image, 'd1'), { type: 'place-ref', ref: 'X1', px: 1, py: 2 }, { type: 'set-ref-value', ref: 'X1', value: '5' });
    expect(nextUnplacedRef(s.refs)).toBe('X2');
    s = docReducer(s, { type: 'place-ref', ref: 'X1', px: 3, py: 4 });
    expect(s.refs.X1).toEqual({ px: 3, py: 4, value: '5' });
    s = docReducer(s, { type: 'clear-ref', ref: 'X1' });
    expect(nextUnplacedRef(s.refs)).toBe('X1');
  });

  it('ignores non-finite positions instead of storing them', () => {
    const s = newDoc(image, 'd1');
    expect(docReducer(s, { type: 'place-ref', ref: 'X1', px: NaN, py: 0 })).toBe(s);
    expect(docReducer(s, { type: 'add-point', datasetId: 'd1', point: { id: 'p', px: Infinity, py: 0 } })).toBe(s);
  });

  it('changing a scale or ref never moves points', () => {
    let s = calibrated(newDoc(image, 'd1'));
    s = docReducer(s, { type: 'add-point', datasetId: 'd1', point: { id: 'p1', px: 100, py: 50 } });
    const before = s.datasets[0]!.points;
    s = apply(s, { type: 'set-scale', axis: 'x', scale: 'log10' }, { type: 'place-ref', ref: 'Y2', px: 12, py: 8 });
    expect(s.datasets[0]!.points).toBe(before);
  });

  it('adds, moves and deletes points in the right dataset', () => {
    let s = apply(
      newDoc(image, 'd1'),
      { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } },
      { type: 'add-point', datasetId: 'd2', point: { id: 'p1', px: 1, py: 1 } },
      { type: 'add-point', datasetId: 'd1', point: { id: 'p2', px: 2, py: 2 } },
      { type: 'move-point', datasetId: 'd2', pointId: 'p1', px: 5.25, py: 6.5 },
    );
    expect(s.activeDatasetId).toBe('d2');
    expect(s.datasets[1]!.points).toEqual([{ id: 'p1', px: 5.25, py: 6.5 }]);
    s = docReducer(s, { type: 'delete-point', datasetId: 'd2', pointId: 'p1' });
    expect(s.datasets[1]!.points).toEqual([]);
    expect(s.datasets[0]!.points).toHaveLength(1);
  });

  it('keeps at least one dataset and re-targets the active one on delete', () => {
    let s = newDoc(image, 'd1');
    expect(docReducer(s, { type: 'delete-dataset', datasetId: 'd1' })).toBe(s);
    s = apply(
      s,
      { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#111111', points: [] } },
      { type: 'rename-dataset', datasetId: 'd2', name: 'Treated' },
      { type: 'recolor-dataset', datasetId: 'd2', color: '#222222' },
      { type: 'delete-dataset', datasetId: 'd2' },
    );
    expect(s.datasets.map((d) => d.id)).toEqual(['d1']);
    expect(s.activeDatasetId).toBe('d1');
  });

  it('applies an auto-detect suggestion in one edit, keeping refs it does not mention', () => {
    let s = docReducer(newDoc(image, 'd1'), { type: 'place-ref', ref: 'Y1', px: 5, py: 6 });
    s = docReducer(s, { type: 'set-ref-value', ref: 'Y1', value: '7' });
    s = docReducer(s, {
      type: 'apply-suggestion',
      xScale: 'log10',
      refs: { X1: { px: 10, py: 90, value: '1' }, X2: { px: 90, py: 90, value: '' }, Y2: { px: NaN, py: 1, value: '3' } },
    });
    expect(s.xScale).toBe('log10');
    expect(s.yScale).toBe('linear');
    expect(s.refs).toEqual({ X1: { px: 10, py: 90, value: '1' }, X2: { px: 90, py: 90, value: '' }, Y1: { px: 5, py: 6, value: '7' } });
  });

  it('suggests unused line names (Line 2, …) and colours', () => {
    const s = newDoc(image, 'd1');
    const next = nextDatasetDefaults(s);
    expect(next.name).toBe('Line 2');
    expect(next.color).not.toBe(s.datasets[0]!.color);
  });

  it('appReducer replaces the whole document and ignores edits before an image exists', () => {
    expect(appReducer(null, { type: 'set-scale', axis: 'x', scale: 'ln' })).toBeNull();
    const doc = newDoc(image, 'd1');
    expect(appReducer(null, { type: 'replace-doc', doc })).toBe(doc);
    expect(hasWork(doc)).toBe(false);
    expect(hasWork(docReducer(doc, { type: 'place-ref', ref: 'X1', px: 0, py: 0 }))).toBe(true);
  });
});

describe('Project conversion', () => {
  it('has no calibration until all four refs are placed', () => {
    const s = apply(newDoc(image, 'd1'), { type: 'place-ref', ref: 'X1', px: 1, py: 1 });
    expect(calibrationSpec(s)).toBeNull();
    expect(toProject(s).calibration).toBeNull();
  });

  it('stores numeric ref text as numbers and date text as typed', () => {
    let s = calibrated(newDoc(image, 'd1'));
    expect(toProject(s).calibration!.refs.X2.value).toBe(10);
    s = apply(s, { type: 'set-scale', axis: 'x', scale: 'date' }, { type: 'set-ref-value', ref: 'X2', value: '2024-03-15' });
    expect(toProject(s).calibration!.refs.X2.value).toBe('2024-03-15');
    // Unparseable numeric text is kept so calibrate() can report it.
    s = apply(s, { type: 'set-scale', axis: 'x', scale: 'linear' }, { type: 'set-ref-value', ref: 'X2', value: '1o' });
    const r = calibrateSpec(calibrationSpec(s)!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-value');
  });

  it('round-trips through toProject / fromProject', () => {
    const s = docReducer(calibrated(newDoc(image, 'd1')), {
      type: 'add-point',
      datasetId: 'd1',
      point: { id: 'p1', px: 50.5, py: 20.25 },
    });
    const project = toProject(s);
    expect(project.version).toBe(2);
    expect('draftCalibration' in project).toBe(false);
    const back = fromProject(JSON.parse(JSON.stringify(project)));
    expect(toProject(back)).toEqual(project);
  });

  it('saves a calibration in progress as draftCalibration and restores it', () => {
    const s = apply(
      newDoc(image, 'd1'),
      { type: 'set-scale', axis: 'x', scale: 'date' },
      { type: 'set-scale', axis: 'y', scale: 'log10' },
      { type: 'place-ref', ref: 'X1', px: 10, py: 90 },
      { type: 'set-ref-value', ref: 'X1', value: '2024-03-15' },
      { type: 'place-ref', ref: 'Y1', px: 10, py: 90 },
      { type: 'set-ref-value', ref: 'Y1', value: '10' },
    );
    const project = toProject(s);
    expect(project.calibration).toBeNull();
    expect(project.draftCalibration).toEqual({
      xScale: 'date',
      yScale: 'log10',
      refs: { X1: { px: 10, py: 90, value: '2024-03-15' }, Y1: { px: 10, py: 90, value: 10 } },
    });
    const back = fromProject(JSON.parse(JSON.stringify(project)));
    expect(back.xScale).toBe('date');
    expect(back.yScale).toBe('log10');
    expect(back.refs).toEqual(s.refs);
    expect(toProject(back)).toEqual(project);
  });

  it('restores the active dataset when it still exists', () => {
    const s = docReducer(newDoc(image, 'd1'), { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } });
    const project = toProject(s);
    expect(fromProject(project, 'd2').activeDatasetId).toBe('d2');
    expect(fromProject(project, 'gone').activeDatasetId).toBe('d1');
    expect(fromProject(project).activeDatasetId).toBe('d1');
  });
});
