import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // Some unit tests run real processes (bash scripts against stub commands, a stub meteor and
    // docker). On a busy machine their first runs take seconds, so 5 s cut them off; a test that
    // really hangs still fails.
    testTimeout: 20_000,
  },
});
