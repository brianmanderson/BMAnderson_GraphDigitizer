/**
 * Same-colour series on the real Takata figure (fixtures/real/km-same-colour-styles.jpg): two
 * black KM-style curves, TFT solid and FFT dashed. Auto-trace reports the clicked line's style and
 * keeps to it, so each trace accepted into its own line reads only its own levels from 12.5
 * months on (labelled: TFT 0.793 then 0.819, FFT 0.755 then 0.778; 0.01 = ~3.8 px at this scale,
 * well above the tracer's error, and the series are 0.015-0.04 apart there).
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, dropFile, goToStep, openApp, readFixtureJson, tableRows } from './helpers.ts';

interface Label {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  knownValues: { series: string; x: [number, number]; y: number; py: number }[];
}
const label = readFixtureJson<Label>('real/km-same-colour-styles.json');
const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
const plateau = (series: string) => label.knownValues.find((k) => k.series === series)!;

async function loadCalibrated(page: Page) {
  await openApp(page);
  await dropFile(page, 'real/km-same-colour-styles.jpg', 'km-same-colour-styles.jpg', 'image/jpeg');
  await expect(page.getByTestId('notice')).toContainText('Loaded km-same-colour-styles.jpg');
  const row = label.xAxis.axisLineRow;
  const col = label.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: tick(label.xAxis.ticks, 0).px, py: row, value: '0' },
    X2: { px: tick(label.xAxis.ticks, 80).px, py: row, value: '80' },
    Y1: { px: col, py: tick(label.yAxis.ticks, 0.2).py, value: '0.2' },
    Y2: { px: col, py: tick(label.yAxis.ticks, 1).py, value: '1' },
  });
  await goToStep(page, 'Data');
}

async function traceAt(page: Page, at: { px: number; py: number }, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await clickImage(page, at.px, at.py);
  await expect(page.getByTestId('trace-count')).toBeVisible();
}

/** y values of the accepted points from 12.5 months on (left of it the two curves touch). */
async function lateValues(page: Page, line: string): Promise<number[]> {
  return (await tableRows(page, line)).map(([, x, y]) => [Number(x), Number(y)] as const).filter(([x]) => x >= 12.5).map(([, y]) => y);
}

const levels = (series: string) => label.knownValues.filter((k) => k.series === series && k.x[1] > 12.5).map((k) => k.y);
const onLevel = (y: number, of: number[]) => of.some((v) => Math.abs(y - v) < 0.01);

test('same-colour lines: the solid and the dashed trace each keep to their own series', async ({ page }) => {
  await loadCalibrated(page);

  // The solid TFT curve, clicked on its plateau.
  const tft = plateau('TFT');
  await traceAt(page, { px: 500, py: tft.py }, 'Auto-trace line');
  await expect(page.getByTestId('trace-kind')).toHaveText('Curve');
  await expect(page.getByTestId('trace-style')).toHaveText('solid');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  const solid = await lateValues(page, 'Line 1');
  expect(solid.length).toBeGreaterThan(5);
  expect(solid.filter((y) => !onLevel(y, levels('TFT')))).toEqual([]);

  // The dashed FFT curve, clicked on a dash of its plateau, into a new line.
  const fft = plateau('FFT');
  await traceAt(page, { px: 474, py: fft.py }, 'Trace into a new line');
  await expect(page.getByTestId('trace-style')).toHaveText('dashed');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  const dashed = await lateValues(page, 'Line 2');
  expect(dashed.length).toBeGreaterThan(5);
  expect(dashed.filter((y) => !onLevel(y, levels('FFT')))).toEqual([]);
});
