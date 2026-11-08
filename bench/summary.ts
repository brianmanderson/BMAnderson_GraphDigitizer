/**
 * Machine-readable benchmark summaries, shared by bench/axes and bench/lines:
 *
 *   npm run bench:axes  -- --summary <path>
 *   npm run bench:lines -- --summary <path>
 *
 * writes every category row of every table the runner prints — the same numbers as the console,
 * unrounded — as `<path>.csv` and `<path>.json` (a `.csv`/`.json` extension on <path> is dropped
 * first). Ratios the console shows as percentages are stored in percent, so the `unit` of each
 * column says what the number is.
 *
 * JSON: { benchmark, generated, tables: [{ name, columns: [{ key, label, unit }], rows: [{ category,
 * values: { <key>: number | string | null } }] }] }. CSV: one header, one row per (table, category):
 * `table,category,<label [unit]>…` over the union of all tables' columns, a cell left empty where
 * a table has no such column or the value is null (printed as `–` on the console).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SummaryValue = number | string | null;

export interface SummaryColumn {
  /** Property name in the JSON rows and the metrics object. */
  key: string;
  /** Console column heading or a longer name. */
  label: string;
  /** '%', 'px', 'count', 'ms', 'data units', '' for text. */
  unit: string;
}

export interface SummaryRow {
  /** 'OVERALL', a category tag, or `figure:<id>` for a per-figure row. */
  category: string;
  values: Record<string, SummaryValue>;
}

export interface SummaryTable {
  name: string;
  columns: SummaryColumn[];
  rows: SummaryRow[];
}

export interface Summary {
  benchmark: string;
  /** ISO timestamp of the run. */
  generated: string;
  tables: SummaryTable[];
}

/** `--summary out/axes.csv` and `--summary out/axes` both mean out/axes.csv + out/axes.json. */
export function summaryPaths(path: string): { csv: string; json: string } {
  const base = path.replace(/\.(csv|json)$/i, '');
  return { csv: `${base}.csv`, json: `${base}.json` };
}

/** A ratio in 0–1 as a percentage; null stays null. */
export const asPercent = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : 100 * v);

/** One column heading: "tick recall [%]", "wrong [count]", "kind" (no unit). */
export const columnHeading = (c: SummaryColumn): string => (c.unit ? `${c.label} [${c.unit}]` : c.label);

function csvCell(v: SummaryValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(roundTo(v, 6)) : '';
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Rounded to `digits` decimals, so 65.32258064516128 is written as 65.322581 and 0.1 + 0.2 as 0.3. */
export function roundTo(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function toCsv(summary: Summary): string {
  // The union of columns, in first-seen order; the same key with the same heading is one column.
  const columns: SummaryColumn[] = [];
  const seen = new Set<string>();
  for (const t of summary.tables) {
    for (const c of t.columns) {
      const id = `${c.key}\u0000${columnHeading(c)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      columns.push(c);
    }
  }
  const lines = [['table', 'category', ...columns.map(columnHeading)].map(csvCell).join(',')];
  for (const t of summary.tables) {
    const has = new Map(t.columns.map((c) => [`${c.key}\u0000${columnHeading(c)}`, c.key]));
    for (const r of t.rows) {
      const cells = columns.map((c) => {
        const key = has.get(`${c.key}\u0000${columnHeading(c)}`);
        return key === undefined ? null : (r.values[key] ?? null);
      });
      lines.push([t.name, r.category, ...cells].map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

export function toJson(summary: Summary): string {
  const rounded: Summary = {
    ...summary,
    tables: summary.tables.map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({
        category: r.category,
        values: Object.fromEntries(
          Object.entries(r.values).map(([k, v]) => [k, typeof v === 'number' ? (Number.isFinite(v) ? roundTo(v, 6) : null) : v]),
        ),
      })),
    })),
  };
  return JSON.stringify(rounded, null, 1) + '\n';
}

/** Writes `<path>.csv` and `<path>.json` (creating the directory) and returns their paths. */
export function writeSummary(path: string, summary: Summary): { csv: string; json: string } {
  const out = summaryPaths(path);
  mkdirSync(dirname(out.csv), { recursive: true });
  writeFileSync(out.csv, toCsv(summary));
  writeFileSync(out.json, toJson(summary));
  return out;
}

/** Builds the rows of one table from named metric objects, keeping only the listed columns. */
export function tableFrom<M extends object>(
  name: string,
  columns: SummaryColumn[],
  rows: [category: string, metrics: M][],
  pick: (m: M, key: string) => SummaryValue,
): SummaryTable {
  return {
    name,
    columns,
    rows: rows.map(([category, m]) => ({ category, values: Object.fromEntries(columns.map((c) => [c.key, pick(m, c.key)])) })),
  };
}
