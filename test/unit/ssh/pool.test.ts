import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config/types.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { SshPool } from '../../../src/ssh/pool.js';

interface FakeConn {
  name: string;
  n: number;
  isAlive: boolean;
  close(): Promise<void>;
}

function pool() {
  const made: FakeConn[] = [];
  const connect = async (name: string): Promise<SshConnection> => {
    const c: FakeConn = { name, n: made.length + 1, isAlive: true, close: async () => void (c.isAlive = false) };
    made.push(c);
    return c as unknown as SshConnection;
  };
  const servers: Record<string, ServerConfig> = { one: { host: '192.0.2.1', username: 'root' } };
  return { p: new SshPool(servers, { cwd: '/', basePath: '/' }, connect), made };
}

describe('SshPool (M8)', () => {
  it('reuses one connection per server', async () => {
    const { p, made } = pool();
    const [a, b] = await Promise.all([p.get('one'), p.get('one')]);
    expect(a).toBe(b);
    expect(made).toHaveLength(1);
  });

  it('opens a new connection when the old one was dropped, once for concurrent callers', async () => {
    const { p, made } = pool();
    const first = (await p.get('one')) as unknown as FakeConn;
    first.isAlive = false;
    const [a, b] = await Promise.all([p.get('one'), p.get('one')]);
    expect(a).toBe(b);
    expect((a as unknown as FakeConn).n).toBe(2);
    expect(made).toHaveLength(2);
  });

  it('rejects unknown servers', async () => {
    await expect(pool().p.get('nope')).rejects.toThrow(/not defined/);
  });
});
