import { describe, expect, it } from 'vitest';
import { PROJECT_VERSION, type Project } from './project.ts';
import { parseProject, parseProjectText } from './projectFile.ts';

const v2: Project = {
  version: 2,
  image: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 640, height: 480, name: 'chart.png' },
  calibration: {
    xScale: 'linear',
    yScale: 'log10',
    refs: {
      X1: { px: 80, py: 420, value: 0 },
      X2: { px: 600, py: 420, value: 10 },
      Y1: { px: 80, py: 420, value: '1' },
      Y2: { px: 80, py: 60, value: 1000 },
    },
  },
  datasets: [{ id: 'd1', name: 'Dataset 1', color: '#d6336c', points: [{ id: 'p1', px: 100.25, py: 200.5 }] }],
  settings: { significantFigures: 4, dateFormat: 'YYYY-MM-DD HH:mm' },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const errorOf = (data: unknown) => {
  const r = parseProject(data);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.message;
};

describe('parseProject', () => {
  it('accepts a current project unchanged', () => {
    expect(PROJECT_VERSION).toBe(2);
    const r = parseProject(clone(v2));
    expect(r).toEqual({ ok: true, project: v2, migratedFrom: null });
  });

  it('keeps a calibration in progress (version 2 draftCalibration)', () => {
    const draft = { ...clone(v2), calibration: null, draftCalibration: { xScale: 'date', yScale: 'linear', refs: { X1: { px: 1, py: 2, value: '2024-03-15' } } } };
    const r = parseProject(draft);
    expect(r.ok && r.project.draftCalibration).toEqual(draft.draftCalibration);
    // A complete calibration wins; a stray draft beside it is dropped.
    const both = parseProject({ ...clone(v2), draftCalibration: draft.draftCalibration });
    expect(both.ok && 'draftCalibration' in both.project).toBe(false);
  });

  it('migrates version 1 files', () => {
    const v1 = { ...clone(v2), version: 1 };
    const r = parseProject(v1);
    expect(r).toEqual({ ok: true, project: v2, migratedFrom: 1 });
  });

  it('rejects files from a newer version with a clear message', () => {
    expect(errorOf({ ...clone(v2), version: 3 })).toMatch(/newer version.*format 3.*up to 2/);
  });

  it('rejects things that are not projects', () => {
    for (const data of [null, 42, 'x', [], {}, { version: 1 }, { ...clone(v2), version: 0 }, { ...clone(v2), version: 1.5 }]) {
      expect(errorOf(data)).toMatch(/not a Graph Digitizer project/);
    }
    expect(parseProjectText('{ nope')).toEqual({ ok: false, message: expect.stringMatching(/not valid JSON/) });
  });

  it('names the damaged field', () => {
    // [path to change, new value (undefined deletes it), expected message]
    const cases: [string, unknown, RegExp][] = [
      ['image.dataUrl', 'http://example.com/a.png', /image\.dataUrl must be an embedded image/],
      ['image.dataUrl', 'data:image/svg+xml;base64,AAAA', /SVG/],
      ['image.width', 0, /image\.width must be a positive whole number/],
      ['image.height', 2.5, /image\.height/],
      ['image.name', undefined, /image\.name must be text/],
      ['calibration.xScale', 'cubic', /calibration\.xScale must be one of/],
      ['calibration.refs.Y2', undefined, /calibration\.refs\.Y2 must be an object/],
      ['calibration.refs.X1.px', 'left', /calibration\.refs\.X1\.px must be a finite number/],
      ['calibration.refs.X2.value', null, /calibration\.refs\.X2\.value must be a number or text/],
      ['datasets.0.points.0.py', null, /datasets\[0\]\.points\[0\]\.py must be a finite number/],
      ['datasets.1', v2.datasets[0], /datasets\[1\]\.id must be non-empty and unique/],
      ['datasets.0.points.1', { id: 'p1', px: 1, py: 1 }, /points\[1\]\.id must be non-empty and unique/],
      ['datasets.0.points', {}, /datasets\[0\]\.points must be a list/],
      ['datasets.0.color', 7, /datasets\[0\]\.color must be text/],
    ];
    for (const [path, value, message] of cases) {
      const p = clone(v2) as unknown as Record<string, unknown>;
      const keys = path.split('.');
      const parent = keys.slice(0, -1).reduce((o, k) => (o as Record<string, unknown>)[k], p as unknown) as Record<string, unknown>;
      if (value === undefined) delete parent[keys.at(-1)!];
      else parent[keys.at(-1)!] = value;
      expect(errorOf(p), path).toMatch(message);
      expect(errorOf(p)).toMatch(/^The project file is damaged: /);
    }
  });

  it('falls back to default settings and drops unknown fields', () => {
    const p = { ...clone(v2), settings: { significantFigures: 99 }, extra: true };
    const r = parseProject(p);
    expect(r.ok && r.project.settings).toEqual({ significantFigures: 4, dateFormat: 'YYYY-MM-DD HH:mm' });
    expect(r.ok && 'extra' in r.project).toBe(false);
    const noSettings = { ...clone(v2) } as Record<string, unknown>;
    delete noSettings.settings;
    expect(parseProject(noSettings).ok).toBe(true);
  });
});
