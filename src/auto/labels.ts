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
import { familyPoint, makeFrame, toFrame, toImage, type Frame } from './frame.ts';
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
  /** Hue of the nearest image pixel, degrees 0–360 (meaningless where chroma is low). */
  hue: Float32Array;
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
  /**
   * More text of body height stands on the label's baseline right beside it, but was not joined
   * to it: the label may be a piece of itself ("8" of "0.8" when the point was lost). Its reading
   * is shown but not used as a value — five such pieces would otherwise agree on a scale ×10.
   */
  partial?: boolean;
  /** The whole word, upscaled for OCR (dark text on white). */
  crop: RgbaImage;
  /** When the word ends in a raised exponent: the base and exponent cut separately. */
  base: RgbaImage | null;
  exponent: RgbaImage | null;
  /** The exponent cut again at a smaller upscale, for a second reading when the first is empty. */
  exponentSmall?: RgbaImage;
  /** A minus sign was seen in front of the digits (of the base, and of the exponent). */
  minus: boolean;
  exponentMinus: boolean;
  /** The word has a single body glyph (OCR is asked for one character). */
  singleChar: boolean;
  /** The exponent is a single digit (with or without a minus sign). */
  exponentSingleChar: boolean;
  /** Decimal points / commas seen between the base's digits (OCR often drops them). */
  marks: PointMarks;
  /**
   * How many characters the base shows above the baseline zone (digits, letters, signs inside the
   * number; not points, commas or a leading minus), counted as separate column runs. Touching
   * characters count once, so a reading may have more characters than this, but one with fewer
   * dropped something ("20" read as "0", "20k" as "20").
   */
  runs?: number;
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
  /**
   * Places where two digits stand further apart than the font's digit pitch and something faint
   * sits between them at the baseline, but not cleanly enough to call it a point (at 6 px a point
   * runs into the foot of the digit before it). The value is then ambiguous: "25" or "2.5".
   */
  uncertain?: { x0: number; x1: number; char: '.' | ',' }[];
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
  /** The labels are rotated (45° or 90°) and were read in a turned frame; no note is looked for. */
  rotated?: boolean;
  /**
   * The same ticks' labels read as rotated text: to be used only when these labels give no
   * calibration and the alternative does.
   */
  alternative?: AxisLabels;
}

const BODY_MIN_HEIGHT = 4;
/** Text is upscaled so its body height is about this many px before OCR. */
const OCR_TEXT_HEIGHT = 28;
/**
 * A second crop of a raised exponent, upscaled less: a lone exponent digit 2–4 px tall that comes
 * back empty at OCR_TEXT_HEIGHT is often read at this height (see SPEC → Exponents).
 */
const EXP_REREAD_HEIGHT = 16;

function makePatch(map: DarknessMap, img: RgbaImage, frame: Frame, u0: number, w0: number, width: number, height: number): Patch {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const dark = new Float32Array(w * h);
  const chroma = new Uint8Array(w * h);
  const hue = new Float32Array(w * h);
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
        hue[j * w + i] = hueOf(r, g, b);
      }
    }
  }
  return { u0, w0, width: w, height: h, dark, chroma, hue };
}

/** Hue angle of an RGB colour, degrees in [0, 360). */
function hueOf(r: number, g: number, b: number): number {
  const h = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Mean colourfulness of a glyph's pixels. */
function glyphChroma(p: Patch, g: Glyph): number {
  let s = 0;
  for (const k of g.pixels) s += p.chroma[k] ?? 0;
  return g.pixels.length ? s / g.pixels.length : 0;
}

/**
 * Glyphs this colourful are data (markers, coloured curves, a coloured number-at-risk table),
 * not tick labels, which are usually drawn in the axis colour: black or grey. Labels printed in a
 * colour (a twin axis in its series colour, a styled figure) are looked for as a colour class of
 * their own (`colourClasses`) when the neutral ink gives fewer labels.
 */
const MAX_LABEL_CHROMA = 80;

/** Which glyphs of a patch may be label text. */
type Ink = (p: Patch, g: Glyph) => boolean;

const NEUTRAL: Ink = (p, g) => glyphChroma(p, g) < MAX_LABEL_CHROMA;

/**
 * The colour of a glyph's core: the mean chroma and hue of its pixels at least half as dark as its
 * darkest one. Antialiased and JPEG-blurred edges mix the colour with the background, so a whole
 * glyph's mean understates it (a thin red "−" averages under MAX_LABEL_CHROMA) while its core
 * keeps it.
 */
function coreColour(p: Patch, g: Glyph): { chroma: number; hue: number } {
  let max = 0;
  for (const k of g.pixels) max = Math.max(max, p.dark[k] ?? 0);
  let n = 0;
  let c = 0;
  let hx = 0;
  let hy = 0;
  for (const k of g.pixels) {
    if ((p.dark[k] ?? 0) < 0.5 * max) continue;
    const ch = p.chroma[k] ?? 0;
    const a = ((p.hue[k] ?? 0) * Math.PI) / 180;
    n++;
    c += ch;
    hx += ch * Math.cos(a);
    hy += ch * Math.sin(a);
  }
  if (!n) return { chroma: 0, hue: 0 };
  const h = (Math.atan2(hy, hx) * 180) / Math.PI;
  return { chroma: c / n, hue: h < 0 ? h + 360 : h };
}

/** A glyph of a colour class: its core within this many degrees of the class hue … */
const CLASS_HUE_TOLERANCE = 25;
/** … and at least this colourful (half the neutral limit: a fringe-diluted glyph of the class). */
const CLASS_MIN_CHROMA = 0.5 * MAX_LABEL_CHROMA;
/** A colour class needs this many text-sized glyphs of clear colour in the band. */
const CLASS_MIN_GLYPHS = 3;

/**
 * The hues of text-sized coloured glyphs in a band (core chroma ≥ MAX_LABEL_CHROMA), clustered:
 * glyphs are sorted by hue and split where neighbours differ by more than the class tolerance;
 * each cluster of at least CLASS_MIN_GLYPHS glyphs is a class, centred on its circular mean hue,
 * most glyphs first.
 */
function colourClasses(p: Patch, glyphs: Glyph[], maxTextHeight: number): number[] {
  const hues = glyphs
    .filter((g) => gh(g) >= BODY_MIN_HEIGHT && gh(g) <= maxTextHeight && gw(g) <= 2 * maxTextHeight)
    .map((g) => coreColour(p, g))
    .filter((c) => c.chroma >= MAX_LABEL_CHROMA)
    .map((c) => c.hue)
    .sort((a, b) => a - b);
  if (hues.length < CLASS_MIN_GLYPHS) return [];
  // Start the circular walk after the widest gap, so a cluster does not straddle 0°/360°.
  let start = 0;
  let widest = -1;
  hues.forEach((h, i) => {
    const prev = hues[(i + hues.length - 1) % hues.length] as number;
    const gap = (h - prev + 360) % 360;
    if (gap > widest) {
      widest = gap;
      start = i;
    }
  });
  const walk = [...hues.slice(start), ...hues.slice(0, start)];
  const clusters: number[][] = [];
  for (const h of walk) {
    const last = clusters[clusters.length - 1];
    if (last && hueDistance(last[last.length - 1] as number, h) <= CLASS_HUE_TOLERANCE) last.push(h);
    else clusters.push([h]);
  }
  return clusters
    .filter((c) => c.length >= CLASS_MIN_GLYPHS)
    .sort((a, b) => b.length - a.length)
    .map((c) => {
      const x = c.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
      const y = c.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0);
      const m = (Math.atan2(y, x) * 180) / Math.PI;
      return m < 0 ? m + 360 : m;
    });
}

