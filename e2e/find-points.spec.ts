/**
 * "Find points" on the real scatter (fixtures/real/scatter-filled-open-kim.png, Kim et al. 2020
 * fig. 2a; provenance in fixtures/real/PROVENANCE.md): black circles, filled (6X_Accumulation)
 * and open (6X_Normal), joined by a solid / dashed line, on a red reference line, with legend
 * samples in a box. The render is a pixel-doubled low-resolution one (markers ~8 px, little
 * thicker than the lines through them) and the two groups coincide at 1, 5 and 10 Gy and overlap
 * at 50 Gy, so the figure cannot support "every filled marker and only those" the way the
 * previous (non-CC BY) figure did — see SPEC → Auto-trace → Known failures. What it does
 * support, and what this spec guards: one click on a marker proposes markers (not a curve),
 * nothing is added before Accept, Accept adds exactly the proposed points, the clicked marker
 * itself is among them at its measured centre (±1 px truth, 3.5 px tolerance as before), and a
 * second find goes into a new line.
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, dropFile, goToStep, openApp, placeByHand, readFixtureJson, tableRows } from './helpers.ts';
import { FIND_PROMPT } from '../src/ui/trace.ts';

interface Label {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  markerSeries: { series: string; seed: [number, number]; markers: [number, number][] }[];
}
const label = readFixtureJson<Label>('real/scatter-filled-open-kim.json');
const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
const [filled, open] = label.markerSeries as [Label['markerSeries'][number], Label['markerSeries'][number]];

// Pixel ↔ value for the check (the same linear fit the calibration makes from these labels; the
// axes have no tick marks, so the labelled positions are label centres).
const x0 = tick(label.xAxis.ticks, 0);
const x100 = tick(label.xAxis.ticks, 100);
const y0 = tick(label.yAxis.ticks, 0);
const y120 = tick(label.yAxis.ticks, 120);
const pxPerX = (x100.px - x0.px) / 100;
const pxPerY = (y0.py - y120.py) / 120;
const toValue = ([px, py]: [number, number]) => [(px - x0.px) / pxPerX, (y0.py - py) / pxPerY] as const;

async function loadCalibrated(page: Page) {
  await openApp(page);
  await dropFile(page, 'real/scatter-filled-open-kim.png', 'scatter-filled-open-kim.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded scatter-filled-open-kim.png');
  const row = label.xAxis.axisLineRow;
  const col = label.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: x0.px, py: row, value: '0' },
    X2: { px: x100.px, py: row, value: '100' },
    Y1: { px: col, py: y0.py, value: '0' },
    Y2: { px: col, py: y120.py, value: '120' },
  });
  await goToStep(page, 'Data');
  await placeByHand(page);
}

async function findAt(page: Page, at: [number, number], button: string): Promise<number> {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByTestId('trace-prompt')).toHaveText(FIND_PROMPT);
  await clickImage(page, at[0], at[1]);
  await expect(page.getByTestId('trace-count')).toBeVisible();
  await expect(page.getByTestId('trace-kind')).toHaveText('Markers');
  return Number(await page.getByTestId('trace-count').textContent());
}

/** The accepted rows number `count`, and one of them is the clicked marker (within 3.5 px). */
async function expectClickedAmong(page: Page, line: string, count: number, centre: [number, number]) {
  const rows = (await tableRows(page, line)).map(([, x, y]) => [Number(x), Number(y)] as const);
  expect(rows).toHaveLength(count);
  const [tx, ty] = toValue(centre);
  const nearest = Math.min(...rows.map(([x, y]) => Math.hypot((x - tx) * pxPerX, (y - ty) * pxPerY)));
  expect(nearest).toBeLessThan(3.5);
}

test('find points: a click on a filled circle, then one on an open circle, each proposes markers into its own line', async ({ page }) => {
  await loadCalibrated(page);
  const rowsBefore = await tableRows(page, 'Line 1');
  expect(rowsBefore).toHaveLength(0);

  // The filled 100 Gy marker (the one place the two groups are apart).
  const nFilled = await findAt(page, filled.seed, 'Find points');
  expect(nFilled).toBeGreaterThanOrEqual(1);
  // Nothing is added before Accept.
  expect(await tableRows(page, 'Line 1')).toHaveLength(0);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectClickedAmong(page, 'Line 1', nFilled, filled.markers[filled.markers.length - 1]!);

  // The open 100 Gy marker, into a new line; Line 1 keeps its points.
  const nOpen = await findAt(page, open.seed, 'Find points into a new line');
  expect(nOpen).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectClickedAmong(page, 'Line 2', nOpen, open.markers[open.markers.length - 1]!);
  expect(await tableRows(page, 'Line 1')).toHaveLength(nFilled);
});
