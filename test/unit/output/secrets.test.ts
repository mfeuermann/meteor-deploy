import { describe, expect, it } from 'vitest';
import { collectSecrets, maskSecrets } from '../../../src/output/secrets.js';
import type { NormalizedConfig } from '../../../src/config/types.js';

describe('maskSecrets', () => {
  it('masks longest secrets first', () => {
    expect(maskSecrets('mongodb://u:p4ss@h/db and p4ss', ['p4ss', 'mongodb://u:p4ss@h/db'])).toBe('*** and ***');
  });

  it('ignores empty and too-short secrets', () => {
    expect(maskSecrets('ab cd', ['ab', ''])).toBe('ab cd');
  });

  it('masks every occurrence including regex metacharacters', () => {
    expect(maskSecrets('a.b*c a.b*c', ['a.b*c'])).toBe('*** ***');
  });
});

describe('collectSecrets', () => {
  const config = {
    servers: { one: { host: 'h', username: 'root', password: 'serverpass' }, two: { host: 'h2', username: 'u' } },
    app: {
      name: 'app',
      path: '../',
      type: 'meteor',
      env: { ROOT_URL: 'https://x.com', MONGO_URL: 'mongodb://u:p@db/x', PORT: 8080, FLAG: true, AB: 'ab' },
      servers: { one: { env: { TOKEN: 'per-server-token' } }, two: {} },
      docker: { image: 'zodern/meteor', imagePort: 3000 },
      buildOptions: { buildLocation: '/tmp/x' },
    },
  } as unknown as NormalizedConfig;

  it('collects env values, per-server env, passwords and settings JSON', () => {
    const s = collectSecrets(config, { private: { k: 'v' } });
    expect(s).toContain('mongodb://u:p@db/x');
    expect(s).toContain('per-server-token');
    expect(s).toContain('serverpass');
    expect(s).toContain(JSON.stringify({ private: { k: 'v' } }));
    expect(s).not.toContain('ab');
  });

  it('does not treat public URLs, ports and plain numbers/booleans as secrets', () => {
    const s = collectSecrets(config);
    expect(s).not.toContain('https://x.com');
    expect(s).not.toContain('8080');
    expect(s).not.toContain('true');
    const c2 = { ...config, app: { ...config.app, env: { STR_NUM: '12345', STR_BOOL: 'false', API_KEY: 'k-12345678' } } } as unknown as NormalizedConfig;
    const s2 = collectSecrets(c2);
    expect(s2).toContain('k-12345678');
    expect(s2).not.toContain('12345');
    expect(s2).not.toContain('false');
  });

  it('collects non-public settings string values of 8+ characters', () => {
    const settings = { public: { siteName: 'public-site-name' }, private: { token: 'example-token-123', short: 'abc', nested: [{ pw: 'nested-password' }] } };
    const s = collectSecrets(config, settings);
    expect(s).toContain('example-token-123');
    expect(s).toContain('nested-password');
    expect(s).not.toContain('public-site-name');
    expect(s).not.toContain('abc');
  });
});
