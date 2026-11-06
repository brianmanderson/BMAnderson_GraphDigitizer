/**
 * The right-hand panel with long lines (Auto-trace makes 60+ points per line common): the step's
 * controls stay fully visible while the points table scrolls, and each line's point list can be
 * collapsed (UI state only — exports always hold every point). Projects are built here and opened
 * through "Open project…", so the specs do not depend on clicking hundreds of points.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickImage, fixturePath, openApp, readAutosave, tableRows } from './helpers.ts';

/** The real KM figure (850 × 666) calibrated from its labelled ticks: x 0–100, y 0–1. */
function project(lines: number, pointsPerLine: number) {
  const dataUrl = `data:image/png;base64,${readFileSync(fixturePath('real/km-cns-lymphoma.png')).toString('base64')}`;
  const colors = ['#d6336c', '#1971c2', '#2f9e44', '#f08c00', '#7048e8', '#0c8599', '#e8590c'];
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
    datasets: Array.from({ length: lines }, (_, l) => ({
      id: `line-${l}`,
      name: `Line ${l + 1}`,
      color: colors[l % colors.length]!,
      // Rows 40 px apart, points 3.5 px apart: the nearest marker to any of them is itself.
      points: Array.from({ length: pointsPerLine }, (_, i) => ({ id: `p${l}-${i}`, px: 100 + i * 3.5, py: 90 + l * 40 })),
    })),
    settings: { significantFigures: 4, dateFormat: 'YYYY-MM-DD' },
  };
}

async function openProject(page: Page, lines: number, pointsPerLine: number) {
  await openApp(page);
  const buffer = Buffer.from(JSON.stringify(project(lines, pointsPerLine)));
  await page.getByTestId('project-input').setInputFiles({ name: 'long-lines.json', mimeType: 'application/json', buffer });
  await expect(page.getByTestId('notice')).toContainText('Opened long-lines.json');
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Data/ })).toHaveAttribute('aria-current', 'step');
}

