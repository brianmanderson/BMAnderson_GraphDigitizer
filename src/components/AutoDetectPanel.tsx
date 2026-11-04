import { SCALE_LABELS, type RefName } from '../core/index.ts';
import type { AxisSuggestion } from '../auto/index.ts';
import { REF_COLORS } from '../ui/draw.ts';
import { suggestedRefs, type AutoState } from '../ui/suggestion.ts';
import { formatPixel } from '../ui/table.ts';

const LEVEL_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

interface Props {
  auto: AutoState;
  disabled: boolean;
  onDetect: () => void;
  onValue: (ref: RefName, value: string) => void;
  onAccept: () => void;
  onDiscard: () => void;
}

function AxisBlock({ s, values, onValue }: { s: AxisSuggestion; values: Partial<Record<RefName, string>>; onValue: Props['onValue'] }) {
  const name = s.axis.toUpperCase();
  const refs = suggestedRefs(s);
  return (
    <div className="auto-axis" data-testid={`auto-${s.axis}`}>
      <div className="auto-head">
        <strong>{name} axis</strong>
        <span className="muted">
          {s.scale && s.status === 'calibrated' ? SCALE_LABELS[s.scale] : 'scale not detected'}
          {s.scale && s.status === 'calibrated' && !s.scaleCertain ? ' (uncertain)' : ''}
        </span>
        <span className={`badge ${s.level}`} data-testid={`auto-badge-${s.axis}`} title="How sure the suggestion is">
          {LEVEL_LABEL[s.level]}
          {s.status === 'calibrated' ? ` ${Math.round(100 * s.confidence)}%` : ''}
        </span>
      </div>
      <p className="hint muted" data-testid={`auto-message-${s.axis}`}>
        {s.message}
      </p>
      {refs.length > 0 && (
        <ul className="refs auto-refs">
          {refs.map((r) => (
            <li key={r.name} className="ref">
              <span className="ref-badge ghost" style={{ borderColor: REF_COLORS[s.axis === 'x' ? 'X' : 'Y'] }}>
                {r.name}
              </span>
              <div className="ref-main">
                <input
                  type="text"
                  value={values[r.name] ?? ''}
                  placeholder="type the value"
                  aria-label={`Suggested ${r.name} value`}
                  onChange={(e) => onValue(r.name, e.target.value)}
                />
                <span className="hint muted">
                  at ({formatPixel(r.px)}, {formatPixel(r.py)}) px
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Auto-detect axes" in the Axes step: run, review the suggestion, accept, edit or discard. */
export function AutoDetectPanel({ auto, disabled, onDetect, onValue, onAccept, onDiscard }: Props) {
  if (auto.status === 'idle' || auto.status === 'error') {
    return (
      <div className="auto">
        <button type="button" onClick={onDetect} disabled={disabled} title="Read the axes and tick labels from the image (nothing is uploaded)">
          Auto-detect axes
        </button>
        {auto.status === 'error' && (
          <p className="error" role="alert" data-testid="auto-error">
            Auto-detect failed: {auto.message}
          </p>
        )}
      </div>
    );
  }
  if (auto.status === 'running') {
    return (
      <div className="auto">
        <button type="button" disabled>
          Auto-detect axes
        </button>
        <p className="info" role="status" data-testid="auto-running">
          {auto.stage}
        </p>
      </div>
    );
  }
  const { result, values } = auto;
  const usable = [result.x, result.y].some((s) => s.status !== 'none');
  const t = result.timings;
  return (
    <section className="auto auto-result" aria-label="Suggested calibration" data-testid="auto-suggestion">
      <p className="prompt">
        {result.ok
          ? 'Suggested calibration: check the dashed markers on the chart, edit a value if needed, then accept.'
          : usable
            ? 'Only part of the calibration could be detected. Accept to start from it, then place or type the rest.'
            : 'Nothing reliable was detected. Calibrate by hand below.'}
      </p>
      <AxisBlock s={result.x} values={values} onValue={onValue} />
      <AxisBlock s={result.y} values={values} onValue={onValue} />
      <p className="hint muted" data-testid="auto-timing">
        {result.x.labels.length + result.y.labels.length} labels read in {Math.round(t.totalMs)} ms ({t.ocrCalls} OCR calls).
      </p>
      <div className="row">
        <button type="button" className="primary small" onClick={onAccept} disabled={!usable}>
          Accept suggestion
        </button>
        <button type="button" className="small" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </section>
  );
}
