/**
 * Cropping the image to one panel (Image step, "Crop…"; docs/SPEC.md → Crop).
 *
 * A crop is a whole-pixel rectangle: columns `x0 … x1 − 1` and rows `y0 … y1 − 1` of the image
 * (`x1 > x0`, `y1 > y0`, inside the image, at least MIN_CROP × MIN_CROP). In the pixel-centre
 * convention its edges are at `x0 − ½` and `x1 − ½`, so a point at `px` becomes `px − x0` and
 * pixel centres stay on pixel centres. The geometry here is pure; only `cropImage` touches the
 * DOM (a canvas), which is why this lives in src/ui and not src/core.
 */

import type { ProjectImage } from '../core/index.ts';

export interface CropRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Smallest crop, in pixels per side. */
export const MIN_CROP = 2;

export type CropField = 'left' | 'top' | 'width' | 'height';

/** The whole image, as a crop. */
export const fullCrop = (width: number, height: number): CropRect => ({ x0: 0, y0: 0, x1: width, y1: height });

export const cropWidth = (r: CropRect) => r.x1 - r.x0;
export const cropHeight = (r: CropRect) => r.y1 - r.y0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Clamp a whole-pixel rectangle into a `width` × `height` image and give it at least MIN_CROP
 * pixels per side (grown to the right/bottom, else pulled back from the far edge). Returns null
 * for an image too small to crop at all or for non-finite input.
 */
export function clampCrop(r: CropRect, width: number, height: number): CropRect | null {
  if (!(width >= MIN_CROP) || !(height >= MIN_CROP)) return null;
  if (![r.x0, r.y0, r.x1, r.y1].every(Number.isFinite)) return null;
  const side = (lo: number, hi: number, size: number) => {
    let a = clamp(Math.round(lo), 0, size - MIN_CROP);
    let b = clamp(Math.round(hi), a + MIN_CROP, size);
    if (b - a < MIN_CROP) {
      b = Math.min(size, a + MIN_CROP);
      a = b - MIN_CROP;
    }
    return [a, b] as const;
  };
  const [x0, x1] = side(r.x0, r.x1, width);
  const [y0, y1] = side(r.y0, r.y1, height);
  return { x0, y0, x1, y1 };
}

/**
 * The crop a drag from image point `a` to `b` (sub-pixel, pixel-centre convention) selects:
 * every pixel the drag touched, clamped to the image.
 */
export function cropFromDrag(a: { px: number; py: number }, b: { px: number; py: number }, width: number, height: number): CropRect | null {
  const first = Math.floor(Math.min(a.px, b.px) + 0.5);
  const last = Math.floor(Math.max(a.px, b.px) + 0.5);
  const top = Math.floor(Math.min(a.py, b.py) + 0.5);
  const bottom = Math.floor(Math.max(a.py, b.py) + 0.5);
  return clampCrop({ x0: first, y0: top, x1: last + 1, y1: bottom + 1 }, width, height);
}

/**
 * The rectangle after one of the panel's fields is edited: Left/Top move it (keeping its size
 * where the image allows), Width/Height resize it from its top-left; the result stays inside
 * the image and at least MIN_CROP × MIN_CROP. A non-finite value leaves it unchanged.
 */
export function setCropField(r: CropRect, field: CropField, value: number, width: number, height: number): CropRect {
  if (!Number.isFinite(value)) return r;
  const v = Math.round(value);
  let next: CropRect;
  switch (field) {
    case 'left': {
      const x0 = clamp(v, 0, width - MIN_CROP);
      next = { ...r, x0, x1: x0 + cropWidth(r) };
      break;
    }
    case 'top': {
      const y0 = clamp(v, 0, height - MIN_CROP);
      next = { ...r, y0, y1: y0 + cropHeight(r) };
      break;
    }
    case 'width':
      next = { ...r, x1: r.x0 + v };
      break;
    case 'height':
      next = { ...r, y1: r.y0 + v };
      break;
  }
  return clampCrop(next, width, height) ?? r;
}

/**
 * Cut the crop out of the decoded image and re-encode it losslessly as a PNG data URL, so a PNG
 * source is cropped exactly and a JPEG source gets no further loss. The result keeps the source's
 * name (exports are named after it).
 */
export function cropImage(img: HTMLImageElement, source: ProjectImage, r: CropRect): ProjectImage {
  const width = cropWidth(r);
  const height = cropHeight(r);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(img, r.x0, r.y0, width, height, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height, name: source.name };
}