const lineToggle = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name} \\(\\d+\\)$`) });

/** The element is entirely inside the viewport and inside the (unscrolled) step area. */
async function expectFullyShown(page: Page, el: Locator) {
  const box = (await el.boundingBox())!;
  const area = (await page.locator('.step-scroll').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(area.y);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
}

/** The step area needs no scrollbar of its own; the points table does. */
async function expectStepWholeTableScrolls(page: Page) {
  const step = await page.locator('.step-scroll').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(step).toBeLessThanOrEqual(1);
  const table = await page.getByTestId('data-tables').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(table.scroll).toBeGreaterThan(table.client);
  expect(table.client).toBeGreaterThan(40);
}

for (const size of [
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
]) {
  test(`6 lines × 200 points at ${size.width}×${size.height}: the Data step stays whole, the table scrolls`, async ({ page }) => {
    await page.setViewportSize(size);
    await openProject(page, 6, 200);
    expect(await tableRows(page, 'Line 6')).toHaveLength(200);

    for (const name of ['+ Add line', 'Delete selected point', 'Auto-trace line', 'Trace into a new line']) {
      await expectFullyShown(page, page.getByRole('button', { name, exact: true }));
    }
    await expectFullyShown(page, page.getByRole('radio', { name: 'Make Line 6 active' }));
    await expectStepWholeTableScrolls(page);

    // The Auto-trace panel opens under the lines without squeezing them.
    await page.getByRole('button', { name: 'Auto-trace line', exact: true }).click();
    await expect(page.getByTestId('trace-prompt')).toBeVisible();
    await expectFullyShown(page, page.getByTestId('trace-panel'));
    await expectFullyShown(page, page.getByRole('button', { name: '+ Add line' }));
    await expectStepWholeTableScrolls(page);
  });
}

test('a window too short for both: the table keeps its minimum and the step area scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 520 });
  await openProject(page, 6, 200);
  const step = await page.locator('.step-scroll').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(step.scroll).toBeGreaterThan(step.client);
  // Options, the first line's header row and the export bar are still shown.
  await expect(page.getByLabel('Sort by X')).toBeInViewport({ ratio: 1 });
  await expect(lineToggle(page, 'Line 1')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeInViewport({ ratio: 1 });
});

test('collapse and expand point lists per line and all at once; exports keep every point', async ({ page }) => {
  await openProject(page, 3, 5);
  const line1 = lineToggle(page, 'Line 1');
  await expect(line1).toHaveAttribute('aria-expanded', 'true');
  const controls = (await line1.getAttribute('aria-controls'))!;
  await expect(page.locator(`[id="${controls}"]`)).toBeVisible();

  await line1.click();
  await expect(line1).toHaveAttribute('aria-expanded', 'false');
  await expect(line1).toHaveText(/Line 1 \(5\)/);
  await expect(page.locator(`[id="${controls}"]`)).toBeHidden();
  expect(await tableRows(page, 'Line 1')).toHaveLength(0);
  expect(await tableRows(page, 'Line 2')).toHaveLength(5);

  await line1.click();
  expect(await tableRows(page, 'Line 1')).toHaveLength(5);

  await page.getByRole('button', { name: 'Collapse all' }).click();
  for (const name of ['Line 1', 'Line 2', 'Line 3']) {
    await expect(lineToggle(page, name)).toHaveAttribute('aria-expanded', 'false');
    expect(await tableRows(page, name)).toHaveLength(0);
  }
  await expect(page.getByRole('button', { name: 'Collapse all' })).toBeDisabled();

  // Exports are unchanged by collapsing: every point of every line.
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = readFileSync((await csvDl.path())!, 'utf8').trim().split('\r\n');
  expect(csv).toHaveLength(1 + 15);
  expect(new Set(csv.slice(1).map((r) => r.split(',')[0]))).toEqual(new Set(['Line 1', 'Line 2', 'Line 3']));
  await page.getByRole('button', { name: 'Copy as TSV' }).click();
  await expect(page.getByTestId('notice')).toContainText('Copied 15 rows');

  await page.getByRole('button', { name: 'Expand all' }).click();
  for (const name of ['Line 1', 'Line 2', 'Line 3']) expect(await tableRows(page, name)).toHaveLength(5);
  await expect(page.getByRole('button', { name: 'Expand all' })).toBeDisabled();
});

test('selecting a point on the canvas expands its line and scrolls its row into view', async ({ page }) => {
  await openProject(page, 6, 200);
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(lineToggle(page, 'Line 4')).toHaveAttribute('aria-expanded', 'false');

  // Point #151 of Line 4 (index 150): far down a 200-row list. Selecting on the canvas takes
  // the Move points tool (without it the click would place a point).
  await page.getByRole('button', { name: 'Move points' }).click();
  await clickImage(page, 100 + 150 * 3.5, 90 + 3 * 40);
  await expect(lineToggle(page, 'Line 4')).toHaveAttribute('aria-expanded', 'true');
  await expect(lineToggle(page, 'Line 3')).toHaveAttribute('aria-expanded', 'false');
  const row = page.getByTestId('table-Line 4').locator('tbody tr[aria-selected="true"]');
  await expect(row.locator('td').first()).toHaveText('151');
  // Inside the scrolled table (to within a sub-pixel row boundary).
  const rowBox = (await row.boundingBox())!;
  const tablesBox = (await page.getByTestId('data-tables').boundingBox())!;
  expect(rowBox.y).toBeGreaterThanOrEqual(tablesBox.y - 1);
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(tablesBox.y + tablesBox.height + 1);

  // A collapsed line stays collapsed while one of its points is selected.
  await lineToggle(page, 'Line 4').click();
  await expect(lineToggle(page, 'Line 4')).toHaveAttribute('aria-expanded', 'false');
});

test('collapsed lines survive a reload (autosave), as UI state outside the Project', async ({ page }) => {
  await openProject(page, 2, 3);
  await lineToggle(page, 'Line 2').click();
  await expect.poll(async () => (await readAutosave(page))?.collapsed).toEqual(['line-1']);
  await page.reload();
  await expect(lineToggle(page, 'Line 2')).toHaveAttribute('aria-expanded', 'false');
  await expect(lineToggle(page, 'Line 1')).toHaveAttribute('aria-expanded', 'true');
  expect(await tableRows(page, 'Line 1')).toHaveLength(3);
});
