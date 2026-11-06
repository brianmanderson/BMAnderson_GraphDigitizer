/**
 * "Find points" on the real scatter (fixtures/real/scatter-filled-open-errorbars.png): black
 * circles, filled (3 months) and open (12 months), joined to error bars, caps and a dashed
 * reference line, two filled/open pairs overlapping, legend samples in a box. One click on a
 * filled circle proposes every filled one and only those; one on an open circle every open one.
 * Truth centres are measured to ±0.5 px; a found point must be within 3.5 px of one of its own
 * group (the half-hidden filled marker at x ≈ 52 is found ~3 px off) and match it one to one.
 */

import { expect, test, type Page } from '@playwright/test';
import { calibrate, clickImage, dropFile, goToStep, openApp, readFixtureJson, tableRows } from './helpers.ts';
import { FIND_PROMPT } from '../src/ui/trace.ts';

interface Label {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  markerSeries: { series: string; seed: [number, number]; markers: [number, number][] }[];
}
const label = readFixtureJson<Label>('real/scatter-filled-open-errorbars.json');
const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;
const [filled, open] = label.markerSeries as [Label['markerSeries'][number], Label['markerSeries'][number]];

// Pixel ↔ value for the check (the same linear fit the calibration makes from these ticks).
const x0 = tick(label.xAxis.ticks, 0);
const x70 = tick(label.xAxis.ticks, 70);
const y0 = tick(label.yAxis.ticks, 0);
const y120 = tick(label.yAxis.ticks, 120);
const pxPerX = (x70.px - x0.px) / 70;
const pxPerY = (y0.py - y120.py) / 120;
const toValue = ([px, py]: [number, number]) => [(px - x0.px) / pxPerX, (y0.py - py) / pxPerY] as const;

async function loadCalibrated(page: Page) {
  await openApp(page);
  await dropFile(page, 'real/scatter-filled-open-errorbars.png', 'scatter-filled-open-errorbars.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded scatter-filled-open-errorbars.png');
  const row = label.xAxis.axisLineRow;
  const col = label.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: x0.px, py: row, value: '0' },
    X2: { px: x70.px, py: row, value: '70' },
    Y1: { px: col, py: y0.py, value: '0' },
    Y2: { px: col, py: y120.py, value: '120' },
  });
  await goToStep(page, 'Data');
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

test('find points: one click finds every filled circle, another every open one', async ({ page }) => {
  await loadCalibrated(page);

  const nFilled = await findAt(page, filled.seed, 'Find points');
  expect(nFilled).toBe(filled.markers.length);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectGroup(page, 'Line 1', filled);

  const nOpen = await findAt(page, open.seed, 'Find points into a new line');
  expect(nOpen).toBe(open.markers.length);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expectGroup(page, 'Line 2', open);
});
