import { expect, test, type Page } from '@playwright/test';
import {
  dropFile,
  goToStep,
  imageToClient,
  kmTruth,
  loadAndCalibrateKm,
  loadViaPicker,
  loupeState,
  openApp,
  readFixtureJson,
  tableRows,
  type SyntheticTruth,
} from './helpers.ts';

const plateauRow = kmTruth.knownValues[0]!.py!;

/** Pixel columns of the first row of a dataset table, as numbers. */
async function firstPixel(page: Page, dataset = 'Dataset 1') {
  const [row] = await tableRows(page, dataset);
  return row ? { px: Number(row[3]), py: Number(row[4]) } : null;
}

test('loupe follows the cursor; a point placed with it nudges with the arrow keys and undoes', async ({ page }) => {
  await openApp(page);
  await loadAndCalibrateKm(page);
  await page.getByRole('button', { name: 'Continue to Data' }).click();
  await page.getByLabel('Pixel columns').check();
  const loupe = page.getByTestId('loupe');
  await expect(loupe).toHaveCount(0);

  // Over the image the loupe shows the pixel under the cursor, top-left by default…
  const at = await imageToClient(page, 400, plateauRow);
  await page.mouse.move(at.x, at.y);
  await expect(loupe).toBeVisible();
  await expect(page.getByTestId('loupe-pixel')).toHaveText(`pixel (400, ${plateauRow})`);
  let state = await loupeState(page);
  expect(state.corner).toBe('top-left');
  expect(Math.abs(state.px - 400)).toBeLessThanOrEqual(0.4);
  expect(Math.abs(state.py - plateauRow)).toBeLessThanOrEqual(0.4);

  // …and flips to the opposite corner when the cursor would be under it.
  const nearCorner = await imageToClient(page, 100, 40);
  await page.mouse.move(nearCorner.x, nearCorner.y);
  await expect(loupe).toHaveAttribute('data-corner', 'top-right');

  // Place the point with the loupe, then nudge it: 1 px, Shift 10 px, Alt 0.1 px.
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  expect(await tableRows(page)).toHaveLength(1);
  const placed = (await firstPixel(page))!;
  expect(Math.abs(placed.px - 400)).toBeLessThanOrEqual(0.45);

  await page.keyboard.press('ArrowRight');
  // While nudging, the loupe shows the selected point (exact position in its data attributes).
  state = await loupeState(page);
  const p0 = { px: state.px - 1, py: state.py };
  expect(Math.abs(p0.px - placed.px)).toBeLessThanOrEqual(0.05);
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await loupeState(page)).py).toBeCloseTo(p0.py - 10, 6);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => (await loupeState(page)).px).toBeCloseTo(p0.px + 0.9, 6);
  // Alt+Left must not have navigated the browser back.
  await expect(page.getByTestId('table-Dataset 1')).toBeVisible();
  const moved = (await firstPixel(page))!;
  expect(moved.px).toBeCloseTo(p0.px + 0.9, 1);
  expect(moved.py).toBeCloseTo(p0.py - 10, 1);
  // The table's y value follows (y = 0.162 at the plateau; 10 px up is +10/307.5 of the axis).
  const y = Number((await tableRows(page))[0]![2]);
  expect(Math.abs(y - (0.162 + 10 / 307.5))).toBeLessThanOrEqual(0.006);

  // Each run of the same key is one undo step: Alt←, Shift↑, →, then the placement itself.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await loupeState(page)).px).toBeCloseTo(p0.px + 1, 6);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await loupeState(page)).py).toBeCloseTo(p0.py, 6);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await loupeState(page)).px).toBeCloseTo(p0.px, 6);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await tableRows(page)).length).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await tableRows(page)).length).toBe(1);

  // Holding a key nudges repeatedly but undoes in one step.
  await page.getByTestId('table-Dataset 1').locator('tbody tr').first().click();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await firstPixel(page))!.py).toBeCloseTo(p0.py + 5, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await firstPixel(page))!.py).toBeCloseTo(p0.py, 1);

  // Z toggles the loupe; so does the toolbar button. The zoom setting changes its magnification.
  await page.mouse.move(at.x + 30, at.y);
  await expect(loupe).toBeVisible();
  await page.keyboard.press('z');
  await expect(loupe).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Loupe' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Loupe' }).click();
  await page.getByLabel('Loupe zoom').selectOption('12');
  await page.mouse.move(at.x + 30, at.y);
  const scale = await page.getByTestId('canvas').evaluate((el) => Number((el as HTMLElement).dataset.scale));
  await expect(loupe).toHaveAttribute('data-cell', String(Math.round(scale * 12)));
});

