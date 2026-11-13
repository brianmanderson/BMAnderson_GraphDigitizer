/**
 * Finding tick labels next to a detected axis (Phase 5), and cutting them out for OCR. Pure TS,
 * no DOM.
 *
 * 1. Patch: the band outside the axis (below a bottom X axis or above a top one; left of a left
 *    Y axis or right of a right one: `DetectedAxis.position`), sampled in the skew-corrected
 *    frame so text is upright, starting just past the outside tick marks.
 * 2. Glyphs: 8-connected components of ink (an adaptive threshold from the band's own darkest
 *    strokes, so faint grey labels work). Components too big to be text (curves, legend boxes,
 *    lines), solid blobs (markers) and colourful ones (data, coloured tables) are dropped.
 * 3. Text rows: "body" glyphs (≥ 4 px tall) that overlap vertically form a row; small marks
 *    (decimal points, minus signs) join the row they sit in. Within a row, glyphs closer than
 *    ~half the text height form a word.
 * 4. Matching: with tick marks, each major tick takes the word centred on it — for the X axis the
 *    row with the most such words (nearest the axis on a tie), for the Y axis the word nearest the
 *    axis in the row level with the tick. Words that match no tick (a number-at-risk table's row
 *    labels, an axis title) are ignored. Without tick marks, the label row itself gives the
 *    positions: the X row nearest the axis with ≥ 3 words, or the Y words whose edges facing
 *    the axis line up next to it; the label centre is the position (less precise than a tick).
 * 5. Offset note: the text matplotlib prints for an axis offset or multiplier (`+1e4` beyond the
 *    X labels at the right end — below a bottom axis, above a top one — and above the Y axis's
 *    top end), found by position and text height.
 * 6. Layout inside a word: a raised, smaller trailing group is an exponent (`10⁻²`); a short wide
 *    mark at mid-height in front of the digits is a minus sign (OCR often drops it).
 */

import { INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, makeFrame, toFrame, type Frame } from './frame.ts';
import type { AxisDetection, AxisPosition, DetectedAxis, LineCandidate, Point, RgbaImage } from './types.ts';

/** A connected ink component in patch coordinates (inclusive bounds). */
interface Glyph {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
  /** Pixel indices into the patch. */
  pixels: number[];
}

interface Patch {
  /** Frame coordinates of patch pixel (0, 0); patch pixel (i, j) is frame (u0 + i, w0 + j). */
  u0: number;
  w0: number;
  width: number;
  height: number;
  dark: Float32Array;
  /** Colourfulness (max − min of R, G, B) of the nearest image pixel, 0–255. */
  chroma: Uint8Array;
}

export interface LabelWord {
  /** Bounds in patch coordinates (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  glyphs: Glyph[];
  /** Height of the row's body glyphs, px. */
  textHeight: number;
}

/** One label next to one axis position, ready for OCR. */
export interface FoundLabel {
  /** Position along the axis in the skew-corrected frame (u for X, w for Y). */
  along: number;
  /** The axis-line point the label belongs to (image px). */
  point: Point;
  /** Index into the axis's tick list, or null when the label itself gave the position. */
  tick: number | null;
  /**
   * Labels only: the label sits on a gridline (or the other axis) that meets this axis, so its
   * position is that line's, exact, rather than the label's centre.
   */
  gridline?: boolean;
  /** The text is slanted (italic or hand-lettered) and was sheared upright for OCR. */
  slanted?: boolean;
  /**
   * Labels only: the word runs into the band's edge next to the axis, i.e. it was written against
   * (or over) the line and may be cut off ("60" read as "6"), so its reading is not used as a value.
   */
  clipped?: boolean;
  /** The whole word, upscaled for OCR (dark text on white). */
  crop: RgbaImage;
  /** When the word ends in a raised exponent: the base and exponent cut separately. */
  base: RgbaImage | null;
  exponent: RgbaImage | null;
  /** A minus sign was seen in front of the digits (of the base, and of the exponent). */
  minus: boolean;
  exponentMinus: boolean;
  /** The word has a single body glyph (OCR is asked for one character). */
  singleChar: boolean;
  /** The exponent is a single digit (with or without a minus sign). */
  exponentSingleChar: boolean;
  /** Decimal points / commas seen between the base's digits (OCR often drops them). */
  marks: PointMarks;
  /** Label box in image px (for display): centre and size. */
  box: { center: Point; width: number; height: number };
}

/**
 * Where small baseline marks sit in a label's base, in patch px: `start`/`end` span the digits
 * (minus sign excluded); each mark is a decimal point ('.') or a comma (',', which descends below
 * the baseline).
 */
export interface PointMarks {
  start: number;
  end: number;
  points: { x0: number; x1: number; char: '.' | ',' }[];
}

export interface AxisLabels {
  axis: 'x' | 'y';
  mode: 'ticks' | 'labels-only';
  labels: FoundLabel[];
  /**
   * Text where matplotlib-style plots print an axis offset or multiplier (`+1e4`, `1e−3`,
   * `×10³`): below the X labels at the axis's right end, above the Y axis's top end. The tick
   * labels are only right after applying it.
   */
  note: FoundLabel | null;
  /**
   * The note runs into the other axis's tick labels (a Y note under a top X axis's label row), so
   * its text cannot be cut out cleanly: it must be treated as unreadable, never applied.
   */
  noteTangled?: boolean;
}

