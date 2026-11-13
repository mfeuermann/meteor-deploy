import { spawn, type SpawnOptions } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/local/exec.js';
import { SshConnection } from '../../src/ssh/connection.js';
import { distributeToServer } from '../../src/transfer/distribute.js';
import { ensureLocalRegistry, pushToLocalRegistry } from '../../src/transfer/local-registry.js';
import { localImageStore, removeArchive, saveImageArchive, serverHasImage, streamToServer } from '../../src/transfer/stream.js';
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

// The stream transfer loads a `docker save` archive of this machine's Docker (whichever image
// store it uses) into both Docker releases the fake servers offer; 29 uses the containerd store.
describe.each(['27.5', '29'] as const)('image transfer over SSH to a server without forwarding (Docker %s)', (docker) => {
  let server: FakeServer;
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';

  beforeAll(async () => {
    [server] = await startFakeServers(1, { allowTcpForwarding: false, docker });
    await run('docker', ['pull', BASE]);
    await dockerBuild('mup-stream:v1-helper', `FROM ${BASE}\nRUN echo stream > /marker\n`);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('loads the image under the target tag only, and a container runs from it', async () => {
    const archive = await saveImageArchive({ localTag: 'mup-stream:v1-helper', platform, app: 'stream', store: await localImageStore() });
    const conn = await connect(server);
    try {
      expect(await serverHasImage(conn, 'mup-stream:v1')).toBe(false);
      await streamToServer(conn, { archive, targetTag: 'mup-stream:v1' });
      // What the deploy checks before it sends anything the next time.
      expect(await serverHasImage(conn, 'mup-stream:v1')).toBe(true);
    } finally {
      removeArchive(archive);
      await conn.close();
    }
    const tags = (await server.exec(`docker images mup-stream --format '{{.Repository}}:{{.Tag}}'`)).stdout.split('\n').filter(Boolean);
    expect(tags).toEqual(['mup-stream:v1']);
    expect((await server.exec('docker run --rm mup-stream:v1 cat /marker')).stdout.trim()).toBe('stream');
  });
});

// A local Docker with the containerd image store (Docker Desktop 4.34+): saveImageArchive's
// `docker` commands run inside a Docker 29 fake server, as if it were this machine. Its archive,
// with `--platform` and without it (what a docker CLI before 28 gets), must load on Docker 27.5.
describe('image transfer over SSH from a Docker with the containerd image store', () => {
  let source: FakeServer;
  let target: FakeServer;
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const inSource = ((_cmd: string, args: string[], o: SpawnOptions) => spawn('docker', ['exec', source.containerId, 'docker', ...args], o)) as typeof spawn;

  beforeAll(async () => {
    [[source], [target]] = await Promise.all([startFakeServers(1, { docker: '29' }), startFakeServers(1, { allowTcpForwarding: false })]);
    const built = await source.exec(`docker pull -q ${BASE} > /dev/null && printf 'FROM ${BASE}\\nRUN echo containerd > /marker\\n' | docker build -q -t mup-cd:v1-helper -`);
    expect(built.code, built.stderr).toBe(0);
  });

  afterAll(async () => {
    await Promise.all([source?.stop(), target?.stop()]);
  });

  it('detects the containerd image store', async () => {
    const inSourceRun = ((cmd: string, args: string[]) => run('docker', ['exec', source.containerId, cmd, ...args])) as typeof run;
    expect(await localImageStore({ run: inSourceRun })).toBe('containerd');
  });

  it.each([
    ['with --platform', 'containerd'],
    ['without --platform (docker CLI before 28)', 'classic'],
  ] as const)('an archive saved %s loads on Docker 27.5 under the target tag', async (_what, store) => {
    const archive = await saveImageArchive({ localTag: 'mup-cd:v1-helper', platform, app: 'cd', store, spawn: inSource });
    const conn = await connect(target);
    try {
      await streamToServer(conn, { archive, targetTag: 'mup-cd:v1' });
    } finally {
      removeArchive(archive);
      await conn.close();
    }
    expect((await target.exec(`docker images mup-cd --format '{{.Repository}}:{{.Tag}}'`)).stdout.trim()).toBe('mup-cd:v1');
    expect((await target.exec('docker run --rm mup-cd:v1 cat /marker')).stdout.trim()).toBe('containerd');
    await target.exec('docker rmi mup-cd:v1');
  });
});
