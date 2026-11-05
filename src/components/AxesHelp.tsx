import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { REF_COLORS } from '../ui/draw.ts';

const LABEL = 'How to place axis points';

/** Ref badge in the diagrams: the canvas colour behind white text, like the refs list. */
function Badge({ x, y, name }: { x: number; y: number; name: string }) {
  return (
    <g>
      <rect x={x} y={y} width={22} height={13} rx={3} fill={`var(--ref-${name[0]!.toLowerCase()})`} />
      <text x={x + 11} y={y + 10} textAnchor="middle" className="help-badge-text">
        {name}
      </text>
    </g>
  );
}

/** A ref marker: a ring in the canvas colour over a halo (visible in the dark theme). */
function Ring({ cx, cy, r, axis }: { cx: number; cy: number; r: number; axis: 'x' | 'y' }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} className="help-halo" />
      <circle cx={cx} cy={cy} r={r} className={`help-ring ${axis}`} />
    </g>
  );
}

const refColorVars = { '--ref-x': REF_COLORS.X, '--ref-y': REF_COLORS.Y } as CSSProperties;

/** Example chart: X1/X2 and Y1/Y2 on printed ticks, far apart, X1 and Y1 sharing the origin. */
function DoDiagram() {
  const ox = 72;
  const oy = 120;
  const xs = [0, 10, 20, 30, 40].map((v, i) => ({ v, x: ox + 45 * i }));
  const ys = [0, 50, 100].map((v, i) => ({ v, y: oy - 48 * i }));
  return (
    <svg className="help-svg" viewBox="0 0 270 182" role="img" aria-labelledby="help-do-title" style={refColorVars}>
      <title id="help-do-title">
        Example: X1 at 0 and X2 at 40 on the X axis, Y1 at 0 and Y2 at 100 on the Y axis; X1 and Y1 share the origin.
      </title>
      <path d="M78 30 C 120 34, 160 70, 245 76" className="help-curve" />
      <line x1={ox} y1={oy} x2={252} y2={oy} className="help-axis" />
      <line x1={ox} y1={oy} x2={ox} y2={20} className="help-axis" />
      {xs.map(({ v, x }) => (
        <g key={`x${v}`}>
          <line x1={x} y1={oy} x2={x} y2={oy + 5} className="help-axis" />
          <text x={x} y={oy + 16} textAnchor="middle" className="help-label">
            {v}
          </text>
        </g>
      ))}
      {ys.map(({ v, y }) => (
        <g key={`y${v}`}>
          <line x1={ox - 5} y1={y} x2={ox} y2={y} className="help-axis" />
          <text x={ox - 11} y={y + 4} textAnchor="end" className="help-label">
            {v}
          </text>
        </g>
      ))}
      {/* Markers: rings on the ticks, in the canvas colours. */}
      <Ring cx={ox} cy={oy} r={8} axis="y" />
      <Ring cx={ox} cy={oy} r={4.5} axis="x" />
      <Ring cx={252} cy={oy} r={4.5} axis="x" />
      <Ring cx={ox} cy={24} r={4.5} axis="y" />
      <Badge x={ox - 11} y={oy + 22} name="X1" />
      <Badge x={252 - 11} y={oy + 22} name="X2" />
      <Badge x={14} y={oy - 6} name="Y1" />
      <Badge x={14} y={24 - 6} name="Y2" />
      <text x={ox + 13} y={oy - 20} className="help-note">
        X1 and Y1 may share the origin
      </text>
      <text x={ox + 13} y={oy - 9} className="help-note">
        when its value (0, 0) is known
      </text>
      {/* "Far apart" dimension line between X1 and X2. */}
      <line x1={ox + 2} y1={170} x2={250} y2={170} className="help-dim" markerStart="url(#help-arrow)" markerEnd="url(#help-arrow)" />
      <text x={(ox + 252) / 2} y={166} textAnchor="middle" className="help-note">
        far apart
      </text>
      <defs>
        <marker id="help-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" className="help-arrowhead" />
        </marker>
      </defs>
    </svg>
  );
}

/** Two small mistakes: refs on neighbouring ticks, and a ref between labelled ticks. */
function DontDiagram() {
  const axis = (x0: number) => [0, 1, 2, 3, 4].map((v, i) => ({ v, x: x0 + 30 * i }));
  const left = axis(14);
  const right = axis(166);
  const ay = 30;
  const ticks = (pts: { v: number; x: number }[]) =>
    pts.map(({ v, x }) => (
      <g key={v}>
        <line x1={x} y1={ay} x2={x} y2={ay + 5} className="help-axis" />
        <text x={x} y={ay + 16} textAnchor="middle" className="help-label">
          {v}
        </text>
      </g>
    ));
  const cross = (x: number) => <path d={`M${x - 5} 4 L${x + 5} 14 M${x + 5} 4 L${x - 5} 14`} className="help-cross" />;
  return (
    <svg className="help-svg" viewBox="0 0 300 72" role="img" aria-labelledby="help-dont-title" style={refColorVars}>
      <title id="help-dont-title">
        Don't: X1 and X2 on neighbouring ticks (too close), or X2 between two labelled ticks.
      </title>
      <line x1={14} y1={ay} x2={134} y2={ay} className="help-axis" />
      {ticks(left)}
      <Ring cx={44} cy={ay} r={4.5} axis="x" />
      <Ring cx={74} cy={ay} r={4.5} axis="x" />
      <Badge x={33} y={ay - 21} name="X1" />
      <Badge x={63} y={ay - 21} name="X2" />
      {cross(124)}
      <text x={74} y={68} textAnchor="middle" className="help-note bad">
        too close together
      </text>

      <line x1={166} y1={ay} x2={286} y2={ay} className="help-axis" />
      {ticks(right)}
      <Ring cx={166} cy={ay} r={4.5} axis="x" />
      <Ring cx={242} cy={ay} r={4.5} axis="x" />
      <Badge x={155} y={ay - 21} name="X1" />
      <Badge x={231} y={ay - 21} name="X2" />
      {cross(280)}
      <text x={226} y={68} textAnchor="middle" className="help-note bad">
        not on a labelled tick
      </text>
    </svg>
  );
}

/** "?" button next to the Axes prompt and the help panel it opens (Esc or Close dismiss it). */
export function AxesHelp() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const id = useId();

  useEffect(() => {
    if (open) close.current?.focus();
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="help-btn"
        aria-label={LABEL}
        title={LABEL}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <div
          id={id}
          className="axes-help"
          role="dialog"
          aria-label={LABEL}
          data-testid="axes-help"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Esc closes the help only; it must not also cancel placing in the app's key handler.
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="axes-help-head">
            <strong>{LABEL}</strong>
            <button ref={close} type="button" className="small" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <figure>
            <DoDiagram />
            <figcaption className="hint muted">Do: each ref on a tick whose value is printed, the two far apart.</figcaption>
          </figure>
          <figure>
            <DontDiagram />
            <figcaption className="hint muted">Don't: refs close together, or between labelled ticks.</figcaption>
          </figure>
          <ol className="axes-help-steps">
            <li>
              Click <b>Place</b>, then click exactly on a tick mark whose value is printed.
            </li>
            <li>Type that tick's value. Use two ticks far apart on each axis.</li>
            <li>
              Log and date axes: type the value as printed, e.g. <code>1000</code> or <code>2024-03-15</code>.
            </li>
            <li>
              Or try <b>Auto-detect axes</b> below: it reads the ticks for you.
            </li>
          </ol>
        </div>
      )}
    </>
  );
}
