import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { DEFAULT_COMET_OPTIONS, normalizeConfig } from '../../../src/config/normalize.js';
import { mupNormalize } from '../../oracle/mup-oracle.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/configs');
const NAMES = ['aaa-like', 'per-server-env', 'mongo', 'proxy-lb', 'registry', 'legacy-docker-image', 'upper-dot-name'];

function ours(name: string) {
  const cwd = join(FIXTURES, name);
  const loaded = loadConfig(cwd, join(cwd, 'mup.js'));
  return normalizeConfig(loaded.raw, { basePath: loaded.basePath });
}

function withoutComet(c: Record<string, any>) {
  const { cometDeploy: _c, ...rest } = c;
  return JSON.parse(JSON.stringify(rest));
}

describe('normalizeConfig matches MUP 1.5.11', () => {
  it.each(NAMES)('%s', async (name) => {
    const expected = await mupNormalize(join(FIXTURES, name, 'mup.js'));
    expect(withoutComet(ours(name))).toEqual(expected);
  });

  it('keeps env key insertion order identical to MUP (affects env.list)', async () => {
    for (const name of [...NAMES, 'proxy-le']) {
      const expected = await mupNormalize(join(FIXTURES, name, 'mup.js'));
      expect(Object.keys(ours(name).app.env)).toEqual(Object.keys(expected.app.env));
    }
  });

  it('fixes the ROOT_URL https rewrite so the port survives (MUP drops the colon)', async () => {
    const expected = await mupNormalize(join(FIXTURES, 'proxy-le', 'mup.js'));
    expect(expected.app.env.ROOT_URL).toBe('https://a.com3000');
    const result = ours('proxy-le');
    expect(result.app.env.ROOT_URL).toBe('https://a.com:3000');
    expect(withoutComet({ ...result, app: { ...result.app, env: { ...result.app.env, ROOT_URL: 'x' } } })).toEqual({
      ...expected,
      app: { ...expected.app, env: { ...expected.app.env, ROOT_URL: 'x' } },
    });
  });

  it('fills cometDeploy defaults', () => {
    expect(ours('aaa-like').cometDeploy).toEqual({
      strategy: 'canary',
      transfer: 'auto',
      platform: 'auto',
      keepVersions: 5,
      zeroDowntime: true,
      healthCheck: { path: '/', maxStatus: 499 },
      lock: true,
    });
    expect(DEFAULT_COMET_OPTIONS.strategy).toBe('canary');
  });

  it('merges partial cometDeploy with defaults', () => {
    const c = normalizeConfig(
      { servers: {}, app: { name: 'a', path: '.', servers: {}, env: { ROOT_URL: 'http://x' } }, cometDeploy: { strategy: 'rolling', healthCheck: { path: '/hc' } } },
      { basePath: '/tmp' },
    );
    expect(c.cometDeploy.strategy).toBe('rolling');
    expect(c.cometDeploy.healthCheck).toEqual({ path: '/hc', maxStatus: 499 });
    expect(c.cometDeploy.keepVersions).toBe(5);
  });

  it('does not mutate the raw config', () => {
    const raw = { servers: {}, meteor: { name: 'a', path: '.', servers: {}, env: { ROOT_URL: 'http://x' }, dockerImage: 'zodern/meteor' } };
    const copy = JSON.parse(JSON.stringify(raw));
    normalizeConfig(raw, { basePath: '/tmp' });
    expect(raw).toEqual(copy);
  });
});
