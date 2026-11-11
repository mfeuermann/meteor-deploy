import { describe, expect, it } from 'vitest';
import { formatHistoryTable } from '../../../src/cli/commands/history.js';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { mergeHistory } from '../../../src/deploy/history.js';
import {
  deployPipeline,
  reconfigPipeline,
  restartPipeline,
  rollbackPipeline,
  type PipelineDeps,
} from '../../../src/deploy/pipeline.js';
import { chooseRollbackTarget } from '../../../src/deploy/rollback.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { HistoryEntry, ImageVersions } from '../../../src/remote/ops.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

const V3 = '20261103-100000';
const V2 = '20261102-100000';
const V1 = '20261101-100000';
const three: ImageVersions = { latestId: 'c', previousId: 'b', versions: [{ tag: V3, id: 'c' }, { tag: V2, id: 'b' }, { tag: V1, id: 'a' }] };

describe('chooseRollbackTarget (Review Focus 4)', () => {
  it('picks the version below the one that runs', () => {
    expect(chooseRollbackTarget(three)).toEqual({ kind: 'version', tag: V2 });
  });

  it('picks the requested version', () => {
    expect(chooseRollbackTarget(three, V1)).toEqual({ kind: 'version', tag: V1 });
  });

  it('refuses an unknown version and lists what is available', () => {
    const t = chooseRollbackTarget(three, 'nope');
    expect(t.kind).toBe('none');
    expect(t.kind === 'none' && t.reason).toContain(V1);
    expect(t.kind === 'none' && t.reason).toContain(V3);
  });

  it('uses :previous on a server deployed only by MUP', () => {
    expect(chooseRollbackTarget({ latestId: 'l', previousId: 'p', versions: [] })).toEqual({ kind: 'previous' });
  });

  it('has nothing to roll back to without versions and :previous', () => {
    expect(chooseRollbackTarget({ latestId: 'l', previousId: null, versions: [] }).kind).toBe('none');
  });

  it('when MUP deployed in between (latest is no kept version) takes the newest kept version', () => {
    expect(chooseRollbackTarget({ ...three, latestId: 'mup' })).toEqual({ kind: 'version', tag: V3 });
  });

  it('only picks versions that ran successfully when the history is known (M2)', () => {
    expect(chooseRollbackTarget(three, undefined, new Set([V3, V1]))).toEqual({ kind: 'version', tag: V1 });
    expect(chooseRollbackTarget({ ...three, previousId: 'p' }, undefined, new Set([V3]))).toEqual({ kind: 'previous' });
    expect(chooseRollbackTarget({ ...three, latestId: 'mup' }, undefined, new Set([V2]))).toEqual({ kind: 'version', tag: V2 });
    // --to is explicit: the history does not filter it
    expect(chooseRollbackTarget(three, V2, new Set([V3]))).toEqual({ kind: 'version', tag: V2 });
  });

  it('falls back to :previous when the running version is the oldest kept one', () => {
    expect(chooseRollbackTarget({ latestId: 'a', previousId: 'p', versions: [{ tag: V1, id: 'a' }] })).toEqual({ kind: 'previous' });
    expect(chooseRollbackTarget({ latestId: 'a', previousId: 'a', versions: [{ tag: V1, id: 'a' }] }).kind).toBe('none');
  });
});

const MUP = `module.exports = {
  servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' }, two: { host: '192.0.2.2', username: 'root', password: 'pw' } },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
};`;

