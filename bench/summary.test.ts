/** The benchmark summary writer (bench/summary.ts): paths, CSV layout, JSON rounding. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asPercent, columnHeading, roundTo, summaryPaths, tableFrom, toCsv, writeSummary, type Summary } from './summary.ts';

const summary: Summary = {
  benchmark: 'bench:test',
  generated: '2026-01-01T00:00:00.000Z',
  tables: [
    {
      name: 'first',
      columns: [
        { key: 'n', label: 'n', unit: 'count' },
        { key: 'recall', label: 'tick recall', unit: '%' },
        { key: 'err', label: 'error median', unit: 'px' },
      ],
      rows: [
        { category: 'OVERALL', values: { n: 62, recall: 65.32258064516128, err: 0.1 + 0.2 } },
        { category: 'x:log10', values: { n: 14, recall: null, err: 0.5 } },
      ],
    },
    {
      name: 'second',
      columns: [
        { key: 'what', label: 'what', unit: '' },
        { key: 'n', label: 'n', unit: 'count' },
        { key: 'err', label: 'y error median', unit: 'data units' },
      ],
      rows: [{ category: 'figure:km, "a"', values: { what: 'points', n: 3, err: 0.00213 } }],
    },
  ],
};

describe('summaryPaths', () => {
  it('drops a .csv/.json extension and writes both beside each other', () => {
    expect(summaryPaths('out/axes.csv')).toEqual({ csv: 'out/axes.csv', json: 'out/axes.json' });
    expect(summaryPaths('out/axes.JSON')).toEqual({ csv: 'out/axes.csv', json: 'out/axes.json' });
    expect(summaryPaths('out/axes')).toEqual({ csv: 'out/axes.csv', json: 'out/axes.json' });
  });
});

describe('toCsv', () => {
  const lines = toCsv(summary).trimEnd().split('\n');

  it('has one header over the union of columns, naming each metric and its unit', () => {
    expect(lines[0]).toBe('table,category,n [count],tick recall [%],error median [px],what,y error median [data units]');
    expect(columnHeading({ key: 'k', label: 'kind', unit: '' })).toBe('kind');
  });

  it('writes one row per table row, blanks for null and for columns a table lacks, quoting as needed', () => {
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('first,OVERALL,62,65.322581,0.3,,');
    expect(lines[2]).toBe('first,x:log10,14,,0.5,,');
    expect(lines[3]).toBe('second,"figure:km, ""a""",3,,,points,0.00213');
  });

  it('keeps two columns apart when the same key has different headings', () => {
    const s: Summary = {
      ...summary,
      tables: [
        { name: 'a', columns: [{ key: 'err', label: 'error', unit: 'px' }], rows: [{ category: 'A', values: { err: 1 } }] },
        { name: 'b', columns: [{ key: 'err', label: 'error', unit: '%' }], rows: [{ category: 'B', values: { err: 2 } }] },
      ],
    };
    const out = toCsv(s).trimEnd().split('\n');
    expect(out[0]).toBe('table,category,error [px],error [%]');
    expect(out[1]).toBe('a,A,1,');
    expect(out[2]).toBe('b,B,,2');
  });
});

describe('writeSummary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes the CSV and a JSON with the same rows, numbers rounded to 6 decimals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-summary-'));
    dirs.push(dir);
    const out = writeSummary(join(dir, 'nested', 'run.csv'), summary);
    expect(out).toEqual({ csv: join(dir, 'nested', 'run.csv'), json: join(dir, 'nested', 'run.json') });
    expect(readFileSync(out.csv, 'utf8')).toBe(toCsv(summary));
    const json = JSON.parse(readFileSync(out.json, 'utf8')) as Summary;
    expect(json.benchmark).toBe('bench:test');
    expect(json.tables.map((t) => t.name)).toEqual(['first', 'second']);
    expect(json.tables[0]!.columns).toEqual(summary.tables[0]!.columns);
    expect(json.tables[0]!.rows[0]).toEqual({ category: 'OVERALL', values: { n: 62, recall: 65.322581, err: 0.3 } });
    expect(json.tables[0]!.rows[1]!.values.recall).toBeNull();
    expect(json.tables[1]!.rows[0]!.values).toEqual({ what: 'points', n: 3, err: 0.00213 });
  });
});

describe('helpers', () => {
  it('turns ratios into percent and rounds', () => {
    expect(asPercent(0.653)).toBeCloseTo(65.3, 9);
    expect(asPercent(null)).toBeNull();
    expect(roundTo(0.1 + 0.2, 6)).toBe(0.3);
  });

  it('builds a table from metric objects through a picker', () => {
    const t = tableFrom(
      'm',
      [
        { key: 'a', label: 'a', unit: '%' },
        { key: 'b', label: 'b', unit: 'count' },
      ],
      [
        ['OVERALL', { a: 0.5, b: 3, c: 9 }],
        ['tag', { a: null, b: 0, c: 1 }],
      ],
      (m, key) => (key === 'a' ? asPercent(m.a) : m[key as 'b']),
    );
    expect(t.rows).toEqual([
      { category: 'OVERALL', values: { a: 50, b: 3 } },
      { category: 'tag', values: { a: null, b: 0 } },
    ]);
  });
});
