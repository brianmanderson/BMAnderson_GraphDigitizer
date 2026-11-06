/**
 * Auto-trace in the UI: the state App keeps while the user picks a series and reviews the traced
 * points, the ghost the workspace draws for it, and the document edit that accepting makes. Like
 * an auto-detect suggestion, a trace is never applied without the user accepting it.
 */

import type { TraceMode, TraceResult } from '../auto/trace/types.ts';
import type { DataPoint } from '../core/index.ts';
import { nextDatasetDefaults, type DocAction, type DocState } from '../state/doc.ts';
import { isOnImage } from './view.ts';

export interface TraceSettings {
  mode: TraceMode;
  maxPoints: number;
}

/** Shown over the canvas and in the panel while the user picks the series to trace. */
export const TRACE_PROMPT = 'Click on the curve or markers to trace';
/** The same for "Find points" (markers mode): one marker stands for all that look like it. */
export const FIND_PROMPT = 'Click on one marker to find every marker like it';

export const promptFor = (mode: TraceMode): string => (mode === 'markers' ? FIND_PROMPT : TRACE_PROMPT);

export const DEFAULT_TRACE_SETTINGS: TraceSettings = { mode: 'auto', maxPoints: 25 };
export const MIN_TRACE_POINTS = 2;
export const MAX_TRACE_POINTS = 200;

export const clampMaxPoints = (n: number): number =>
  Number.isFinite(n) ? Math.min(MAX_TRACE_POINTS, Math.max(MIN_TRACE_POINTS, Math.round(n))) : DEFAULT_TRACE_SETTINGS.maxPoints;

/** Where accepted points go: the active line, or a new line made for them. */
export type TraceTarget = 'active' | 'new';

type Seed = { px: number; py: number };

/**
 * Auto-trace state for the current image (App owns it; it is not part of the document). `mode` is
 * the trace's own: the session's mode for "Auto-trace line", 'markers' for "Find points".
 */
export type TraceState = { target: TraceTarget; mode: TraceMode } & (
  | { status: 'picking' }
  | { status: 'running'; seed: Seed }
  | { status: 'done'; seed: Seed; result: TraceResult }
  | { status: 'error'; seed: Seed; message: string }
);

export const rgbHex = ([r, g, b]: readonly [number, number, number]): string =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The traced series' colour as a line colour, when it is colourful enough to tell lines apart
 * (a black or grey curve keeps the next palette colour).
 */
export function lineColorOf(color: readonly [number, number, number]): string | null {
  return Math.max(...color) - Math.min(...color) >= 60 ? rgbHex(color) : null;
}

/** The colour the traced points will have once accepted. */
export function traceColor(doc: DocState, target: TraceTarget, result: TraceResult | null): string {
  if (target === 'new') return (result && lineColorOf(result.color)) ?? nextDatasetDefaults(doc).color;
  return doc.datasets.find((d) => d.id === doc.activeDatasetId)?.color ?? nextDatasetDefaults(doc).color;
}

/** The points a result offers: finite, on the image. */
export function tracedPoints(doc: DocState, result: TraceResult): Seed[] {
  return result.points
    .filter((p) => Number.isFinite(p.px) && Number.isFinite(p.py) && isOnImage(p.px, p.py, doc.image.width, doc.image.height))
    .map(({ px, py }) => ({ px, py }));
}

/**
 * The edit that accepting makes — one undo step: the points appended to the active line, or a new
 * line holding them (named and coloured like "+ Add line", in the series' colour when it has one).
 * Null when there is nothing to add. `newId` supplies ids so the reducer stays pure.
 */
export function acceptTraceAction(doc: DocState, target: TraceTarget, result: TraceResult, newId: () => string): DocAction | null {
  const points: DataPoint[] = tracedPoints(doc, result).map((p) => ({ id: newId(), ...p }));
  if (!result.ok || points.length === 0) return null;
  if (target === 'active') return { type: 'add-points', datasetId: doc.activeDatasetId, points };
  const defaults = nextDatasetDefaults(doc);
  return {
    type: 'add-dataset',
    dataset: { id: newId(), name: defaults.name, color: lineColorOf(result.color) ?? defaults.color, points },
  };
}

/** What the workspace draws for a trace under review (image px). */
export interface TraceGhost {
  color: string;
  seed: Seed | null;
  path: Seed[];
  points: Seed[];
}

export function traceGhostOf(doc: DocState, trace: TraceState | null): TraceGhost | null {
  if (!trace || trace.status === 'picking') return null;
  const result = trace.status === 'done' ? trace.result : null;
  return {
    color: traceColor(doc, trace.target, result),
    seed: trace.seed,
    path: result?.path ?? [],
    points: result ? tracedPoints(doc, result) : [],
  };
}
