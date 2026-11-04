import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // A DST-observing zone, so date tests prove the engine ignores the host time zone.
    env: { TZ: 'America/New_York' },
  },
});
