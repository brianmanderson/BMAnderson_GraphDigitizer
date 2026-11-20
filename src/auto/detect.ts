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
 *
 * Charts without axis lines (SPEC → Charts without axis lines). Two other sources give the plot
 * area when the pair above is missing or is not what it seems:
 *  - a filled panel (panel.ts): when there is no pair, or the pair's lines both lie on the panel
 *    without being its edges (gridlines or data on a ggplot-style panel), the panel's bottom and
 *    left edges are the axes. A pair that encloses the filled area (a shaded region inside an
 *    ordinary plot) or sits on the panel's edges (a frame around it) stays.
 *  - a grid (grid.ts): when there is no pair, or one of the pair's lines is just one of the grid's
 *    own evenly spaced lines inside it (a crossing of two gridlines looks like an axis corner
 *    with perfect ticks), the plot area is where the gridlines end.
 * An axis from either is `virtual` unless a found line runs along that edge (an Excel chart's X
 * axis line, the frame of a seaborn "whitegrid" chart).
 *
 * Gridlines as ticks. An axis on which no tick marks were found takes its tick positions from
 * the gridlines that cross the plot box, when they form a pattern (`TickSet.source`).
 */

import { darknessMap, INK_THRESHOLD, sample, type DarknessMap } from './darkness.ts';
import { familyPoint, makeFrame, toImage, type Frame } from './frame.ts';
import { frameGray, gridBox, gridlineTicks, ridgeReach, type GrayGrid, type GridBox, type GridLine } from './grid.ts';
import { findLines, median, residualTilt, type Family, type FoundLine } from './lines.ts';
import { findPanel, type Panel } from './panel.ts';
import { estimateSkew } from './skew.ts';
import { analyseMarks, defaultTickOptions, detectTicks, scanSide, type TickOptions } from './ticks.ts';
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
 * The frame line opposite a moved axis counts when it is at least this dark relative to it: a
 * 1-px line straddling two pixel rows shows half the contrast of the same line on one row.
 */
const OPPOSITE_CONTRAST = 0.3;
/**
 * Range frame: the largest gap between a detached axis line and the other axis, as a fraction of its
 * length (an outward offset of up to ~20 pt plus ~10 % padding of the range on a small plot).
 */