test.describe('on a 2× (high-DPI) display', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the loupe copies source pixels exactly at several main-view and loupe zooms', async ({ page }) => {
    await openApp(page);
    await dropFile(page, 'real/km-pericardial-effusion.jpg', 'km-pericardial-effusion.jpg', 'image/jpeg');
    await expect(page.getByTestId('notice')).toContainText('Loaded');
    await goToStep(page, 'Data');
    const loupe = page.getByTestId('loupe');

    // The curve's first riser area: dark and light pixels side by side.
    const target = { px: 230.3, py: 322.6 };
    const check = async (label: string) => {
      const at = await imageToClient(page, target.px, target.py);
      await page.mouse.move(at.x, at.y);
      await expect(loupe).toBeVisible();
      const result = await page.evaluate(async () => {
        const el = document.querySelector<HTMLElement>('[data-testid=loupe]')!;
        const canvas = el.querySelector('canvas')!;
        const { cell, originX, originY, px, py } = el.dataset;
        const img = new Image();
        img.src = '/fixtures/real/km-pericardial-effusion.jpg';
        await img.decode();
        const src = document.createElement('canvas');
        src.width = img.naturalWidth;
        src.height = img.naturalHeight;
        const sctx = src.getContext('2d')!;
        sctx.drawImage(img, 0, 0);
        const source = sctx.getImageData(0, 0, src.width, src.height);
        const shown = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        const c = Number(cell);
        const ci = Math.round(Number(px));
        const cj = Math.round(Number(py));
        let compared = 0;
        const mismatches: string[] = [];
        // Texels two or more away from the centre: clear of the crosshair and the pixel outline.
        for (const dj of [-3, -2, 2, 3]) {
          for (const di of [-3, -2, 2, 3]) {
            const i = ci + di;
            const j = cj + dj;
            const k = (j * source.width + i) * 4;
            for (let y = Number(originY) + j * c; y < Number(originY) + (j + 1) * c; y++) {
              for (let x = Number(originX) + i * c; x < Number(originX) + (i + 1) * c; x++) {
                if (x < 0 || y < 0 || x >= shown.width || y >= shown.height) continue;
                const m = (y * shown.width + x) * 4;
                compared++;
                for (let ch = 0; ch < 4; ch++) {
                  if (shown.data[m + ch] !== source.data[k + ch]) mismatches.push(`texel ${i},${j} at device ${x},${y}`);
                }
              }
            }
          }
        }
        return { width: canvas.width, cssWidth: canvas.getBoundingClientRect().width, cell: c, compared, mismatches: mismatches.slice(0, 5) };
      });
      const scale = await page.getByTestId('canvas').evaluate((el) => Number((el as HTMLElement).dataset.scale));
      const zoom = Number(await page.getByLabel('Loupe zoom').inputValue());
      expect(result.width, label).toBe(360);
      expect(result.cssWidth, label).toBe(180);
      expect(result.cell, label).toBe(Math.max(1, Math.min(72, Math.round(scale * zoom * 2))));
      expect(result.compared, label).toBeGreaterThan(0);
      expect(result.mismatches, label).toEqual([]);
    };

    await check('fit, 6×');
    await page.getByLabel('Loupe zoom').selectOption('2');
    await check('fit, 2×');
    await page.getByLabel('Loupe zoom').selectOption('16');
    await check('fit, 16×');
    // Zoom the main view in about the target (wheel), then far in.
    await page.getByLabel('Loupe zoom').selectOption('6');
    for (const [label, ticks] of [
      ['main view ~3×', 1],
      ['main view ~13×', 2],
    ] as const) {
      const at = await imageToClient(page, target.px, target.py);
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < ticks; i++) await page.mouse.wheel(0, -500);
      await check(label);
    }
  });
});

test('snap puts points on marker centres, and leaves points on a line where they are', async ({ page }) => {
  const truth = readFixtureJson<SyntheticTruth>('synthetic/synthetic-linear.json');
  await openApp(page);
  await loadViaPicker(page, 'synthetic/synthetic-linear.png');
  await goToStep(page, 'Data');
  await page.getByLabel('Pixel columns').check();
  const snap = page.getByRole('button', { name: 'Snap' });
  await expect(snap).toHaveAttribute('aria-pressed', 'false'); // off by default
  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'true');

  // Clicks 2–3 px off each marker; the loupe shows the snap target before the click commits it.
  const offsets = [
    [2.5, -2],
    [-3, 1.5],
    [2, 2.5],
    [-2.5, -2.5],
    [3, 0],
  ];
  for (const [i, p] of truth.points.entries()) {
    const [dx, dy] = offsets[i % offsets.length]!;
    const at = await imageToClient(page, p.px + dx!, p.py + dy!);
    await page.mouse.move(at.x, at.y);
    await expect(page.getByTestId('loupe')).toHaveAttribute('data-snap-px');
    const preview = (await loupeState(page)).snap!;
    expect(Math.hypot(preview.px - p.px, preview.py - p.py), `preview ${i + 1}`).toBeLessThanOrEqual(0.25);
    await page.mouse.click(at.x, at.y);
  }
  const rows = await tableRows(page);
  expect(rows).toHaveLength(truth.points.length);
  truth.points.forEach((p, i) => {
    // Pixel columns show one decimal: 0.25 px snap error + 0.05 rounding.
    expect(Math.abs(Number(rows[i]![3]) - p.px), `point ${i + 1} px`).toBeLessThanOrEqual(0.3);
    expect(Math.abs(Number(rows[i]![4]) - p.py), `point ${i + 1} py`).toBeLessThanOrEqual(0.3);
  });

  // The Kaplan–Meier step line carries '+' censoring marks of its own colour: hovering anywhere
  // along the plateau offers no snap, so a click lands exactly where it would without snapping.
  await dropFile(page, 'real/km-pericardial-effusion.jpg', 'km-pericardial-effusion.jpg', 'image/jpeg');
  await expect(page.getByTestId('notice')).toContainText('Loaded km-pericardial-effusion.jpg');
  await goToStep(page, 'Data');
  for (let px = 300; px <= 560; px += 20) {
    const at = await imageToClient(page, px, plateauRow);
    await page.mouse.move(at.x, at.y);
    await expect(page.getByTestId('loupe')).toBeVisible();
    expect((await loupeState(page)).snap, `plateau at px ${px}`).toBeNull();
  }
  const at = await imageToClient(page, 400, plateauRow);
  await page.mouse.click(at.x, at.y);
  const placed = (await firstPixel(page))!;
  expect(Math.abs(placed.px - 400)).toBeLessThanOrEqual(0.45);
  expect(Math.abs(placed.py - plateauRow)).toBeLessThanOrEqual(0.45);
});
