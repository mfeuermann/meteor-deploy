import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config/types.js';
import { CometError } from '../../../src/core/errors.js';
import { buildConnectOptions } from '../../../src/ssh/options.js';

const base = { cwd: '/work', basePath: '/work/.deploy', env: {} as NodeJS.ProcessEnv };
const files: Record<string, string> = { [join(homedir(), 'k.pem')]: 'PRIVATE-KEY' };
const readFile = (p: string) => {
  if (!(p in files)) throw new Error(`ENOENT ${p}`);
  return files[p];
};

describe('buildConnectOptions', () => {
  it('reads the pem (with ~) and ignores the password', () => {
    const o = buildConnectOptions({ host: 'h', username: 'root', pem: '~/k.pem', password: 'pw' }, { ...base, readFile });
    expect(o.privateKey).toBe('PRIVATE-KEY');
    expect(o.password).toBeUndefined();
  });

  it('rejects a .pub key', () => {
    expect(() => buildConnectOptions({ host: 'h', username: 'root', pem: '~/k.pub' }, { ...base, readFile })).toThrow(CometError);
  });

  it('reports an unreadable pem with the path', () => {
    expect(() => buildConnectOptions({ host: 'h', username: 'root', pem: '/nope/key' }, { ...base, readFile })).toThrow(/\/nope\/key/);
  });

  it('passes the password unchanged', () => {
    const o = buildConnectOptions({ host: 'h', username: 'root', password: 'p@ss:w"rd' }, base);
    expect(o.password).toBe('p@ss:w"rd');
    expect(o.privateKey).toBeUndefined();
  });

  it('falls back to the ssh agent', () => {
    const o = buildConnectOptions({ host: 'h', username: 'root' }, { ...base, env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } });
    expect(o.agent).toBe('/tmp/agent.sock');
  });

  it('fails with the server name when there is no authentication', () => {
    expect(() => buildConnectOptions({ host: 'h', username: 'root' }, { ...base, name: 'one' })).toThrow(CometError);
    expect(() => buildConnectOptions({ host: 'h', username: 'root' }, { ...base, name: 'one' })).toThrow(/"one"/);
  });

  it('merges servers.*.opts into the connect options', () => {
    const server: ServerConfig = { host: 'h', username: 'u', password: 'x', opts: { port: 2222, readyTimeout: 5000 } };
    const o = buildConnectOptions(server, base);
    expect(o.port).toBe(2222);
    expect(o.readyTimeout).toBe(5000);
  });

  it('uses MUP defaults', () => {
    const o = buildConnectOptions({ host: '192.0.2.1', username: 'deployer', password: 'x' }, base);
    expect(o).toMatchObject({ host: '192.0.2.1', port: 22, username: 'deployer', keepaliveInterval: 28000, keepaliveCountMax: 12, readyTimeout: 60000 });
  });
});
