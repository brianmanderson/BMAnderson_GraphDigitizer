import { expect, test } from '@playwright/test';
import { openApp, pasteFile } from './helpers.ts';

test('rejects non-images with a clear message; accepts a pasted image', async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId('file-input');

  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a chart') });
  await expect(page.getByTestId('notice')).toContainText('"notes.txt" (text/plain) is not an image');

  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('definitely not png bytes') });
  await expect(page.getByTestId('notice')).toContainText('"broken.png" could not be read as an image');
  // Nothing was loaded, so the later steps stay locked.
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /Axes/ })).toBeDisabled();

  await pasteFile(page, 'synthetic/synthetic-linear.png', 'image.png', 'image/png');
  await expect(page.getByTestId('notice')).toContainText('Loaded image.png (640 × 480 px)');
  await expect(page.getByTestId('axes-prompt')).toContainText('(X1)');
});