const BODY_MIN_HEIGHT = 4;
/** Text is upscaled so its body height is about this many px before OCR. */
const OCR_TEXT_HEIGHT = 28;

function makePatch(map: DarknessMap, img: RgbaImage, frame: Frame, u0: number, w0: number, width: number, height: number): Patch {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const dark = new Float32Array(w * h);
  const chroma = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = familyPoint(frame, 'horizontal', u0 + i, w0 + j);
      const v = sample(map, p.x, p.y);
      dark[j * w + i] = v > 0 ? v : 0;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) {
        const o = (y * img.width + x) * 4;
        const r = img.data[o] ?? 0;
        const g = img.data[o + 1] ?? 0;
        const b = img.data[o + 2] ?? 0;
        chroma[j * w + i] = Math.max(r, g, b) - Math.min(r, g, b);
      }
    }
  }
  return { u0, w0, width: w, height: h, dark, chroma };
}

/** Mean colourfulness of a glyph's pixels. */
function glyphChroma(p: Patch, g: Glyph): number {
  let s = 0;
  for (const k of g.pixels) s += p.chroma[k] ?? 0;
  return g.pixels.length ? s / g.pixels.length : 0;
}

/**
 * Glyphs this colourful are data (markers, coloured curves, a coloured number-at-risk table),
 * not tick labels, which are drawn in the axis colour: black or grey.
 */
const MAX_LABEL_CHROMA = 80;

/** Ink threshold for text in this patch: a fraction of its darkest strokes, never below INK. */
function inkThreshold(p: Patch): number {
  const vals: number[] = [];
  for (const v of p.dark) if (v >= INK_THRESHOLD) vals.push(v);
  if (vals.length < 10) return INK_THRESHOLD;
  vals.sort((a, b) => a - b);
  const p98 = vals[Math.floor(0.98 * (vals.length - 1))] as number;
  return Math.min(80, Math.max(INK_THRESHOLD, 0.3 * p98));
}

function components(p: Patch, threshold: number): Glyph[] {
  const { width: w, height: h, dark } = p;
  const seen = new Uint8Array(w * h);
  const out: Glyph[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || (dark[start] ?? 0) < threshold) continue;
    seen[start] = 1;
    stack.push(start);
    const g: Glyph = { x0: w, y0: h, x1: -1, y1: -1, n: 0, pixels: [] };
    while (stack.length) {
      const k = stack.pop() as number;
      const x = k % w;
      const y = (k - x) / w;
      g.pixels.push(k);
      g.n++;
      if (x < g.x0) g.x0 = x;
      if (x > g.x1) g.x1 = x;
      if (y < g.y0) g.y0 = y;
      if (y > g.y1) g.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const kk = yy * w + xx;
          if (!seen[kk] && (dark[kk] ?? 0) >= threshold) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
      }
    }
    out.push(g);
  }
  return out;
}

const gh = (g: { y0: number; y1: number }) => g.y1 - g.y0 + 1;
const gw = (g: { x0: number; x1: number }) => g.x1 - g.x0 + 1;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[s.length >> 1] as number) : 0;
}

