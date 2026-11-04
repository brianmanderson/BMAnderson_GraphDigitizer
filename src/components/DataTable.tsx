import { memo } from 'react';
import type { Calibration } from '../core/index.ts';
import type { DocState } from '../state/doc.ts';
import type { Target } from '../ui/draw.ts';
import { datasetRows, formatPixel, formatValue, type TableOptions } from '../ui/table.ts';

interface Props {
  doc: DocState;
  calibration: Calibration | null;
  options: TableOptions;
  selected: Target | null;
  onSelect: (target: Target) => void;
  onOptions: (patch: Partial<TableOptions>) => void;
  onExportCsv: () => void;
  onCopyTsv: () => void;
  onExportJson: () => void;
}

/** Live table of every dataset's points, with display options and the export buttons. */
export const DataTable = memo(function DataTable({ doc, calibration, options, selected, onSelect, onOptions, onExportCsv, onCopyTsv, onExportJson }: Props) {
  const hasDate = doc.xScale === 'date' || doc.yScale === 'date';
  const total = doc.datasets.reduce((n, d) => n + d.points.length, 0);
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
      </div>

      <div className="tables" data-testid="data-tables">
        {doc.datasets.map((d) => {
          const rows = datasetRows(d, calibration, options.sortByX);
          return (
            <div key={d.id} className="dataset-table">
              <h3>
                <span className="swatch" style={{ background: d.color }} />
                {d.name} <span className="muted">({rows.length})</span>
              </h3>
              {rows.length === 0 ? (
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
                      const isSelected = selected?.kind === 'point' && selected.pointId === r.pointId;
                      return (
                        <tr
                          key={r.pointId}
                          className={isSelected ? 'selected' : undefined}
                          aria-selected={isSelected}
                          onClick={() => onSelect({ kind: 'point', datasetId: d.id, pointId: r.pointId })}
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
