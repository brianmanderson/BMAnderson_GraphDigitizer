/**
 * Types for automatic axis detection (Phase 4). Pure data, no DOM: the detector runs in a Web
 * Worker and in Node (the benchmark), so it takes plain RGBA bytes, not ImageData.
 *
 * Coordinates are image pixels with the app's convention: integer = pixel centre, origin
 * top-left, y down (docs/SPEC.md → Pixel convention).
 */

/** Decoded image: `data` is RGBA, 4 bytes per pixel, row-major (same layout as ImageData). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A straight dark line found by the projection profiles, in the skew-corrected frame: `family`
 * says whether it runs (nearly) horizontally or vertically; `offset` is its sub-pixel position
 * across that direction and `start`/`end` its extent along it (see `frame.ts`).
 */
export interface LineCandidate {
  family: 'horizontal' | 'vertical';
  offset: number;
  start: number;
  end: number;
  /** Image coordinates of the two ends (start → end: left → right, or top → bottom). */
  p1: Point;
  p2: Point;
  length: number;
  /** Mean ink darkness along the line, 0–255 above the local background. */
  contrast: number;
  /** Apparent thickness across the line, px. */
  thickness: number;
  /** length × contrast / 255: what candidates are ranked by. */
  strength: number;
}

/** Relative to the plot: 'outside' = away from it (below a bottom X axis, above a top one). */
export type TickSide = 'outside' | 'inside' | 'both';

export interface Tick {
  /** Where the tick meets the axis line (image px). */
  point: Point;
  /** Position along the axis in the skew-corrected frame (x for the X axis, y for the Y axis). */
  along: number;
  /** Length of the mark from the axis line's centre, px (minor ticks are shorter). */
  length: number;
  kind: 'major' | 'minor';
  /** 0–1: how well this mark fits the axis's tick pattern. */
  confidence: number;
}

export interface TickSet {
  ticks: Tick[];
  /** Fitted spacing of the major ticks along the axis (px), or null when there is no pattern. */
  spacing: number | null;
  /**
   * 'log' when minor ticks sit at log10(2…9) of each major interval (a log axis); 'even' for
   * evenly spaced majors (linear, date, or a log axis without visible minors); null = no ticks.
   */
  pattern: 'even' | 'log' | null;
  side: TickSide | null;
  /**
   * 0–1 for the whole set. 0 with no ticks means "this axis shows no tick marks" (e.g. labels
   * only); callers must not invent ticks then.
   */
  confidence: number;
  /** Short marks that were seen but did not fit the pattern (for debugging and Phase 5). */
  rejected: Point[];
}

/**
 * Which edge of the plot an axis runs along: X at the bottom (default) or top, Y at the left
 * (default) or right. Tick labels sit on the far side of the axis from the plot.
 */
export type AxisPosition = 'bottom' | 'top' | 'left' | 'right';

export interface DetectedAxis {
  line: LineCandidate;
  position: AxisPosition;
  /** 0–1 heuristic: line strength, its length, and whether it forms a plausible axis pair. */
  confidence: number;
  ticks: TickSet;
}

/** Plot-area quadrilateral; corners in image px (a rectangle rotated by the skew angle). */
export interface PlotBox {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
  /**
   * For the edges opposite the axes: whether each is a drawn frame line (true) or was inferred
   * from the axes' extents. Edges along an axis are always false.
   */
  framed: { top: boolean; right: boolean; bottom: boolean; left: boolean };
}

export interface AxisDetection {
  width: number;
  height: number;
  /** Estimated skew of the chart, degrees, positive = rotated clockwise on screen. */
  skewDegrees: number;
  xAxis: DetectedAxis | null;
  yAxis: DetectedAxis | null;
  plotBox: PlotBox | null;
  /** The strongest line candidates of each family, strongest first. */
  candidates: { horizontal: LineCandidate[]; vertical: LineCandidate[] };
}
