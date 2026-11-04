/**
 * Undo/redo on top of `appReducer`: the history keeps whole-document snapshots (cheap, since
 * the reducer shares every unchanged object, the image data URL included).
 *
 * Edits that carry the same `group` key one after another merge into one undo step: a drag
 * (many `place-ref` / `move-point` actions between pointerdown and pointerup), typing into one
 * field, or holding an arrow key to nudge. Switching the active dataset is not an undo step; it
 * changes the present document without touching the history.
 */

import { appReducer, type AppAction, type DocState } from './doc.ts';

/** Undo steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 200;

export interface History {
  past: DocState[];
  present: DocState | null;
  future: DocState[];
  /** Group key of the newest undo step while further edits may still merge into it. */
  group: string | null;
  /**
   * Bumped by every recorded edit, undo, redo and reset. A notice that offers "Undo" records it
   * and hides the button once anything else has changed the history.
   */
  rev: number;
}

export type HistoryAction =
  | { type: 'edit'; action: AppAction; group?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Replace the document and forget the history (restoring an autosave). */
  | { type: 'reset'; doc: DocState | null };

export const EMPTY_HISTORY: History = { past: [], present: null, future: [], group: null, rev: 0 };

/** Actions that change the document but are not worth an undo step of their own. */
const UNRECORDED: ReadonlySet<AppAction['type']> = new Set(['set-active-dataset']);

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;

export function historyReducer(h: History, action: HistoryAction): History {
  switch (action.type) {
    case 'undo': {
      const prev = h.past.at(-1);
      if (!prev || !h.present) return h;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], group: null, rev: h.rev + 1 };
    }
    case 'redo': {
      const [next, ...future] = h.future;
      if (!next || !h.present) return h;
      return { past: [...h.past, h.present], present: next, future, group: null, rev: h.rev + 1 };
    }
    case 'reset':
      return { past: [], present: action.doc, future: [], group: null, rev: h.rev + 1 };
    case 'edit': {
      const next = appReducer(h.present, action.action);
      if (next === h.present) return h;
      // Nothing to go back to before the first image.
      if (h.present === null || next === null) return { past: [], present: next, future: [], group: null, rev: h.rev + 1 };
      if (UNRECORDED.has(action.action.type)) return { ...h, present: next };
      const group = action.group ?? null;
      if (group !== null && group === h.group && h.past.length > 0) {
        return { ...h, present: next, future: [], rev: h.rev + 1 };
      }
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        group,
        rev: h.rev + 1,
      };
    }
  }
}
