import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { calibrate, clickImage, loadViaPicker, openApp, readFixtureJson, tableRows, type SyntheticTruth } from './helpers.ts';

const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

// Clicks land within ~0.5 CSS px (≈0.4 image px at the fitted zoom): 0.4 px is 0.008 in x
// (52 px per unit) and 0.11 in y (3.8 px per unit). Allow 0.3% of each axis range.
const X_TOL = 0.03;
const Y_TOL = 0.3;

test('linear chart: load → calibrate → place points → table, edit and export', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Axes/ })).toHaveAttribute('aria-current', 'step');

  const row = truth.xAxis.axisLineRow;
  const col = truth.yAxis.axisLineCol;
  const x10 = tick(truth.xAxis.ticks, 10);
  const y100 = tick(truth.yAxis.ticks, 100);

  // A degenerate calibration is reported inline, from the engine.
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: x10.px, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: y100.py, value: '100' },
  });
  await page.getByLabel('X2 value').fill('0');
  await expect(page.getByTestId('calibration-error')).toContainText('same value');
  await page.getByLabel('X2 value').fill('10');
  await expect(page.getByTestId('calibration-ok')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Data' }).click();
  for (const p of truth.points) await clickImage(page, p.px, p.py);

  const rows = await tableRows(page);
  expect(rows).toHaveLength(truth.points.length);
  truth.points.forEach((p, i) => {
    const [n, x, y] = rows[i]!;
    expect(n).toBe(String(i + 1));
    expect(Math.abs(Number(x) - (p.x as number)), `point ${i + 1} x`).toBeLessThanOrEqual(X_TOL);
    expect(Math.abs(Number(y) - p.y), `point ${i + 1} y`).toBeLessThanOrEqual(Y_TOL);
  });

  // Select a stray point and delete it with the keyboard.
  await clickImage(page, 300, 300);
  await expect.poll(async () => (await tableRows(page)).length).toBe(6);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await tableRows(page)).length).toBe(5);

  // Table options: pixel columns and sort by X (placement numbers are kept).
  await page.getByLabel('Pixel columns').check();
  await page.getByLabel('Sort by X').check();
  const sorted = await tableRows(page);
  expect(sorted[0]).toHaveLength(5);
  const xs = sorted.map((r) => Number(r[1]));
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  await page.getByLabel('Sort by X').uncheck();

  // Significant figures apply to the table.
  await page.getByLabel('Significant figures').fill('2');
  const short = await tableRows(page);
  expect(short[3]![2]).toMatch(/^\d{2}$/); // y ≈ 33 → "33"
  await page.getByLabel('Significant figures').fill('4');

  // CSV download: one file, line column, pixel columns as shown.
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  expect(csvDl.suggestedFilename()).toBe('synthetic-linear-data.csv');
  const csv = readFileSync((await csvDl.path())!, 'utf8').trim().split('\r\n');
  expect(csv[0]).toBe('line,#,x,y,px,py');
  expect(csv).toHaveLength(6);
  const [ds, num, cx, cy, cpx, cpy] = csv[1]!.split(',');
  expect([ds, num]).toEqual(['Line 1', '1']);
  expect(Math.abs(Number(cx) - 1)).toBeLessThanOrEqual(X_TOL);
  expect(Math.abs(Number(cy) - 15)).toBeLessThanOrEqual(Y_TOL);
  expect(Math.abs(Number(cpx) - truth.points[0]!.px)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(Number(cpy) - truth.points[0]!.py)).toBeLessThanOrEqual(0.5);

  // Copy as TSV puts the same table on the clipboard.
  await page.getByRole('button', { name: 'Copy as TSV' }).click();
  await expect(page.getByTestId('notice')).toContainText('Copied 5 rows');
  // The OS clipboard may normalise line endings (Windows reads back CRLF).
  const tsv = (await page.evaluate(() => navigator.clipboard.readText())).trim().split(/\r?\n/);
  expect(tsv[0]).toBe('line\t#\tx\ty\tpx\tpy');
  expect(tsv).toHaveLength(6);
  expect(tsv[1]!.split('\t').slice(0, 2)).toEqual(['Line 1', '1']);

  // JSON download is the full Project (format 2 since Phase 3; a calibrated project has no draft).
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
  const project = JSON.parse(readFileSync((await jsonDl.path())!, 'utf8'));
  expect(project.version).toBe(2);
  expect(project).not.toHaveProperty('draftCalibration');
  expect(project.image).toMatchObject({ width: 640, height: 480, name: 'synthetic-linear.png' });
  expect(project.image.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(project.calibration).toMatchObject({ xScale: 'linear', yScale: 'linear' });
  expect(project.calibration.refs.X2.value).toBe(10);
  expect(project.datasets[0].points).toHaveLength(5);
  expect(project.settings).toEqual({ significantFigures: 4, dateFormat: 'YYYY-MM-DD HH:mm' });
});

test('lines: add, rename, switch active, delete', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Data/ }).click();
  await clickImage(page, 200, 200);

  await page.getByRole('button', { name: '+ Add line' }).click();
  await page.getByLabel('Line name').nth(1).fill('Control');
  await page.getByLabel('Make Control active').check();
  await clickImage(page, 250, 250);
  await clickImage(page, 260, 240);
  expect(await tableRows(page, 'Line 1')).toHaveLength(1);
  expect(await tableRows(page, 'Control')).toHaveLength(2);
  // Uncalibrated: values are blank, the table still lists the points.
  expect((await tableRows(page, 'Control'))[0]!.slice(1, 3)).toEqual(['—', '—']);

  // No confirmation prompt: the deletion can be undone instead.
  await page.getByRole('button', { name: 'Delete Control' }).click();
  await expect(page.getByTestId('table-Control')).toHaveCount(0);
  await expect(page.getByTestId('notice')).toContainText('Deleted "Control" and its 2 points.');
  await expect(page.getByRole('button', { name: 'Delete Line 1' })).toBeDisabled();
});
