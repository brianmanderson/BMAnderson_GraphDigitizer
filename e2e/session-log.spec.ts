/**
 * The session log (docs/SPEC.md → Session log): a full session on the real Kaplan–Meier figure —
 * crop, Auto-detect + Accept, Auto-trace + Accept, a point added, nudged and deleted, CSV — then
 * "Download session log". The downloaded JSON must carry the header, consecutive `seq`, a
 * non-decreasing `t`, exactly the expected events (the crop rectangle exact, the nudge one event)
 * with the export of the log itself last, and no image data. Loading another image starts over.
 */

import { readFileSync, statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { clickImage, dropFile, fixturePath, loadViaPicker, openApp } from './helpers.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const FIGURE = 'real/km-pericardial-pao.png';
/** 710 × 691 px; its ink spans columns 2–674 and rows 10–688, so this crop keeps all of it. */
const CROP = { left: 0, top: 6, width: 700, height: 685 };
/** The black series' final plateau (row 186, columns 526–648 of the full figure), in the crop. */
const CURVE = { px: 590, py: 186 - CROP.top };

interface LogEvent {
  seq: number;
  t: number;
  type: string;
  [key: string]: unknown;
}
interface LogFile {
  format: string;
  version: number;
  header: {
    appVersion: string;
    commit: string;
    startedAt: string;
    userAgent: string;
    viewport: { w: number; h: number };
    devicePixelRatio: number;
    imageName: string;
    imageSize: { w: number; h: number; bytes: number };
  };
  events: LogEvent[];
}

/** Click "Download session log" and read the file it downloads. */
async function downloadLog(page: Page): Promise<{ name: string; text: string; log: LogFile }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('session-log').click()]);
  const name = download.suggestedFilename();
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  const text = readFileSync(path, 'utf8');
  return { name, text, log: JSON.parse(text) as LogFile };
}

