/**
 * Canvas rendering of the workspace: image, calibration overlay, ref markers and data points.
 * All geometry is converted from image pixels with the view transform at draw time.
 */

import { REF_NAMES, forward, type Calibration, type RefName } from '../core/index.ts';
import type { DocState } from '../state/doc.ts';
import { selectionKeys, targetKey, type Selection } from './selection.ts';
import type { Ghost } from './suggestion.ts';
import type { TraceGhost } from './trace.ts';
import { formatValue } from './table.ts';
import { axisTicks } from './ticks.ts';
import { imageToScreen, type View } from './view.ts';

export type Target = { kind: 'ref'; ref: RefName } | { kind: 'point'; datasetId: string; pointId: string };

/** Where a marker is, or null when it no longer exists (e.g. after an undo). */
export function findTargetPos(doc: DocState, t: Target): { px: number; py: number } | null {
  if (t.kind === 'ref') return doc.refs[t.ref] ?? null;
  return doc.datasets.find((d) => d.id === t.datasetId)?.points.find((q) => q.id === t.pointId) ?? null;
}

export const REF_COLORS: Readonly<Record<'X' | 'Y', string>> = { X: '#c92a2a', Y: '#5f3dc4' };
const OVERLAY = 'rgba(12, 133, 153, 0.32)';
const OVERLAY_AXIS = 'rgba(12, 133, 153, 0.85)';
const POINT_RADIUS = 4.5;

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  view: View;
  image: HTMLImageElement | null;
  doc: DocState;
  calibration: Calibration | null;
  /** Selected markers: one ref, or any number of points (each drawn with a ring). */
  selected: Selection;
  hovered: Target | null;
  /** Ref markers are emphasised while calibrating. */
  step: 'image' | 'axes' | 'data';
  /** Where a click would place the next point when snapping is on (image px, blob size). */
  snap: { px: number; py: number; width: number; height: number; color: string } | null;
  /** A pending auto-detect suggestion, drawn as dashed "ghost" markers in the Axes step. */
  ghost?: Ghost | null;
  /** An auto-trace under review, drawn as hollow dashed points in the Data step. */
  trace?: TraceGhost | null;
  /** A rubber-band selection being dragged (screen CSS px corners). */
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** The crop being chosen (Image step, crop mode): whole-pixel columns x0…x1−1, rows y0…y1−1. */
  crop?: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function drawWorkspace(input: DrawInput): void {
  const { ctx, width, height, dpr, view, image, doc } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!image) return;

  const { width: iw, height: ih } = doc.image;
  const s = view.scale;
  const left = view.offsetX - s / 2;
  const top = view.offsetY - s / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = s < 3;
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#fff';
  ctx.fillRect(left, top, iw * s, ih * s);
  ctx.shadowBlur = 0;
  ctx.drawImage(image, left, top, iw * s, ih * s);
  ctx.restore();

  if (input.calibration) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, iw * s, ih * s);
    ctx.clip();
    drawOverlay(input, input.calibration);
    ctx.restore();
  }

  const selected = selectionKeys(input.selected);
  const hovered = input.hovered ? targetKey(input.hovered) : null;
  for (const d of doc.datasets) {
    for (const p of d.points) {
      const key = `${d.id}/${p.id}`;
      drawPoint(ctx, imageToScreen(view, p.px, p.py), d.color, selected.has(key), hovered === key);
    }
  }

  for (const name of REF_NAMES) {
    const r = doc.refs[name];
    if (!r) continue;
    drawRef(ctx, imageToScreen(view, r.px, r.py), name, input.step === 'axes', hovered === name || selected.has(name));
  }

  if (input.ghost && input.step === 'axes') drawGhost(ctx, view, input.ghost);
  if (input.trace && input.step === 'data') drawTraceGhost(ctx, view, input.trace);
  if (input.snap) drawSnap(ctx, view, input.snap);
  if (input.marquee) drawMarquee(ctx, input.marquee);
  if (input.crop) drawCrop(ctx, view, iw, ih, input.crop);
}

/** The rubber band: a dashed dark outline over a white one, faintly filled, on any chart. */
function drawMarquee(ctx: CanvasRenderingContext2D, m: NonNullable<DrawInput['marquee']>) {
  const x = Math.min(m.x0, m.x1);
  const y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);
  ctx.save();
  ctx.fillStyle = 'rgba(28, 126, 214, 0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  dashedOutline(ctx, x, y, w, h);
}

/**
 * The crop being chosen: the image outside it dimmed (a fixed translucent dark, since the canvas
 * is not themed) and its outline drawn like the marquee. The rectangle's edges lie on pixel
 * edges (x0 − ½ … x1 − ½ in image coordinates).
 */