/** The glyphs of one colour class (see `colourClasses`). */
const ofHue =
  (hue: number): Ink =>
  (p, g) => {
    const c = coreColour(p, g);
    return c.chroma >= CLASS_MIN_CHROMA && hueDistance(c.hue, hue) <= CLASS_HUE_TOLERANCE;
  };

/**
 * Ink threshold for text in this patch: a fraction of its darkest strokes, never below INK. For a
 * colour class (`hue`), of that colour's strokes only: an orange label is far lighter than the
 * black ticks and title beside it, and at their threshold its thin strokes fall apart.
 */
function inkThreshold(p: Patch, hue: number | null = null): number {
  const vals: number[] = [];
  p.dark.forEach((v, k) => {
    if (v < INK_THRESHOLD) return;
    if (hue !== null && ((p.chroma[k] ?? 0) < CLASS_MIN_CHROMA || hueDistance(p.hue[k] ?? 0, hue) > CLASS_HUE_TOLERANCE)) return;
    vals.push(v);
  });
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

/**
 * A decimal point between two digits of one word: in the columns between `a` and `b` (glyphs of
 * a row of body height `h`, baseline `baseline`) there is ink in the baseline zone — however faint,
 * and whether or not it survived as a component (a 1-px point is one pixel: components need two) —
 * at most 0.4 text heights wide, and none above it. Small text puts the digits on either side of a
 * point further apart than the word gap, so without this the word splits at its point and only the
 * digit next to the axis is kept: "0.8" read as "8".
 */
function pointBetween(p: Patch, a: Glyph, b: Glyph, baseline: number, h: number): boolean {
  const x0 = Math.min(a.x1, b.x1) + 1;
  const x1 = Math.max(a.x0, b.x0) - 1;
  if (x1 < x0) return false;
  const top = Math.max(0, Math.round(baseline - h));
  const zone = baseline - 0.3 * h;
  const bottom = Math.min(p.height - 1, Math.round(baseline + 0.35 * h));
  // A stroke above the baseline zone (a letter, a digit) vetoes; the antialiased edge of the digits
  // either side does not: the band is sampled at sub-pixel offsets, so a digit's edge bleeds into
  // the gap's first and last columns at a fraction of its stroke darkness.
  let stroke = 0;
  for (const g of [a, b]) for (const k of g.pixels) stroke = Math.max(stroke, p.dark[k] ?? 0);
  const lows: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let upper = 0;
    let lower = 0;
    for (let y = top; y <= bottom; y++) {
      const v = p.dark[y * p.width + x] ?? 0;
      if (y < zone) upper = Math.max(upper, v);
      else lower = Math.max(lower, v);
    }
    if (upper >= 0.5 * stroke) return false;
    lows.push(lower);
  }
  // A point is printed in the text colour: at least a quarter as dark as the strokes (a digit's
  // edge bleeding in at the baseline is fainter, 8 % on the scanned c70).
  const peak = Math.max(...lows);
  if (peak < Math.max(POINT_INK, 0.25 * stroke)) return false;
  // The point: the gap's columns at half its peak or more, at most 0.4 text heights wide, and
  // inside the gap — its first and last columns are where the digits' edges bleed in.
  const at = lows.map((v, i) => (v >= 0.5 * peak ? i : -1)).filter((i) => i >= 0);
  const first = at[0] as number;
  const last = at[at.length - 1] as number;
  return first > 0 && last < lows.length - 1 && last - first + 1 <= Math.max(1, 0.4 * h);
}

/** Darkness of a decimal point's ink (a 1-px point is antialiased; INK_THRESHOLD is 24). */
const POINT_INK = 0.5 * INK_THRESHOLD;