async function setup(versions: Record<string, ImageVersions>) {
  const dir = tempDir({ '.deploy/mup.js': MUP, '.deploy/settings.json': '{"public":{}}' });
  const out: string[] = [];
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js' },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({ get: async (n: string) => ({ name: n, host: n }) as unknown as SshConnection, closeAll: async () => {} }),
    },
  );
  const calls: string[] = [];
  const history: HistoryEntry[] = [];
  const deps: Partial<PipelineDeps> = {
    readGitInfo: async () => null,
    preflight: async (_c, servers) => {
      calls.push('preflight');
      return { errors: [], warnings: [], platformByServer: Object.fromEntries(servers.map((s) => [s, 'linux/amd64'])), platforms: ['linux/amd64'] };
    },
    buildApp: async () => [{ platform: 'linux/amd64', version: V3, localTag: `mup-myapp:${V3}`, imageId: 'x', nodeVersion: '24', depsHash: 'd', fromCache: false }],
    ensureLocalRegistry: async () => ({ port: 5555 }),
    pushToLocalRegistry: async (t) => t,
    stopLocalRegistry: async () => true,
    distributeToServer: async () => ({ durationMs: 1 }),
    pruneVersions: async () => [],
    readLock: async (c) => (calls.push(`read-lock:${c.name}`), { user: 'eve', machine: 'box', pid: 1, startedAt: 'x', command: 'deploy', tool: 't' }),
    acquireLock: async (c) => (calls.push(`lock:${c.name}`), { ok: true }),
    releaseLock: async (c) => void calls.push(`release:${c.name}`),
    listVersions: async (c) => (calls.push(`versions:${c.name}`), versions[c.name]),
    activateServer: async (d, o) => {
      calls.push(`activate:${d.serverName}:${o.mode}:${o.version}`);
      return { server: d.serverName, status: 'healthy', durationMs: 1 } as ActivationResult;
    },
    startServer: async (d) => ({ server: d.serverName, status: 'healthy', durationMs: 1 }),
    appendHistory: async (_c, _a, e) => void history.push(e),
  };
  return { ctx, deps, calls, history, out: () => out.join('') };
}

describe('rollbackPipeline', () => {
  it('rolls every server back by strategy, keeps the config and writes history', async () => {
    const s = await setup({ one: three, two: { latestId: 'l', previousId: 'p', versions: [] } });
    const out = await rollbackPipeline(s.ctx, {}, s.deps);
    expect(out.ok).toBe(true);
    expect(s.calls).toEqual([
      'lock:one',
      'lock:two',
      'versions:one',
      `activate:one:rollback:${V2}`,
      'versions:two',
      'activate:two:rollback:null',
      'release:one',
      'release:two',
    ]);
    expect(s.history.map((h) => [h.action, h.version, h.result])).toEqual([
      ['rollback', V2, 'success'],
      ['rollback', null, 'success'],
    ]);
  });

  it('a server without a target fails with the reason, the others continue by strategy', async () => {
    const none: ImageVersions = { latestId: 'l', previousId: null, versions: [] };
    const s = await setup({ one: three, two: none });
    const out = await rollbackPipeline(s.ctx, { strategy: 'parallel' }, s.deps);
    expect(out.ok).toBe(false);
    expect(out.results.find((r) => r.server === 'two')).toMatchObject({ status: 'failed', error: expect.stringMatching(/nothing to roll back/i) });
    expect(s.calls).toContain(`activate:one:rollback:${V2}`);

    const c = await setup({ one: none, two: three });
    const canary = await rollbackPipeline(c.ctx, {}, c.deps);
    expect(canary.skipped).toEqual(['two']);
    expect(c.calls.some((x) => x.startsWith('activate:'))).toBe(false);
  });

  it('skips a version whose deploy failed on that server (M2)', async () => {
    const s = await setup({ one: three, two: three });
    const h = (version: string, result: HistoryEntry['result']): HistoryEntry => ({
      version, action: 'deploy', result, startedAt: 'x', durationMs: 1, user: 'u', machine: 'm', servers: ['one', 'two'], tool: 't',
    });
    s.deps.readHistory = async (c) => (c.name === 'one' ? [h(V1, 'success'), h(V2, 'reverted'), h(V3, 'success')] : []);
    const out = await rollbackPipeline(s.ctx, { strategy: 'parallel' }, s.deps);
    // different targets: no single version to name
    expect(out.version).toBe('the versions listed above');
    expect(s.calls).toContain(`activate:one:rollback:${V1}`);
    // no history on "two" (e.g. it was lost): the kept versions are used as they are
    expect(s.calls).toContain(`activate:two:rollback:${V2}`);
  });

  it('does not filter by a history that names no deployed version (only reconfig/restart)', async () => {
    const s = await setup({ one: three, two: three });
    const reconfig: HistoryEntry = { version: null, action: 'reconfig', result: 'success', startedAt: 'x', durationMs: 1, user: 'u', machine: 'm', servers: ['one'], tool: 't' };
    s.deps.readHistory = async () => [reconfig];
    await rollbackPipeline(s.ctx, { strategy: 'parallel' }, s.deps);
    expect(s.calls).toContain(`activate:one:rollback:${V2}`);
  });

  it('--to rolls back to the given version', async () => {
    const s = await setup({ one: three, two: three });
    await rollbackPipeline(s.ctx, { to: V1 }, s.deps);
    expect(s.calls.filter((x) => x.startsWith('activate:'))).toEqual([`activate:one:rollback:${V1}`, `activate:two:rollback:${V1}`]);
  });
});

