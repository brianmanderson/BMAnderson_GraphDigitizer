/**
 * The editable document behind the UI: a Project plus the in-progress parts the Project type
 * cannot hold yet (scale choices and refs before all four are placed, the active dataset).
 *
 * Every change goes through `docReducer`, a pure function, so undo/redo (Phase 3) can wrap it
 * and persistence can snapshot it via `toProject` / `fromProject`. Ids are supplied by the
 * caller in the action, which keeps the reducer deterministic.
 */

import {
  DEFAULT_SETTINGS,
  PROJECT_VERSION,
  REF_NAMES,
  type CalibrationRefs,
  type CalibrationSpec,
  type Dataset,
  type DataPoint,
  type Project,
  type ProjectImage,
  type ProjectSettings,
  type RefName,
  type ScaleType,
} from '../core/index.ts';

/** A ref while calibrating: the value is kept as typed text until the fit succeeds. */
export interface DraftRef {
  px: number;
  py: number;
  value: string;
}

export interface DocState {
  image: ProjectImage;
  xScale: ScaleType;
  yScale: ScaleType;
  refs: Partial<Record<RefName, DraftRef>>;
  datasets: Dataset[];
  activeDatasetId: string;
  settings: ProjectSettings;
}

/** Categorical colours for new datasets (cycled). Chosen to stay distinct on white and on charts. */
export const DATASET_COLORS = [
  '#d6336c',
  '#1c7ed6',
  '#2f9e44',
  '#f08c00',
  '#7048e8',
  '#0c8599',
  '#e8590c',
  '#495057',
] as const;

export type DocAction =
  | { type: 'set-scale'; axis: 'x' | 'y'; scale: ScaleType }
  | { type: 'place-ref'; ref: RefName; px: number; py: number }
  | { type: 'set-ref-value'; ref: RefName; value: string }
  | { type: 'clear-ref'; ref: RefName }
  | { type: 'add-point'; datasetId: string; point: DataPoint }
  | { type: 'move-point'; datasetId: string; pointId: string; px: number; py: number }
  | { type: 'delete-point'; datasetId: string; pointId: string }
  | { type: 'add-dataset'; dataset: Dataset }
  | { type: 'rename-dataset'; datasetId: string; name: string }
  | { type: 'recolor-dataset'; datasetId: string; color: string }
  | { type: 'delete-dataset'; datasetId: string }
  | { type: 'set-active-dataset'; datasetId: string }
  | { type: 'set-settings'; settings: Partial<ProjectSettings> };

/** A fresh document for a newly loaded image: no calibration, one empty dataset. */
export function newDoc(image: ProjectImage, firstDatasetId: string, settings?: ProjectSettings): DocState {
  return {
    image,
    xScale: 'linear',
    yScale: 'linear',
    refs: {},
    datasets: [{ id: firstDatasetId, name: 'Dataset 1', color: DATASET_COLORS[0], points: [] }],
    activeDatasetId: firstDatasetId,
    settings: { ...(settings ?? DEFAULT_SETTINGS) },
  };
}

function mapDataset(state: DocState, datasetId: string, f: (d: Dataset) => Dataset): DocState {
  let changed = false;
  const datasets = state.datasets.map((d) => {
    if (d.id !== datasetId) return d;
    changed = true;
    return f(d);
  });
  return changed ? { ...state, datasets } : state;
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case 'set-scale':
      return action.axis === 'x' ? { ...state, xScale: action.scale } : { ...state, yScale: action.scale };
    case 'place-ref': {
      if (!Number.isFinite(action.px) || !Number.isFinite(action.py)) return state;
      const prev = state.refs[action.ref];
      return {
        ...state,
        refs: { ...state.refs, [action.ref]: { px: action.px, py: action.py, value: prev?.value ?? '' } },
      };
    }
    case 'set-ref-value': {
      const prev = state.refs[action.ref];
      if (!prev) return state;
      return { ...state, refs: { ...state.refs, [action.ref]: { ...prev, value: action.value } } };
    }
    case 'clear-ref': {
      const refs = { ...state.refs };
      delete refs[action.ref];
      return { ...state, refs };
    }
    case 'add-point':
      if (!Number.isFinite(action.point.px) || !Number.isFinite(action.point.py)) return state;
      return mapDataset(state, action.datasetId, (d) => ({ ...d, points: [...d.points, action.point] }));
    case 'move-point':
      if (!Number.isFinite(action.px) || !Number.isFinite(action.py)) return state;
      return mapDataset(state, action.datasetId, (d) => ({
        ...d,
        points: d.points.map((p) => (p.id === action.pointId ? { ...p, px: action.px, py: action.py } : p)),
      }));
    case 'delete-point':
      return mapDataset(state, action.datasetId, (d) => ({
        ...d,
        points: d.points.filter((p) => p.id !== action.pointId),
      }));
    case 'add-dataset':
      return {
        ...state,
        datasets: [...state.datasets, action.dataset],
        activeDatasetId: action.dataset.id,
      };
    case 'rename-dataset':
      return mapDataset(state, action.datasetId, (d) => ({ ...d, name: action.name }));
    case 'recolor-dataset':
      return mapDataset(state, action.datasetId, (d) => ({ ...d, color: action.color }));
    case 'delete-dataset': {
      // There is always at least one dataset to place points into.
      if (state.datasets.length <= 1) return state;
      const index = state.datasets.findIndex((d) => d.id === action.datasetId);
      if (index < 0) return state;
      const datasets = state.datasets.filter((d) => d.id !== action.datasetId);
      const activeDatasetId =
        state.activeDatasetId === action.datasetId
          ? datasets[Math.min(index, datasets.length - 1)]!.id
          : state.activeDatasetId;
      return { ...state, datasets, activeDatasetId };
    }
    case 'set-active-dataset':
      return state.datasets.some((d) => d.id === action.datasetId)
        ? { ...state, activeDatasetId: action.datasetId }
        : state;
    case 'set-settings':
      return { ...state, settings: { ...state.settings, ...action.settings } };
  }
}

