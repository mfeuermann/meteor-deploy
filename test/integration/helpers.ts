/**
 * Helpers for the integration / e2e scenarios: a copy of the sample app, a
 * mup.js pointing at fake servers, and in-process runs of our CLI and MUP's.
 */
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/cli/main.js';
import { fakeServersConfig, type FakeServer } from '../harness/fake-servers.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const SAMPLE_APP = join(here, '../fixtures/sample-app');
export const APP_NAME = 'sampleapp';

/** Temp project: `<root>/app` (copy of the sample app incl. node_modules) and `<root>/.deploy`. */
export function sampleProject(): { root: string; appDir: string; deployDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'comet-e2e-'));
  const appDir = join(root, 'app');
  cpSync(SAMPLE_APP, appDir, { recursive: true, filter: (src) => !src.includes(join('.meteor', 'local')) });
  // node_modules is not committed: install from the lockfile on a fresh clone.
  if (!existsSync(join(appDir, 'node_modules'))) execFileSync('meteor', ['npm', 'ci'], { cwd: appDir, stdio: 'inherit' });
  const deployDir = join(root, '.deploy');
  mkdirSync(deployDir);
  return { root, appDir, deployDir };
}

/** Writes mup.js + settings.json into `dir`; returns the mup.js path. */
export function writeTestConfig(
  dir: string,
  servers: FakeServer[],
  o: {
    env?: Record<string, string>;
    strategy?: string;
    auth?: 'password' | 'pem';
    settings?: unknown;
    appPath?: string;
    /** Extra `app.docker` options (e.g. MUP's useBuildKit for the interop test). */
    docker?: Record<string, unknown>;
    /** The `proxy` section, written as given. */
    proxy?: Record<string, unknown>;
    /** Extra `cometDeploy` options; `strategy` above is merged in. */
    cometDeploy?: Record<string, unknown>;
    /** The app name (default `APP_NAME`), for a second app on the same servers. */
    name?: string;
    /** Sets each server's `privateIp` to its container IP (the load balancing upstream). */
    privateIp?: boolean;
  } = {},
): string {
  const serversConfig = fakeServersConfig(servers, o.auth ?? 'password');
  if (o.privateIp) for (const s of servers) Object.assign(serversConfig[s.name], { privateIp: s.ip });
  const config = {
    servers: serversConfig,
    app: {
      name: o.name ?? APP_NAME,
      path: o.appPath ?? '../app',
      servers: Object.fromEntries(servers.map((s) => [s.name, {}])),
      env: { ROOT_URL: 'http://localhost', ...o.env },
      docker: { image: 'zodern/meteor:latest', ...o.docker },
      deployCheckWaitTime: 120,
    },
    ...(o.proxy ? { proxy: o.proxy } : {}),
    ...(o.strategy || o.cometDeploy ? { cometDeploy: { ...o.cometDeploy, ...(o.strategy ? { strategy: o.strategy } : {}) } } : {}),
  };
  const path = join(dir, 'mup.js');
  writeFileSync(path, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(o.settings ?? { public: {} }));
  return path;
}

/** Runs our CLI in-process; stdout and stderr interleaved in `output`. */
export async function cli(args: string[], cwd: string): Promise<{ code: number; output: string }> {
  const out: string[] = [];
  const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void out.push(s) };
  const code = await main(args, io, { cwd });
  return { code, output: out.join('') };
}

/** Runs MUP 1.5.11 (devDependency) as a child process. */
export function mup(args: string[], cwd: string): Promise<{ code: number; output: string }> {
  const bin = join(dirname(require.resolve('mup/package.json')), 'index.js');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd, env: { ...process.env, MUP_SKIP_UPDATE_CHECK: 'true', FORCE_COLOR: '0' }, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** `curl` inside a fake server against the app on port 80. */
export async function curlApp(server: FakeServer, path: string): Promise<string> {
  const r = await server.exec(`curl -s --max-time 15 http://localhost${path}`);
  return r.stdout.trim();
}

/** `curl` inside a fake server through the reverse proxy on port 80, with `host` as the Host header. */
export async function curlVia(server: FakeServer, host: string, path: string): Promise<string> {
  const r = await server.exec(`curl -s --max-time 15 -H 'Host: ${host}' http://localhost${path}`);
  return r.stdout.trim();
}

let loopCount = 0;

/**
 * Sends a request through the reverse proxy on `server` every 50 ms, in the background inside
 * the fake server, until `stop()`. Every answer other than HTTP 200 counts as failed (000 = no
 * connection); `codes` lists the distinct failed statuses for the assertion message. It waits
 * for the first answers before it resolves, so the command under test starts with traffic.
 */
export async function requestLoop(
  server: FakeServer,
  host: string,
  path = '/native',
): Promise<{ stop(): Promise<{ total: number; failed: number; codes: string[] }> }> {
  // A new name per loop, so no file of an earlier loop is read.
  const id = `/tmp/comet-loop-${process.pid}-${++loopCount}`;
  await server.exec(
    `cat > ${id}.sh <<'EOF'
: > ${id}.log
while [ ! -f ${id}.stop ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: ${host}' http://localhost${path}); rc=$?
  # A failed request also records curl's exit code (7 refused, 28 timeout, 52/56 dropped).
  if [ "$code" = 200 ]; then echo 200; else echo "$code/curl$rc"; fi >> ${id}.log
  sleep 0.05
done
touch ${id}.done
EOF
setsid nohup bash ${id}.sh > /dev/null 2>&1 &`,
  );
  await waitFor(async () => Number((await server.exec(`wc -l < ${id}.log 2>/dev/null || echo 0`)).stdout.trim()) >= 5, 30_000);
  return {
    async stop() {
      await server.exec(`touch ${id}.stop`);
      await waitFor(async () => (await server.exec(`test -f ${id}.done`)).code === 0, 30_000);
      const codes = (await server.exec(`cat ${id}.log`)).stdout.split('\n').filter(Boolean);
      const failed = codes.filter((c) => c !== '200');
      return { total: codes.length, failed: failed.length, codes: [...new Set(failed)] };
    },
  };
}

/** Image id behind `mup-<app>:<tag>` on a fake server ('' when missing). */
export async function imageId(server: FakeServer, tag: string): Promise<string> {
  return (await server.exec(`docker image inspect --format '{{.Id}}' mup-${APP_NAME}:${tag} 2>/dev/null`)).stdout.trim();
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
