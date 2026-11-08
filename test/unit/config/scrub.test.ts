import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import { scrubConfig } from '../../../src/config/scrub.js';
import { createMupApi } from '../../oracle/mup-oracle.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/configs');

function ours(name: string) {
  const cwd = join(FIXTURES, name);
  const l = loadConfig(cwd, join(cwd, 'mup.js'));
  return normalizeConfig(l.raw, { basePath: l.basePath });
}

function mupScrub(name: string) {
  const api = createMupApi(join(FIXTURES, name, 'mup.js'));
  const log = console.log;
  console.log = () => {};
  try {
    return JSON.parse(JSON.stringify(api.scrubConfig()));
  } finally {
    console.log = log;
  }
}

describe('scrubConfig', () => {
  it('replaces hosts, passwords, pem, name and urls', () => {
    const c = ours('per-server-env');
    c.app.env.ROOT_URL = 'https://sub.example.org:3000/x';
    const s = scrubConfig(c);
    expect(s.servers.one.host).toBe('1.2.3.4');
    expect(s.servers.one.pem).toBe('~/.ssh/pem');
    expect(s.servers.two.password).toBe('password');
    expect(s.app.name).toBe('my-app');
    expect(s.app.env.ROOT_URL).toBe('https://subdomain.host.com:3000/x');
    expect(c.app.name).toBe('per-server');
  });

  it.each(['aaa-like', 'proxy-lb', 'registry', 'mongo'])('matches MUP for %s', (name) => {
    const { cometDeploy: _c, ...rest } = scrubConfig(ours(name)) as any;
    expect(JSON.parse(JSON.stringify(rest))).toEqual(mupScrub(name));
  });
});
