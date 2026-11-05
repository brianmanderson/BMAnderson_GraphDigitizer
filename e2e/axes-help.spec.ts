/**
 * Axes step for first-time users: the "How to place axis points" help opens and closes (Esc and
 * Close, focus back on the button), and "Auto-detect axes" sits below the refs list as a call to
 * action until a calibration is valid.
 */

import { expect, test } from '@playwright/test';
import { calibrate, loadViaPicker, openApp, readFixtureJson, type SyntheticTruth } from './helpers.ts';

const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
const tick = <T extends { value: number | string }>(ticks: T[], value: number) => ticks.find((t) => t.value === value)!;

test('help panel opens with its diagrams and closes with Esc or Close', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');

  const help = page.getByRole('button', { name: 'How to place axis points' });
  const panel = page.getByRole('dialog', { name: 'How to place axis points' });
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);

  await help.click();
  await expect(panel).toBeVisible();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('img')).toHaveCount(2);
  await expect(panel).toContainText('2024-03-15');
  await expect(panel.getByRole('button', { name: 'Close' })).toBeFocused();

  // Esc closes the help only: placing X1 is still pending.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(help).toBeFocused();
  await expect(page.getByTestId('axes-prompt')).toContainText('(X1)');

  await help.click();
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await expect(help).toBeFocused();
});

test('Auto-detect axes comes after the refs list and is a call to action until calibrated', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');

  const detect = page.getByRole('button', { name: 'Auto-detect axes' });
  // Enabled once the image is decoded; clicks on the canvas before that place nothing.
  await expect(detect).toBeEnabled();
  const refs = page.getByRole('region', { name: 'Axes' }).locator('ul.refs');
  const after = await refs.evaluate(
    (list, button) => !!(list.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING),
    await detect.elementHandle(),
  );
  expect(after).toBe(true);
  await expect(detect).toHaveClass(/\bcta\b/);
  const box = (await detect.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);

  const row = truth.xAxis.axisLineRow;
  const col = truth.yAxis.axisLineCol;
  await calibrate(page, {
    X1: { px: col, py: row, value: '0' },
    X2: { px: tick(truth.xAxis.ticks, 10).px, py: row, value: '10' },
    Y1: { px: col, py: row, value: '0' },
    Y2: { px: col, py: tick(truth.yAxis.ticks, 100).py, value: '100' },
  });
  await expect(page.getByTestId('calibration-ok')).toBeVisible();
  await expect(detect).not.toHaveClass(/\bcta\b/);
});
