import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/local/exec.js';
import { SshConnection } from '../../src/ssh/connection.js';
import { distributeToServer } from '../../src/transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry } from '../../src/transfer/local-registry.js';
import { probeForwarding, TunnelUnavailableError } from '../../src/transfer/tunnel.js';
import { fakeServersConfig, startFakeServers, type FakeServer } from '../harness/fake-servers.js';

const BASE = 'busybox:1.36';

async function dockerBuild(tag: string, dockerfile: string): Promise<void> {
  const r = await run('docker', ['build', '-t', tag, '-'], { input: dockerfile });
  if (r.code !== 0) throw new Error(r.stderr);
}

async function connect(s: FakeServer): Promise<SshConnection> {
  const [name, cfg] = Object.entries(fakeServersConfig([s], 'password'))[0];
  return SshConnection.connect(name, cfg, { cwd: process.cwd(), basePath: process.cwd() });
}

describe('image distribution through the local registry and a reverse tunnel', () => {
  let servers: FakeServer[] = [];
  let noForward: FakeServer[] = [];
  let port: number;

  beforeAll(async () => {
    [servers, noForward] = await Promise.all([startFakeServers(2), startFakeServers(1, { allowTcpForwarding: false })]);
    await run('docker', ['pull', BASE]);
    await dockerBuild('mup-app:v1', `FROM ${BASE}\nRUN dd if=/dev/urandom of=/big bs=1M count=5\n`);
    await dockerBuild('mup-app:v2', 'FROM mup-app:v1\nRUN echo small > /small\n');
    ({ port } = await ensureLocalRegistry());
  });

  afterAll(async () => {
    await Promise.all([...servers, ...noForward].map((s) => s.stop()));
  });

  it('distributes to two servers in parallel and leaves no tunnel tags', async () => {
    const ref = await pushToLocalRegistry('mup-app:v1', port);
    expect(ref).toBe('mup-app:v1');
    await Promise.all(
      servers.map(async (s) => {
        const conn = await connect(s);
        try {
          await distributeToServer(conn, { registryPort: port, registryRef: ref, targetTag: 'mup-app:v1', baseImage: BASE });
        } finally {
          await conn.close();
        }
      }),
    );
    for (const s of servers) {
      const images = (await s.exec(`docker images --format '{{.Repository}}:{{.Tag}}'`)).stdout;
      expect(images).toContain('mup-app:v1');
      expect(images).not.toMatch(/127\.0\.0\.1:\d+\//);
    }
  });

  it('transfers only the changed layer the second time', async () => {
    const ref = await pushToLocalRegistry('mup-app:v2', port);
    const conn = await connect(servers[0]);
    const lines: string[] = [];
    try {
      await distributeToServer(conn, { registryPort: port, registryRef: ref, targetTag: 'mup-app:v2', baseImage: BASE, onStatus: (l) => lines.push(l) });
    } finally {
      await conn.close();
    }
    expect(lines.some((l) => /Already exists/.test(l))).toBe(true);
    expect(lines.filter((l) => /Pull complete/.test(l))).toHaveLength(1);
  });

  it('the preflight probe finds a server without TCP forwarding and passes a normal one (M3)', async () => {
    const [bad, good] = await Promise.all([connect(noForward[0]), connect(servers[0])]);
    try {
      expect(await probeForwarding(bad)).toEqual(expect.any(String));
      expect(await probeForwarding(good)).toBeNull();
    } finally {
      await Promise.all([bad.close(), good.close()]);
    }
  });

  it('reports a server without TCP forwarding', async () => {
    const conn = await connect(noForward[0]);
    try {
      await expect(
        distributeToServer(conn, { registryPort: port, registryRef: 'mup-app:v1', targetTag: 'mup-app:v1', baseImage: BASE }),
      ).rejects.toBeInstanceOf(TunnelUnavailableError);
    } finally {
      await conn.close();
    }
  });
});
