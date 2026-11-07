/**
 * Auto-detect axes (Phase 5) on two real figures (provenance: fixtures/real/PROVENANCE.md): the
 * suggestion is shown, never applied until accepted, reproduces the figures' known values, and
 * everything (Tesseract's worker, WASM core, language data) comes from the app's own origin —
 * nothing is fetched from anywhere else.
 */

import { expect, test, type Page } from '@playwright/test';
import { clickImage, dropFile, openApp, placeByHand, readFixtureJson, tableRows } from './helpers.ts';

interface RealTruth {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  knownValues: { series?: string; x: [number, number]; y: number; py?: number }[];
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

/** The "at (x, y) px" positions the panel prints for an axis's suggested refs (1 then 2). */
async function refPositions(page: Page, axis: 'x' | 'y'): Promise<[number, number][]> {
  const text = (await page.getByTestId(`auto-${axis}`).textContent()) ?? '';
  const found = [...text.matchAll(/at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\) px/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  if (found.length !== 2) throw new Error(`expected two ref positions in ${JSON.stringify(text)}`);
  return found;
}

test('auto-detect on the Pao figure (zero lines inside the axes): review, accept, plateau reads its value', async ({ page }) => {
  const foreign = await offline(page);
  await openApp(page);
  // Tesseract is not part of the first-paint bundle.
  const before = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(before.filter((n) => /tesseract/i.test(n))).toEqual([]);

  await dropFile(page, 'real/km-pericardial-pao.png', 'km-pericardial-pao.png', 'image/png');
  await autoDetect(page);

  await expect(page.getByTestId('auto-badge-x')).toContainText('High');
  await expect(page.getByTestId('auto-badge-y')).toContainText('High');
  await expect(page.getByLabel('Suggested X1 value')).toHaveValue('0');
  await expect(page.getByLabel('Suggested X2 value')).toHaveValue('72');
  await expect(page.getByLabel('Suggested Y1 value')).toHaveValue('1');
  await expect(page.getByLabel('Suggested Y2 value')).toHaveValue('0');

  // Nothing is applied before accepting.
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('calibration-ok')).toHaveCount(0);

  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await expect(page.getByLabel('X2 value', { exact: true })).toHaveValue('72');
  await expect(page.getByLabel('X scale')).toHaveValue('linear');
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);

  // The black series' final plateau (row 186, columns 526–648).
  const plateau = readFixtureJson<RealTruth>('real/km-pericardial-pao.json').knownValues[0]!;
  await clickImage(page, 590, plateau.py!);
  const [[, x, y]] = (await tableRows(page)) as [string[]];
  expect(Number(x)).toBeGreaterThanOrEqual(plateau.x[0]);
  expect(Number(x)).toBeLessThanOrEqual(plateau.x[1]);
  // A click lands within ~0.5 CSS px; at the fitted zoom and 410 px per unit that is < 0.005 in y.
  expect(Math.abs(Number(y) - plateau.y)).toBeLessThanOrEqual(0.005);

  // One undo step takes the whole suggestion back.
  await page.getByRole('button', { name: 'Axes' }).click();
  await page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();

  expect(foreign).toEqual([]);
});

test('auto-detect on the Ikawa figure (SAS frame not at zero, risk table under the axis): two lines', async ({ page }) => {
  const foreign = await offline(page);
  await openApp(page);
  await dropFile(page, 'real/km-sas-frame-ikawa.png', 'km-sas-frame-ikawa.png', 'image/png');
  await autoDetect(page);
  const truth = readFixtureJson<RealTruth>('real/km-sas-frame-ikawa.json');
  const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

  await expect(page.getByTestId('auto-badge-x')).toContainText('High');
  await expect(page.getByTestId('auto-badge-y')).toContainText('High');
  // x = 0 and y = 0 are inside the frame, not at the frame lines: the refs sit on the frame lines
  // at the labelled 0 ticks (X1 on the bottom line at the x = 0 tick; Y2 on the left line at the
  // y = 0 tick, 11.5 px above the bottom line), within 1 px of the label.
  await expect(page.getByLabel('Suggested X1 value')).toHaveValue('0');
  await expect(page.getByLabel('Suggested Y2 value')).toHaveValue('0');
  const [[x1px, x1py]] = await refPositions(page, 'x');
  expect(Math.abs(x1px - tick(truth.xAxis.ticks, 0).px)).toBeLessThanOrEqual(1);
  expect(Math.abs(x1py - truth.xAxis.axisLineRow)).toBeLessThanOrEqual(1);
  const [, [y2px, y2py]] = await refPositions(page, 'y');
  expect(Math.abs(y2px - truth.yAxis.axisLineCol)).toBeLessThanOrEqual(1);
  expect(Math.abs(y2py - tick(truth.yAxis.ticks, 0).py)).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);

  // The blue solid and red solid final plateaus (both span column 700).
  const blue = truth.knownValues.find((k) => k.series === 'High dose (unweighted)')!;
  const red = truth.knownValues.find((k) => k.series === 'Standard dose (unweighted)')!;
  await clickImage(page, 700, blue.py!);
  await page.getByRole('button', { name: '+ Add line' }).click();
  await placeByHand(page);
  await clickImage(page, 700, red.py!);
  const [[, , y1]] = (await tableRows(page, 'Line 1')) as [string[]];
  const [[, , y2]] = (await tableRows(page, 'Line 2')) as [string[]];
  expect(Math.abs(Number(y1) - blue.y)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(Number(y2) - red.y)).toBeLessThanOrEqual(0.01);

  expect(foreign).toEqual([]);
});

test('discarding a suggestion leaves the manual calibration untouched', async ({ page }) => {
  await openApp(page);
  await dropFile(page, 'real/km-pericardial-pao.png', 'km-pericardial-pao.png', 'image/png');
  await autoDetect(page);
  await page.getByLabel('Suggested X2 value').fill('100');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('auto-suggestion')).toHaveCount(0);
  await expect(page.getByLabel('X1 value', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('axes-prompt')).toContainText('(X1)');
});