/** Rows of text → words, nearest row to the axis first (rows sorted by top). */
function words(glyphs: Glyph[], maxTextHeight: number, fromRight: boolean): LabelWord[][] {
  // Solid roughly square blobs are markers (scatter points, legend swatches), not glyphs:
  // digit strokes fill well under 80 % of their box.
  const blob = (g: Glyph) => gh(g) >= BODY_MIN_HEIGHT && gw(g) >= 0.6 * gh(g) && gw(g) <= 1.6 * gh(g) && g.n >= 0.8 * gw(g) * gh(g);
  const text = glyphs.filter((g) => gh(g) <= maxTextHeight && gw(g) <= 8 * maxTextHeight && g.n >= 2 && !blob(g));
  const body = text.filter((g) => gh(g) >= BODY_MIN_HEIGHT).sort((a, b) => a.y0 - b.y0);
  // Union body glyphs that overlap vertically by ≥ 30 % of the smaller height.
  const rows: { y0: number; y1: number; glyphs: Glyph[] }[] = [];
  for (const g of body) {
    const row = rows.find((r) => Math.min(r.y1, g.y1) - Math.max(r.y0, g.y0) + 1 >= 0.3 * Math.min(gh(g), r.y1 - r.y0 + 1));
    if (row) {
      row.glyphs.push(g);
      row.y0 = Math.min(row.y0, g.y0);
      row.y1 = Math.max(row.y1, g.y1);
    } else {
      rows.push({ y0: g.y0, y1: g.y1, glyphs: [g] });
    }
  }
  const small = text.filter((g) => gh(g) < BODY_MIN_HEIGHT);
  for (const g of small) {
    const cy = (g.y0 + g.y1) / 2;
    const row = rows.find((r) => {
      const pad = 0.15 * (r.y1 - r.y0 + 1);
      return cy >= r.y0 - pad && cy <= r.y1 + pad;
    });
    row?.glyphs.push(g);
  }
  rows.sort((a, b) => a.y0 - b.y0);
  return rows.map((r) => {
    const height = median(r.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT).map(gh));
    const gap = Math.max(2, 0.5 * height);
    // Y labels are right-aligned at the axis: grow words from the axis side.
    const sorted = [...r.glyphs].sort((a, b) => (fromRight ? b.x1 - a.x1 : a.x0 - b.x0));
    const out: LabelWord[] = [];
    const bodyHeight = (wd: LabelWord) => Math.max(0, ...wd.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT).map(gh));
    for (const g of sorted) {
      const last = out[out.length - 1];
      const dist = last ? (fromRight ? last.x0 - g.x1 - 1 : g.x0 - last.x1 - 1) : Infinity;
      // A glyph much taller than the word that sticks out above and below it (an axis title's
      // letter beside a label) starts a new word; a base beside its raised exponent does not.
      const hw = last ? bodyHeight(last) : 0;
      const outside = last ? Math.min(last.y0 - g.y0, g.y1 - last.y1) : 0;
      const fits = hw === 0 || gh(g) < BODY_MIN_HEIGHT || gh(g) <= 1.4 * hw || outside <= 0.25 * hw;
      if (last && dist <= gap && fits) {
        last.glyphs.push(g);
        last.x0 = Math.min(last.x0, g.x0);
        last.x1 = Math.max(last.x1, g.x1);
        last.y0 = Math.min(last.y0, g.y0);
        last.y1 = Math.max(last.y1, g.y1);
      } else {
        out.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, glyphs: [g], textHeight: height });
      }
    }
    out.sort((a, b) => a.x0 - b.x0);
    // A word must contain a body glyph (stray dots and dashes are not labels).
    return out.filter((wd) => wd.glyphs.some((g) => gh(g) >= BODY_MIN_HEIGHT));
  });
}

interface Layout {
  base: Glyph[];
  marks: PointMarks;
  exponent: Glyph[];
  minus: boolean;
  exponentMinus: boolean;
  /** Vertical extent of the base glyphs (patch px). */
  baseTop: number;
  baseline: number;
}

// A minus sign: clearly wider than tall and long enough not to be a point (a 3×2 px blob).
const isDash = (g: Glyph, hb: number) => gw(g) >= 2 * gh(g) && gw(g) >= 0.3 * hb && gh(g) <= 0.3 * hb;

/**
 * Points from the column profile of the digits at a strong threshold (half the darkest stroke):
 * a run of columns with ink only near the baseline, at most ~0.4 of the text height wide, with
 * an empty column on each side and taller ink (digits) beyond both.
 */
function profilePoints(p: Patch, digits: Glyph[], start: number, end: number, baseline: number, hb: number): PointMarks['points'] {
  if (digits.length < 2 || end - start < 3) return [];
  let max = 0;
  for (const g of digits) for (const k of g.pixels) max = Math.max(max, p.dark[k] ?? 0);
  const t = 0.5 * max;
  const top = Math.max(0, Math.round(baseline - 1.1 * hb));
  const bottom = Math.min(p.height - 1, Math.round(baseline + 0.35 * hb));
  type Col = 'empty' | 'low' | 'tall';
  const cols: { kind: Col; lowest: number }[] = [];
  for (let x = start; x <= end; x++) {
    let first = -1;
    let last = -1;
    for (let y = top; y <= bottom; y++) {
      if ((p.dark[y * p.width + x] ?? 0) >= t) {
        if (first < 0) first = y;
        last = y;
      }
    }
    const kind: Col = first < 0 ? 'empty' : first > baseline - 0.3 * hb ? 'low' : 'tall';
    cols.push({ kind, lowest: last });
  }
  const out: PointMarks['points'] = [];
  for (let i = 0; i < cols.length; ) {
    if (cols[i]?.kind !== 'low') {
      i++;
      continue;
    }
    let j = i;
    while (cols[j + 1]?.kind === 'low') j++;
    const width = j - i + 1;
    const emptyBoth = cols[i - 1]?.kind === 'empty' && cols[j + 1]?.kind === 'empty';
    const tallLeft = cols.slice(0, i).some((c) => c.kind === 'tall');
    const tallRight = cols.slice(j + 1).some((c) => c.kind === 'tall');
    if (width <= Math.max(1, 0.4 * hb) && emptyBoth && tallLeft && tallRight) {
      const lowest = Math.max(...cols.slice(i, j + 1).map((c) => c.lowest));
      out.push({ x0: start + i, x1: start + j, char: lowest > baseline + 0.1 * hb ? ',' : '.' });
    }
    i = j + 1;
  }
  return out;
}

