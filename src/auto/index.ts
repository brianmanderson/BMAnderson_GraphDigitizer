/**
 * Automatic axis detection (Phase 4) and auto-calibration (Phase 5): pure TypeScript, no DOM,
 * safe to run in a Web Worker. `detectAxes(rgba)` finds the X/Y axis lines, the plot box and the
 * tick marks, each with a confidence (measured by `npm run bench:axes`, bench/axes/).
 * `autoCalibrate(rgba, ocr)` adds tick-label OCR (injected engine), scale inference and a
 * cross-checked suggested calibration. `traceLine(request)` follows a plotted series from one click
 * and proposes its points (measured by `npm run bench:lines`, bench/lines/).
 */

export { detectAxes, detectAxesInMap } from './detect.ts';
export { darknessMap, INK_THRESHOLD } from './darkness.ts';
export { traceLine, type LineStyle, type TraceMode, type TracedPoint, type TraceRequest, type TraceResult } from './trace/index.ts';
export { autoCalibrate, type AutoOptions, type OcrCharset, type OcrEngine, type OcrRequest } from './auto.ts';
export { findLabels, type AxisLabels, type FoundLabel } from './labels.ts';
export { monthOf, parseDateToken, parseNumberLabel, resolveDateLabels, type LabelToken } from './parseLabel.ts';
export {
  crossCheck,
  suggestAxis,
  tolerance,
  type AutoCalibration,
  type AxisReading,
  type AxisSuggestion,
  type ConfidenceLevel,
  type OcrLabel,
  type ReadLabel,
  type SuggestedRef,
} from './suggest.ts';
export type {
  AxisDetection,
  AxisPosition,
  DetectedAxis,
  LineCandidate,
  PlotBox,
  Point,
  RgbaImage,
  Tick,
  TickSet,
  TickSide,
} from './types.ts';
