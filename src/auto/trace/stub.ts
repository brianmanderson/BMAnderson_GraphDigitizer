/**
 * STUB — NOT THE REAL TRACER. A stand-in for `traceLine()` (src/auto/trace/index.ts, built in a
 * separate change) so the Auto-trace UI, worker wiring and e2e can be built against the fixed
 * contract in `types.ts`. It samples the seed's colour and follows pixels of that colour left and
 * right of the seed, column by column, staying near the previous row. No markers detection, no
 * plot box, no confidence model. The app reaches it only through `src/workers/traceImpl.ts`;
 * delete this file once the real engine is wired in there.
 */

import type { TraceRequest, TraceResult, TracedPoint } from './types.ts';

/** Max RGB distance from the seed colour that still counts as the series. */
const COLOR_TOL = 70;
/** Rows above/below the previous column's centre searched in the next column. */
const ROW_WINDOW = 6;
/** Columns without a match before the walk stops (a marker drawn over the line hides it). */
const MAX_GAP = 12;

export function traceLineStub(req: TraceRequest): TraceResult {
  const t0 = Date.now();
  const { rgba, width, height } = req;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
  };
  const sx = Math.min(width - 1, Math.max(0, Math.round(req.seed.px)));
  const sy = Math.min(height - 1, Math.max(0, Math.round(req.seed.py)));

  // The seed colour: the darkest pixel within 2 px (a click lands near, not on, a thin line).
  let color = at(sx, sy);
  for (let y = Math.max(0, sy - 2); y <= Math.min(height - 1, sy + 2); y++) {
    for (let x = Math.max(0, sx - 2); x <= Math.min(width - 1, sx + 2); x++) {
      const c = at(x, y);
      if (c[0] + c[1] + c[2] < color[0] + color[1] + color[2]) color = c;
    }
  }
  const none = (message: string): TraceResult => ({
    ok: false,
    kind: 'none',
    color,
    path: [],
    points: [],
    message,
    timings: { totalMs: Date.now() - t0 },
  });
  if (color[0] + color[1] + color[2] > 3 * 230) return none('There is no line or marker under the click.');

  const matches = (c: [number, number, number]) => Math.hypot(c[0] - color[0], c[1] - color[1], c[2] - color[2]) <= COLOR_TOL;
  /** Mean row of matching pixels in column x within the window around `row`, or null. */
  const centre = (x: number, row: number): number | null => {
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, Math.round(row) - ROW_WINDOW); y <= Math.min(height - 1, Math.round(row) + ROW_WINDOW); y++) {
      if (matches(at(x, y))) {
        sum += y;
        n++;
      }
    }
    return n > 0 ? sum / n : null;
  };

  const walk = (dir: 1 | -1): TracedPoint[] => {
    const out: TracedPoint[] = [];
    let row = sy;
    let gap = 0;
    for (let x = sx + dir; x >= 0 && x < width && gap <= MAX_GAP; x += dir) {
      const c = centre(x, row);
      if (c === null) {
        gap++;
        continue;
      }
      gap = 0;
      row = c;
      out.push({ px: x, py: c, confidence: 0.5 });
    }
    return out;
  };
  const start = centre(sx, sy);
  const path = [...walk(-1).reverse(), ...(start === null ? [] : [{ px: sx, py: start, confidence: 0.5 }]), ...walk(1)];
  if (path.length < 2) return none('Could not follow a line from the click.');

  const n = Math.max(2, Math.min(req.maxPoints, path.length));
  const points = Array.from({ length: n }, (_, i) => path[Math.round((i * (path.length - 1)) / (n - 1))]!);
  return {
    ok: true,
    kind: req.mode === 'markers' ? 'markers' : 'curve',
    color,
    path,
    points,
    timings: { totalMs: Date.now() - t0 },
  };
}
