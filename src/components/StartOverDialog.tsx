import { useEffect, useId, useRef, useState } from 'react';
import { REF_NAMES } from '../core/index.ts';
import type { DocState } from '../state/doc.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the axes hold, in the dialog's words. */
function axesSummary(doc: DocState, calibrated: boolean): string {
  if (calibrated) return 'the axis calibration';
  const placed = REF_NAMES.filter((r) => doc.refs[r]).length;
  return placed === 0 ? 'no axis points yet' : `${placed} of 4 axis points (not yet calibrated)`;
}

interface Props {
  doc: DocState;
  calibrated: boolean;
  onSave: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * "Start over" confirmation (docs/SPEC.md → Start over): a modal `<dialog>` saying what will be
 * lost, with "Save project first…", "Start over" and "Cancel". Esc and Cancel change nothing.
 * Cancel has the focus, so Enter right after the toolbar click does not clear the work.
 */
export function StartOverDialog({ doc, calibrated, onSave, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState(false);
  const titleId = useId();
  const points = doc.datasets.reduce((n, d) => n + d.points.length, 0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    cancel.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      data-testid="start-over-dialog"
      onCancel={(e) => {
        // Esc: the parent unmounts the dialog (which closes it); nothing else happens.
        e.preventDefault();
        onCancel();
      }}
      onKeyDown={(e) => {
        // Keys inside the dialog never reach the app's shortcuts (Esc, Delete, Ctrl+Z …).
        e.stopPropagation();
      }}
    >
      <h2 id={titleId}>Start over?</h2>
      <p>This clears everything in this tab:</p>
      <ul data-testid="start-over-summary">
        <li>
          the image <strong>{doc.image.name}</strong> ({doc.image.width} × {doc.image.height} px)
        </li>
        <li>{axesSummary(doc, calibrated)}</li>
        <li>
          {plural(doc.datasets.length, 'line')} with {plural(points, 'point')}
        </li>
      </ul>
      <p className="muted">
        The autosave in this browser is cleared too, so reloading will not bring it back. This cannot be undone; save the
        project first to keep a copy.
      </p>
      {saved && (
        <p className="muted" role="status">
          Project saved — check your downloads.
        </p>
      )}
      <div className="confirm-actions">
        <button
          type="button"
          onClick={() => {
            onSave();
            setSaved(true);
          }}
        >
          Save project first…
        </button>
        <span className="spacer" />
        <button ref={cancel} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Start over
        </button>
      </div>
    </dialog>
  );
}
