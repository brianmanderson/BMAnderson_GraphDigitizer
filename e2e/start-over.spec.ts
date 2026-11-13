/**
 * "Start over" (docs/SPEC.md → Start over): the toolbar button asks first, saying what will be
 * lost; Cancel and Esc change nothing, "Save project first…" downloads the project and keeps the
 * dialog open; confirming returns to the fresh-load state — no image, no table, no undo — and
 * clears the autosave, so a reload stays empty.
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, loadViaPicker, openApp, placeByHand, readAutosave, readFixtureJson, tableRows, type SyntheticTruth } from './helpers.ts';

const linear = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

const startOverButton = (page: Page) => page.getByRole('group', { name: 'File' }).getByRole('button', { name: 'Start over' });
const dialog = (page: Page) => page.getByTestId('start-over-dialog');

/** Load the linear chart, calibrate it and place one point by hand; wait until the autosave holds it. */
async function digitizeOnePoint(page: Page) {
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const row = linear.xAxis.axisLineRow;
  const col = linear.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: tick(linear.xAxis.ticks, 10).px, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: tick(linear.yAxis.ticks, 100).py, value: '100' },
  });
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);
  await clickImage(page, linear.points[0]!.px, linear.points[0]!.py);
  expect(await tableRows(page)).toHaveLength(1);
  await expect.poll(async () => (await readAutosave(page))?.project.datasets[0]?.points.length, { timeout: 10_000 }).toBe(1);
}

test('Start over is disabled on the empty start screen', async ({ page }) => {
  await openApp(page);
  await expect(startOverButton(page)).toBeDisabled();
  await expect(startOverButton(page)).toHaveAttribute('title', 'Clear the image, axes and all lines');
});

test('Cancel, Esc and "Save project first…" leave the work intact', async ({ page }) => {
  await openApp(page);
  await digitizeOnePoint(page);

  await expect(startOverButton(page)).toBeEnabled();
  await startOverButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Start over?' })).toBeVisible();
  const summary = page.getByTestId('start-over-summary');
  await expect(summary).toContainText('synthetic-linear.png (640 × 480 px)');
  await expect(summary).toContainText('the axis calibration');
  await expect(summary).toContainText('1 line with 1 point');
  // The safe choice has the focus, so a stray Enter does not clear the work.
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();

  // Save project first: the usual project file, and the dialog stays open.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog(page).getByRole('button', { name: 'Save project first…' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('synthetic-linear-project.json');
  await expect(dialog(page)).toBeVisible();

  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await tableRows(page)).toHaveLength(1);
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Data/ })).toHaveAttribute('aria-current', 'step');

  // Esc closes the dialog only: the point stays, and so does the Data step's state.
  await startOverButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(await tableRows(page)).toHaveLength(1);
  await expect(page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' })).toBeEnabled();
  expect((await readAutosave(page))?.project.datasets[0]?.points).toHaveLength(1);
});

test('confirming clears the image, the table, the history and the autosave; a reload stays empty', async ({ page }) => {
  await openApp(page);
  await digitizeOnePoint(page);

  await startOverButton(page).click();
  await dialog(page).getByRole('button', { name: 'Start over' }).click();
  await expect(dialog(page)).toHaveCount(0);

  // The fresh-load state.
  await expect(page.getByText('Drop a chart image here')).toBeVisible();
  await expect(page.getByTestId('table-Line 1')).toHaveCount(0);
  await expect(page.getByTestId('image-current')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Image/ })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Axes/ })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Redo' })).toBeDisabled();
  await expect(startOverButton(page)).toBeDisabled();
  await expect(page.getByTestId('notice')).toHaveCount(0);
  await expect(page.getByTestId('statusbar')).toContainText('No image loaded.');
  await page.keyboard.press('Control+z'); // nothing to undo: Start over is not undoable
  await expect(page.getByText('Drop a chart image here')).toBeVisible();
  await expect.poll(() => readAutosave(page)).toBeNull();

  await page.reload();
  await expect(page.getByText('Drop a chart image here')).toBeVisible();
  await expect(page.getByTestId('notice')).toHaveCount(0);
  await expect(page.getByTestId('table-Line 1')).toHaveCount(0);
  expect(await readAutosave(page)).toBeNull();

  // A new image starts cleanly: one empty line, nothing calibrated.
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await expect(page.getByTestId('calibration-ok')).toHaveCount(0);
  expect(await tableRows(page)).toHaveLength(0);
});
