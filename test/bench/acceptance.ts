/**
 * Local acceptance benchmark: comet-deploy vs MUP 1.5.11 on fake servers with an
 * aaa-brain-shaped config (top-level `meteor`, dockerImage, serverOnly, PORT 8080,
 * docker.args with the timezone mounts). Scenario per tool on fresh servers:
 * setup → deploy (cold) → code-only change → deploy.
 *
 * Run from the repo root after `npm run build`:
 *   BENCH_OUT=<dir> BENCH_SERVERS=2 [BENCH_TOOLS=comet,mup] npx vite-node test/bench/acceptance.ts
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { sampleProject } from '../integration/helpers.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.env.BENCH_OUT!;
const N = Number(process.env.BENCH_SERVERS ?? 2);
const TOOLS = (process.env.BENCH_TOOLS ?? 'comet,mup').split(',') as Array<'comet' | 'mup'>;
const req = createRequire(join(REPO, 'package.json'));
const BIN = { mup: join(dirname(req.resolve('mup/package.json')), 'index.js'), comet: join(REPO, 'dist/cli/main.js') };
const NAMES = ['one', 'two', 'three', 'four', 'five', 'six'];
mkdirSync(OUT, { recursive: true });

interface Line { t: number; line: string }
interface Run { code: number; ms: number; lines: Line[] }

function runTool(tool: 'comet' | 'mup', args: string[], cwd: string, log: string): Promise<Run> {
  const t0 = Date.now();
  const child = spawn(process.execPath, [BIN[tool], ...args], {
    cwd,
    env: { ...process.env, MUP_SKIP_UPDATE_CHECK: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const lines: Line[] = [];
  const bufs = { out: '', err: '' };
  const onData = (k: 'out' | 'err') => (d: Buffer) => {
    bufs[k] += d.toString();
    let i: number;
    while ((i = bufs[k].search(/[\r\n]/)) >= 0) {
      const line = bufs[k].slice(0, i).trimEnd();
      if (line) lines.push({ t: Date.now() - t0, line });
      bufs[k] = bufs[k].slice(i + 1);
    }
  };
  child.stdout.on('data', onData('out'));
  child.stderr.on('data', onData('err'));
  return new Promise((resolve) =>
    child.on('close', (code) => {
      for (const k of ['out', 'err'] as const) if (bufs[k].trim()) lines.push({ t: Date.now() - t0, line: bufs[k].trim() });
      const ms = Date.now() - t0;
      writeFileSync(join(OUT, `${log}.log`), lines.map((l) => `${(l.t / 1000).toFixed(1).padStart(7)}s  ${l.line}`).join('\n') + `\n[exit ${code}, ${(ms / 1000).toFixed(1)}s]\n`);
      resolve({ code: code ?? 1, ms, lines });
    }),
  );
}

function writeConfig(deployDir: string, servers: FakeServer[]): string {
  const names = servers.map((_, i) => NAMES[i]);
  const config = {
    servers: Object.fromEntries(servers.map((s, i) => [names[i], { host: s.host, username: s.username, pem: s.pemPath, opts: { port: s.port } }])),
    meteor: {
      name: 'benchapp',
      path: '../app',
      servers: Object.fromEntries(names.map((n) => [n, {}])),
      buildOptions: { serverOnly: true },
      env: { ROOT_URL: 'http://localhost', PORT: 8080 },
      enableUploadProgressBar: true,
      dockerImage: 'zodern/meteor:latest',
      // useBuildKit: MUP 1.5.11 without it fails on its own for this app (EPERM chmod, see interop test); comet-deploy ignores it.
      docker: { args: ['-v /etc/timezone:/etc/timezone', '-v /etc/localtime:/etc/localtime'], useBuildKit: true },
      deployCheckWaitTime: 120,
    },
  };
  const path = join(deployDir, 'mup.js');
  writeFileSync(path, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  writeFileSync(join(deployDir, 'settings.json'), JSON.stringify({ public: {} }));
  return path;
}

const at = (r: Run, re: RegExp, last = false): number | null => {
  const hits = r.lines.filter((l) => re.test(l.line));
  const h = last ? hits[hits.length - 1] : hits[0];
  return h ? h.t : null;
};

/** Seconds from the end of `meteor build` to the last healthy server. */
function buildEndToHealthy(tool: 'comet' | 'mup', r: Run): number | null {
  const [a, b] =
    tool === 'comet'
      ? [at(r, /^<== meteor build/), at(r, /^<== Activate/)]
      : [at(r, /Started TaskList: Pushing Meteor App/), at(r, /Verifying Deployment: SUCCESS/, true)];
  return a !== null && b !== null ? (b - a) / 1000 : null;
}

function cometPhases(r: Run): Record<string, string> {
  return Object.fromEntries(
    r.lines.flatMap((l) => {
      const m = /^<== (.+?) \(([^)]+)\)$/.exec(l.line);
      return m ? [[m[1], m[2]]] : [];
    }),
  );
}

async function curlAll(servers: FakeServer[]): Promise<string[]> {
  return Promise.all(servers.map(async (s) => (await s.exec('curl -s --max-time 15 http://localhost:8080/native')).stdout.trim()));
}

async function scenario(tool: 'comet' | 'mup') {
  const servers = await startFakeServers(N);
  try {
    // aaa-brain mounts /etc/timezone; make sure the file exists on the fake server.
    await Promise.all(servers.map((s) => s.exec('test -f /etc/timezone || echo Etc/UTC > /etc/timezone')));
    const p = sampleProject();
    const cfg = ['--config', writeConfig(p.deployDir, servers)];
    const result: Record<string, unknown> = { tool, servers: N };
    const step = async (name: string, args: string[]) => {
      const r = await runTool(tool, args, p.root, `${tool}-${N}-${name}`);
      const s: Record<string, unknown> = { code: r.code, totalS: +(r.ms / 1000).toFixed(1) };
      if (name.startsWith('deploy')) {
        s.buildEndToHealthyS = buildEndToHealthy(tool, r);
        if (tool === 'comet') s.phases = cometPhases(r);
      }
      result[name] = s;
      console.log(`[${tool} x${N}] ${name}: ${JSON.stringify(s)}`);
      if (r.code !== 0) throw new Error(`${tool} ${name} failed, see ${tool}-${N}-${name}.log`);
    };
    await step('setup', ['setup', ...cfg]);
    await step('deploy1-cold', ['deploy', ...cfg]);
    result.curl1 = await curlAll(servers);
    const main = join(p.appDir, 'server/main.js');
    writeFileSync(main, readFileSync(main, 'utf8').replace("'sample-app started'", "'sample-app started (bench change)'"));
    await step('deploy2-code-change', ['deploy', ...cfg]);
    result.curl2 = await curlAll(servers);
    return result;
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
  }
}

const results = [];
for (const tool of TOOLS) {
  try {
    results.push(await scenario(tool));
  } catch (err) {
    results.push({ tool, servers: N, error: (err as Error).message });
    console.log(`[${tool} x${N}] ERROR ${(err as Error).message}`);
  }
}
writeFileSync(join(OUT, `results-${N}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
