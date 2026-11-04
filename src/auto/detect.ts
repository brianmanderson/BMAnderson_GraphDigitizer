/**
 * Axis detection: image → skew → line candidates → the X/Y axis pair → plot box → ticks.
 *
 * Skew. The Hough estimate (skew.ts) is refined once from the slopes of the longest fitted lines
 * (lines.ts → residualTilt; the median over up to four lines, so one line with a bar or legend
 * touching it cannot tilt the frame), and the lines are found again in the refined frame. A thick line
 * can only pin the Hough angle to within its thickness over its length; the fit does better.
 *
 * Choosing the pair. Every strong horizontal candidate is paired with every strong vertical
 * one. A pair is plausible when the lines actually meet and the plot lies above the horizontal
 * one and right of the vertical one: an "L" corner (axes at the plot edge) or a cross (axes
 * through the data, e.g. at zero). That rules out the other corners of a box frame. Plausible
 * pairs are ranked by line strength, by how much of each line runs into the plot, and by tick
 * evidence, so a frame's bottom-left corner beats a gridline crossing and an axis with tick
 * marks beats a long line of data.
 *
 * Corner or cross is decided by how far the line continues *unbroken* past the other axis (the
 * candidate runs bridge small gaps, so a tick label written right up to the corner would
 * otherwise look like a continuation of the axis).
 *
 * The plot box is the axes' corner extended to the far ends of the axis lines, or to the frame's
 * top/right lines when a box frame is drawn (a parallel line of similar darkness at that end).
 */

import { darknessMap, INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, makeFrame, toImage, type Frame } from './frame.ts';
import { findLines, median, residualTilt, type Family, type FoundLine } from './lines.ts';
import { estimateSkew } from './skew.ts';
import { defaultTickOptions, detectTicks, type TickOptions } from './ticks.ts';
import type { AxisDetection, DetectedAxis, LineCandidate, PlotBox, RgbaImage, TickSet } from './types.ts';

const TOP_CANDIDATES = 8;
const STRONG_FRACTION = 0.25;
/** Below this refinement an unrotated (θ = 0) estimate is kept exactly 0. */
const MIN_TILT_FROM_ZERO = (0.05 * Math.PI) / 180;
/** A frame line must be at least this dark relative to the axis line it continues. */
const FRAME_CONTRAST = 0.6;

interface Pair {
  h: FoundLine;
  v: FoundLine;
  score: number;
  /** Whether the axis lines meet at the plot's corner (true) or cross inside it. */
  cornerX: boolean;
  cornerY: boolean;
}

function tickCache(map: DarknessMap, frame: Frame, opts: TickOptions) {
  const cache = new Map<LineCandidate, TickSet>();
  return (line: LineCandidate): TickSet => {
    let t = cache.get(line);
    if (!t) {
      // Outside = below the X axis (+offset), left of the Y axis (−offset).
      t = detectTicks(map, frame, line, line.family === 'horizontal' ? 1 : -1, opts);
      cache.set(line, t);
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
      if (rightExt < 0.3 * hLen || upExt < 0.3 * vLen) continue;
      const tx = ticksOf(h).confidence;
      const ty = ticksOf(v).confidence;
      const score =
        h.strength / hMax + v.strength / vMax + 0.5 * (rightExt / hLen + upExt / vLen) + 0.6 * (tx + ty);
      if (!best || score > best.score) {
        best = {
          h,
          v,
          score,
          cornerX: leftExt <= meetTol || unbroken(map, frame, h, v.offset - v.thickness / 2 - 1, -1) <= meetTol,
          cornerY: downExt <= meetTol || unbroken(map, frame, v, h.offset + h.thickness / 2 + 1, 1) <= meetTol,
        };
      }
    }
  }

  if (!best) {
    // No plausible pair: report the strongest single lines with low confidence (Phase 5 can fall
    // back to manual calibration with them pre-filled, or ignore them).
    const h = hs[0];
    const v = vs[0];
    if (h) result.xAxis = { line: plain(h), confidence: 0.2 * (h.strength / hMax), ticks: ticksOf(h) };
    if (v) result.yAxis = { line: plain(v), confidence: 0.2 * (v.strength / vMax), ticks: ticksOf(v) };
    return result;
  }

  const { h, v } = best;
  result.xAxis = axis(h, ticksOf(h), best, width);
  result.yAxis = axis(v, ticksOf(v), best, height);
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

function axis(line: FoundLine, ticks: TickSet, pair: Pair, extent: number): DetectedAxis {
  const lengthTerm = Math.min(1, line.length / (0.5 * extent));
  const contrastTerm = Math.min(1, line.contrast / 100);
  const confidence = Math.min(1, 0.3 + 0.3 * lengthTerm + 0.2 * contrastTerm + 0.2 * Math.min(1, pair.score / 4));
  return { line: plain(line), confidence, ticks };
}

function plotBox(frame: Frame, pair: Pair, hs: FoundLine[], vs: FoundLine[], tol: number): PlotBox {
  const { h, v } = pair;
  const left = pair.cornerX ? v.offset : h.start;
  const bottom = pair.cornerY ? h.offset : v.end;
  let right = h.end;
  let top = v.start;
  // A box frame: a vertical line at the X axis's far end and a horizontal one at the Y axis's top,
  // about as dark as the axes (a gridline near the end is lighter).
  const rightLine = vs.find(
    (c) =>
      c !== v &&
      c.contrast >= FRAME_CONTRAST * v.contrast &&
      Math.abs(c.offset - h.end) <= tol &&
      c.start <= top + tol &&
      c.end >= bottom - tol,
  );
  const topLine = hs.find(
    (c) =>
      c !== h &&
      c.contrast >= FRAME_CONTRAST * h.contrast &&
      Math.abs(c.offset - v.start) <= tol &&
      c.start <= left + tol &&
      c.end >= right - tol,
  );
  if (rightLine) right = rightLine.offset;
  if (topLine) top = topLine.offset;
  return {
    topLeft: toImage(frame, left, top),
    topRight: toImage(frame, right, top),
    bottomRight: toImage(frame, right, bottom),
    bottomLeft: toImage(frame, left, bottom),
    framed: { top: !!topLine, right: !!rightLine },
  };
}
