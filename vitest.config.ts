import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['src/hooks/__tests__/**', 'happy-dom'],
      ['src/components/**/__tests__/**', 'happy-dom'],
    ],
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});