/** Rows of text → words, nearest row to the axis first (rows sorted by top). */
function words(p: Patch, glyphs: Glyph[], maxTextHeight: number, fromRight: boolean): LabelWord[][] {
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
  const placed = new Set(rows.flatMap((r) => r.glyphs));
  const loose = small.filter((g) => !placed.has(g));
  const built = rows.map((r) => {
    const rough = median(r.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT).map(gh));
    // A minus sign 4 px thick (a large or bold figure) is tall enough to be a "body" glyph, but it
    // says nothing about the text height.
    const dash = (g: Glyph) => gw(g) >= 2 * gh(g) && gh(g) <= 0.3 * rough;
    const height = median(r.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT && !dash(g)).map(gh)) || rough;
    const gap = Math.max(2, 0.5 * height);
    // Y labels are right-aligned at the axis: grow words from the axis side.
    const sorted = [...r.glyphs].sort((a, b) => (fromRight ? b.x1 - a.x1 : a.x0 - b.x0));
    // The word's body glyph next to `g`, and whether a point stands between the two.
    const pointAcross = (wd: LabelWord, g: Glyph) => {
      if (gh(g) < BODY_MIN_HEIGHT) return false;
      const bodies = wd.glyphs.filter((q) => gh(q) >= BODY_MIN_HEIGHT);
      if (bodies.length === 0) return false;
      const edge = bodies.reduce((a, b) => (fromRight ? (b.x0 < a.x0 ? b : a) : b.x1 > a.x1 ? b : a));
      const baseline = Math.max(edge.y1, g.y1);
      return Math.abs(edge.y1 - g.y1) <= 1 && pointBetween(p, edge, g, baseline, Math.max(gh(edge), gh(g)));
    };
    const out: LabelWord[] = [];
    // (A word that so far is only a minus sign has no height: the digit after it always fits.)
    const bodyHeight = (wd: LabelWord) => Math.max(0, ...wd.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT && !dash(g)).map(gh));
    for (const g of sorted) {
      const last = out[out.length - 1];
      const dist = last ? (fromRight ? last.x0 - g.x1 - 1 : g.x0 - last.x1 - 1) : Infinity;
      // A glyph much taller than the word that sticks out above and below it (an axis title's
      // letter beside a label) starts a new word; a base beside its raised exponent does not.
      const hw = last ? bodyHeight(last) : 0;
      const outside = last ? Math.min(last.y0 - g.y0, g.y1 - last.y1) : 0;
      const fits = hw === 0 || gh(g) < BODY_MIN_HEIGHT || gh(g) <= 1.4 * hw || outside <= 0.25 * hw;
      // Across a wider gap only to the digit beyond a decimal point (at most a text height away).
      const near = (d: number) => d <= gap || (d <= Math.max(gap, height) && pointAcross(last as LabelWord, g));
      if (last && near(dist) && fits) {
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
    return out;
  });
  attachRaised(built, loose);
  // A word must contain a body glyph (stray dots and dashes are not labels).
  return built.map((row) => row.filter((wd) => wd.glyphs.some((g) => gh(g) >= BODY_MIN_HEIGHT))).filter((row) => row.length > 0);
}

/**
 * Exponents set well above their base (`10⁻²` in mathtext: the exponent's foot is level with the
 * base's head) share no row with it, so the row test leaves them as a word of their own in the
 * row above, or — at 3 px tall — as loose marks. A smaller group that starts right after a word's
 * end and stands raised against it (its foot in the upper 70 % of the word or just above it) is
 * that word's exponent and joins it: at most 0.3 text heights away (further off it is another
 * word: a tick label beside a letter of the rotated axis title), no taller than 0.9 and no wider
 * than 1.8 of them. Tick labels have nothing else there: the next label of a row
 * is further away, and the label above on a Y axis is right-aligned with this one, not beyond it.
 */
function attachRaised(rows: LabelWord[][], loose: Glyph[]): void {
  type Piece = { x0: number; y0: number; x1: number; y1: number; glyphs: Glyph[]; row: LabelWord[] | null; word: LabelWord | null };
  const pieces: Piece[] = [
    ...rows.flatMap((row) => row.map((word): Piece => ({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, glyphs: word.glyphs, row, word }))),
    ...loose.map((g): Piece => ({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, glyphs: [g], row: null, word: null })),
  ];
  const taken = new Set<Piece>();
  for (const row of rows) {
    for (const base of [...row]) {
      if (taken.has(pieces.find((q) => q.word === base) as Piece)) continue;
      const top = base.y0;
      const bottom = base.y1;
      const h = bottom - top + 1;
      if (h < BODY_MIN_HEIGHT) continue;
      const raised = pieces
        .filter(
          (q) =>
            q.word !== base &&
            !taken.has(q) &&
            q.x0 >= base.x1 - 1 &&
            q.y1 - q.y0 + 1 <= 0.9 * h &&
            q.x1 - q.x0 + 1 <= 1.8 * h &&
            q.y1 <= bottom - 0.3 * h &&
            q.y1 >= top - 0.15 * h &&
            q.y0 >= top - 0.8 * h,
        )
        .sort((a, b) => a.x0 - b.x0);
      let end = base.x1;
      for (const q of raised) {
        if (q.x0 - end - 1 > Math.max(2, 0.3 * h)) break;
        taken.add(q);
        end = Math.max(end, q.x1);
        base.glyphs.push(...q.glyphs);
        base.x1 = Math.max(base.x1, q.x1);
        base.y0 = Math.min(base.y0, q.y0);
        if (q.row && q.word) q.row.splice(q.row.indexOf(q.word), 1);
      }
    }
  }
}

