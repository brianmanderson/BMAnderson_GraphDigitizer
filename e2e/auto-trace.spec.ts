/**
 * Auto-trace in the Data step on the synthetic linear chart (a blue polyline through pink
 * markers): one click proposes ghost points, nothing is applied before Accept, Accept adds them
 * as one undo step and they then behave like ordinary points. Counts are read from the panel, not
 * hard-coded, so the spec holds for the stub and the real tracer alike.
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, goToStep, loadViaPicker, openApp, readFixtureJson, tableRows, type SyntheticTruth } from './helpers.ts';

const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

/** A pixel on the blue line, between the first two markers (well clear of both). */
const [p1, p2] = truth.points as [SyntheticTruth['points'][number], SyntheticTruth['points'][number]];
const ON_LINE = { px: (p1.px + p2.px) / 2, py: (p1.py + p2.py) / 2 };

async function loadCalibrated(page: Page) {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const row = truth.xAxis.axisLineRow;
  const col = truth.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: tick(truth.xAxis.ticks, 10).px, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: tick(truth.yAxis.ticks, 100).py, value: '100' },
  });
  await page.getByRole('button', { name: 'Continue to Data' }).click();
}

/** Click "Auto-trace line" (or "Trace into a new line"), pick the series, wait for the result. */
async function traceAt(page: Page, at: { px: number; py: number }, button = 'Auto-trace line'): Promise<number> {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByTestId('trace-prompt')).toHaveText('Click on the curve or markers to trace');
  await clickImage(page, at.px, at.py);
  await expect(page.getByTestId('trace-prompt')).toHaveCount(0);
  await expect(page.getByTestId('trace-count')).toBeVisible();
  return Number(await page.getByTestId('trace-count').textContent());
}

const undoButton = (page: Page) => page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' });

test('auto-trace needs a calibration', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await goToStep(page, 'Data');
  await expect(page.getByRole('button', { name: 'Auto-trace line' })).toBeDisabled();
});

test('auto-trace: ghost points → discard changes nothing → accept is one undo step', async ({ page }) => {
  await loadCalibrated(page);
  // One manual point first, so the trace is appended to existing data.
  await clickImage(page, 300, 300);
  await expect.poll(async () => (await tableRows(page)).length).toBe(1);
  const before = await tableRows(page);

  // Trace, then discard: the document is untouched (no new rows, nothing to undo beyond the point).
  const count = await traceAt(page, ON_LINE);
  expect(count).toBeGreaterThanOrEqual(2);
  expect(count).toBeLessThanOrEqual(25);
  await expect(page.getByTestId('trace-kind')).not.toHaveText('Nothing found');
  expect(await tableRows(page)).toEqual(before);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);
  expect(await tableRows(page)).toEqual(before);

  // While a trace is open, a click picks the series instead of adding a point.
  const n = await traceAt(page, ON_LINE);
  expect(await tableRows(page)).toEqual(before);

  // The point count re-runs the trace and caps the result.
  await page.getByLabel('Number of points', { exact: true }).fill('8');
  await expect(page.getByTestId('trace-running')).toBeVisible();
  await expect(page.getByTestId('trace-count')).toBeVisible();
  const capped = Number(await page.getByTestId('trace-count').textContent());
  expect(capped).toBeGreaterThanOrEqual(2);
  expect(capped).toBeLessThanOrEqual(8);
  expect(capped).toBeLessThanOrEqual(n);
  // So does the mode (the count may change with it).
  await page.getByLabel('Trace mode').selectOption('curve');
  await expect(page.getByTestId('trace-count')).toBeVisible();
  const traced = Number(await page.getByTestId('trace-count').textContent());
  expect(traced).toBeLessThanOrEqual(8);

  // Accept: N points are appended to the active line as ordinary points, in one undo step.
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);
  await expect(page.getByTestId('notice')).toContainText(`Added ${traced} traced points to "Line 1"`);
  const after = await tableRows(page);
  expect(after).toHaveLength(1 + traced);
  expect(after[0]).toEqual(before[0]);
  // The traced points lie on the blue line between x = 1 and x = 9 (values, not pixels).
  for (const [, x, y] of after.slice(1)) {
    expect(Number(x)).toBeGreaterThan(0.5);
    expect(Number(x)).toBeLessThan(9.5);
    expect(Number(y)).toBeGreaterThan(0);
    expect(Number(y)).toBeLessThan(100);
  }

  // They are ordinary points: select one in the table and delete it, then undo that.
  await page.getByTestId('table-Line 1').locator('tbody tr').nth(1).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await tableRows(page)).length).toBe(traced);
  await undoButton(page).click();
  await expect.poll(async () => (await tableRows(page)).length).toBe(1 + traced);

  // One Undo removes every traced point; the manual one stays.
  await undoButton(page).click();
  await expect.poll(async () => tableRows(page)).toEqual(before);
});

test('trace into a new line: offered once the active line has points, takes the series colour', async ({ page }) => {
  await loadCalibrated(page);
  await expect(page.getByRole('button', { name: 'Trace into a new line' })).toHaveCount(0);
  await clickImage(page, 300, 300);
  const count = await traceAt(page, ON_LINE, 'Trace into a new line');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByTestId('notice')).toContainText('a new line, "Line 2"');
  expect(await tableRows(page, 'Line 1')).toHaveLength(1);
  expect(await tableRows(page, 'Line 2')).toHaveLength(count);
  await expect(page.getByLabel('Make Line 2 active')).toBeChecked();
  // The traced series is the blue line (#1c5fa8, antialiased): the new line is blue.
  const color = await page.getByLabel('Colour of Line 2').inputValue();
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
  expect(b).toBeGreaterThan(r + 60);
  expect(b).toBeGreaterThan(g);

  await undoButton(page).click();
  await expect(page.getByTestId('table-Line 2')).toHaveCount(0);
  expect(await tableRows(page, 'Line 1')).toHaveLength(1);
});

test('Escape cancels picking without adding a point', async ({ page }) => {
  await loadCalibrated(page);
  await page.getByRole('button', { name: 'Auto-trace line' }).click();
  await expect(page.getByTestId('trace-prompt')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);
  await clickImage(page, 300, 300);
  await expect.poll(async () => (await tableRows(page)).length).toBe(1);
});
