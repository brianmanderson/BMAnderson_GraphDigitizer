/**
 * Axis detection: image → skew → line candidates → the X/Y axis pair → plot box → ticks.
 *
 * Skew. The Hough estimate (skew.ts) is refined once from the slopes of the longest fitted lines
 * (lines.ts → residualTilt; the median over up to four lines, so one line with a bar or legend
 * touching it cannot tilt the frame), and the lines are found again in the refined frame. A thick line
 * can only pin the Hough angle to within its thickness over its length; the fit does better.
 *
 * Choosing the pair. Every strong horizontal candidate is paired with every strong vertical
 * one, in each of the four corner orientations (the X axis at the plot's bottom or top, the Y axis
 * at its left or right). A pair is plausible when the lines actually meet and the plot lies on
 * the chosen side of each: an "L" corner (axes at the plot edge) or a cross (axes through the
 * data, e.g. at zero). Plausible pairs are ranked by line strength, by how much of each line runs
 * into the plot, and by tick evidence, so a frame's bottom-left corner beats a gridline crossing
 * and an axis with tick marks beats a long line of data.
 *
 * Bottom-left is the default. An X axis at the top (a "Γ" frame) or a Y axis at the right is
 * accepted only when (a) that axis ends at the corner — a cross keeps the default orientation,
 * since the labels of axes through zero sit below/left of them — (b) it carries a tick pattern
 * (confidence ≥ MOVED_MIN_TICKS), and (c) after a fixed handicap per moved axis (MOVED_PENALTY).
 * So a frame with ticks on every side keeps its bottom-left corner, while a box frame whose
 * only X ticks are on the top line, or a Γ with no bottom line at all, gets the top axis.
 *
 * Corner or cross is decided by how far the line continues *unbroken* past the other axis (the
 * candidate runs bridge small gaps, so a tick label written right up to the corner would
 * otherwise look like a continuation of the axis).
 *
 * The plot box is the axes' corner extended to the far ends of the axis lines, or to the frame's
 * opposite lines when a box frame is drawn (a parallel line of similar darkness at that end).
 */

import { darknessMap, INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, makeFrame, toImage, type Frame } from './frame.ts';
import { findLines, median, residualTilt, type Family, type FoundLine } from './lines.ts';
import { estimateSkew } from './skew.ts';
import { defaultTickOptions, detectTicks, type TickOptions } from './ticks.ts';
import type { AxisDetection, AxisPosition, DetectedAxis, LineCandidate, PlotBox, RgbaImage, TickSet } from './types.ts';

const TOP_CANDIDATES = 8;
const STRONG_FRACTION = 0.25;
/** Below this refinement an unrotated (θ = 0) estimate is kept exactly 0. */
const MIN_TILT_FROM_ZERO = (0.05 * Math.PI) / 180;
/** A frame line must be at least this dark relative to the axis line it continues. */
const FRAME_CONTRAST = 0.6;
/** Score handicap for each axis not in its default place (X at the top, Y at the right). */
const MOVED_PENALTY = 0.25;
/** An axis not in its default place needs at least this tick confidence. */
const MOVED_MIN_TICKS = 0.3;

/**
 * Where the axes sit on the plot: `xSide` +1 = X axis at the bottom (plot above it), −1 = at the
 * top; `ySide` +1 = Y axis at the left (plot right of it), −1 = at the right.
 */
interface Orientation {
  xSide: 1 | -1;
  ySide: 1 | -1;
}

/** Default first: the no-pair fallback and every tie use it. */
const ORIENTATIONS: Orientation[] = [
  { xSide: 1, ySide: 1 },
  { xSide: -1, ySide: 1 },
  { xSide: 1, ySide: -1 },
  { xSide: -1, ySide: -1 },
];

/**
 * Offset direction away from the plot across an axis line: +1 below a bottom X axis, −1 above a
 * top one; −1 left of a left Y axis, +1 right of a right one.
 */
function outside(family: Family, o: Orientation): 1 | -1 {
  if (family === 'horizontal') return o.xSide;
  return o.ySide === 1 ? -1 : 1;
}

interface Pair {
  h: FoundLine;
  v: FoundLine;
  o: Orientation;
  score: number;
  /** Whether the axis lines meet at the plot's corner (true) or cross inside it. */
  cornerX: boolean;
  cornerY: boolean;
}

function tickCache(map: DarknessMap, frame: Frame, opts: TickOptions) {
  const cache = new Map<LineCandidate, Map<number, TickSet>>();
  return (line: LineCandidate, outsideSign: 1 | -1): TickSet => {
    let bySign = cache.get(line);
    if (!bySign) {
      bySign = new Map();
      cache.set(line, bySign);
    }
    let t = bySign.get(outsideSign);
    if (!t) {
      t = detectTicks(map, frame, line, outsideSign, opts);
      bySign.set(outsideSign, t);
    }
    return t;
  };
}

