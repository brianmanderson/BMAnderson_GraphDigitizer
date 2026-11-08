/**
 * Line-tracing benchmark: runs `traceLine` (mode 'auto', 25 points) from the truth seed of every
 * series in the corpus and compares with the baseline.
 *
 *   npm run bench:lines                     run, print, exit 1 on any regression vs baseline.json
 *   npm run bench:lines -- --update         also rewrite baseline.json (only for a deliberate,
 *                                           reviewed change; say why in the commit)
 *   npm run bench:lines -- --verbose        per-trace lines
 *   npm run bench:lines -- --only l03,km    a subset (never gates or updates)
 *   npm run bench:lines -- --summary <path> also write every row of both tables as <path>.csv
 *                                           and <path>.json (bench/summary.ts)
 *
 * Corpus: bench/lines/synthetic/*.json (generate.py) and the figures in bench/lines/real/
 * manifest.json (partial truth: hand-labelled plateaus). The plot box passed to the tracer is the
 * one `detectAxes` finds (once per image, as the app does after Auto-detect), or null. Results are
 * deterministic; timings are not gated. The latest full run goes to bench/lines/last-run.json
 * (git-ignored).
 *
 * Two tables: the pixel metrics (gated), and for figures whose label carries calibrated axes the
 * same errors in data units and as % of the labelled axis range (bench/lines/values.ts; reported,
 * not gated). Data units are only comparable within one figure, so category rows pooling several
 * figures show them as `–`; the per-figure rows carry them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { detectAxes, traceLine } from '../../src/auto/index.ts';
import { decodeImage } from '../axes/decode.ts';
import { asPercent, writeSummary, type Summary, type SummaryColumn, type SummaryRow, type SummaryTable } from '../summary.ts';
import { aggregate, COVER_PX, CORNER_PX, GATED, scoreTrace, type Metrics, type TraceScore } from './score.ts';
import { loadCorpus } from './truth.ts';
import { aggregateValues, VALUE_WHATS, valueStats, type ValueStats, type ValueWhat } from './values.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'baseline.json');
const LAST_RUN = join(HERE, 'last-run.json');
const EPS = 1e-9;
const MAX_POINTS = 25;

interface TraceReport {
  kind: string;
  coverage: number | null;
  medianError: number | null;
  wrong: boolean;
  corners: string;
  markers: string;
  points: number;
  /** Reported line style, '' when not a curve with a known style ('!' marks a wrong one). */
  style: string;
}

interface Report {
  overall: Metrics;
  categories: Record<string, Metrics>;
  traces: Record<string, TraceReport>;
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);
const pct = (v: number | null) => (v === null ? '   –  ' : `${(100 * v).toFixed(1).padStart(5)}%`);
const px = (v: number | null) => (v === null ? '   – ' : v.toFixed(2).padStart(5));
/** A data-unit error to 3 significant digits ("0.00213", "12.3"); null → '–'. */
const units = (v: number | null) => (v === null ? '–' : String(Number(v.toPrecision(3)))).padStart(8);
/** A % of axis range. */
const pctRange = (v: number | null) => (v === null ? '–' : v.toFixed(3)).padStart(7);

const HEADER = 'category                 n   kind   cover  med-px p95-px wrong  corner  mk-R   mk-P  mk-grp  style    ms';

function row(name: string, m: Metrics): string {
  return [
    name.padEnd(22),
    String(m.traces).padStart(4),
    pct(m.kindAccuracy),
    pct(m.coverage),
    px(m.medianError).padStart(6),
    px(m.p95Error).padStart(6),
    pct(m.wrongRate),
    pct(m.cornerRecall),
    pct(m.markerRecall),
    pct(m.markerPrecision),
    pct(m.wrongGroupRate),
    pct(m.styleAccuracy),
    m.meanMs.toFixed(0).padStart(5),
  ].join(' ');
}

const VALUE_HEADER = 'values                                          n   Δx-med   Δx-p95  Δx%med  Δx%p95   Δy-med   Δy-p95  Δy%med  Δy%p95';