/** The app's top-level state: no document until an image is loaded. */
export type AppAction = DocAction | { type: 'replace-doc'; doc: DocState };

export function appReducer(state: DocState | null, action: AppAction): DocState | null {
  if (action.type === 'replace-doc') return action.doc;
  return state === null ? null : docReducer(state, action);
}

/** True when the document holds work that replacing the image would discard. */
export function hasWork(state: DocState | null): boolean {
  return state !== null && (Object.keys(state.refs).length > 0 || state.datasets.some((d) => d.points.length > 0));
}

/** A name and colour for the next dataset that don't repeat the existing ones. */
export function nextDatasetDefaults(state: DocState): { name: string; color: string } {
  const names = new Set(state.datasets.map((d) => d.name));
  let n = state.datasets.length + 1;
  while (names.has(`Dataset ${n}`)) n++;
  const used = new Set(state.datasets.map((d) => d.color.toLowerCase()));
  const color = DATASET_COLORS.find((c) => !used.has(c)) ?? DATASET_COLORS[state.datasets.length % DATASET_COLORS.length]!;
  return { name: `Dataset ${n}`, color };
}

/** The four refs, once all are placed; otherwise null. */
export function completeRefs(refs: DocState['refs']): Record<RefName, DraftRef> | null {
  const out = {} as Record<RefName, DraftRef>;
  for (const name of REF_NAMES) {
    const r = refs[name];
    if (!r) return null;
    out[name] = r;
  }
  return out;
}

/** The ref to place next in the guided order X1 → X2 → Y1 → Y2, or null when all are placed. */
export function nextUnplacedRef(refs: DocState['refs']): RefName | null {
  return REF_NAMES.find((name) => !refs[name]) ?? null;
}

/** Spec for calibrate(), once all four refs are placed (values may still be invalid). */
export function calibrationSpec(state: DocState): CalibrationSpec | null {
  const refs = completeRefs(state.refs);
  if (!refs) return null;
  const out = {} as CalibrationRefs;
  for (const name of REF_NAMES) {
    const r = refs[name];
    const scale = name.startsWith('X') ? state.xScale : state.yScale;
    // Numeric text is stored as a number so saved projects carry plain values; date text and
    // anything unparseable stay as typed, and calibrate() reports the latter.
    const text = r.value.trim();
    const n = text === '' ? NaN : Number(text);
    out[name] = { px: r.px, py: r.py, value: scale !== 'date' && Number.isFinite(n) ? n : r.value };
  }
  return { xScale: state.xScale, yScale: state.yScale, refs: out };
}

/** The document as a Project (docs/SPEC.md → Data model), for JSON export and saving. */
export function toProject(state: DocState): Project {
  return {
    version: PROJECT_VERSION,
    image: state.image,
    calibration: calibrationSpec(state),
    datasets: state.datasets,
    settings: state.settings,
  };
}

/** Rebuild an editable document from a Project (the inverse of toProject). */
export function fromProject(project: Project): DocState {
  const refs: DocState['refs'] = {};
  if (project.calibration) {
    for (const name of REF_NAMES) {
      const r = project.calibration.refs[name];
      refs[name] = { px: r.px, py: r.py, value: String(r.value) };
    }
  }
  const datasets = project.datasets.length > 0 ? project.datasets : newDoc(project.image, 'dataset-1').datasets;
  return {
    image: project.image,
    xScale: project.calibration?.xScale ?? 'linear',
    yScale: project.calibration?.yScale ?? 'linear',
    refs,
    datasets,
    activeDatasetId: datasets[0]!.id,
    settings: { ...DEFAULT_SETTINGS, ...project.settings },
  };
}
