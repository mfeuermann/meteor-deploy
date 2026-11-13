import { describe, expect, it } from 'vitest';
import type { BuiltImage } from '../../../src/build/index.js';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { deployPipeline, holdsLock, lockServers, restartPipeline, type PipelineDeps } from '../../../src/deploy/pipeline.js';
import { createProxyRollout } from '../../../src/proxy/rollout.js';
import { createReporter } from '../../../src/output/reporter.js';
import { SetupMissingError, type HistoryEntry } from '../../../src/remote/ops.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';
import { fakeProxyDeps, inSyncState } from '../../helpers/proxy.js';

const MUP = (extra = '') => `module.exports = {
  servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw-one' }, two: { host: '192.0.2.2', username: 'root', password: 'pw-two' } },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {} }, env: { ROOT_URL: 'http://a.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
  ${extra}
};`;

async function setup(o: { extra?: string; activate?: Record<string, ActivationResult['status']>; strategy?: string; servers?: string } = {}) {
  const dir = tempDir({ '.deploy/mup.js': MUP(o.extra), '.deploy/settings.json': '{"public":{}}' });
  const lines: string[] = [];
  const reporter = createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) });
  const conns: Record<string, SshConnection> = {};
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js', ...(o.servers ? { servers: o.servers } : {}) },
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
    preflight: async (_c, servers, p) => {
      calls.push(p.proxyServers?.length ? `preflight:proxy=${p.proxyServers.join(',')}` : 'preflight');
      return { errors: [], warnings: [], platformByServer: Object.fromEntries(servers.map((s) => [s, 'linux/amd64'])), platforms: ['linux/amd64'], streamServers: [] };
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
      calls.push(`activate:${d.serverName}:${x.version}${x.switch ? `:${x.switch.kind}` : ''}`);
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
    pruneImages: async (conn) => {
      calls.push(`prune-images:${conn.name}`);
    },
    readHistory: async () => [],
    releaseLock: async (conn) => {
      calls.push(`release:${conn.name}`);
    },
    stopLocalRegistry: async () => {
      calls.push('stop-registry');
      return true;
    },
  };
  return { ctx, deps, calls, history, output: () => lines.join('') };
}

/** A `hooks` section whose method hooks push `hook:<name>` into the array of `withCalls`. */
const recordHooks = (names: string[]) => `hooks: { ${names.map((n) => `'${n}': () => void globalThis.__hookCalls.push('hook:${n}')`).join(', ')} },`;

/** Runs `fn` with `globalThis.__hookCalls` pointing at `calls`. */
async function withCalls<T>(calls: string[], fn: () => Promise<T>): Promise<T> {
  (globalThis as { __hookCalls?: string[] }).__hookCalls = calls;
  try {
    return await fn();
  } finally {
    delete (globalThis as { __hookCalls?: string[] }).__hookCalls;
  }
}

