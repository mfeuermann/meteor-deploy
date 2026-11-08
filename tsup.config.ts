import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/main': 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
