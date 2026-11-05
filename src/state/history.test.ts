import { describe, expect, it } from 'vitest';
import { newDoc, type AppAction, type DocState } from './doc.ts';
import { EMPTY_HISTORY, HISTORY_LIMIT, canRedo, canUndo, historyReducer, type History, type HistoryAction } from './history.ts';

const image = { dataUrl: 'data:image/png;base64,', width: 200, height: 100, name: 'chart.png' };
const other = { dataUrl: 'data:image/png;base64,AA', width: 50, height: 40, name: 'other.png' };

const edit = (action: AppAction, group?: string): HistoryAction =>
  group === undefined ? { type: 'edit', action } : { type: 'edit', action, group };

function run(h: History, ...actions: HistoryAction[]): History {
  return actions.reduce(historyReducer, h);
}

const loaded = () => run(EMPTY_HISTORY, edit({ type: 'replace-doc', doc: newDoc(image, 'd1') }));
const points = (h: History) => h.present!.datasets.flatMap((d) => d.points.map((p) => [p.px, p.py]));
const addPoint = (id: string, px: number, py: number) => edit({ type: 'add-point', datasetId: 'd1', point: { id, px, py } });

describe('historyReducer', () => {
  it('has nothing to undo after the first image', () => {
    const h = loaded();
    expect(h.present?.image.name).toBe('chart.png');
    expect(canUndo(h)).toBe(false);
    expect(run(h, { type: 'undo' })).toBe(h);
  });

  it('undoes and redoes point, ref, scale and dataset changes in order', () => {
    const h = run(
      loaded(),
      addPoint('p1', 10, 20),
      edit({ type: 'place-ref', ref: 'X1', px: 1, py: 2 }),
      edit({ type: 'set-scale', axis: 'y', scale: 'log10' }),
      edit({ type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } }),
      edit({ type: 'rename-dataset', datasetId: 'd2', name: 'Control' }),
    );
    const snapshots: DocState[] = [];
    let u = h;
    while (canUndo(u)) {
      snapshots.push(u.present!);
      u = run(u, { type: 'undo' });
    }
    expect(snapshots).toHaveLength(5);
    expect(u.present).toEqual(newDoc(image, 'd1'));
    expect(snapshots[0]!.datasets[1]!.name).toBe('Control');
    expect(snapshots[1]!.datasets[1]!.name).toBe('B');
    expect(snapshots[2]!.datasets).toHaveLength(1);
    expect(snapshots[2]!.yScale).toBe('log10');
    expect(snapshots[3]!.yScale).toBe('linear');
    expect(snapshots[3]!.refs.X1).toBeDefined();
    expect(snapshots[4]!.refs.X1).toBeUndefined();
    expect(snapshots[4]!.datasets[0]!.points).toHaveLength(1);

    let r = u;
    for (const s of [...snapshots].reverse()) {
      r = run(r, { type: 'redo' });
      expect(r.present).toBe(s);
    }
    expect(canRedo(r)).toBe(false);
  });

  it('a new edit after undo discards the redo branch', () => {
    const h = run(loaded(), addPoint('p1', 1, 1), addPoint('p2', 2, 2), { type: 'undo' });
    expect(canRedo(h)).toBe(true);
    const after = run(h, addPoint('p3', 3, 3));
    expect(canRedo(after)).toBe(false);
    expect(points(after)).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it('merges consecutive edits with the same group into one step (a drag, typing, a held key)', () => {
    let h = run(loaded(), addPoint('p1', 10, 10));
    for (let i = 1; i <= 20; i++) h = run(h, edit({ type: 'move-point', datasetId: 'd1', pointId: 'p1', px: 10 + i, py: 10 }, 'drag:1'));
    expect(points(h)).toEqual([[30, 10]]);
    h = run(h, { type: 'undo' });
    expect(points(h)).toEqual([[10, 10]]);
    h = run(h, { type: 'redo' });
    expect(points(h)).toEqual([[30, 10]]);

    // A different group, or an ungrouped edit, starts a new step; so does undo.
    h = run(
      h,
      edit({ type: 'move-point', datasetId: 'd1', pointId: 'p1', px: 40, py: 10 }, 'drag:2'),
      edit({ type: 'move-point', datasetId: 'd1', pointId: 'p1', px: 50, py: 10 }, 'drag:3'),
    );
    expect(points(run(h, { type: 'undo' }))).toEqual([[40, 10]]);
    h = run(h, edit({ type: 'set-scale', axis: 'x', scale: 'ln' }), edit({ type: 'set-scale', axis: 'x', scale: 'log10' }));
    expect(run(h, { type: 'undo' }).present!.xScale).toBe('ln');

    const typed = run(
      h,
      edit({ type: 'place-ref', ref: 'X2', px: 5, py: 5 }),
      ...['1', '12', '120'].map((value) => edit({ type: 'set-ref-value', ref: 'X2', value }, 'value:X2')),
    );
    expect(typed.present!.refs.X2!.value).toBe('120');
    expect(run(typed, { type: 'undo' }).present!.refs.X2!.value).toBe('');
    // After an undo the same group does not merge into the step below.
    const again = run(typed, { type: 'undo' }, edit({ type: 'set-ref-value', ref: 'X2', value: '7' }, 'value:X2'));
    expect(run(again, { type: 'undo' }).present!.refs.X2!.value).toBe('');
  });

  it('does not record no-ops or switching the active dataset', () => {
    const h = run(
      loaded(),
      edit({ type: 'add-dataset', dataset: { id: 'd2', name: 'B', color: '#000000', points: [] } }),
    );
    expect(h.present!.activeDatasetId).toBe('d2');
    const switched = run(h, edit({ type: 'set-active-dataset', datasetId: 'd1' }));
    expect(switched.present!.activeDatasetId).toBe('d1');
    expect(switched.past).toBe(h.past);
    expect(switched.rev).toBe(h.rev);
    // Ignored edits (unknown ids, non-finite pixels) leave the history as it was.
    expect(run(h, edit({ type: 'delete-point', datasetId: 'nope', pointId: 'x' }))).toBe(h);
    expect(run(h, addPoint('p', NaN, 1))).toBe(h);
  });

  it('makes loading another image undoable', () => {
    let h = run(loaded(), addPoint('p1', 1, 2), edit({ type: 'replace-doc', doc: newDoc(other, 'e1') }));
    expect(h.present!.image.name).toBe('other.png');
    h = run(h, { type: 'undo' });
    expect(h.present!.image.name).toBe('chart.png');
    expect(points(h)).toEqual([[1, 2]]);
  });

  it('reset replaces the document and forgets the history', () => {
    const h = run(loaded(), addPoint('p1', 1, 2), { type: 'reset', doc: newDoc(other, 'e1') });
    expect(h.present!.image.name).toBe('other.png');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('adding several points at once is one undo step', () => {
    const h = run(
      loaded(),
      addPoint('p0', 1, 1),
      edit({
        type: 'add-points',
        datasetId: 'd1',
        points: [1, 2, 3, 4].map((i) => ({ id: `t${i}`, px: 10 * i, py: 5 * i })),
      }),
    );
    expect(points(h)).toHaveLength(5);
    const u = run(h, { type: 'undo' });
    expect(points(u)).toEqual([[1, 1]]);
    expect(run(u, { type: 'redo' }).present).toBe(h.present);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    let h = loaded();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) h = run(h, addPoint(`p${i}`, i, i));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    while (canUndo(h)) h = run(h, { type: 'undo' });
    expect(points(h)).toHaveLength(25);
  });

  it('bumps rev on every recorded change so an Undo notice can tell it is stale', () => {
    const h0 = loaded();
    const h1 = run(h0, addPoint('p1', 1, 1));
    expect(h1.rev).toBe(h0.rev + 1);
    const h2 = run(h1, edit({ type: 'move-point', datasetId: 'd1', pointId: 'p1', px: 2, py: 2 }, 'g'));
    const h3 = run(h2, edit({ type: 'move-point', datasetId: 'd1', pointId: 'p1', px: 3, py: 3 }, 'g'));
    expect(h3.rev).toBe(h2.rev + 1);
    expect(run(h3, { type: 'undo' }).rev).toBe(h3.rev + 1);
  });
});
