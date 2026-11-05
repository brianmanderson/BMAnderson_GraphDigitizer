import type { ComponentProps } from 'react';
import type { DocState } from '../state/doc.ts';
import type { Target } from '../ui/draw.ts';
import { TracePanel } from './TracePanel.tsx';

interface Props {
  doc: DocState;
  calibrated: boolean;
  selected: Target | null;
  onActivate: (datasetId: string) => void;
  onRename: (datasetId: string, name: string) => void;
  onRecolor: (datasetId: string, color: string) => void;
  onDelete: (datasetId: string) => void;
  onAdd: () => void;
  onDeleteSelected: () => void;
  /** The Auto-trace panel's props (it is shown under the lines, beside the active one's controls). */
  trace: Omit<ComponentProps<typeof TracePanel>, 'activeName' | 'activeHasPoints'>;
}

export function DataStep({ doc, calibrated, selected, onActivate, onRename, onRecolor, onDelete, onAdd, onDeleteSelected, trace }: Props) {
  const active = doc.datasets.find((d) => d.id === doc.activeDatasetId);
  return (
    <section className="step-body" aria-label="Data">
      <p className="prompt">
        Click on the chart to add a point to <strong>{active?.name}</strong>. Drag a point to move it; select it and press{' '}
        <kbd>Delete</kbd> to remove it.
      </p>
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
        <button type="button" className="small" onClick={onDeleteSelected} disabled={selected?.kind !== 'point'}>
          Delete selected point
        </button>
      </div>
      <TracePanel {...trace} activeName={active?.name ?? ''} activeHasPoints={(active?.points.length ?? 0) > 0} />
    </section>
  );
}
