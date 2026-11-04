/**
 * Date/time parsing and formatting for date axes. Values are epoch milliseconds (UTC).
 *
 * Text is interpreted as UTC unless it carries an explicit zone (Z, UTC, GMT, ±HH, ±HHmm,
 * ±HH:mm). The host's local time zone is never consulted, so results do not depend on where
 * the app runs and are unaffected by daylight-saving transitions.
 */

import { MAX_EPOCH_MS } from './scales.ts';

export type DateParseFailure = 'empty' | 'unrecognized' | 'ambiguous' | 'invalid';

export type DateParseResult =
  | { ok: true; ms: number; hasTime: boolean; hasZone: boolean }
  | { ok: false; reason: DateParseFailure; message: string };

export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm';

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1-based month number from a name or abbreviation ("Mar", "march", "Sept"); else null. */
function monthFromName(name: string): number | null {
  const n = name.toLowerCase();
  if (n.length < 3) return null;
  if (n === 'sept') return 9;
  const i = MONTH_NAMES.findIndex((full) => full.startsWith(n));
  return i < 0 ? null : i + 1;
}

interface DateFields {
  year: number;
  month: number;
  day: number;
  /** Year-only and year-month forms cannot take a time of day. */
  allowsTime: boolean;
}

type DateMatch = { fields: DateFields; rest: string } | 'ambiguous' | null;

// Each pattern matches the date part at the start of the string; group "rest" is the remainder.
const ISO_DATE = /^(?<y>\d{4})(?<sep>[-/.])(?<m>\d{1,2})(?:\k<sep>(?<d>\d{1,2}))?(?<rest>.*)$/;
const YEAR_ONLY = /^(?<y>\d{4})$/;
const DAY_MONTH_NAME =
  /^(?<d>\d{1,2})(?:st|nd|rd|th)?[\s-]+(?<mon>[a-z]+)\.?[\s,-]+(?<y>\d{4})(?<rest>.*)$/i;
const MONTH_NAME_DAY = /^(?<mon>[a-z]+)\.?\s+(?<d>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<y>\d{4})(?<rest>.*)$/i;
const MONTH_NAME_YEAR = /^(?<mon>[a-z]+)\.?,?\s+(?<y>\d{4})(?<rest>)$/i;
const NUMERIC_DMY = /^(?<a>\d{1,2})(?<sep>[/.-])(?<b>\d{1,2})\k<sep>(?<y>\d{4})(?<rest>.*)$/;

const TIME_AND_ZONE =
  /^(?:T|\s+)(?<h>\d{1,2}):(?<mi>\d{2})(?::(?<s>\d{2})(?:[.,](?<frac>\d{1,9}))?)?\s*(?<ampm>[ap]\.?m\.?)?(?:\s*(?<zone>Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?))?$/i;

