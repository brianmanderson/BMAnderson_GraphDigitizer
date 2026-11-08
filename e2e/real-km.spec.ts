import { expect, test } from '@playwright/test';
import { clickImage, imageToClient, kmTruth, loadAndCalibrateKm, openApp, placeByHand, tableRows } from './helpers.ts';

/**
 * The real Kaplan–Meier figure (fixtures/real/km-pericardial-pao.png, Pao et al. 2020 fig. 1c):
 * calibrated from its labelled ticks, the black series' final plateau (row 186, columns 526–648)
 * must read its labelled value. Labels are ±1 px; at 410 px per unit of y and the fitted zoom a
 * click lands within ~0.5 CSS px, so 0.005 in y is the same tolerance the fixture tests use.
 */
const plateau = kmTruth.knownValues[0]!;
const ON_PLATEAU = 590; // image column inside the plateau's 526–648

test('real Kaplan–Meier figure: the plateau reads its labelled value, zoom and pan keep points in place', async ({ page }) => {
  await openApp(page);
  await loadAndCalibrateKm(page);
  await expect(page.getByTestId('notice')).toContainText('Loaded km-pericardial-pao.png (710 × 691 px)');
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await placeByHand(page);

  await clickImage(page, ON_PLATEAU, plateau.py!);
  await page.getByLabel('Pixel columns').check();
  const [first] = await tableRows(page);
  const [, x, y, px, py] = first!;
  expect(Number(x)).toBeGreaterThanOrEqual(plateau.x[0]);
  expect(Number(x)).toBeLessThanOrEqual(plateau.x[1]);
  expect(Math.abs(Number(y) - plateau.y)).toBeLessThanOrEqual(0.005);

  // Zoom in about the cursor, then pan with the middle button.
  const zoomBefore = await page.getByTestId('zoom-level').textContent();
  const at = await imageToClient(page, ON_PLATEAU, plateau.py!);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -500);
  await expect(page.getByTestId('zoom-level')).not.toHaveText(zoomBefore!);
  const afterZoom = await imageToClient(page, ON_PLATEAU, plateau.py!);
  // The image point under the cursor stays under it.
  expect(Math.abs(afterZoom.x - at.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterZoom.y - at.y)).toBeLessThanOrEqual(1);

  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(at.x - 60, at.y - 40, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const afterPan = await imageToClient(page, ON_PLATEAU, plateau.py!);
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
  await clickImage(page, ON_PLATEAU + 30, plateau.py!);
  let second = (await tableRows(page))[1]!;
  expect(Math.abs(Number(second[3]) - (ON_PLATEAU + 30))).toBeLessThanOrEqual(0.2);
  expect(Math.abs(Number(second[2]) - plateau.y)).toBeLessThanOrEqual(0.005);

  const from = await imageToClient(page, ON_PLATEAU + 30, plateau.py!);
  const to = await imageToClient(page, ON_PLATEAU + 55, plateau.py!);
  await page.getByRole('button', { name: 'Move points' }).click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  second = (await tableRows(page))[1]!;
  expect(Math.abs(Number(second[3]) - (ON_PLATEAU + 55))).toBeLessThanOrEqual(0.2);
  expect(await tableRows(page)).toHaveLength(2);

  // Fit to window restores the overview without touching the points.
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  expect((await tableRows(page))[0]!.slice(3)).toEqual([px, py]);
});
