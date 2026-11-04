/**
 * Auto-detect suggestions in the UI (Phase 5): the state App keeps for the current image, the
 * refs a suggestion offers, the document edit that accepting it makes, and the ghost markers
 * drawn for it. A suggestion is never applied without the user accepting it.
 */

import type { AutoCalibration, AxisSuggestion, Point } from '../auto/index.ts';
import type { RefName, ScaleType } from '../core/index.ts';
import type { DocAction, DraftRef } from '../state/doc.ts';

/** Auto-detect state for the current image (App owns it; it is not part of the document). */
export type AutoState =
  | { status: 'idle' }
  | { status: 'running'; stage: string }
  /** `values`: the suggested ref values as the user may have edited them before accepting. */
  | { status: 'done'; result: AutoCalibration; values: Partial<Record<RefName, string>> }
  | { status: 'error'; message: string };

/** The refs a suggestion offers for one axis: X1/X2 or Y1/Y2 with their positions. */
export function suggestedRefs(s: AxisSuggestion): { name: RefName; px: number; py: number; value: string }[] {
  if (!s.refs || s.status === 'none') return [];
  const [a, b] = s.refs;
  const names: [RefName, RefName] = s.axis === 'x' ? ['X1', 'X2'] : ['Y1', 'Y2'];
  return [
    { name: names[0], ...a },
    { name: names[1], ...b },
  ];
}

/** Initial (editable) values for every suggested ref. */
export function initialValues(result: AutoCalibration): Partial<Record<RefName, string>> {
  const out: Partial<Record<RefName, string>> = {};
  for (const r of [...suggestedRefs(result.x), ...suggestedRefs(result.y)]) out[r.name] = r.value;
  return out;
}

/**
 * The edit that accepting makes: every suggested ref with its (possibly edited, possibly empty)
 * value, and the scale of each axis whose labels were read.
 */
export function acceptAction(result: AutoCalibration, values: Partial<Record<RefName, string>>): Extract<DocAction, { type: 'apply-suggestion' }> {
  const refs: Partial<Record<RefName, DraftRef>> = {};
  for (const r of [...suggestedRefs(result.x), ...suggestedRefs(result.y)]) {
    refs[r.name] = { px: r.px, py: r.py, value: values[r.name] ?? r.value };
  }
  const scaleOf = (s: AxisSuggestion): ScaleType | undefined => (s.status === 'calibrated' && s.scale ? s.scale : undefined);
  const xScale = scaleOf(result.x);
  const yScale = scaleOf(result.y);
  return { type: 'apply-suggestion', refs, ...(xScale && { xScale }), ...(yScale && { yScale }) };
}

/** What the workspace draws for a pending suggestion (image px). */
export interface Ghost {
  refs: { name: RefName; px: number; py: number; value: string }[];
  lines: { p1: Point; p2: Point }[];
  labels: { center: Point; width: number; height: number; inlier: boolean }[];
}

export function ghostOf(auto: AutoState): Ghost | null {
  if (auto.status !== 'done') return null;
  const { result, values } = auto;
  const axes = [result.x, result.y];
  return {
    refs: axes.flatMap(suggestedRefs).map((r) => ({ ...r, value: values[r.name] ?? r.value })),
    lines: axes.flatMap((s) => (s.line ? [s.line] : [])),
    labels: axes.flatMap((s) => s.labels.map((l) => ({ ...l.box, inlier: l.inlier }))),
  };
}
