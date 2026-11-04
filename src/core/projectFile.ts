/**
 * Reading saved projects: validate untrusted JSON (a file the user opened, or an autosave) and
 * migrate older schema versions to the current Project shape. Never throws.
 */

import { DEFAULT_SETTINGS, PROJECT_VERSION, REF_NAMES, type CalibrationRefs, type DataPoint, type Dataset, type Project, type ProjectSettings, type RefPoint } from './project.ts';
import { isScaleType, type ScaleType } from './scales.ts';

export type ParseProjectResult = { ok: true; project: Project; migratedFrom: number | null } | { ok: false; message: string };

class Invalid extends Error {}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(path: string, what: string): never {
  throw new Invalid(`${path} ${what}.`);
}

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, 'must be an object');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be text');
  return v;
}

function finite(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}

function scale(v: unknown, path: string): ScaleType {
  if (!isScaleType(v)) fail(path, 'must be one of linear, log10, ln, reciprocal, date');
  return v;
}

function refPoint(v: unknown, path: string): RefPoint {
  const r = obj(v, path);
  const value = r.value;
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail(`${path}.value`, 'must be a number or text');
  }
  return { px: finite(r.px, `${path}.px`), py: finite(r.py, `${path}.py`), value };
}

function image(v: unknown): Project['image'] {
  const im = obj(v, 'image');
  const dataUrl = str(im.dataUrl, 'image.dataUrl');
  if (!/^data:image\/[\w.+-]+[;,]/.test(dataUrl)) fail('image.dataUrl', 'must be an embedded image (data:image/…)');
  if (/^data:image\/svg/i.test(dataUrl)) fail('image.dataUrl', 'is a vector (SVG) image, which is not supported');
  const size = (k: 'width' | 'height') => {
    const n = finite(im[k], `image.${k}`);
    if (!Number.isInteger(n) || n <= 0) fail(`image.${k}`, 'must be a positive whole number');
    return n;
  };
  return { dataUrl, width: size('width'), height: size('height'), name: str(im.name, 'image.name') };
}

function calibration(v: unknown): Project['calibration'] {
  if (v === null || v === undefined) return null;
  const c = obj(v, 'calibration');
  const refs = obj(c.refs, 'calibration.refs');
  const out = {} as CalibrationRefs;
  for (const name of REF_NAMES) out[name] = refPoint(refs[name], `calibration.refs.${name}`);
  return { xScale: scale(c.xScale, 'calibration.xScale'), yScale: scale(c.yScale, 'calibration.yScale'), refs: out };
}

function draftCalibration(v: unknown): Project['draftCalibration'] {
  if (v === undefined) return undefined;
  const c = obj(v, 'draftCalibration');
  const refs = obj(c.refs, 'draftCalibration.refs');
  const out: Partial<CalibrationRefs> = {};
  for (const name of REF_NAMES) {
    if (refs[name] !== undefined) out[name] = refPoint(refs[name], `draftCalibration.refs.${name}`);
  }
  return { xScale: scale(c.xScale, 'draftCalibration.xScale'), yScale: scale(c.yScale, 'draftCalibration.yScale'), refs: out };
}

function datasets(v: unknown): Dataset[] {
  if (!Array.isArray(v)) fail('datasets', 'must be a list');
  const ids = new Set<string>();
  return v.map((raw, i): Dataset => {
    const path = `datasets[${i}]`;
    const d = obj(raw, path);
    const id = str(d.id, `${path}.id`);
    if (id === '' || ids.has(id)) fail(`${path}.id`, 'must be non-empty and unique');
    ids.add(id);
    if (!Array.isArray(d.points)) fail(`${path}.points`, 'must be a list');
    const pointIds = new Set<string>();
    const points = d.points.map((rawPoint, j): DataPoint => {
      const pp = `${path}.points[${j}]`;
      const p = obj(rawPoint, pp);
      const pid = str(p.id, `${pp}.id`);
      if (pid === '' || pointIds.has(pid)) fail(`${pp}.id`, 'must be non-empty and unique within its dataset');
      pointIds.add(pid);
      return { id: pid, px: finite(p.px, `${pp}.px`), py: finite(p.py, `${pp}.py`) };
    });
    return { id, name: str(d.name, `${path}.name`), color: str(d.color, `${path}.color`), points };
  });
}

/** Settings are lenient: missing or out-of-range values fall back to the defaults. */
function settings(v: unknown): ProjectSettings {
  const s = isObj(v) ? v : {};
  const sf = s.significantFigures;
  return {
    significantFigures:
      typeof sf === 'number' && Number.isInteger(sf) && sf >= 1 && sf <= 15 ? sf : DEFAULT_SETTINGS.significantFigures,
    dateFormat: typeof s.dateFormat === 'string' && s.dateFormat !== '' ? s.dateFormat : DEFAULT_SETTINGS.dateFormat,
  };
}

/**
 * Migrations, keyed by the version they upgrade *from*. Each takes the raw object of that
 * version and returns the raw object of the next one. Version 1 → 2 only added the optional
 * `draftCalibration`, so a version 1 file is already a valid version 2 file.
 */
const MIGRATIONS: Record<number, (p: Obj) => Obj> = {
  1: (p) => ({ ...p, version: 2 }),
};

/** Validate and migrate a parsed project file. Unknown fields are dropped. */
export function parseProject(data: unknown): ParseProjectResult {
  if (!isObj(data) || typeof data.version !== 'number' || !isObj(data.image) || !Array.isArray(data.datasets)) {
    return { ok: false, message: 'This file is not a Graph Digitizer project.' };
  }
  const from = data.version;
  if (!Number.isInteger(from) || from < 1) return { ok: false, message: 'This file is not a Graph Digitizer project.' };
  if (from > PROJECT_VERSION) {
    return {
      ok: false,
      message: `This project was saved by a newer version of the app (format ${from}); this version reads formats up to ${PROJECT_VERSION}.`,
    };
  }
  let raw: Obj = data;
  for (let v = from; v < PROJECT_VERSION; v++) raw = MIGRATIONS[v]!(raw);
  try {
    const cal = calibration(raw.calibration);
    const draft = cal ? undefined : draftCalibration(raw.draftCalibration);
    const project: Project = {
      version: PROJECT_VERSION,
      image: image(raw.image),
      calibration: cal,
      ...(draft && { draftCalibration: draft }),
      datasets: datasets(raw.datasets),
      settings: settings(raw.settings),
    };
    return { ok: true, project, migratedFrom: from === PROJECT_VERSION ? null : from };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, message: `The project file is damaged: ${e.message}` };
    throw e;
  }
}

/** Parse project file text (JSON). */
export function parseProjectText(text: string): ParseProjectResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: 'This file is not a Graph Digitizer project (it is not valid JSON).' };
  }
  return parseProject(data);
}
