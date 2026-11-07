/**
 * "Find points" on the real scatter (fixtures/real/scatter-errorbars-glowa.png, Glowa et al.
 * 2024 fig. 3a; provenance in fixtures/real/PROVENANCE.md): red filled circles and blue filled
 * squares, each joined to horizontal and vertical error bars with caps and to a fit curve of its
 * own colour, grey circles and squares of the same shapes on and under them, legend samples in
 * a box. One click on a red circle proposes every red circle and only those (not the grey
 * circles, not the legend sample); one on a blue square every blue square. Truth centres are
 * measured to ±0.5 px; a found point must be within 3.5 px of one of its own group and match it
 * one to one (the same tolerance the previous scatter fixture used).
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, dropFile, goToStep, openApp, placeByHand, readFixtureJson, tableRows } from './helpers.ts';
import { FIND_PROMPT } from '../src/ui/trace.ts';

interface Label {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number; minor?: boolean }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number; minor?: boolean }[] };
  markerSeries: { series: string; seed: [number, number]; markers: [number, number][] }[];
}
const label = readFixtureJson<Label>('real/scatter-errorbars-glowa.json');
const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
const [circles, squares] = label.markerSeries as [Label['markerSeries'][number], Label['markerSeries'][number]];

// Pixel ↔ value for the check (the same linear fit the calibration makes from these ticks).
const x20 = tick(label.xAxis.ticks, 20);
const x160 = tick(label.xAxis.ticks, 160);
const y12 = tick(label.yAxis.ticks, 1.2);
const y24 = tick(label.yAxis.ticks, 2.4);
const pxPerX = (x160.px - x20.px) / 140;
const pxPerY = (y12.py - y24.py) / 1.2;
const toValue = ([px, py]: [number, number]) => [20 + (px - x20.px) / pxPerX, 1.2 + (y12.py - py) / pxPerY] as const;

async function loadCalibrated(page: Page) {
  await openApp(page);
  await dropFile(page, 'real/scatter-errorbars-glowa.png', 'scatter-errorbars-glowa.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded scatter-errorbars-glowa.png');
  const row = label.xAxis.axisLineRow;
  const col = label.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: x20.px, py: row, value: '20' },
    X2: { px: x160.px, py: row, value: '160' },
    Y1: { px: col, py: y12.py, value: '1.2' },
    Y2: { px: col, py: y24.py, value: '2.4' },
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

/** Every accepted point matches a distinct marker of the group, and the counts agree. */
async function expectGroup(page: Page, line: string, group: Label['markerSeries'][number]) {
  const rows = (await tableRows(page, line)).map(([, x, y]) => [Number(x), Number(y)] as const);
  expect(rows).toHaveLength(group.markers.length);
  const truth = group.markers.map(toValue);
  const used = new Set<number>();
  for (const [x, y] of rows) {
    let best = -1;
    let bestD = Infinity;
    truth.forEach(([tx, ty], i) => {
      const d = Math.hypot((x - tx) * pxPerX, (y - ty) * pxPerY);
      if (!used.has(i) && d < bestD) {
        bestD = d;
        best = i;
      }
    });
    expect(bestD).toBeLessThan(3.5);
    used.add(best);
  }
}

test('find points: one click finds every red circle, another every blue square — nothing else, nothing before Accept', async ({ page }) => {
  await loadCalibrated(page);

  const nCircles = await findAt(page, circles.seed, 'Find points');
  expect(nCircles).toBe(circles.markers.length);
  // Nothing is added before Accept.
  expect(await tableRows(page, 'Line 1')).toHaveLength(0);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectGroup(page, 'Line 1', circles);

  const nSquares = await findAt(page, squares.seed, 'Find points into a new line');
  expect(nSquares).toBe(squares.markers.length);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectGroup(page, 'Line 2', squares);
  // Line 1 keeps its circles.
  await expectGroup(page, 'Line 1', circles);
});
