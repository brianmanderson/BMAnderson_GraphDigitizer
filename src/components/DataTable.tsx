import { memo, useEffect, useId, useMemo, useRef } from 'react';
import type { Calibration } from '../core/index.ts';
import type { DocState } from '../state/doc.ts';
import type { Target } from '../ui/draw.ts';
import { lastPoint, selectionKeys, type SelectHow, type Selection } from '../ui/selection.ts';
import { datasetRows, formatPixel, formatValue, type TableOptions } from '../ui/table.ts';

interface Props {
  doc: DocState;
  calibration: Calibration | null;
  options: TableOptions;
  /** Every selected row is highlighted; the last selected point's row is scrolled into view. */
  selection: Selection;
  /** Ids of the lines whose rows are collapsed (UI state only; exports always hold every point). */
  collapsed: ReadonlySet<string>;
  onToggle: (datasetId: string) => void;
  onCollapseAll: (collapse: boolean) => void;
  /** A row click: replaces the selection, or toggles the row with Shift / Ctrl / Cmd. */
  onSelect: (targets: readonly Target[], how: SelectHow) => void;
  /** "Select all" in a line's header. */
  onSelectLine: (datasetId: string) => void;
  onOptions: (patch: Partial<TableOptions>) => void;
  onExportCsv: () => void;
  onCopyTsv: () => void;
  onExportJson: () => void;
}

/** Live table of every dataset's points, with display options and the export buttons. */
export const DataTable = memo(function DataTable({
  doc,
  calibration,
  options,
  selection,
  collapsed,
  onToggle,
  onCollapseAll,
  onSelect,
  onSelectLine,
  onOptions,
  onExportCsv,
  onCopyTsv,
  onExportJson,
}: Props) {
  const hasDate = doc.xScale === 'date' || doc.yScale === 'date';
  const total = doc.datasets.reduce((n, d) => n + d.points.length, 0);
  const nCollapsed = doc.datasets.filter((d) => collapsed.has(d.id)).length;
  const idPrefix = useId();
  const tables = useRef<HTMLDivElement>(null);

  const selectedKeys = useMemo(() => selectionKeys(selection), [selection]);
  // Bring a newly selected point's row into view (a no-op when it is visible, e.g. a click on it).
  const selectedPoint = lastPoint(selection);
  const rowShown = selectedPoint !== null && !collapsed.has(selectedPoint.datasetId);
  useEffect(() => {
    if (!selectedPoint || !rowShown) return;
    const row = tables.current?.querySelector(`tr[data-point-id="${CSS.escape(selectedPoint.pointId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    // Only on a new selection (or its line expanding), not on every edit of the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPoint?.pointId, rowShown]);
  return (
    <section className="table-panel" aria-label="Data table">
      <div className="table-options">
        <label className="check">
          <input type="checkbox" checked={options.sortByX} onChange={(e) => onOptions({ sortByX: e.target.checked })} />
          Sort by X
        </label>
        <label className="check">
          <input type="checkbox" checked={options.showPixels} onChange={(e) => onOptions({ showPixels: e.target.checked })} />
          Pixel columns
        </label>
        <label className="inline">
          Sig. figs
          <input
            type="number"
            min={1}
            max={15}
            value={options.significantFigures}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 15) onOptions({ significantFigures: n });
            }}
            aria-label="Significant figures"
          />
        </label>
        {hasDate && (
          <label className="inline wide">
            Date format
            <input
              type="text"
              value={options.dateFormat}
              onChange={(e) => onOptions({ dateFormat: e.target.value })}
              aria-label="Date format"
              title="Tokens: YYYY MMM MM DD HH mm ss SSS; [text] is literal. Times are UTC."
            />
          </label>
        )}
        <span className="collapse-all">
          <button type="button" className="small" onClick={() => onCollapseAll(true)} disabled={nCollapsed === doc.datasets.length}>
            Collapse all
          </button>
          <button type="button" className="small" onClick={() => onCollapseAll(false)} disabled={nCollapsed === 0}>
            Expand all
          </button>
        </span>
      </div>

      <div className="tables" data-testid="data-tables" ref={tables}>
        {doc.datasets.map((d) => {
          const open = !collapsed.has(d.id);
          const bodyId = `${idPrefix}-rows-${d.id}`;
          const rows = open ? datasetRows(d, calibration, options.sortByX) : [];
          return (
            <div key={d.id} className="dataset-table">
              <h3 className="line-header">
                <button
                  type="button"
                  className="line-toggle"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => onToggle(d.id)}
                  title={open ? `Collapse ${d.name}'s points` : `Expand ${d.name}'s points`}
                >
                  <span className="swatch" style={{ background: d.color }} />
                  {d.name} <span className="muted">({d.points.length})</span>
                  <span className="chevron" aria-hidden="true">
                    ▾
                  </span>
                </button>
                <button
                  type="button"
                  className="small select-line"
                  onClick={() => onSelectLine(d.id)}
                  disabled={d.points.length === 0}
                  aria-label={`Select all points of ${d.name}`}
                  title={`Select all of ${d.name}'s points (then Delete, or arrows to nudge)`}
                >
                  Select all
                </button>
              </h3>
              <div id={bodyId} hidden={!open}>
                {!open ? null : rows.length === 0 ? (
                  <p className="muted small-text">No points yet.</p>
                ) : (
                  <table data-testid={`table-${d.name}`}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>X</th>
                        <th>Y</th>
                        {options.showPixels && (
                          <>
                            <th>px</th>
                            <th>py</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const isSelected = selectedKeys.has(`${d.id}/${r.pointId}`);
                        return (
                          <tr
                            key={r.pointId}
                            data-point-id={r.pointId}
                            className={isSelected ? 'selected' : undefined}
                            aria-selected={isSelected}
                            // Shift+click must not select the table's text.
                            onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                            onClick={(e) =>
                              onSelect(
                                [{ kind: 'point', datasetId: d.id, pointId: r.pointId }],
                                e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace',
                              )
                            }
                          >
                            <td>{r.index}</td>
                            <td className="num">{formatValue(r.x, doc.xScale, options) || '—'}</td>
                            <td className="num">{formatValue(r.y, doc.yScale, options) || '—'}</td>
                            {options.showPixels && (
                              <>
                                <td className="num">{formatPixel(r.px)}</td>
                                <td className="num">{formatPixel(r.py)}</td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="export-bar">
        <button type="button" className="small" onClick={onExportCsv} disabled={total === 0}>
          Download CSV
        </button>
        <button type="button" className="small" onClick={onCopyTsv} disabled={total === 0}>
          Copy as TSV
        </button>
        <button type="button" className="small" onClick={onExportJson}>
          Download JSON
        </button>
      </div>
    </section>
  );
});
