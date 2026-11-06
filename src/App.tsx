import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { calibrateSpec, parseProject, parseProjectText, type Project, type RefName } from './core/index.ts';
import { AxesStep } from './components/AxesStep.tsx';
import { DataStep } from './components/DataStep.tsx';
import { DataTable } from './components/DataTable.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Workspace, type Step } from './components/Workspace.tsx';
import {
  calibrationSpec,
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
import { findTargetPos, type Target } from './ui/draw.ts';
import { baseName, copyText, downloadText } from './ui/export.ts';
import { runAutoDetect, type AutoRun } from './ui/autoDetect.ts';
import { runTrace, type TraceRun } from './ui/autoTrace.ts';
import type { TraceMode } from './auto/trace/types.ts';
import { ACCEPTED_IMAGE_TYPES, decodeImage, firstFile, imagePixels, isProjectFile, loadImageFile } from './ui/loadImage.ts';
import { DEFAULT_LOUPE_ZOOM, LOUPE_ZOOMS } from './ui/loupe.ts';
import { nudgeDirection, nudgeStep, nudged } from './ui/nudge.ts';
import { acceptAction, ghostOf, initialValues, type AutoState } from './ui/suggestion.ts';
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

/** The step to show for a restored or opened document: Data once the axes are calibrated. */
function stepFor(doc: DocState): Step {
  const spec = calibrationSpec(doc);
  return spec && calibrateSpec(spec).ok ? 'data' : 'axes';
}

const targetKey = (t: Target) => (t.kind === 'ref' ? t.ref : `${t.datasetId}/${t.pointId}`);

/** Precision-tool preferences, remembered per browser (not part of the project). */
interface Prefs {
  loupe: boolean;
  loupeZoom: number;
  snap: boolean;
}
const PREFS_KEY = 'graph-digitizer:prefs';
const DEFAULT_PREFS: Prefs = { loupe: true, loupeZoom: DEFAULT_LOUPE_ZOOM, snap: false };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      loupe: typeof raw.loupe === 'boolean' ? raw.loupe : DEFAULT_PREFS.loupe,
      loupeZoom: (LOUPE_ZOOMS as readonly number[]).includes(raw.loupeZoom ?? NaN) ? raw.loupeZoom! : DEFAULT_PREFS.loupeZoom,
      snap: typeof raw.snap === 'boolean' ? raw.snap : DEFAULT_PREFS.snap,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Settings changes (dragging the Points slider) settle this long before the trace re-runs. */
const TRACE_DEBOUNCE_MS = 120;

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function App() {
  const [history, historyDispatch] = useReducer(historyReducer, EMPTY_HISTORY);
  const doc = history.present;
  const [step, setStep] = useState<Step>('image');
  /** The decoded image, tagged with the document image it was decoded from. */
  const [decoded, setDecoded] = useState<{ of: DocState['image']; el: HTMLImageElement } | null>(null);
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const viewport = useRef({ width: 0, height: 0 });
  const [selectedRaw, setSelected] = useState<Target | null>(null);
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
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);

  const dispatch = useCallback((action: AppAction, group?: string) => {
    historyDispatch(group === undefined ? { type: 'edit', action } : { type: 'edit', action, group });
  }, []);
  const undo = useCallback(() => historyDispatch({ type: 'undo' }), []);
  const redo = useCallback(() => historyDispatch({ type: 'redo' }), []);
  const onFocused = useCallback(() => setFocusRef(null), []);

  // A selection whose marker an undo removed is no selection.
  const selected = selectedRaw && doc && findTargetPos(doc, selectedRaw) ? selectedRaw : null;
  const image = decoded && doc && decoded.of === doc.image ? decoded.el : null;
  // A suggestion belongs to the image it was made for (a load or an undo across one drops it).
  const auto: AutoState = useMemo(
    () => (autoRaw && doc && autoRaw.of === doc.image ? autoRaw.state : { status: 'idle' }),
    [autoRaw, doc],
  );
  const ghost = useMemo(() => ghostOf(auto), [auto]);
  const trace = traceRaw && doc && traceRaw.of === doc.image && step === 'data' ? traceRaw.state : null;
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
      run = runTrace(pixels, runningSeed, runningMode, traceSettings.maxPoints);
      run.result.then(
        (result) => settle((target, mode) => ({ status: 'done', target, mode, seed: runningSeed, result })),
        (err: unknown) =>
          settle((target, mode) => ({ status: 'error', target, mode, seed: runningSeed, message: err instanceof Error ? err.message : String(err) })),
      );
    }, TRACE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      run?.cancel();
    };
  }, [runningSeed, runningMode, traceSettings, image, docImage]);

  /** Replace the document with an undoable step, and say so with an Undo button when work was replaced. */
  const replaceDoc = useCallback(
    (next: DocState, text: string) => {
      const replacesWork = hasWork(doc);
      dispatch({ type: 'replace-doc', doc: next });
      setSelected(null);
      setChosenRef(null);
      setStep(stepFor(next));
      setNotice({
        kind: 'info',
        text: replacesWork ? `${text} Undo brings back the previous work.` : text,
        ...(replacesWork && { undoRev: history.rev + 1 }),
      });
    },
    [doc, dispatch, history.rev],
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
      replaceDoc(fromProject(project), `Opened ${file.name}${migrated}.`);
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
      replaceDoc(next, `Loaded ${loaded.image.name} (${loaded.image.width} × ${loaded.image.height} px).`);
    },
    [doc, openProject, replaceDoc],
  );

  // Autosave: restore the last session once on start, then save after every change (debounced).
  const docRef = useRef(doc);
  const collapsedRef = useRef(collapsed);
  useLayoutEffect(() => {
    docRef.current = doc;
    collapsedRef.current = collapsed;
  });
  const restoreDone = useRef(false);
  useEffect(() => {
    let live = true;
    readAutosave()
      .then((raw) => {
        if (!live) return;
        restoreDone.current = true;
        const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
        const parsed = rec ? parseProject(rec.project) : null;
        // Never clobber an image the user loaded while the autosave was being read.
        if (!parsed?.ok || docRef.current !== null) return;
        const active = typeof rec?.activeDatasetId === 'string' ? rec.activeDatasetId : undefined;
        const restored = fromProject(parsed.project, active);
        historyDispatch({ type: 'reset', doc: restored });
        setStep(stepFor(restored));
        if (Array.isArray(rec?.collapsed)) setCollapsed(new Set(rec.collapsed.filter((id): id is string => typeof id === 'string')));
        const at = typeof rec?.savedAt === 'number' ? `, autosaved at ${timeOf(rec.savedAt)}` : '';
        setNotice({ kind: 'info', text: `Restored ${restored.image.name} from your last session${at}.` });
      })
      .catch(() => {
        restoreDone.current = true;
      });
    return () => {
      live = false;
    };
  }, []);

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

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.kind === 'point') {
      dispatch({ type: 'delete-point', datasetId: selected.datasetId, pointId: selected.pointId });
    } else {
      dispatch({ type: 'clear-ref', ref: selected.ref });
      setChosenRef(null);
    }
    setSelected(null);
  }, [selected, dispatch]);

  const saveProject = useCallback(() => {
    if (!doc) return;
    downloadText(`${baseName(doc.image.name)}-project.json`, JSON.stringify(toProject(doc), null, 2), 'application/json');
  }, [doc]);

  /** Arrow keys move the selection (refs in Axes, points in Data); returns whether it did. */
  const nudgeSelected = useCallback(
    (e: KeyboardEvent): boolean => {
      const dir = nudgeDirection(e.key);
      if (!dir || !doc || !selected) return false;
      if ((selected.kind === 'ref' ? 'axes' : 'data') !== step) return false;
      const pos = findTargetPos(doc, selected);
      if (!pos) return false;
      const amount = nudgeStep(e);
      const p = nudged(pos, dir, amount, doc.image.width, doc.image.height);
      setLoupeOnSelection(true);
      if (p.px === pos.px && p.py === pos.py) return true;
      // Holding a key (or pressing it repeatedly) is one undo step.
      const group = `nudge:${targetKey(selected)}:${e.key}:${amount}`;
      if (selected.kind === 'ref') dispatch({ type: 'place-ref', ref: selected.ref, ...p }, group);
      else dispatch({ type: 'move-point', datasetId: selected.datasetId, pointId: selected.pointId, ...p }, group);
      return true;
    },
    [doc, selected, step, dispatch],
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
      if (mod || isTypingTarget(e.target)) return;
      if (nudgeSelected(e)) {
        e.preventDefault(); // Alt+Left would otherwise navigate back.
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === 'Escape') {
        setTrace(null);
        setSelected(null);
        setChosenRef(null);
        setLoupeOnSelection(false);
      } else if (e.key === 'f' || e.key === 'F') {
        fit();
      } else if (e.key === 'z' || e.key === 'Z') {
        setPrefs((p) => ({ ...p, loupe: !p.loupe }));
      } else if (e.key === 's' || e.key === 'S') {
        setPrefs((p) => ({ ...p, snap: !p.snap }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteSelected, fit, undo, redo, saveProject, nudgeSelected]);

  const onCursor = useCallback((pos: { px: number; py: number } | null) => {
    setCursor(pos);
    setLoupeOnSelection(false);
  }, []);

  const onPlaceRef = useCallback(
    (ref: RefName, px: number, py: number) => {
      const isNew = !doc?.refs[ref];
      dispatch({ type: 'place-ref', ref, px, py });
      setChosenRef(null);
      setSelected({ kind: 'ref', ref });
      if (isNew || doc?.refs[ref]?.value.trim() === '') setFocusRef(ref);
    },
    [doc, dispatch],
  );

  const expandLine = useCallback(
    (datasetId: string) => setCollapsed((c) => (c.has(datasetId) ? new Set([...c].filter((id) => id !== datasetId)) : c)),
    [],
  );

  const onAddPoint = useCallback(
    (px: number, py: number) => {
      if (!doc) return;
      const point = { id: newId(), px, py };
      dispatch({ type: 'add-point', datasetId: doc.activeDatasetId, point });
      setSelected({ kind: 'point', datasetId: doc.activeDatasetId, pointId: point.id });
      expandLine(doc.activeDatasetId);
    },
    [doc, dispatch, expandLine],
  );

  const onMoveTarget = useCallback(
    (t: Target, px: number, py: number, gesture: number) => {
      const group = `drag:${gesture}`;
      if (t.kind === 'ref') dispatch({ type: 'place-ref', ref: t.ref, px, py }, group);
      else dispatch({ type: 'move-point', datasetId: t.datasetId, pointId: t.pointId, px, py }, group);
    },
    [dispatch],
  );

  const onSelect = useCallback(
    (t: Target | null) => {
      setSelected(t);
      setLoupeOnSelection(false);
      if (t?.kind === 'point' && doc && t.datasetId !== doc.activeDatasetId) {
        dispatch({ type: 'set-active-dataset', datasetId: t.datasetId });
      }
      // A point selected on the canvas shows its row, so its line's list opens.
      if (t?.kind === 'point') expandLine(t.datasetId);
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
    downloadText(`${baseName(doc.image.name)}-data.csv`, toCsv(cells()), 'text/csv;charset=utf-8');
  }, [doc, cells]);

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
    run.result.then(
      (result) => autoRun.current === run && setAuto({ of, state: { status: 'done', result, values: initialValues(result) } }),
      (err: unknown) =>
        autoRun.current === run && setAuto({ of, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } }),
    );
  }, [doc, image]);

  const onAutoValue = useCallback((ref: RefName, value: string) => {
    setAuto((a) => (a?.state.status === 'done' ? { of: a.of, state: { ...a.state, values: { ...a.state.values, [ref]: value } } } : a));
  }, []);

  const onAutoAccept = () => {
    if (auto.status !== 'done') return;
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
    setTrace({ of: doc.image, state: { status: 'picking', target, mode } });
    setSelected(null);
  };

  const onTraceSeed = useCallback(
    (px: number, py: number) =>
      setTrace((t) => (t ? { of: t.of, state: { status: 'running', target: t.state.target, mode: t.state.mode, seed: { px, py } } } : t)),
    [],
  );

  const onTraceSettings = (patch: Partial<TraceSettings>) => {
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
    setTrace(null);
    const into = action.type === 'add-dataset' ? `a new line, "${action.dataset.name}"` : `"${doc.datasets.find((d) => d.id === doc.activeDatasetId)?.name}"`;
    setNotice({ kind: 'info', text: `Added ${traceCount} traced point${traceCount === 1 ? '' : 's'} to ${into}.`, undoRev: history.rev + 1 });
  };

  const cursorValue = cursor && calibration ? calibration.pixelToValue(cursor.px, cursor.py) : null;
  const totalPoints = doc?.datasets.reduce((n, d) => n + d.points.length, 0) ?? 0;

  const goStep = (s: Step) => {
    setStep(s);
    setTrace(null);
    setSelected(null);
    setChosenRef(null);
  };

  const loupe = useMemo(() => ({ enabled: prefs.loupe, zoom: prefs.loupeZoom }), [prefs.loupe, prefs.loupeZoom]);
  const showUndo = notice?.undoRev !== undefined && notice.undoRev === history.rev && canUndo(history);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Graph Digitizer</h1>
        <div className="tool-group">
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open image…
          </button>
          <button type="button" onClick={() => projectInput.current?.click()} title="Open a saved project (Ctrl+O)">
            Open project…
          </button>
          <button type="button" onClick={saveProject} disabled={!doc} title="Save the project with its image as a .json file (Ctrl+S)">
            Save project
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
            onClick={() => setPrefs((p) => ({ ...p, snap: !p.snap }))}
            title="Snap new points to the centre of the nearest small marker (S)"
          >
            Snap
          </button>
        </div>
        <div className="notice-slot">
          {notice && (
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
          )}
        </div>
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
          selected={selected}
          onSelect={onSelect}
          placingRef={step === 'axes' ? placingRef : null}
          onPlaceRef={onPlaceRef}
          onAddPoint={onAddPoint}
          onMoveTarget={onMoveTarget}
          onCursor={onCursor}
          onFile={(f) => void handleFile(f)}
          onOpenFile={() => fileInput.current?.click()}
          loupe={loupe}
          loupeOnSelection={loupeOnSelection}
          snap={prefs.snap}
          ghost={ghost}
          tracing={trace !== null}
          tracePrompt={trace?.status === 'picking' ? promptFor(trace.mode) : null}
          onTraceSeed={onTraceSeed}
          traceGhost={traceGhost}
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
                  <p>
                    Current: <strong>{doc.image.name}</strong>, {doc.image.width} × {doc.image.height} px.{' '}
                    <button type="button" className="link" onClick={() => goStep('axes')}>
                      Calibrate axes →
                    </button>
                  </p>
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
                onAutoDiscard={() => setAuto(null)}
              />
            )}
            {step === 'data' && doc && (
              <DataStep
                doc={doc}
                calibrated={!!calibration}
                selected={selected}
                onActivate={(id) => dispatch({ type: 'set-active-dataset', datasetId: id })}
                onRename={(id, name) => dispatch({ type: 'rename-dataset', datasetId: id, name }, `rename:${id}`)}
                onRecolor={(id, color) => dispatch({ type: 'recolor-dataset', datasetId: id, color }, `recolor:${id}`)}
                onDelete={deleteDataset}
                onAdd={addDataset}
                onDeleteSelected={deleteSelected}
                trace={{
                  trace,
                  settings: traceSettings,
                  canTrace: !!calibration && !!image,
                  color: traceColor(doc, trace?.target ?? 'active', trace?.status === 'done' ? trace.result : null),
                  count: traceCount,
                  onStart: onTraceStart,
                  onSettings: onTraceSettings,
                  onAccept: onTraceAccept,
                  onDiscard: () => setTrace(null),
                }}
              />
            )}
          </div>

          {doc && (
            <DataTable
              doc={doc}
              calibration={calibration}
              options={tableOptions}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggleLine}
              onCollapseAll={onCollapseAll}
              onSelect={onSelect}
              onOptions={onTableOptions}
              onExportCsv={onExportCsv}
              onCopyTsv={() => void onCopyTsv()}
              onExportJson={saveProject}
            />
          )}
        </aside>
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
        <span className="muted">
          Wheel: zoom · Space/middle-drag: pan · Arrows: nudge (Shift ×10, Alt ×0.1) · Z: loupe · S: snap · F: fit
        </span>
      </footer>
    </div>
  );
}