function valueRow(name: string, what: ValueWhat, v: ValueStats): string {
  return [
    `${name} ${what}`.padEnd(44),
    String(v.n).padStart(5),
    units(v.xMedian),
    units(v.xP95),
    pctRange(v.xPctMedian),
    pctRange(v.xPctP95),
    units(v.yMedian),
    units(v.yP95),
    pctRange(v.yPctMedian),
    pctRange(v.yPctP95),
  ].join(' ');
}

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function report1(s: TraceScore): TraceReport {
  return {
    kind: s.kind,
    coverage: round(s.coverage),
    medianError: round(median(s.errors)),
    wrong: s.wrong,
    corners: s.corners.truth ? `${s.corners.matched}/${s.corners.truth}` : '',
    markers: s.expected === 'markers' ? `${s.markers.matched}/${s.markers.truth} of ${s.markers.found}${s.markers.wrongGroup ? `, ${s.markers.wrongGroup} wrong group` : ''}` : '',
    points: s.points,
    style: s.style ? `${s.style.got}${s.style.got === s.style.truth ? '' : '!'}` : '',
  };
}

/** The value table's rows: (category | figure) × (points | corners | markers) with any errors. */
function valueRows(scores: TraceScore[], tags: string[]): [name: string, what: ValueWhat, stats: ValueStats][] {
  const withValues = scores.filter((s) => s.values);
  if (!withValues.length) return [];
  const out: [string, ValueWhat, ValueStats][] = [];
  const add = (name: string, list: TraceScore[], pool: (what: ValueWhat) => ValueStats) => {
    if (!list.length) return;
    for (const what of VALUE_WHATS) {
      const v = pool(what);
      if (v.n) out.push([name, what, v]);
    }
  };
  add('OVERALL', withValues, (what) => aggregateValues(withValues, what));
  for (const tag of tags) {
    const list = withValues.filter((s) => s.tags.includes(tag));
    add(tag, list, (what) => aggregateValues(list, what));
  }
  for (const chart of [...new Set(withValues.map((s) => s.chart))]) {
    const list = withValues.filter((s) => s.chart === chart);
    add(`figure:${chart}`, list, (what) => valueStats(list.flatMap((s) => s.values![what])));
  }
  return out;
}

const TRACING_COLUMNS: SummaryColumn[] = [
  { key: 'traces', label: 'traces', unit: 'count' },
  { key: 'kindAccuracy', label: 'kind accuracy', unit: '%' },
  { key: 'coverage', label: 'coverage', unit: '%' },
  { key: 'medianError', label: 'centreline error median', unit: 'px' },
  { key: 'p95Error', label: 'centreline error p95', unit: 'px' },
  { key: 'wrongRate', label: 'wrong series', unit: '%' },
  { key: 'cornerRecall', label: 'corner recall', unit: '%' },
  { key: 'markerRecall', label: 'marker recall', unit: '%' },
  { key: 'markerPrecision', label: 'marker precision', unit: '%' },
  { key: 'wrongGroupRate', label: 'wrong group', unit: '%' },
  { key: 'styleAccuracy', label: 'style accuracy', unit: '%' },
  { key: 'meanMs', label: 'time per trace', unit: 'ms' },
];
const PERCENT_KEYS = new Set(['kindAccuracy', 'coverage', 'wrongRate', 'cornerRecall', 'markerRecall', 'markerPrecision', 'wrongGroupRate', 'styleAccuracy']);

const VALUE_COLUMNS: SummaryColumn[] = [
  { key: 'what', label: 'what', unit: '' },
  { key: 'n', label: 'n', unit: 'count' },
  { key: 'xMedian', label: 'x error median', unit: 'data units' },
  { key: 'xP95', label: 'x error p95', unit: 'data units' },
  { key: 'xPctMedian', label: 'x error median', unit: '% of x range' },
  { key: 'xPctP95', label: 'x error p95', unit: '% of x range' },
  { key: 'yMedian', label: 'y error median', unit: 'data units' },
  { key: 'yP95', label: 'y error p95', unit: 'data units' },
  { key: 'yPctMedian', label: 'y error median', unit: '% of y range' },
  { key: 'yPctP95', label: 'y error p95', unit: '% of y range' },
];

