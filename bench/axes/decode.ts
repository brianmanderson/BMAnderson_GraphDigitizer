/** Decode a PNG or JPEG file to RGBA in Node (pure JS, so the benchmark needs no browser). */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import type { RgbaImage } from '../../src/auto/index.ts';

export function decodeImage(path: string): RgbaImage {
  const buf = readFileSync(path);
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = pngjs.PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return { width: j.width, height: j.height, data: j.data };
  }
  throw new Error(`${path}: not a PNG or JPEG`);
}
