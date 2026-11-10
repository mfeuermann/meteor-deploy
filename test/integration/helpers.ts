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
  o: { env?: Record<string, string>; strategy?: string; auth?: 'password' | 'pem'; settings?: unknown; appPath?: string } = {},
): string {
  const config = {
    servers: fakeServersConfig(servers, o.auth ?? 'password'),
    app: {
      name: APP_NAME,
      path: o.appPath ?? '../app',
      servers: Object.fromEntries(servers.map((s) => [s.name, {}])),
      env: { ROOT_URL: 'http://localhost', ...o.env },
      docker: { image: 'zodern/meteor:latest' },
      deployCheckWaitTime: 120,
    },
    ...(o.strategy ? { cometDeploy: { strategy: o.strategy } } : {}),
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
