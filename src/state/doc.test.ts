import { describe, expect, it } from 'vitest';
import { calibrateSpec } from '../core/index.ts';
import {
  appReducer,
  calibrationSpec,
  cropLosses,
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

  const twoLines = () =>
    apply(
      newDoc(image, 'd1'),
      { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } },
      { type: 'add-points', datasetId: 'd1', points: [{ id: 'a', px: 1, py: 1 }, { id: 'b', px: 2, py: 2 }, { id: 'c', px: 3, py: 3 }] },
      { type: 'add-points', datasetId: 'd2', points: [{ id: 'x', px: 4, py: 4 }, { id: 'y', px: 5, py: 5 }] },
    );

  it('deletes several points of several datasets in one edit', () => {
    const s = twoLines();
    const t = docReducer(s, {
      type: 'delete-points',
      points: [
        { datasetId: 'd1', pointId: 'a' },
        { datasetId: 'd2', pointId: 'y' },
        { datasetId: 'd1', pointId: 'c' },
      ],
    });
    expect(t.datasets.map((d) => d.points.map((p) => p.id))).toEqual([['b'], ['x']]);
    // A point id only counts in its own dataset; nothing matching (or nothing at all) is no edit.
    expect(docReducer(s, { type: 'delete-points', points: [{ datasetId: 'd2', pointId: 'a' }] })).toBe(s);
    expect(docReducer(s, { type: 'delete-points', points: [] })).toBe(s);
  });

  it('moves several points of several datasets in one edit, ignoring non-finite positions', () => {
    const s = twoLines();
    const t = docReducer(s, {
      type: 'move-points',
      moves: [
        { datasetId: 'd1', pointId: 'b', px: 12.5, py: 20 },
        { datasetId: 'd2', pointId: 'x', px: 14, py: 24.25 },
        { datasetId: 'd2', pointId: 'y', px: NaN, py: 1 },
      ],
    });
    expect(t.datasets[0]!.points).toEqual([
      { id: 'a', px: 1, py: 1 },
      { id: 'b', px: 12.5, py: 20 },
      { id: 'c', px: 3, py: 3 },
    ]);
    expect(t.datasets[1]!.points).toEqual([
      { id: 'x', px: 14, py: 24.25 },
      { id: 'y', px: 5, py: 5 },
    ]);
    expect(t.datasets[0]!.points[0]).toBe(s.datasets[0]!.points[0]);
    // Moving to where they already are, or moving unknown points, changes nothing.
    expect(docReducer(s, { type: 'move-points', moves: [{ datasetId: 'd1', pointId: 'a', px: 1, py: 1 }] })).toBe(s);
    expect(docReducer(s, { type: 'move-points', moves: [{ datasetId: 'd1', pointId: 'x', px: 9, py: 9 }] })).toBe(s);
  });

  it('adds several points to one dataset in one edit, dropping non-finite ones', () => {
    const s = newDoc(image, 'd1');
    expect(docReducer(s, { type: 'add-points', datasetId: 'd1', points: [] })).toBe(s);
    expect(docReducer(s, { type: 'add-points', datasetId: 'd1', points: [{ id: 'p', px: NaN, py: 1 }] })).toBe(s);
    const t = apply(
      s,
      { type: 'add-point', datasetId: 'd1', point: { id: 'p0', px: 1, py: 1 } },
      {
        type: 'add-points',
        datasetId: 'd1',
        points: [
          { id: 'p1', px: 2.5, py: 3 },
          { id: 'p2', px: Infinity, py: 3 },
          { id: 'p3', px: 4, py: 5.25 },
        ],
      },
    );
    expect(t.datasets[0]!.points.map((p) => p.id)).toEqual(['p0', 'p1', 'p3']);
    expect(docReducer(t, { type: 'add-points', datasetId: 'nope', points: [{ id: 'p4', px: 1, py: 1 }] })).toBe(t);
  });

  it('adds a dataset with points, dropping non-finite ones', () => {
    const s = docReducer(newDoc(image, 'd1'), {
      type: 'add-dataset',
      dataset: { id: 'd2', name: 'B', color: '#000000', points: [{ id: 'p1', px: 1, py: 2 }, { id: 'p2', px: 1, py: NaN }] },
    });
    expect(s.datasets[1]!.points).toEqual([{ id: 'p1', px: 1, py: 2 }]);
    expect(s.activeDatasetId).toBe('d2');
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

  describe('crop', () => {
    const cropped = { dataUrl: 'data:image/png;base64,AAA', width: 100, height: 60, name: 'chart.png' };
    /** Calibrated 200 × 100 image with points; a crop of columns 50…149 and rows 20…79 keeps some. */
    const withWork = () =>
      apply(
        calibrated(newDoc(image, 'd1')),
        { type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } },
        {
          type: 'add-points',
          datasetId: 'd1',
          points: [
            { id: 'in', px: 100.25, py: 50.5 },
            { id: 'left-of', px: 49.49, py: 50 },
            { id: 'above', px: 100, py: 19.49 },
          ],
        },
        { type: 'add-points', datasetId: 'd2', points: [{ id: 'edge', px: 149.5, py: 79.5 }, { id: 'right-of', px: 149.51, py: 50 }] },
        { type: 'set-active-dataset', datasetId: 'd1' },
      );
    const crop = (s: DocState) => docReducer(s, { type: 'crop', image: cropped, x0: 50, y0: 20 });

    it('replaces the image and moves every ref and point by (−x0, −y0)', () => {
      const s = withWork();
      const t = crop(s);
      expect(t.image).toBe(cropped);
      // X1 (10, 90) and Y1 (10, 90) fall outside; X2 (190, 90) too; Y2 (10, 10) too — only the
      // point data shows the translation here, the refs are checked below.
      expect(t.datasets[0]!.points.find((p) => p.id === 'in')).toEqual({ id: 'in', px: 50.25, py: 30.5 });
      expect(t.activeDatasetId).toBe('d1');
      expect(t.settings).toBe(s.settings);
      expect(t.xScale).toBe(s.xScale);
    });

    it('keeps refs that land on the new image, moved, and drops the others', () => {
      let s = apply(
        newDoc(image, 'd1'),
        { type: 'place-ref', ref: 'X1', px: 49.5, py: 79.5 },
        { type: 'set-ref-value', ref: 'X1', value: '0' },
        { type: 'place-ref', ref: 'X2', px: 149.5, py: 79.5 },
        { type: 'set-ref-value', ref: 'X2', value: '10' },
        { type: 'place-ref', ref: 'Y1', px: 49.5, py: 79.5 },
        { type: 'place-ref', ref: 'Y2', px: 49.5, py: 19.4 },
      );
      s = crop(s);
      // The crop's edges are at x0 − ½ and x1 − ½: a ref exactly on one stays (at the new edge).
      expect(s.refs).toEqual({
        X1: { px: -0.5, py: 59.5, value: '0' },
        X2: { px: 99.5, py: 59.5, value: '10' },
        Y1: { px: -0.5, py: 59.5, value: '' },
      });
      expect(nextUnplacedRef(s.refs)).toBe('Y2');
      expect(calibrationSpec(s)).toBeNull();
    });

    it('drops points outside the crop, half-pixel edges included, in every dataset', () => {
      const t = crop(withWork());
      expect(t.datasets[0]!.points.map((p) => p.id)).toEqual(['in']);
      expect(t.datasets[1]!.points).toEqual([{ id: 'edge', px: 99.5, py: 59.5 }]);
      expect(t.datasets.map((d) => d.id)).toEqual(['d1', 'd2']);
    });

    it('counts what a crop would drop', () => {
      const s = withWork();
      expect(cropLosses(s, 50, 20, 100, 60)).toEqual({ refs: 4, points: 3 });
      expect(cropLosses(s, 0, 0, 200, 100)).toEqual({ refs: 0, points: 0 });
      expect(cropLosses(newDoc(image, 'd1'), 50, 20, 100, 60)).toEqual({ refs: 0, points: 0 });
    });

    it('ignores an invalid crop (non-finite offset, missing or empty image)', () => {
      const s = withWork();
      expect(docReducer(s, { type: 'crop', image: cropped, x0: NaN, y0: 20 })).toBe(s);
      expect(docReducer(s, { type: 'crop', image: cropped, x0: 50, y0: Infinity })).toBe(s);
      expect(docReducer(s, { type: 'crop', image: { ...cropped, width: 0 }, x0: 50, y0: 20 })).toBe(s);
      expect(docReducer(s, { type: 'crop', image: { ...cropped, height: NaN }, x0: 50, y0: 20 })).toBe(s);
      expect(docReducer(s, { type: 'crop', image: undefined as unknown as typeof cropped, x0: 50, y0: 20 })).toBe(s);
    });
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
