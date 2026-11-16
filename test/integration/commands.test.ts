/**
 * `ssh`, the full `status` and `meteor debug` against two fake servers (commands plan Task 6):
 * s1 allows SSH TCP forwarding, n1 does not, so the debugger goes through docker exec there.
 */
import { get } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSsh } from '../../src/cli/commands/ssh.js';
import { createContext, type CommandContext } from '../../src/core/context.js';
import { createReporter } from '../../src/output/reporter.js';
import { debugApp } from '../../src/remote/debug.js';
import type { LocalTerminal } from '../../src/ssh/interactive.js';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, sampleProject, writeTestConfig } from './helpers.js';

const SECRET = 'do-not-print-4711';

/** GETs `path` on 127.0.0.1:`port` without keep-alive and returns the body. */
function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

describe('ssh, status and meteor debug', () => {
  let s1: FakeServer;
  let n1: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const configPath = () => join(p.deployDir, 'mup.js');
  const config = () => ['--config', configPath()];

  /** A context whose reporter output is collected in `out`. */
  async function context(): Promise<{ ctx: CommandContext; out: string[] }> {
    const out: string[] = [];
    const ctx = await createContext({ config: configPath() }, { cwd: p.root, reporter: createReporter({ verbose: false, tty: false, write: (s) => out.push(s) }) });
    return { ctx, out };
  }

  beforeAll(async () => {
    [[s1], [n1]] = await Promise.all([startFakeServers(1), startFakeServers(1, { allowTcpForwarding: false, namePrefix: 'n' })]);
    p = sampleProject();
    writeTestConfig(p.deployDir, [s1, n1], { env: { SECRET_TOKEN: SECRET } });
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
  });

  afterAll(async () => {
    await Promise.all([s1?.stop(), n1?.stop()]);
  });

  it('ssh runs a command and passes its exit code', async () => {
    const { ctx } = await context();
    let printed = '';
    const sink = Object.assign(new EventEmitter(), { write: (d: Buffer | string) => ((printed += String(d)), true) });
    const term = { stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: sink, stderr: sink } as unknown as LocalTerminal;
    try {
      await runSsh(ctx, ['s1', 'echo', 'hi'], term);
      expect(printed).toContain('hi');
      await expect(runSsh(ctx, ['n1', 'false'], term)).rejects.toMatchObject({ exitCode: 1 });
    } finally {
      await ctx.ssh.closeAll();
    }
  });

  it('status shows one section per server with env names but no values', async () => {
    const r = await cli(['status', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    for (const s of [s1, n1]) expect(r.output).toContain(`== ${s.name} (127.0.0.1)`);
    expect(r.output).toMatch(/Version: {4}\d{8}-\d{6}/);
    expect(r.output).toMatch(/Env: {8}\d+ variables: .*ROOT_URL/);
    expect(r.output).toContain('SECRET_TOKEN');
    expect(r.output).not.toContain(SECRET);
    // The reporter masks SECRET whatever status.sh prints; a value from outside the config (the
    // image's PATH) and the mask itself show whether a value left the server at all.
    expect(r.output).toMatch(/Env: .*\bPATH\b/);
    expect(r.output).not.toContain('/usr/local/sbin');
    expect(r.output).not.toContain('***');
    expect(r.output).toMatch(/HTTP: {7}200 on the server/);

    const overview = await cli(['status', '--overview', ...config()], p.root);
    expect(overview.code, overview.output).toBe(0);
    expect(overview.output).not.toContain('== s1');
  });

  for (const which of ['s1', 'n1'] as const) {
    it(`meteor debug on ${which} reaches the inspector and leaves nothing behind`, async () => {
      const server = which === 's1' ? s1 : n1;
      const portsBefore = (await server.exec("docker ps --format '{{.Names}} {{.Ports}}'")).stdout.trim();
      const { ctx, out } = await context();
      const ac = new AbortController();
      const done = debugApp(ctx, { words: [which], port: 0, signal: ac.signal });
      try {
        let port = 0;
        for (let i = 0; i < 600 && !port; i++) {
          const m = out.join('').match(/ws:\/\/127\.0\.0\.1:(\d+)/);
          if (m) port = Number(m[1]);
          else await Promise.race([new Promise((r) => setTimeout(r, 200)), done]);
        }
        expect(port, out.join('')).toBeGreaterThan(0);
        const version = JSON.parse(await httpGet(port, '/json/version')) as { Browser?: string };
        expect(version.Browser).toMatch(/^node\.js\//);
        if (which === 'n1') expect(out.join('')).toContain('SSH TCP forwarding is off on "n1"');
        else expect(out.join('')).not.toContain('SSH TCP forwarding is off');
      } finally {
        ac.abort();
        await done;
        await ctx.ssh.closeAll();
      }
      expect((await server.exec(`docker ps -a --filter name=${APP_NAME}-debug --format '{{.Names}}'`)).stdout.trim()).toBe('');
      expect((await server.exec("docker ps --format '{{.Names}} {{.Ports}}'")).stdout.trim()).toBe(portsBefore);
    });
  }
});