const DETACHED_MAX_GAP = 0.25;
/** Range frame: both detached axis lines need at least this tick confidence. */
const DETACHED_MIN_TICKS = 0.3;
/** Range frame: score handicap of a pair whose lines do not meet. */
const DETACHED_PENALTY = 0.25;

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
  /** A range frame: the lines stop short of each other; the corner is where they would meet. */
  detached: boolean;
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
      const hLen = Math.max(1, h.length);
      const vLen = Math.max(1, v.length);
      if (rightExt < -meetTol || upExt < -meetTol) continue;
      // A range frame: the X axis starts right of the Y axis and/or the Y axis ends above the X
      // axis, by a short gap; the lines would meet if extended (bottom-left only, see below).
      const detached = leftExt < -meetTol || downExt < -meetTol;
      if (detached && (leftExt < -DETACHED_MAX_GAP * hLen || downExt < -DETACHED_MAX_GAP * vLen)) continue;
      // Whether each line stops at the other on a given side (else it continues past: a cross).
      const hEndsLeft = () => leftExt <= meetTol || unbroken(map, frame, h, v.offset - v.thickness / 2 - 1, -1) <= meetTol;
      const hEndsRight = () => rightExt <= meetTol || unbroken(map, frame, h, v.offset + v.thickness / 2 + 1, 1) <= meetTol;
      const vEndsBelow = () => downExt <= meetTol || unbroken(map, frame, v, h.offset + h.thickness / 2 + 1, 1) <= meetTol;
      const vEndsAbove = () => upExt <= meetTol || unbroken(map, frame, v, h.offset - h.thickness / 2 - 1, -1) <= meetTol;
      // A gridline inside a frame: the other axis runs on past it to a frame line of similar
      // darkness that spans the same plot, so that frame line, not this one, is the axis.
      const vFramed = (o: Orientation) =>
        !(o.ySide === 1 ? hEndsLeft() : hEndsRight()) &&
        vs.some(
          (c) =>
            c !== v &&
            c.contrast >= FRAME_CONTRAST * v.contrast &&
            (o.ySide === 1 ? c.offset < v.offset && Math.abs(c.offset - h.start) <= meetTol : c.offset > v.offset && Math.abs(c.offset - h.end) <= meetTol) &&
            (o.xSide === 1 ? c.start <= v.start + meetTol && c.end >= h.offset - meetTol : c.start <= h.offset + meetTol && c.end >= v.end - meetTol),
        );
      const hFramed = (o: Orientation) =>
        !(o.xSide === 1 ? vEndsBelow() : vEndsAbove()) &&
        hs.some(
          (c) =>
            c !== h &&
            c.contrast >= FRAME_CONTRAST * h.contrast &&
            (o.xSide === 1 ? c.offset > h.offset && Math.abs(c.offset - v.end) <= meetTol : c.offset < h.offset && Math.abs(c.offset - v.start) <= meetTol) &&
            (o.ySide === 1 ? c.start <= v.offset + meetTol && c.end >= h.end - meetTol : c.start <= h.start + meetTol && c.end >= v.offset - meetTol),
        );
      // A frame with ticks on every side keeps its bottom-left corner: the frame line opposite a
      // moved axis (at the crossing axis's other end, spanning the same plot, of similar darkness)
      // carries a tick pattern too. Without this the strength term decides, and of two equal frame
      // lines the one that happens to lie on a pixel row is "stronger" than its antialiased twin.
      const defaultSideTicked = (moved: FoundLine, family: FoundLine[], at: number, kind: Family) =>
        family.some(
          (c) =>
            c !== moved &&
            Math.abs(c.offset - at) <= meetTol &&
            c.contrast >= OPPOSITE_CONTRAST * moved.contrast &&
            c.start <= moved.start + meetTol &&
            c.end >= moved.end - meetTol &&
            ticksOf(c, outside(kind, ORIENTATIONS[0] as Orientation)).confidence >= MOVED_MIN_TICKS,
        );
      if (detached) {
        // Only in the default orientation; the line that does reach the other must end there
        // (not run on past it: that is no range frame), and both must carry a tick pattern.
        const o = ORIENTATIONS[0] as Orientation;
        if (leftExt >= -meetTol && !hEndsLeft()) continue;
        if (downExt >= -meetTol && !vEndsBelow()) continue;
        const tx = ticksOf(h, outside('horizontal', o)).confidence;
        const ty = ticksOf(v, outside('vertical', o)).confidence;
        if (tx < DETACHED_MIN_TICKS || ty < DETACHED_MIN_TICKS) continue;
        const score =
          h.strength / hMax + v.strength / vMax + 0.5 * (Math.min(1, rightExt / hLen) + Math.min(1, upExt / vLen)) + 0.6 * (tx + ty) - DETACHED_PENALTY;
        if (!best || score > best.score) best = { h, v, o, score, cornerX: true, cornerY: true, detached: true };
        continue;
      }
      for (const o of ORIENTATIONS) {
        const intoX = o.ySide === 1 ? rightExt : leftExt;
        const intoY = o.xSide === 1 ? upExt : downExt;
        if (intoX < 0.3 * hLen || intoY < 0.3 * vLen) continue;
        if (vFramed(o) || hFramed(o)) continue;
        const tx = ticksOf(h, outside('horizontal', o)).confidence;
        const ty = ticksOf(v, outside('vertical', o)).confidence;
        let moved = 0;
        if (o.xSide === -1) {
          if (tx < MOVED_MIN_TICKS || !vEndsAbove() || defaultSideTicked(h, hs, v.end, 'horizontal')) continue;
          moved++;
        }
        if (o.ySide === -1) {
          if (ty < MOVED_MIN_TICKS || !hEndsRight() || defaultSideTicked(v, vs, h.start, 'vertical')) continue;
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
            detached: false,
          };
        }
      }
    }
  }

  const o0 = ORIENTATIONS[0] as Orientation;
  const grid = frameGray(map, frame);
  const reach = ridgeReach(width, height);
  // The plot area from a filled panel or from the gridlines, when the pair is missing or bogus.
  let area: Area | null = null;
  if (grid) {
    const panel = findPanel(grid);
    if (panel && panelDecides(panel, best)) {
      area = { ...panel, kind: 'panel', contrast: Math.abs(panel.level - panel.background), lone: null, axisH: null, axisV: null };
    } else if (!best || !best.detached) {
      const g = gridBox(grid, reach);
      if (g && gridDecides(g, best)) {
        const lone = g.horizontal.length && g.vertical.length ? null : g.horizontal.length ? 'horizontal' : 'vertical';
        area = { ...g, kind: 'grid', contrast: medianContrast(g), lone };
      }
    }
  }
  if (area) {
    const a: Area = area;
    const tickOpts: TickOptions = { ...opts, startGap: Math.max(2, Math.round(0.006 * Math.min(width, height))) };
    const lineAt = (family: Family, at: number, from: number, to: number, contrast: number, thickness: number): FoundLine => ({
      family,
      offset: at,
      start: from,
      end: to,
      p1: familyPoint(frame, family, from, at),
      p2: familyPoint(frame, family, to, at),
      length: to - from,
      contrast,
      thickness,
      strength: ((to - from) * contrast) / 255,
      fit: null,
    });
    // The axis along one edge of the area, or along an axis line through it (`inner`): a found
    // line that runs there is the axis line, the pair's own first; otherwise the edge itself
    // (virtual), or the line as the ridges show it.
    const edge = (family: Family, lines: FoundLine[], pairLine: FoundLine | null, at: number, inner: GridLine | null) => {
      const [from, to] = family === 'horizontal' ? [a.left, a.right] : [a.top, a.bottom];
      const along = (c: FoundLine) =>
        Math.abs(c.offset - at) <= EDGE_TOL + c.thickness / 2 && c.start <= from + 0.1 * (to - from) && c.end >= to - 0.1 * (to - from);
      const drawn = pairLine && along(pairLine) ? pairLine : lines.find(along);
      if (drawn) return { line: drawn, virtual: false };
      if (inner) return { line: lineAt(family, at, from, to, inner.contrast, inner.mass / Math.max(1, inner.contrast)), virtual: false };
      return { line: lineAt(family, at, from, to, a.contrast, 0), virtual: true };
    };
    // An axis is at the top / right when the pair had it there on a panel's edge (not on a grid:
    // its crossing lines make any of its lines look like a ticked axis) — or when a line is drawn
    // along that edge, none along the default one, and nothing is written beyond the default one
    // (a "Γ" frame over a grid, its tick labels above the top line).
    const onEdge = (line: FoundLine, at: number) => Math.abs(line.offset - at) <= EDGE_TOL + line.thickness / 2;
    const drawnAlong = (lines: FoundLine[], at: number, from: number, to: number) =>
      lines.some((c) => onEdge(c, at) && c.start <= from + 0.1 * (to - from) && c.end >= to - 0.1 * (to - from));
    // An axis line through the grid (an Excel chart's X axis at zero) is the axis when nothing is
    // written beyond the plot's edge on that side: the tick labels then sit along that line (below
    // it / left of it: the default sides).
    const nothingBelow = !inkBeyond(map, frame, a, 'horizontal');
    const nothingLeft = !inkBeyond(map, frame, a, 'vertical');
    const innerX = nothingBelow ? a.axisH : null;
    const innerY = nothingLeft ? a.axisV : null;
    const xMoved =
      !innerX &&
      ((a.kind === 'panel' && !!best && best.o.xSide === -1 && onEdge(best.h, a.top)) ||
        (nothingBelow && drawnAlong(horizontal, a.top, a.left, a.right) && !drawnAlong(horizontal, a.bottom, a.left, a.right)));
    const yMoved =
      !innerY &&
      ((a.kind === 'panel' && !!best && best.o.ySide === -1 && onEdge(best.v, a.right)) ||
        (nothingLeft && drawnAlong(vertical, a.right, a.top, a.bottom) && !drawnAlong(vertical, a.left, a.top, a.bottom)));
    const o: Orientation = { xSide: xMoved ? -1 : 1, ySide: yMoved ? -1 : 1 };
    const x = edge('horizontal', horizontal, best?.h ?? null, innerX?.offset ?? (xMoved ? a.top : a.bottom), innerX);
    const y = edge('vertical', vertical, best?.v ?? null, innerY?.offset ?? (yMoved ? a.right : a.left), innerY);
    // The box: the area's edges, or the drawn line along each.
    const rect: Rect = { left: a.left, right: a.right, top: a.top, bottom: a.bottom };
    if (!innerX && !x.virtual) rect[xMoved ? 'top' : 'bottom'] = x.line.offset;
    if (!innerY && !y.virtual) rect[yMoved ? 'right' : 'left'] = y.line.offset;
    const make = (e: { line: FoundLine; virtual: boolean }, family: Family, position: AxisPosition): DetectedAxis => {
      // Without a drawn line only marks pointing away from the plot are ticks: just inside a
      // filled panel's edge the darkness map shows the edge's own faint halo.
      const marks = e.virtual
        ? analyseMarks(frame, e.line, scanSide(map, frame, e.line, outside(family, o), tickOpts), 'outside')
        : ticksOf(e.line, outside(family, o));
      // A grid of one family: its outermost lines are tick positions, not known plot edges.
      const edgeLines = a.lone !== null && a.lone !== family;
      const t = withGridlines(grid, frame, clip(e.line, rect), marks, rect, reach, edgeLines);
      const confidence = Math.min(1, (a.kind === 'panel' ? 0.6 : 0.5) + 0.3 * t.confidence);
      return e.virtual ? { line: plain(e.line), position, confidence, ticks: t, virtual: true } : { line: plain(e.line), position, confidence, ticks: t };
    };
    result.xAxis = make(x, 'horizontal', xMoved ? 'top' : 'bottom');
    result.yAxis = make(y, 'vertical', yMoved ? 'right' : 'left');
    const framed = a.kind === 'panel';
    result.plotBox = boxOf(frame, rect, { top: framed && !xMoved, right: framed && !yMoved, bottom: framed && xMoved, left: framed && yMoved });
    return result;
  }

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
  const { box, rect } = plotBox(frame, best, hs, vs, meetTol);
  result.xAxis = axis(h, o.xSide === 1 ? 'bottom' : 'top', withGridlines(grid, frame, clip(h, rect), ticksOf(h, outside('horizontal', o)), rect, reach), best, width);
  result.yAxis = axis(v, o.ySide === 1 ? 'left' : 'right', withGridlines(grid, frame, clip(v, rect), ticksOf(v, outside('vertical', o)), rect, reach), best, height);
  result.plotBox = box;
  return result;
}

