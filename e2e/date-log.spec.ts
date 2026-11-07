import { expect, test } from '@playwright/test';
import { calibrate, clickImage, loadViaPicker, openApp, placeByHand, readFixtureJson, tableRows, type SyntheticTruth } from './helpers.ts';

const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-date-log.json');
const DAY = 86_400_000;

/** Table text "YYYY-MM-DD HH:mm" (UTC) → epoch ms. */
const tableDate = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

test('date X and log10 Y: dates parsed in UTC, values within tolerance', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-date-log.png');
  await page.getByLabel('X scale').selectOption('date');
  await page.getByLabel('Y scale').selectOption('log10');

  const row = truth.xAxis.axisLineRow;
  const col = truth.yAxis.axisLineCol;
  const xFirst = truth.xAxis.ticks[0]!;
  const xLast = truth.xAxis.ticks.at(-1)!;
  const yTop = truth.yAxis.ticks.at(-1)!;
  await calibrate(page, {
    X1: { px: xFirst.px, py: row, value: String(xFirst.value) },
    X2: { px: xLast.px, py: row, value: String(xLast.value) },
    Y1: { px: col, py: truth.yAxis.ticks[0]!.py, value: '1' },
    Y2: { px: col, py: yTop.py, value: String(yTop.value) },
  });

  // The date input shows how the text was read; ambiguous day/month order is rejected.
  const x1 = page.getByLabel('X1 value');
  await expect(x1.locator('..').getByTestId('date-hint')).toHaveText('= 2024-01-01 00:00:00 UTC');
  await x1.fill('03/04/2024');
  await expect(x1.locator('..').getByTestId('date-hint')).toContainText('ambiguous');
  await expect(page.getByTestId('calibration-error')).toContainText('ambiguous');
  await x1.fill('Jan 1, 2024');
  await expect(page.getByTestId('calibration-ok')).toBeVisible();

  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);
  for (const p of truth.points) await clickImage(page, p.px, p.py);

  const rows = await tableRows(page);
  expect(rows).toHaveLength(truth.points.length);
  truth.points.forEach((p, i) => {
    const [, x, y] = rows[i]!;
    // 520 px span 366 days (≈0.7 day/px); 120 px per decade on Y.
    const expectedMs = Date.parse(`${p.x}Z`);
    expect(Math.abs(tableDate(x!) - expectedMs), `point ${i + 1} date ${x}`).toBeLessThanOrEqual(DAY);
    expect(Math.abs(Number(y) / p.y - 1), `point ${i + 1} y ${y}`).toBeLessThanOrEqual(0.015);
  });

  await page.getByLabel('Date format').fill('DD MMM YYYY');
  expect((await tableRows(page))[1]![1]).toMatch(/^1[4-6] Jun 2024$/);
});
