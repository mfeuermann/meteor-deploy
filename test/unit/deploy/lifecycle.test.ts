import { describe, expect, it } from 'vitest';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { reconfigPipeline, restartPipeline, startAll, stopAll, type PipelineDeps } from '../../../src/deploy/pipeline.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

const MUP = `module.exports = {
  servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' }, two: { host: '192.0.2.2', username: 'root', password: 'pw' } },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
};`;

/** Fake connection: records scripts by a short label, health answer configurable, 10 ms per call. */
function fakeConn(name: string, health: string, log: string[], timeline: Array<[string, 'start' | 'end']>) {
  const label = (s: string) =>
    s.includes('COMET_HEALTH') ? 'health' : s.includes('# start app') ? 'meteor-start' : s.includes('docker stop') || s.includes('docker rm -f') ? 'meteor-stop' : s.includes('echo "activated"') ? 'retag' : s.trim().slice(0, 40);
  const res = async (s: string): Promise<ExecResult> => {
    const l = label(s);
    log.push(`${name}:${l}`);
    timeline.push([name, 'start']);
    await new Promise((r) => setTimeout(r, 10));
    timeline.push([name, 'end']);
    return { code: 0, stdout: l === 'health' ? health : '', stderr: '' };
  };
  return { name, host: name, runScript: res, runScriptOrThrow: res, exec: res, writeFile: async () => void log.push(`${name}:write`) } as unknown as SshConnection;
}

async function setup(health = 'COMET_HEALTH ok 200 1\n') {
  const dir = tempDir({ '.deploy/mup.js': MUP, '.deploy/settings.json': '{"public":{}}' });
  const out: string[] = [];
  const log: string[] = [];
  const timeline: Array<[string, 'start' | 'end']> = [];
  const conns: Record<string, SshConnection> = {};
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js' },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({ get: async (n: string) => (conns[n] ??= fakeConn(n, health, log, timeline)), closeAll: async () => {} }),
    },
  );
  const calls: string[] = [];
  const deps: Partial<PipelineDeps> = {
    acquireLock: async (c) => (calls.push(`lock:${c.name}`), { ok: true }),
    releaseLock: async (c) => void calls.push(`release:${c.name}`),
    appendHistory: async (c, _a, e) => void calls.push(`history:${c.name}:${e.action}:${e.result}`),
  };
  return { ctx, deps, calls, log, timeline, out: () => out.join('') };
}

describe('reconfigPipeline', () => {
  it('activates in reconfig mode with the MUP command keys', async () => {
    const s = await setup();
    const seen: Array<{ version: string | null; mode: string }> = [];
    s.deps.activateServer = async (d, o) => {
      seen.push(o);
      return { server: d.serverName, status: 'healthy', durationMs: 1 } as ActivationResult;
    };
    const out = await reconfigPipeline(s.ctx, {}, s.deps);
    expect(out.ok).toBe(true);
    expect(seen).toEqual([{ version: null, mode: 'reconfig' }, { version: null, mode: 'reconfig' }]);
    expect(s.ctx.runner.history).toEqual(['default.reconfig', 'meteor.envconfig', 'meteor.start']);
    expect(s.calls).toEqual(['lock:one', 'lock:two', 'history:one:reconfig:success', 'history:two:reconfig:success', 'release:one', 'release:two']);
  });

  it('releases the locks when activation throws', async () => {
    const s = await setup();
    s.deps.activateServer = async () => {
      throw new CometError('boom');
    };
    s.deps.appendHistory = async () => {
      throw new Error('history down');
    };
    const out = await reconfigPipeline(s.ctx, { strategy: 'parallel' }, s.deps);
    expect(out.ok).toBe(false);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two']));
  });
});

describe('restartPipeline', () => {
  it('stops, starts and checks health without retagging; a failed check is not ok', async () => {
    const s = await setup('COMET_HEALTH fail timeout 503 60\n');
    const out = await restartPipeline(s.ctx, {}, s.deps);
    expect(out.ok).toBe(false);
    expect(out.skipped).toEqual(['two']);
    expect(s.log.filter((l) => l.startsWith('one:'))).toEqual(expect.arrayContaining(['one:meteor-stop', 'one:meteor-start', 'one:health']));
    expect(s.log.some((l) => l.endsWith(':retag'))).toBe(false);
    expect(s.calls).toContain('history:one:restart:failed');
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two']));
  });
});

describe('Ctrl+C in reconfig / restart / rollback (I1)', () => {
  it('restart: stops before the next server, releases the locks and exits 130', async () => {
    const s = await setup();
    const ac = new AbortController();
    s.deps.startServer = async (d) => {
      ac.abort();
      return { server: d.serverName, status: 'healthy', durationMs: 1 };
    };
    const err = await restartPipeline(s.ctx, { strategy: 'rolling' }, { ...s.deps, signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(CometError);
    expect(err.exitCode).toBe(130);
    expect(s.log.filter((l) => l.endsWith(':meteor-stop'))).toEqual(['one:meteor-stop']);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two']));
  });

  it('reconfig: an abort before the rollout changes nothing and still releases the locks', async () => {
    const s = await setup();
    const ac = new AbortController();
    ac.abort();
    const seen: string[] = [];
    s.deps.activateServer = async (d) => (seen.push(d.serverName), { server: d.serverName, status: 'healthy', durationMs: 1 });
    await expect(reconfigPipeline(s.ctx, {}, { ...s.deps, signal: ac.signal })).rejects.toMatchObject({ exitCode: 130 });
    expect(seen).toEqual([]);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two']));
  });
});

describe('start / stop', () => {
  function overlapped(timeline: Array<[string, 'start' | 'end']>): boolean {
    const firstEnd = timeline.findIndex(([, e]) => e === 'end');
    return new Set(timeline.slice(0, firstEnd).filter(([, e]) => e === 'start').map(([n]) => n)).size > 1;
  }

  it('stop runs on all servers in parallel', async () => {
    const s = await setup();
    await stopAll(s.ctx);
    expect(s.log.sort()).toEqual(['one:meteor-stop', 'two:meteor-stop']);
    expect(overlapped(s.timeline)).toBe(true);
  });

  it('start runs in parallel and reports the health check', async () => {
    const s = await setup();
    const results = await startAll(s.ctx);
    expect(results.map((r) => r.status)).toEqual(['healthy', 'healthy']);
    expect(s.log).toEqual(expect.arrayContaining(['one:meteor-start', 'one:health', 'two:meteor-start', 'two:health']));
    expect(overlapped(s.timeline)).toBe(true);
    expect(s.out()).toMatch(/\[one\] health ✓ HTTP 200/);
  });
});
