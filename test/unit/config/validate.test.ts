import { join } from 'node:path';
import cloneDeep from 'lodash/cloneDeep.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { RawConfig } from '../../../src/config/types.js';
import { hasFatal, validateConfig, type Issue } from '../../../src/config/validate.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/configs');

function base(): RawConfig {
  return {
    servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
    app: {
      name: 'app',
      path: '../app',
      servers: { one: {} },
      env: { ROOT_URL: 'https://app.example.com', MONGO_URL: 'mongodb://db.example.com/app' },
      docker: { image: 'zodern/meteor' },
    },
  };
}

function check(mutate: (c: RawConfig) => void): Issue[] {
  const raw = base();
  mutate(raw);
  return validateConfig(normalizeConfig(raw, { basePath: '/tmp/cfg' }), raw);
}

function find(issues: Issue[], path: string) {
  return issues.find((i) => i.path === path);
}

describe('validateConfig', () => {
  it('accepts the aaa-like fixture without issues', () => {
    const cwd = join(FIXTURES, 'aaa-like');
    const l = loadConfig(cwd, join(cwd, 'mup.js'));
    expect(validateConfig(normalizeConfig(l.raw, { basePath: l.basePath }), l.raw)).toEqual([]);
  });

  it('accepts the base config', () => {
    expect(check(() => {})).toEqual([]);
  });

  describe('fatal errors', () => {
    it.each<[string, (c: RawConfig) => void, string, RegExp?]>([
      ['missing name', (c) => delete c.app.name, 'app.name'],
      ['missing path', (c) => delete c.app.path, 'app.path'],
      ['name with space', (c) => (c.app.name = 'my app'), 'app.name', /space/],
      ['missing servers', (c) => delete c.servers, 'servers'],
      ['invalid ROOT_URL', (c) => (c.app.env.ROOT_URL = 'app.example.com'), 'app.env.ROOT_URL'],
      ['missing env', (c) => delete c.app.env, 'app.env.ROOT_URL'],
      ['unknown app server', (c) => (c.app.servers.three = {}), 'app.servers.three'],
      ['swarm', (c) => (c.swarm = { enabled: true }), 'swarm.enabled', /not supported/],
      ['legacy app.ssl', (c) => (c.app.ssl = { crt: 'a', key: 'b' }), 'app.ssl', /proxy/],
      ['legacy app.nginx', (c) => (c.app.nginx = { clientUploadLimit: '1M' }), 'app.nginx', /proxy/],
      ['legacy imageFrontendServer', (c) => (c.app.docker.imageFrontendServer = 'x'), 'app.docker.imageFrontendServer', /proxy/],
      ['legacy dockerImageFrontendServer', (c) => (c.app.dockerImageFrontendServer = 'x'), 'app.dockerImageFrontendServer', /proxy/],
      [
        'missing name with a mongo section',
        (c) => {
          delete c.app.name;
          c.mongo = {};
        },
        'app.name',
      ],
      ['newline in env', (c) => (c.app.env.MULTI = 'a\nb'), 'app.env.MULTI', /newline/],
      ['newline in per-server env', (c) => (c.app.servers.one = { env: { X: 'a\nb' } }), 'app.servers.one.env.X', /newline/],
      ['bad strategy', (c) => (c.cometDeploy = { strategy: 'fast' }), 'cometDeploy.strategy'],
      ['keepVersions 0', (c) => (c.cometDeploy = { keepVersions: 0 }), 'cometDeploy.keepVersions'],
      ['pem .pub', (c) => (c.servers.one = { host: 'h', username: 'u', pem: '~/.ssh/id.pub' }), 'servers.one.pem', /private key/],
      ['missing host', (c) => delete c.servers.one.host, 'servers.one.host'],
    ])('%s', (_name, mutate, path, msg) => {
      const issues = check(mutate);
      const issue = find(issues, path);
      expect(issue, JSON.stringify(issues)).toBeDefined();
      expect(issue!.severity).toBe('error');
      if (msg) expect(issue!.message).toMatch(msg);
      expect(hasFatal(issues)).toBe(true);
    });
  });

  it('reports a null app.servers entry with proxy load balancing instead of crashing', () => {
    const issues = check((c) => {
      c.servers.one.privateIp = '10.0.0.1';
      c.app.servers.one = null;
      c.proxy = { domains: 'app.example.com', loadBalancing: true };
    });
    expect(find(issues, 'app.servers.one'), JSON.stringify(issues)).toBeDefined();
  });

  it.each<[string, (c: RawConfig) => void, string]>([
    ['app.path that is not a string', (c) => (c.app.path = 1), 'app.path'],
    ['app.env that is not an object, with mongo', (c) => {
      c.app.env = 'x';
      c.mongo = {};
    }, 'app.env'],
    ['app.env that is not an object, with proxy', (c) => {
      c.app.env = 'x';
      c.proxy = { domains: 'app.example.com' };
    }, 'app.env'],
  ])('reports an %s instead of crashing', (_name, mutate, path) => {
    const issues = check(mutate);
    expect(find(issues, path), JSON.stringify(issues)).toBeDefined();
  });

  it('accepts ssh2 options in servers.*.opts, such as passphrase', () => {
    expect(check((c) => (c.servers.one.opts = { port: 2222, passphrase: 'secret phrase' }))).toEqual([]);
  });

  describe('warnings', () => {
    it.each<[string, (c: RawConfig) => void, string, RegExp?]>([
      ['unknown app key', (c) => (c.app.foo = 1), 'app.foo'],
      ['singular allowIncompatibleUpdate', (c) => (c.app.buildOptions = { allowIncompatibleUpdate: true }), 'app.buildOptions.allowIncompatibleUpdate'],
      ['plugins', (c) => (c.plugins = ['mup-redis']), 'plugins', /not supported/],
      ['prepareBundleLocally', (c) => (c.app.docker.prepareBundleLocally = true), 'app.docker.prepareBundleLocally', /ignored: comet-deploy always builds locally/],
      ['wrong type tolerated', (c) => (c.app.deployCheckWaitTime = '60'), 'app.deployCheckWaitTime'],
      ['unknown cometDeploy key', (c) => (c.cometDeploy = { turbo: true }), 'cometDeploy.turbo'],
    ])('%s', (_name, mutate, path, msg) => {
      const issues = check(mutate);
      const issue = find(issues, path);
      expect(issue, JSON.stringify(issues)).toBeDefined();
      expect(issue!.severity).toBe('warning');
      if (msg) expect(issue!.message).toMatch(msg);
      expect(hasFatal(issues)).toBe(false);
    });
  });

  describe('the built-in MongoDB', () => {
    const withMongo = (c: RawConfig) => {
      c.mongo = { version: '7.0.14', servers: { one: {} } };
      c.app.env.MONGO_URL = 'mongodb://mongodb/app';
    };

    it('accepts one app server that also runs MongoDB', () => {
      expect(check(withMongo).filter((i) => i.path.startsWith('mongo'))).toEqual([]);
    });

    it('warns, without failing, when the app has two servers', () => {
      const issues = check((c) => {
        withMongo(c);
        c.servers.two = { host: '192.0.2.2', username: 'root', password: 'pw' };
        c.app.servers.two = {};
      });
      const issue = issues.find((i) => i.path === 'mongo' && /exactly one app server/.test(i.message));
      expect(issue, JSON.stringify(issues)).toBeDefined();
      expect(issue!.severity).toBe('warning');
      expect(hasFatal(issues)).toBe(false);
    });

    it('warns that the app uses only the first of several mongo.servers', () => {
      const issues = check((c) => {
        withMongo(c);
        c.servers.two = { host: '192.0.2.2', username: 'root', password: 'pw' };
        c.mongo.servers.two = {};
      });
      const issue = find(issues, 'mongo.servers');
      expect(issue?.severity).toBe('warning');
      expect(issue?.message).toBe('has 2 servers; MongoDB is set up on each of them, but the app uses only the first one ("one")');
    });
  });

  it('prefixes paths with meteor. when the raw config uses the meteor key', () => {
    const raw = base();
    raw.meteor = cloneDeep(raw.app);
    delete raw.app;
    raw.meteor.env.ROOT_URL = 'nope';
    const issues = validateConfig(normalizeConfig(raw, { basePath: '/tmp' }), raw);
    expect(find(issues, 'meteor.env.ROOT_URL')?.severity).toBe('error');
  });

  it('accepts all bundled fixtures without fatal errors', () => {
    for (const name of ['per-server-env', 'mongo', 'proxy-le', 'proxy-lb', 'registry', 'legacy-docker-image', 'upper-dot-name']) {
      const cwd = join(FIXTURES, name);
      const l = loadConfig(cwd, join(cwd, 'mup.js'));
      const issues = validateConfig(normalizeConfig(l.raw, { basePath: l.basePath }), l.raw);
      expect(hasFatal(issues), `${name}: ${JSON.stringify(issues)}`).toBe(false);
    }
  });
});
