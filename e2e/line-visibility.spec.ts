/**
 * The eye beside each line in the Data step: a hidden line's points are not drawn and cannot be
 * picked (click, box-select, Delete), but stay in the table, the exports and the autosave. A line
 * is shown again when it becomes active or gets a point, so nothing is placed out of sight.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixturePath, imageToClient, openApp, placeByHand, readAutosave, tableRows } from './helpers.ts';

type Pt = { id: string; px: number; py: number };

const COLORS = ['#d6336c', '#1971c2'];
const LINE_1_RGB = [0xd6, 0x33, 0x6c];

/** The real KM figure (967 × 725) calibrated from its labelled ticks, with the given lines. */
function project(lines: Pt[][]) {
  const dataUrl = `data:image/png;base64,${readFileSync(fixturePath('real/km-sas-frame-ikawa.png')).toString('base64')}`;
  return {
    version: 2,
    image: { dataUrl, width: 967, height: 725, name: 'km-sas-frame-ikawa.png' },
    calibration: {
      xScale: 'linear',
      yScale: 'linear',
      refs: {
        X1: { px: 215.08, py: 575.99, value: 0 },
        X2: { px: 922.73, py: 575.99, value: 84 },
        Y1: { px: 187.15, py: 564.52, value: 0 },
        Y2: { px: 187.15, py: 61.38, value: 1 },
      },
    },
    datasets: lines.map((points, l) => ({ id: `line-${l}`, name: `Line ${l + 1}`, color: COLORS[l]!, points })),
    settings: { significantFigures: 4, dateFormat: 'YYYY-MM-DD' },
  };
}

async function openProject(page: Page, lines: Pt[][]) {
  await openApp(page);
  const buffer = Buffer.from(JSON.stringify(project(lines)));
  await page.getByTestId('project-input').setInputFiles({ name: 'eye.json', mimeType: 'application/json', buffer });
  await expect(page.getByTestId('notice')).toContainText('Opened eye.json');
  await placeByHand(page);
  await page.getByLabel('Pixel columns').check();
}

/** The canvas colour (r, g, b) at an image pixel. */
async function colourAt(page: Page, px: number, py: number): Promise<number[]> {
  const at = await imageToClient(page, px, py);
  return page.getByTestId('canvas').evaluate((el, at) => {
    const canvas = el as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    const d = canvas.getContext('2d')!.getImageData(Math.round((at.x - r.left) * k), Math.round((at.y - r.top) * k), 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  }, at);
}

const eye = (page: Page, action: 'Hide' | 'Show', line: string) => page.getByRole('button', { name: `${action} ${line}`, exact: true });
const selectedRows = (page: Page) => page.locator('tr[aria-selected="true"]');

test('a hidden line is not drawn and cannot be picked, but stays in the table and the CSV', async ({ page }) => {
  await openProject(page, [
    [
      { id: 'a', px: 300, py: 200 },
      { id: 'b', px: 400, py: 300 },
    ],
    [{ id: 'c', px: 500, py: 250 }],
  ]);
  await page.getByLabel('Make Line 2 active').check();
  await expect.poll(() => colourAt(page, 300, 200)).toEqual(LINE_1_RGB);

  await eye(page, 'Hide', 'Line 1').click();
  await expect(eye(page, 'Show', 'Line 1')).toBeVisible();
  await expect(eye(page, 'Hide', 'Line 2')).toBeVisible();
  await expect.poll(() => colourAt(page, 300, 200)).not.toEqual(LINE_1_RGB);

  // Move points: a click right on a hidden point selects nothing.
  await page.getByRole('button', { name: 'Move points' }).click();
  const a = await imageToClient(page, 300, 200);
  await page.mouse.click(a.x, a.y);
  await expect(selectedRows(page)).toHaveCount(0);

  // A box around every point takes only the visible line's; Delete removes only that.
  const from = await imageToClient(page, 250, 150);
  const to = await imageToClient(page, 550, 350);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect(selectedRows(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete 1 point' }).click();
  expect(await tableRows(page, 'Line 2')).toHaveLength(0);
  expect(await tableRows(page, 'Line 1')).toHaveLength(2);

  // Hiding is display only: the CSV holds every point of the hidden line.
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = readFileSync((await csvDl.path())!, 'utf8').trim().split('\r\n');
  expect(csv.slice(1).map((r) => r.split(',')[0])).toEqual(['Line 1', 'Line 1']);

  await eye(page, 'Show', 'Line 1').click();
  await expect.poll(() => colourAt(page, 300, 200)).toEqual(LINE_1_RGB);
});

test('hiding a line deselects its points', async ({ page }) => {
  await openProject(page, [[{ id: 'a', px: 300, py: 200 }], [{ id: 'c', px: 500, py: 250 }]]);
  await page.getByRole('button', { name: 'Select all points of Line 1' }).click();
  await expect(selectedRows(page)).toHaveCount(1);
  await page.getByLabel('Make Line 2 active').check();
  await eye(page, 'Hide', 'Line 1').click();
  await expect(selectedRows(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete selected points' })).toBeDisabled();
  // Shown again, the points stay unselected.
  await eye(page, 'Show', 'Line 1').click();
  await expect(selectedRows(page)).toHaveCount(0);
});

test('a hidden line is shown again when it becomes active, gets a point or is picked in the table', async ({ page }) => {
  await openProject(page, [[{ id: 'a', px: 300, py: 200 }], [{ id: 'c', px: 500, py: 250 }]]);
  await page.getByLabel('Make Line 1 active').check();

  await eye(page, 'Hide', 'Line 2').click();
  await page.getByLabel('Make Line 2 active').check();
  await expect(eye(page, 'Hide', 'Line 2')).toBeVisible();

  // The active line may be hidden; a click that places a point on it shows it.
  await eye(page, 'Hide', 'Line 2').click();
  await expect(eye(page, 'Show', 'Line 2')).toBeVisible();
  const at = await imageToClient(page, 600, 300);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await tableRows(page, 'Line 2')).length).toBe(2);
  await expect(eye(page, 'Hide', 'Line 2')).toBeVisible();

  // A row of a hidden line picked in the table: that line becomes active and is shown.
  await eye(page, 'Hide', 'Line 1').click();
  await page.getByTestId('table-Line 1').locator('tr[data-point-id="a"] td').first().click();
  await expect(page.getByLabel('Make Line 1 active')).toBeChecked();
  await expect(eye(page, 'Hide', 'Line 1')).toBeVisible();
  await expect(selectedRows(page)).toHaveCount(1);
});

test('hidden lines survive a reload (autosave), not a saved project file', async ({ page }) => {
  await openProject(page, [[{ id: 'a', px: 300, py: 200 }], [{ id: 'c', px: 500, py: 250 }]]);
  await page.getByLabel('Make Line 1 active').check();
  await eye(page, 'Hide', 'Line 2').click();
  await expect.poll(async () => (await readAutosave(page))?.hidden).toEqual(['line-1']);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project' }).click()]);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8')) as { datasets: Record<string, unknown>[] };
  expect(saved.datasets.map((d) => Object.keys(d).sort())).toEqual([
    ['color', 'id', 'name', 'points'],
    ['color', 'id', 'name', 'points'],
  ]);

  await page.reload();
  await expect(page.getByTestId('notice')).toContainText('Restored km-sas-frame-ikawa.png');
  await expect(eye(page, 'Show', 'Line 2')).toBeVisible();
  await expect(eye(page, 'Hide', 'Line 1')).toBeVisible();
});
