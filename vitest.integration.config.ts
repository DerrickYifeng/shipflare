import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    sequence: { concurrent: false },
    setupFiles: ['./tests/integration/bullmq.setup.ts'],
  },
  resolve: { alias: { '@': resolve(__dirname, './src') } },
});