test('the session log records a full session, ends with its own export and holds no image data; a new image resets it', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('session-log')).toBeDisabled();
  await dropFile(page, FIGURE, 'km-pericardial-pao.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded km-pericardial-pao.png');
  await expect(page.getByTestId('session-log')).toBeEnabled();

  // Crop (toolbar "Crop…" opens the Image step), typed into the panel.
  await page.getByRole('group', { name: 'File' }).getByRole('button', { name: 'Crop…' }).click();
  for (const [field, value] of Object.entries(CROP)) await page.getByTestId(`crop-${field}`).fill(String(value));
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('notice')).toContainText(`Cropped to ${CROP.width} × ${CROP.height} px.`);

  // Auto-detect on the crop, accept.
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Axes/ }).click();
  await page.getByRole('button', { name: 'Auto-detect axes' }).click();
  await expect(page.getByTestId('auto-suggestion')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Accept suggestion' }).click();
  await expect(page.getByTestId('calibration-ok')).toBeVisible();

  // Auto-trace (the Data step's default tool) on the black curve, accept.
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await expect(page.getByTestId('trace-prompt')).toBeVisible();
  await clickImage(page, CURVE.px, CURVE.py);
  await expect(page.getByTestId('trace-count')).toBeVisible({ timeout: 30_000 });
  const traced = Number(await page.getByTestId('trace-count').textContent());
  expect(traced).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);

  // One point by hand, nudged twice with one key (one undo step, one event), then deleted.
  await clickImage(page, 300, 300);
  await expect(page.getByRole('row', { selected: true })).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('row', { selected: true })).toHaveCount(0);

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  expect(csv.suggestedFilename()).toBe('km-pericardial-pao-data.csv');

  const { name, text, log } = await downloadLog(page);
  expect(name).toBe('km-pericardial-pao-session.json');
  expect(log.format).toBe('graph-digitizer-session-log');
  expect(log.version).toBe(1);

  // Header: once, with the right types.
  const h = log.header;
  expect(h.appVersion).toBe(pkg.version);
  expect(h.commit).toMatch(/^([0-9a-f]{40}|unknown)$/);
  expect(new Date(h.startedAt).toISOString()).toBe(h.startedAt);
  expect(typeof h.userAgent).toBe('string');
  expect(h.userAgent.length).toBeGreaterThan(0);
  expect(h.viewport).toEqual({ w: 1366, h: 768 });
  expect(typeof h.devicePixelRatio).toBe('number');
  expect(h.devicePixelRatio).toBeGreaterThan(0);
  expect(h.imageName).toBe('km-pericardial-pao.png');
  expect(h.imageSize).toEqual({ w: 710, h: 691, bytes: statSync(fixturePath(FIGURE)).size });

  // Sequence and clock.
  const events = log.events;
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  for (let i = 1; i < events.length; i++) expect(events[i]!.t).toBeGreaterThanOrEqual(events[i - 1]!.t);
  expect(events[0]!.t).toBe(0);

  // Exactly these events, in this order.
  expect(events.map((e) => e.type)).toEqual([
    'image-loaded',
    'crop',
    'auto-detect-run',
    'suggestion-accepted',
    'trace-run',
    'trace-accepted',
    'points-added',
    'points-moved',
    'points-deleted',
    'export',
    'export',
  ]);
  const [loaded, crop, detect, accepted, run, traceAccepted, added, moved, deleted, csvExport, logExport] = events;
  expect(loaded).toMatchObject({ source: 'image' });
  expect(crop!.rect).toEqual({ x0: CROP.left, y0: CROP.top, x1: CROP.left + CROP.width, y1: CROP.top + CROP.height });
  expect(detect).toMatchObject({ outcome: 'suggested', axesSuggested: ['x', 'y'] });
  expect(detect!.durationMs).toBeGreaterThan(0);
  expect(detect!.labelsRead).toBeGreaterThan(0);
  expect(accepted).toMatchObject({ editedFields: [] });
  expect(run).toMatchObject({ mode: 'auto', kind: 'curve', outcome: 'ok', pointCount: traced });
  // The seed is the clicked image position (sub-pixel; a click lands within ~0.5 CSS px, < 1 image px at the fitted zoom).
  const seed = run!.seedPx as { x: number; y: number };
  expect(Math.abs(seed.x - CURVE.px)).toBeLessThanOrEqual(1);
  expect(Math.abs(seed.y - CURVE.py)).toBeLessThanOrEqual(1);
  const line = run!.datasetId as string;
  expect(typeof line).toBe('string');
  expect(traceAccepted).toMatchObject({ datasetId: line, pointCount: traced });
  expect(added).toMatchObject({ datasetId: line, count: 1, source: 'hand' });
  expect(moved).toMatchObject({ datasetId: line, count: 1, source: 'nudge' });
  expect(deleted).toMatchObject({ datasetId: line, count: 1 });
  expect(csvExport).toMatchObject({ kind: 'csv', filename: 'km-pericardial-pao-data.csv' });
  expect(logExport).toMatchObject({ kind: 'session-log', filename: 'km-pericardial-pao-session.json' });

  // No image data of any kind.
  expect(text).not.toMatch(/data:/i);
  expect(text).not.toMatch(/base64/i);
  expect(text).not.toMatch(/[A-Za-z0-9+/]{100,}/);
  expect(text).not.toMatch(/"(image|dataUrl)":/);

  // Another image: a new log with only its load and this export.
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const next = await downloadLog(page);
  expect(next.name).toBe('synthetic-linear-session.json');
  expect(next.log.header.imageName).toBe('synthetic-linear.png');
  expect(next.log.events.map((e) => [e.seq, e.type])).toEqual([
    [0, 'image-loaded'],
    [1, 'export'],
  ]);
  expect(new Date(next.log.header.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(h.startedAt).getTime());
});

test('Start over is logged as `start-over` with what was cleared; the log stays downloadable until the next load', async ({ page }) => {
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await page.getByRole('group', { name: 'File' }).getByRole('button', { name: 'Start over' }).click();
  await page.getByTestId('start-over-dialog').getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByText('Drop a chart image here')).toBeVisible();

  await expect(page.getByTestId('session-log')).toBeEnabled();
  const { name, log } = await downloadLog(page);
  expect(name).toBe('synthetic-linear-session.json');
  expect(log.events.map((e) => [e.seq, e.type])).toEqual([
    [0, 'image-loaded'],
    [1, 'start-over'],
    [2, 'export'],
  ]);
  expect(log.events[1]).toMatchObject({ lines: 1, points: 0 });

  // The next image starts a new log.
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  const next = await downloadLog(page);
  expect(next.log.events.map((e) => e.type)).toEqual(['image-loaded', 'export']);
});