export function detectAxes(img: RgbaImage): AxisDetection {
  return detectAxesInMap(darknessMap(img));
}

/** Median tilt of the two longest lines of each family, or 0. */
function refinement(horizontal: FoundLine[], vertical: FoundLine[], width: number, height: number): number {
  const tilts: number[] = [];
  const take = (lines: FoundLine[], family: Family, extent: number) => {
    const long = [...lines].filter((l) => l.length >= 0.3 * extent).sort((a, b) => b.length - a.length);
    for (const l of long.slice(0, 2)) {
      const d = l.fit ? residualTilt(family, l.fit) : null;
      if (d !== null) tilts.push(d);
    }
  };
  take(horizontal, 'horizontal', width);
  take(vertical, 'vertical', height);
  return tilts.length ? median(tilts) : 0;
}

export function detectAxesInMap(map: DarknessMap): AxisDetection {
  const { width, height } = map;
  let theta = estimateSkew(map).theta;
  let frame = makeFrame(theta);
  let horizontal = findLines(map, frame, 'horizontal');
  let vertical = findLines(map, frame, 'vertical');
  const delta = refinement(horizontal, vertical, width, height);
  if ((theta !== 0 && Math.abs(delta) > 1e-5) || Math.abs(delta) > MIN_TILT_FROM_ZERO) {
    theta += delta;
    frame = makeFrame(theta);
    horizontal = findLines(map, frame, 'horizontal');
    vertical = findLines(map, frame, 'vertical');
  }

  const opts = defaultTickOptions(width, height);
  const ticksOf = tickCache(map, frame, opts);
  const result: AxisDetection = {
    width,
    height,
    skewDegrees: (theta * 180) / Math.PI,
    xAxis: null,
    yAxis: null,
    plotBox: null,
    candidates: {
      horizontal: horizontal.slice(0, TOP_CANDIDATES).map(plain),
      vertical: vertical.slice(0, TOP_CANDIDATES).map(plain),
    },
  };
  const hs = strongest(horizontal);
  const vs = strongest(vertical);
  const hMax = hs[0]?.strength ?? 1;
  const vMax = vs[0]?.strength ?? 1;
  const meetTol = 3 + opts.maxTickLength;

  let best: Pair | null = null;
  for (const h of hs) {
    for (const v of vs) {
      // Intersection in the frame: u = v.offset (along h), w = h.offset (along v).
      const leftExt = v.offset - h.start;
      const rightExt = h.end - v.offset;
      const upExt = h.offset - v.start;
      const downExt = v.end - h.offset;
      if (leftExt < -meetTol || rightExt < -meetTol || upExt < -meetTol || downExt < -meetTol) continue;
      const hLen = Math.max(1, h.length);
      const vLen = Math.max(1, v.length);
      // Whether each line stops at the other on a given side (else it continues past: a cross).
      const hEndsLeft = () => leftExt <= meetTol || unbroken(map, frame, h, v.offset - v.thickness / 2 - 1, -1) <= meetTol;
      const hEndsRight = () => rightExt <= meetTol || unbroken(map, frame, h, v.offset + v.thickness / 2 + 1, 1) <= meetTol;
      const vEndsBelow = () => downExt <= meetTol || unbroken(map, frame, v, h.offset + h.thickness / 2 + 1, 1) <= meetTol;
      const vEndsAbove = () => upExt <= meetTol || unbroken(map, frame, v, h.offset - h.thickness / 2 - 1, -1) <= meetTol;
      for (const o of ORIENTATIONS) {
        const intoX = o.ySide === 1 ? rightExt : leftExt;
        const intoY = o.xSide === 1 ? upExt : downExt;
        if (intoX < 0.3 * hLen || intoY < 0.3 * vLen) continue;
        const tx = ticksOf(h, outside('horizontal', o)).confidence;
        const ty = ticksOf(v, outside('vertical', o)).confidence;
        let moved = 0;
        if (o.xSide === -1) {
          if (tx < MOVED_MIN_TICKS || !vEndsAbove()) continue;
          moved++;
        }
        if (o.ySide === -1) {
          if (ty < MOVED_MIN_TICKS || !hEndsRight()) continue;
          moved++;
        }
        const score =
          h.strength / hMax + v.strength / vMax + 0.5 * (intoX / hLen + intoY / vLen) + 0.6 * (tx + ty) - MOVED_PENALTY * moved;
        if (!best || score > best.score) {
          best = {
            h,
            v,
            o,
            score,
            cornerX: o.ySide === 1 ? hEndsLeft() : hEndsRight(),
            cornerY: o.xSide === 1 ? vEndsBelow() : vEndsAbove(),
          };
        }
      }
    }
  }

  const o0 = ORIENTATIONS[0] as Orientation;
  if (!best) {
    // No plausible pair: report the strongest single lines with low confidence (Phase 5 can fall
    // back to manual calibration with them pre-filled, or ignore them).
    const h = hs[0];
    const v = vs[0];
    if (h) result.xAxis = { line: plain(h), position: 'bottom', confidence: 0.2 * (h.strength / hMax), ticks: ticksOf(h, outside('horizontal', o0)) };
    if (v) result.yAxis = { line: plain(v), position: 'left', confidence: 0.2 * (v.strength / vMax), ticks: ticksOf(v, outside('vertical', o0)) };
    return result;
  }

  const { h, v, o } = best;
  result.xAxis = axis(h, o.xSide === 1 ? 'bottom' : 'top', ticksOf(h, outside('horizontal', o)), best, width);
  result.yAxis = axis(v, o.ySide === 1 ? 'left' : 'right', ticksOf(v, outside('vertical', o)), best, height);
  result.plotBox = plotBox(frame, best, hs, vs, meetTol);
  return result;
}