describe('deployPipeline', () => {
  it('hands the build cache import and export to the build', async () => {
    const s = await setup();
    const build = s.deps.buildApp!;
    let got: unknown;
    s.deps.buildApp = async (c, o) => {
      got = o;
      return build(c, o);
    };
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false, cacheFrom: ['type=local,src=/c'], cacheTo: ['type=local,dest=/c'] }, s.deps);
    expect(got).toMatchObject({ cacheFrom: ['type=local,src=/c'], cacheTo: ['type=local,dest=/c'] });
  });

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
      'settings',
      'activate:one:20261107-183005',
      'activate:two:20261107-183005',
      'history:one',
      'history:two',
      'prune:one',
      'prune:two',
      'prune-images:one',
      'prune-images:two',
      'release:one',
      'release:two',
      'stop-registry',
    ]);
    expect(s.ctx.runner.history).toEqual(['meteor.deploy', 'meteor.push', 'meteor.build', 'meteor.prepareBundle', 'default.reconfig', 'meteor.envconfig', 'meteor.start']);
    expect(s.history.one[0]).toMatchObject({ action: 'deploy', result: 'success', version: '20261107-183005', servers: ['one', 'two'] });
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

  it('gives the "wait for the other deploy" hint only for a held lock', async () => {
    const s = await setup();
    s.deps.acquireLock = async (conn) => {
      if (conn.name === 'two') throw new CometError('[two] /opt/myapp/config does not exist. Run "comet-deploy setup" first.');
      return { ok: true };
    };
    const err = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps).catch((e: CometError) => e);
    expect((err as CometError).message).toMatch(/setup/);
    expect((err as CometError).hint).toBeUndefined();
  });

  it('keeps the hint of a server error when the servers cannot be locked', async () => {
    const s = await setup();
    s.deps.acquireLock = async (conn) => {
      if (conn.name === 'two') throw new CometError('[two] Cannot write to /opt/myapp/config: No such file', { hint: 'Run "comet-deploy setup" first.' });
      return { ok: true };
    };
    const err = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps).catch((e: CometError) => e);
    expect((err as CometError).message).toMatch(/Cannot write to \/opt\/myapp\/config/);
    expect((err as CometError).hint).toBe('Run "comet-deploy setup" first.');
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
    // I3: only the servers that got the new version roll back
    expect(s.output()).toContain('comet-deploy rollback --servers two');
    expect(s.calls).toContain('prune:two');
    expect(s.calls).not.toContain('prune:one');
  });

  it('Ctrl+C during the canary: the other servers are not touched, locks released, exit 130 after the summary (I2)', async () => {
    const s = await setup();
    const ac = new AbortController();
    const activate = s.deps.activateServer!;
    s.deps.activateServer = async (d, x) => {
      const r = await activate(d, x);
      ac.abort();
      return r;
    };
    const err = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, { ...s.deps, signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(CometError);
    expect(err.exitCode).toBe(130);
    expect(s.calls).toContain('activate:one:20261107-183005');
    expect(s.calls).not.toContain('activate:two:20261107-183005');
    expect(s.calls).toEqual(expect.arrayContaining(['history:one', 'release:one', 'release:two', 'stop-registry']));
    expect(s.output()).toMatch(/two\s+-\s+skipped/);
  });

  it('names the version the servers run after a build-cache hit (M1)', async () => {
    const cached = '20261101-090000';
    const s = await setup({ activate: { one: 'reverted', two: 'healthy' } });
    s.deps.buildApp = async () => [{ platform: 'linux/amd64', version: cached, localTag: `mup-myapp:${cached}`, imageId: 'sha256:x', nodeVersion: '24', depsHash: 'd', fromCache: true }];
    const out = await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false, strategy: 'parallel' }, s.deps);
    expect(out.version).toBe(cached);
    expect(s.output()).toContain(`two run ${cached}`);
  });

  it('removes versions that only failed on a server when pruning (M2) and prunes dangling images (M9)', async () => {
    const s = await setup();
    const seen: Record<string, string[]> = {};
    s.deps.readHistory = async (conn) =>
      conn.name === 'one'
        ? [{ version: '20261101-000000', action: 'deploy', result: 'reverted', startedAt: 'x', durationMs: 1, user: 'u', machine: 'm', servers: ['one'], tool: 't' }]
        : [];
    s.deps.pruneVersions = async (conn, _repo, _keep, o) => {
      seen[conn.name] = [...(o?.failed ?? [])];
      return [];
    };
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(seen).toEqual({ one: ['20261101-000000'], two: [] });
    expect(s.calls).toEqual(expect.arrayContaining(['prune-images:one', 'prune-images:two']));
  });

  it('refuses settings too large for env.list before building anything (M11)', async () => {
    const s = await setup();
    s.ctx.getSettings = () => ({ big: 'y'.repeat(70 * 1024) });
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow(/64 KiB/);
    expect(s.calls).not.toContain('build');
    expect(s.calls.some((c) => c.startsWith('lock:'))).toBe(false);
  });

  it('runs the hooks around the deploy steps where MUP runs them', async () => {
    const names = ['meteor.deploy', 'meteor.push', 'meteor.build', 'meteor.prepareBundle', 'default.reconfig', 'meteor.envconfig', 'meteor.start'].flatMap((k) => [`pre.${k}`, `post.${k}`]);
    const s = await setup({ extra: recordHooks(names) });
    await withCalls(s.calls, () => deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps));
    const at = (c: string) => s.calls.indexOf(c);
    for (const n of names) expect(at(`hook:${n}`), n).toBeGreaterThanOrEqual(0);
    expect(at('hook:pre.meteor.push')).toBeLessThan(at('build'));
    expect(at('hook:post.meteor.build')).toBeLessThan(at('lock:one'));
    expect(at('hook:pre.meteor.prepareBundle')).toBeGreaterThan(at('lock:two'));
    expect(at('hook:post.meteor.push')).toBeGreaterThan(at('distribute:two:mup-myapp:20261107-183005'));
    expect(at('hook:post.meteor.envconfig')).toBeLessThan(at('hook:pre.meteor.start'));
    expect(at('hook:pre.meteor.start')).toBeLessThan(at('activate:one:20261107-183005'));
    expect(at('hook:post.meteor.start')).toBeGreaterThan(at('history:two'));
    expect(at('hook:post.default.reconfig')).toBeLessThan(at('release:one'));
    expect(at('hook:post.meteor.deploy')).toBeGreaterThan(at('release:two'));
  });

  it('a failing pre.meteor.start hook stops the deploy before the activation and releases the locks', async () => {
    const s = await setup({ extra: "hooks: { 'pre.meteor.start': { localCommand: 'exit 4' } }," });
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow('exited with code 4');
    expect(s.calls.some((c) => c.startsWith('activate'))).toBe(false);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two', 'stop-registry']));
  });

  it('a failing post.meteor.start hook keeps the history of the activated servers and releases the locks', async () => {
    const s = await setup({ extra: "hooks: { 'post.meteor.start': { localCommand: 'exit 5' } }," });
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow('exited with code 5');
    expect(s.calls).toEqual(expect.arrayContaining(['history:one', 'history:two', 'release:one', 'release:two', 'stop-registry']));
    expect(s.calls.some((c) => c.startsWith('prune'))).toBe(false);
  });

  it('a failing post.meteor.start hook still prints the summary of the activated servers', async () => {
    const s = await setup({ extra: "hooks: { 'post.meteor.start': { localCommand: 'exit 5' } }," });
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow('exited with code 5');
    expect(s.output()).toContain('SERVER');
    expect(s.output()).toMatch(/one\s.*20261107-183005/);
    expect(s.output()).toMatch(/two\s.*20261107-183005/);
  });

  it('a failing post.meteor.prepareBundle hook drops the registry lease', async () => {
    const s = await setup({ extra: "hooks: { 'post.meteor.prepareBundle': { localCommand: 'exit 6' } }," });
    await expect(deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps)).rejects.toThrow('exited with code 6');
    expect(s.calls.some((c) => c.startsWith('activate'))).toBe(false);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two', 'stop-registry']));
  });

  it('a failed activation runs no post hooks', async () => {
    const s = await setup({ activate: { two: 'reverted' }, strategy: 'parallel', extra: recordHooks(['pre.meteor.start', 'post.meteor.start', 'post.default.reconfig', 'post.meteor.deploy']) });
    const out = await withCalls(s.calls, () => deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps));
    expect(out.ok).toBe(false);
    expect(s.calls.filter((c) => c.startsWith('hook:'))).toEqual(['hook:pre.meteor.start']);
  });

  it('settings replaced in pre.default.reconfig reach the activation', async () => {
    const s = await setup({ extra: "hooks: { 'pre.reconfig'(api) { api.settings = { public: { fromHook: 1 } }; } }," });
    const got: unknown[] = [];
    const activate = s.deps.activateServer!;
    s.deps.activateServer = async (d, x) => (got.push(d.settings), activate(d, x));
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(got).toEqual([{ public: { fromHook: 1 } }, { public: { fromHook: 1 } }]);
  });

  it('a config replaced in pre.meteor.start reaches the activation', async () => {
    const s = await setup({
      extra: "hooks: { 'pre.meteor.start'(api) { const c = api.getConfig(); api.setConfig({ ...c, app: { ...c.app, env: { ...c.app.env, FROM_HOOK: 'yes' } } }); } },",
    });
    const got: unknown[] = [];
    const activate = s.deps.activateServer!;
    s.deps.activateServer = async (d, x) => (got.push(d.config.app.env.FROM_HOOK), activate(d, x));
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(got).toEqual(['yes', 'yes']);
  });

  it('holdsLock is true inside the lock and false after it', async () => {
    const s = await setup();
    const seen: boolean[] = [];
    const activate = s.deps.activateServer!;
    s.deps.activateServer = async (d, x) => (seen.push(holdsLock(s.ctx)), activate(d, x));
    expect(holdsLock(s.ctx)).toBe(false);
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false }, s.deps);
    expect(seen).toEqual([true, true]);
    expect(holdsLock(s.ctx)).toBe(false);
  });

  it('meteor build only runs under meteor.build, like MUP', async () => {
    const s = await setup({ extra: "hooks: { 'pre.meteor.deploy': {}, 'post.meteor.push': {} }," });
    await deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false, stopAfter: 'build' }, s.deps);
    expect(s.calls).toEqual(['preflight', 'settings', 'build']);
    expect(s.ctx.runner.history).toEqual(['meteor.build']);
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

  it('lockServers: of two commands that lock the same servers at once, exactly one gets them', async () => {
    const s = await setup();
    const deps = s.deps as PipelineDeps;
    const held = new Map<string, string>();
    // "a" is slow on "two" and "b" on "one": locking in parallel, each would get one server first.
    const slow = new Set(['a:two', 'b:one']);
    deps.acquireLock = async (conn, _app, info) => {
      await new Promise((r) => setTimeout(r, slow.has(`${info.command}:${conn.name}`) ? 30 : 1));
      const holder = held.get(conn.name);
      if (holder) return { ok: false, holder: { ...info, command: holder } };
      held.set(conn.name, info.command);
      return { ok: true };
    };
    // Releasing is a round trip to the server too.
    deps.releaseLock = async (conn) => {
      await new Promise((r) => setTimeout(r, 50));
      held.delete(conn.name);
    };
    const results = await Promise.allSettled([lockServers(s.ctx, ['one', 'two'], 'a', deps), lockServers(s.ctx, ['two', 'one'], 'b', deps)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('lockServers with skipNotSetUp skips a server that is not set up and still reports other errors', async () => {
    const s = await setup();
    const deps = s.deps as PipelineDeps;
    deps.acquireLock = async (conn) => {
      if (conn.name === 'two') throw new SetupMissingError('[two] /opt/myapp/config does not exist.', { hint: 'Run "comet-deploy setup" first.' });
      return { ok: true };
    };
    expect(await lockServers(s.ctx, ['one', 'two'], 'proxy setup', deps, { skipNotSetUp: true })).toEqual(['one']);
    await expect(lockServers(s.ctx, ['one', 'two'], 'proxy setup', deps)).rejects.toThrow(/does not exist/);
    deps.acquireLock = async (conn) => {
      if (conn.name === 'two') throw new CometError('[two] Acquiring the deploy lock failed (exit code 1)');
      return { ok: true };
    };
    await expect(lockServers(s.ctx, ['one', 'two'], 'proxy setup', deps, { skipNotSetUp: true })).rejects.toThrow(/exit code 1/);
  });
});

describe('pipelines behind the proxy', () => {
  const V = '20261107-183005';
  const LE = "proxy: { domains: 'a.com' },";
  const LB = "proxy: { domains: 'a.com', loadBalancing: true },";
  const deploy = (s: Awaited<ReturnType<typeof setup>>, o: { strategy?: 'canary' | 'rolling' | 'parallel' } = {}) =>
    deployPipeline(s.ctx, { cachedBuild: false, forceBuild: false, ...o }, s.deps);
  /** The real rollout over fake proxy servers `one` and `two` in the given state. */
  async function withProxies(s: Awaited<ReturnType<typeof setup>>, lb: 'keep' | 'off', o: Parameters<typeof fakeProxyDeps>[2] = {}) {
    const state = await inSyncState(s.ctx, { lb });
    const d = fakeProxyDeps({ one: state, two: state }, s.calls, o);
    s.deps.createProxyRollout = (ctx, x) => createProxyRollout(ctx, x, d);
  }
  const flow = (calls: string[]) => calls.filter((c) => /^(drain|activate|healthy|finalize):/.test(c));

  it('deploy: preflight checks the proxy servers, the rollout wraps the activation and finishes before the unlock', async () => {
    const s = await setup({ extra: LE });
    s.deps.createProxyRollout = async (_ctx, o) => {
      s.calls.push(`proxy:create:${o.action}`);
      return {
        prepare: async () => void s.calls.push('proxy:prepare'),
        activate: async (server, run) => {
          s.calls.push(`proxy:activate:${server}`);
          return run({ kind: 'zero-downtime' });
        },
        finish: async (results) => {
          s.calls.push(`proxy:finish:${results.length}`);
          return ['a proxy warning'];
        },
      };
    };
    const out = await deploy(s);
    expect(out.ok).toBe(true);
    expect(s.calls).toEqual([
      'preflight:proxy=one,two',
      'settings',
      'proxy:create:deploy',
      'build',
      'lock:one',
      'lock:two',
      'registry',
      'push',
      `distribute:one:mup-myapp:${V}`,
      `distribute:two:mup-myapp:${V}`,
      'proxy:prepare',
      'settings',
      'proxy:activate:one',
      `activate:one:${V}:zero-downtime`,
      'proxy:activate:two',
      `activate:two:${V}:zero-downtime`,
      'history:one',
      'history:two',
      'prune:one',
      'prune:two',
      'prune-images:one',
      'prune-images:two',
      'proxy:finish:2',
      'release:one',
      'release:two',
      'stop-registry',
    ]);
    expect(s.output().indexOf('a proxy warning')).toBeGreaterThan(s.output().indexOf('SERVER'));
  });

  it('a missing nginxServerConfig fails before the build (Review Focus 5)', async () => {
    const s = await setup({ extra: "proxy: { domains: 'a.com', nginxServerConfig: './missing.conf' }," });
    await expect(deploy(s)).rejects.toThrow(/proxy\.nginxServerConfig/);
    expect(s.calls).not.toContain('build');
    expect(s.calls.some((c) => c.startsWith('lock:'))).toBe(false);
  });

  it('load balancing, canary: drain → activate → healthy, server by server', async () => {
    const s = await setup({ extra: LB });
    await withProxies(s, 'keep');
    expect((await deploy(s)).ok).toBe(true);
    expect(flow(s.calls)).toEqual([
      'drain:one',
      `activate:one:${V}:restart`,
      'healthy:one',
      'drain:two',
      `activate:two:${V}:restart`,
      'healthy:two',
      'finalize:',
    ]);
  });

  it('load balancing, parallel: no drain', async () => {
    const s = await setup({ extra: LB });
    await withProxies(s, 'keep');
    await deploy(s, { strategy: 'parallel' });
    expect(s.calls.some((c) => c.startsWith('drain:'))).toBe(false);
  });

  it('load balancing, revert-failed on two: two stays down and the summary says how to bring it back', async () => {
    const s = await setup({ extra: LB, activate: { two: 'revert-failed' } });
    await withProxies(s, 'keep');
    expect((await deploy(s)).ok).toBe(false);
    expect(s.calls).toContain('finalize:two');
    expect(s.output()).toContain('comet-deploy restart --servers two');
  });

  it('Ctrl+C after one: the rollout still finishes, two is neither drained nor deployed (Review Focus 3)', async () => {
    const s = await setup({ extra: LB });
    await withProxies(s, 'keep');
    const ac = new AbortController();
    const activate = s.deps.activateServer!;
    s.deps.activateServer = async (d, x) => {
      const r = await activate(d, x);
      ac.abort();
      return r;
    };
    s.deps.signal = ac.signal;
    await expect(deploy(s)).rejects.toThrow('Deploy aborted');
    expect(flow(s.calls)).toEqual(['drain:one', `activate:one:${V}:restart`, 'healthy:one', 'finalize:']);
    expect(s.calls.indexOf('finalize:')).toBeLessThan(s.calls.indexOf('release:one'));
  });

  it('a proxy that cannot be written does not stop the deploy, and the summary names it (Review Focus 4)', async () => {
    const s = await setup({ extra: LB });
    await withProxies(s, 'keep', { failWrite: 'two' });
    const out = await deploy(s);
    expect(out.results.map((r) => r.status)).toEqual(['healthy', 'healthy']);
    expect(s.output()).toMatch(/"two".*connection refused/);
  });

  it('load balancing locks every app server, also for --servers one', async () => {
    const s = await setup({ extra: LB, servers: 'one' });
    await withProxies(s, 'keep');
    await deploy(s);
    expect(s.calls.filter((c) => c.startsWith('lock:'))).toEqual(['lock:one', 'lock:two']);
    expect(s.calls.filter((c) => c.startsWith('activate:'))).toEqual([`activate:one:${V}:restart`]);
    expect(s.calls).toEqual(expect.arrayContaining(['release:one', 'release:two']));
  });

  it('enabling load balancing writes the upstream only after every server is healthy', async () => {
    const s = await setup({ extra: LB });
    await withProxies(s, 'off');
    await deploy(s);
    // Until the upstream exists nginx routes to the containers, so the servers switch without a gap.
    const lastActivation = s.calls.indexOf(`activate:two:${V}:zero-downtime`);
    expect(lastActivation).toBeGreaterThan(-1);
    const enable = s.calls.indexOf('sync:after:one:lb-enable+service');
    expect(enable).toBeGreaterThan(lastActivation);
    expect(enable).toBeLessThan(s.calls.indexOf('release:one'));

    const f = await setup({ extra: LB, activate: { two: 'reverted' }, strategy: 'parallel' });
    await withProxies(f, 'off');
    await deploy(f, { strategy: 'parallel' });
    expect(f.calls.some((c) => c.startsWith('sync:after'))).toBe(false);
    expect(f.output()).toContain('loadBalancing was not enabled on the proxies because two did not deploy; run the deploy again');
  });

  it('restart with the zero-downtime switch does not stop the app first', async () => {
    const s = await setup({ extra: LE });
    await withProxies(s, 'off');
    s.deps.startServer = async (d, x) => {
      s.calls.push(`start:${d.serverName}:${x?.switch?.kind ?? 'none'}`);
      return { server: d.serverName, status: 'healthy', durationMs: 1 };
    };
    const out = await restartPipeline(s.ctx, {}, s.deps);
    expect(out.ok).toBe(true);
    expect(s.calls.filter((c) => c.startsWith('start:'))).toEqual(['start:one:zero-downtime', 'start:two:zero-downtime']);
  });
});