describe('--force-unlock', () => {
  const runs: Array<[string, (ctx: CommandContext, deps: Partial<PipelineDeps>) => Promise<unknown>]> = [
    ['deploy', (ctx, d) => deployPipeline(ctx, { cachedBuild: false, forceBuild: false, forceUnlock: true }, d)],
    ['reconfig', (ctx, d) => reconfigPipeline(ctx, { forceUnlock: true }, d)],
    ['restart', (ctx, d) => restartPipeline(ctx, { forceUnlock: true }, d)],
    ['rollback', (ctx, d) => rollbackPipeline(ctx, { forceUnlock: true }, d)],
  ];
  for (const [name, run] of runs) {
    it(`${name}: releases the lock before acquiring it`, async () => {
      const s = await setup({ one: three, two: three });
      s.deps.preflight = async (_c, servers, o) => {
        s.calls.push(`preflight:checkLocks=${o.checkLocks}`);
        return { errors: [], warnings: [], platformByServer: Object.fromEntries(servers.map((x) => [x, 'linux/amd64'])), platforms: ['linux/amd64'] };
      };
      await run(s.ctx, s.deps);
      const lockCalls = s.calls.filter((x) => /^(release|lock):one$/.test(x));
      expect(lockCalls.slice(0, 2)).toEqual(['release:one', 'lock:one']);
      expect(s.out()).toMatch(/eve@box/);
      if (name === 'deploy') expect(s.calls).toContain('preflight:checkLocks=false');
    });
  }

  it('without the flag nothing is released before acquiring', async () => {
    const s = await setup({ one: three, two: three });
    await rollbackPipeline(s.ctx, {}, s.deps);
    expect(s.calls.indexOf('lock:one')).toBeLessThan(s.calls.indexOf('release:one'));
    expect(s.calls).not.toContain('read-lock:one');
  });
});

describe('history table', () => {
  const e = (p: Partial<HistoryEntry>): HistoryEntry => ({
    version: V2,
    action: 'deploy',
    result: 'success',
    startedAt: '2026-11-07T10:00:00.000Z',
    durationMs: 61_000,
    user: 'Marek',
    machine: 'mac',
    servers: ['one', 'two'],
    tool: 'comet-deploy@0.1.0',
    git: { commit: 'abcdef1234567', branch: 'main', dirty: true },
    ...p,
  });

  it('shows one row per deploy with columns and per-server results when they differ', () => {
    const merged = mergeHistory({ one: [e({})], two: [e({ result: 'reverted' })] }, 20);
    const text = formatHistoryTable(merged, { timeZone: 'UTC' });
    const [header, row] = text.split('\n');
    expect(header.split(/\s{2,}/)).toEqual(['TIME', 'ACTION', 'VERSION', 'RESULT', 'DURATION', 'BY', 'COMMIT', 'SERVERS']);
    expect(row).toContain('2026-11-07 10:00:00');
    expect(row).toContain('success: one, reverted: two');
    expect(row).toContain('Marek@mac');
    expect(row).toContain('abcdef1 main dirty');
    expect(row).toContain('1m01s');
    expect(row).toContain('one, two');
  });

  it('says so when there is no history', () => {
    expect(formatHistoryTable([], { timeZone: 'UTC' })).toMatch(/no deploy history/i);
  });
});
