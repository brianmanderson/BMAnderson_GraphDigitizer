/**
 * Ground truth for the line-tracing benchmark, and its loaders.
 *
 * Synthetic charts (bench/lines/synthetic/lNN.json, written by generate.py): one JSON per image
 * with `series: [{ id, kind: 'line'|'step'|'scatter', tags, color, seed: [x,y], path?: [[x,y]…],
 * markers?: [[x,y]…], corners?: [[x,y]…], style, lineWidthPx, markerSizePx, data, pixels }]` — `path`
 * is the drawn polyline (lines, steps), `markers` the marker centres (scatter, lines with markers),
 * `corners` the step corners, `style` the line style ('solid', 'dashed', 'dotted', 'dashdot').
 *
 * Real figures (bench/lines/real/manifest.json → label JSON shared with fixtures/real/): only
 * hand-labelled plateaus exist, as `knownValues: [{ series?, x: [x0, x1], y, py? }]` with x in data
 * units. They become horizontal truth segments (x converted with a least-squares fit of the
 * labelled x ticks; py from the label, else from the y ticks), so real-figure truth is *partial*:
 * scored only where it exists. The seed of a series is the middle of its first segment. An optional
 * `styles: { <series>: 'solid' | 'dashed' | … }` gives the series' line styles.
 * A label with `points: [{ px, py }…]` (a polyline chart with a marker on every data point, like
 * fixtures/synthetic/synthetic-linear.json) gives full truth instead: a line series through the
 * points (seeded in the middle of its first segment, a corner at every point) and the marker series
 * (seeded on its second marker, size from the manifest's `markerSizePx`). A manifest entry's
 * `source` names the figure's top category (default `real`). A label with `markerSeries: [{ series,
 * markerSizePx, seed: [x, y], markers: [[x, y]…] }]` (scatter groups, e.g. filled vs open markers of
 * one colour, centres measured to ±1 px) gives full marker truth for each group; its legend samples
 * are not markers.
 *
 * A real figure's label also carries its calibrated axes (bench/axes format); they become the
 * chart's `values` (bench/lines/values.ts) so errors can be reported in data units. Synthetic
 * charts have none (`values: null`).
 *
 * Pixels follow the app's convention (integer = pixel centre).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadTruth } from '../axes/truth.ts';
import { valueMapFromTruth, type ValueMap } from './values.ts';

export interface P {
  x: number;
  y: number;
}

export interface SeriesTruth {
  id: string;
  kind: 'line' | 'step' | 'scatter';
  tags: string[];
  seed: P;
  /** Truth polylines (one for synthetic series; one per labelled segment for real figures). */
  pieces: P[][];
  markers: P[];
  corners: P[];
  markerSizePx: number;
  /** Line style ('solid' | 'dashed' | 'dotted' | 'dash-dot', as TraceResult.style), or null (scatter, unlabelled). */
  style: string | null;
  /** Real figures: truth exists only on the labelled segments. */
  partial: boolean;
}

/** The generator's style names → TraceResult.style. */
const styleName = (v: unknown): string | null => (typeof v === 'string' && v !== 'none' ? (v === 'dashdot' ? 'dash-dot' : v) : null);

export interface ChartTruth {
  id: string;
  imagePath: string;
  tags: string[];
  series: SeriesTruth[];
  /** Pixel → data value through the label's axis ticks (bench/lines/values.ts); null without them. */
  values: ValueMap | null;
}

type Json = Record<string, unknown>;
const pts = (v: unknown): P[] => (Array.isArray(v) ? (v as [number, number][]).map(([x, y]) => ({ x, y })) : []);

function synthetic(path: string): ChartTruth {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Json;
  const series = (raw.series as Json[]).map((s): SeriesTruth => {
    const kind = s.kind as SeriesTruth['kind'];
    const markers = pts(s.markers);
    const seed = s.seed as [number, number];
    return {
      id: String(s.id),
      kind,
      tags: s.tags as string[],
      seed: { x: seed[0], y: seed[1] },
      pieces: kind === 'scatter' ? [] : [pts(s.path)],
      markers,
      corners: pts(s.corners),
      markerSizePx: Number(s.markerSizePx),
      style: kind === 'scatter' ? null : styleName(s.style),
      partial: false,
    };
  });
  return {
    id: path.replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, ''),
    imagePath: resolve(dirname(path), String(raw.image)),
    tags: ['synthetic', ...(raw.tags as string[])],
    series,
    values: null,
  };
}

/** The label's calibrated axes, when it has them in the bench/axes format (the fixtures do). */
function valuesOf(labelPath: string): ValueMap | null {
  try {
    return valueMapFromTruth(loadTruth(labelPath, 'real'));
  } catch {
    return null;
  }
}

