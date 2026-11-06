/**
 * The workspace selection (UI state, never part of the document): nothing, one ref (Axes step),
 * or any number of points from any lines. Points keep the order they were selected in; the last
 * one is the "current" point — the table scrolls to it and the loupe shows it after a nudge.
 */

import type { DocState } from '../state/doc.ts';
import type { Target } from './draw.ts';

export type Selection = readonly Target[];
export type PointTarget = Extract<Target, { kind: 'point' }>;

export const EMPTY_SELECTION: Selection = [];

/** How a pick changes the selection: replace it, toggle each target (Shift+click), or add (Shift+marquee). */
export type SelectHow = 'replace' | 'toggle' | 'add';

export const targetKey = (t: Target): string => (t.kind === 'ref' ? t.ref : `${t.datasetId}/${t.pointId}`);

export const sameTarget = (a: Target, b: Target): boolean => targetKey(a) === targetKey(b);

/** Keys of the selected targets, for O(1) "is this selected?" while drawing or rendering rows. */
export const selectionKeys = (sel: Selection): ReadonlySet<string> => new Set(sel.map(targetKey));

export const selectedPoints = (sel: Selection): PointTarget[] => sel.filter((t): t is PointTarget => t.kind === 'point');

/** The most recently selected point, or null. */
export function lastPoint(sel: Selection): PointTarget | null {
  for (let i = sel.length - 1; i >= 0; i--) {
    const t = sel[i]!;
    if (t.kind === 'point') return t;
  }
  return null;
}

/**
 * The selection after a pick. Refs are single-select: picking one replaces everything, and a
 * point pick drops any ref. Toggling removes a selected target and appends an unselected one;
 * adding appends the targets not yet selected (the others keep their place).
 */
export function applySelect(sel: Selection, targets: readonly Target[], how: SelectHow): Selection {
  const ref = targets.find((t) => t.kind === 'ref');
  if (ref) return [ref];
  if (how === 'replace') return dedupe(targets);
  const keys = new Set(selectedPoints(sel).map(targetKey));
  let next: Target[] = selectedPoints(sel);
  for (const t of targets) {
    const k = targetKey(t);
    if (keys.has(k)) {
      if (how === 'toggle') {
        next = next.filter((s) => targetKey(s) !== k);
        keys.delete(k);
      }
    } else {
      next.push(t);
      keys.add(k);
    }
  }
  return next;
}

function dedupe(targets: readonly Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const k = targetKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The selection without targets the document no longer has (an undo, a deleted line, a load).
 * Returns `sel` itself when nothing is missing.
 */
export function validSelection(doc: DocState, sel: Selection): Selection {
  if (sel.length === 0) return sel;
  const points = new Set<string>();
  for (const d of doc.datasets) for (const p of d.points) points.add(`${d.id}/${p.id}`);
  const valid = sel.filter((t) => (t.kind === 'ref' ? doc.refs[t.ref] !== undefined : points.has(targetKey(t))));
  return valid.length === sel.length ? sel : valid;
}

/** Every point of one line, in placement order. */
export function linePoints(doc: DocState, datasetId: string): PointTarget[] {
  const d = doc.datasets.find((x) => x.id === datasetId);
  return d ? d.points.map((p) => ({ kind: 'point', datasetId: d.id, pointId: p.id })) : [];
}

/** Every point, of any line, inside the rectangle with corners `a` and `b` (image px, edges included). */
export function pointsInRect(doc: DocState, a: { px: number; py: number }, b: { px: number; py: number }): PointTarget[] {
  const x0 = Math.min(a.px, b.px);
  const x1 = Math.max(a.px, b.px);
  const y0 = Math.min(a.py, b.py);
  const y1 = Math.max(a.py, b.py);
  const out: PointTarget[] = [];
  for (const d of doc.datasets) {
    for (const p of d.points) {
      if (p.px >= x0 && p.px <= x1 && p.py >= y0 && p.py <= y1) out.push({ kind: 'point', datasetId: d.id, pointId: p.id });
    }
  }
  return out;
}
