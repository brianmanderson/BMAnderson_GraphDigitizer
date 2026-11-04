import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';
import type { Calibration, RefName } from '../core/index.ts';
import type { DocState } from '../state/doc.ts';
import { drawWorkspace, hitTest, type Target } from '../ui/draw.ts';
import { firstFile } from '../ui/loadImage.ts';
import { clampToImage, isOnImage, panBy, screenToImage, zoomAt, type View } from '../ui/view.ts';

export type Step = 'image' | 'axes' | 'data';

interface Props {
  doc: DocState | null;
  image: HTMLImageElement | null;
  calibration: Calibration | null;
  step: Step;
  view: View;
  /** Takes an updater so several input events within one frame compose. */
  onViewChange: Dispatch<SetStateAction<View>>;
  onViewportSize: (width: number, height: number) => void;
  selected: Target | null;
  onSelect: (target: Target | null) => void;
  /** The ref a click on empty canvas places, while calibrating. */
  placingRef: RefName | null;
  onPlaceRef: (ref: RefName, px: number, py: number) => void;
  onAddPoint: (px: number, py: number) => void;
  onMoveTarget: (target: Target, px: number, py: number) => void;
  onCursor: (pos: { px: number; py: number } | null) => void;
  onFile: (file: File) => void;
  onOpenFile: () => void;
}

/** Pointer movement (CSS px) below which a press counts as a click, not a drag. */
const CLICK_SLOP = 3;

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'drag'; target: Target; startX: number; startY: number; dx: number; dy: number; moved: boolean }
  | { kind: 'click'; startX: number; startY: number };

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * The canvas workspace: draws the image and markers through the view transform and turns
 * pointer input into image-pixel edits. Wheel zooms about the cursor; middle-drag or
 * Space+drag pans.
 */
export function Workspace(props: Props) {
  const { doc, image, view, step } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  const [hovered, setHovered] = useState<Target | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dropping, setDropping] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null);

  // Latest props for the native listeners registered once below.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const { onViewportSize } = props;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 });
      onViewportSize(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onViewportSize]);

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const p = latest.current;
      if (!p.doc) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      p.onViewChange((v) => zoomAt(v, x, y, Math.exp(-delta * 0.0015)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !doc) return;
    drawWorkspace({
      ctx,
      width: size.width,
      height: size.height,
      dpr: size.dpr,
      view,
      image,
      doc,
      calibration: props.calibration,
      selected: props.selected,
      hovered,
      step,
    });
  });

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!doc) return;
    const { x, y } = local(e);
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      gesture.current = { kind: 'pan', lastX: x, lastY: y };
    } else if (e.button === 0) {
      const hit = hitTest(doc, view, x, y, step);
      if (hit) {
        props.onSelect(hit);
        const pos = targetPos(doc, hit);
        const at = screenToImage(view, x, y);
        // Keep the grab offset so the marker doesn't jump to the cursor.
        gesture.current = { kind: 'drag', target: hit, startX: x, startY: y, dx: pos.px - at.px, dy: pos.py - at.py, moved: false };
      } else {
        gesture.current = { kind: 'click', startX: x, startY: y };
      }
    } else {
      return;
    }
    setGestureKind(gesture.current.kind);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (e.g. released mid-dispatch); the gesture still works.
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!doc) return;
    const { x, y } = local(e);
    const at = screenToImage(view, x, y);
    props.onCursor(isOnImage(at.px, at.py, doc.image.width, doc.image.height) ? at : null);
    const g = gesture.current;
    if (!g) {
      setHovered(hitTest(doc, view, x, y, step));
      return;
    }
    if (g.kind === 'pan') {
      const dx = x - g.lastX;
      const dy = y - g.lastY;
      props.onViewChange((v) => panBy(v, dx, dy));
      g.lastX = x;
      g.lastY = y;
    } else if (g.kind === 'drag') {
      if (!g.moved && Math.hypot(x - g.startX, y - g.startY) < CLICK_SLOP) return;
      g.moved = true;
      const p = clampToImage(at.px + g.dx, at.py + g.dy, doc.image.width, doc.image.height);
      props.onMoveTarget(g.target, p.px, p.py);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setGestureKind(null);
    if (!doc || !g || g.kind === 'pan') return;
    const { x, y } = local(e);
    const at = screenToImage(view, x, y);
    if (g.kind === 'drag') {
      // A click (not a drag) on another ref still places the pending one: X1 and Y1 usually
      // share the origin pixel.
      const placing = props.placingRef;
      if (!g.moved && step === 'axes' && placing && !(g.target.kind === 'ref' && g.target.ref === placing)) {
        props.onPlaceRef(placing, at.px, at.py);
      }
      return;
    }
    if (Math.hypot(x - g.startX, y - g.startY) >= CLICK_SLOP) return;
    if (!isOnImage(at.px, at.py, doc.image.width, doc.image.height)) {
      props.onSelect(null);
      return;
    }
    if (step === 'axes' && props.placingRef) {
      props.onPlaceRef(props.placingRef, at.px, at.py);
    } else if (step === 'data') {
      props.onAddPoint(at.px, at.py);
    } else {
      props.onSelect(null);
    }
  };

  const placing = (step === 'axes' && props.placingRef !== null) || step === 'data';
  const cursor =
    gestureKind === 'pan' || gestureKind === 'drag'
      ? 'grabbing'
      : spaceHeld || hovered
        ? 'grab'
        : placing
          ? 'crosshair'
          : 'default';

  return (
    <div
      ref={wrapRef}
      className={`workspace${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = firstFile(e.dataTransfer);
        if (file) props.onFile(file);
      }}
      data-testid="workspace"
    >
      <canvas
        ref={canvasRef}
        width={Math.round(size.width * size.dpr)}
        height={Math.round(size.height * size.dpr)}
        style={{ width: size.width, height: size.height, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          setGestureKind(null);
        }}
        onPointerLeave={() => {
          if (!gesture.current) {
            setHovered(null);
            props.onCursor(null);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        onAuxClick={(e) => e.preventDefault()}
        aria-label="Chart workspace"
        data-testid="canvas"
        // The view transform, for tests that click at image coordinates.
        data-scale={view.scale}
        data-offset-x={view.offsetX}
        data-offset-y={view.offsetY}
      />
      {!doc && (
        <div className="empty-state">
          <p className="empty-title">Drop a chart image here</p>
          <p>
            or paste one with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or{' '}
            <button type="button" className="link" onClick={props.onOpenFile}>
              choose a file
            </button>
          </p>
          <p className="muted">PNG, JPEG, GIF, WebP or BMP. The image stays in your browser.</p>
        </div>
      )}
      {dropping && <div className="drop-hint">Drop to load the image</div>}
    </div>
  );
}

function targetPos(doc: DocState, t: Target): { px: number; py: number } {
  if (t.kind === 'ref') return doc.refs[t.ref]!;
  const p = doc.datasets.find((d) => d.id === t.datasetId)?.points.find((q) => q.id === t.pointId);
  return p ?? { px: 0, py: 0 };
}
