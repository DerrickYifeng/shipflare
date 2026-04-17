import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest 4 removed `environmentMatchGlobs` in favour of per-file
 * `// @vitest-environment happy-dom` directives (or projects). Hook and
 * component tests should add that directive at the top of the file; the
 * rest of the suite runs in `node`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});
