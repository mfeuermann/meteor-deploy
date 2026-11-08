import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SshConnection } from '../../src/ssh/connection.js';
import { fakeServersConfig, startFakeServers, type FakeServer } from '../harness/fake-servers.js';

describe('fake servers harness', () => {
  let servers: FakeServer[] = [];

  beforeAll(async () => {
    servers = await startFakeServers(2);
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
  });

  for (const auth of ['password', 'pem'] as const) {
    it(`connects with ${auth} and runs docker on every server`, async () => {
      const config = fakeServersConfig(servers, auth);
      for (const [name, server] of Object.entries(config)) {
        const conn = await SshConnection.connect(name, server, { cwd: process.cwd(), basePath: process.cwd() });
        try {
          const r = await conn.runScript('sudo docker version --format "{{.Server.Version}}"');
          expect(r.code).toBe(0);
          expect(r.stdout.trim()).toMatch(/^\d+\.\d+/);
        } finally {
          await conn.close();
        }
      }
    });
  }

  it('opens a reverse tunnel on a server-assigned port', async () => {
    const [name, server] = Object.entries(fakeServersConfig(servers, 'password'))[0];
    const conn = await SshConnection.connect(name, server, { cwd: process.cwd(), basePath: process.cwd() });
    try {
      const tunnel = await conn.forwardIn(0, (stream) => stream.end('hello\n'));
      expect(tunnel.port).toBeGreaterThan(0);
      const r = await conn.exec(`curl -s --max-time 5 telnet://127.0.0.1:${tunnel.port} </dev/null || true`);
      expect(r.stdout).toContain('hello');
      await tunnel.close();
    } finally {
      await conn.close();
    }
  });
});
