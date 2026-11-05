import type { TraceMode } from '../auto/trace/types.ts';
import { MAX_TRACE_POINTS, MIN_TRACE_POINTS, TRACE_PROMPT, type TraceSettings, type TraceState, type TraceTarget } from '../ui/trace.ts';

const MODES: { id: TraceMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'curve', label: 'Curve' },
  { id: 'markers', label: 'Markers' },
];
const KIND_LABEL = { curve: 'Curve', markers: 'Markers', none: 'Nothing found' } as const;
/** The traced line's style, as shown after the kind (nothing when the tracer can't tell). */
const STYLE_LABEL = { solid: 'solid', dashed: 'dashed', dotted: 'dotted', 'dash-dot': 'dash-dot', unknown: null } as const;

interface Props {
  trace: TraceState | null;
  settings: TraceSettings;
  /** A valid calibration and a decoded image are needed to trace. */
  canTrace: boolean;
  activeName: string;
  activeHasPoints: boolean;
  /** The colour the traced points will get. */
  color: string;
  /** The number of points Accept would add. */
  count: number;
  onStart: (target: TraceTarget) => void;
  onSettings: (patch: Partial<TraceSettings>) => void;
  onAccept: () => void;
  onDiscard: () => void;
}

/**
 * "Auto-trace line" in the Data step: pick a series with one click, review the proposed points
 * (ghosts on the chart), tune the point count or mode (each change re-runs the trace), then
 * accept them into the active line (or a new one) or discard them.
 */
export function TracePanel({ trace, settings, canTrace, activeName, activeHasPoints, color, count, onStart, onSettings, onAccept, onDiscard }: Props) {
  if (!trace) {
    const title = canTrace ? `Click a plotted series to propose its points for ${activeName}` : 'Calibrate the axes first';
    return (
      <div className="row trace-start">
        <button type="button" className="small" onClick={() => onStart('active')} disabled={!canTrace} title={title}>
          Auto-trace line
        </button>
        {activeHasPoints && (
          <button type="button" className="small" onClick={() => onStart('new')} disabled={!canTrace} title="Trace a series into a new line">
            Trace into a new line
          </button>
        )}
      </div>
    );
  }

  const into = trace.target === 'new' ? 'a new line' : activeName;
  const result = trace.status === 'done' ? trace.result : null;
  const style = result?.kind === 'curve' ? STYLE_LABEL[result.style] : null;
  return (
    <section className="auto-result trace" aria-label="Auto-trace" data-testid="trace-panel">
      <p className="prompt">
        <span className="swatch ghost" style={{ borderColor: color }} /> Auto-trace into <strong>{into}</strong>
      </p>
      {trace.status === 'picking' && (
        <p className="info" role="status">
          {TRACE_PROMPT}.
        </p>
      )}
      {trace.status === 'running' && (
        <p className="info" role="status" data-testid="trace-running">
          Tracing…
        </p>
      )}
      {trace.status === 'error' && (
        <p className="error" role="alert" data-testid="trace-error">
          Auto-trace failed: {trace.message}
        </p>
      )}
      {result && (
        <>
          <p data-testid="trace-result">
            Detected: <strong data-testid="trace-kind">{KIND_LABEL[result.kind]}</strong>
            {style && (
              <>
                , <strong data-testid="trace-style">{style}</strong> line
              </>
            )}{' '}
            ·{' '}
            <strong data-testid="trace-count">{count}</strong> point{count === 1 ? '' : 's'}
            <span className="muted"> in {Math.round(result.timings.totalMs)} ms</span>
          </p>
          {result.message && <p className="hint muted">{result.message}</p>}
          {style && <p className="hint muted">Keeps to the {style} line: lines of the same colour in another style are skipped.</p>}
          <p className="hint muted">Check the dashed points on the chart. Click elsewhere on the series to trace from there.</p>
        </>
      )}
      <div className="row trace-settings">
        <label className="inline">
          Points
          <input
            type="range"
            min={MIN_TRACE_POINTS}
            max={MAX_TRACE_POINTS}
            value={settings.maxPoints}
            onChange={(e) => onSettings({ maxPoints: Number(e.target.value) })}
            aria-label="Points"
          />
          <input
            type="number"
            min={MIN_TRACE_POINTS}
            max={MAX_TRACE_POINTS}
            value={settings.maxPoints}
            onChange={(e) => e.target.value !== '' && onSettings({ maxPoints: Number(e.target.value) })}
            aria-label="Number of points"
          />
        </label>
        <label className="inline">
          Mode
          <select value={settings.mode} onChange={(e) => onSettings({ mode: e.target.value as TraceMode })} aria-label="Trace mode">
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <button type="button" className="primary small" onClick={onAccept} disabled={count === 0}>
          Accept
        </button>
        <button type="button" className="small" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </section>
  );
}
