/** Tick-label text → values: numbers in every accepted notation, axis notes, dates, points. */

import { describe, expect, it } from 'vitest';
import { monthOf, parseAxisNote, parseDateToken, parseNumberLabel, resolveDateLabels, restorePoints } from './parseLabel.ts';

describe('parseNumberLabel', () => {
  it.each([
    ['0', 0],
    ['20', 20],
    ['-40', -40],
    ['−40', -40],
    ['–5.5', -5.5],
    ['+3', 3],
    ['0.25', 0.25],
    ['.5', 0.5],
    ['10,000', 10000],
    ['1 000 000', 1000000],
    ['-1,234.5', -1234.5],
    ['0,5', 0.5],
    ['0,001', 0.001],
    ['0,01', 0.01],
    ['-0,250', -0.25],
    ['1e-3', 0.001],
    ['1.5E+04', 15000],
    ['10^3', 1000],
    ['10^-2', 0.01],
    ['10^(-2)', 0.01],
    ['10³', 1000],
    ['10⁻³', 0.001],
    ['1×10^-3', 0.001],
    ['2x10^3', 2000],
    ['-10^2', -100],
    ['20%', 20],
  ])('%s → %d', (text, value) => {
    expect(parseNumberLabel(text)?.value).toBe(value);
  });

  it('flags power-of-ten notation', () => {
    expect(parseNumberLabel('10^2')?.power).toBe(true);
    expect(parseNumberLabel('1e3')?.power).toBe(true);
    expect(parseNumberLabel('100')?.power).toBe(false);
  });

  it.each(['', '-', 'abc', '1.2.3', '10^', '^2', 'e5', '08', '000', '0020', '-04', '1,2,3'])('rejects %j', (text) => {
    expect(parseNumberLabel(text)).toBeNull();
  });

  it('never returns a non-finite value', () => {
    expect(parseNumberLabel('1e999')).toBeNull();
    expect(parseNumberLabel('10^999')).toBeNull();
  });
});

describe('parseAxisNote', () => {
  it.each([
    ['+1e4', { multiplier: 1, offset: 10000 }],
    ['−1e4', { multiplier: 1, offset: -10000 }],
    ['+5', { multiplier: 1, offset: 5 }],
    ['1e-3', { multiplier: 0.001, offset: 0 }],
    ['×10^3', { multiplier: 1000, offset: 0 }],
    ['1e-3+1e4', { multiplier: 0.001, offset: 10000 }],
    ['+lel', { multiplier: 1, offset: 10 }],
  ])('%s', (text, note) => {
    expect(parseAxisNote(text)).toEqual(note);
  });

  it.each(['', '4', 'mg/L', '+', '0e4'])('rejects %j', (text) => {
    expect(parseAxisNote(text)).toBeNull();
  });
});

describe('dates', () => {
  it('recognises month names and abbreviations', () => {
    expect(monthOf('Oct')).toBe(10);
    expect(monthOf('sept')).toBe(9);
    expect(monthOf('March')).toBe(3);
    expect(monthOf('0ct')).toBe(10);
    expect(monthOf('Ma')).toBeNull();
    expect(monthOf('Marx')).toBeNull();
  });

  it('classifies tokens', () => {
    expect(parseDateToken('2023')).toEqual({ kind: 'year', year: 2023 });
    expect(parseDateToken('Feb')).toEqual({ kind: 'month', month: 2 });
    expect(parseDateToken('15')).toEqual({ kind: 'day', day: 15 });
    expect(parseDateToken('2024-03-15')).toEqual({ kind: 'date', ms: Date.UTC(2024, 2, 15) });
    expect(parseDateToken('Mar 2024')).toEqual({ kind: 'date', ms: Date.UTC(2024, 2, 1) });
    expect(parseDateToken('99')).toBeNull();
  });

  const tok = (s: string) => parseDateToken(s);
  it('dates months from a year label after them and before them', () => {
    // matplotlib's concise formatter: Oct Nov Dec 2023 Feb.
    expect(resolveDateLabels(['Oct', 'Nov', 'Dec', '2023', 'Feb'].map(tok))).toEqual([
      Date.UTC(2022, 9, 1),
      Date.UTC(2022, 10, 1),
      Date.UTC(2022, 11, 1),
      Date.UTC(2023, 0, 1),
      Date.UTC(2023, 1, 1),
    ]);
    expect(resolveDateLabels(['Jul', 'Oct', '1998', 'Apr', 'Jul', 'Oct', '1999'].map(tok))).toEqual([
      Date.UTC(1997, 6, 1),
      Date.UTC(1997, 9, 1),
      Date.UTC(1998, 0, 1),
      Date.UTC(1998, 3, 1),
      Date.UTC(1998, 6, 1),
      Date.UTC(1998, 9, 1),
      Date.UTC(1999, 0, 1),
    ]);
  });

  it('starts a new year when months wrap without a year label', () => {
    expect(resolveDateLabels(['2020', 'Jun', 'Dec', 'Jun'].map(tok))).toEqual([
      Date.UTC(2020, 0, 1),
      Date.UTC(2020, 5, 1),
      Date.UTC(2020, 11, 1),
      Date.UTC(2021, 5, 1),
    ]);
  });

  it('dates nothing without a year, and never dates bare day numbers', () => {
    expect(resolveDateLabels(['Sep', '03', '05'].map(tok))).toEqual([null, null, null]);
    expect(resolveDateLabels(['2003', '03', '05'].map(tok))).toEqual([Date.UTC(2003, 0, 1), null, null]);
  });
});

describe('restorePoints', () => {
  const marks = (start: number, end: number, ...pts: [number, number, ('.' | ',')?][]) => ({
    start,
    end,
    points: pts.map(([x0, x1, char]) => ({ x0, x1, char: char ?? ('.' as const) })),
  });

  it('puts a dropped decimal point back where the layout shows it', () => {
    // "1.0": digit, point, digit of equal width.
    expect(restorePoints('10', marks(0, 12, [5, 6]))).toBe('1.0');
    // "0.00"
    expect(restorePoints('000', marks(0, 17, [5, 6]))).toBe('0.00');
    // "100.00"
    expect(restorePoints('10000', marks(0, 29, [17, 18]))).toBe('100.00');
    // A minus sign is kept in front.
    expect(restorePoints('-05', marks(0, 12, [5, 6]))).toBe('-0.5');
  });

  it('restores thousands commas too', () => {
    expect(restorePoints('10000', marks(0, 29, [11, 12, ',']))).toBe('10,000');
  });

  it('leaves text alone when OCR kept the marks, saw none, or read something else', () => {
    expect(restorePoints('1.0', marks(0, 12, [5, 6]))).toBe('1.0');
    expect(restorePoints('10', marks(0, 12))).toBe('10');
    expect(restorePoints('10^2', marks(0, 12, [5, 6]))).toBe('10^2');
    expect(restorePoints('Oct', marks(0, 12, [5, 6]))).toBe('Oct');
  });
});