function drawCrop(ctx: CanvasRenderingContext2D, view: View, iw: number, ih: number, c: NonNullable<DrawInput['crop']>) {
  const a = imageToScreen(view, c.x0 - 0.5, c.y0 - 0.5);
  const b = imageToScreen(view, c.x1 - 0.5, c.y1 - 0.5);
  const img = imageToScreen(view, -0.5, -0.5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(img.x, img.y, iw * view.scale, ih * view.scale);
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fill('evenodd');
  ctx.restore();
  dashedOutline(ctx, a.x, a.y, b.x - a.x, b.y - a.y);
}

/** A dashed dark outline over a white one, so it reads on any chart. */
function dashedOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(33, 37, 41, 0.9)';
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

const GHOST_LINE = 'rgba(12, 133, 153, 0.9)';

/**
 * A suggestion: the detected axis lines (dashed), a thin box round each tick label that was read
 * (teal when it agrees with the suggested scale, red when not) and dashed ref markers labelled
 * with their suggested values ("X1 = 20").
 */
function drawGhost(ctx: CanvasRenderingContext2D, view: View, ghost: Ghost) {
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = GHOST_LINE;
  for (const l of ghost.lines) line(ctx, imageToScreen(view, l.p1.x, l.p1.y), imageToScreen(view, l.p2.x, l.p2.y));
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  for (const b of ghost.labels) {
    const c = imageToScreen(view, b.center.x, b.center.y);
    const w = b.width * view.scale + 4;
    const h = b.height * view.scale + 4;
    ctx.strokeStyle = b.inlier ? 'rgba(12, 133, 153, 0.7)' : 'rgba(201, 42, 42, 0.8)';
    ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
  }
  ctx.font = 'bold 11px system-ui, sans-serif';
  for (const r of ghost.refs) {
    const p = imageToScreen(view, r.px, r.py);
    const color = REF_COLORS[r.name[0] as 'X' | 'Y'];
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    line(ctx, { x: p.x - 11, y: p.y }, { x: p.x + 11, y: p.y });
    line(ctx, { x: p.x, y: p.y - 11 }, { x: p.x, y: p.y + 11 });
    ctx.setLineDash([]);
    const text = `${r.name} = ${r.value === '' ? '?' : r.value}`;
    const tw = ctx.measureText(text).width;
    const lx = p.x + 9;
    const ly = r.name[0] === 'X' ? p.y + 8 : p.y - 24;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw + 8, 16, 3);
    ctx.fill();
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 4, ly + 8.5);
  }
  ctx.restore();
}

/**
 * A trace under review: the followed path as a faint dashed line, the proposed points as hollow
 * dashed rings in the colour they will get, and a small cross at the click it started from. Every
 * mark has a white halo like the placed points, so it reads on light and dark charts alike.
 */
