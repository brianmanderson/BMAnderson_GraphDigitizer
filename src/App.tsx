import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { calibrateSpec, type RefName } from './core/index.ts';
import { AxesStep } from './components/AxesStep.tsx';
import { DataStep } from './components/DataStep.tsx';
import { DataTable } from './components/DataTable.tsx';
import { Workspace, type Step } from './components/Workspace.tsx';
import {
  appReducer,
  calibrationSpec,
  hasWork,
  newDoc,
  nextDatasetDefaults,
  nextUnplacedRef,
  toProject,
  type AppAction,
} from './state/doc.ts';
import type { Target } from './ui/draw.ts';
import { baseName, copyText, downloadText } from './ui/export.ts';
import { ACCEPTED_IMAGE_TYPES, decodeImage, firstFile, loadImageFile } from './ui/loadImage.ts';
import { exportCells, formatValue, toCsv, toTsv, type TableOptions } from './ui/table.ts';
import { IDENTITY_VIEW, fitView, zoomAt, type View } from './ui/view.ts';

type Notice = { kind: 'error' | 'info'; text: string };

const newId = () => crypto.randomUUID();

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const STEPS: { id: Step; label: string }[] = [
  { id: 'image', label: 'Image' },
  { id: 'axes', label: 'Axes' },
  { id: 'data', label: 'Data' },
];

