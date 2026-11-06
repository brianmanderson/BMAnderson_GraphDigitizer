/**
 * Interface contract of the automatic line tracer (`traceLine`, src/auto/trace/index.ts). The
 * Data-step UI codes against these shapes verbatim; changing one means updating docs/SPEC.md →
 * Auto-trace in the same change.
 *
 * Coordinates are image pixels with the app's convention: integer = pixel centre, origin
 * top-left, y down (docs/SPEC.md → Pixel convention).
 */

/**
 * 'curve' follows a drawn line; 'markers' ("Find points") finds every marker that looks like the
 * clicked one (colour, shape, filled or open, size); 'auto' picks.
 */
export type TraceMode = 'auto' | 'curve' | 'markers';

export interface TraceRequest {
  /** RGBA bytes, row-major, 4 per pixel (ImageData.data layout). */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Plot area in image px (4 corners, TL,TR,BR,BL), or null = whole image. */
  plotBox: [number, number][] | null;
  /** Image pixel the user clicked on the series (pixel-centre convention). */
  seed: { px: number; py: number };
  mode: TraceMode;
  /** Target number of suggested points (UI default 25); corners/extrema are kept beyond it. */
  maxPoints: number;
}

export interface TracedPoint {
  px: number;
  py: number;
  /** 0–1: how clean the evidence for this point is (1 = an isolated stroke of the series colour). */
  confidence: number;
}

/** Line style of a traced curve, read from the stroke around the seed ('unknown' = can't tell). */
export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'unknown';

export interface TraceResult {
  ok: boolean;
  kind: 'curve' | 'markers' | 'none';
  /**
   * Line style of the clicked series (curves); 'unknown' for markers, failures, or when the
   * stroke near the seed is too short or irregular to tell. The trace keeps to ink of this style.
   */
  style: LineStyle;
  /** Series colour sampled at the seed, sRGB 0–255. */
  color: [number, number, number];
  /** Dense centreline (curves) or every marker centroid (markers), ordered by px. */
  path: TracedPoint[];
  /** Suggested points to add to the line: resampled from path, keeping step corners and extrema. */
  points: TracedPoint[];
  message?: string;
  timings: { totalMs: number };
}
