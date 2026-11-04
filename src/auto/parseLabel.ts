/**
 * Parsing OCR'd tick-label text into values (Phase 5). Pure, no DOM.
 *
 * Numbers: optional sign (ASCII '-', Unicode minus '−', en dash '–', '+'), digits with an optional
 * decimal point, thousands separators (`10,000`, `1 000`; a single comma not followed by exactly
 * three digits is a decimal comma: `0,5`), scientific notation (`1e-3`, `1.5E+04`), powers
 * (`1×10^-3`, `1x10^3`, `10^3`, and Unicode superscripts `10³`, `10⁻³`) and a trailing `%`
 * (the number as printed: `20%` → 20). The OCR stage writes a raised exponent it read separately
 * as `base^exp`.
 *
 * Dates: a label may be a full date (anything `parseDateTime` accepts, e.g. `2024-03-15`,
 * `Mar 2024`), a year (`2023`), a month name (`Oct`) or a bare day number. Month names need a year
 * on the same axis to become dates — `resolveDateLabels` reconstructs them the way date axes are
 * usually written (matplotlib, Excel): months increase along the axis and a year label marks
 * January of that year.
 */

import { parseDateTime } from '../core/index.ts';
import type { PointMarks } from './labels.ts';

export type LabelToken =
  | { kind: 'number'; value: number; /** written as a power of ten (10^k, 1e3, 1×10³) */ power: boolean }
  | { kind: 'date'; ms: number }
  | { kind: 'year'; year: number }
  | { kind: 'month'; month: number }
  | { kind: 'day'; day: number };

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
  '⁺': '+',
};

/** Signs and lookalikes normalised; superscript runs become `^exp`; spaces dropped. */
function normalise(text: string): string {
  let s = text.trim().replace(/[−–—‒]/g, '-');
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (run) => '^' + [...run].map((c) => SUPERSCRIPTS[c] ?? '').join(''));
  return s.replace(/\s+/g, '');
}

const DECIMAL = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const PLAIN = new RegExp(`^${DECIMAL}$`);
const SCI = new RegExp(`^(${DECIMAL})[eE]([+-]?\\d+)$`);
const POW = new RegExp(`^(?:(${DECIMAL})[x×*·])?([+-]?)10\\^?\\(?([+-]?\\d+)\\)?$`);
const THOUSANDS = /^([+-]?)(\d{1,3}(?:([, ])\d{3})+)(\.\d+)?$/;

/** A number written in any of the accepted forms, or null. Never NaN/Infinity. */
export function parseNumberLabel(text: string): { value: number; power: boolean } | null {
  let s = normalise(text);
  if (s.endsWith('%')) s = s.slice(0, -1);
  if (s === '') return null;
  const finite = (v: number, power: boolean) => (Number.isFinite(v) ? { value: v, power } : null);
  // A leading zero followed by more digits ("08", "000", "0020") is a number whose decimal point
  // was lost: never a value.
  if (/^[+-]?0\d/.test(s)) return null;
  if (PLAIN.test(s)) return finite(Number(s), false);
  const t = THOUSANDS.exec(text.trim().replace(/[−–]/g, '-'));
  if (t) return finite(Number(`${t[1]}${(t[2] ?? '').replace(/[, ]/g, '')}${t[4] ?? ''}`), false);
  const sci = SCI.exec(s);
  if (sci) return finite(Number(`${sci[1]}e${sci[2]}`), true);
  // `10^3` needs the caret (or a superscript): "103" is the number 103.
  const pow = POW.exec(s);
  if (pow && (s.includes('^') || pow[1] !== undefined)) {
    const mantissa = pow[1] === undefined ? 1 : Number(pow[1]);
    const sign = pow[2] === '-' ? -1 : 1;
    return finite(sign * Number(`${mantissa}e${pow[3]}`), true);
  }
  const comma = /^([+-]?\d+),(\d+)$/.exec(s);
  if (comma && (comma[2] ?? '').length !== 3) return finite(Number(`${comma[1]}.${comma[2]}`), false);
  return null;
}

/**
 * An axis offset/multiplier note as matplotlib prints it: a signed term is added (`+1e4`,
 * `−5`), an unsigned one multiplies (`1e−3`, `×10³`), and `1e−3+1e4` does both. Null when the text
 * is not such a note.
 */
