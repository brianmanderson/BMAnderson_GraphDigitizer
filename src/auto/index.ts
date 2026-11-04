/**
 * Automatic axis detection (Phase 4): pure TypeScript, no DOM, safe to run in a Web Worker.
 * `detectAxes(rgba)` finds the X/Y axis lines, the plot box and the tick marks, each with a
 * confidence. Measured by `npm run bench:axes` (bench/axes/).
 */

export { detectAxes, detectAxesInMap } from './detect.ts';
export { darknessMap, INK_THRESHOLD } from './darkness.ts';
export type {
  AxisDetection,
  DetectedAxis,
  LineCandidate,
  PlotBox,
  Point,
  RgbaImage,
  Tick,
  TickSet,
  TickSide,
} from './types.ts';
