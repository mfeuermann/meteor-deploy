/**
 * Disposable "servers" for integration tests: privileged Debian containers with
 * sshd + their own dockerd, published on 127.0.0.1:<random port>.
 * Because each one runs its own Docker daemon, setup, image pulls through the SSH reverse
 * tunnel and container restarts happen for real. The image is built from `fake-server/` on
 * first use.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ServerConfig } from '../../src/config/types.js';
import type { ExecResult } from '../../src/ssh/connection.js';
import { SshConnection } from '../../src/ssh/connection.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
// The image is only built when its tag is missing: bump IMAGE_REVISION after changing
// fake-server/, or an old image is reused.
const IMAGE_REVISION = 2;
/** The Docker releases a fake server can run: the default one, and the newest major (29). */
export type FakeDockerVersion = '27.5' | '29';
/** The exact release of each major; 29.9 was the newest 29.x when the proxy gate was added. */
const DOCKER_RELEASE: Record<FakeDockerVersion, string> = { '27.5': '27.5', '29': '29.9' };
const imageTag = (v: FakeDockerVersion) => `comet-fake-server:${IMAGE_REVISION}-docker${DOCKER_RELEASE[v]}`;
// Test-only credentials; the containers listen on 127.0.0.1 only.
const ROOT_PASSWORD = 'comet-root-pw';
const DEPLOYER_PASSWORD = 'comet-deployer-pw';
const READY_TIMEOUT_MS = 180_000;

/** One running fake server. */
export interface FakeServer {
  /** `s1`, `s2`, … in start order. */
  name: string;
  host: '127.0.0.1';
  /** The host port that the container's port 22 is published on. */
  port: number;
  /** `root` or `deployer`, as chosen in `startFakeServers`. */
  username: string;
  /** The password of `username`. */
  password: string;
  /** Private key accepted by both users (one key pair per test process). */
  pemPath: string;
  containerId: string;
  /** Runs a command inside the container (docker exec, not SSH). */
  exec(cmd: string): Promise<ExecResult>;
  /** Removes the container and its Docker data volume; never throws. */
  stop(): Promise<void>;
}

/** Runs the local docker CLI and returns its trimmed stdout; rejects on a non-zero exit. */
async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const imageReady = new Map<FakeDockerVersion, Promise<string>>();
/**
 * Builds the image for Docker `v` if it is missing and resolves to its tag. The promise is
 * shared per version, so parallel callers share one build.
 */
function ensureImage(v: FakeDockerVersion): Promise<string> {
  let ready = imageReady.get(v);
  if (!ready) {
    const tag = imageTag(v);
    ready = (async () => {
      try {
        await docker(['image', 'inspect', tag]);
      } catch {
        await docker(['build', '--build-arg', `DOCKER_VERSION=${DOCKER_RELEASE[v]}`, '-t', tag, join(here, 'fake-server')]);
      }
      return tag;
    })();
    imageReady.set(v, ready);
  }
  return ready;
}

let keys: { pemPath: string; publicKey: string } | undefined;
/**
 * One RSA key pair per test process, in a new temp directory, without a passphrase. `-m PEM`
 * writes the classic PEM format rather than the OpenSSH one.
 */
