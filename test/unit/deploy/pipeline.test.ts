import { describe, expect, it } from 'vitest';
import type { BuiltImage } from '../../../src/build/index.js';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { deployPipeline, type PipelineDeps } from '../../../src/deploy/pipeline.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { HistoryEntry } from '../../../src/remote/ops.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

const MUP = (extra = '') => `module.exports = {
  servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw-one' }, two: { host: '192.0.2.2', username: 'root', password: 'pw-two' } },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {} }, env: { ROOT_URL: 'http://a.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
  ${extra}
};`;

async function setup(o: { extra?: string; activate?: Record<string, ActivationResult['status']>; strategy?: string } = {}) {
  const dir = tempDir({ '.deploy/mup.js': MUP(o.extra), '.deploy/settings.json': '{"public":{}}' });
  const lines: string[] = [];
  const reporter = createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) });
  const conns: Record<string, SshConnection> = {};
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js' },
    {
      cwd: dir,
      reporter,
      sshPoolFactory: () => ({
        get: async (name: string) => (conns[name] ??= { name, host: name } as unknown as SshConnection),
        closeAll: async () => {},
      }),
    },
  );
  const calls: string[] = [];
  const history: Record<string, HistoryEntry[]> = {};
  const origGetSettings = ctx.getSettings.bind(ctx);
  ctx.getSettings = () => {
    calls.push('settings');
    return origGetSettings();
  };
  const built: BuiltImage = { platform: 'linux/amd64', version: '20261107-183005', localTag: 'mup-myapp:20261107-183005', imageId: 'sha256:x', nodeVersion: '24.22.1', depsHash: 'd', fromCache: false };
  const deps: Partial<PipelineDeps> = {
    readGitInfo: async () => null,
    preflight: async (_c, servers) => {
      calls.push('preflight');
      return { errors: [], warnings: [], platformByServer: Object.fromEntries(servers.map((s) => [s, 'linux/amd64'])), platforms: ['linux/amd64'] };
    },
    buildApp: async () => {
      calls.push('build');
      return [built];
    },
    acquireLock: async (conn) => {
      calls.push(`lock:${conn.name}`);
      return { ok: true };
    },
    ensureLocalRegistry: async () => {
      calls.push('registry');
      return { port: 5555 };
    },
    pushToLocalRegistry: async (tag) => {
      calls.push('push');
      return tag;
    },
    distributeToServer: async (conn, x) => {
      calls.push(`distribute:${conn.name}:${x.targetTag}`);
      return { durationMs: 1 };
    },
    activateServer: async (d, x) => {
      calls.push(`activate:${d.serverName}:${x.version}`);
      return { server: d.serverName, status: o.activate?.[d.serverName] ?? 'healthy', durationMs: 1 };
    },
    appendHistory: async (conn, _app, e) => {
      calls.push(`history:${conn.name}`);
      (history[conn.name] ??= []).push(e);
    },
    pruneVersions: async (conn) => {
      calls.push(`prune:${conn.name}`);
      return [];
    },
    releaseLock: async (conn) => {
      calls.push(`release:${conn.name}`);
    },
    stopLocalRegistry: async () => {
      calls.push('stop-registry');
    },
  };
  return { ctx, deps, calls, history, output: () => lines.join('') };
}

