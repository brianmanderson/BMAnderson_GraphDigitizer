/** Shared e2e helpers: load fixtures, click at image-pixel coordinates, read the table. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

export const fixturePath = (rel: string) => fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));

export function readFixtureJson<T>(rel: string): T {
  return JSON.parse(readFileSync(fixturePath(rel), 'utf8')) as T;
}

export type RefName = 'X1' | 'X2' | 'Y1' | 'Y2';

/** Ground truth of fixtures/synthetic/*.json (written by scripts/make-synthetic-charts.ts). */
export interface SyntheticTruth {
  image: string;
  width: number;
  height: number;
  xAxis: { scale: string; axisLineRow: number; ticks: { value: number | string; px: number }[] };
  yAxis: { scale: string; axisLineCol: number; ticks: { value: number | string; py: number }[] };
  points: { x: number | string; y: number; px: number; py: number }[];
}

export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Drop a chart image here')).toBeVisible();
}

export async function loadViaPicker(page: Page, rel: string) {
  await page.getByTestId('file-input').setInputFiles(fixturePath(rel));
  await expect(page.getByTestId('notice')).toContainText('Loaded');
}

/** Screen (client) position of image pixel (px, py) under the current view transform. */
export async function imageToClient(page: Page, px: number, py: number) {
  const canvas = page.getByTestId('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not visible');
  const [s, ox, oy] = await canvas.evaluate((el) => [
    Number(el.dataset.scale),
    Number(el.dataset.offsetX),
    Number(el.dataset.offsetY),
  ]);
  return { x: box.x + ox! + px * s!, y: box.y + oy! + py * s! };
}

export async function clickImage(page: Page, px: number, py: number) {
  const p = await imageToClient(page, px, py);
  await page.mouse.click(p.x, p.y);
}

/** Place the four refs in guided order, typing each value after its click. */
export async function calibrate(page: Page, refs: Record<RefName, { px: number; py: number; value: string }>) {
  for (const name of ['X1', 'X2', 'Y1', 'Y2'] as const) {
    await expect(page.getByTestId('axes-prompt')).toContainText(`(${name})`);
    await clickImage(page, refs[name].px, refs[name].py);
    const input = page.getByLabel(`${name} value`, { exact: true });
    await expect(input).toBeFocused();
    await input.fill(refs[name].value);
  }
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
}

/** Table rows of one line (dataset) as text cells: #, X, Y[, px, py]. */
export async function tableRows(page: Page, dataset = 'Line 1'): Promise<string[][]> {
  const table = page.getByTestId(`table-${dataset}`);
  if ((await table.count()) === 0) return [];
  return table.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from((tr as HTMLTableRowElement).cells, (td) => td.textContent ?? '')),
  );
}

/** Dispatch a drop of a fixture file onto the workspace, as a file manager drag would. */
export async function dropFile(page: Page, rel: string, name: string, type: string) {
  const base64 = readFileSync(fixturePath(rel)).toString('base64');
  await page.getByTestId('workspace').evaluate(
    (el, { base64, name, type }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { base64, name, type },
  );
}

/** Dispatch a paste carrying a fixture file, as Ctrl+V with an image on the clipboard would. */
export async function pasteFile(page: Page, rel: string, name: string, type: string) {
  const base64 = readFileSync(fixturePath(rel)).toString('base64');
  await page.evaluate(
    ({ base64, name, type }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { base64, name, type },
  );
}

export interface KmTruth {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  knownValues: { series?: string; x: [number, number]; y: number; py?: number }[];
}

/** The real Kaplan–Meier figure (Pao et al. 2020, fig. 1c; provenance in fixtures/real/PROVENANCE.md). */
export const kmTruth = readFixtureJson<KmTruth>('real/km-pericardial-pao.json');

/**
 * Drop the real Kaplan–Meier figure and calibrate it from its labelled ticks (x 0–72 months,
 * y 0–1). Its zero lines sit inside the axes (ggplot expansion), so the refs are placed on the
 * zero lines rather than on the axis lines: X1 and Y1 both at the data origin (the x = 0 column
 * × the y = 0 row — the same pixel, as on a chart whose axes cross at zero, where a click must
 * place Y1 rather than grab X1), X2 on the same row, Y2 in the same column.
 */
export async function loadAndCalibrateKm(page: Page) {
  await dropFile(page, 'real/km-pericardial-pao.png', 'km-pericardial-pao.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded km-pericardial-pao.png');
  const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
  const x0 = tick(kmTruth.xAxis.ticks, 0).px;
  const y0 = tick(kmTruth.yAxis.ticks, 0).py;
  await calibrate(page, {
    X1: { px: x0, py: y0, value: '0' },
    X2: { px: tick(kmTruth.xAxis.ticks, 72).px, py: y0, value: '72' },
    Y1: { px: x0, py: y0, value: '0' },
    Y2: { px: x0, py: tick(kmTruth.yAxis.ticks, 1).py, value: '1' },
  });
}

export async function goToStep(page: Page, step: 'Image' | 'Axes' | 'Data') {
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: new RegExp(step) }).click();
}

/**
 * Entering the Data step (and "+ Add line") opens Auto-trace by default, so a click on the chart
 * would pick a series: close it to place points by hand.
 */
export async function placeByHand(page: Page) {
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);
}

/** The loupe's state from its data attributes (see Workspace.tsx). */
export async function loupeState(page: Page) {
  return page.getByTestId('loupe').evaluate((el) => {
    const d = (el as HTMLElement).dataset;
    return {
      corner: d.corner,
      px: Number(d.px),
      py: Number(d.py),
      cell: Number(d.cell),
      originX: Number(d.originX),
      originY: Number(d.originY),
      snap: d.snapPx === undefined ? null : { px: Number(d.snapPx), py: Number(d.snapPy) },
    };
  });
}

/** The parts of a saved Project the specs look at. */
export interface SavedProject {
  version: number;
  image: { name: string; width: number; height: number; dataUrl: string };
  calibration: { xScale: string; yScale: string } | null;
  draftCalibration?: { xScale: string; yScale: string; refs: Record<string, { px: number; py: number; value: number | string }> };
  datasets: { id: string; name: string; color: string; points: { id: string; px: number; py: number }[] }[];
}

/** The autosaved project in IndexedDB, or null. */
export async function readAutosave(
  page: Page,
): Promise<{ project: SavedProject; activeDatasetId: string; collapsed?: string[]; hidden?: string[] } | null> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('graph-digitizer', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('autosave')) return resolve(null);
          const get = db.transaction('autosave').objectStore('autosave').get('current');
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => reject(get.error);
        };
      }),
  );
}
