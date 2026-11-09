/**
 * The notice ("Loaded …", "Cropped to … px." with Undo, errors) floats over the bottom of the
 * canvas area as a snackbar (docs/SPEC.md → Notices): it never takes toolbar width, so it stays
 * readable and its buttons clickable however wide the system font is, and the toolbar stays one
 * row. Verdana stands in for the wider DejaVu Sans of the Linux CI runner, where the old in-toolbar
 * notice shrank to ~10 px and the theme toggle covered its Undo button.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToStep, loadViaPicker, openApp } from './helpers.ts';

const WIDE_FONT = 'html, body, button, select, input { font-family: Verdana, "DejaVu Sans", sans-serif !important; }';

type Box = { x: number; y: number; width: number; height: number };
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The element a click at the centre of `l` would reach (what Playwright's "intercepts pointer events" checks). */
async function hitAtCentre(page: Page, l: Locator) {
  const b = await box(l);
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? { tag: el.tagName, testid: el.getAttribute('data-testid'), text: el.textContent?.trim() ?? '' } : null;
  }, [b.x + b.width / 2, b.y + b.height / 2] as const);
}

async function expectReadableSnackbar(page: Page) {
  const notice = page.getByTestId('notice');
  const nb = await box(notice);
  // Over the canvas area: inside the workspace, clear of the toolbar and the side panel.
  expect(inside(nb, await box(page.getByTestId('workspace')))).toBe(true);
  expect(overlaps(nb, await box(page.locator('header.toolbar')))).toBe(false);
  expect(overlaps(nb, await box(page.locator('aside.panel')))).toBe(false);
  // The whole text shows, not an ellipsis.
  const text = notice.locator('.notice-text');
  const fits = await text.evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
  // The text lets clicks through to the canvas; only the buttons catch them.
  expect((await hitAtCentre(page, text))?.testid).toBe('canvas');
  const dismiss = notice.getByRole('button', { name: 'Dismiss' });
  expect((await hitAtCentre(page, dismiss))?.text).toBe('✕');
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.addStyleTag({ content: WIDE_FONT });
});

test('with a wide font at 1366×768 the notice is a readable snackbar, its Undo works, the toolbar stays one row', async ({ page }) => {
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await expectReadableSnackbar(page);
  expect((await box(page.locator('header.toolbar'))).height).toBeLessThan(50);

  await goToStep(page, 'Image');
  await page.getByRole('region', { name: 'Image', exact: true }).getByRole('button', { name: 'Crop…' }).click();
  for (const [name, v] of [['left', 100], ['top', 50], ['width', 400], ['height', 300]] as const) {
    await page.getByTestId(`crop-${name}`).fill(String(v));
  }
  await page.getByTestId('crop-height').press('Enter');
  const notice = page.getByTestId('notice');
  await expect(notice).toContainText('Cropped to 400 × 300 px.');
  await expectReadableSnackbar(page);
  expect((await box(page.locator('header.toolbar'))).height).toBeLessThan(50);

  const undo = notice.getByRole('button', { name: 'Undo' });
  expect((await hitAtCentre(page, undo))?.text).toBe('Undo');
  await undo.click();
  await expect(page.getByTestId('image-current')).toContainText('640 × 480 px');
  await expect(undo).toHaveCount(0);

  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
});