/** The plot box in frame coordinates. */
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * A plot area found without an axis pair: a filled panel or the extent of a grid. `lone` = the
 * grid has lines of this family only; `axisH` / `axisV` = an axis line through the grid.
 */
type Area = Rect & { kind: 'panel' | 'grid'; contrast: number; lone: Family | null; axisH: GridLine | null; axisV: GridLine | null };

/** A line runs along an edge of a panel or grid when its centre is within this (plus half its thickness), px. */
const EDGE_TOL = 3;
/** Tick labels are looked for within this share of the image's short side beyond a plot edge (at least 14 px). */
const LABEL_BAND = 0.07;
/** Fewer than this share of the positions along an edge with ink beyond it: nothing is written there. */
const LABEL_INK = 0.03;

/** `line` limited to the plot box along its length (an axis through zero runs on past it). */
function clip(line: FoundLine, rect: Rect): FoundLine {
  const [lo, hi] = line.family === 'horizontal' ? [rect.left, rect.right] : [rect.top, rect.bottom];
  return { ...line, start: Math.max(line.start, lo), end: Math.min(line.end, hi) };
}

/** `ticks`, or — when the axis shows no tick marks — the gridlines crossing the plot, if any. */
function withGridlines(grid: GrayGrid | null, frame: Frame, line: FoundLine, ticks: TickSet, rect: Rect, reach: number, edgeLines = false): TickSet {
  if (!grid || ticks.ticks.length) return ticks;
  const [lo, hi] = line.family === 'horizontal' ? [rect.top, rect.bottom] : [rect.left, rect.right];
  const fromGrid = gridlineTicks(grid, frame, line, lo, hi, reach, edgeLines);
  return fromGrid ? { ...fromGrid, rejected: ticks.rejected } : ticks;
}