interface Layout {
  base: Glyph[];
  marks: PointMarks;
  /** Widths (px) of the digits' column runs: for the axis's digit width. */
  runWidths: number[];
  /** Height of the base's digits, px. */
  bodyHeight: number;
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
function profilePoints(
  p: Patch,
  digits: Glyph[],
  start: number,
  end: number,
  baseline: number,
  hb: number,
  digitWidth: number | null,
): { points: PointMarks['points']; uncertain: PointMarks['points']; runWidths: number[] } {
  if (digits.length < 1 || end - start < 3) return { points: [], uncertain: [], runWidths: digits.length ? [end - start + 1] : [] };
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
  // Digits: runs of columns with ink above the baseline zone, at a lower threshold than the
  // points' (at half the darkest stroke a 7 px "0" falls apart into its two sides).
  const zone = Math.round(baseline - 0.3 * hb);
  const weak = Math.max(0.5 * INK_THRESHOLD, 0.12 * max);
  const column = (i: number) => {
    let upper = 0;
    let lower = 0;
    let lowest = -1;
    for (let y = top; y <= bottom; y++) {
      const v = p.dark[y * p.width + start + i] ?? 0;
      if (y < zone) upper = Math.max(upper, v);
      else {
        lower = Math.max(lower, v);
        if (v >= weak) lowest = y;
      }
    }
    return { i, upper, lower, lowest };
  };
  const profile = cols.map((_, i) => column(i));
  const runs: { a: number; b: number }[] = [];
  profile.forEach((c) => {
    if (c.upper < 0.3 * max) return;
    const last = runs[runs.length - 1];
    if (last && last.b === c.i - 1) last.b = c.i;
    else runs.push({ a: c.i, b: c.i });
  });
  const runWidths = runs.map((r) => r.b - r.a + 1);
  const uncertain: PointMarks['points'] = [];
  // (One component only: the strong profile's "points" there are pieces of a broken digit.)
  if (digits.length < 2) out.length = 0;
  if (digitWidth === null || runs.length < 2) return { points: out, uncertain, runWidths };

  // A faint point (grey, 1-2 px: at half the darkest stroke it is not there at all) still pushes
  // the digits apart, and shows as ink of the gap that stays in the baseline zone.
  for (let k = 0; k + 1 < runs.length; k++) {
    const left = runs[k] as { a: number; b: number };
    const right = runs[k + 1] as { a: number; b: number };
    if (out.some((m) => m.x0 - start > left.b && m.x1 - start < right.a)) continue;
    // Two digits that merged into one run (JPEG, 5 px text) have no usable centre.
    if (left.b - left.a + 1 > MAX_DIGIT_RUN * digitWidth || right.b - right.a + 1 > MAX_DIGIT_RUN * digitWidth) continue;
    const pitch = ((right.a + right.b) / 2 - (left.a + left.b) / 2) / digitWidth;
    if (pitch < PITCH_POINT) continue;
    const gap = profile.slice(left.b + 1, right.a);
    const low = gap.filter((c) => c.lower >= Math.max(weak, 0.2 * max) && c.upper < 0.5 * c.lower);
    if (low.length === 0) continue;
    const markOf = (cs: typeof low) => ({
      x0: start + Math.min(...cs.map((c) => c.i)),
      x1: start + Math.max(...cs.map((c) => c.i)),
      char: (Math.max(...cs.map((c) => c.lowest)) > baseline + 0.1 * hb ? ',' : '.') as '.' | ',',
    });
    // Standing clear of both digits — a lighter column between it and each of them — it is a
    // point: a digit's foot (the serif of a 1, the base of a 2) and its antialiased edge hang on
    // to the digit.
    const clear = low.filter((c) => gap.some((d) => d.i < c.i && d.lower <= 0.5 * c.lower) && gap.some((d) => d.i > c.i && d.lower <= 0.5 * c.lower));
    if (clear.length > 0 && clear.length <= Math.max(1, 0.4 * hb)) out.push(markOf(clear));
    // In small text a point runs into the digit beside it: possible, not certain. (In larger
    // text a point is always resolved, and what touches a digit there is its own serif.)
    else if (clear.length === 0 && hb <= SMALL_TEXT && pitch >= PITCH_MAYBE && low.length <= Math.max(2, 0.4 * hb)) uncertain.push(markOf(low));
  }
  out.sort((a, b) => a.x0 - b.x0);
  // A number has one decimal point: where one was found, the base of the "2" in "0.20" is no other.
  if (out.length > 0) uncertain.length = 0;
  return { points: out, uncertain, runWidths };
}

/**
 * Digit pitch tests, in units of the axis's digit width (the width of its wide digits' column
 * runs, 0 and 2–9). Digits are tabular in nearly every font: on the corpus neighbours stand a
 * median 1.21 widths apart centre to centre (up to 1.6 beside a "1", whose ink is off-centre),
 * and 1.42–2.0 with a point between them. The pitch alone does not decide; it only rules out a
 * "point" between digits that stand too close to have one.
 */
const PITCH_POINT = 1.3;
const PITCH_MAYBE = 1.36;
/** Text up to this tall (px) may hide a point against the neighbouring digit. */
const SMALL_TEXT = 11.5;
/** A column run wider than this many digit widths is two digits run together. */
const MAX_DIGIT_RUN = 1.7;

/** Layouts without a digit width are asked for again and again (per tick, per word): kept. */
const plainLayouts = new WeakMap<LabelWord, Layout>();

function layout(word: LabelWord, p: Patch, digitWidth: number | null = null): Layout {
  if (digitWidth !== null) return layoutOf(word, p, digitWidth);
  let l = plainLayouts.get(word);
  if (!l) {
    l = layoutOf(word, p, null);
    plainLayouts.set(word, l);
  }
  return l;
}

function layoutOf(word: LabelWord, p: Patch, digitWidth: number | null): Layout {
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
  const found = profilePoints(p, digits, marks.start, marks.end, baseline, hb, digitWidth);
  marks.points = found.points;
  if (found.uncertain.length > 0) marks.uncertain = found.uncertain;
  const eTop = exponent.length ? Math.min(...exponent.map((g) => g.y0)) : 0;
  const eBottom = exponent.length ? Math.max(...exponent.filter((g) => !isDash(g, hb)).map((g) => g.y1)) : 0;
  return {
    base,
    marks,
    runWidths: found.runWidths,
    bodyHeight: hb,
    exponent,
    minus: hasMinus,
    exponentMinus: exponent.length > 1 && minusAt(exponent, eTop, eBottom),
    baseTop,
    baseline,
  };
}

/**
 * An exponent's glyphs for its own crop, and the specks among them: at low resolution or in a JPEG
 * a fleck of the base's last digit (the top of a "0") ends up raised beside the exponent and is
 * taken for part of it; cut out with the exponent it reads as a point or a digit ("²" as ".2").
 * A speck is no taller and no wider than a quarter of the exponent's height, not a minus sign, and
 * lies wholly in front of the exponent's other glyphs.
 */
function exponentParts(exponent: Glyph[], bodyH: number, expH: number): [Glyph[], Glyph[]] {
  const tiny = (g: Glyph) => !isDash(g, bodyH) && gh(g) <= 0.25 * expH && gw(g) <= 0.25 * expH;
  const solid = exponent.filter((g) => !tiny(g));
  if (!solid.length) return [exponent, []];
  // Only in front of the exponent's own strokes: a small piece under or beside them is a part of
  // a digit broken up at low resolution (the foot of a "3").
  const start = Math.min(...solid.map((g) => g.x0));
  const speck = (g: Glyph) => tiny(g) && g.x1 < start;
  return [exponent.filter((g) => !speck(g)), exponent.filter(speck)];
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
function cut(p: Patch, glyphs: Glyph[], bodyHeight: number, slant = 0, exclude: Glyph[] = [], textHeight = OCR_TEXT_HEIGHT): RgbaImage {
  const x0 = Math.min(...glyphs.map((g) => g.x0)) - 1;
  const x1 = Math.max(...glyphs.map((g) => g.x1)) + 1;
  const y0 = Math.min(...glyphs.map((g) => g.y0)) - 1;
  const y1 = Math.max(...glyphs.map((g) => g.y1)) + 1;
  let max = 1;
  for (const g of glyphs) for (const k of g.pixels) max = Math.max(max, p.dark[k] ?? 0);
  // The other part of a word (the base beside an exponent, or the exponent above a base) can
  // reach into this part's box: the top of a "0" next to a small exponent made "³" read as "23".
  // A pixel of the box nearer to that part's ink than to this part's is left out (its own pixels
  // and its antialiased rim; faint ink of this part, such as a light point, stays).
  const masked = new Set<number>();
  if (exclude.length) {
    const coords = (gs: Glyph[]) =>
      gs.flatMap((g) => g.pixels.map((k) => [k % p.width, Math.floor(k / p.width)] as const));
    const own = coords(glyphs);
    const other = coords(exclude).filter(([x, y]) => x >= x0 - 3 && x <= x1 + 3 && y >= y0 - 3 && y <= y1 + 3);
    const nearest = (pts: readonly (readonly [number, number])[], x: number, y: number) =>
      pts.reduce((m, [px, py]) => Math.min(m, Math.max(Math.abs(px - x), Math.abs(py - y))), Infinity);
    if (other.length) {
      for (let y = Math.max(0, y0); y <= Math.min(p.height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(p.width - 1, x1); x++) {
          if (nearest(other, x, y) < nearest(own, x, y)) masked.add(y * p.width + x);
        }
      }
    }
  }
  const scale = Math.min(10, Math.max(1, textHeight / Math.max(1, bodyHeight)));
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
  const at = (x: number, y: number) =>
    x < x0 || y < y0 || x > x1 || y > y1 || masked.has(y * p.width + x) ? 0 : (p.dark[y * p.width + x] ?? 0);
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
  let primary = viaTicks;
  if (tickMode === 'ticks' && viaTicks.labels.length < 2) {
    const viaLabels = labelsWith(map, img, frame, which, ax, avoid, 'labels-only', [], crossing);
    if (viaLabels.labels.length >= 2) primary = viaLabels;
  }
  // Labels printed in a colour: each colour class of the band is matched like the neutral ink,
  // and replaces the neutral pass when it finds more labels, or at least half as many that either
  // have more than twice their ink (the neutral pass then matched the faint, colourless fringes of
  // the coloured glyphs: empty readings at every tick) or sit nearer the axis (it matched the
  // black axis title beyond them) — both only at tick marks. Its glyphs only, so a black gridline or a curve of another hue
  // is no part of them. Otherwise neutral wins: a coloured number-at-risk table under black tick
  // labels matches the same ticks with ink like theirs, further from the axis.
  for (const hue of HUES.get(viaTicks) ?? []) {
    let alt = labelsWith(map, img, frame, which, ax, avoid, tickMode, majors, crossing, hue);
    if (tickMode === 'ticks' && alt.labels.length < 2) alt = labelsWith(map, img, frame, which, ax, avoid, 'labels-only', [], crossing, hue);
    const n = alt.labels.length;
    const m = primary.labels.length;
    const half = alt.mode === 'ticks' && n >= 0.5 * m;
    const inkier = half && (MASS.get(alt) ?? 0) > 2 * (MASS.get(primary) ?? 0);
    const nearer = half && m > 0 && reach(alt) < reach(primary) - Math.max(2, 0.5 * median(alt.labels.map((l) => l.box.height)));
    if (n >= 2 && (n > m || inkier || nearer)) {
      primary = alt;
      UPRIGHT.set(viaTicks, UPRIGHT.get(alt) ?? 0);
    }
  }
  // Rotated tick labels (45° or 90°, common for long X labels: dates, big numbers; 90° on Y),
  // looked for only when few of the labels found read as upright text: the band is sampled again
  // in a frame turned by that angle, where the text is upright. Glyph shapes alone cannot tell
  // turned text from small upright digits run together, so this is only an alternative reading:
  // auto-calibration reads it when the upright reading gives no calibration.
  const upright = UPRIGHT.get(viaTicks) ?? 0;
  if (tickMode === 'ticks' && upright < ROTATED_ONLY_BELOW * majors.length) {
    let best: { labels: FoundLabel[]; score: number } | null = null;
    for (const angle of which === 'x' ? [45, 90] : [90]) {
      const r = rotatedLabels(map, img, frame, which, ax, majors, angle);
      if (!best || r.score > best.score) best = r;
    }
    if (best && best.score >= 3 && best.score >= upright + 2 && best.labels.length >= 3) {
      return { ...primary, alternative: { axis: which, mode: 'ticks', labels: best.labels, note: null, rotated: true } };
    }
  }
  return primary;
}

/** Median distance of a pass's labels from their points on the axis line, image px. */
const reach = (r: AxisLabels) => median(r.labels.map((l) => Math.hypot(l.box.center.x - l.point.x, l.box.center.y - l.point.y)));

/** How upright the labels a pass found read (`uprightness`), per result. */
const UPRIGHT = new WeakMap<AxisLabels, number>();
/** The rotated readings are tried when the upright pass has fewer upright votes than this many per major tick. */
const ROTATED_ONLY_BELOW = 0.6;

/**
 * How upright the text of some words is: each body glyph votes +1 when clearly taller than wide
 * (an upright digit or letter: ≥ 1.15) and −1 when much wider than tall (a digit turned by 90°:
 * ≥ 1.5; two upright digits run together are 1.2–1.35 times wider than tall and abstain); thin
 * strokes (a "1", a turned minus sign) and squarish glyphs abstain. Words of several glyphs
 * strung along a diagonal (rotated text that the row test chained together: taller than 1.6 text
 * heights) do not vote.
 */
function uprightness(ws: LabelWord[]): number {
  let votes = 0;
  for (const wd of ws) {
    const bodies = wd.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT);
    if (bodies.length >= 2 && gh(wd) > 1.6 * wd.textHeight) continue;
    for (const g of bodies) {
      const thin = Math.min(gw(g), gh(g)) <= 2 || Math.min(gw(g), gh(g)) < 0.4 * Math.max(gw(g), gh(g));
      if (thin) continue;
      if (gh(g) >= 1.15 * gw(g)) votes++;
      else if (gw(g) >= 1.5 * gh(g)) votes--;
    }
  }
  return votes;
}

/**
 * Tick labels rotated by `angle` degrees counter-clockwise (matplotlib's `rotation`): the band
 * outside the axis is sampled in a frame turned by the same angle, so the text is upright there
 * and the usual glyph → row → word steps apply. A word belongs to the major tick its axis-side end
 * (X: rotated labels hang from their tick by that end) or its centre (Y: centred on the tick) is
 * level with. The score counts the matched words that read as upright text.
 */
function rotatedLabels(
  map: DarknessMap,
  img: RgbaImage,
  frame: Frame,
  which: 'x' | 'y',
  ax: DetectedAxis,
  majors: { t: DetectedAxis['ticks']['ticks'][number]; i: number }[],
  angle: number,
): { labels: FoundLabel[]; score: number } {
  const line = ax.line;
  const flipped = ax.position === 'top' || ax.position === 'right';
  const outsideLen = ax.ticks.side !== 'inside' ? Math.max(...majors.map(({ t }) => t.length)) : 0;
  const d0 = Math.max(line.thickness / 2, outsideLen) + 1;
  const short = Math.min(map.width, map.height);
  const margin = Math.max(20, 0.08 * (line.end - line.start));
  const maxTextHeight = Math.max(12, 0.08 * short);
  // The band in the axis frame: [u0, u1] × [w0, w1].
  const depth = which === 'x' ? Math.min(300, Math.max(60, 0.22 * short)) : Math.min(400, Math.max(40, 0.25 * map.width));
  const band =
    which === 'x'
      ? { u0: line.start - margin, u1: line.end + margin, w0: flipped ? line.offset - d0 - depth : line.offset + d0, w1: flipped ? line.offset - d0 : line.offset + d0 + depth }
      : { u0: flipped ? line.offset + d0 : line.offset - d0 - depth, u1: flipped ? line.offset + d0 + depth : line.offset - d0, w0: line.start - margin, w1: line.end + margin };
  const theta = Math.atan2(frame.sin, frame.cos) - (angle * Math.PI) / 180;
  const turned = makeFrame(theta);
  const corners = [
    [band.u0, band.w0],
    [band.u1, band.w0],
    [band.u0, band.w1],
    [band.u1, band.w1],
  ].map(([u, w]) => toFrame(turned, toImage(frame, u as number, w as number)));
  const tu0 = Math.floor(Math.min(...corners.map((c) => c.u)));
  const tw0 = Math.floor(Math.min(...corners.map((c) => c.w)));
  const q = makePatch(map, img, turned, tu0, tw0, Math.max(...corners.map((c) => c.u)) - tu0 + 1, Math.max(...corners.map((c) => c.w)) - tw0 + 1);
  // Only the band itself: the turned patch's corners reach into the plot and the other margin.
  const inBand = (i: number, j: number) => {
    const f = toFrame(frame, toImage(turned, q.u0 + i, q.w0 + j));
    return f.u >= band.u0 && f.u <= band.u1 && f.w >= band.w0 && f.w <= band.w1;
  };
  for (let j = 0; j < q.height; j++) for (let i = 0; i < q.width; i++) if (!inBand(i, j)) q.dark[j * q.width + i] = 0;
  const glyphs = components(q, inkThreshold(q)).filter((g) => glyphChroma(q, g) < MAX_LABEL_CHROMA);
  // In the turned frame every label is a line of its own: words of a row a space apart ("Nov
  // 2001") are one label.
  const all = words(q, glyphs, maxTextHeight, false).flatMap((row) => {
    const out: LabelWord[] = [];
    for (const wd of row) {
      const last = out[out.length - 1];
      if (last && wd.x0 - last.x1 - 1 <= 1.2 * Math.max(last.textHeight, wd.textHeight)) {
        out[out.length - 1] = { x0: last.x0, y0: Math.min(last.y0, wd.y0), x1: wd.x1, y1: Math.max(last.y1, wd.y1), glyphs: [...last.glyphs, ...wd.glyphs], textHeight: last.textHeight };
      } else out.push({ ...wd, glyphs: [...wd.glyphs] });
    }
    return out;
  });
  const image = (i: number, j: number) => toImage(turned, q.u0 + i, q.w0 + j);
  const alongOf = (pt: Point) => (which === 'x' ? toFrame(frame, pt).u : toFrame(frame, pt).w);
  const acrossOf = (pt: Point) => (which === 'x' ? toFrame(frame, pt).w : toFrame(frame, pt).u);
  const anchor = (wd: LabelWord) => {
    const cy = (wd.y0 + wd.y1) / 2;
    // The end nearer the axis (rotated X labels hang from it); a Y label's centre.
    if (which === 'y') return alongOf(image((wd.x0 + wd.x1) / 2, cy));
    const a = image(wd.x0, cy);
    const b = image(wd.x1, cy);
    const near = Math.abs(acrossOf(a) - line.offset) < Math.abs(acrossOf(b) - line.offset) ? a : b;
    return alongOf(near);
  };
  const reach = (wd: LabelWord) =>
    Math.min(...[image(wd.x0, wd.y0), image(wd.x1, wd.y0), image(wd.x0, wd.y1), image(wd.x1, wd.y1)].map((pt) => Math.abs(acrossOf(pt) - line.offset)));
  const used = new Set<LabelWord>();
  const labels: FoundLabel[] = [];
  for (const { t, i } of majors) {
    let pick: LabelWord | null = null;
    let pickD = Infinity;
    for (const wd of all) {
      if (used.has(wd)) continue;
      const d = Math.abs(anchor(wd) - t.along);
      if (d <= 0.5 * wd.textHeight + 2 && reach(wd) <= d0 + 3 * wd.textHeight + 4 && d < pickD) {
        pick = wd;
        pickD = d;
      }
    }
    if (!pick) continue;
    used.add(pick);
    const l = layout(pick, q);
    const bodyH = Math.max(1, l.baseline - l.baseTop + 1);
    const hasExp = l.exponent.length > 0;
    const expBodies = hasExp ? l.exponent.filter((g) => !isDash(g, bodyH)) : [];
    const expH = expBodies.length ? Math.max(...expBodies.map(gh)) : bodyH;
    const [expGlyphs, specks] = exponentParts(l.exponent, bodyH, expH);
    const bodies = pick.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT);
    labels.push({
      along: t.along,
      point: t.point,
      tick: i,
      crop: cut(q, pick.glyphs, bodyH),
      base: hasExp ? cut(q, l.base, bodyH, 0, l.exponent) : null,
      exponent: hasExp ? cut(q, expGlyphs, expH, 0, [...l.base, ...specks]) : null,
      ...(hasExp ? { exponentSmall: cut(q, expGlyphs, expH, 0, [...l.base, ...specks], EXP_REREAD_HEIGHT) } : {}),
      minus: l.minus,
      exponentMinus: hasExp && l.exponentMinus,
      singleChar: bodies.length === 1 && !hasExp && pick.x1 - pick.x0 + 1 <= 0.8 * bodyH,
      exponentSingleChar: expBodies.length === 1,
      marks: l.marks,
      runs: l.runWidths.length,
      box: { center: image((pick.x0 + pick.x1) / 2, (pick.y0 + pick.y1) / 2), width: pick.x1 - pick.x0 + 1, height: pick.y1 - pick.y0 + 1 },
    });
  }
  labels.sort((a, b) => a.along - b.along);
  return { labels, score: uprightness([...used]) };
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
  /** A colour class's hue (`colourClasses`): only its glyphs are label text; null = neutral ink. */
  hue: number | null = null,
): AxisLabels {
  const ink: Ink = hue === null ? NEUTRAL : ofHue(hue);
  const { width: W, height: H } = map;
  const line: AxisGeometry = ax.line;
  // The labels' side: below a bottom X axis / above a top one; left of a left Y axis / right of
  // a right one. "Near" = the patch edge next to the axis.
  const flipped = ax.position === 'top' || ax.position === 'right';
  // (Ticks taken from gridlines, TickSet.source 'gridlines', are 'inside': the band starts at the
  // line. Labels touching its edge there are not flagged as cut off: on the scanned c70–c73 they are
  // whole and read right, and flagging them, as labels-only axes do, lost those axes.)
  const bare = mode === 'labels-only';
  const outsideLen =
    mode === 'ticks' && ax.ticks.side !== 'inside' ? Math.max(...majors.map(({ t }) => t.length)) : 0;
  // Past the line's edge by half its thickness again: a thick scanned or hand-ruled line wobbles
  // by that much, and labels touching it must not join it into one long component.
  const d0 = Math.max(line.thickness / 2, outsideLen) + 1 + (bare ? Math.max(0, line.thickness / 2 - 1) : 0);
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
  const all = components(p, inkThreshold(p, hue));
  // The band's colour classes; in the neutral pass, a glyph of one of them is no neutral ink even
  // when its mean colour, diluted by its antialiased edge, falls under MAX_LABEL_CHROMA (a muted
  // purple label splits into "neutral" digits and coloured exponents otherwise).
  const classes = ink === NEUTRAL ? colourClasses(p, all, maxTextHeight) : [];
  const inks = classes.map(ofHue);
  const glyphs = all.filter((g) => ink(p, g) && !inks.some((c) => c(p, g)));
  // Y labels are aligned at the axis: words grow from the axis side.
  const rows = words(p, glyphs, maxTextHeight, which === 'y' && !flipped);
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

  // The ink width of the axis's wide digits (0, 2–9): runs between 0.42 and 0.95 text heights
  // (a "1" is narrower, two merged digits wider).
  const widths = chosen.flatMap(({ word }) => {
    const l = layout(word, p);
    return l.runWidths.filter((w) => w >= 0.42 * l.bodyHeight && w <= 0.95 * l.bodyHeight);
  });
  const digitWidth = widths.length >= 2 ? median(widths) : null;
  // Pieces left beside a chosen word: a word of the same row, not chosen itself, alone in its
  // column (no glyph within half a text height above or below: not a letter of a turned axis
  // title), of upright digit shapes (taller than wide), of body height like it
  // (±25 %), on its baseline (±max(1, 0.15 h)), within one character pitch of it — measured on
  // this axis's own labels (centre to centre of neighbouring glyphs; 0.7 text heights when no
  // label has two). For an X label (centred on its tick) only when the label with that piece would
  // still be centred on the tick — a neighbouring label whose tick was missed is not a piece; for a
  // Y label (aligned at the axis) only on its far side from the axis.
  const chosenSet = new Set(chosen.map((c) => c.word));
  const bodiesOf = (wd: LabelWord) => wd.glyphs.filter((g) => gh(g) >= BODY_MIN_HEIGHT).sort((a, b) => a.x0 - b.x0);
  const bodyOf = (wd: LabelWord) => Math.max(0, ...bodiesOf(wd).map(gh));
  const pitches = chosen.flatMap(({ word }) => {
    const bs = bodiesOf(word);
    return bs.slice(1).map((g, i) => (g.x0 + g.x1) / 2 - ((bs[i] as Glyph).x0 + (bs[i] as Glyph).x1) / 2);
  });
  const pitchOf = (h: number) => (pitches.length >= 2 ? Math.min(median(pitches), 1.5 * h) : 0.7 * h);
  const pieceBeside = (c: { word: LabelWord; along: number; tick: number | null }) => {
    const wd = c.word;
    const row = rows.find((r) => r.includes(wd));
    if (!row) return false;
    const h = bodyOf(wd);
    if (h < BODY_MIN_HEIGHT) return false;
    return row.some((o) => {
      if (o === wd || chosenSet.has(o)) return false;
      const ho = bodyOf(o);
      if (ho < 0.75 * h || ho > 1.25 * h || Math.abs(o.y1 - wd.y1) > Math.max(1, 0.15 * h)) return false;
      if (!bodiesOf(o).every((g) => gh(g) >= 1.1 * gw(g))) return false;
      // A letter of a turned axis title has more of the title right above or below it; a piece of
      // a tick label has nothing there (the next label is a tick spacing away).
      const column = glyphs.some(
        (g) => gh(g) >= BODY_MIN_HEIGHT && !o.glyphs.includes(g) && g.x1 >= o.x0 && g.x0 <= o.x1 && (g.y1 < o.y0 ? o.y0 - g.y1 : g.y0 - o.y1) - 1 <= 0.5 * h && (g.y1 < o.y0 || g.y0 > o.y1),
      );
      if (column) return false;
      const gap = o.x0 > wd.x1 ? o.x0 - wd.x1 - 1 : wd.x0 - o.x1 - 1;
      if (gap < 0 || gap > pitchOf(h)) return false;
      if (which === 'y') return flipped ? o.x0 > wd.x1 : o.x1 < wd.x0;
      if (c.tick === null) return false;
      const x0 = Math.min(o.x0, wd.x0);
      const x1 = Math.max(o.x1, wd.x1);
      return Math.abs(p.u0 + (x0 + x1) / 2 - c.along) <= 0.35 * h + 0.2 * (x1 - x0 + 1) + 1;
    });
  };
  const found = (word: LabelWord, q: Patch, along: number, tick: number | null, italic = false): FoundLabel => {
    const l = layout(word, q, q === p && !italic ? digitWidth : null);
    const bodyH = Math.max(1, l.baseline - l.baseTop + 1);
    const slant = italic ? slantOf(q, word.glyphs, bodyH) : 0;
    // Slanted (italic, hand-lettered) labels are read whole: their uneven glyphs often end above
    // the baseline, which is no sign of an exponent.
    const hasExp = l.exponent.length > 0 && slant === 0;
    const expBodies = hasExp ? l.exponent.filter((g) => !isDash(g, bodyH)) : [];
    const expH = expBodies.length ? Math.max(...expBodies.map(gh)) : bodyH;
    const [expGlyphs, specks] = exponentParts(l.exponent, bodyH, expH);
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
      base: hasExp ? cut(q, l.base, bodyH, slant, l.exponent) : null,
      exponent: hasExp ? cut(q, expGlyphs, expH, slant, [...l.base, ...specks]) : null,
      ...(hasExp ? { exponentSmall: cut(q, expGlyphs, expH, slant, [...l.base, ...specks], EXP_REREAD_HEIGHT) } : {}),
      minus: l.minus,
      exponentMinus: hasExp && l.exponentMinus,
      // One glyph no wider than it is tall (two touching digits make one wide component).
      singleChar: bodies.length === 1 && !hasExp && word.x1 - word.x0 + 1 <= 0.8 * bodyH,
      exponentSingleChar: expBodies.length === 1,
      marks: l.marks,
      ...(slant === 0 ? { runs: l.runWidths.length } : {}),
      box: { center, width: word.x1 - word.x0 + 1, height: word.y1 - word.y0 + 1 },
      ...(slant > 0 ? { slanted: true } : {}),
      // Only without ticks: then the band starts at the line, and a word reaching its edge was
      // written against the line. (With ticks the band starts past them; a label grazing that
      // edge is usually whole.)
      ...(bare && q === p && touchesAxisSide(word) ? { clipped: true } : {}),
    };
  };
  const touchesAxisSide = (wd: LabelWord) =>
    which === 'x' ? (flipped ? wd.y1 >= p.height - 1 : wd.y0 <= 0) : flipped ? wd.x0 <= 0 : wd.x1 >= p.width - 1;
  // A sliver of the line's own ragged edge (a thick scanned line), 1–2 px across and touching
  // the band's axis side, is no label.
  const sliver = (wd: LabelWord) => touchesAxisSide(wd) && (which === 'x' ? wd.y1 - wd.y0 + 1 : wd.x1 - wd.x0 + 1) <= 2;
  const kept = bare ? chosen.filter((c) => !sliver(c.word)) : chosen;
  const snapped: (typeof chosen[number] & { gridline?: boolean })[] = mode === 'labels-only' ? snapToGridlines(kept, line, ax.position, crossing, which === 'x' ? (wd) => wd.x1 - wd.x0 + 1 : (wd) => wd.y1 - wd.y0 + 1) : kept;
  // Italic or hand-lettered labels: most of the axis's labels are slanted. A single upright "7"
  // or "/"-like digit can look slanted on its own, so the decision is the axis's, not the word's.
  const slanted = snapped.filter(({ word }) => {
    const l = layout(word, p);
    return slantOf(p, word.glyphs, Math.max(1, l.baseline - l.baseTop + 1)) > 0;
  }).length;
  const italic = snapped.length >= 2 && slanted > 0.5 * snapped.length;
  const labels = snapped.map((c) => {
    const { word, along, tick, gridline } = c;
    const l = found(word, p, along, tick, italic);
    const marked = pieceBeside(c) ? { ...l, partial: true } : l;
    return gridline ? { ...marked, gridline } : marked;
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
      const qRows = words(q, components(q, 1.5 * INK_THRESHOLD).filter((g) => ink(q, g)), maxTextHeight, false);
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
  const result: AxisLabels = noteTangled ? { axis: which, mode, labels, note, noteTangled } : { axis: which, mode, labels, note };
  UPRIGHT.set(result, uprightness(snapped.map(({ word }) => word)));
  let mass = 0;
  for (const { word } of snapped) for (const g of word.glyphs) for (const k of g.pixels) mass += p.dark[k] ?? 0;
  MASS.set(result, mass);
  if (ink === NEUTRAL) HUES.set(result, classes);
  return result;
}

/** The summed darkness of the glyphs of the labels a pass found, per result. */
const MASS = new WeakMap<AxisLabels, number>();
/** The colour classes seen in a neutral pass's band (`colourClasses`), per result. */
const HUES = new WeakMap<AxisLabels, number[]>();

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
