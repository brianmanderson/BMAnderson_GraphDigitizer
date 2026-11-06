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

/** Line 1: a, b, c along y = 200; Line 2: x, y along y = 300 and z far away. */
const LINES: Pt[][] = [
  [
    { id: 'a', px: 200, py: 200 },
    { id: 'b', px: 300, py: 200 },
    { id: 'c', px: 400, py: 200 },
  ],
  [
    { id: 'x', px: 250, py: 300 },
    { id: 'y', px: 350, py: 300 },
    { id: 'z', px: 600, py: 500 },
  ],
];

const selectedRows = (page: Page) => page.locator('tbody tr[aria-selected="true"]');
const undo = (page: Page) => page.getByRole('group', { name: 'History' }).getByRole('button', { name: 'Undo' });

async function shiftClickImage(page: Page, px: number, py: number) {
  const p = await imageToClient(page, px, py);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}

async function dragImage(page: Page, from: { px: number; py: number }, to: { px: number; py: number }, shift = false) {
  const a = await imageToClient(page, from.px, from.py);
  const b = await imageToClient(page, to.px, to.py);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('Shift+click three points across two lines, Delete removes all three, one Ctrl+Z brings them back', async ({ page }) => {
  await openProject(page, LINES);
  await moveTool(page).click();
  await shiftClickImage(page, 200, 200);
  await shiftClickImage(page, 400, 200);
  await shiftClickImage(page, 350, 300);
  await expect(selectedRows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Delete 3 points' })).toBeEnabled();
  // The line of the point clicked last is the active one.
  await expect(page.getByLabel('Make Line 2 active')).toBeChecked();
  // Shift+click again removes a point, and adds it back.
  await shiftClickImage(page, 400, 200);
  await expect(selectedRows(page)).toHaveCount(2);
  await shiftClickImage(page, 400, 200);
  await expect(selectedRows(page)).toHaveCount(3);

  await page.keyboard.press('Delete');
  await expect.poll(() => pixels(page, 'Line 1')).toEqual([[300, 200]]);
  expect(await pixels(page, 'Line 2')).toEqual([
    [250, 300],
    [600, 500],
  ]);
  await expect(page.getByRole('button', { name: 'Delete selected points' })).toBeDisabled();

  await page.keyboard.press('Control+z');
  await expect.poll(() => pixels(page, 'Line 1')).toHaveLength(3);
  expect(await pixels(page, 'Line 2')).toHaveLength(3);
  // That was the only step: the project as opened is the oldest state (nothing more to undo).
  await expect(undo(page)).toBeDisabled();
});

test('marquee select (Shift adds), drag and nudge the selection together, then delete it in one step', async ({ page }) => {
  await openProject(page, LINES);
  await moveTool(page).click();
  // A box over b, x and y (a and c are outside it), started on empty canvas.
  await dragImage(page, { px: 230, py: 170 }, { px: 370, py: 320 });
  await expect(selectedRows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Delete 3 points' })).toBeVisible();
  await dragImage(page, { px: 580, py: 480 }, { px: 620, py: 520 }, true);
  await expect(selectedRows(page)).toHaveCount(4);

  // Dragging one selected point moves all four by the same amount, as one undo step.
  await dragImage(page, { px: 300, py: 200 }, { px: 320, py: 210 });
  await expect.poll(() => pixels(page, 'Line 1')).not.toContainEqual([300, 200]);
  const [, b] = await pixels(page, 'Line 1');
  const dx = b![0]! - 300;
  const dy = b![1]! - 200;
  expect(Math.abs(dx - 20)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(dy - 10)).toBeLessThanOrEqual(0.5);
  expect((await pixels(page, 'Line 1'))[0]).toEqual([200, 200]);
  const line2 = await pixels(page, 'Line 2');
  LINES[1]!.forEach((p, i) => {
    expect(line2[i]![0]).toBeCloseTo(p.px + dx, 1);
    expect(line2[i]![1]).toBeCloseTo(p.py + dy, 1);
  });
  await undo(page).click();
  await expect.poll(() => pixels(page, 'Line 2')).toEqual(LINES[1]!.map((p) => [p.px, p.py]));
  await expect(selectedRows(page)).toHaveCount(4);

  // Arrow keys nudge the whole selection; repeated presses are one undo step.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => pixels(page, 'Line 2')).toEqual([
    [252, 300],
    [352, 300],
    [602, 500],
  ]);
  expect(await pixels(page, 'Line 1')).toEqual([
    [200, 200],
    [302, 200],
    [400, 200],
  ]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => pixels(page, 'Line 2')).toEqual(LINES[1]!.map((p) => [p.px, p.py]));

  await page.keyboard.press('Delete');
  await expect.poll(() => pixels(page, 'Line 2')).toEqual([]);
  expect(await pixels(page, 'Line 1')).toEqual([
    [200, 200],
    [400, 200],
  ]);
  await expect(page.getByTestId('notice')).toContainText('Deleted 4 points.');
  await page.keyboard.press('Control+z');
  await expect.poll(() => pixels(page, 'Line 2')).toHaveLength(3);
  expect(await pixels(page, 'Line 1')).toHaveLength(3);

  // Esc clears the selection; so does a click on empty canvas.
  await dragImage(page, { px: 180, py: 180 }, { px: 420, py: 220 });
  await expect(selectedRows(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(selectedRows(page)).toHaveCount(0);
  await dragImage(page, { px: 180, py: 180 }, { px: 420, py: 220 });
  await expect(selectedRows(page)).toHaveCount(3);
  const empty = await imageToClient(page, 500, 100);
  await page.mouse.click(empty.x, empty.y);
  await expect(selectedRows(page)).toHaveCount(0);
});

test('place mode: select from the table (Shift+click, Select all), delete; placing selects the new point', async ({ page }) => {
  await openProject(page, LINES);
  const line1 = page.getByTestId('table-Line 1').locator('tbody tr');
  const line2 = page.getByTestId('table-Line 2').locator('tbody tr');
  await line1.nth(0).click();
  await line2.nth(1).click({ modifiers: ['Shift'] });
  await expect(selectedRows(page)).toHaveCount(2);
  await expect(page.getByLabel('Make Line 2 active')).toBeChecked();
  await page.getByRole('button', { name: 'Delete 2 points' }).click();
  await expect.poll(() => pixels(page, 'Line 1')).toEqual([
    [300, 200],
    [400, 200],
  ]);
  expect(await pixels(page, 'Line 2')).toEqual([
    [250, 300],
    [600, 500],
  ]);
  await undo(page).click();
  await expect.poll(() => pixels(page, 'Line 1')).toHaveLength(3);

  // "Select all" of a line selects its points and makes it active; arrows move them all.
  await page.getByLabel('Make Line 2 active').check();
  await page.getByRole('button', { name: 'Select all points of Line 1' }).click();
  await expect(selectedRows(page)).toHaveCount(3);
  await expect(page.getByLabel('Make Line 1 active')).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => pixels(page, 'Line 1')).toEqual([
    [200, 201],
    [300, 201],
    [400, 201],
  ]);

  // A click on the canvas places a point (right beside b) and selects only it.
  const at = await imageToClient(page, 300, 201);
  await page.mouse.click(at.x + 3, at.y);
  await expect.poll(() => pixels(page, 'Line 1')).toHaveLength(4);
  await expect(selectedRows(page)).toHaveCount(1);
  await expect(page.getByTestId('table-Line 1').locator('tbody tr').nth(3)).toHaveAttribute('aria-selected', 'true');
  expect((await pixels(page, 'Line 1')).slice(0, 3)).toEqual([
    [200, 201],
    [300, 201],
    [400, 201],
  ]);
});