function layout(word: LabelWord, p: Patch): Layout {
  const gs = [...word.glyphs].sort((a, b) => a.x0 - b.x0);
  const hb = Math.max(...gs.map(gh));
  const tall = gs.filter((g) => gh(g) >= 0.75 * hb);
  // Medians, so a raised exponent as tall as the digits does not move the base's lines.
  const baseline = median(tall.map((g) => g.y1));
  const baseTop = median(tall.map((g) => g.y0));
  const firstTall = gs.indexOf(tall[0] as Glyph);
  // Exponent: a trailing run of raised glyphs after the first tall one (trailing, so a leading
  // minus sign is never one). Raised = ends well above the baseline, or above it and sticking
  // out over the digits' top. At low resolution an exponent's strokes break into pieces, so
  // the first test looks at the bottom only.
  let k = gs.length;
  while (k - 1 > firstTall) {
    const g = gs[k - 1] as Glyph;
    const raised = g.y1 <= baseline - 0.3 * hb || (g.y1 <= baseline - 0.2 * hb && g.y0 <= baseTop - 0.1 * hb);
    if (!raised || gh(g) > hb) break;
    k--;
  }
  const exponent = gs.slice(k);
  let base = gs.slice(0, k);
  if (exponent.length > 0 && !exponent.some((g) => !isDash(g, hb))) {
    // Only a raised dash: not an exponent.
    base = gs;
    exponent.length = 0;
  }
  const minusAt = (list: Glyph[], top: number, bottom: number) => {
    const g = list[0];
    if (!g || list.length < 2) return false;
    const h = bottom - top + 1;
    const cy = (g.y0 + g.y1) / 2;
    return isDash(g, h) && cy >= bottom - 0.75 * h && cy <= bottom - 0.15 * h;
  };
  const hasMinus = minusAt(base, baseTop, baseline);
  const digits = hasMinus ? base.slice(1) : base;
  const marks: PointMarks = {
    start: digits.length ? Math.min(...digits.map((g) => g.x0)) : 0,
    end: digits.length ? Math.max(...digits.map((g) => g.x1)) : 0,
    points: [],
  };
  // From the column profile, not from components: antialiasing often bridges a point to the
  // next digit, and JPEG breaks digits into small pieces that look like points.
  const points = profilePoints(p, digits, marks.start, marks.end, baseline, hb);
  marks.points = points;
  const eTop = exponent.length ? Math.min(...exponent.map((g) => g.y0)) : 0;
  const eBottom = exponent.length ? Math.max(...exponent.filter((g) => !isDash(g, hb)).map((g) => g.y1)) : 0;
  return {
    base,
    marks,
    exponent,
    minus: hasMinus,
    exponentMinus: exponent.length > 1 && minusAt(exponent, eTop, eBottom),
    baseTop,
    baseline,
  };
}

/** Shears tried for italic text (horizontal shift per pixel of height, top to the right). */
const SLANTS = Array.from({ length: 17 }, (_, i) => i * 0.05);
/** Below this shear (about 8.5°) text is treated as upright. */
const MIN_SLANT = 0.15;
/** Slant is only measured on text at least this tall (px): small glyphs are too coarse. */
const SLANT_MIN_HEIGHT = 10;
/** The best shear must sharpen the column profile (sum of squares) by this factor. */
const SLANT_GAIN = 1.05;

/**
 * The slant of italic or hand-lettered text: the shear that makes the glyphs' strokes most
 * vertical (the column profile of the sheared ink is then most peaked). 0 for upright text, for
 * small text, and when shearing does not clearly sharpen the profile. Tesseract reads slanted
 * digits poorly ("170" as "70"), so crops are sheared upright before OCR.
 */
function slantOf(p: Patch, glyphs: Glyph[], bodyHeight: number): number {
  if (bodyHeight < SLANT_MIN_HEIGHT) return 0;
  const x0 = Math.min(...glyphs.map((g) => g.x0));
  const y1 = Math.max(...glyphs.map((g) => g.y1));
  const y0 = Math.min(...glyphs.map((g) => g.y0));
  const span = Math.max(...glyphs.map((g) => g.x1)) - x0 + 1 + Math.ceil((SLANTS[SLANTS.length - 1] as number) * (y1 - y0 + 1));
  const offset = Math.ceil((SLANTS[SLANTS.length - 1] as number) * (y1 - y0 + 1));
  const bins = new Float64Array(span + 2);
  const score = (k: number) => {
    bins.fill(0);
    for (const g of glyphs) {
      for (const idx of g.pixels) {
        const x = idx % p.width;
        const y = (idx - x) / p.width;
        const b = Math.round(x - x0 + offset + k * (y - y1));
        bins[b] = (bins[b] ?? 0) + (p.dark[idx] ?? 0);
      }
    }
    let s = 0;
    for (const b of bins) s += b * b;
    return s;
  };
  const upright = score(0);
  let best = 0;
  let bestScore = upright;
  for (const k of SLANTS) {
    const s = score(k);
    if (s > bestScore) {
      best = k;
      bestScore = s;
    }
  }
  return best >= MIN_SLANT && bestScore >= SLANT_GAIN * upright ? best : 0;
}

