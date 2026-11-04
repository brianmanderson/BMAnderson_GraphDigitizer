import { describe, expect, it } from 'vitest';
import { formatDateTime, parseDateTime } from './dates.ts';

/** Parse and return the ISO string of the result, failing the test on a parse error. */
function iso(text: string): string {
  const r = parseDateTime(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.message}`);
  return new Date(r.ms).toISOString();
}

describe('parseDateTime', () => {
  it.each([
    ['2024-03-15', '2024-03-15T00:00:00.000Z'],
    ['2024-3-5', '2024-03-05T00:00:00.000Z'],
    ['2024/03/15', '2024-03-15T00:00:00.000Z'],
    ['2024.03.15', '2024-03-15T00:00:00.000Z'],
    ['2024-03', '2024-03-01T00:00:00.000Z'],
    ['2024', '2024-01-01T00:00:00.000Z'],
    ['2024-03-15 14:30', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15T14:30', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15T14:30:05', '2024-03-15T14:30:05.000Z'],
    ['2024-03-15 14:30:05.25', '2024-03-15T14:30:05.250Z'],
    ['  2024-03-15   14:30  ', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15 2:30 PM', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15 12:05 am', '2024-03-15T00:05:00.000Z'],
    ['2024-03-15 12:05 p.m.', '2024-03-15T12:05:00.000Z'],
    ['2024-03-15T14:30Z', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15 14:30 UTC', '2024-03-15T14:30:00.000Z'],
    ['2024-03-15T14:30+05:30', '2024-03-15T09:00:00.000Z'],
    ['2024-03-15T14:30-0400', '2024-03-15T18:30:00.000Z'],
    ['2024-03-15 14:30 +02', '2024-03-15T12:30:00.000Z'],
    ['15 Mar 2024', '2024-03-15T00:00:00.000Z'],
    ['15-Mar-2024', '2024-03-15T00:00:00.000Z'],
    ['15 March 2024 08:00', '2024-03-15T08:00:00.000Z'],
    ['Mar 15, 2024', '2024-03-15T00:00:00.000Z'],
    ['March 15th 2024', '2024-03-15T00:00:00.000Z'],
    ['Sept 1, 2024', '2024-09-01T00:00:00.000Z'],
    ['Mar 2024', '2024-03-01T00:00:00.000Z'],
    ['15/03/2024', '2024-03-15T00:00:00.000Z'],
    ['03/15/2024', '2024-03-15T00:00:00.000Z'],
    ['15.03.2024', '2024-03-15T00:00:00.000Z'],
    ['04/04/2024', '2024-04-04T00:00:00.000Z'],
    ['0050-06-01', '0050-06-01T00:00:00.000Z'],
  ])('parses %j', (text, expected) => {
    expect(iso(text)).toBe(expected);
  });

  it('reports whether a time and zone were given', () => {
    expect(parseDateTime('2024-03-15')).toMatchObject({ ok: true, hasTime: false, hasZone: false });
    expect(parseDateTime('2024-03-15 10:00')).toMatchObject({ ok: true, hasTime: true, hasZone: false });
    expect(parseDateTime('2024-03-15 10:00Z')).toMatchObject({ ok: true, hasTime: true, hasZone: true });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['hello', 'unrecognized'],
    ['2024.5', 'unrecognized'], // a decimal year, not May 2024
    ['2024-03 14:30', 'unrecognized'], // time needs a full date
    ['2024-03-15 25', 'unrecognized'],
    ['2024-03-15 14:30 EST', 'unrecognized'], // named zones other than UTC/GMT are ambiguous
    ['Foo 15, 2024', 'unrecognized'],
    ['03/04/2024', 'ambiguous'],
    ['2023-02-29', 'invalid'],
    ['1900-02-29', 'invalid'],
    ['2024-04-31', 'invalid'],
    ['2024-13-01', 'invalid'],
    ['2024-00-10', 'invalid'],
    ['2024-03-15 24:00', 'invalid'],
    ['2024-03-15 13:00 PM', 'invalid'],
    ['2024-03-15 10:60', 'invalid'],
    ['2024-03-15 10:00+19:00', 'invalid'],
    ['31/31/2024', 'invalid'],
  ])('rejects %j as %s', (text, reason) => {
    const r = parseDateTime(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('handles leap years', () => {
    expect(iso('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
    expect(iso('2000-02-29')).toBe('2000-02-29T00:00:00.000Z');
    expect(parseDateTime('2100-02-29').ok).toBe(false);
  });

  it('ignores the host time zone, including across a DST change', () => {
    // vite.config.ts runs tests in America/New_York so this exercises a DST-observing host.
    const jan = new Date(2024, 0, 15).getTimezoneOffset();
    const jul = new Date(2024, 6, 15).getTimezoneOffset();
    expect(jan).not.toBe(jul);

    const before = parseDateTime('2024-03-10 00:00');
    const after = parseDateTime('2024-03-11 00:00');
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.ms - before.ms).toBe(24 * 3600_000);
  });
});

describe('formatDateTime', () => {
  const ms = Date.UTC(2024, 1, 29, 7, 5, 9, 42);

  it('formats tokens in UTC', () => {
    expect(formatDateTime(ms)).toBe('2024-02-29 07:05');
    expect(formatDateTime(ms, 'YYYY-MM-DD')).toBe('2024-02-29');
    expect(formatDateTime(ms, 'DD MMM YYYY HH:mm:ss.SSS')).toBe('29 Feb 2024 07:05:09.042');
    expect(formatDateTime(ms, 'YYYY-MM-DD[T]HH:mm[Z]')).toBe('2024-02-29T07:05Z');
  });

  it('rounds to the nearest millisecond', () => {
    expect(formatDateTime(ms + 0.6, 'ss.SSS')).toBe('09.043');
    expect(formatDateTime(Date.UTC(2024, 11, 31, 23, 59, 59, 999) + 0.7, 'YYYY-MM-DD HH:mm:ss.SSS')).toBe(
      '2025-01-01 00:00:00.000',
    );
  });

  it('round-trips with parseDateTime', () => {
    for (const text of ['2024-02-29 07:05', '1999-12-31 23:59', '2024-03-10 02:30']) {
      const r = parseDateTime(text);
      expect(r.ok).toBe(true);
      if (r.ok) expect(formatDateTime(r.ms)).toBe(text);
    }
  });

  it('returns an empty string for unrepresentable values', () => {
    expect(formatDateTime(NaN)).toBe('');
    expect(formatDateTime(Infinity)).toBe('');
    expect(formatDateTime(9e15)).toBe('');
  });
});
