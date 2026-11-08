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
    expect(s).toContain('https://x.com');
    expect(s).toContain('mongodb://u:p@db/x');
    expect(s).toContain('8080');
    expect(s).toContain('true');
    expect(s).toContain('per-server-token');
    expect(s).toContain('serverpass');
    expect(s).toContain(JSON.stringify({ private: { k: 'v' } }));
    expect(s).not.toContain('ab');
  });
});
