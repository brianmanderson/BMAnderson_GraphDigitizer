/**
 * Cropping the image to one panel (Image step, "Crop…"): the crop replaces the image as one undo
 * step and existing refs and points move with it (docs/SPEC.md → Crop).
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  calibrate,
  clickImage,
  goToStep,
  imageToClient,
  loadViaPicker,
  openApp,
  readFixtureJson,
  tableRows,
  type SavedProject,
  type SyntheticTruth,
} from './helpers.ts';

const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
const row = truth.xAxis.axisLineRow;
const col = truth.yAxis.axisLineCol;
const x10 = tick(truth.xAxis.ticks, 10).px;
const y100 = tick(truth.yAxis.ticks, 100).py;

// As in synthetic-linear.spec.ts: clicks land within ~0.5 CSS px, and a crop is fitted at least
// as large as the full image, so 0.3 % of each axis range covers it.
const X_TOL = 0.03;
const Y_TOL = 0.3;

const cropButton = (page: Page) => page.getByRole('button', { name: 'Crop…' });
const current = (page: Page) => page.getByTestId('image-current');
const field = (page: Page, name: 'left' | 'top' | 'width' | 'height') => page.getByTestId(`crop-${name}`);
const fieldValues = async (page: Page) => ({
  left: Number(await field(page, 'left').inputValue()),
  top: Number(await field(page, 'top').inputValue()),
  width: Number(await field(page, 'width').inputValue()),
  height: Number(await field(page, 'height').inputValue()),
});
const historyButton = (page: Page, name: 'Undo' | 'Redo') => page.getByRole('group', { name: 'History' }).getByRole('button', { name });

async function startCrop(page: Page) {
  await goToStep(page, 'Image');
  await cropButton(page).click();
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('crop-panel')).toBeVisible();
  await expect(page.getByTestId('crop-apply')).toBeDisabled();
  await expect(page.getByTestId('crop-size')).toContainText('No rectangle yet');
}

/** Type the rectangle into the panel and apply it; returns once the Current line shows the new size. */
async function cropTo(page: Page, r: { left: number; top: number; width: number; height: number }, apply: 'button' | 'enter' = 'button') {
  await startCrop(page);
  await field(page, 'left').fill(String(r.left));
  await field(page, 'top').fill(String(r.top));
  await field(page, 'width').fill(String(r.width));
  await field(page, 'height').fill(String(r.height));
  await expect(page.getByTestId('crop-size')).toContainText(`Result: ${r.width} × ${r.height} px`);
  await expect(page.getByTestId('crop-apply')).toBeEnabled();
  if (apply === 'button') await page.getByTestId('crop-apply').click();
  else await field(page, 'height').press('Enter');
  await expect(page.getByTestId('notice')).toContainText(`Cropped to ${r.width} × ${r.height} px.`);
  await expect(current(page)).toContainText(`${r.width} × ${r.height} px`);
  await expect(page.getByTestId('crop-panel')).toHaveCount(0);
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'false');
}

test('crop through the panel, then calibrate and digitize on the crop; the cropped project reopens', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const crop = { left: 40, top: 20, width: 580, height: 430 };
  await cropTo(page, crop);
  // Nothing was placed yet, so nothing was removed; the crop is still undoable from the notice.
  await expect(page.getByTestId('notice')).not.toContainText('removed');
  await expect(page.getByTestId('notice').getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Image/ })).toHaveAttribute('aria-current', 'step');

  // The truth refs and points, shifted by the crop origin, calibrate and digitize the crop.
  await goToStep(page, 'Axes');
  await calibrate(page, {
    X1: { px: col - crop.left, py: row - crop.top, value: '0' },
    X2: { px: x10 - crop.left, py: row - crop.top, value: '10' },
    Y1: { px: col - crop.left, py: row - crop.top, value: '0' },
    Y2: { px: col - crop.left, py: y100 - crop.top, value: '100' },
  });
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  for (const p of truth.points) await clickImage(page, p.px - crop.left, p.py - crop.top);
  await page.getByLabel('Pixel columns').check();
  const rows = await tableRows(page);
  expect(rows).toHaveLength(truth.points.length);
  truth.points.forEach((p, i) => {
    const [, x, y, px, py] = rows[i]!;
    expect(Math.abs(Number(x) - (p.x as number)), `point ${i + 1} x`).toBeLessThanOrEqual(X_TOL);
    expect(Math.abs(Number(y) - p.y), `point ${i + 1} y`).toBeLessThanOrEqual(Y_TOL);
    // Stored pixels are in the cropped image's frame.
    expect(Math.abs(Number(px) - (p.px - crop.left)), `point ${i + 1} px`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Number(py) - (p.py - crop.top)), `point ${i + 1} py`).toBeLessThanOrEqual(0.5);
  });

  // The saved project holds the cropped image (PNG, same name) and reopens as it was.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project' }).click()]);
  expect(download.suggestedFilename()).toBe('synthetic-linear-project.json');
  const file = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedProject;
  expect(saved.image).toMatchObject({ name: 'synthetic-linear.png', width: crop.width, height: crop.height });
  expect(saved.image.dataUrl).toMatch(/^data:image\/png;base64,/);
  await loadViaPicker(page, 'synthetic/synthetic-date-log.png');
  await page.getByTestId('project-input').setInputFiles(file);
  await expect(page.getByTestId('notice')).toContainText('Opened synthetic-linear-project.json');
  await page.getByLabel('Pixel columns').check();
  expect(await tableRows(page)).toEqual(rows);
  await goToStep(page, 'Image');
  await expect(current(page)).toContainText(`${crop.width} × ${crop.height} px`);
});