/**
 * Cut glyphs out of the patch as an upscaled grey image: black text on white, the glyphs' box
 * with a 1-px border, bilinear upscaling so the body height is about
 * OCR_TEXT_HEIGHT, and a white margin. Contrast is normalised to the glyphs' darkest stroke.
 * `slant` > 0 shears italic text upright (rows shift left in proportion to their height above
 * the box's bottom).
 */
function cut(p: Patch, glyphs: Glyph[], bodyHeight: number, slant = 0): RgbaImage {
  const x0 = Math.min(...glyphs.map((g) => g.x0)) - 1;
  const x1 = Math.max(...glyphs.map((g) => g.x1)) + 1;
  const y0 = Math.min(...glyphs.map((g) => g.y0)) - 1;
  const y1 = Math.max(...glyphs.map((g) => g.y1)) + 1;
  let max = 1;
  for (const g of glyphs) for (const k of g.pixels) max = Math.max(max, p.dark[k] ?? 0);
  const scale = Math.min(10, Math.max(1, OCR_TEXT_HEIGHT / Math.max(1, bodyHeight)));
  const margin = Math.round(0.5 * OCR_TEXT_HEIGHT);
  // Upright x = x + slant·(y − y1): the box's bottom row stays put, its top moves left.
  const xu0 = x0 - slant * (y1 - y0);
  const cw = Math.max(1, Math.round((x1 - xu0 + 1) * scale));
  const ch = Math.max(1, Math.round((y1 - y0 + 1) * scale));
  const width = cw + 2 * margin;
  const height = ch + 2 * margin;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // Everything inside the glyphs' box: faint parts below the glyph threshold (a light decimal
  // point) stay visible to OCR.
  const at = (x: number, y: number) => (x < x0 || y < y0 || x > x1 || y > y1 ? 0 : (p.dark[y * p.width + x] ?? 0));
  for (let j = 0; j < ch; j++) {
    const fy = y0 - 0.5 + (j + 0.5) / scale;
    const iy = Math.floor(fy);
    const ay = fy - iy;
    for (let i = 0; i < cw; i++) {
      const fx = xu0 - 0.5 + (i + 0.5) / scale + slant * (y1 - fy);
      const ix = Math.floor(fx);
      const ax = fx - ix;
      const d =
        (at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax) * (1 - ay) + (at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax) * ay;
      const v = 255 - Math.min(255, (255 * d) / (0.8 * max));
      const o = ((j + margin) * width + i + margin) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
    }
  }
  return { width, height, data };
}

interface AxisGeometry {
  family: 'horizontal' | 'vertical';
  offset: number;
  start: number;
  end: number;
  thickness: number;
}

/**
 * A text row in the frame: its centre line (w), how far a word's centre may be from it to be
 * part of it, and half its height.
 */
interface Row {
  w: number;
  tol: number;
  half: number;
}

/**
 * Labels without tick marks sit beside the line they name when the figure has a grid (or at the
 * other axis, for the label at the corner): such a label takes that line's position, which is
 * exact, instead of its own centre (a hand-lettered or italic label's centre can be off by a
 * good part of its width). A line qualifies when it runs into the plot from this axis (one end
 * at the axis line, or a little past it) and lies within 15 % of the label spacing and 20 % of
 * the label's extent of the label's centre; labels between gridlines keep their centres.
 */
function snapToGridlines<T extends { word: LabelWord; along: number }>(
  chosen: T[],
  line: AxisGeometry,
  position: AxisPosition,
  crossing: LineCandidate[],
  extent: (wd: LabelWord) => number,
): (T & { gridline?: boolean })[] {
  if (chosen.length < 2) return chosen;
  const alongs = chosen.map((c) => c.along).sort((a, b) => a - b);
  const spacing = median(alongs.slice(1).map((a, i) => a - (alongs[i] as number)));
  // How far the crossing line runs past the axis, away from the plot (negative: it stops short).
  // It must reach the axis; a hand-ruled grid may poke out a little into the labels.
  const beyond = (c: LineCandidate) => (position === 'bottom' || position === 'right' ? c.end - line.offset : line.offset - c.start);
  const reach = 3 + line.thickness;
  const meeting = crossing.filter(
    (c) => beyond(c) >= -(reach + c.thickness) && beyond(c) <= 0.5 * spacing && c.offset >= line.start - reach && c.offset <= line.end + reach,
  );
  return chosen.map((c) => {
    // Tight: a label beside the frame (c19's first label sits half its width inside it) must keep
    // its centre; a label written over its gridline is off by a small part of its extent.
    const tol = Math.min(0.15 * spacing, 0.2 * extent(c.word));
    let best: LineCandidate | null = null;
    for (const g of meeting) {
      const d = Math.abs(g.offset - c.along);
      if (d <= tol && (!best || d < Math.abs(best.offset - c.along))) best = g;
    }
    return best ? { ...c, along: best.offset, gridline: true } : c;
  });
}