describe('deployPipeline', () => {
  it('runs every phase in order', async () => {
    const s = await setup();
    const out = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(out.ok).toBe(true);
    expect(s.calls).toEqual([
      'preflight',
      'settings',
      'build',
      'lock:one',
      'lock:two',
      'registry',
      'push',
      'distribute:one:mup-myapp:20261107-183005',
      'distribute:two:mup-myapp:20261107-183005',
      'activate:one:20261107-183005',
      'activate:two:20261107-183005',
      'history:one',
      'history:two',
      'prune:one',
      'prune:two',
      'release:one',
      'release:two',
      'stop-registry',
    ]);
    expect(s.ctx.runner.history).toEqual(['meteor.deploy', 'meteor.push', 'meteor.build', 'meteor.prepareBundle', 'default.reconfig', 'meteor.envconfig', 'meteor.start']);
    expect(s.history.one[0]).toMatchObject({ action: 'deploy', result: 'success', version: '20261107-183005', servers: ['one', 'two'] });
  });

  it('refuses proxy and mongo configs (phase 2)', async () => {
    const p = await setup({ extra: "proxy: { domains: 'a.com' }," });
    await expect(deployPipeline(p.ctx, { cachedBuild: false, forceBuild: false }, p.deps)).rejects.toThrow(/phase 2/);
    const m = await setup({ extra: 'mongo: { servers: { one: {} } },' });
    await expect(deployPipeline(m.ctx, { cachedBuild: false, forceBuild: false }, m.deps)).rejects.toThrow(/phase 2/);
    expect(p.calls).toEqual([]);
  });

  it('stops before activation when aborted, releasing locks and the registry (Review Focus 2)', async () => {
    const s = await setup();
    const ac = new AbortController();
    const distribute = s.deps.distributeToServer!;
    s.deps.distributeToServer = async (conn, x) => {
      const r = await distribute(conn, x);
      if (conn.name === 'two') ac.abort();
      return r;
    };
    s.deps.signal = ac.signal;
    const p = deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    await expect(p).rejects.toThrow(CometError);
    await expect(p).rejects.toThrow('Deploy aborted');
    expect(s.calls.some((c) => c.startsWith('activate'))).toBe(false);
    expect(s.calls).toContain('release:one');
    expect(s.calls).toContain('release:two');
    expect(s.calls.at(-1)).toBe('stop-registry');
  });

  it('does not activate when distribution fails on one server', async () => {
    const s = await setup();
    s.deps.distributeToServer = async (conn) => {
      if (conn.name === 'two') throw new CometError('pull failed on two');
      return { durationMs: 1 };
    };
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow(/pull failed on two/);
    expect(s.calls.some((c) => c.startsWith('activate'))).toBe(false);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two', 'stop-registry']));
  });

  it('releases already acquired locks when another server is locked', async () => {
    const s = await setup();
    s.deps.acquireLock = async (conn) => {
      s.calls.push(`lock:${conn.name}`);
      return conn.name === 'two'
        ? { ok: false, holder: { user: 'alice', machine: 'laptop', pid: 1, startedAt: 'x', command: 'deploy', tool: 't' } }
        : { ok: true };
    };
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow(/alice/);
    expect(s.calls).toContain('release:one');
    expect(s.calls).not.toContain('release:two');
    expect(s.calls).not.toContain('registry');
  });

  it('canary revert: not ok, others skipped, history says reverted', async () => {
    const s = await setup({ activate: { one: 'reverted' } });
    const out = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(out.ok).toBe(false);
    expect(out.skipped).toEqual(['two']);
    expect(s.history.one[0].result).toBe('reverted');
    expect(s.history.two).toBeUndefined();
    expect(s.calls).not.toContain('activate:two:20261107-183005');
  });

  it('parallel with mixed results warns about mixed versions', async () => {
    const s = await setup({ activate: { one: 'reverted', two: 'healthy' } });
    const out = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false, strategy: 'parallel' }, s.deps);
    expect(out.ok).toBe(false);
    expect(s.output()).toContain('MIXED VERSIONS');
    expect(s.output()).toContain('comet-deploy rollback');
    expect(s.calls).toContain('prune:two');
    expect(s.calls).not.toContain('prune:one');
  });

  it('meteor build / push stop early', async () => {
    const b = await setup();
    await deployPipeline(b.ctx, { cachedBuild: false, forceBuild: false, stopAfter: 'build' }, b.deps);
    expect(b.calls).toEqual(['preflight', 'settings', 'build']);
    const p = await setup();
    await deployPipeline(p.ctx, { cachedBuild: false, forceBuild: false, stopAfter: 'push' }, p.deps);
    expect(p.calls.some((c) => c.startsWith('activate'))).toBe(false);
    expect(p.calls).toContain('distribute:two:mup-myapp:20261107-183005');
    expect(p.calls).toEqual(expect.arrayContaining(['release:one', 'release:two', 'stop-registry']));
  });
});
