import { useEffect, useRef } from 'react';
import {
  REF_NAMES,
  SCALE_LABELS,
  SCALE_TYPES,
  formatDateTime,
  isScaleType,
  parseDateTime,
  type CalibrationResult,
  type RefName,
  type ScaleType,
} from '../core/index.ts';
import type { DocState } from '../state/doc.ts';
import type { AutoState } from '../ui/suggestion.ts';
import { AutoDetectPanel } from './AutoDetectPanel.tsx';
import { REF_COLORS } from '../ui/draw.ts';
import { formatPixel } from '../ui/table.ts';

interface Props {
  doc: DocState;
  result: CalibrationResult | null;
  placingRef: RefName | null;
  /** Ref whose value input should take focus (set right after it is placed). */
  focusRef: RefName | null;
  onFocused: () => void;
  onScale: (axis: 'x' | 'y', scale: ScaleType) => void;
  onValue: (ref: RefName, value: string) => void;
  onPlace: (ref: RefName | null) => void;
  onContinue: () => void;
  auto: AutoState;
  /** Whether the image is decoded and auto-detect can run. */
  canAutoDetect: boolean;
  onAutoDetect: () => void;
  onAutoValue: (ref: RefName, value: string) => void;
  onAutoAccept: () => void;
  onAutoDiscard: () => void;
}

const PROMPTS: Record<RefName, string> = {
  X1: 'Click a point on the X axis with a known value (X1).',
  X2: 'Click a second point on the X axis, far from X1 (X2).',
  Y1: 'Click a point on the Y axis with a known value (Y1).',
  Y2: 'Click a second point on the Y axis, far from Y1 (Y2).',
};

const INTERPRETATION_FORMAT = 'YYYY-MM-DD HH:mm:ss[ UTC]';

function DateHint({ text }: { text: string }) {
  if (text.trim() === '') return <span className="hint muted">e.g. 2024-03-15 or 2024-03-15 14:30</span>;
  const parsed = parseDateTime(text);
  return parsed.ok ? (
    <span className="hint ok" data-testid="date-hint">= {formatDateTime(parsed.ms, INTERPRETATION_FORMAT)}</span>
  ) : (
    <span className="hint bad" data-testid="date-hint">{parsed.message}</span>
  );
}

export function AxesStep(props: Props) {
  const { doc, result, placingRef, focusRef, onFocused, onScale, onValue, onPlace, onContinue } = props;
  const inputs = useRef<Partial<Record<RefName, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!focusRef) return;
    inputs.current[focusRef]?.focus();
    inputs.current[focusRef]?.select();
    onFocused();
  }, [focusRef, onFocused]);

  const errorRef = result && !result.ok && 'ref' in result.error ? result.error.ref : null;
  // Refs still waiting for a value: prompt for them instead of showing the engine's error.
  const blank = REF_NAMES.filter((n) => doc.refs[n] !== undefined && doc.refs[n].value.trim() === '');

  const scaleSelect = (axis: 'x' | 'y') => (
    <label className="field">
      <span>{axis.toUpperCase()} scale</span>
      <select
        value={axis === 'x' ? doc.xScale : doc.yScale}
        onChange={(e) => isScaleType(e.target.value) && onScale(axis, e.target.value)}
        aria-label={`${axis.toUpperCase()} scale`}
      >
        {SCALE_TYPES.map((s) => (
          <option key={s} value={s}>
            {SCALE_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="step-body" aria-label="Axes">
      <AutoDetectPanel
        auto={props.auto}
        disabled={!props.canAutoDetect}
        onDetect={props.onAutoDetect}
        onValue={props.onAutoValue}
        onAccept={props.onAutoAccept}
        onDiscard={props.onAutoDiscard}
      />
      <div className="row two">
        {scaleSelect('x')}
        {scaleSelect('y')}
      </div>

      <p className="prompt" data-testid="axes-prompt">
        {placingRef ? PROMPTS[placingRef] : 'All four refs are placed. Drag a marker to adjust it, or use Move to re-place it.'}
      </p>

      <ul className="refs">
        {REF_NAMES.map((name) => {
          const r = doc.refs[name];
          const scale = name.startsWith('X') ? doc.xScale : doc.yScale;
          return (
            <li key={name} className={`ref${placingRef === name ? ' placing' : ''}`}>
              <span className="ref-badge" style={{ background: REF_COLORS[name[0] as 'X' | 'Y'] }}>
                {name}
              </span>
              <div className="ref-main">
                <input
                  ref={(el) => {
                    inputs.current[name] = el;
                  }}
                  type="text"
                  inputMode={scale === 'date' ? 'text' : 'decimal'}
                  placeholder={r ? (scale === 'date' ? 'date/time' : 'value') : 'place first'}
                  disabled={!r}
                  value={r?.value ?? ''}
                  aria-label={`${name} value`}
                  aria-invalid={errorRef === name}
                  onChange={(e) => onValue(name, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                {r && scale === 'date' && <DateHint text={r.value} />}
                <span className="hint muted">{r ? `at (${formatPixel(r.px)}, ${formatPixel(r.py)}) px` : 'not placed'}</span>
              </div>
              <button
                type="button"
                className="small"
                onClick={() => onPlace(placingRef === name ? null : name)}
                aria-pressed={placingRef === name}
              >
                {placingRef === name ? 'Cancel' : r ? 'Move' : 'Place'}
              </button>
            </li>
          );
        })}
      </ul>

      {result && !result.ok && blank.length > 0 && (
        <p className="info" data-testid="calibration-pending">
          Type the known value for {blank.join(', ')}.
        </p>
      )}
      {result && !result.ok && blank.length === 0 && (
        <p className="error" role="alert" data-testid="calibration-error">
          {result.error.message}
        </p>
      )}
      {result?.ok && (
        <div className="ok-box" data-testid="calibration-ok">
          <span>Calibrated. Check the overlay gridlines against the chart.</span>
          <button type="button" className="primary small" onClick={onContinue}>
            Continue to Data →
          </button>
        </div>
      )}
    </section>
  );
}
