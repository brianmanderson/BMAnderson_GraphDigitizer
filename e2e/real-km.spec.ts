import { expect, test } from '@playwright/test';
import { calibrate, clickImage, dropFile, imageToClient, openApp, readFixtureJson, tableRows } from './helpers.ts';

interface KmTruth {
  xAxis: { axisLineRow: number; ticks: { value: number; px: number }[] };
  yAxis: { axisLineCol: number; ticks: { value: number; py: number }[] };
  knownValues: { x: [number, number]; y: number; py?: number }[];
}

const truth = readFixtureJson<KmTruth>('real/km-pericardial-effusion.json');
const tick = <T extends { value: number }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

test('real Kaplan–Meier figure: plateau reads 16.2%, zoom and pan keep points in place', async ({ page }) => {
  await openApp(page);
  await dropFile(page, 'real/km-pericardial-effusion.jpg', 'km-pericardial-effusion.jpg', 'image/jpeg');
  await expect(page.getByTestId('notice')).toContainText('Loaded km-pericardial-effusion.jpg (709 × 424 px)');

  const row = truth.xAxis.axisLineRow;
  const col = truth.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: tick(truth.xAxis.ticks, 0).px, py: row, value: '0' },
    X2: { px: tick(truth.xAxis.ticks, 120).px, py: row, value: '120' },
    // Y1 shares the origin pixel with X1: a click there places Y1 rather than grabbing X1.
    Y1: { px: col, py: tick(truth.yAxis.ticks, 0).py, value: '0' },
    Y2: { px: col, py: tick(truth.yAxis.ticks, 1).py, value: '1' },
  });
  await page.getByRole('button', { name: 'Continue to Data' }).click();

  const plateau = truth.knownValues[0]!;
  await clickImage(page, 400, plateau.py!);
  await page.getByLabel('Pixel columns').check();
  const [first] = await tableRows(page);
  const [, x, y, px, py] = first!;
  expect(Number(x)).toBeGreaterThanOrEqual(plateau.x[0]);
  expect(Number(x)).toBeLessThanOrEqual(plateau.x[1]);
  expect(Math.abs(Number(y) - plateau.y)).toBeLessThanOrEqual(0.005);

  // Zoom in about the cursor, then pan with the middle button.
  const zoomBefore = await page.getByTestId('zoom-level').textContent();
  const at = await imageToClient(page, 400, plateau.py!);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -500);
  await expect(page.getByTestId('zoom-level')).not.toHaveText(zoomBefore!);
  const afterZoom = await imageToClient(page, 400, plateau.py!);
  // The image point under the cursor stays under it.
  expect(Math.abs(afterZoom.x - at.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterZoom.y - at.y)).toBeLessThanOrEqual(1);

  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(at.x - 60, at.y - 40, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const afterPan = await imageToClient(page, 400, plateau.py!);
  expect(afterPan.x - afterZoom.x).toBeCloseTo(-60, 0);
  expect(afterPan.y - afterZoom.y).toBeCloseTo(-40, 0);

  // Stored pixels are untouched by the view, and the marker is still where it is drawn: with
  // Move points on, clicking it selects it rather than adding a point.
  expect((await tableRows(page))[0]!.slice(3)).toEqual([px, py]);
  await page.getByRole('button', { name: 'Move points' }).click();
  await page.mouse.click(afterPan.x, afterPan.y);
  await expect(page.locator('tbody tr').first()).toHaveAttribute('aria-selected', 'true');
  expect(await tableRows(page)).toHaveLength(1);

  // A point placed in the zoomed view lands on the right image pixel; dragging (Move points) moves it.
  await page.getByRole('button', { name: 'Move points' }).click();
  await clickImage(page, 450, plateau.py!);
  let second = (await tableRows(page))[1]!;
  expect(Math.abs(Number(second[3]) - 450)).toBeLessThanOrEqual(0.2);
  expect(Math.abs(Number(second[2]) - plateau.y)).toBeLessThanOrEqual(0.005);

  const from = await imageToClient(page, 450, plateau.py!);
  const to = await imageToClient(page, 500, plateau.py!);
  await page.getByRole('button', { name: 'Move points' }).click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  second = (await tableRows(page))[1]!;
  expect(Math.abs(Number(second[3]) - 500)).toBeLessThanOrEqual(0.2);
  expect(await tableRows(page)).toHaveLength(2);

  // Fit to window restores the overview without touching the points.
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  expect((await tableRows(page))[0]!.slice(3)).toEqual([px, py]);
});
