/** Reading a user-supplied file into a ProjectImage, entirely in the browser. */

import type { ProjectImage } from '../core/index.ts';

export type LoadImageResult = { ok: true; image: ProjectImage } | { ok: false; message: string };

/** Raster formats from docs/SPEC.md. Other image/* types are tried and kept if they decode. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Decode a data URL into an <img>. Rejects if the browser cannot decode it. */
export function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = dataUrl;
  });
}

export async function loadImageFile(file: File): Promise<LoadImageResult> {
  const name = file.name || 'pasted-image';
  if (!file.type.startsWith('image/')) {
    const kind = file.type ? ` (${file.type})` : '';
    return { ok: false, message: `"${name}"${kind} is not an image. Use a PNG, JPEG, GIF, WebP or BMP file.` };
  }
  if (file.type === 'image/svg+xml') {
    return { ok: false, message: `"${name}" is a vector (SVG) image, which is not supported. Export it as PNG first.` };
  }
  try {
    const dataUrl = await readAsDataUrl(file);
    const img = await decodeImage(dataUrl);
    if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error('empty image');
    return { ok: true, image: { dataUrl, width: img.naturalWidth, height: img.naturalHeight, name } };
  } catch {
    return { ok: false, message: `"${name}" could not be read as an image. The file may be damaged.` };
  }
}

/** The first image-like file in a DataTransfer (drop or paste), if any. */
export function firstFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  if (data.files.length > 0) return data.files[0] ?? null;
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}
