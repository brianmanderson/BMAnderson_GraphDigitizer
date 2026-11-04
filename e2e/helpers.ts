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
    const input = page.getByLabel(`${name} value`);
    await expect(input).toBeFocused();
    await input.fill(refs[name].value);
  }
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
}

/** Table rows of one dataset as text cells: #, X, Y[, px, py]. */
export async function tableRows(page: Page, dataset = 'Dataset 1'): Promise<string[][]> {
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
