/**
 * The magnifier loupe: a square inset in a corner of the workspace showing the source image
 * around a point, nearest-neighbour, with a crosshair and the pixel under it outlined.
 *
 * It samples the decoded source image, not the main canvas, so it stays sharp at any main-view
 * zoom. The magnification is relative to the main view (6× shows image pixels six times larger
 * than the canvas does), rounded so every image pixel covers a whole number of device pixels:
 * pixel edges stay crisp on high-DPI screens too.
 */

export const LOUPE_SIZE = 180; // CSS px
export const LOUPE_MARGIN = 12; // CSS px from the workspace edges
/** Extra clearance around the loupe that already counts as "covering the cursor". */
const LOUPE_CLEARANCE = 24;
export const LOUPE_ZOOMS = [2, 3, 4, 6, 8, 12, 16] as const;
export const DEFAULT_LOUPE_ZOOM = 6;
/** At least this many image pixels stay visible across the loupe, however far it zooms. */
const MIN_VISIBLE_PIXELS = 5;

export type LoupeCorner = 'top-left' | 'top-right';

/** Top-left by default; the opposite (top-right) corner when the top-left one would cover `at`. */
export function loupeCorner(at: { x: number; y: number }, viewportWidth: number): LoupeCorner {
  const reach = LOUPE_MARGIN + LOUPE_SIZE + LOUPE_CLEARANCE;
  const coversCursor = at.x <= reach && at.y <= reach;
  return coversCursor && viewportWidth >= 2 * (LOUPE_SIZE + LOUPE_MARGIN) ? 'top-right' : 'top-left';
}

/** Device pixels per image pixel in the loupe: a whole number ≥ 1. */
export function loupeCell(viewScale: number, zoom: number, dpr: number): number {
  const max = Math.floor((LOUPE_SIZE * dpr) / MIN_VISIBLE_PIXELS);
  return Math.max(1, Math.min(max, Math.round(viewScale * zoom * dpr)));
}

/**
 * Device-pixel x (or y) of the left (top) edge of image pixel 0 when image coordinate `c` sits at
 * the loupe centre; rounded so pixel edges fall on device pixels.
 */
export function loupeOrigin(c: number, cell: number, sizeDevice: number): number {
  return Math.round(sizeDevice / 2 - (c + 0.5) * cell);
}

export interface LoupeMarker {
  px: number;
  py: number;
  color: string;
}

export interface LoupeInput {
  ctx: CanvasRenderingContext2D;
  image: CanvasImageSource;
  imageWidth: number;
  imageHeight: number;
  /** Image coordinates at the loupe centre. */
  px: number;
  py: number;
  cell: number;
  /** Canvas size in device pixels (square). */
  size: number;
  dpr: number;
  markers: LoupeMarker[];
  /** Where a click would snap to, if snapping is on and found a marker. */
  snap: { px: number; py: number; color: string } | null;
}

export function drawLoupe(input: LoupeInput): void {
  const { ctx, image, imageWidth, imageHeight, px, py, cell, size, dpr } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#9aa0a8';
  ctx.fillRect(0, 0, size, size);

  const ox = loupeOrigin(px, cell, size);
  const oy = loupeOrigin(py, cell, size);
  // Whole source pixels that reach into the loupe, so the copy is an exact integer scale-up.
  const i0 = Math.max(0, Math.floor(-ox / cell));
  const j0 = Math.max(0, Math.floor(-oy / cell));
  const i1 = Math.min(imageWidth, Math.ceil((size - ox) / cell));
  const j1 = Math.min(imageHeight, Math.ceil((size - oy) / cell));
  if (i1 > i0 && j1 > j0) {
    ctx.drawImage(image, i0, j0, i1 - i0, j1 - j0, ox + i0 * cell, oy + j0 * cell, (i1 - i0) * cell, (j1 - j0) * cell);
  }
  const toX = (u: number) => ox + (u + 0.5) * cell;
  const toY = (v: number) => oy + (v + 0.5) * cell;

  for (const m of input.markers) {
    ctx.beginPath();
    ctx.arc(toX(m.px), toY(m.py), 4 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = m.color;
    ctx.stroke();
  }

  const cx = toX(px);
  const cy = toY(py);
  if (input.snap) {
    const sx = toX(input.snap.px);
    const sy = toY(input.snap.py);
    ctx.save();
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = input.snap.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(5 * dpr, cell * 0.8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // The pixel under the centre, outlined in black and white so it shows on any colour.
  const pi = Math.round(px);
  const pj = Math.round(py);
  const lw = Math.max(1, Math.round(dpr));
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(ox + pi * cell - lw / 2, oy + pj * cell - lw / 2, cell + lw, cell + lw);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(ox + pi * cell - (3 * lw) / 2, oy + pj * cell - (3 * lw) / 2, cell + 3 * lw, cell + 3 * lw);

  // Crosshair through the exact centre: thin and translucent, so the axis line or curve being
  // lined up under it stays visible; a gap keeps the outlined pixel clear.
  const gap = cell / 2 + 6 * dpr;
  const arm = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(201, 42, 42, 0.7)';
  ctx.lineWidth = dpr;
  arm(0, cy, cx - gap, cy);
  arm(cx + gap, cy, size, cy);
  arm(cx, 0, cx, cy - gap);
  arm(cx, cy + gap, cx, size);
}
