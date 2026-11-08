import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