function summaryOf(report: Report, tags: string[], values: [string, ValueWhat, ValueStats][]): Summary {
  const tracing: SummaryTable = {
    name: 'tracing',
    columns: TRACING_COLUMNS,
    rows: [['OVERALL', report.overall] as const, ...tags.map((t) => [t, report.categories[t]!] as const)].map(([category, m]) => ({
      category,
      values: Object.fromEntries(TRACING_COLUMNS.map((c) => [c.key, PERCENT_KEYS.has(c.key) ? asPercent(m[c.key as keyof Metrics] as number | null) : m[c.key as keyof Metrics]])),
    })),
  };
  const valueTable: SummaryTable = {
    name: 'values',
    columns: VALUE_COLUMNS,
    rows: values.map(([category, what, v]): SummaryRow => ({ category, values: { what, ...v } })),
  };
  return { benchmark: 'bench:lines', generated: new Date().toISOString(), tables: [tracing, valueTable] };
}

function main(): number {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const verbose = args.includes('--verbose');
  const onlyArg = args[args.indexOf('--only') + 1];
  const only = args.includes('--only') && onlyArg ? onlyArg.split(',') : null;
  const summaryArg = args[args.indexOf('--summary') + 1];
  const summaryPath = args.includes('--summary') && summaryArg && !summaryArg.startsWith('--') ? summaryArg : null;
  if (args.includes('--summary') && !summaryPath) {
    console.error('--summary needs a path');
    return 2;
  }

  let charts = loadCorpus(HERE);
  if (only) charts = charts.filter((c) => only.some((o) => c.id.includes(o)));
  const started = performance.now();
  const scores: TraceScore[] = [];
  for (const chart of charts) {
    const img = decodeImage(chart.imagePath);
    const rgba = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const det = detectAxes(img);
    const b = det.plotBox;
    const plotBox: [number, number][] | null = b ? [b.topLeft, b.topRight, b.bottomRight, b.bottomLeft].map((p) => [p.x, p.y]) : null;
    for (const s of chart.series) {
      const r = traceLine({ rgba, width: img.width, height: img.height, plotBox, seed: { px: s.seed.x, py: s.seed.y }, mode: 'auto', maxPoints: MAX_POINTS });
      const score = scoreTrace(chart.id, chart.tags, s, chart.series.filter((o) => o !== s), r, chart.values);
      scores.push(score);
      if (verbose) {
        const t = report1(score);
        const v = score.values && score.values.points.length ? valueStats(score.values.points) : null;
        console.log(
          `${`${chart.id}/${s.id}`.padEnd(26)} ${s.kind.padEnd(7)} → ${r.kind.padEnd(7)} cover ${pct(t.coverage)} err ${px(t.medianError)}${t.wrong ? ' WRONG' : ''} ${t.corners ? `corners ${t.corners}` : ''}${t.markers ? `markers ${t.markers}` : ''}${t.style ? ` style ${t.style}` : ''} pts ${t.points} ${r.timings.totalMs.toFixed(0)}ms${v ? ` Δy ${units(v.yMedian).trim()} (${pctRange(v.yPctMedian).trim()}% of range)` : ''}${r.message ? ` "${r.message}"` : ''}`,
        );
      }
    }
  }

  const tags = [...new Set(scores.flatMap((s) => s.tags))].sort();
  const report: Report = {
    overall: aggregate(scores),
    categories: Object.fromEntries(tags.map((tag) => [tag, aggregate(scores.filter((s) => s.tags.includes(tag)))])),
    traces: Object.fromEntries(scores.map((s) => [`${s.chart}/${s.series}`, report1(s)])),
  };
  console.log(HEADER);
  console.log(row('OVERALL', report.overall));
  for (const tag of tags) console.log(row(tag, report.categories[tag]!));
  const values = valueRows(scores, tags);
  if (values.length) {
    console.log(`\n${VALUE_HEADER}`);
    for (const [name, what, v] of values) console.log(valueRow(name, what, v));
  }
  console.log(`\n${scores.length} traces on ${charts.length} images in ${((performance.now() - started) / 1000).toFixed(1)} s (incl. decoding and detection)`);
  console.log(
    `kind: auto chose curve/markers right; cover: % of the true x-range traced within ${COVER_PX} px; med/p95-px: centreline error of traced points; wrong: traces that follow another series; corner: step corners within ${CORNER_PX} px of a suggested point; mk-R/mk-P: marker recall/precision; mk-grp: found markers of another series (wrong group); style: curves whose line style is reported right; ms: per trace (not gated)`,
  );
  if (values.length) {
    console.log(
      `values (figures with calibrated axes; reported, not gated): the same errors through the engine's calibration from the label's outermost ticks — points: traced points vs the nearest truth point; corners/markers: matched ones vs their true position; Δx/Δy-med/p95: median/p95 in data units (only within one figure, else –); Δx%/Δy%: as % of the labelled axis range`,
    );
  }

  if (summaryPath) {
    const out = writeSummary(summaryPath, summaryOf(report, tags, values));
    console.log(`\nWrote ${out.csv} and ${out.json}`);
  }
  if (only) return 0;
  const stripped = strip(report);
  writeFileSync(LAST_RUN, JSON.stringify(stripped, null, 1) + '\n');
  if (update || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, JSON.stringify(stripped, null, 1) + '\n');
    console.log(`\nWrote ${BASELINE}`);
    return 0;
  }
  return compare(JSON.parse(readFileSync(BASELINE, 'utf8')) as Report, stripped);
}