/** Least-squares line through (value, pixel) tick pairs. */
function fit(pairs: [number, number][]): (v: number) => number {
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sxy = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const sxx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const b = sxy / sxx;
  return (v) => my + b * (v - mx);
}

function polylineFigure(raw: Json, markerSizePx: number): SeriesTruth[] {
  const vertices = (raw.points as Json[]).map((p) => ({ x: Number(p.px), y: Number(p.py) }));
  const [a, b] = vertices as [P, P];
  return [
    {
      id: 'line',
      kind: 'line',
      tags: ['series:line+markers', 'color:colour', 'kinks', 'markers:other-colour'],
      seed: { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) },
      pieces: [vertices],
      markers: vertices,
      corners: vertices,
      markerSizePx,
      style: 'solid',
      partial: false,
    },
    {
      id: 'markers',
      kind: 'scatter',
      tags: ['series:scatter', 'color:colour'],
      seed: { x: Math.round(b.x), y: Math.round(b.y) },
      pieces: [],
      markers: vertices,
      corners: [],
      markerSizePx,
      style: null,
      partial: false,
    },
  ];
}

function markerFigure(raw: Json): SeriesTruth[] {
  return (raw.markerSeries as Json[]).map((m, i): SeriesTruth => {
    const seed = m.seed as [number, number];
    return {
      id: `${i}:${String(m.series)}`,
      kind: 'scatter',
      tags: ['series:scatter', 'color:black'],
      seed: { x: seed[0], y: seed[1] },
      pieces: [],
      markers: pts(m.markers),
      corners: [],
      markerSizePx: Number(m.markerSizePx),
      style: null,
      partial: false,
    };
  });
}

function real(path: string, extraTags: string[], source: string, markerSizePx: number): ChartTruth {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Json;
  const values = valuesOf(path);
  if (Array.isArray(raw.markerSeries)) {
    return {
      id: path.replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, ''),
      imagePath: resolve(dirname(path), String(raw.image)),
      tags: [source, ...extraTags],
      series: markerFigure(raw),
      values,
    };
  }
  if (Array.isArray(raw.points)) {
    return {
      id: path.replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, ''),
      imagePath: resolve(dirname(path), String(raw.image)),
      tags: [source, ...extraTags],
      series: polylineFigure(raw, markerSizePx),
      values,
    };
  }
  const xa = raw.xAxis as Json;
  const ya = raw.yAxis as Json;
  const xTicks = (xa.ticks as Json[]).map((t) => [Number(t.value), Number(t.px)] as [number, number]);
  const yTicks = (ya.ticks as Json[]).map((t) => [Number(t.value), Number(t.py)] as [number, number]);
  const xpx = fit(xTicks);
  const ypx = fit(yTicks);
  const bySeries = new Map<string, P[][]>();
  for (const k of raw.knownValues as Json[]) {
    const [x0, x1] = k.x as [number, number];
    const py = typeof k.py === 'number' ? k.py : ypx(Number(k.y));
    const name = typeof k.series === 'string' ? k.series : 'series';
    const list = bySeries.get(name) ?? [];
    list.push([
      { x: xpx(x0), y: py },
      { x: xpx(x1), y: py },
    ]);
    bySeries.set(name, list);
  }
  const styles = (raw.styles ?? {}) as Record<string, unknown>;
  const series = [...bySeries.entries()].map(([name, pieces], i): SeriesTruth => {
    const [a, b] = pieces[0]!;
    return {
      id: `${i}:${name}`,
      kind: 'step',
      tags: ['series:step', 'color:colour'],
      seed: { x: Math.round((a!.x + b!.x) / 2), y: Math.round(a!.y) },
      pieces,
      markers: [],
      corners: [],
      markerSizePx: 0,
      style: styleName(styles[name]),
      partial: true,
    };
  });
  return {
    id: path.replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, ''),
    imagePath: resolve(dirname(path), String(raw.image)),
    tags: [source, ...extraTags],
    series,
    values,
  };
}

export function loadCorpus(here: string): ChartTruth[] {
  const synth = join(here, 'synthetic');
  const out = readdirSync(synth)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => synthetic(join(synth, f)));
  const manifestPath = join(here, 'real', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    figures: { truth: string; tags?: string[]; source?: string; markerSizePx?: number }[];
  };
  for (const fig of manifest.figures) {
    out.push(real(resolve(dirname(manifestPath), fig.truth), fig.tags ?? [], fig.source ?? 'real', fig.markerSizePx ?? 0));
  }
  return out;
}