function drawTraceGhost(ctx: CanvasRenderingContext2D, view: View, g: TraceGhost) {
  ctx.save();
  if (g.path.length > 1) {
    ctx.beginPath();
    g.path.forEach((q, i) => {
      const p = imageToScreen(view, q.px, q.py);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = g.color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const q of g.points) {
    const p = imageToScreen(view, q.px, q.py);
    ctx.beginPath();
    ctx.arc(p.x, p.y, POINT_RADIUS + 1, 0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = g.color;
    ctx.stroke();
  }
  if (g.seed) {
    const p = imageToScreen(view, g.seed.px, g.seed.py);
    ctx.setLineDash([]);
    for (const [width, style] of [
      [3.5, 'rgba(255,255,255,0.9)'],
      [1.5, g.color],
    ] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      line(ctx, { x: p.x - 6, y: p.y - 6 }, { x: p.x + 6, y: p.y + 6 });
      line(ctx, { x: p.x - 6, y: p.y + 6 }, { x: p.x + 6, y: p.y - 6 });
    }
  }
  ctx.restore();
}

/** Dashed ring around the blob a click would snap to, with a dot at its centroid. */
function drawSnap(ctx: CanvasRenderingContext2D, view: View, snap: NonNullable<DrawInput['snap']>) {
  const p = imageToScreen(view, snap.px, snap.py);
  const radius = Math.max(7, (Math.max(snap.width, snap.height) * view.scale) / 2 + 4);
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = snap.color;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 1.75, 0, Math.PI * 2);
  ctx.fillStyle = snap.color;
  ctx.fill();
  ctx.restore();
}

function line(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline) {
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Faint gridlines at round values plus the two calibrated axis lines, drawn via the fit. */
function drawOverlay(input: DrawInput, cal: Calibration) {
  const { ctx, view, doc } = input;
  const { width: iw, height: ih } = doc.image;
  const corners = [
    [-0.5, -0.5],
    [iw - 0.5, -0.5],
    [-0.5, ih - 0.5],
    [iw - 0.5, ih - 0.5],
  ].map(([px, py]) => cal.pixelToLinear(px!, py!));
  const uLo = Math.min(...corners.map((c) => c.u));
  const uHi = Math.max(...corners.map((c) => c.u));
  const wLo = Math.min(...corners.map((c) => c.w));
  const wHi = Math.max(...corners.map((c) => c.w));
  const toScreen = (u: number, w: number) => {
    const p = cal.linearToPixel(u, w);
    return imageToScreen(view, p.px, p.py);
  };
  // The X refs share one y (w) value and the Y refs one x (u) value: those are the axis lines.
  const wAxis = cal.pixelToLinear(doc.refs.X1!.px, doc.refs.X1!.py).w;
  const uAxis = cal.pixelToLinear(doc.refs.Y1!.px, doc.refs.Y1!.py).u;
  const fmt = { significantFigures: doc.settings.significantFigures, dateFormat: doc.settings.dateFormat };

  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = OVERLAY;
  const xTicks = axisTicks(doc.xScale, uLo, uHi, [cal.refValues.X1, cal.refValues.X2]);
  const yTicks = axisTicks(doc.yScale, wLo, wHi, [cal.refValues.Y1, cal.refValues.Y2]);
  for (const v of xTicks) {
    const u = forward(doc.xScale, v)!;
    line(ctx, toScreen(u, wLo), toScreen(u, wHi));
  }
  for (const v of yTicks) {
    const w = forward(doc.yScale, v)!;
    line(ctx, toScreen(uLo, w), toScreen(uHi, w));
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = OVERLAY_AXIS;
  ctx.lineWidth = 1.5;
  line(ctx, toScreen(uLo, wAxis), toScreen(uHi, wAxis));
  line(ctx, toScreen(uAxis, wLo), toScreen(uAxis, wHi));

  ctx.fillStyle = OVERLAY_AXIS;
  for (const v of xTicks) {
    const p = toScreen(forward(doc.xScale, v)!, wAxis);
    label(ctx, formatValue(v, doc.xScale, fmt), p.x + 3, p.y + 3, 'left', 'top');
  }
  for (const v of yTicks) {
    const p = toScreen(uAxis, forward(doc.yScale, v)!);
    label(ctx, formatValue(v, doc.yScale, fmt), p.x + 4, p.y - 3, 'left', 'bottom');
  }
}

function drawPoint(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, color: string, selected: boolean, hovered: boolean) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, hovered ? POINT_RADIUS + 1.5 : POINT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  if (selected) {
    // A ring in the line's colour on a white halo, so it reads on light and dark charts.
    ctx.beginPath();
    ctx.arc(p.x, p.y, POINT_RADIUS + 4.5, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function drawRef(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, name: RefName, active: boolean, hovered: boolean) {
  const color = REF_COLORS[name[0] as 'X' | 'Y'];
  const arm = hovered ? 12 : 9;
  ctx.save();
  ctx.globalAlpha = active ? 1 : 0.55;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  line(ctx, { x: p.x - arm, y: p.y }, { x: p.x + arm, y: p.y });
  line(ctx, { x: p.x, y: p.y - arm }, { x: p.x, y: p.y + arm });
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = color;
  line(ctx, { x: p.x - arm, y: p.y }, { x: p.x + arm, y: p.y });
  line(ctx, { x: p.x, y: p.y - arm }, { x: p.x, y: p.y + arm });
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = 'bold 11px system-ui, sans-serif';
  const tw = ctx.measureText(name).width;
  // X labels sit above-right, Y labels below-right, so X1 and Y1 at a shared origin stay legible.
  const lx = p.x + 7;
  const ly = name[0] === 'X' ? p.y - 22 : p.y + 7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(lx, ly, tw + 8, 15, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, lx + 4, ly + 8);
  ctx.restore();
}

/** Screen distance (CSS px) within which a click grabs a marker. */
export const HIT_RADIUS = 9;

/**
 * The marker under screen point (x, y). Only the current step's markers are live: refs while
 * calibrating, data points otherwise, so a click in one step cannot move the other's markers.
 * Among overlapping points the active dataset's win.
 */
export function hitTest(doc: DocState, view: View, x: number, y: number, step: DrawInput['step']): Target | null {
  let best: Target | null = null;
  let bestD = Infinity;
  const consider = (target: Target, px: number, py: number, bias: number) => {
    const s = imageToScreen(view, px, py);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= HIT_RADIUS && d + bias < bestD) {
      best = target;
      bestD = d + bias;
    }
  };
  if (step === 'axes') {
    for (const name of REF_NAMES) {
      const r = doc.refs[name];
      if (r) consider({ kind: 'ref', ref: name }, r.px, r.py, 0);
    }
  } else if (step === 'data') {
    for (const d of doc.datasets) {
      const bias = d.id === doc.activeDatasetId ? 0 : 2;
      for (const p of d.points) consider({ kind: 'point', datasetId: d.id, pointId: p.id }, p.px, p.py, bias);
    }
  }
  return best;
}