/**
 * Whether anything is written just beyond the plot area on the labels' default side: below its
 * bottom edge (`horizontal`: the X axis's labels) or left of its left edge.
 */
function inkBeyond(map: DarknessMap, frame: Frame, r: Rect, family: Family): boolean {
  const depth = Math.max(14, Math.round(LABEL_BAND * Math.min(map.width, map.height)));
  const [from, to] = family === 'horizontal' ? [r.left, r.right] : [r.top, r.bottom];
  let inked = 0;
  let total = 0;
  for (let t = Math.ceil(from); t <= to; t++) {
    total++;
    for (let k = 3; k <= depth; k++) {
      const p = family === 'horizontal' ? toImage(frame, t, r.bottom + k) : toImage(frame, r.left - k, t);
      if (sample(map, p.x, p.y) >= INK_THRESHOLD) {
        inked++;
        break;
      }
    }
  }
  return inked >= LABEL_INK * Math.max(1, total);
}

/**
 * Whether a filled panel, not the pair, gives the axes: there is no pair, or both of its lines lie
 * on the panel (not outside it: a shaded region inside an ordinary plot keeps the pair) and are
 * not both its edges (a frame around the panel keeps the pair as it is).
 */
function panelDecides(panel: Panel, pair: Pair | null): boolean {
  if (!pair) return true;
  const { h, v } = pair;
  const th = EDGE_TOL + h.thickness / 2;
  const tv = EDGE_TOL + v.thickness / 2;
  const on = h.offset >= panel.top - th && h.offset <= panel.bottom + th && v.offset >= panel.left - tv && v.offset <= panel.right + tv;
  if (!on) return false;
  const hEdge = Math.abs(h.offset - panel.bottom) <= th || Math.abs(h.offset - panel.top) <= th;
  const vEdge = Math.abs(v.offset - panel.left) <= tv || Math.abs(v.offset - panel.right) <= tv;
  return !(hEdge && vEdge);
}

