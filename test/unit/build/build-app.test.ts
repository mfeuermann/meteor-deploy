import { describe, expect, it } from 'vitest';
import { buildApp, prepareBundleSupported } from '../../../src/build/index.js';
import type { CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';

describe('prepareBundleSupported', () => {
  it('follows MUP: zodern/meteor and abernix/meteord, or an explicit prepareBundle', () => {
    expect(prepareBundleSupported({ image: 'zodern/meteor:root' })).toBe(true);
    expect(prepareBundleSupported({ image: 'abernix/meteord:node-12-base' })).toBe(true);
    expect(prepareBundleSupported({ image: 'kadirahq/meteord' })).toBe(false);
    expect(prepareBundleSupported({ image: 'my/custom', prepareBundle: true })).toBe(true);
    expect(prepareBundleSupported({ image: 'zodern/meteor', prepareBundle: false })).toBe(false);
  });
});

describe('buildApp', () => {
  it('refuses images without prepare-bundle support (bundle mode is phase 2)', async () => {
    const ctx = { config: { app: { docker: { image: 'kadirahq/meteord' } } }, reporter: {} } as unknown as CommandContext;
    const p = buildApp(ctx, { platforms: ['linux/amd64'], version: '20261107-183005', cachedBuild: false, forceBuild: false });
    await expect(p).rejects.toThrow(CometError);
    await expect(buildApp(ctx, { platforms: ['linux/amd64'], version: 'v', cachedBuild: false, forceBuild: false })).rejects.toThrow(/phase 2/);
  });
});