/** Rounded, timings dropped: what the baseline stores and is compared on. */
function strip(r: Report): Report {
  const m = (x: Metrics): Metrics => {
    const out = { ...x, meanMs: 0 };
    for (const { key } of GATED) (out[key] as number | null) = round(x[key] as number | null);
    return out;
  };
  return {
    overall: m(r.overall),
    categories: Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, m(v)])),
    traces: r.traces,
  };
}

function compare(base: Report, now: Report): number {
  const problems: string[] = [];
  const check = (name: string, b: Metrics | undefined, n: Metrics) => {
    if (!b) return;
    for (const { key, higherIsBetter } of GATED) {
      const bv = b[key] as number | null;
      const nv = n[key] as number | null;
      if (bv === null || bv === undefined) continue;
      if (nv === null) {
        problems.push(`${name}: ${key} missing (baseline ${bv})`);
        continue;
      }
      if (higherIsBetter ? nv < bv - EPS : nv > bv + EPS) problems.push(`${name}: ${key} ${bv} → ${nv}`);
    }
  };
  check('OVERALL', base.overall, now.overall);
  for (const [tag, m] of Object.entries(now.categories)) check(tag, base.categories[tag], m);
  for (const tag of Object.keys(base.categories)) if (!now.categories[tag]) problems.push(`category ${tag} disappeared from the corpus`);

  const changed: string[] = [];
  for (const [id, b] of Object.entries(base.traces)) {
    const n = now.traces[id];
    if (!n) {
      changed.push(`${id}: missing from this run`);
      continue;
    }
    const diffs = (Object.keys(b) as (keyof TraceReport)[])
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(n[k]))
      .map((k) => `${k} ${JSON.stringify(b[k])} → ${JSON.stringify(n[k])}`);
    if (diffs.length) changed.push(`${id}: ${diffs.join(', ')}`);
  }
  if (changed.length) console.log(`\nChanged vs baseline:\n  ${changed.join('\n  ')}`);
  if (problems.length) {
    console.error(`\nREGRESSION vs bench/lines/baseline.json:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log('\nNo regression vs bench/lines/baseline.json.');
  return 0;
}

process.exit(main());
