import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { REF_NAMES, calibrateSpec, parseProject, parseProjectText, type Project, type ProjectImage, type RefName } from './core/index.ts';
import { AxesStep } from './components/AxesStep.tsx';
import { CropPanel } from './components/CropPanel.tsx';
import { DataStep } from './components/DataStep.tsx';
import { DataTable } from './components/DataTable.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Workspace, type Step } from './components/Workspace.tsx';
import {
  appReducer,
  calibrationSpec,
  cropLosses,
  fromProject,
  hasWork,
  newDoc,
  nextDatasetDefaults,
  nextUnplacedRef,
  toProject,
  type AppAction,
  type DocState,
} from './state/doc.ts';
import { EMPTY_HISTORY, canRedo, canUndo, historyReducer } from './state/history.ts';
import { readAutosave, writeAutosave } from './ui/autosave.ts';
import { cropImage, fullCrop, setCropField, type CropField, type CropRect } from './ui/crop.ts';
import { findTargetPos, type Target } from './ui/draw.ts';
import { baseName, copyText, downloadText } from './ui/export.ts';
import { runAutoDetect, type AutoRun } from './ui/autoDetect.ts';
import { runTrace, type TraceRun } from './ui/autoTrace.ts';
import type { TraceMode } from './auto/trace/types.ts';
import { ACCEPTED_IMAGE_TYPES, decodeImage, firstFile, imagePixels, isProjectFile, loadImageFile } from './ui/loadImage.ts';
import { DEFAULT_LOUPE_ZOOM, LOUPE_ZOOMS } from './ui/loupe.ts';
import { nudgeDirection, nudgeStep, nudged, nudgedAll } from './ui/nudge.ts';
import {
  EMPTY_SELECTION,
  applySelect,
  lastPoint,
  linePoints,
  selectedPoints,
  targetKey,
  validSelection,
  type SelectHow,
  type Selection,
} from './ui/selection.ts';
import { acceptAction, ghostOf, initialValues, type AutoState } from './ui/suggestion.ts';
import {
  SessionRecorder,
  autoDetectEvent,
  dataUrlBytes,
  eventsForAction,
  serializeLog,
  sessionLogFilename,
  type LoadSource,
  type SessionEventBody,
} from './ui/sessionLog.ts';
import {
  DEFAULT_TRACE_SETTINGS,
  promptFor,
  acceptTraceAction,
  clampMaxPoints,
  traceColor,
  traceGhostOf,
  tracedPoints,
  type TraceSettings,
  type TraceState,
  type TraceTarget,
} from './ui/trace.ts';
import { exportCells, formatValue, toCsv, toTsv, type TableOptions } from './ui/table.ts';
import { IDENTITY_VIEW, fitView, zoomAt, type View } from './ui/view.ts';

/** `undoRev`: the history revision this notice's Undo button undoes; hidden once it moves on. */
type Notice = { kind: 'error' | 'info'; text: string; undoRev?: number };

const newId = () => crypto.randomUUID();

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const STEPS: { id: Step; label: string }[] = [
  { id: 'image', label: 'Image' },
  { id: 'axes', label: 'Axes' },
  { id: 'data', label: 'Data' },
];

const isCalibrated = (doc: DocState): boolean => {
  const spec = calibrationSpec(doc);
  return !!spec && calibrateSpec(spec).ok;
};

/** The step to show for a restored or opened document: Data once the axes are calibrated. */
const stepFor = (doc: DocState): Step => (isCalibrated(doc) ? 'data' : 'axes');

/**
 * "Auto-trace line" is the Data step's default tool: it opens by itself — picking, into the active
 * line, in the session's mode — on entering the step and after "+ Add line", once the axes are
 * calibrated (as for the button; SPEC → Auto-trace UI). Discard or Esc returns to placing by hand.
 */
function defaultTrace(doc: DocState | null, mode: TraceMode): { of: DocState['image']; state: TraceState } | null {
  return doc && isCalibrated(doc) ? { of: doc.image, state: { status: 'picking', target: 'active', mode } } : null;
}

/** Precision-tool and edit-mode preferences, remembered per browser (not part of the project). */
interface Prefs {
  loupe: boolean;
  loupeZoom: number;
  snap: boolean;
  /** "Move points" tool (Data step): on, clicks select and drags move; off, every click places a point. */
  movePoints: boolean;
}
const PREFS_KEY = 'graph-digitizer:prefs';
const DEFAULT_PREFS: Prefs = { loupe: true, loupeZoom: DEFAULT_LOUPE_ZOOM, snap: false, movePoints: false };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      loupe: typeof raw.loupe === 'boolean' ? raw.loupe : DEFAULT_PREFS.loupe,
      loupeZoom: (LOUPE_ZOOMS as readonly number[]).includes(raw.loupeZoom ?? NaN) ? raw.loupeZoom! : DEFAULT_PREFS.loupeZoom,
      snap: typeof raw.snap === 'boolean' ? raw.snap : DEFAULT_PREFS.snap,
      movePoints: typeof raw.movePoints === 'boolean' ? raw.movePoints : DEFAULT_PREFS.movePoints,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Settings changes (dragging the Points slider) settle this long before the trace re-runs. */
const TRACE_DEBOUNCE_MS = 120;

