/**
 * Table rows and text exports (CSV, TSV) derived from the document and its calibration.
 * Pure: values come from Calibration.pixelToValue every time; nothing here does axis math.
 */

import { formatDateTime, type Calibration, type Dataset, type ScaleType } from '../core/index.ts';

export interface TableOptions {
  significantFigures: number;
  dateFormat: string;
  showPixels: boolean;
  sortByX: boolean;
}

export interface TableRow {
  pointId: string;
  /** 1-based position in placement order; kept when sorting so a row can be found again. */
  index: number;
  px: number;
  py: number;
  x: number | null;
  y: number | null;
}

/** Shortest text for `v` rounded to `sf` significant figures (no trailing zeros). */
export function formatNumber(v: number, sf: number): string {
  const digits = Math.min(Math.max(Math.round(sf), 1), 17);
  const rounded = Number(v.toPrecision(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A data value as shown in the table and exports. null (unrepresentable) is ''. */
export function formatValue(v: number | null, scale: ScaleType, options: Pick<TableOptions, 'significantFigures' | 'dateFormat'>): string {
  if (v === null) return '';
  return scale === 'date' ? formatDateTime(v, options.dateFormat) : formatNumber(v, options.significantFigures);
}

/** Pixel coordinates are shown to 0.1 px. */
export function formatPixel(v: number): string {
  return v.toFixed(1);
}

export function datasetRows(dataset: Dataset, calibration: Calibration | null, sortByX: boolean): TableRow[] {
  const rows = dataset.points.map((p, i): TableRow => {
    const value = calibration ? calibration.pixelToValue(p.px, p.py) : { x: null, y: null };
    return { pointId: p.id, index: i + 1, px: p.px, py: p.py, x: value.x, y: value.y };
  });
  if (sortByX && calibration) {
    // Stable sort; rows without an x value go last.
    rows.sort((a, b) => {
      if (a.x === null || b.x === null) return a.x === null ? (b.x === null ? 0 : 1) : -1;
      return a.x - b.x;
    });
  }
  return rows;
}

/** Header + one row per point across all datasets, as text cells. */
export function exportCells(
  datasets: readonly Dataset[],
  calibration: Calibration | null,
  scales: { xScale: ScaleType; yScale: ScaleType },
  options: TableOptions,
): string[][] {
  const header = ['dataset', '#', 'x', 'y'];
  if (options.showPixels) header.push('px', 'py');
  const out = [header];
  for (const d of datasets) {
    for (const r of datasetRows(d, calibration, options.sortByX)) {
      const row = [
        d.name,
        String(r.index),
        formatValue(r.x, scales.xScale, options),
        formatValue(r.y, scales.yScale, options),
      ];
      if (options.showPixels) row.push(formatPixel(r.px), formatPixel(r.py));
      out.push(row);
    }
  }
  return out;
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with CRLF line endings. */
export function toCsv(cells: readonly (readonly string[])[]): string {
  return cells.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Tab-separated text for pasting into a spreadsheet. Tabs/newlines inside cells become spaces. */
export function toTsv(cells: readonly (readonly string[])[]): string {
  return cells.map((row) => row.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n') + '\n';
}