/** Length of the gap-free ink run along `line` from `from` in direction `dir`. */
function unbroken(map: DarknessMap, frame: Frame, line: FoundLine, from: number, dir: 1 | -1): number {
  let n = 0;
  for (let t = from; dir < 0 ? t >= line.start - 1 : t <= line.end + 1; t += dir) {
    const p = familyPoint(frame, line.family, t, line.offset);
    if (sample(map, p.x, p.y) < INK_THRESHOLD) break;
    n++;
  }
  return n;
}

/** The public candidate without the detector's per-pixel fit samples. */
function plain(l: FoundLine): LineCandidate {
  const { family, offset, start, end, p1, p2, length, contrast, thickness, strength } = l;
  return { family, offset, start, end, p1, p2, length, contrast, thickness, strength };
}

function strongest(lines: FoundLine[]): FoundLine[] {
  const max = lines[0]?.strength ?? 0;
  return lines.filter((l) => l.strength >= STRONG_FRACTION * max).slice(0, TOP_CANDIDATES);
}

function axis(line: FoundLine, position: AxisPosition, ticks: TickSet, pair: Pair, extent: number): DetectedAxis {
  const lengthTerm = Math.min(1, line.length / (0.5 * extent));
  const contrastTerm = Math.min(1, line.contrast / 100);
  const confidence = Math.min(1, 0.3 + 0.3 * lengthTerm + 0.2 * contrastTerm + 0.2 * Math.min(1, pair.score / 4));
  return { line: plain(line), position, confidence, ticks };
}

function plotBox(frame: Frame, pair: Pair, hs: FoundLine[], vs: FoundLine[], tol: number): PlotBox {
  const { h, v, o } = pair;
  // Along u (the X axis): from the corner (or, past a cross, the X axis's own end) to the far end.
  const nearU = pair.cornerX ? v.offset : o.ySide === 1 ? h.start : h.end;
  const farEndU = o.ySide === 1 ? h.end : h.start;
  // Along w (the Y axis): the far end is its top (X axis at the bottom) or its bottom.
  const nearW = pair.cornerY ? h.offset : o.xSide === 1 ? v.end : v.start;
  const farEndW = o.xSide === 1 ? v.start : v.end;
  const uLo = Math.min(nearU, farEndU);
  const uHi = Math.max(nearU, farEndU);
  const wLo = Math.min(nearW, farEndW);
  const wHi = Math.max(nearW, farEndW);
  // A box frame: a vertical line at the X axis's far end and a horizontal one at the Y axis's far
  // end, about as dark as the axes (a gridline near the end is lighter), spanning the box.
  const farV = vs.find(
    (c) =>
      c !== v &&
      c.contrast >= FRAME_CONTRAST * v.contrast &&
      Math.abs(c.offset - farEndU) <= tol &&
      c.start <= wLo + tol &&
      c.end >= wHi - tol,
  );
  const farH = hs.find(
    (c) =>
      c !== h &&
      c.contrast >= FRAME_CONTRAST * h.contrast &&
      Math.abs(c.offset - farEndW) <= tol &&
      c.start <= uLo + tol &&
      c.end >= uHi - tol,
  );
  const farU = farV ? farV.offset : farEndU;
  const farW = farH ? farH.offset : farEndW;
  const left = Math.min(nearU, farU);
  const right = Math.max(nearU, farU);
  const top = Math.min(nearW, farW);
  const bottom = Math.max(nearW, farW);
  return {
    topLeft: toImage(frame, left, top),
    topRight: toImage(frame, right, top),
    bottomRight: toImage(frame, right, bottom),
    bottomLeft: toImage(frame, left, bottom),
    framed: {
      top: !!farH && o.xSide === 1,
      right: !!farV && o.ySide === 1,
      bottom: !!farH && o.xSide === -1,
      left: !!farV && o.ySide === -1,
    },
  };
}