test('existing refs and points move with the crop; those outside are dropped and the notice names them', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: x10, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: y100, value: '100' },
  });
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  for (const p of truth.points) await clickImage(page, p.px, p.py);
  // A stray point near the right edge, outside the crop below.
  await clickImage(page, 610, 200);
  await expect.poll(async () => (await tableRows(page)).length).toBe(truth.points.length + 1);
  await page.getByLabel('Pixel columns').check();

  // Keeps columns 20…559 and rows 10…469: X2 (at 600) and the stray point fall outside.
  const crop = { left: 20, top: 10, width: 540, height: 460 };
  await cropTo(page, crop);
  await expect(page.getByTestId('notice')).toContainText('1 point and 1 ref outside the crop were removed.');
  const rows = await tableRows(page);
  expect(rows).toHaveLength(truth.points.length);
  truth.points.forEach((p, i) => {
    const [, x, y, px, py] = rows[i]!;
    // Three refs are not a calibration: values are blank until X2 is placed again.
    expect([x, y]).toEqual(['—', '—']);
    expect(Math.abs(Number(px) - (p.px - crop.left)), `point ${i + 1} px`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Number(py) - (p.py - crop.top)), `point ${i + 1} py`).toBeLessThanOrEqual(0.5);
  });

  // The kept refs moved with the image: placing X2 again (on the x = 8 tick, which the crop kept)
  // completes the calibration exactly.
  await goToStep(page, 'Axes');
  await expect(page.getByTestId('axes-prompt')).toContainText('(X2)');
  await expect(page.getByLabel('X1 value', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Y2 value', { exact: true })).toHaveValue('100');
  await clickImage(page, tick(truth.xAxis.ticks, 8).px - crop.left, row - crop.top);
  const x2 = page.getByLabel('X2 value', { exact: true });
  await expect(x2).toBeFocused();
  await x2.fill('8');
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await goToStep(page, 'Data');
  const calibrated = await tableRows(page);
  truth.points.forEach((p, i) => {
    const [, x, y] = calibrated[i]!;
    expect(Math.abs(Number(x) - (p.x as number)), `point ${i + 1} x`).toBeLessThanOrEqual(X_TOL);
    expect(Math.abs(Number(y) - p.y), `point ${i + 1} y`).toBeLessThanOrEqual(Y_TOL);
  });
});

test('undo brings the full image back; redo crops it again', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await cropTo(page, { left: 100, top: 50, width: 400, height: 300 }, 'enter');
  const notice = page.getByTestId('notice');
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(current(page)).toContainText('640 × 480 px');
  await expect(notice.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await historyButton(page, 'Redo').click();
  await expect(current(page)).toContainText('400 × 300 px');
  await page.keyboard.press('Control+z');
  await expect(current(page)).toContainText('640 × 480 px');
  await expect(historyButton(page, 'Redo')).toBeEnabled();
});

test('a drag draws the rectangle (a new drag replaces it, a click and a pan do not); Esc cancels', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await startCrop(page);
  const canvas = page.getByTestId('canvas');
  await expect(canvas).toHaveCSS('cursor', 'crosshair');

  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await imageToClient(page, from[0], from[1]);
    const b = await imageToClient(page, to[0], to[1]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  // Every pixel the drag touched: columns 100…300 and rows 50…250 (within a pixel of click error).
  await drag([100, 50], [300, 250]);
  let v = await fieldValues(page);
  expect(Math.abs(v.left - 100)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.top - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.width - 201)).toBeLessThanOrEqual(2);
  expect(Math.abs(v.height - 201)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('crop-size')).toContainText(`Result: ${v.width} × ${v.height} px`);
  await expect(page.getByTestId('crop-apply')).toBeEnabled();

  // A new drag replaces the rectangle; a click draws nothing; Space+drag pans instead.
  await drag([200, 100], [250, 150]);
  v = await fieldValues(page);
  expect(Math.abs(v.left - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(v.width - 51)).toBeLessThanOrEqual(2);
  await clickImage(page, 50, 50);
  expect(await fieldValues(page)).toEqual(v);
  const offsetBefore = await canvas.getAttribute('data-offset-x');
  await page.keyboard.down('Space');
  await drag([400, 300], [450, 300]);
  await page.keyboard.up('Space');
  expect(await canvas.getAttribute('data-offset-x')).not.toBe(offsetBefore);
  expect(await fieldValues(page)).toEqual(v);

  // Esc leaves crop mode with the image untouched — from the canvas and from a field.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('crop-panel')).toHaveCount(0);
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(current(page)).toContainText('640 × 480 px');
  await startCrop(page);
  await field(page, 'left').fill('30');
  await expect(page.getByTestId('crop-size')).toContainText('Result: 610 × 480 px');
  await field(page, 'left').press('Escape');
  await expect(page.getByTestId('crop-panel')).toHaveCount(0);
  await expect(current(page)).toContainText('640 × 480 px');
  // Leaving the step cancels it too.
  await startCrop(page);
  await goToStep(page, 'Axes');
  await goToStep(page, 'Image');
  await expect(cropButton(page)).toHaveAttribute('aria-pressed', 'false');
});
