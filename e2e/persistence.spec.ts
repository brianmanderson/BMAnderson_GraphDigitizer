import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  calibrate,
  clickImage,
  goToStep,
  imageToClient,
  loadAndCalibrateKm,
  loadViaPicker,
  openApp,
  placeByHand,
  readAutosave,
  readFixtureJson,
  tableRows,
  type SavedProject,
  type SyntheticTruth,
} from './helpers.ts';

const linear = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

async function calibrateLinear(page: Page) {
  const row = linear.xAxis.axisLineRow;
  const col = linear.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: tick(linear.xAxis.ticks, 10).px, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: tick(linear.yAxis.ticks, 100).py, value: '100' },
  });
}

const toolbarButton = (page: Page, name: 'Undo' | 'Redo') =>
  page.getByRole('group', { name: 'History' }).getByRole('button', { name });

/** The "at (px, py) px" hint under a ref's value input. */
const refHint = (page: Page, ref: string) =>
  page.getByLabel(`${ref} value`).locator('xpath=..').locator('.hint.muted').textContent();

test('undo/redo covers refs, scales, points and lines; deleting and replacing offer Undo instead of a prompt', async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`);
  });
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await calibrateLinear(page);

  // Scale change → engine error; Ctrl+Z (focus still in the select) restores it.
  await page.getByLabel('X scale').selectOption('log10');
  await expect(page.getByTestId('calibration-error')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('X scale')).toHaveValue('linear');
  await expect(page.getByTestId('calibration-ok')).toBeVisible();

  // Retyping a value (clear, then each keystroke) is one undo step.
  await page.getByLabel('X2 value').fill('');
  await page.getByLabel('X2 value').pressSequentially('20');
  await page.getByLabel('X2 value').press('Enter');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('X2 value')).toHaveValue('10');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByLabel('X2 value')).toHaveValue('20');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('X2 value')).toHaveValue('10');

  // A ref drag (many moves) is one undo step.
  const x2 = tick(linear.xAxis.ticks, 10);
  const before = await refHint(page, 'X2');
  const from = await imageToClient(page, x2.px, linear.xAxis.axisLineRow);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => refHint(page, 'X2')).not.toBe(before);
  await toolbarButton(page, 'Undo').click();
  await expect.poll(() => refHint(page, 'X2')).toBe(before);
  await toolbarButton(page, 'Redo').click();
  await expect.poll(() => refHint(page, 'X2')).not.toBe(before);
  await toolbarButton(page, 'Undo').click();

  // Points and lines.
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);
  await clickImage(page, linear.points[0]!.px, linear.points[0]!.py);
  await clickImage(page, linear.points[1]!.px, linear.points[1]!.py);
  await page.getByRole('button', { name: '+ Add line' }).click();
  await placeByHand(page);
  await clickImage(page, linear.points[2]!.px, linear.points[2]!.py);
  expect(await tableRows(page, 'Line 2')).toHaveLength(1);

  // Deleting a line with points no longer asks; the notice offers Undo.
  await page.getByRole('button', { name: 'Delete Line 2' }).click();
  await expect(page.getByTestId('table-Line 2')).toHaveCount(0);
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('Deleted "Line 2" and its 1 point.');
  await notice.getByRole('button', { name: 'Undo' }).click();
  expect(await tableRows(page, 'Line 2')).toHaveLength(1);
  await expect(notice.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  // Loading another image over the work is undoable too.
  await loadViaPicker(page, 'synthetic/synthetic-date-log.png');
  await expect(notice).toContainText('Undo brings back the previous work');
  await expect(page.getByTestId('table-Line 1')).toHaveCount(0);
  await notice.getByRole('button', { name: 'Undo' }).click();
  expect(await tableRows(page, 'Line 1')).toHaveLength(2);
  expect(await tableRows(page, 'Line 2')).toHaveLength(1);
  await goToStep(page, 'Axes');
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('table-Line 1')).toHaveCount(0);

  // An Undo offer goes stale once something else changes the history.
  await page.keyboard.press('Control+z');
  await goToStep(page, 'Data');
  await placeByHand(page);
  await page.getByRole('button', { name: 'Delete Line 2' }).click();
  await clickImage(page, 300, 300);
  await expect(notice.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('autosave restores everything after a reload; a saved project file reopens', async ({ page }) => {
  await openApp(page);
  await loadAndCalibrateKm(page);
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);
  await clickImage(page, 400, 295);
  await clickImage(page, 300, 300);
  await page.getByLabel('Line name').fill('Effusion');
  await page.getByRole('button', { name: '+ Add line' }).click();
  await placeByHand(page);
  await page.getByLabel('Line name').nth(1).fill('Other');
  await clickImage(page, 200, 320);
  await page.getByLabel('Pixel columns').check();
  const effusion = await tableRows(page, 'Effusion');
  const other = await tableRows(page, 'Other');
  expect(effusion).toHaveLength(2);

  // Wait until the autosave holds the latest edit, then reload.
  await expect
    .poll(async () => {
      const saved = await readAutosave(page);
      return saved?.project.datasets.map((d) => `${d.name}:${d.points.length}`).join(',');
    })
    .toBe('Effusion:2,Other:1');
  await page.reload();
  await expect(page.getByTestId('notice')).toContainText('Restored km-pericardial-pao.png from your last session');
  // Restored into the Data step, with the active line and every value as before.
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Data/ })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('Make Other active')).toBeChecked();
  // Auto-trace, the Data step's default tool, is open for the restored active line.
  await expect(page.getByTestId('trace-panel')).toContainText('Auto-trace into Other');
  await page.getByLabel('Pixel columns').check();
  expect(await tableRows(page, 'Effusion')).toEqual(effusion);
  expect(await tableRows(page, 'Other')).toEqual(other);
  // Undo history is not saved: there is nothing to undo after a restore.
  await expect(toolbarButton(page, 'Undo')).toBeDisabled();

  // Save project → a .json with the image embedded, version 2.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project' }).click()]);
  expect(download.suggestedFilename()).toBe('km-pericardial-pao-project.json');
  const file = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedProject;
  expect(saved.version).toBe(2);
  expect(saved.image).toMatchObject({ name: 'km-pericardial-pao.png', width: 710, height: 691 });
  expect(saved.image.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(saved.datasets.map((d) => d.name)).toEqual(['Effusion', 'Other']);

  // Replace it with another image, then open the saved file: everything comes back.
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await expect(page.getByTestId('table-Effusion')).toHaveCount(0);
  await page.getByTestId('project-input').setInputFiles(file);
  await expect(page.getByTestId('notice')).toContainText('Opened km-pericardial-pao-project.json');
  await page.getByLabel('Pixel columns').check();
  expect(await tableRows(page, 'Effusion')).toEqual(effusion);
  expect(await tableRows(page, 'Other')).toEqual(other);
  // Opening is an undo step like any other (the notice offers Undo only when it replaced work,
  // and the freshly loaded image had none).
  await expect(page.getByTestId('notice').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await toolbarButton(page, 'Undo').click();
  await expect(page.getByTestId('table-Effusion')).toHaveCount(0);

  // Bad project files are refused with a reason; nothing changes.
  const input = page.getByTestId('project-input');
  await input.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') });
  await expect(page.getByTestId('notice')).toContainText('"broken.json": This file is not a Graph Digitizer project (it is not valid JSON).');
  const future = { ...saved, version: 3 };
  await input.setInputFiles({ name: 'future.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(future)) });
  await expect(page.getByTestId('notice')).toContainText('saved by a newer version of the app (format 3)');
  const damaged = { ...saved, datasets: [{ ...saved.datasets[0], points: [{ id: 'p', px: 'x', py: 1 }] }] };
  await input.setInputFiles({ name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) });
  await expect(page.getByTestId('notice')).toContainText('datasets[0].points[0].px must be a finite number');
  // A version 1 file (Phase 2's JSON export) opens and is converted.
  const v1 = { ...saved, version: 1 };
  await input.setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v1)) });
  await expect(page.getByTestId('notice')).toContainText('Opened old.json (converted from format 1)');
  expect(await tableRows(page, 'Effusion')).toEqual(effusion);
});

test('a calibration in progress survives a reload', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-date-log.png');
  await page.getByLabel('Y scale').selectOption('log10');
  await page.getByLabel('X scale').selectOption('date');
  await clickImage(page, 80, 420);
  await page.getByLabel('X1 value').fill('2024-01-01');
  await expect
    .poll(async () => (await readAutosave(page))?.project.draftCalibration?.refs.X1?.value)
    .toBe('2024-01-01');
  await page.reload();
  await expect(page.getByTestId('notice')).toContainText('Restored synthetic-date-log.png');
  await expect(page.getByLabel('X scale')).toHaveValue('date');
  await expect(page.getByLabel('Y scale')).toHaveValue('log10');
  await expect(page.getByLabel('X1 value')).toHaveValue('2024-01-01');
  await expect(page.getByTestId('axes-prompt')).toContainText('(X2)');
});
