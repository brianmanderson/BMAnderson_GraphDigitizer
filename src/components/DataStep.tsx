import type { ComponentProps } from 'react';
import type { DocState } from '../state/doc.ts';
import { TracePanel } from './TracePanel.tsx';

interface Props {
  doc: DocState;
  calibrated: boolean;
  /** Points selected (on the canvas or in the table), of any lines. */
  selectedCount: number;
  onActivate: (datasetId: string) => void;
  onRename: (datasetId: string, name: string) => void;
  onRecolor: (datasetId: string, color: string) => void;
  onDelete: (datasetId: string) => void;
  onAdd: () => void;
  onDeleteSelected: () => void;
  /** The "Move points" tool is on: clicks select and drags move instead of placing. */
  movePoints: boolean;
  /** The Auto-trace panel's props (it is shown under the lines, beside the active one's controls). */
  trace: Omit<ComponentProps<typeof TracePanel>, 'activeName' | 'activeHasPoints'>;
}

export function DataStep({ doc, calibrated, selectedCount, onActivate, onRename, onRecolor, onDelete, onAdd, onDeleteSelected, movePoints, trace }: Props) {
  const active = doc.datasets.find((d) => d.id === doc.activeDatasetId);
  return (
    <section className="step-body" aria-label="Data">
      {movePoints ? (
        <p className="prompt" data-testid="data-prompt">
          <strong>Move points</strong> is on: click a point to select it (<kbd>Shift</kbd> adds), drag to move the selection,
          drag across empty space to box-select; <kbd>Delete</kbd> removes. <kbd>M</kbd> places points again.
        </p>
      ) : (
        <p className="prompt" data-testid="data-prompt">
          Click on the chart to add a point to <strong>{active?.name}</strong>. To select or drag points, turn on{' '}
          <strong>Move points</strong> (<kbd>M</kbd>).
        </p>
      )}
      {!calibrated && <p className="info">The axes are not calibrated yet, so the table shows pixels only.</p>}

      <ul className="datasets" aria-label="Lines">
        {doc.datasets.map((d) => (
          <li key={d.id} className={d.id === doc.activeDatasetId ? 'active' : undefined}>
            <input
              type="radio"
              name="active-dataset"
              checked={d.id === doc.activeDatasetId}
              onChange={() => onActivate(d.id)}
              aria-label={`Make ${d.name} active`}
            />
            <input
              type="color"
              value={d.color}
              onChange={(e) => onRecolor(d.id, e.target.value)}
              aria-label={`Colour of ${d.name}`}
            />
            <input
              type="text"
              className="name"
              value={d.name}
              onChange={(e) => onRename(d.id, e.target.value)}
              onFocus={() => onActivate(d.id)}
              aria-label="Line name"
            />
            <span className="count" title="Points">
              {d.points.length}
            </span>
            <button
              type="button"
              className="small icon"
              onClick={() => onDelete(d.id)}
              disabled={doc.datasets.length <= 1}
              aria-label={`Delete ${d.name}`}
              title={doc.datasets.length <= 1 ? 'There must be at least one line' : `Delete ${d.name}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="small" onClick={onAdd}>
          + Add line
        </button>
        <button type="button" className="small" onClick={onDeleteSelected} disabled={selectedCount === 0} title="Delete or Backspace">
          {selectedCount === 0 ? 'Delete selected points' : `Delete ${selectedCount} point${selectedCount === 1 ? '' : 's'}`}
        </button>
      </div>
      <TracePanel {...trace} activeName={active?.name ?? ''} activeHasPoints={(active?.points.length ?? 0) > 0} />
    </section>
  );
}
