import { describe, expect, it } from 'vitest';
import { collectSecrets, maskSecrets } from '../../../src/output/secrets.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { createContext } from '../../../src/core/context.js';
import { createReporter } from '../../../src/output/reporter.js';
import { tempDir } from '../../helpers/fs.js';

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

describe('secrets that were never masked (M7)', () => {
  it('collects the SSH key passphrase and the per-server settings', () => {
    const config = {
      servers: { one: { host: 'h', username: 'root', pem: '~/.ssh/id', opts: { passphrase: 'my-key-passphrase' } } },
      app: { name: 'app', env: {}, servers: { one: { settings: 'one.json' } } },
    } as unknown as NormalizedConfig;
    const s = collectSecrets(config, { public: {} }, [{ private: { token: 'per-server-token-1' } }]);
    expect(s).toContain('my-key-passphrase');
    expect(s).toContain('per-server-token-1');
    expect(s).toContain(JSON.stringify({ private: { token: 'per-server-token-1' } }));
  });

  it('masks per-server settings once the settings are loaded', async () => {
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = {
        servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw-one' } },
        app: { name: 'myapp', path: '../app', servers: { one: { settings: '.deploy/one.json' } }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
      };`,
      '.deploy/settings.json': '{"public":{}}',
      '.deploy/one.json': '{"private":{"token":"per-server-token-2"}}',
    });
    const ctx = await createContext({ config: '.deploy/mup.js' }, { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
    ctx.getSettings();
    expect(ctx.reporter.mask('token per-server-token-2 here')).toBe('token *** here');
  });

  it('loads only the per-server settings of the servers selected with --servers', async () => {
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = {
        servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' }, staging: { host: '192.0.2.2', username: 'root', password: 'pw' } },
        app: { name: 'myapp', path: '../app', servers: { one: { settings: '.deploy/one.json' }, staging: { settings: '.deploy/staging.json' } }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
      };`,
      '.deploy/settings.json': '{"public":{}}',
      '.deploy/one.json': '{"private":{"token":"per-server-token-3"}}',
      // .deploy/staging.json does not exist on this machine
    });
    const ctx = await createContext({ config: '.deploy/mup.js', servers: 'one' }, { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
    expect(() => ctx.getSettings()).not.toThrow();
    expect(ctx.reporter.mask('per-server-token-3')).toBe('***');
  });

  it('keeps failing when a per-server settings file is missing, also on a second call', async () => {
    const dir = tempDir({
      '.deploy/mup.js': `module.exports = {
        servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
        app: { name: 'myapp', path: '../app', servers: { one: { settings: '.deploy/one.json' } }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
      };`,
      '.deploy/settings.json': '{"public":{}}',
    });
    const ctx = await createContext({ config: '.deploy/mup.js' }, { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }) });
    expect(() => ctx.getSettings()).toThrow(/one\.json/);
    expect(() => ctx.getSettings()).toThrow(/one\.json/);
  });

  it('masks the settings for commands that do not use them (logs, restart, rollback), without failing on a missing file', async () => {
    const files = {
      '.deploy/mup.js': `module.exports = {
        servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
        app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
      };`,
    };
    const reporter = () => createReporter({ verbose: false, tty: false, write: () => {} });
    const dir = tempDir({ ...files, '.deploy/settings.json': '{"private":{"apiKey":"settings-api-key-1"}}' });
    const ctx = await createContext({ config: '.deploy/mup.js' }, { cwd: dir, reporter: reporter() });
    ctx.maskSettings();
    expect(ctx.reporter.mask('key settings-api-key-1')).toBe('key ***');

    const missing = await createContext({ config: '.deploy/mup.js', settings: 'nope.json' }, { cwd: tempDir(files), reporter: reporter() });
    expect(() => missing.maskSettings()).not.toThrow();
    expect(() => missing.getSettings()).toThrow();
  });
});