export function App() {
  const [doc, rawDispatch] = useReducer(appReducer, null);
  const [step, setStep] = useState<Step>('image');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const viewport = useRef({ width: 0, height: 0 });
  const [selected, setSelected] = useState<Target | null>(null);
  /** A ref the user chose to (re-)place; otherwise the next unplaced ref is placed. */
  const [chosenRef, setChosenRef] = useState<RefName | null>(null);
  const [focusRef, setFocusRef] = useState<RefName | null>(null);
  const [cursor, setCursor] = useState<{ px: number; py: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tableView, setTableView] = useState({ showPixels: false, sortByX: false });
  const fileInput = useRef<HTMLInputElement>(null);

  const dispatch = useCallback((a: AppAction) => rawDispatch(a), []);
  const onFocused = useCallback(() => setFocusRef(null), []);

  const spec = useMemo(() => (doc ? calibrationSpec(doc) : null), [doc]);
  const result = useMemo(() => (spec ? calibrateSpec(spec) : null), [spec]);
  const calibration = result?.ok ? result.calibration : null;
  const placingRef = doc ? (chosenRef ?? nextUnplacedRef(doc.refs)) : null;

  // Decode the image for drawing whenever the document's image changes.
  const dataUrl = doc?.image.dataUrl;
  useEffect(() => {
    if (!dataUrl) return;
    let live = true;
    decodeImage(dataUrl).then(
      (img) => live && setImage(img),
      () => live && setNotice({ kind: 'error', text: 'The image could not be displayed.' }),
    );
    return () => {
      live = false;
    };
  }, [dataUrl]);


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

  const handleFile = useCallback(
    async (file: File) => {
      if (hasWork(doc) && !window.confirm('Load a new image? The current calibration and points will be cleared.')) return;
      const loaded = await loadImageFile(file);
      if (!loaded.ok) {
        setNotice({ kind: 'error', text: loaded.message });
        return;
      }
      setImage(null);
      dispatch({ type: 'replace-doc', doc: newDoc(loaded.image, newId(), doc?.settings) });
      setSelected(null);
      setChosenRef(null);
      setStep('axes');
      fitImage(loaded.image.width, loaded.image.height);
      setNotice({ kind: 'info', text: `Loaded ${loaded.image.name} (${loaded.image.width} × ${loaded.image.height} px).` });
    },
    [doc, dispatch, fitImage],
  );

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = firstFile(e.clipboardData);
      if (file && file.type.startsWith('image/')) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === 'Escape') {
        setSelected(null);
        setChosenRef(null);
      } else if (e.key === 'f' || e.key === 'F') {
        fit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteSelected, fit]);

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

  const onAddPoint = useCallback(
    (px: number, py: number) => {
      if (!doc) return;
      const point = { id: newId(), px, py };
      dispatch({ type: 'add-point', datasetId: doc.activeDatasetId, point });
      setSelected({ kind: 'point', datasetId: doc.activeDatasetId, pointId: point.id });
    },
    [doc, dispatch],
  );

  const onMoveTarget = useCallback(
    (t: Target, px: number, py: number) => {
      if (t.kind === 'ref') dispatch({ type: 'place-ref', ref: t.ref, px, py });
      else dispatch({ type: 'move-point', datasetId: t.datasetId, pointId: t.pointId, px, py });
    },
    [dispatch],
  );

  const onSelect = useCallback(
    (t: Target | null) => {
      setSelected(t);
      if (t?.kind === 'point' && doc && t.datasetId !== doc.activeDatasetId) {
        dispatch({ type: 'set-active-dataset', datasetId: t.datasetId });
      }
    },
    [doc, dispatch],
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
      if (significantFigures !== undefined || dateFormat !== undefined) {
        dispatch({
          type: 'set-settings',
          settings: {
            ...(significantFigures !== undefined && { significantFigures }),
            ...(dateFormat !== undefined && { dateFormat }),
          },
        });
      }
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

  const onExportJson = useCallback(() => {
    if (!doc) return;
    downloadText(`${baseName(doc.image.name)}-project.json`, JSON.stringify(toProject(doc), null, 2), 'application/json');
  }, [doc]);

  const addDataset = () => {
    if (!doc) return;
    dispatch({ type: 'add-dataset', dataset: { id: newId(), ...nextDatasetDefaults(doc), points: [] } });
  };

  const deleteDataset = (id: string) => {
    const d = doc?.datasets.find((x) => x.id === id);
    if (!d) return;
    if (d.points.length > 0 && !window.confirm(`Delete "${d.name}" and its ${d.points.length} points?`)) return;
    dispatch({ type: 'delete-dataset', datasetId: id });
    if (selected?.kind === 'point' && selected.datasetId === id) setSelected(null);
  };

  const zoomBy = (factor: number) => {
    const { width, height } = viewport.current;
    setView((v) => zoomAt(v, width / 2, height / 2, factor));
  };

  const cursorValue = cursor && calibration ? calibration.pixelToValue(cursor.px, cursor.py) : null;
  const totalPoints = doc?.datasets.reduce((n, d) => n + d.points.length, 0) ?? 0;

  const goStep = (s: Step) => {
    setStep(s);
    setSelected(null);
    setChosenRef(null);
  };

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Graph Digitizer</h1>
        <button type="button" onClick={() => fileInput.current?.click()}>
          Open image…
        </button>
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
        <div className="zoom" role="group" aria-label="Zoom">
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
        <span className="spacer" />
        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="notice">
            {notice.text}
            <button type="button" className="icon" onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
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
          onCursor={setCursor}
          onFile={(f) => void handleFile(f)}
          onOpenFile={() => fileInput.current?.click()}
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
                <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                  Choose image…
                </button>
                <p className="muted">
                  Or drop a file onto the workspace, or paste an image with <kbd>Ctrl</kbd>+<kbd>V</kbd>. PNG, JPEG,
                  GIF, WebP and BMP work. Nothing is uploaded: the image stays in this browser tab.
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
                onValue={(ref, value) => dispatch({ type: 'set-ref-value', ref, value })}
                onPlace={setChosenRef}
                onContinue={() => goStep('data')}
              />
            )}
            {step === 'data' && doc && (
              <DataStep
                doc={doc}
                calibrated={!!calibration}
                selected={selected}
                onActivate={(id) => dispatch({ type: 'set-active-dataset', datasetId: id })}
                onRename={(id, name) => dispatch({ type: 'rename-dataset', datasetId: id, name })}
                onRecolor={(id, color) => dispatch({ type: 'recolor-dataset', datasetId: id, color })}
                onDelete={deleteDataset}
                onAdd={addDataset}
                onDeleteSelected={deleteSelected}
              />
            )}
          </div>

          {doc && (
            <DataTable
              doc={doc}
              calibration={calibration}
              options={tableOptions}
              selected={selected}
              onSelect={onSelect}
              onOptions={onTableOptions}
              onExportCsv={onExportCsv}
              onCopyTsv={() => void onCopyTsv()}
              onExportJson={onExportJson}
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
        <span className="muted">Wheel: zoom · Space+drag or middle-drag: pan · F: fit</span>
      </footer>
    </div>
  );
}
