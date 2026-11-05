/**
 * Light/dark theme: the first load follows the OS preference, the toolbar toggle switches
 * instantly and its choice survives a reload, and the Auto-detect call to action keeps the same
 * light-green fill in both themes.
 */

import { expect, test, type Page } from '@playwright/test';
import { loadViaPicker, openApp } from './helpers.ts';

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const background = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);

test('first load follows the OS; the toggle switches and its choice wins after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  // The toggle is named after the theme a click switches to.
  const toLight = page.getByRole('button', { name: 'Light theme', exact: true });
  const toDark = page.getByRole('button', { name: 'Dark theme', exact: true });
  expect(await theme(page)).toBe('dark');
  await expect(toLight).toBeVisible();
  await expect(toDark).toHaveCount(0);
  const darkPage = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  await toLight.click();
  expect(await theme(page)).toBe('light');
  await expect(toDark).toBeVisible();
  await expect(toLight).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe(darkPage);

  // The OS still prefers dark, but the saved choice wins.
  await page.reload();
  await expect(page.getByText('Drop a chart image here')).toBeVisible();
  expect(await theme(page)).toBe('light');
  await expect(toDark).toBeVisible();

  await toDark.click();
  await page.reload();
  await expect(toLight).toBeVisible();
  expect(await theme(page)).toBe('dark');
});

test('the Auto-detect call to action is the same light green in both themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const detect = page.getByRole('button', { name: 'Auto-detect axes' });
  await expect(detect).toBeEnabled();
  await expect(detect).toHaveClass(/\bcta\b/);

  const light = await background(page, 'Auto-detect axes');
  const lightPanel = await page.getByRole('region', { name: 'Axes' }).evaluate((el) => getComputedStyle(el.closest('.panel')!).backgroundColor);
  await page.getByRole('button', { name: 'Dark theme' }).click();
  expect(await theme(page)).toBe('dark');
  const darkPanel = await page.getByRole('region', { name: 'Axes' }).evaluate((el) => getComputedStyle(el.closest('.panel')!).backgroundColor);
  expect(darkPanel).not.toBe(lightPanel);
  expect(await background(page, 'Auto-detect axes')).toBe(light);
  expect(light).toBe('rgb(211, 249, 216)');
});