export function parseAxisNote(text: string): { multiplier: number; offset: number } | null {
  // Read as free text, a note's 1s and 0s may come back as letters (`+lel` for `+1e1`).
  const s = normalise(text)
    .replace(/^[x×]/, '')
    .replace(/[lI|]/g, '1')
    .replace(/[oO]/g, '0');
  if (s === '') return null;
  // Split at the first sign that starts a term (not one inside an exponent: `1e-3`, `10^-3`).
  let cut = -1;
  for (let i = 0; i < s.length; i++) {
    if ((s[i] === '+' || s[i] === '-') && (i === 0 || !/[eE^]/.test(s[i - 1] as string))) {
      cut = i;
      break;
    }
  }
  const m1 = cut < 0 ? s : s.slice(0, cut);
  const m2 = cut < 0 ? '' : s.slice(cut);
  if (m2 !== '' && /[+-]/.test(m2.slice(1).replace(/[eE^][+-]/g, ''))) return null;
  const mult = m1 ? parseNumberLabel(m1) : { value: 1 };
  const off = m2 ? parseNumberLabel(m2) : { value: 0 };
  if (!mult || !off || mult.value === 0) return null;
  // A multiplier is a power of ten (`1e-3`, `10^3`); a plain number alone is not a note.
  if (m1 && !/e|\^/i.test(m1)) return null;
  return { multiplier: mult.value, offset: off.value };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 1–12 for a month name or its abbreviation (`Sept`, `oct.`), else null. */
export function monthOf(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\.$/, '').replace(/^0(?=[a-z])/, 'o');
  if (s.length < 3) return null;
  const i = MONTHS.indexOf(s.slice(0, 3));
  if (i < 0) return null;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][i] as string;
  return full.startsWith(s) || s === 'sept' ? i + 1 : null;
}

/** Classify one label read in "text" mode (dates allowed). */
export function parseDateToken(text: string): LabelToken | null {
  const s = text.trim();
  if (s === '') return null;
  const month = monthOf(s);
  if (month !== null) return { kind: 'month', month };
  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return year >= 1000 && year <= 2999 ? { kind: 'year', year } : null;
  }
  if (/^\d{1,2}$/.test(s)) {
    const day = Number(s);
    return day >= 1 && day <= 31 ? { kind: 'day', day } : null;
  }
  const d = parseDateTime(s);
  return d.ok ? { kind: 'date', ms: d.ms } : null;
}

/**
 * Epoch ms for each label of a date axis, in axis order (increasing time), or null where a label
 * cannot be dated. Full dates stand alone; a year means 1 January of it; months take their year
 * from the nearest year or full date before them (walking forward, a month not after the previous
 * one starts a new year) or after them (walking backward). Bare day numbers are never dated: the
 * month and year they belong to are usually printed elsewhere (an offset text) that is not read.
 */
export function resolveDateLabels(tokens: (LabelToken | null)[]): (number | null)[] {
  const out: (number | null)[] = tokens.map(() => null);
  const ym: ({ y: number; m: number } | null)[] = tokens.map(() => null);
  const anchors: number[] = [];
  tokens.forEach((t, i) => {
    if (t?.kind === 'date') {
      out[i] = t.ms;
      const d = new Date(t.ms);
      ym[i] = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
      anchors.push(i);
    } else if (t?.kind === 'year') {
      out[i] = Date.UTC(t.year, 0, 1);
      ym[i] = { y: t.year, m: 1 };
      anchors.push(i);
    }
  });
  if (anchors.length === 0) return out;
  const place = (i: number, y: number, m: number) => {
    out[i] = Date.UTC(y, m - 1, 1);
    ym[i] = { y, m };
  };
  // Forward from the first anchor.
  let cur = ym[anchors[0] as number] as { y: number; m: number };
  for (let i = (anchors[0] as number) + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (ym[i]) cur = ym[i] as { y: number; m: number };
    else if (t?.kind === 'month') {
      cur = { y: t.month > cur.m ? cur.y : cur.y + 1, m: t.month };
      place(i, cur.y, cur.m);
    }
  }
  // Backward from the first anchor.
  cur = ym[anchors[0] as number] as { y: number; m: number };
  for (let i = (anchors[0] as number) - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t?.kind === 'month') {
      cur = { y: t.month < cur.m ? cur.y : cur.y - 1, m: t.month };
      place(i, cur.y, cur.m);
    }
  }
  return out;
}

/**
 * Put back decimal points/commas that the label's layout shows but OCR dropped (Tesseract reads
 * a small "1.0" as "10" with high confidence, which would scale the whole axis by ten). Digits are
 * taken as equally wide (tabular figures), so a mark's position along the word says how many
 * digits precede it. Text that already has as many marks, or is not plain digits, is unchanged.
 */
export function restorePoints(text: string, marks: PointMarks): string {
  if (marks.points.length === 0) return text;
  const sign = /^[-+−]/.exec(text)?.[0] ?? '';
  const body = text.slice(sign.length);
  if (!/^[\d.,]+$/.test(body) || (body.match(/[.,]/g) ?? []).length >= marks.points.length) return text;
  const digits = body.replace(/[.,]/g, '');
  const n = digits.length;
  const pts = [...marks.points].sort((a, b) => a.x0 - b.x0);
  const markWidth = (list: typeof pts) => list.reduce((s, m) => s + (m.x1 - m.x0 + 1), 0);
  let out = '';
  let used = 0;
  pts.forEach((m, i) => {
    const left = m.x0 - marks.start - markWidth(pts.slice(0, i));
    const right = marks.end - m.x1 - markWidth(pts.slice(i + 1));
    const k = Math.min(n - 1, Math.max(used + 1, Math.round((n * left) / Math.max(1, left + right))));
    if (k <= used || k >= n) return;
    out += digits.slice(used, k) + m.char;
    used = k;
  });
  return sign + out + digits.slice(used);
}
