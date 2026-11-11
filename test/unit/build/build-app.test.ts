import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildApp, hashExclusions, hashExtras, prepareBundleSupported } from '../../../src/build/index.js';
import type { AppConfig } from '../../../src/config/types.js';
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

describe('hashExtras', () => {
  const app = (env: Record<string, string>, buildInstructions: string[] = ['RUN echo "$API_HOST" > /built_app/api']) =>
    ({ buildOptions: { serverOnly: true }, docker: { image: 'zodern/meteor:root', buildInstructions }, env }) as unknown as AppConfig;

  it('changes when an env value that a build instruction uses changes', () => {
    expect(hashExtras(app({ API_HOST: 'a' }), 'linux/amd64')).not.toEqual(hashExtras(app({ API_HOST: 'b' }), 'linux/amd64'));
  });

  it('ignores env values no build instruction uses', () => {
    expect(hashExtras(app({ API_HOST: 'a', MONGO_URL: 'x' }), 'linux/amd64')).toEqual(hashExtras(app({ API_HOST: 'a', MONGO_URL: 'y' }), 'linux/amd64'));
  });

  it('keeps the build-arg values out of the cache state (only a digest)', () => {
    expect(JSON.stringify(hashExtras(app({ API_HOST: 'very-secret-value' }), 'linux/amd64'))).not.toContain('very-secret-value');
  });
});

describe('hashExclusions', () => {
  const a = '/home/u/myapp';
  it('leaves out the build location and a config directory whose path starts with a dot directory', () => {
    expect(hashExclusions(a, join(a, '.deploy'), '/tmp/build')).toEqual(['/tmp/build', join(a, '.deploy')]);
  });

  it('keeps a config directory Meteor would bundle or load, and the app root', () => {
    expect(hashExclusions(a, join(a, 'deploy'), '/tmp/build')).toEqual(['/tmp/build']);
    expect(hashExclusions(a, join(a, 'private/deploy'), '/tmp/build')).toEqual(['/tmp/build']);
    expect(hashExclusions(a, a, '/tmp/build')).toEqual(['/tmp/build']);
  });
});