/**
 * Whether the grid's extent, not the pair, gives the axes: there is no pair, or one of its lines
 * is one of the grid's own lines inside the grid (not along its edge, where a frame of the
 * gridlines' colour runs). Against a pair only a grid of both families counts: gridlines of one
 * family tell where two of the plot's edges are, not all four.
 */
function gridDecides(g: GridBox, pair: Pair | null): boolean {
  if (!pair) return true;
  if (!g.horizontal.length || !g.vertical.length) return false;
  const member = (line: FoundLine, lines: GridLine[], lo: number, hi: number) =>
    lines.some((l) => Math.abs(l.offset - line.offset) <= 1.5) && line.offset > lo + EDGE_TOL && line.offset < hi - EDGE_TOL;
  return member(pair.h, g.horizontal, g.top, g.bottom) || member(pair.v, g.vertical, g.left, g.right);
}

function medianContrast(g: GridBox): number {
  const all = [...g.horizontal, ...g.vertical].map((l) => l.contrast);
  return all.length ? median(all) : 0;
}

function boxOf(frame: Frame, r: Rect, framed: PlotBox['framed']): PlotBox {
  return {
    topLeft: toImage(frame, r.left, r.top),
    topRight: toImage(frame, r.right, r.top),
    bottomRight: toImage(frame, r.right, r.bottom),
    bottomLeft: toImage(frame, r.left, r.bottom),
    framed,
  };
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

function plotBox(frame: Frame, pair: Pair, hs: FoundLine[], vs: FoundLine[], tol: number): { box: PlotBox; rect: Rect } {
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
  // end, about as dark as the axes (a gridline near the end is lighter), spanning the box. A range
  // frame has none: its box ends where its lines end (a long line just past one is something else,
  // e.g. a viewer's toolbar above a screenshot of the figure).
  // Of several such lines within reach of the end, the nearest: a gridline of the frame's colour
  // one tick step inside it may rank higher among the candidates but is not the frame.
  const nearest = (lines: FoundLine[], at: number) =>
    lines.reduce<FoundLine | null>((a, c) => (!a || Math.abs(c.offset - at) < Math.abs(a.offset - at) ? c : a), null);
  const farV =
    !pair.detached &&
    nearest(
      vs.filter((c) => c !== v && c.contrast >= FRAME_CONTRAST * v.contrast && Math.abs(c.offset - farEndU) <= tol && c.start <= wLo + tol && c.end >= wHi - tol),
      farEndU,
    );
  const farH =
    !pair.detached &&
    nearest(
      hs.filter((c) => c !== h && c.contrast >= FRAME_CONTRAST * h.contrast && Math.abs(c.offset - farEndW) <= tol && c.start <= uLo + tol && c.end >= uHi - tol),
      farEndW,
    );
  const farU = farV ? farV.offset : farEndU;
  const farW = farH ? farH.offset : farEndW;
  const left = Math.min(nearU, farU);
  const right = Math.max(nearU, farU);
  const top = Math.min(nearW, farW);
  const bottom = Math.max(nearW, farW);
  const rect = { left, right, top, bottom };
  return {
    rect,
    box: boxOf(frame, rect, {
      top: !!farH && o.xSide === 1,
      right: !!farV && o.ySide === 1,
      bottom: !!farH && o.xSide === -1,
      left: !!farV && o.ySide === -1,
    }),
  };
}
