/**
 * A small pool of Tesseract.js workers implementing the pipeline's `OcrEngine` (Phase 5). Shared
 * by the app (src/ui/ocr.ts, browser workers) and the benchmark (bench/axes/ocrNode.ts, Node
 * worker threads); each side supplies how a worker is created and how an RGBA crop becomes an
 * image Tesseract accepts.
 *
 * Each request sets its own character whitelist and page-segmentation mode; a worker only
 * re-sends parameters when they differ from its last job.
 */

import type { ImageLike, Worker as TesseractWorker } from 'tesseract.js';
import type { OcrEngine, OcrRequest, RgbaImage } from '../auto/index.ts';

/** Characters allowed per charset ('' = Tesseract's full set). */
export const WHITELISTS: Record<OcrRequest['charset'], string> = {
  numeric: '0123456789.,-+eE×x%',
  text: '',
};

/**
 * Tesseract page-segmentation modes tried in turn until one reads something: 7 = a single text
 * line, 6 = a block, 10 = a single character. A lone "0" label often comes back empty in 7 and
 * 10 but not in 6; a lone exponent digit is read best in 7 or 10 and worst in 6.
 */
const modes = (r: OcrRequest) => (r.singleChar ? ['7', '6', '10'] : ['7', '6']);

interface Slot {
  worker: TesseractWorker;
  params: string;
}

interface Job {
  image: RgbaImage;
  request: OcrRequest;
  resolve: (r: { text: string; confidence: number }) => void;
  reject: (e: unknown) => void;
}

export interface PoolOptions {
  size: number;
  create: () => Promise<TesseractWorker>;
  toImage: (img: RgbaImage) => ImageLike | Promise<ImageLike>;
}

export class TesseractPool implements OcrEngine {
  private readonly idle: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly all: Promise<Slot>[];
  private readonly opts: PoolOptions;

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.all = Array.from({ length: Math.max(1, opts.size) }, () =>
      opts.create().then((worker) => {
        const slot = { worker, params: '' };
        this.idle.push(slot);
        this.pump();
        return slot;
      }),
    );
  }

  /** Resolves once every worker has loaded (language data included). */
  async ready(): Promise<void> {
    await Promise.all(this.all);
  }

  recognize(image: RgbaImage, request: OcrRequest): Promise<{ text: string; confidence: number }> {
    return new Promise((resolve, reject) => {
      this.queue.push({ image, request, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const slot = this.idle.pop() as Slot;
      const job = this.queue.shift() as Job;
      void this.run(slot, job);
    }
  }

  private async read(slot: Slot, image: ImageLike, charset: OcrRequest['charset'], mode: string) {
    const params = `${charset}/${mode}`;
    if (slot.params !== params) {
      await slot.worker.setParameters({
        tessedit_char_whitelist: WHITELISTS[charset],
        tessedit_pageseg_mode: mode as never,
      });
      slot.params = params;
    }
    const r = await slot.worker.recognize(image);
    return { text: r.data.text.replace(/\s+/g, ' ').trim(), confidence: r.data.confidence / 100 };
  }

  private async run(slot: Slot, job: Job): Promise<void> {
    try {
      const image = await this.opts.toImage(job.image);
      let r = { text: '', confidence: 0 };
      for (const mode of modes(job.request)) {
        r = await this.read(slot, image, job.request.charset, mode);
        if (r.text !== '') break;
      }
      job.resolve(r);
    } catch (e) {
      job.reject(e);
    } finally {
      this.idle.push(slot);
      this.pump();
    }
  }

  async terminate(): Promise<void> {
    const slots = await Promise.allSettled(this.all);
    await Promise.all(slots.map((s) => (s.status === 'fulfilled' ? s.value.worker.terminate() : undefined)));
  }
}