function labelsFor(
  map: DarknessMap,
  img: RgbaImage,
  frame: Frame,
  which: 'x' | 'y',
  ax: DetectedAxis,
  crossing: LineCandidate[],
  avoid: Row | null = null,
): AxisLabels {
  const majors = ax.ticks.ticks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'major');
  const tickMode: AxisLabels['mode'] = majors.length >= 2 ? 'ticks' : 'labels-only';
  const viaTicks = labelsWith(map, img, frame, which, ax, avoid, tickMode, majors, crossing);
  // Marks that no two labels sit at are not the labelled ticks (glyphs touching the axis, a
  // scanned line's bumps): the labels themselves give the positions then.
  if (tickMode === 'ticks' && viaTicks.labels.length < 2) {
    const viaLabels = labelsWith(map, img, frame, which, ax, avoid, 'labels-only', [], crossing);
    if (viaLabels.labels.length >= 2) return viaLabels;
  }
  return viaTicks;
}

function labelsWith(
  map: DarknessMap,
  img: RgbaImage,
  frame: Frame,
  which: 'x' | 'y',
  ax: DetectedAxis,
  avoid: Row | null,
  mode: AxisLabels['mode'],
  majors: { t: DetectedAxis['ticks']['ticks'][number]; i: number }[],
  crossing: LineCandidate[],
): AxisLabels {
  const { width: W, height: H } = map;
  const line: AxisGeometry = ax.line;
  // The labels' side: below a bottom X axis / above a top one; left of a left Y axis / right of
  // a right one. "Near" = the patch edge next to the axis.
  const flipped = ax.position === 'top' || ax.position === 'right';
  const outsideLen =
    mode === 'ticks' && ax.ticks.side !== 'inside' ? Math.max(...majors.map(({ t }) => t.length)) : 0;
  // Past the line's edge by half its thickness again: a thick scanned or hand-ruled line wobbles
  // by that much, and labels touching it must not join it into one long component.
  const d0 = Math.max(line.thickness / 2, outsideLen) + 1 + (mode === 'labels-only' ? Math.max(0, line.thickness / 2 - 1) : 0);
  const short = Math.min(W, H);
  const margin = Math.max(20, 0.08 * (line.end - line.start));
  const maxTextHeight = Math.max(12, 0.08 * short);

  let p: Patch;
  if (which === 'x') {
    const depth = Math.min(250, Math.max(45, 0.15 * short));
    const w0 = flipped ? line.offset - d0 - depth : line.offset + d0;
    p = makePatch(map, img, frame, line.start - margin, w0, line.end - line.start + 2 * margin, depth);
  } else {
    const depth = Math.min(400, Math.max(40, 0.25 * W));
    const u0 = flipped ? line.offset + d0 : line.offset - d0 - depth;
    p = makePatch(map, img, frame, u0, line.start - margin, depth, line.end - line.start + 2 * margin);
  }
  const glyphs = components(p, inkThreshold(p)).filter((g) => glyphChroma(p, g) < MAX_LABEL_CHROMA);
  // Y labels are aligned at the axis: words grow from the axis side.
  const rows = words(glyphs, maxTextHeight, which === 'y' && !flipped);
  // X rows nearest the axis first.
  const xRows = flipped ? [...rows].reverse() : rows;
  // Distance of a Y word's near edge from the axis side of the patch.
  const gapToAxis = (wd: LabelWord) => (flipped ? wd.x0 : p.width - 1 - wd.x1);

  // Candidate (word, position) pairs.
  const chosen: { word: LabelWord; along: number; tick: number | null }[] = [];
  const centreX = (wd: LabelWord) => p.u0 + (wd.x0 + wd.x1) / 2;
  const bodyCentreY = (wd: LabelWord) => {
    const l = layout(wd, p);
    return p.w0 + (l.baseTop + l.baseline) / 2;
  };
  if (which === 'x') {
    const tol = (wd: LabelWord) => 0.35 * wd.textHeight + 0.2 * (wd.x1 - wd.x0 + 1) + 1;
    if (mode === 'ticks') {
      let best: { row: LabelWord[]; hits: { word: LabelWord; along: number; tick: number }[] } | null = null;
      for (const row of xRows) {
        const used = new Set<LabelWord>();
        const hits: { word: LabelWord; along: number; tick: number }[] = [];
        for (const { t, i } of majors) {
          let pick: LabelWord | null = null;
          for (const wd of row) {
            const d = Math.abs(centreX(wd) - t.along);
            if (d <= tol(wd) && !used.has(wd) && (!pick || d < Math.abs(centreX(pick) - t.along))) pick = wd;
          }
          if (pick) {
            used.add(pick);
            hits.push({ word: pick, along: t.along, tick: i });
          }
        }
        if (hits.length >= 2 && (!best || hits.length > best.hits.length)) best = { row, hits };
      }
      if (best) chosen.push(...best.hits);
    } else {
      const row = xRows.find((r) => r.length >= 3);
      if (row) for (const wd of row) chosen.push({ word: wd, along: centreX(wd), tick: null });
    }
  } else {
    // The word of each row nearest the axis.
    const nearest = rows.map((r) => r.reduce((a, b) => (gapToAxis(b) < gapToAxis(a) ? b : a)));
    if (mode === 'ticks') {
      const used = new Set<LabelWord>();
      for (const { t, i } of majors) {
        let pick: LabelWord | null = null;
        for (const wd of nearest) {
          const d = Math.abs(bodyCentreY(wd) - t.along);
          // The label must also sit close to the axis (not a table's row label further out).
          if (d <= 0.5 * wd.textHeight + 1 && gapToAxis(wd) <= 3 * wd.textHeight + 4 && !used.has(wd)) {
            if (!pick || d < Math.abs(bodyCentreY(pick) - t.along)) pick = wd;
          }
        }
        if (pick) {
          used.add(pick);
          chosen.push({ word: pick, along: t.along, tick: i });
        }
      }
    } else if (nearest.length >= 3) {
      const closest = Math.min(...nearest.map(gapToAxis));
      for (const wd of nearest) {
        if (gapToAxis(wd) <= closest + Math.max(3, 0.6 * wd.textHeight)) chosen.push({ word: wd, along: bodyCentreY(wd), tick: null });
      }
      if (chosen.length < 3) chosen.length = 0;
    }
  }

  const found = (word: LabelWord, q: Patch, along: number, tick: number | null, italic = false): FoundLabel => {
    const l = layout(word, q);
    const bodyH = Math.max(1, l.baseline - l.baseTop + 1);
    const slant = italic ? slantOf(q, word.glyphs, bodyH) : 0;
    // Slanted (italic, hand-lettered) labels are read whole: their uneven glyphs often end above
    // the baseline, which is no sign of an exponent.
    const hasExp = l.exponent.length > 0 && slant === 0;
    const expBodies = hasExp ? l.exponent.filter((g) => !isDash(g, bodyH)) : [];
    const expH = expBodies.length ? Math.max(...expBodies.map(gh)) : bodyH;
    const bodies = word.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT);
    const cx = (word.x0 + word.x1) / 2;
    const cy = (word.y0 + word.y1) / 2;
    const center = familyPoint(frame, 'horizontal', q.u0 + cx, q.w0 + cy);
    const point = tick !== null ? (ax.ticks.ticks[tick] as { point: Point }).point : familyPoint(frame, line.family, along, line.offset);
    return {
      along,
      point,
      tick,
      crop: cut(q, word.glyphs, bodyH, slant),
      base: hasExp ? cut(q, l.base, bodyH, slant) : null,
      exponent: hasExp ? cut(q, l.exponent, expH, slant) : null,
      minus: l.minus,
      exponentMinus: hasExp && l.exponentMinus,
      // One glyph no wider than it is tall (two touching digits make one wide component).
      singleChar: bodies.length === 1 && !hasExp && word.x1 - word.x0 + 1 <= 0.8 * bodyH,
      exponentSingleChar: expBodies.length === 1,
      marks: l.marks,
      box: { center, width: word.x1 - word.x0 + 1, height: word.y1 - word.y0 + 1 },
      ...(slant > 0 ? { slanted: true } : {}),
      // Only without ticks: then the band starts at the line, and a word reaching its edge was
      // written against the line. (With ticks the band starts past them; a label grazing that
      // edge is usually whole.)
      ...(mode === 'labels-only' && q === p && touchesAxisSide(word) ? { clipped: true } : {}),
    };
  };
  const touchesAxisSide = (wd: LabelWord) =>
    which === 'x' ? (flipped ? wd.y1 >= p.height - 1 : wd.y0 <= 0) : flipped ? wd.x0 <= 0 : wd.x1 >= p.width - 1;
  // A sliver of the line's own ragged edge (a thick scanned line), 1–2 px across and touching
  // the band's axis side, is no label.
  const sliver = (wd: LabelWord) => touchesAxisSide(wd) && (which === 'x' ? wd.y1 - wd.y0 + 1 : wd.x1 - wd.x0 + 1) <= 2;
  const kept = mode === 'labels-only' ? chosen.filter((c) => !sliver(c.word)) : chosen;
  const snapped: (typeof chosen[number] & { gridline?: boolean })[] = mode === 'labels-only' ? snapToGridlines(kept, line, ax.position, crossing, which === 'x' ? (wd) => wd.x1 - wd.x0 + 1 : (wd) => wd.y1 - wd.y0 + 1) : kept;
  // Italic or hand-lettered labels: most of the axis's labels are slanted. A single upright "7"
  // or "/"-like digit can look slanted on its own, so the decision is the axis's, not the word's.
  const slanted = snapped.filter(({ word }) => {
    const l = layout(word, p);
    return slantOf(p, word.glyphs, Math.max(1, l.baseline - l.baseTop + 1)) > 0;
  }).length;
  const italic = snapped.length >= 2 && slanted > 0.5 * snapped.length;
  const labels = snapped.map(({ word, along, tick, gridline }) => {
    const l = found(word, p, along, tick, italic);
    return gridline ? { ...l, gridline } : l;
  });
  labels.sort((a, b) => a.along - b.along);

  // The offset/multiplier note, only next to an axis whose labels were found. Its words (`+`,
  // `1e5`) are merged.
  let note: FoundLabel | null = null;
  let noteTangled = false;
  const merge = (ws: LabelWord[]): LabelWord => ({
    x0: Math.min(...ws.map((w) => w.x0)),
    y0: Math.min(...ws.map((w) => w.y0)),
    x1: Math.max(...ws.map((w) => w.x1)),
    y1: Math.max(...ws.map((w) => w.y1)),
    glyphs: ws.flatMap((w) => w.glyphs),
    textHeight: (ws[0] as LabelWord).textHeight,
  });
  if (chosen.length >= 2) {
    const h = median(chosen.map((c) => c.word.textHeight));
    const used = new Set(chosen.map((c) => c.word));
    const similar = (wd: LabelWord) => Math.abs(wd.textHeight - h) <= 0.4 * h;
    if (which === 'x') {
      // Right-aligned at the axis end, in the rows just beyond the labels (below a bottom axis's
      // labels, above a top axis's), nearest row first.
      const beyond = flipped ? -Math.min(...chosen.map((c) => c.word.y0)) : Math.max(...chosen.map((c) => c.word.y1));
      const endX = line.end - p.u0;
      for (const row of xRows) {
        const ws = row.filter((wd) => {
          const start = flipped ? -wd.y1 : wd.y0;
          return !used.has(wd) && start > beyond - 0.3 * h && start <= beyond + 2.5 * h && similar(wd);
        });
        const last = ws.reduce<LabelWord | null>((a, b) => (!a || b.x1 > a.x1 ? b : a), null);
        if (!last || Math.abs(last.x1 - endX) > 1.5 * h) continue;
        const group = ws.filter((wd) => wd.x1 >= last.x0 - 6 * h);
        note = found(merge(group), p, line.end, null);
        break;
      }
    } else {
      // Aligned at the axis (left-aligned for a left axis, right-aligned for a right one), just
      // above its top end.
      const q = makePatch(map, img, frame, flipped ? line.offset - 11 * h : line.offset - 3 * h, line.start - 3 * h, 14 * h, 3 * h - 1);
      // A fixed low threshold: a dark title beside a small grey note would set an adaptive one
      // so high that the note falls apart.
      const qRows = words(components(q, 1.5 * INK_THRESHOLD).filter((g) => glyphChroma(q, g) < MAX_LABEL_CHROMA), maxTextHeight, false);
      // Above a Y axis that meets a top X axis runs the X labels' row: a word centred on that row
      // is an X label (one at the corner often has no tick of its own), not a note. A note
      // squeezed in beside it (matplotlib's, between the labels and the axis) is off-centre.
      const xLabel = (wd: LabelWord) => !!avoid && Math.abs(q.w0 + (wd.y0 + wd.y1) / 2 - avoid.w) <= avoid.tol;
      for (const row of qRows.reverse()) {
        const ws = row.filter((wd) => similar(wd) && line.start - (q.w0 + wd.y1) <= 1.5 * h && !xLabel(wd));
        // The word at the axis (leftmost for a left axis, rightmost for a right one), its outer
        // edge within reach of the axis line; mirrored for a right axis.
        const first = ws.reduce<LabelWord | null>((a, b) => (!a || (flipped ? b.x1 > a.x1 : b.x0 < a.x0) ? b : a), null);
        if (!first) continue;
        const edge = flipped ? line.offset - (q.u0 + first.x1) : q.u0 + first.x0 - line.offset;
        if (edge < -2.5 * h || edge > 1.5 * h) continue;
        const group = ws.filter((wd) => (flipped ? wd.x1 >= first.x0 - 6 * h : wd.x0 <= first.x1 + 6 * h));
        note = found(merge(group), q, line.start, null);
        // Any part of it reaching into the X labels' row: glyphs of both may have merged.
        noteTangled =
          !!avoid && group.some((wd) => q.w0 + wd.y0 <= avoid.w + avoid.half && q.w0 + wd.y1 >= avoid.w - avoid.half);
        break;
      }
    }
  }
  return noteTangled ? { axis: which, mode, labels, note, noteTangled } : { axis: which, mode, labels, note };
}

/** Tick labels beside both detected axes (empty lists when an axis was not found). */
export function findLabels(map: DarknessMap, img: RgbaImage, det: AxisDetection): { x: AxisLabels; y: AxisLabels } {
  const frame = makeFrame((det.skewDegrees * Math.PI) / 180);
  const x: AxisLabels = det.xAxis ? labelsFor(map, img, frame, 'x', det.xAxis, det.candidates.vertical) : { axis: 'x', mode: 'labels-only', labels: [], note: null };
  // A top X axis's label row runs over the Y axis's top end, where the Y note is looked for.
  let avoid: Row | null = null;
  if (det.xAxis?.position === 'top' && x.labels.length) {
    const height = median(x.labels.map((l) => l.box.height));
    avoid = { w: median(x.labels.map((l) => toFrame(frame, l.box.center).w)), tol: Math.max(2, 0.3 * height), half: height / 2 };
  }
  return {
    x,
    y: det.yAxis ? labelsFor(map, img, frame, 'y', det.yAxis, det.candidates.horizontal, avoid) : { axis: 'y', mode: 'labels-only', labels: [], note: null },
  };
}
