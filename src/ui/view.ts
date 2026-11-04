/**
 * The view transform between image pixels and screen (canvas CSS) pixels.
 *
 *   screen = image · scale + offset
 *
 * Image coordinates put the centre of pixel (i, j) at (i, j), so pixel i spans [i − ½, i + ½).
 * The view only changes how the image is shown; stored points never pass through it except to
 * convert a click into image coordinates.
 */

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 64;

export const IDENTITY_VIEW: View = { scale: 1, offsetX: 0, offsetY: 0 };

export function imageToScreen(view: View, px: number, py: number): { x: number; y: number } {
  return { x: px * view.scale + view.offsetX, y: py * view.scale + view.offsetY };
}

export function screenToImage(view: View, x: number, y: number): { px: number; py: number } {
  return { px: (x - view.offsetX) / view.scale, py: (y - view.offsetY) / view.scale };
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Zoom by `factor`, keeping the image point under screen (x, y) fixed. */
export function zoomAt(view: View, x: number, y: number, factor: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, offsetX: x - (x - view.offsetX) * k, offsetY: y - (y - view.offsetY) * k };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

/** Scale and centre the whole image inside a viewport, with a small margin. */
export function fitView(imageWidth: number, imageHeight: number, viewWidth: number, viewHeight: number): View {
  if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return IDENTITY_VIEW;
  const margin = 16;
  const scale = clampScale(
    Math.min((viewWidth - 2 * margin) / imageWidth, (viewHeight - 2 * margin) / imageHeight),
  );
  // The image's outer edges are at −½ and size − ½ in image coordinates.
  return {
    scale,
    offsetX: (viewWidth - imageWidth * scale) / 2 + scale / 2,
    offsetY: (viewHeight - imageHeight * scale) / 2 + scale / 2,
  };
}

/** True when image point (px, py) lies on the image (pixel edges included). */
export function isOnImage(px: number, py: number, width: number, height: number): boolean {
  return px >= -0.5 && py >= -0.5 && px <= width - 0.5 && py <= height - 0.5;
}

export function clampToImage(px: number, py: number, width: number, height: number): { px: number; py: number } {
  return {
    px: Math.min(width - 0.5, Math.max(-0.5, px)),
    py: Math.min(height - 0.5, Math.max(-0.5, py)),
  };
}