/** An open hand, the "Move points" tool's icon (stroke follows the button's text colour). */
function HandIcon() {
  return (
    <svg className="tool-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** " 3 points and 1 ref outside the crop were removed." — or nothing when the crop kept everything. */
function removedByCrop(lost: { refs: number; points: number }): string {
  const parts = [lost.points > 0 && plural(lost.points, 'point'), lost.refs > 0 && plural(lost.refs, 'ref')].filter((p) => p !== false);
  if (parts.length === 0) return '';
  return ` ${parts.join(' and ')} outside the crop ${lost.points + lost.refs === 1 ? 'was' : 'were'} removed.`;
}

export function App() {
  const [history, historyDispatch] = useReducer(historyReducer, EMPTY_HISTORY);
  const doc = history.present;
  const [step, setStep] = useState<Step>('image');
  /** The decoded image, tagged with the document image it was decoded from. */
  const [decoded, setDecoded] = useState<{ of: DocState['image']; el: HTMLImageElement } | null>(null);
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const viewport = useRef({ width: 0, height: 0 });
  /** One ref (Axes) or any number of points (Data); see src/ui/selection.ts. */
  const [selectionRaw, setSelection] = useState<Selection>(EMPTY_SELECTION);
  /** A ref the user chose to (re-)place; otherwise the next unplaced ref is placed. */
  const [chosenRef, setChosenRef] = useState<RefName | null>(null);
  const [focusRef, setFocusRef] = useState<RefName | null>(null);
  const [cursor, setCursor] = useState<{ px: number; py: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tableView, setTableView] = useState({ showPixels: false, sortByX: false });
  /** Lines whose point lists are collapsed in the table (UI state; autosaved, not in the Project). */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  /** The selection was just nudged with the keyboard: the loupe shows it until the mouse moves. */
  const [loupeOnSelection, setLoupeOnSelection] = useState(false);
  const [autosaved, setAutosaved] = useState<{ ok: boolean; at: number } | null>(null);
  /** Auto-detect for the current image: never applied until the user accepts it. */
  const [autoRaw, setAuto] = useState<{ of: DocState['image']; state: AutoState } | null>(null);
  const autoRun = useRef<AutoRun | null>(null);
  /** Auto-trace for the current image, Data step only: never applied until the user accepts it. */
  const [traceRaw, setTrace] = useState<{ of: DocState['image']; state: TraceState } | null>(null);
  const [traceSettings, setTraceSettings] = useState<TraceSettings>(DEFAULT_TRACE_SETTINGS);
  /**
   * Crop mode (Image step), for the current image: the rectangle chosen so far, or null until one
   * is dragged or typed. UI state only — never in the document, the autosave or the prefs.
   */
  const [cropRaw, setCrop] = useState<{ of: DocState['image']; rect: CropRect | null } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  /** The session log of the current image (docs/SPEC.md → Session log): in memory only. */
  const [sessionLog] = useState(() => new SessionRecorder(() => performance.now()));
  /** Latest render's values, for callbacks that must not re-create on every change. */
  const docRef = useRef(doc);
  const historyRef = useRef(history);
  const traceTargetRef = useRef<TraceTarget | null>(null);

  /**
   * Every document edit: logged (src/ui/sessionLog.ts maps it to events, with the same group key
   * as the undo step so a drag is one event), then applied through the history. An edit the
   * reducer ignores is not logged. `snapped`: an added point came from Snap.
   */
  const dispatch = useCallback(
    (action: AppAction, group?: string, opts: { snapped?: boolean } = {}) => {
      const before = docRef.current;
      if (before && appReducer(before, action) !== before) sessionLog.record(eventsForAction(before, action, group, opts), group);
      historyDispatch(group === undefined ? { type: 'edit', action } : { type: 'edit', action, group });
    },
    [sessionLog],
  );
  const undo = useCallback(() => {
    if (canUndo(historyRef.current)) sessionLog.record({ type: 'undo' });
    historyDispatch({ type: 'undo' });
  }, [sessionLog]);
  const redo = useCallback(() => {
    if (canRedo(historyRef.current)) sessionLog.record({ type: 'redo' });
    historyDispatch({ type: 'redo' });
  }, [sessionLog]);
  const record = useCallback((body: SessionEventBody, group?: string) => sessionLog.record(body, group), [sessionLog]);

  /** A new log for a newly loaded image (a file, a project, the autosave). */
  const startLog = useCallback(
    (image: ProjectImage, source: LoadSource) =>
      sessionLog.start(
        {
          appVersion: __APP_VERSION__,
          commit: __GIT_COMMIT__,
          startedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          devicePixelRatio: window.devicePixelRatio,
          imageName: image.name,
          imageSize: { w: image.width, h: image.height, bytes: dataUrlBytes(image.dataUrl) },
        },
        source,
      ),
    [sessionLog],
  );
  const onFocused = useCallback(() => setFocusRef(null), []);

  // Markers an undo, a deleted line or a load removed drop out of the selection.
  const selection = useMemo(() => (doc ? validSelection(doc, selectionRaw) : EMPTY_SELECTION), [doc, selectionRaw]);
  const selectedPointCount = useMemo(() => selectedPoints(selection).length, [selection]);
  const image = decoded && doc && decoded.of === doc.image ? decoded.el : null;
  // A suggestion belongs to the image it was made for (a load or an undo across one drops it).
  const auto: AutoState = useMemo(
    () => (autoRaw && doc && autoRaw.of === doc.image ? autoRaw.state : { status: 'idle' }),
    [autoRaw, doc],
  );
  const ghost = useMemo(() => ghostOf(auto), [auto]);
  const trace = traceRaw && doc && traceRaw.of === doc.image && step === 'data' ? traceRaw.state : null;
  const crop = cropRaw && doc && cropRaw.of === doc.image && step === 'image' ? cropRaw : null;
  const traceGhost = useMemo(() => (doc ? traceGhostOf(doc, trace) : null), [doc, trace]);

  const spec = useMemo(() => (doc ? calibrationSpec(doc) : null), [doc]);
  const result = useMemo(() => (spec ? calibrateSpec(spec) : null), [spec]);
  const calibration = result?.ok ? result.calibration : null;
  const placingRef = doc ? (chosenRef ?? nextUnplacedRef(doc.refs)) : null;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage unavailable (private mode, quota): preferences just aren't remembered.
    }
  }, [prefs]);

  /** Image size to fit once the workspace has been measured (it may not be on first load). */
  const pendingFit = useRef<{ width: number; height: number } | null>(null);
  const fitImage = useCallback((imageWidth: number, imageHeight: number) => {
    const { width, height } = viewport.current;
    if (width > 0 && height > 0) {
      pendingFit.current = null;
      setView(fitView(imageWidth, imageHeight, width, height));
    } else {
      pendingFit.current = { width: imageWidth, height: imageHeight };
    }
  }, []);

  const fit = useCallback(() => {
    if (doc) fitImage(doc.image.width, doc.image.height);
  }, [doc, fitImage]);

  const onViewportSize = useCallback(
    (width: number, height: number) => {
      viewport.current = { width, height };
      if (pendingFit.current) fitImage(pendingFit.current.width, pendingFit.current.height);
    },
    [fitImage],
  );

  // Whenever the document's image changes (load, open, restore, or undo across a load): decode
  // it for drawing and fit it to the window.
  const docImage = doc?.image ?? null;
  useEffect(() => {
    if (!docImage) return;
    let live = true;
    fitImage(docImage.width, docImage.height);
    decodeImage(docImage.dataUrl).then(
      (el) => live && setDecoded({ of: docImage, el }),
      () => live && setNotice({ kind: 'error', text: 'The image could not be displayed.' }),
    );
    return () => {
      live = false;
    };
  }, [docImage, fitImage]);

  // Run the trace in the worker whenever it is (re)started: a new seed, or new settings.
  const runningSeed = trace?.status === 'running' ? trace.seed : null;
  const runningMode = trace?.status === 'running' ? trace.mode : null;
  useEffect(() => {
    const pixels = image && imagePixels(image);
    if (!runningSeed || !runningMode || !pixels || !docImage) return;
    let live = true;
    let run: TraceRun | null = null;
    const settle = (state: (target: TraceTarget, mode: TraceMode) => TraceState) =>
      live &&
      setTrace((t) =>
        t?.of === docImage && t.state.status === 'running' && t.state.seed === runningSeed ? { of: docImage, state: state(t.state.target, t.state.mode) } : t,
      );
    const timer = setTimeout(() => {
      const started = performance.now();
      const generation = sessionLog.generation;
      /** One `trace-run` per finished run (a cancelled one, or one for an image since replaced, is not logged). */
      const logRun = (kind: 'curve' | 'markers' | 'none', outcome: 'ok' | 'empty' | 'error', pointCount: number) => {
        const d = docRef.current;
        if (!live || !d || sessionLog.generation !== generation) return;
        sessionLog.record({
          type: 'trace-run',
          datasetId: traceTargetRef.current === 'new' ? null : d.activeDatasetId,
          seedPx: { x: runningSeed.px, y: runningSeed.py },
          mode: runningMode,
          kind,
          durationMs: Math.round(performance.now() - started),
          outcome,
          pointCount,
        });
      };
      run = runTrace(pixels, runningSeed, runningMode, traceSettings.maxPoints);
      run.result.then(
        (result) => {
          const n = result.ok && docRef.current ? tracedPoints(docRef.current, result).length : 0;
          logRun(result.kind, n > 0 ? 'ok' : 'empty', n);
          settle((target, mode) => ({ status: 'done', target, mode, seed: runningSeed, result }));
        },
        (err: unknown) => {
          logRun('none', 'error', 0);
          settle((target, mode) => ({ status: 'error', target, mode, seed: runningSeed, message: err instanceof Error ? err.message : String(err) }));
        },
      );
    }, TRACE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      run?.cancel();
    };
  }, [runningSeed, runningMode, traceSettings, image, docImage, sessionLog]);

  /** Replace the document with an undoable step, and say so with an Undo button when work was replaced. */
  const replaceDoc = useCallback(
    (next: DocState, text: string, source: LoadSource) => {
      const replacesWork = hasWork(doc);
      startLog(next.image, source);
      dispatch({ type: 'replace-doc', doc: next });
      setSelection(EMPTY_SELECTION);
      setChosenRef(null);
      setCrop(null);
      setStep(stepFor(next));
      setTrace(defaultTrace(next, traceSettings.mode));
      setNotice({
        kind: 'info',
        text: replacesWork ? `${text} Undo brings back the previous work.` : text,
        ...(replacesWork && { undoRev: history.rev + 1 }),
      });
    },
    [doc, dispatch, startLog, history.rev, traceSettings.mode],
  );

  const openProject = useCallback(
    async (file: File) => {
      const parsed = parseProjectText(await file.text());
      if (!parsed.ok) {
        setNotice({ kind: 'error', text: `"${file.name}": ${parsed.message}` });
        return;
      }
      const { project } = parsed;
      try {
        const el = await decodeImage(project.image.dataUrl);
        if (el.naturalWidth !== project.image.width || el.naturalHeight !== project.image.height) {
          setNotice({
            kind: 'error',
            text: `"${file.name}": the embedded image is ${el.naturalWidth} × ${el.naturalHeight} px, but the project says ${project.image.width} × ${project.image.height} px.`,
          });
          return;
        }
      } catch {
        setNotice({ kind: 'error', text: `"${file.name}": the embedded image could not be decoded.` });
        return;
      }
      const migrated = parsed.migratedFrom === null ? '' : ` (converted from format ${parsed.migratedFrom})`;
      replaceDoc(fromProject(project), `Opened ${file.name}${migrated}.`, 'project');
    },
    [replaceDoc],
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (isProjectFile(file)) {
        await openProject(file);
        return;
      }
      const loaded = await loadImageFile(file);
      if (!loaded.ok) {
        setNotice({ kind: 'error', text: loaded.message });
        return;
      }
      const next = newDoc(loaded.image, newId(), doc?.settings);
      replaceDoc(next, `Loaded ${loaded.image.name} (${loaded.image.width} × ${loaded.image.height} px).`, 'image');
    },
    [doc, openProject, replaceDoc],
  );

  // Autosave: restore the last session once on start, then save after every change (debounced).
  const collapsedRef = useRef(collapsed);
  const traceSettingsRef = useRef(traceSettings);
  useLayoutEffect(() => {
    docRef.current = doc;
    historyRef.current = history;
    traceTargetRef.current = trace?.target ?? null;
    collapsedRef.current = collapsed;
    traceSettingsRef.current = traceSettings;
  });
  const restoreDone = useRef(false);
  const pendingSave = useRef<DocState | null>(null);
  const saveNow = useCallback(() => {
    const d = pendingSave.current;
    if (!d) return;
    pendingSave.current = null;
    const project: Project = toProject(d);
    const savedAt = Date.now();
    const collapsedIds = d.datasets.filter((ds) => collapsedRef.current.has(ds.id)).map((ds) => ds.id);
    writeAutosave({ project, activeDatasetId: d.activeDatasetId, collapsed: collapsedIds, savedAt }).then(
      () => setAutosaved({ ok: true, at: savedAt }),
      () => setAutosaved({ ok: false, at: savedAt }),
    );
  }, []);
  /**
   * The restore read is over (restored or not): saves may start. A document the user loaded
   * while it was being read missed its debounced save — nothing re-runs that effect until the
   * next change — so it is saved now.
   */
  const restoreFinished = useCallback(() => {
    restoreDone.current = true;
    if (docRef.current) {
      pendingSave.current = docRef.current;
      saveNow();
    }
  }, [saveNow]);
  useEffect(() => {
    let live = true;
    readAutosave()
      .then((raw) => {
        if (!live) return;
        restoreFinished();
        const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
        const parsed = rec ? parseProject(rec.project) : null;
        // Never clobber an image the user loaded while the autosave was being read.
        if (!parsed?.ok || docRef.current !== null) return;
        const active = typeof rec?.activeDatasetId === 'string' ? rec.activeDatasetId : undefined;
        const restored = fromProject(parsed.project, active);
        startLog(restored.image, 'autosave');
        historyDispatch({ type: 'reset', doc: restored });
        setStep(stepFor(restored));
        setTrace(defaultTrace(restored, traceSettingsRef.current.mode));
        if (Array.isArray(rec?.collapsed)) setCollapsed(new Set(rec.collapsed.filter((id): id is string => typeof id === 'string')));
        const at = typeof rec?.savedAt === 'number' ? `, autosaved at ${timeOf(rec.savedAt)}` : '';
        setNotice({ kind: 'info', text: `Restored ${restored.image.name} from your last session${at}.` });
      })
      .catch(restoreFinished);
    return () => {
      live = false;
    };
  }, [restoreFinished, startLog]);

  useEffect(() => {
    if (!doc || !restoreDone.current) return;
    pendingSave.current = doc;
    const t = setTimeout(saveNow, 400);
    return () => clearTimeout(t);
  }, [doc, collapsed, saveNow]);
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', saveNow);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [saveNow]);

  // Paste an image (or a project file) from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = firstFile(e.clipboardData);
      if (file && (file.type.startsWith('image/') || isProjectFile(file))) {
        e.preventDefault();
        void handleFile(file);
      } else if (!isTypingTarget(e.target)) {
        setNotice({ kind: 'error', text: 'The clipboard does not contain an image.' });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFile]);

  /** Delete the selected ref, or every selected point as one undo step. */
  const deleteSelected = useCallback(() => {
    const first = selection[0];
    if (!first) return;
    if (first.kind === 'ref') {
      dispatch({ type: 'clear-ref', ref: first.ref });
      setChosenRef(null);
    } else {
      const points = selectedPoints(selection);
      dispatch({ type: 'delete-points', points: points.map(({ datasetId, pointId }) => ({ datasetId, pointId })) });
      if (points.length > 1) setNotice({ kind: 'info', text: `Deleted ${points.length} points.`, undoRev: history.rev + 1 });
    }
    setSelection(EMPTY_SELECTION);
  }, [selection, dispatch, history.rev]);

  const saveProject = useCallback(() => {
    if (!doc) return;
    const filename = `${baseName(doc.image.name)}-project.json`;
    record({ type: 'export', kind: 'project', filename });
    downloadText(filename, JSON.stringify(toProject(doc), null, 2), 'application/json');
  }, [doc, record]);

  /** "Download session log": the export is the last event of the file it writes. */
  const downloadSessionLog = useCallback(() => {
    const header = sessionLog.file()?.header;
    if (!header) return;
    const filename = sessionLogFilename(baseName(header.imageName));
    sessionLog.record({ type: 'export', kind: 'session-log', filename });
    const file = sessionLog.file();
    if (file) downloadText(filename, serializeLog(file), 'application/json');
  }, [sessionLog]);

  /** Snap toggle (toolbar, S): a setting the session log records. */
  const toggleSnap = useCallback(() => {
    const snap = !prefs.snap;
    setPrefs((p) => ({ ...p, snap }));
    record({ type: 'setting-changed', key: 'snap', value: snap });
  }, [prefs.snap, record]);

  /**
   * A trace under review (a result shown) is being closed without Accept — Discard, Escape,
   * leaving or re-entering the step, "+ Add line", starting another trace: log it as discarded.
   */
  const noteTraceDropped = useCallback(() => {
    if (!doc || trace?.status !== 'done') return;
    record({
      type: 'trace-discarded',
      datasetId: trace.target === 'new' ? null : doc.activeDatasetId,
      pointCount: trace.result.ok ? tracedPoints(doc, trace.result).length : 0,
    });
  }, [doc, trace, record]);

  /**
   * Arrow keys move the selection (the ref in Axes, every selected point together in Data);
   * returns whether it did.
   */
  const nudgeSelected = useCallback(
    (e: KeyboardEvent): boolean => {
      const dir = nudgeDirection(e.key);
      const first = selection[0];
      if (!dir || !doc || !first) return false;
      if ((first.kind === 'ref' ? 'axes' : 'data') !== step) return false;
      const amount = nudgeStep(e);
      // Holding a key (or pressing it repeatedly) on one selection is one undo step.
      const group = `nudge:${selection.map(targetKey).join(',')}:${e.key}:${amount}`;
      setLoupeOnSelection(true);
      if (first.kind === 'ref') {
        const pos = findTargetPos(doc, first);
        if (!pos) return false;
        const p = nudged(pos, dir, amount, doc.image.width, doc.image.height);
        if (p.px !== pos.px || p.py !== pos.py) dispatch({ type: 'place-ref', ref: first.ref, ...p }, group);
        return true;
      }
      const points = selectedPoints(selection);
      const from = points.map((t) => findTargetPos(doc, t) ?? { px: 0, py: 0 });
      const to = nudgedAll(from, dir, amount, doc.image.width, doc.image.height);
      const moves = points.map(({ datasetId, pointId }, i) => ({ datasetId, pointId, ...to[i]! }));
      dispatch({ type: 'move-points', moves }, group);
      return true;
    },
    [doc, selection, step, dispatch],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        // Undo/redo work everywhere, text fields included: every edit is in the app's history.
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'y') {
          e.preventDefault();
          if (k === 'y' || e.shiftKey) redo();
          else undo();
        } else if (k === 's') {
          e.preventDefault();
          saveProject();
        } else if (k === 'o') {
          e.preventDefault();
          projectInput.current?.click();
        }
        return;
      }
      if (e.key === 'Escape' && crop) {
        // Leaves crop mode even from its inputs (the panel's Cancel button does the same).
        setCrop(null);
        return;
      }
      if (mod || isTypingTarget(e.target)) return;
      if (nudgeSelected(e)) {
        e.preventDefault(); // Alt+Left would otherwise navigate back.
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.length > 0) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === 'Escape') {
        noteTraceDropped();
        setTrace(null);
        setSelection(EMPTY_SELECTION);
        setChosenRef(null);
        setLoupeOnSelection(false);
      } else if (e.key === 'f' || e.key === 'F') {
        fit();
      } else if (e.key === 'z' || e.key === 'Z') {
        setPrefs((p) => ({ ...p, loupe: !p.loupe }));
      } else if (e.key === 's' || e.key === 'S') {
        toggleSnap();
      } else if ((e.key === 'm' || e.key === 'M') && step === 'data') {
        setPrefs((p) => ({ ...p, movePoints: !p.movePoints }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, step, crop, deleteSelected, fit, undo, redo, saveProject, nudgeSelected, toggleSnap, noteTraceDropped]);

  const onCursor = useCallback((pos: { px: number; py: number } | null) => {
    setCursor(pos);
    setLoupeOnSelection(false);
  }, []);

  const onPlaceRef = useCallback(
    (ref: RefName, px: number, py: number) => {
      const isNew = !doc?.refs[ref];
      dispatch({ type: 'place-ref', ref, px, py });
      setChosenRef(null);
      setSelection([{ kind: 'ref', ref }]);
      if (isNew || doc?.refs[ref]?.value.trim() === '') setFocusRef(ref);
    },
    [doc, dispatch],
  );

  const expandLine = useCallback(
    (datasetId: string) => setCollapsed((c) => (c.has(datasetId) ? new Set([...c].filter((id) => id !== datasetId)) : c)),
    [],
  );

  const onAddPoint = useCallback(
    (px: number, py: number, snapped: boolean) => {
      if (!doc) return;
      const point = { id: newId(), px, py };
      dispatch({ type: 'add-point', datasetId: doc.activeDatasetId, point }, undefined, { snapped });
      setSelection([{ kind: 'point', datasetId: doc.activeDatasetId, pointId: point.id }]);
      expandLine(doc.activeDatasetId);
    },
    [doc, dispatch, expandLine],
  );

  const onMoveTargets = useCallback(
    (moves: { target: Target; px: number; py: number }[], gesture: number) => {
      const group = `drag:${gesture}`;
      const points = moves.flatMap(({ target: t, px, py }) => {
        if (t.kind === 'ref') {
          dispatch({ type: 'place-ref', ref: t.ref, px, py }, group);
          return [];
        }
        return [{ datasetId: t.datasetId, pointId: t.pointId, px, py }];
      });
      if (points.length > 0) dispatch({ type: 'move-points', moves: points }, group);
    },
    [dispatch],
  );

  /**
   * A pick on the canvas or in the table. `activate`: the picked point's line becomes the active
   * one when the pick leaves it selected (a click or Shift+click, not a marquee).
   */
  const onSelect = useCallback(
    (targets: readonly Target[], how: SelectHow = 'replace', activate = true) => {
      const next = applySelect(selection, targets, how);
      setSelection(next);
      setLoupeOnSelection(false);
      const picked = targets.length === 1 ? targets[0]! : null;
      if (activate && picked?.kind === 'point' && next.some((t) => targetKey(t) === targetKey(picked)) && doc && picked.datasetId !== doc.activeDatasetId) {
        dispatch({ type: 'set-active-dataset', datasetId: picked.datasetId });
      }
      // The current (last selected) point's row is shown, so its line's list opens.
      const last = lastPoint(next);
      if (last && targets.some((t) => targetKey(t) === targetKey(last))) expandLine(last.datasetId);
    },
    [doc, selection, dispatch, expandLine],
  );

  /** "Select all" in a line's table header: every point of that line, which becomes active. */
  const onSelectLine = useCallback(
    (datasetId: string) => {
      if (!doc) return;
      setSelection(linePoints(doc, datasetId));
      setLoupeOnSelection(false);
      if (datasetId !== doc.activeDatasetId) dispatch({ type: 'set-active-dataset', datasetId });
      expandLine(datasetId);
    },
    [doc, dispatch, expandLine],
  );

  const onToggleLine = useCallback(
    (datasetId: string) =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (!next.delete(datasetId)) next.add(datasetId);
        return next;
      }),
    [],
  );

  const onCollapseAll = useCallback(
    (collapse: boolean) => setCollapsed(collapse && doc ? new Set(doc.datasets.map((d) => d.id)) : new Set()),
    [doc],
  );

  const tableOptions: TableOptions = useMemo(
    () => ({
      significantFigures: doc?.settings.significantFigures ?? 4,
      dateFormat: doc?.settings.dateFormat ?? '',
      ...tableView,
    }),
    [doc?.settings, tableView],
  );

  const onTableOptions = useCallback(
    (patch: Partial<TableOptions>) => {
      const { significantFigures, dateFormat, ...rest } = patch;
      if (significantFigures !== undefined) dispatch({ type: 'set-settings', settings: { significantFigures } }, 'settings:significantFigures');
      if (dateFormat !== undefined) dispatch({ type: 'set-settings', settings: { dateFormat } }, 'settings:dateFormat');
      if (Object.keys(rest).length > 0) setTableView((v) => ({ ...v, ...rest }));
    },
    [dispatch],
  );

  const cells = useCallback(
    () => (doc ? exportCells(doc.datasets, calibration, { xScale: doc.xScale, yScale: doc.yScale }, tableOptions) : []),
    [doc, calibration, tableOptions],
  );

  const onExportCsv = useCallback(() => {
    if (!doc) return;
    const filename = `${baseName(doc.image.name)}-data.csv`;
    record({ type: 'export', kind: 'csv', filename });
    downloadText(filename, toCsv(cells()), 'text/csv;charset=utf-8');
  }, [doc, cells, record]);

  const onCopyTsv = useCallback(async () => {
    const rows = cells();
    const ok = await copyText(toTsv(rows));
    setNotice(
      ok
        ? { kind: 'info', text: `Copied ${rows.length - 1} rows as TSV — paste into a spreadsheet.` }
        : { kind: 'error', text: 'Copying to the clipboard failed. Use Download CSV instead.' },
    );
  }, [cells]);

  const addDataset = () => {
    if (!doc) return;
    dispatch({ type: 'add-dataset', dataset: { id: newId(), ...nextDatasetDefaults(doc), points: [] } });
    // The new line is the active one: Auto-trace opens for it (dropping a trace under review).
    const next = defaultTrace(doc, traceSettings.mode);
    if (next) {
      noteTraceDropped();
      setTrace(next);
      setSelection(EMPTY_SELECTION);
    }
  };

  const deleteDataset = (id: string) => {
    const d = doc?.datasets.find((x) => x.id === id);
    if (!d || !doc || doc.datasets.length <= 1) return;
    dispatch({ type: 'delete-dataset', datasetId: id });
    const n = d.points.length;
    setNotice({ kind: 'info', text: `Deleted "${d.name}"${n > 0 ? ` and its ${n} point${n === 1 ? '' : 's'}` : ''}.`, undoRev: history.rev + 1 });
  };

  const zoomBy = (factor: number) => {
    const { width, height } = viewport.current;
    setView((v) => zoomAt(v, width / 2, height / 2, factor));
  };

  const onAutoDetect = useCallback(() => {
    const pixels = image && imagePixels(image);
    if (!doc || !pixels) return;
    const of = doc.image;
    autoRun.current?.cancel();
    const run = runAutoDetect(pixels, (stage) =>
      setAuto((a) => (a?.of === of && a.state.status === 'running' ? { of, state: { status: 'running', stage } } : a)),
    );
    autoRun.current = run;
    setAuto({ of, state: { status: 'running', stage: 'Starting…' } });
    const started = performance.now();
    const generation = sessionLog.generation;
    // Logged once it settles, unless a newer run or a new image superseded it.
    const logRun = (result: Parameters<typeof autoDetectEvent>[0]) => {
      if (autoRun.current === run && sessionLog.generation === generation) sessionLog.record(autoDetectEvent(result, performance.now() - started));
    };
    run.result.then(
      (result) => {
        logRun(result);
        if (autoRun.current === run) setAuto({ of, state: { status: 'done', result, values: initialValues(result) } });
      },
      (err: unknown) => {
        logRun(null);
        if (autoRun.current === run) setAuto({ of, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
      },
    );
  }, [doc, image, sessionLog]);

  const onAutoValue = useCallback((ref: RefName, value: string) => {
    setAuto((a) => (a?.state.status === 'done' ? { of: a.of, state: { ...a.state, values: { ...a.state.values, [ref]: value } } } : a));
  }, []);

  const onAutoAccept = () => {
    if (auto.status !== 'done') return;
    const suggested = initialValues(auto.result);
    record({ type: 'suggestion-accepted', editedFields: REF_NAMES.filter((r) => r in suggested && auto.values[r] !== suggested[r]) });
    dispatch(acceptAction(auto.result, auto.values));
    setAuto(null);
    setChosenRef(null);
    setNotice({
      kind: 'info',
      text: 'Applied the suggested calibration. Check the overlay gridlines against the chart.',
      undoRev: history.rev + 1,
    });
  };

  /** "Auto-trace line" runs in the session's mode, "Find points" in markers mode. */
  const onTraceStart = (target: TraceTarget, mode: TraceMode = traceSettings.mode) => {
    if (!doc) return;
    noteTraceDropped();
    setTrace({ of: doc.image, state: { status: 'picking', target, mode } });
    setSelection(EMPTY_SELECTION);
  };

  const onTraceSeed = useCallback(
    (px: number, py: number) =>
      setTrace((t) => (t ? { of: t.of, state: { status: 'running', target: t.state.target, mode: t.state.mode, seed: { px, py } } } : t)),
    [],
  );

  const onTraceSettings = (patch: Partial<TraceSettings>) => {
    if (patch.mode !== undefined) record({ type: 'setting-changed', key: 'traceMode', value: patch.mode });
    // Dragging the Points slider is one event (its latest value), like an undo group.
    if (patch.maxPoints !== undefined) record({ type: 'setting-changed', key: 'traceMaxPoints', value: clampMaxPoints(patch.maxPoints) }, 'setting:traceMaxPoints');
    setTraceSettings((s) => ({ ...s, ...patch, maxPoints: clampMaxPoints(patch.maxPoints ?? s.maxPoints) }));
    // A trace under review re-runs from the same click with the new settings (a new mode is its own).
    setTrace((t) => {
      if (!t) return t;
      const mode = patch.mode ?? t.state.mode;
      return t.state.status === 'picking'
        ? { of: t.of, state: { ...t.state, mode } }
        : { of: t.of, state: { status: 'running', target: t.state.target, mode, seed: t.state.seed } };
    });
  };

  const traceCount = trace?.status === 'done' && trace.result.ok && doc ? tracedPoints(doc, trace.result).length : 0;

  const onTraceAccept = () => {
    if (!doc || trace?.status !== 'done') return;
    const action = acceptTraceAction(doc, trace.target, trace.result, newId);
    if (!action) return;
    dispatch(action);
    record(
      action.type === 'add-dataset'
        ? { type: 'trace-accepted', datasetId: action.dataset.id, pointCount: action.dataset.points.length }
        : { type: 'trace-accepted', datasetId: doc.activeDatasetId, pointCount: action.type === 'add-points' ? action.points.length : 0 },
    );
    setTrace(null);
    setSelection(EMPTY_SELECTION);
    const into = action.type === 'add-dataset' ? `a new line, "${action.dataset.name}"` : `"${doc.datasets.find((d) => d.id === doc.activeDatasetId)?.name}"`;
    setNotice({ kind: 'info', text: `Added ${traceCount} traced point${traceCount === 1 ? '' : 's'} to ${into}.`, undoRev: history.rev + 1 });
  };

  const cursorValue = cursor && calibration ? calibration.pixelToValue(cursor.px, cursor.py) : null;
  const totalPoints = doc?.datasets.reduce((n, d) => n + d.points.length, 0) ?? 0;

  const goStep = (s: Step) => {
    noteTraceDropped();
    setStep(s);
    setTrace(s === 'data' ? defaultTrace(doc, traceSettings.mode) : null);
    setCrop(null);
    setSelection(EMPTY_SELECTION);
    setChosenRef(null);
  };

  /** A drag on the canvas in crop mode (re)draws the rectangle. */
  const onCropRect = useCallback((rect: CropRect) => setCrop((c) => (c ? { ...c, rect } : c)), []);

  /**
   * "Crop…" (toolbar and Image step): enters crop mode on the Image step — from any step, since
   * loading an image moves straight to Axes — or leaves it when pressed again.
   */
  const toggleCrop = () => {
    if (crop) {
      setCrop(null);
      return;
    }
    if (!doc || !image) return;
    if (step !== 'image') goStep('image');
    setCrop({ of: doc.image, rect: null });
  };

  /** An edit in the crop panel: the rectangle starts from the whole image when none exists yet. */
  const onCropField = (field: CropField, value: number) => {
    if (!doc) return;
    const { width, height } = doc.image;
    setCrop((c) => (c ? { ...c, rect: setCropField(c.rect ?? fullCrop(width, height), field, value, width, height) } : c));
  };

  /**
   * Apply the crop: the document's image becomes the cut-out and every ref and point moves with
   * it (one undo step); the image effect above re-decodes and re-fits it. Crop mode ends.
   */
  const applyCrop = () => {
    if (!doc || !image || !crop?.rect) return;
    const rect = crop.rect;
    let cropped: DocState['image'];
    try {
      cropped = cropImage(image, doc.image, rect);
    } catch {
      setNotice({ kind: 'error', text: 'The image could not be cropped.' });
      return;
    }
    const lost = cropLosses(doc, rect.x0, rect.y0, cropped.width, cropped.height);
    dispatch({ type: 'crop', image: cropped, x0: rect.x0, y0: rect.y0 });
    setCrop(null);
    setSelection(EMPTY_SELECTION);
    setChosenRef(null);
    setNotice({ kind: 'info', text: `Cropped to ${cropped.width} × ${cropped.height} px.${removedByCrop(lost)}`, undoRev: history.rev + 1 });
  };

  const loupe = useMemo(() => ({ enabled: prefs.loupe, zoom: prefs.loupeZoom }), [prefs.loupe, prefs.loupeZoom]);
  const showUndo = notice?.undoRev !== undefined && notice.undoRev === history.rev && canUndo(history);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Graph Digitizer</h1>
        <div className="tool-group" role="group" aria-label="File">
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open image…
          </button>
          <button
            type="button"
            className="toggle"
            aria-pressed={crop !== null}
            disabled={!image}
            onClick={toggleCrop}
            title="Crop the image to one panel (opens the Image step); refs and points move with it (undoable)"
          >
            Crop…
          </button>
          <button type="button" onClick={() => projectInput.current?.click()} title="Open a saved project (Ctrl+O)">
            Open project…
          </button>
          <button type="button" onClick={saveProject} disabled={!doc} title="Save the project with its image as a .json file (Ctrl+S)">
            Save project
          </button>
          <button
            type="button"
            onClick={downloadSessionLog}
            disabled={!doc}
            data-testid="session-log"
            aria-label="Download session log"
            title="Download session log: what was done with this image (times, steps, edits, exports) as a .json file. Kept in this tab only; no image data."
          >
            Session log
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={[...ACCEPTED_IMAGE_TYPES, 'image/*'].join(',')}
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void handleFile(f);
          }}
        />
        <input
          ref={projectInput}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="project-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void openProject(f);
          }}
        />
        <div className="tool-group" role="group" aria-label="History">
          <button type="button" className="icon-text" onClick={undo} disabled={!canUndo(history)} aria-label="Undo" title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button type="button" className="icon-text" onClick={redo} disabled={!canRedo(history)} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
        </div>
        <div className="zoom tool-group" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.25)} disabled={!doc} aria-label="Zoom out">
            −
          </button>
          <span className="zoom-level" data-testid="zoom-level">
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" onClick={() => zoomBy(1.25)} disabled={!doc} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={fit} disabled={!doc} title="Fit to window (F)">
            Fit
          </button>
        </div>
        <div className="tool-group" role="group" aria-label="Precision">
          <button
            type="button"
            className="toggle"
            aria-pressed={prefs.loupe}
            onClick={() => setPrefs((p) => ({ ...p, loupe: !p.loupe }))}
            title="Magnifier loupe while placing and dragging (Z)"
          >
            Loupe
          </button>
          <select
            value={prefs.loupeZoom}
            onChange={(e) => setPrefs((p) => ({ ...p, loupeZoom: Number(e.target.value) }))}
            aria-label="Loupe zoom"
            title="Loupe magnification, relative to the main view"
          >
            {LOUPE_ZOOMS.map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
          <button
            type="button"
            className="toggle"
            aria-pressed={prefs.snap}
            onClick={toggleSnap}
            title="Snap new points to the centre of the nearest small marker (S)"
          >
            Snap
          </button>
        </div>
        <div className="tool-group" role="group" aria-label="Edit">
          <button
            type="button"
            className="toggle icon-label"
            aria-pressed={prefs.movePoints}
            disabled={step !== 'data'}
            onClick={() => setPrefs((p) => ({ ...p, movePoints: !p.movePoints }))}
            title={
              step === 'data'
                ? 'Move points (M): select, drag and box-select points. Off: every click places a new point.'
                : 'Move points (M) — in the Data step'
            }
          >
            <HandIcon />
            Move points
          </button>
        </div>
        <div className="spacer" />
        <ThemeToggle />
      </header>

      <main className="main">
        <Workspace
          doc={doc}
          image={image}
          calibration={calibration}
          step={step}
          view={view}
          onViewChange={setView}
          onViewportSize={onViewportSize}
          selection={selection}
          onSelect={onSelect}
          placingRef={step === 'axes' ? placingRef : null}
          onPlaceRef={onPlaceRef}
          onAddPoint={onAddPoint}
          onMoveTargets={onMoveTargets}
          onCursor={onCursor}
          onFile={(f) => void handleFile(f)}
          onOpenFile={() => fileInput.current?.click()}
          loupe={loupe}
          loupeOnSelection={loupeOnSelection}
          snap={prefs.snap}
          movePoints={prefs.movePoints}
          ghost={ghost}
          tracing={trace !== null}
          tracePrompt={trace?.status === 'picking' ? promptFor(trace.mode) : null}
          onTraceSeed={onTraceSeed}
          traceGhost={traceGhost}
          crop={crop ? { rect: crop.rect, onRect: onCropRect } : null}
        />

        <aside className="panel">
          <nav className="steps" aria-label="Steps">
            {STEPS.map((s, i) => {
              const done = s.id === 'image' ? !!doc : s.id === 'axes' ? !!calibration : totalPoints > 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`step-tab${step === s.id ? ' current' : ''}${done ? ' done' : ''}`}
                  onClick={() => goStep(s.id)}
                  disabled={s.id !== 'image' && !doc}
                  aria-current={step === s.id ? 'step' : undefined}
                >
                  <span className="step-num">{done ? '✓' : i + 1}</span>
                  {s.label}
                </button>
              );
            })}
          </nav>

          <div className="step-scroll">
            {step === 'image' && (
              <section className="step-body" aria-label="Image">
                <p className="prompt">Load the chart you want to digitize.</p>
                <div className="row">
                  <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                    Choose image…
                  </button>
                  <button type="button" onClick={() => projectInput.current?.click()}>
                    Open project…
                  </button>
                </div>
                <p className="muted">
                  Or drop a file onto the workspace, or paste an image with <kbd>Ctrl</kbd>+<kbd>V</kbd>. PNG, JPEG,
                  GIF, WebP and BMP work, and saved project (.json) files. Nothing is uploaded: the image stays in this
                  browser, and your work is autosaved here.
                </p>
                {doc && (
                  <>
                    <p data-testid="image-current">
                      Current: <strong>{doc.image.name}</strong>, {doc.image.width} × {doc.image.height} px.{' '}
                      <button type="button" className="link" onClick={() => goStep('axes')}>
                        Calibrate axes →
                      </button>
                    </p>
                    <p className="muted">Figure with several panels? Crop to the one you want.</p>
                    <div className="row">
                      <button
                        type="button"
                        className="toggle"
                        aria-pressed={crop !== null}
                        disabled={!image}
                        onClick={toggleCrop}
                        title="Crop the image to a rectangle; refs and points move with it (undoable)"
                      >
                        Crop…
                      </button>
                    </div>
                    {crop && (
                      <CropPanel
                        rect={crop.rect}
                        imageWidth={doc.image.width}
                        imageHeight={doc.image.height}
                        onField={onCropField}
                        onApply={applyCrop}
                        onCancel={() => setCrop(null)}
                      />
                    )}
                  </>
                )}
              </section>
            )}
            {step === 'axes' && doc && (
              <AxesStep
                doc={doc}
                result={result}
                placingRef={placingRef}
                focusRef={focusRef}
                onFocused={onFocused}
                onScale={(axis, scale) => dispatch({ type: 'set-scale', axis, scale })}
                onValue={(ref, value) => dispatch({ type: 'set-ref-value', ref, value }, `value:${ref}`)}
                onPlace={setChosenRef}
                onContinue={() => goStep('data')}
                auto={auto}
                canAutoDetect={!!image}
                onAutoDetect={onAutoDetect}
                onAutoValue={onAutoValue}
                onAutoAccept={onAutoAccept}
                onAutoDiscard={() => {
                  record({ type: 'suggestion-discarded' });
                  setAuto(null);
                }}
              />
            )}
            {step === 'data' && doc && (
              <DataStep
                doc={doc}
                calibrated={!!calibration}
                selectedCount={selectedPointCount}
                onActivate={(id) => dispatch({ type: 'set-active-dataset', datasetId: id })}
                onRename={(id, name) => dispatch({ type: 'rename-dataset', datasetId: id, name }, `rename:${id}`)}
                onRecolor={(id, color) => dispatch({ type: 'recolor-dataset', datasetId: id, color }, `recolor:${id}`)}
                onDelete={deleteDataset}
                onAdd={addDataset}
                onDeleteSelected={deleteSelected}
                movePoints={prefs.movePoints}
                trace={{
                  trace,
                  settings: traceSettings,
                  canTrace: !!calibration && !!image,
                  color: traceColor(doc, trace?.target ?? 'active', trace?.status === 'done' ? trace.result : null),
                  count: traceCount,
                  onStart: onTraceStart,
                  onSettings: onTraceSettings,
                  onAccept: onTraceAccept,
                  onDiscard: () => {
                    noteTraceDropped();
                    setTrace(null);
                  },
                }}
              />
            )}
          </div>

          {doc && (
            <DataTable
              doc={doc}
              calibration={calibration}
              options={tableOptions}
              selection={selection}
              collapsed={collapsed}
              onToggle={onToggleLine}
              onCollapseAll={onCollapseAll}
              onSelect={onSelect}
              onSelectLine={onSelectLine}
              onOptions={onTableOptions}
              onExportCsv={onExportCsv}
              onCopyTsv={() => void onCopyTsv()}
              onExportJson={saveProject}
            />
          )}
        </aside>

        {/* A snackbar over the bottom of the canvas area: never takes toolbar width, so it stays
            readable whatever the font (SPEC → Notices). Only its buttons catch the pointer. */}
        {notice && (
          <div className="notice-layer">
            <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="notice" title={notice.text}>
              <span className="notice-text">{notice.text}</span>
              {showUndo && (
                <button type="button" className="small" onClick={undo}>
                  Undo
                </button>
              )}
              <button type="button" className="icon" onClick={() => setNotice(null)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar" data-testid="statusbar">
        {cursor ? (
          <>
            <span data-testid="cursor-px">
              px ({cursor.px.toFixed(1)}, {cursor.py.toFixed(1)})
            </span>
            {doc && cursorValue && (
              <span data-testid="cursor-value">
                x = {formatValue(cursorValue.x, doc.xScale, tableOptions) || '—'}, y ={' '}
                {formatValue(cursorValue.y, doc.yScale, tableOptions) || '—'}
              </span>
            )}
          </>
        ) : (
          <span className="muted">{doc ? 'Move over the image to read coordinates.' : 'No image loaded.'}</span>
        )}
        <span className="spacer" />
        {autosaved && (
          <span className={autosaved.ok ? 'muted' : 'bad'} data-testid="autosave">
            {autosaved.ok ? `Autosaved ${timeOf(autosaved.at)}` : 'Autosave failed (storage full or blocked)'}
          </span>
        )}
        <span className="muted shortcuts">
          Wheel: zoom · Space/middle-drag: pan · Arrows: nudge (Shift ×10, Alt ×0.1) · M: move points · Z: loupe · S: snap · F: fit
        </span>
        <span className="muted credit">
          Brian Anderson, UC San Diego ·{' '}
          <a href="https://github.com/brianmanderson/UCSD_GraphEvaluator" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}