async function keyPair(): Promise<{ pemPath: string; publicKey: string }> {
  if (keys) return keys;
  const dir = mkdtempSync(join(tmpdir(), 'comet-fake-keys-'));
  const pemPath = join(dir, 'id_rsa');
  await run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-f', pemPath]);
  keys = { pemPath, publicKey: readFileSync(`${pemPath}.pub`, 'utf8').trim() };
  return keys;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls over real SSH (password auth) once a second until the inner dockerd answers, which
 * takes longer than sshd. Throws with the last error after READY_TIMEOUT_MS.
 */
async function waitReady(server: FakeServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const conn = await SshConnection.connect(server.name, fakeServerConfig(server, 'password'), { cwd: here, basePath: here });
      try {
        const r = await conn.exec('sudo docker version --format "{{.Server.Version}}"');
        if (r.code === 0) return;
        lastError = new Error(r.stderr);
      } finally {
        await conn.close();
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(1000);
  }
  throw new Error(`Fake server ${server.name} not ready after ${READY_TIMEOUT_MS / 1000}s: ${(lastError as Error)?.message}`);
}

/**
 * Starts `n` fake servers in parallel and resolves when all of them accept SSH and run Docker.
 * `o.user` picks the SSH user (`deployer` is a non-root user with passwordless sudo);
 * `o.allowTcpForwarding: false` makes sshd refuse the reverse tunnel; `o.docker` picks the Docker
 * release inside (default 27.5). If any server does not
 * become ready, all of them are removed and the error is rethrown. Otherwise the caller must
 * `stop()` them.
 */
export async function startFakeServers(
  n: number,
  o: { allowTcpForwarding?: boolean; user?: 'root' | 'deployer'; docker?: FakeDockerVersion } = {},
): Promise<FakeServer[]> {
  const image = await ensureImage(o.docker ?? '27.5');
  const { pemPath, publicKey } = await keyPair();
  const user = o.user ?? 'root';
  const servers = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      // --privileged lets the inner dockerd run. The label finds leftover containers
      // (`docker ps -a --filter label=comet-fake-server`). `127.0.0.1::22` publishes port 22
      // on a random port, on loopback only.
      const containerId = await docker([
        'run', '-d', '--privileged', '--label', 'comet-fake-server=1',
        '-p', '127.0.0.1::22',
        '-e', `ROOT_PASSWORD=${ROOT_PASSWORD}`,
        '-e', `DEPLOYER_PASSWORD=${DEPLOYER_PASSWORD}`,
        '-e', `AUTHORIZED_KEY=${publicKey}`,
        '-e', `ALLOW_TCP_FORWARDING=${o.allowTcpForwarding === false ? 'no' : 'yes'}`,
        image,
      ]);
      const mapping = await docker(['port', containerId, '22/tcp']);
      const port = Number(mapping.split('\n')[0].split(':').pop());
      const server: FakeServer = {
        name: `s${i + 1}`,
        host: '127.0.0.1',
        port,
        username: user,
        password: user === 'root' ? ROOT_PASSWORD : DEPLOYER_PASSWORD,
        pemPath,
        containerId,
        async exec(cmd) {
          try {
            const { stdout, stderr } = await run('docker', ['exec', containerId, 'bash', '-c', cmd], { maxBuffer: 64 * 1024 * 1024 });
            return { code: 0, stdout, stderr };
          } catch (err) {
            // execFile rejects on a non-zero exit, with the exit code in `code` (a string
            // such as ENOENT when docker itself cannot be started).
            const e = err as { code?: number; stdout?: string; stderr?: string };
            return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
          }
        },
        async stop() {
          await docker(['rm', '-f', '-v', containerId]).catch(() => {});
        },
      };
      return server;
    }),
  );
  try {
    await Promise.all(servers.map(waitReady));
  } catch (err) {
    await Promise.all(servers.map((s) => s.stop()));
    throw err;
  }
  return servers;
}

/** The `servers.<name>` entry for one fake server, with password or key authentication. */
function fakeServerConfig(s: FakeServer, auth: 'password' | 'pem'): ServerConfig {
  return {
    host: s.host,
    username: s.username,
    opts: { port: s.port },
    ...(auth === 'pem' ? { pem: s.pemPath } : { password: s.password }),
  };
}

/** `servers` section for a mup.js pointing at the fake servers. */
export function fakeServersConfig(servers: FakeServer[], auth: 'password' | 'pem'): Record<string, ServerConfig> {
  return Object.fromEntries(servers.map((s) => [s.name, fakeServerConfig(s, auth)]));
}
