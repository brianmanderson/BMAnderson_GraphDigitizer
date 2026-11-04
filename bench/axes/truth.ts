/**
 * Ground-truth label format for the axis benchmark, and its loader. One JSON file per image,
 * beside the image (synthetic) or anywhere referenced from `real/manifest.json` (real figures).
 * The format is documented in .claude/skills/axis-detection/SKILL.md; in short:
 *
 *   {
 *     "image": "fig.jpg",                     // relative to this JSON file
 *     "tags": ["journal", "km"],              // optional categories (manifest tags are added)
 *     "plotBox": [[x,y] TL, TR, BR, BL],      // optional
 *     "xAxis": {
 *       "scale": "linear" | "log10" | "date" | …,
 *       "line": [[x1,y1],[x2,y2]],            // the drawn axis line, left → right, OR
 *       "axisLineRow": 344.5,                 // shorthand for an unrotated line at this row
 *       "lineDrawn": false,                   // optional: no visible line (score vs the edge)
 *       "tickMarks": true,                    // false = labels only: any detected tick is false
 *       "ticks": [{ "value": 0, "px": 134, "py": 344.5, "label": "0", "minor": true }]
 *     },
 *     "yAxis": { …, "axisLineCol": 134, "ticks": [{ "value": 0.2, "py": 283 }] }
 *   }
 *
 * Pixels follow the app's convention (integer = pixel centre). With the row/col shorthand, a
 * tick's missing coordinate is the axis line's, and the scored line runs between the extreme
 * ticks. Extra fields (description, knownValues, pitfalls…) are ignored, so the e2e fixtures in
 * fixtures/real/ are valid labels as they are.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface P {
  x: number;
  y: number;
}

export interface TruthTick {
  value: number | string;
  point: P;
  minor: boolean;
  label?: string;
}

export interface TruthAxis {
  scale: string;
  line: [P, P];
  lineDrawn: boolean;
  tickMarks: boolean;
  ticks: TruthTick[];
}

export interface Truth {
  id: string;
  imagePath: string;
  source: 'synthetic' | 'real';
  tags: string[];
  plotBox: [P, P, P, P] | null;
  x: TruthAxis;
  y: TruthAxis;
}

type Json = Record<string, unknown>;

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
  return v;
}

function pt(v: unknown, what: string): P {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${what} must be [x, y]`);
  return { x: num(v[0], `${what}[0]`), y: num(v[1], `${what}[1]`) };
}

function axis(raw: unknown, which: 'x' | 'y', file: string): TruthAxis {
  const a = raw as Json;
  if (!a || typeof a !== 'object') throw new Error(`${file}: ${which}Axis missing`);
  const rawTicks = Array.isArray(a.ticks) ? (a.ticks as Json[]) : [];
  let line: [P, P];
  let fill: (t: Json, i: number) => P;
  if (Array.isArray(a.line)) {
    line = [pt(a.line[0], `${which}Axis.line[0]`), pt(a.line[1], `${which}Axis.line[1]`)];
    fill = (t, i) => ({ x: num(t.px, `${which} tick ${i} px`), y: num(t.py, `${which} tick ${i} py`) });
  } else if (which === 'x' && typeof a.axisLineRow === 'number') {
    const row = a.axisLineRow;
    fill = (t, i) => ({ x: num(t.px, `x tick ${i} px`), y: typeof t.py === 'number' ? t.py : row });
    const xs = rawTicks.map((t, i) => fill(t, i).x);
    line = [{ x: Math.min(...xs), y: row }, { x: Math.max(...xs), y: row }];
  } else if (which === 'y' && typeof a.axisLineCol === 'number') {
    const col = a.axisLineCol;
    fill = (t, i) => ({ x: typeof t.px === 'number' ? t.px : col, y: num(t.py, `y tick ${i} py`) });
    const ys = rawTicks.map((t, i) => fill(t, i).y);
    line = [{ x: col, y: Math.max(...ys) }, { x: col, y: Math.min(...ys) }];
  } else {
    throw new Error(`${file}: ${which}Axis needs "line" or "${which === 'x' ? 'axisLineRow' : 'axisLineCol'}"`);
  }
  if (rawTicks.length < 2 && !Array.isArray(a.line)) throw new Error(`${file}: ${which}Axis needs ≥ 2 ticks`);
  return {
    scale: typeof a.scale === 'string' ? a.scale : 'linear',
    line,
    lineDrawn: a.lineDrawn !== false,
    tickMarks: a.tickMarks !== false,
    ticks: rawTicks.map((t, i) => ({
      value: typeof t.value === 'string' ? t.value : num(t.value, `${which} tick ${i} value`),
      point: fill(t, i),
      minor: t.minor === true,
      ...(typeof t.label === 'string' ? { label: t.label } : {}),
    })),
  };
}

export function loadTruth(jsonPath: string, source: Truth['source'], extraTags: string[] = []): Truth {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as Json;
  if (typeof raw.image !== 'string') throw new Error(`${jsonPath}: "image" missing`);
  const box = Array.isArray(raw.plotBox) ? raw.plotBox.map((p, i) => pt(p, `plotBox[${i}]`)) : null;
  if (box && box.length !== 4) throw new Error(`${jsonPath}: plotBox needs 4 corners`);
  const tags = [...(Array.isArray(raw.tags) ? (raw.tags as string[]) : []), ...extraTags];
  const id = jsonPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.json$/, '') ?? jsonPath;
  return {
    id,
    imagePath: resolve(dirname(jsonPath), raw.image),
    source,
    tags: [...new Set([source, ...tags])],
    plotBox: box as [P, P, P, P] | null,
    x: axis(raw.xAxis, 'x', jsonPath),
    y: axis(raw.yAxis, 'y', jsonPath),
  };
}