function matchDate(text: string): DateMatch {
  let g = ISO_DATE.exec(text)?.groups;
  // "2024.5" reads as a decimal year, not May 2024: year-month needs "-" or "/".
  if (g && !(g.d === undefined && g.sep === '.')) {
    return {
      fields: { year: +g.y!, month: +g.m!, day: g.d ? +g.d : 1, allowsTime: g.d !== undefined },
      rest: g.rest!,
    };
  }
  if (YEAR_ONLY.test(text)) {
    return { fields: { year: +text, month: 1, day: 1, allowsTime: false }, rest: '' };
  }

  for (const re of [DAY_MONTH_NAME, MONTH_NAME_DAY, MONTH_NAME_YEAR]) {
    g = re.exec(text)?.groups;
    if (!g) continue;
    const month = monthFromName(g.mon!);
    if (month === null) continue;
    return {
      fields: { year: +g.y!, month, day: g.d ? +g.d : 1, allowsTime: g.d !== undefined },
      rest: g.rest!,
    };
  }

  g = NUMERIC_DMY.exec(text)?.groups;
  if (g) {
    const a = +g.a!;
    const b = +g.b!;
    let day = a;
    let month = b;
    if (b > 12 && a <= 12) [month, day] = [a, b];
    else if (a <= 12 && b <= 12 && a !== b) return 'ambiguous';
    // Otherwise day/month: a > 12 fixes it; a === b is the same either way; both > 12 fails
    // range validation in the caller.
    return { fields: { year: +g.y!, month, day, allowsTime: true }, rest: g.rest! };
  }
  return null;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Epoch ms of midnight UTC on the given calendar date (years 0–99 are not shifted to 19xx). */
function utcMidnight(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getTime();
}

/** Zone offset in minutes east of UTC, from "Z", "UTC", "+05", "-0430", "+05:30". */
function zoneOffsetMinutes(zone: string): number | null {
  if (/^(z|utc|gmt)$/i.test(zone)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!m) return null;
  const hours = +m[2]!;
  const minutes = m[3] ? +m[3] : 0;
  if (hours > 18 || minutes > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

const fail = (reason: DateParseFailure, message: string): DateParseResult => ({
  ok: false,
  reason,
  message,
});

/**
 * Parse a date or date-time string to epoch milliseconds.
 *
 * Accepted forms (case-insensitive):
 * - ISO-like: `2024-03-15`, `2024-03`, `2024`, `2024/03/15`, `2024.03.15`
 * - With time: `2024-03-15T14:30`, `2024-03-15 14:30:05.250`, `2024-03-15 2:30 PM`
 * - With zone (after a time): `…Z`, `… UTC`, `…+05:30`, `…-0400`, `…+02`
 * - Month names: `15 Mar 2024`, `15-Mar-2024`, `Mar 15, 2024`, `March 15th 2024`, `Mar 2024`
 * - Numeric day/month: `15/03/2024`, `03/15/2024` — only when unambiguous (one part > 12,
 *   or both equal); `03/04/2024` is rejected as ambiguous.
 */
export function parseDateTime(input: string): DateParseResult {
  const text = input.trim().replace(/\s+/g, ' ');
  if (text === '') return fail('empty', 'Enter a date, e.g. 2024-03-15 or 2024-03-15 14:30.');

  const date = matchDate(text);
  if (date === null) return fail('unrecognized', `"${input}" is not a recognised date/time.`);
  if (date === 'ambiguous') {
    return fail(
      'ambiguous',
      `"${input}" is ambiguous (day/month order unknown). Use YYYY-MM-DD, e.g. 2024-03-15.`,
    );
  }

  const { year, month, day, allowsTime } = date.fields;
  if (month < 1 || month > 12) return fail('invalid', `Month ${month} is out of range in "${input}".`);
  if (day < 1 || day > daysInMonth(year, month)) {
    return fail('invalid', `Day ${day} does not exist in ${MONTH_ABBR[month - 1]} ${year}.`);
  }

  let timeMs = 0;
  let offsetMinutes = 0;
  let hasTime = false;
  let hasZone = false;
  if (date.rest !== '') {
    const t = allowsTime ? TIME_AND_ZONE.exec(date.rest)?.groups : undefined;
    if (!t) return fail('unrecognized', `"${input}" is not a recognised date/time.`);
    let hour = +t.h!;
    const minute = +t.mi!;
    const second = t.s ? +t.s : 0;
    if (t.ampm) {
      if (hour < 1 || hour > 12) return fail('invalid', `Hour ${hour} is out of range for AM/PM.`);
      const pm = t.ampm.toLowerCase().startsWith('p');
      hour = (hour % 12) + (pm ? 12 : 0);
    }
    if (hour > 23 || minute > 59 || second > 59) {
      return fail('invalid', `Time in "${input}" is out of range.`);
    }
    const fracMs = t.frac ? Number(`0.${t.frac}`) * 1000 : 0;
    timeMs = ((hour * 60 + minute) * 60 + second) * 1000 + fracMs;
    hasTime = true;
    if (t.zone) {
      const off = zoneOffsetMinutes(t.zone);
      if (off === null) return fail('invalid', `Time zone "${t.zone}" is out of range.`);
      offsetMinutes = off;
      hasZone = true;
    }
  }

  const ms = utcMidnight(year, month, day) + timeMs - offsetMinutes * 60_000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
    return fail('invalid', `"${input}" is outside the supported date range.`);
  }
  return { ok: true, ms, hasTime, hasZone };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Format epoch milliseconds as UTC using tokens: YYYY, MMM (Jan), MM, DD, HH, mm, ss, SSS.
 * Text inside [brackets] is literal. Values are rounded to the nearest millisecond.
 * Returns '' for values outside the representable date range.
 */
export function formatDateTime(ms: number, format: string = DEFAULT_DATE_FORMAT): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) return '';
  const d = new Date(Math.round(ms));
  const year = d.getUTCFullYear();
  const tokens: Record<string, string> = {
    YYYY: year < 0 ? `-${pad(-year, 4)}` : pad(year, 4),
    MMM: MONTH_ABBR[d.getUTCMonth()]!,
    MM: pad(d.getUTCMonth() + 1, 2),
    DD: pad(d.getUTCDate(), 2),
    HH: pad(d.getUTCHours(), 2),
    mm: pad(d.getUTCMinutes(), 2),
    ss: pad(d.getUTCSeconds(), 2),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return format.replace(
    /\[([^\]]*)\]|YYYY|MMM|MM|DD|HH|mm|ss|SSS/g,
    (tok: string, literal: string | undefined) => literal ?? tokens[tok]!,
  );
}
