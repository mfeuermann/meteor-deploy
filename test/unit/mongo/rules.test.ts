import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { builtInMongoProblem, judgeVersionChange, releaseSeries } from '../../../src/mongo/rules.js';

/** The `mongo` fixture: one server "one" for the app and for MongoDB. */
function load(): NormalizedConfig {
  const dir = join(import.meta.dirname, '../../fixtures/configs/mongo');
  const { raw, basePath } = loadConfig(dir, './mup.js');
  return normalizeConfig(raw, { basePath });
}

describe('builtInMongoProblem', () => {
  it('is null for one app server that also runs MongoDB', () => {
    expect(builtInMongoProblem(load())).toBeNull();
  });

  it('is null without a mongo section', () => {
    const c = load();
    delete c.mongo;
    expect(builtInMongoProblem(c)).toBeNull();
  });

  it('needs exactly one app server', () => {
    const c = load();
    c.servers.two = { host: '192.0.2.31', username: 'root', password: 'pw' } as any;
    c.app.servers = { one: {}, two: {} };
    expect(builtInMongoProblem(c)).toMatch(/exactly one app server \(the app has 2\)/);
  });

  it('needs MongoDB on the same machine as the app', () => {
    const c = load();
    c.servers.db = { host: '192.0.2.40', username: 'root', password: 'pw' } as any;
    c.mongo!.servers = { db: {} };
    expect(builtInMongoProblem(c)).toMatch(/mongo\.servers "db" is not the same machine as app server "one"/);
  });

  it('counts the same address with another SSH port as another machine', () => {
    const c = load();
    c.servers.db = { ...c.servers.one, opts: { port: 2222 } } as any;
    c.mongo!.servers = { db: {} };
    expect(builtInMongoProblem(c)).toMatch(/not the same machine/);
  });
});

describe('releaseSeries', () => {
  it('reads major.minor from plain versions only', () => {
    expect(releaseSeries('6.0.13')).toBe('6.0');
    expect(releaseSeries('4.4')).toBe('4.4');
    for (const v of ['7', 'latest', '7.0-jammy', '']) expect(releaseSeries(v), v).toBeNull();
  });
});

describe('judgeVersionChange', () => {
  it('passes a first start, the same version and a patch change', () => {
    expect(judgeVersionChange(null, '7.0.14', null)).toEqual({ kind: 'same' });
    expect(judgeVersionChange('7.0.14', '7.0.14', null)).toEqual({ kind: 'same' });
    expect(judgeVersionChange('7.0.14', '7.0.15', null)).toEqual({ kind: 'patch' });
  });

  it('passes one series up when the FCV is the current series', () => {
    expect(judgeVersionChange('6.0.13', '7.0.14', '6.0')).toEqual({ kind: 'upgrade', from: '6.0', to: '7.0' });
    expect(judgeVersionChange('4.4.29', '5.0.31', '4.4')).toEqual({ kind: 'upgrade', from: '4.4', to: '5.0' });
    expect(judgeVersionChange('3.4.24', '3.6.23', '3.4')).toEqual({ kind: 'upgrade', from: '3.4', to: '3.6' });
  });

  it('treats the next major after the last known series as one step', () => {
    expect(judgeVersionChange('8.0.4', '9.0.0', '8.0')).toEqual({ kind: 'upgrade', from: '8.0', to: '9.0' });
  });

  it('refuses one series up with another FCV', () => {
    const v = judgeVersionChange('6.0.13', '7.0.14', '5.0');
    expect(v.kind).toBe('refuse');
    expect((v as { reason: string }).reason).toMatch(/featureCompatibilityVersion is 5\.0/);
  });

  it('refuses one series up when the FCV could not be read', () => {
    const v = judgeVersionChange('6.0.13', '7.0.14', null);
    expect(v.kind).toBe('refuse');
    expect((v as { reason: string }).reason).toMatch(/could not read/i);
  });

  it('refuses a skipped series', () => {
    const v = judgeVersionChange('5.0.31', '7.0.14', '5.0');
    expect(v.kind).toBe('refuse');
    expect((v as { reason: string }).reason).toMatch(/one release series at a time/);
  });

  it('refuses an older series', () => {
    const v = judgeVersionChange('7.0.14', '6.0.13', '7.0');
    expect(v.kind).toBe('refuse');
    expect((v as { reason: string }).reason).toMatch(/older/);
  });

  it('unparseable versions pass with a warning', () => {
    for (const [from, to] of [
      ['7.0.14', 'latest'],
      ['7', '7.0.14'],
      ['7.0.14', '7.3.0'],
    ]) {
      const v = judgeVersionChange(from, to, null);
      expect(v.kind, `${from} → ${to}`).toBe('unknown');
      expect((v as { warning: string }).warning).toMatch(/not checked/);
    }
  });
});
