/**
 * A private Docker registry for integration tests: `registry:2.8.3` with htpasswd
 * authentication, published on 127.0.0.1:<random port> of the local Docker. Docker treats
 * 127.0.0.0/8 as an insecure registry (plain HTTP, no certificate), so neither the local Docker
 * nor the fake servers need any setting. The fake servers reach it at the same address through
 * `forwardRegistry` (socat inside the fake server), so one image reference works on both sides.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FakeServer } from './fake-servers.js';

const run = promisify(execFile);

// Test-only credentials. The hash is `htpasswd -nbB comet comet-registry-pw` (the registry
// accepts bcrypt only).
const USERNAME = 'comet';
const PASSWORD = 'comet-registry-pw';
const HTPASSWD = 'comet:$2y$05$5K0.WvMj43d0S.Hl7kPyO.RU1llYzcBYfLfTq2qg5SddxYAqjHYAa\n';

/** One running test registry. */
export interface TestRegistry {
  port: number;
  /** `127.0.0.1:<port>`: the registry host on this computer and, after `forwardRegistry`, on the fake servers. */
  host: string;
  /** The container's IP on the local Docker network (where socat in a fake server connects). */
  ip: string;
  username: string;
  password: string;
  /** The tags of `repo` (e.g. `comet/mup-sampleapp`); [] when the repository does not exist. */
  tags(repo: string): Promise<string[]>;
  /** Removes the container; never throws. */
  stop(): Promise<void>;
}

async function docker(args: string[]): Promise<string> {
  return (await run('docker', args)).stdout.trim();
}

/** Starts a registry with authentication; its data lives in the container and goes with it. */
export async function startTestRegistry(): Promise<TestRegistry> {
  const authDir = mkdtempSync(join(tmpdir(), 'comet-registry-auth-'));
  writeFileSync(join(authDir, 'htpasswd'), HTPASSWD);
  const id = await docker([
    'run', '-d', '--label', 'comet-test-registry=1', '-p', '127.0.0.1::5000',
    '-e', 'REGISTRY_AUTH=htpasswd', '-e', 'REGISTRY_AUTH_HTPASSWD_REALM=comet-test', '-e', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
    '-v', `${authDir}:/auth:ro`,
    'registry:2.8.3',
  ]);
  const port = Number((await docker(['port', id, '5000/tcp'])).split('\n')[0].split(':').pop());
  const ip = (await docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', id])).split(/\s+/)[0] ?? '';
  const auth = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  // Ready when it answers (401 without credentials).
  for (let i = 0; ; i++) {
    const ok = await fetch(url('/v2/')).then(() => true, () => false);
    if (ok) break;
    if (i > 100) throw new Error('The test registry did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    host: `127.0.0.1:${port}`,
    ip,
    username: USERNAME,
    password: PASSWORD,
    async tags(repo) {
      const res = await fetch(url(`/v2/${repo}/tags/list`), { headers: { authorization: auth } });
      if (res.status === 404) return [];
      const body = (await res.json()) as { tags?: string[] | null };
      return [...(body.tags ?? [])].sort();
    },
    async stop() {
      await docker(['rm', '-f', id]).catch(() => {});
      rmSync(authDir, { recursive: true, force: true });
    },
  };
}

/**
 * Makes the registry reachable inside the fake server at `reg.host` (127.0.0.1:<port>), as on
 * this computer: socat listens there and forwards to the registry container.
 */
export async function forwardRegistry(server: FakeServer, reg: TestRegistry): Promise<void> {
  const started = await server.exec(
    `setsid nohup socat TCP-LISTEN:${reg.port},bind=127.0.0.1,fork,reuseaddr TCP:${reg.ip}:5000 > /dev/null 2>&1 < /dev/null & ` +
      `for i in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/${reg.port}) 2>/dev/null && exit 0; sleep 0.1; done; exit 1`,
  );
  if (started.code !== 0) throw new Error(`socat did not start in ${server.name}: ${started.stderr}`);
}

/**
 * Points the docker CLI of this process (and of comet-deploy, which runs in it) at a fresh
 * DOCKER_CONFIG, so a `docker login` in a test never changes the developer's own. The current
 * context's endpoint goes to DOCKER_HOST (the context lives in the old config), and the CLI
 * plugins (buildx) stay reachable through a symlink. `restore` puts everything back.
 */
export function isolatedDockerConfig(): { dir: string; restore(): void } {
  const prev = { config: process.env.DOCKER_CONFIG, host: process.env.DOCKER_HOST };
  const host = prev.host ?? execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'comet-docker-config-'));
  const plugins = join(prev.config ?? join(homedir(), '.docker'), 'cli-plugins');
  if (existsSync(plugins)) symlinkSync(plugins, join(dir, 'cli-plugins'));
  process.env.DOCKER_CONFIG = dir;
  process.env.DOCKER_HOST = host;
  return {
    dir,
    restore() {
      for (const [key, value] of [['DOCKER_CONFIG', prev.config], ['DOCKER_HOST', prev.host]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
