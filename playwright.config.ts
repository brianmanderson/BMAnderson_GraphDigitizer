import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the Vite dev server on its own port (5174), so a dev server you
// have open on 5173 doesn't interfere. Chromium only; run `npx playwright install chromium` once.
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 768 },
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Never reuse a server by default: one already on the port may belong to another checkout
    // (the suite would test its code) or stop mid-run (every open page reloads). With
    // --strictPort a busy port then fails the run at once. E2E_REUSE=1 opts back in.
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 60_000,
  },
});
