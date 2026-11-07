/**
 * Auto-detect axes (Phase 5) on the two real figures: the suggestion is shown, never applied until
 * accepted, reproduces the figures' known values, and everything (Tesseract's worker, WASM core,
 * language data) comes from the app's own origin — nothing is fetched from anywhere else.
 */

import { expect, test, type Page } from '@playwright/test';
import { clickImage, dropFile, openApp, placeByHand, readFixtureJson, tableRows } from './helpers.ts';

interface RealTruth {
  knownValues: { x: [number, number]; y: number; py?: number }[];
}

/** Abort anything not served by the app itself, and record what was asked for. */
async function offline(page: Page): Promise<string[]> {
  const foreign: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    foreign.push(url.href);
    return route.abort();
  });
  return foreign;
}

async function autoDetect(page: Page) {
  await page.getByRole('button', { name: 'Auto-detect axes' }).click();
  // First use loads Tesseract and its language data; allow for a slow CI machine.
  await expect(page.getByTestId('auto-suggestion')).toBeVisible({ timeout: 60_000 });
}

test('auto-detect on the pericardial-effusion figure: review, accept, plateau reads 16.2%', async ({ page }) => {
  const foreign = await offline(page);
  await openApp(page);
  // Tesseract is not part of the first-paint bundle.
  const before = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(before.filter((n) => /tesseract/i.test(n))).toEqual([]);

  await dropFile(page, 'real/km-pericardial-effusion.jpg', 'km-pericardial-effusion.jpg', 'image/jpeg');
  await autoDetect(page);

  await expect(page.getByTestId('auto-badge-x')).toContainText('High');
  await expect(page.getByTestId('auto-badge-y')).toContainText('High');
  await expect(page.getByLabel('Suggested X1 value')).toHaveValue('0');
  await expect(page.getByLabel('Suggested X2 value')).toHaveValue('120');
  await expect(page.getByLabel('Suggested Y1 value')).toHaveValue('1');
  await expect(page.getByLabel('Suggested Y2 value')).toHaveValue('0');

  // Nothing is applied before accepting.
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('calibration-ok')).toHaveCount(0);

  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await expect(page.getByLabel('X2 value', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('X scale')).toHaveValue('linear');
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);

  const plateau = readFixtureJson<RealTruth>('real/km-pericardial-effusion.json').knownValues[0]!;
  await clickImage(page, 400, plateau.py!);
  const [[, x, y]] = (await tableRows(page)) as [string[]];
  expect(Number(x)).toBeGreaterThanOrEqual(plateau.x[0]);
  expect(Number(x)).toBeLessThanOrEqual(plateau.x[1]);
  // A click lands within ~0.5 CSS px; at the fitted zoom that is < 0.005 in y.
  expect(Math.abs(Number(y) - plateau.y)).toBeLessThanOrEqual(0.005);

  // One undo step takes the whole suggestion back.
  await page.getByRole('button', { name: 'Axes' }).click();
  await page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();

  expect(foreign).toEqual([]);
});

test('auto-detect on the CNS-lymphoma figure (frame not at zero, table in the plot): two lines', async ({ page }) => {
  const foreign = await offline(page);
  await openApp(page);
  await dropFile(page, 'real/km-cns-lymphoma.png', 'km-cns-lymphoma.png', 'image/png');
  await autoDetect(page);

  await expect(page.getByTestId('auto-badge-x')).toContainText('High');
  await expect(page.getByTestId('auto-badge-y')).toContainText('High');
  // x = 0 and y = 0 are inside the frame, not at the frame lines.
  await expect(page.getByLabel('Suggested X1 value')).toHaveValue('0');
  await expect(page.getByLabel('Suggested Y2 value')).toHaveValue('0');
  await expect(page.getByTestId('auto-x')).toContainText('at (127.6, 455.0) px');
  await expect(page.getByTestId('auto-y')).toContainText('at (90.5, 400.6) px');

  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);

  const known = readFixtureJson<RealTruth>('real/km-cns-lymphoma.json').knownValues;
  const blue = known[0]!;
  const red = known[3]!;
  await clickImage(page, 403, blue.py!);
  await page.getByRole('button', { name: '+ Add line' }).click();
  await placeByHand(page);
  await clickImage(page, 403, red.py!);
  const [[, , y1]] = (await tableRows(page, 'Line 1')) as [string[]];
  const [[, , y2]] = (await tableRows(page, 'Line 2')) as [string[]];
  expect(Math.abs(Number(y1) - blue.y)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(Number(y2) - red.y)).toBeLessThanOrEqual(0.01);

  expect(foreign).toEqual([]);
});

test('discarding a suggestion leaves the manual calibration untouched', async ({ page }) => {
  await openApp(page);
  await dropFile(page, 'real/km-pericardial-effusion.jpg', 'km-pericardial-effusion.jpg', 'image/jpeg');
  await autoDetect(page);
  await page.getByLabel('Suggested X2 value').fill('100');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('auto-suggestion')).toHaveCount(0);
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('axes-prompt')).toContainText('(X1)');
});
