/**
 * The Data step's two modes: with "Move points" off (the default) every click places a point on
 * the active line and existing points are never grabbed, so points of different lines can sit
 * right beside one another; with it on, clicks select and drags move.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixturePath, goToStep, imageToClient, openApp, tableRows } from './helpers.ts';

type Pt = { id: string; px: number; py: number };

/** The real KM figure (850 × 666) calibrated from its labelled ticks, with the given lines. */
function project(lines: Pt[][]) {
  const dataUrl = `data:image/png;base64,${readFileSync(fixturePath('real/km-cns-lymphoma.png')).toString('base64')}`;
  const colors = ['#d6336c', '#1971c2', '#2f9e44'];
  return {
    version: 2,
    image: { dataUrl, width: 850, height: 666, name: 'km-cns-lymphoma.png' },
    calibration: {
      xScale: 'linear',
      yScale: 'linear',
      refs: {
        X1: { px: 128, py: 455, value: 0 },
        X2: { px: 815, py: 455, value: 100 },
        Y1: { px: 90.5, py: 401, value: 0 },
        Y2: { px: 90.5, py: 78, value: 1 },
      },
    },
    datasets: lines.map((points, l) => ({ id: `line-${l}`, name: `Line ${l + 1}`, color: colors[l]!, points })),
    settings: { significantFigures: 4, dateFormat: 'YYYY-MM-DD' },
  };
}

async function openProject(page: Page, lines: Pt[][]) {
  await openApp(page);
  const buffer = Buffer.from(JSON.stringify(project(lines)));
  await page.getByTestId('project-input').setInputFiles({ name: 'modes.json', mimeType: 'application/json', buffer });
  await expect(page.getByTestId('notice')).toContainText('Opened modes.json');
  await page.getByLabel('Pixel columns').check();
}

/** px, py cells of a line's rows. */
const pixels = async (page: Page, line: string) => (await tableRows(page, line)).map((r) => r.slice(3).map(Number));

const moveTool = (page: Page) => page.getByRole('button', { name: 'Move points' });

test('place mode: a click right beside another line’s point adds a point and moves nothing', async ({ page }) => {
  await openProject(page, [[{ id: 'a', px: 300, py: 200 }], []]);
  await expect(moveTool(page)).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Make Line 2 active').check();

  // 4 CSS px from Line 1's point: well inside the 9 px radius that used to grab it.
  const at = await imageToClient(page, 300, 200);
  await page.mouse.click(at.x + 4, at.y + 2);
  await expect.poll(() => pixels(page, 'Line 2')).toHaveLength(1);
  expect(await pixels(page, 'Line 1')).toEqual([[300, 200]]);
  const [placed] = await pixels(page, 'Line 2');
  const scale = await page.getByTestId('canvas').evaluate((el) => Number((el as HTMLElement).dataset.scale));
  expect(Math.abs(placed![0]! - (300 + 4 / scale))).toBeLessThanOrEqual(0.2);

  // A press on the point itself places another one; a drag from it moves nothing.
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => pixels(page, 'Line 2')).toHaveLength(2);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 20, { steps: 6 });
  await page.mouse.up();
  expect(await pixels(page, 'Line 1')).toEqual([[300, 200]]);
  expect(await pixels(page, 'Line 2')).toHaveLength(2);
  await expect(page.getByTestId('canvas')).toHaveCSS('cursor', 'crosshair');
});

test('move mode: the same press drags the existing point, in one undo step', async ({ page }) => {
  await openProject(page, [[{ id: 'a', px: 300, py: 200 }], []]);
  await page.getByLabel('Make Line 2 active').check();
  // Shortcuts are ignored while a form control has focus (the radio button here).
  await page.keyboard.press('m');
  await expect(moveTool(page)).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('m');
  await expect(moveTool(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('data-prompt')).toContainText('Move points is on');

  const at = await imageToClient(page, 300, 200);
  await page.mouse.move(at.x + 4, at.y + 2);
  await expect(page.getByTestId('canvas')).toHaveCSS('cursor', 'grab');
  const to = await imageToClient(page, 340, 230);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + 2, { steps: 8 });
  await page.mouse.up();
  const [moved] = await pixels(page, 'Line 1');
  expect(Math.abs(moved![0]! - 340)).toBeLessThanOrEqual(0.3);
  expect(Math.abs(moved![1]! - 230)).toBeLessThanOrEqual(0.3);
  expect(await tableRows(page, 'Line 2')).toHaveLength(0);
  // Grabbing Line 1's point made its line active.
  await expect(page.getByLabel('Make Line 1 active')).toBeChecked();

  // A click on empty canvas places nothing in move mode.
  await page.mouse.click(at.x - 80, at.y + 60);
  expect(await tableRows(page, 'Line 1')).toHaveLength(1);
  expect(await tableRows(page, 'Line 2')).toHaveLength(0);

  await page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => pixels(page, 'Line 1')).toEqual([[300, 200]]);

  // The tool belongs to the Data step: disabled (and M ignored) elsewhere; the setting is remembered.
  await goToStep(page, 'Axes');
  await expect(moveTool(page)).toBeDisabled();
  await page.keyboard.press('m');
  await goToStep(page, 'Data');
  await expect(moveTool(page)).toHaveAttribute('aria-pressed', 'true');
  await moveTool(page).click();
  await expect(moveTool(page)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('graph-digitizer:prefs') ?? '{}').movePoints)).toBe(false);
});
