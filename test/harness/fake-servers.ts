/**
 * Disposable "servers" for integration tests: privileged Debian containers with
 * sshd + their own dockerd, published on 127.0.0.1:<random port>.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ServerConfig } from '../../src/config/types.js';
import type { ExecResult } from '../../src/ssh/connection.js';
import { SshConnection } from '../../src/ssh/connection.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const IMAGE = 'comet-fake-server:1';
const ROOT_PASSWORD = 'comet-root-pw';
const DEPLOYER_PASSWORD = 'comet-deployer-pw';
const READY_TIMEOUT_MS = 180_000;

export interface FakeServer {
  name: string;
  host: '127.0.0.1';
  port: number;
  username: string;
  password: string;
  pemPath: string;
  containerId: string;
  /** Runs a command inside the container (docker exec, not SSH). */
  exec(cmd: string): Promise<ExecResult>;
  stop(): Promise<void>;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

let imageReady: Promise<void> | undefined;
function ensureImage(): Promise<void> {
  imageReady ??= (async () => {
    try {
      await docker(['image', 'inspect', IMAGE]);
    } catch {
      await docker(['build', '-t', IMAGE, join(here, 'fake-server')]);
    }
  })();
  return imageReady;
}

let keys: { pemPath: string; publicKey: string } | undefined;
async function keyPair(): Promise<{ pemPath: string; publicKey: string }> {
  if (keys) return keys;
  const dir = mkdtempSync(join(tmpdir(), 'comet-fake-keys-'));
  const pemPath = join(dir, 'id_rsa');
  if (!existsSync(pemPath)) await run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '', '-f', pemPath]);
  keys = { pemPath, publicKey: readFileSync(`${pemPath}.pub`, 'utf8').trim() };
  return keys;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function startFakeServers(
  n: number,
  o: { allowTcpForwarding?: boolean; user?: 'root' | 'deployer' } = {},
): Promise<FakeServer[]> {
  await ensureImage();
  const { pemPath, publicKey } = await keyPair();
  const user = o.user ?? 'root';
  const servers = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const containerId = await docker([
        'run', '-d', '--privileged', '--label', 'comet-fake-server=1',
        '-p', '127.0.0.1::22',
        '-e', `ROOT_PASSWORD=${ROOT_PASSWORD}`,
        '-e', `DEPLOYER_PASSWORD=${DEPLOYER_PASSWORD}`,
        '-e', `AUTHORIZED_KEY=${publicKey}`,
        '-e', `ALLOW_TCP_FORWARDING=${o.allowTcpForwarding === false ? 'no' : 'yes'}`,
        IMAGE,
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
