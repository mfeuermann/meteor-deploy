import { describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import type { ActivationResult } from '../../../src/deploy/activate.js';
import { createReporter } from '../../../src/output/reporter.js';
import { createProxyRollout, lockTargets, rolloutProxies, type ProxyRollout } from '../../../src/proxy/rollout.js';
import type { SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';
import { formatUpstream, parseUpstream } from '../../../src/proxy/upstream.js';
import { fakeProxyDeps, inSyncState } from '../../helpers/proxy.js';

const mup = (proxy: string | null, extra = '') => `module.exports = {
  servers: {
    one: { host: '192.0.2.1', username: 'root', password: 'pw', privateIp: '10.0.0.1' },
    two: { host: '192.0.2.2', username: 'root', password: 'pw', privateIp: '10.0.0.2' },
    three: { host: '192.0.2.3', username: 'root', password: 'pw' },
  },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {} }, env: { ROOT_URL: 'https://a.example.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
  ${proxy === null ? '' : `proxy: ${proxy},`}
  ${extra}
};`;

const LB = "{ domains: 'a.example.com', loadBalancing: true }";
const LE = "{ domains: 'a.example.com' }";

async function context(cfg: string, servers?: string) {
  const dir = tempDir({ 'mup.js': cfg });
  const lines: string[] = [];
  const ctx = await createContext(
    { config: 'mup.js', ...(servers ? { servers } : {}) },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void lines.push(s) }),
      sshPoolFactory: () => ({ get: async (name: string) => ({ name, host: name }) as unknown as SshConnection, closeAll: async () => {} }),
    },
  );
  return { ctx, output: () => lines.join('') };
}

/** Runs `servers` one after the other through `rollout.activate`, like the canary strategy. */
async function roll(rollout: ProxyRollout, servers: string[], calls: string[], status: Record<string, ActivationResult['status']> = {}) {
  const results: ActivationResult[] = [];
  for (const s of servers) {
    results.push(
      await rollout.activate(s, async (mode) => {
        calls.push(`run:${s}:${mode.kind}`);
        return { server: s, status: status[s] ?? 'healthy', durationMs: 1 };
      }),
    );
  }
  return results;
}

const flow = (calls: string[]) => calls.filter((c) => /^(drain|run|healthy|finalize):/.test(c));

/** `host:port[ down]` of every server line of an upstream file. */
const lines = (content: string | null | undefined) => parseUpstream(content ?? '').map((e) => `${e.host}:${e.port}${e.down ? ' down' : ''}`);

/** A load-balanced state whose upstream lists both servers on `port`. */
async function lbOn(ctx: Awaited<ReturnType<typeof context>>['ctx'], port: number) {
  const upstream = formatUpstream(ctx.config, [
    { host: '10.0.0.1', port, down: false },
    { host: '10.0.0.2', port, down: false },
  ]);
  return { ...(await inSyncState(ctx, { lb: 'keep' })), upstream };
}

const LB_4100 = "{ domains: 'a.example.com', loadBalancing: true }";
const PORT_4100 = (cfg: string) => cfg.replace("env: { ROOT_URL", "env: { PORT: 4100, ROOT_URL");

describe('createProxyRollout', () => {
  it('is null without a proxy section', async () => {
    const { ctx } = await context(mup(null));
    expect(await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({}, []))).toBeNull();
  });

  it('load balancing, canary: drains each server before its restart and returns it after its health check', async () => {
    const { ctx, output } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    const results = await roll(r, ['one', 'two'], calls);
    expect(await r.finish(results)).toEqual([]);
    expect(flow(calls)).toEqual(['drain:one', 'run:one:restart', 'healthy:one', 'drain:two', 'run:two:restart', 'healthy:two', 'finalize:']);
    expect(output()).toMatch(/one\b.*drain.*out of load balancing/);
    // The drain reaches every proxy server before the restart.
    expect(calls.slice(calls.indexOf('drain:one'), calls.indexOf('run:one:restart'))).toEqual([
      'drain:one',
      'upstream:one:10.0.0.1 down,10.0.0.2',
      'upstream:two:10.0.0.1 down,10.0.0.2',
    ]);
  });

  it('load balancing, parallel: nothing is drained', async () => {
    const { ctx, output } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'parallel' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    await r.finish(await roll(r, ['one', 'two'], calls));
    expect(calls.some((c) => c.startsWith('drain:'))).toBe(false);
    expect(output()).not.toMatch(/drain/);
    expect(calls).toEqual(expect.arrayContaining(['run:one:restart', 'run:two:restart']));
  });

  it('a reverted server goes back into the upstream; a revert-failed one stays down with the restart command', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'rolling' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    const warnings = await r.finish(await roll(r, ['one', 'two'], calls, { one: 'reverted', two: 'revert-failed' }));
    expect(flow(calls)).toEqual(['drain:one', 'run:one:restart', 'healthy:one:kept', 'drain:two', 'run:two:restart', 'finalize:two']);
    expect(warnings.join('\n')).toContain('comet-deploy restart --servers two');
    // The upstream as finalize leaves it: two still down (its drain already wrote that).
    expect(calls.filter((c) => c.startsWith('upstream:')).at(-1)).toBe('upstream:two:10.0.0.1,10.0.0.2 down');
  });

  it('after an abort only the servers that ran were drained (Review Focus 3)', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    expect(await r.finish(await roll(r, ['one'], calls))).toEqual([]);
    expect(flow(calls)).toEqual(['drain:one', 'run:one:restart', 'healthy:one', 'finalize:']);
  });

  it('a proxy that cannot be written is named in the warnings, with the command that puts the servers back (Review Focus 4)', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls, { failWrite: 'two' })))!;
    await r.prepare();
    const results = await roll(r, ['one', 'two'], calls);
    expect(results.map((x) => x.status)).toEqual(['healthy', 'healthy']);
    const warnings = (await r.finish(results)).join('\n');
    expect(warnings).toContain(
      'Could not update the reverse proxy on "two": connection refused. Its upstream may still have one, two out of load balancing: once "two" is reachable, run "comet-deploy restart --servers one,two".',
    );
    expect(warnings).not.toContain('proxy setup');
  });

  it('a proxy that missed the restore of a server gets it at the end (Review Focus 4)', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const files: Record<string, string | null> = {};
    const state = await inSyncState(ctx, { lb: 'keep' });
    // Proxy two: drain one, restore one, drain two, restore two (fails), finalize.
    const deps = fakeProxyDeps({ one: state, two: state }, calls, { failWrite: 'two', failWriteCalls: [4], files });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, deps))!;
    await r.prepare();
    expect(await r.finish(await roll(r, ['one', 'two'], calls))).toEqual([]);
    expect(files.two).toBe(state.upstream);
  });

  it('a failed canary after a PORT change leaves every server on the port it listens on', async () => {
    const { ctx } = await context(PORT_4100(mup(LB_4100)));
    const calls: string[] = [];
    const files: Record<string, string | null> = {};
    const state = await lbOn(ctx, 4000);
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls, { files })))!;
    await r.prepare();
    // The canary reverts to its previous start.sh (port 4000); two is not activated.
    await r.finish(await roll(r, ['one'], calls, { one: 'reverted' }));
    expect(lines(files.one)).toEqual(['10.0.0.1:4000', '10.0.0.2:4000']);
    expect(lines(files.two)).toEqual(['10.0.0.1:4000', '10.0.0.2:4000']);
  });

  it('a PORT change moves each server once it deployed, and the end result is the MUP file', async () => {
    const { ctx } = await context(PORT_4100(mup(LB_4100)));
    const calls: string[] = [];
    const files: Record<string, string | null> = {};
    const state = await lbOn(ctx, 4000);
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls, { files })))!;
    await r.prepare();
    await roll(r, ['one'], calls);
    expect(lines(files.one)).toEqual(['10.0.0.1:4100', '10.0.0.2:4000']);
    await r.finish([...(await roll(r, ['two'], calls)), { server: 'one', status: 'healthy', durationMs: 1 }]);
    expect(files.one).toBe(formatUpstream(ctx.config, [
      { host: '10.0.0.1', port: 4100, down: false },
      { host: '10.0.0.2', port: 4100, down: false },
    ]));
  });

  it('restart and rollback after a PORT edit in mup.js keep the ports the servers run', async () => {
    for (const action of ['restart', 'rollback'] as const) {
      const { ctx } = await context(PORT_4100(mup(LB_4100)));
      const calls: string[] = [];
      const files: Record<string, string | null> = {};
      const state = await lbOn(ctx, 4000);
      const r = (await createProxyRollout(ctx, { action, strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls, { files })))!;
      await r.prepare();
      expect(await r.finish(await roll(r, ['one', 'two'], calls))).toEqual([]);
      expect(flow(calls)).toEqual(['drain:one', 'run:one:restart', 'healthy:one:kept', 'drain:two', 'run:two:restart', 'healthy:two:kept', 'finalize:']);
      expect(files.one).toBe(state.upstream);
    }
  });

  it('a new server that did not deploy is named: it is not in load balancing', async () => {
    const cfg = mup(LB).replace("servers: { one: {}, two: {} }", "servers: { one: {}, two: {}, three: {} }");
    const { ctx } = await context(cfg);
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep', upstream: formatUpstream(ctx.config, [
      { host: '10.0.0.1', port: 80, down: false },
      { host: '10.0.0.2', port: 80, down: false },
    ]) });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'rolling' }, fakeProxyDeps({ one: state, two: state, three: state }, calls)))!;
    await r.prepare();
    const warnings = await r.finish(await roll(r, ['one', 'two', 'three'], calls, { three: 'failed' }));
    expect(warnings).toContain('"three" is not in load balancing: it does not run this config yet. Run "comet-deploy deploy --servers three" to add it.');
  });

  it('while load balancing is being enabled the servers switch with zero downtime: nginx still routes to the containers', async () => {
    const { ctx, output } = await context(mup(LB));
    const calls: string[] = [];
    const off = await inSyncState(ctx, { lb: 'off' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, calls)))!;
    await r.prepare();
    await r.finish(await roll(r, ['one', 'two'], calls));
    expect(flow(calls)).toEqual(['run:one:zero-downtime', 'run:two:zero-downtime']);
    expect(output()).not.toContain('Zero-downtime switch not used');

    // An earlier run already switched one to the load-balanced container, which publishes the port.
    const again: string[] = [];
    const r2 = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, again, { publishes: ['one'] })))!;
    await r2.prepare();
    await r2.finish(await roll(r2, ['one', 'two'], again));
    expect(flow(again)).toEqual(['run:one:restart', 'run:two:zero-downtime']);
  });

  it('enables load balancing only in finish, and only when every app server deployed', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const off = await inSyncState(ctx, { lb: 'off' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, calls)))!;
    await r.prepare();
    const results = await roll(r, ['one', 'two'], calls);
    expect(calls.some((c) => c.startsWith('sync:after') || c.startsWith('drain:'))).toBe(false);
    expect(await r.finish(results)).toEqual([]);
    expect(calls.filter((c) => c.startsWith('sync:'))).toEqual(['sync:after:one:lb-enable+service', 'sync:after:two:lb-enable+service']);

    const calls2: string[] = [];
    const r2 = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, calls2)))!;
    await r2.prepare();
    const warnings = await r2.finish(await roll(r2, ['one', 'two'], calls2, { two: 'reverted' }));
    expect(calls2.some((c) => c.startsWith('sync:after'))).toBe(false);
    expect(warnings).toContain('loadBalancing was not enabled on the proxies because two did not deploy; run the deploy again');
  });

  it('a deploy of some servers does not enable load balancing', async () => {
    const { ctx } = await context(mup(LB), 'one');
    const calls: string[] = [];
    const off = await inSyncState(ctx, { lb: 'off' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, calls)))!;
    await r.prepare();
    const warnings = await r.finish(await roll(r, ['one'], calls));
    expect(calls.some((c) => c.startsWith('sync:after'))).toBe(false);
    expect(warnings).toContain('loadBalancing was not enabled on the proxies because two did not deploy; run the deploy again');
  });

  it('refuses to turn off load balancing while the proxy runs on servers without the app', async () => {
    const { ctx } = await context(mup("{ domains: 'a.example.com', servers: { one: {}, three: {} } }"));
    const linked = { ...(await inSyncState(ctx, { lb: 'off' })), upstream: '\nserver 10.0.0.1:4000;\n', upstreamLinks: ['a.example.com'] };
    const p = createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: linked, three: linked }, []));
    await expect(p).rejects.toThrow(CometError);
    await expect(p).rejects.toThrow(
      'Turning off loadBalancing while the proxy runs on servers without the app would leave those proxies without a backend. Remove proxy.servers first or keep loadBalancing.',
    );
  });

  it('switches with zero downtime behind the proxy without load balancing', async () => {
    const { ctx, output } = await context(mup(LE));
    const calls: string[] = [];
    const state = await inSyncState(ctx);
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    await r.finish(await roll(r, ['one', 'two'], calls));
    expect(flow(calls)).toEqual(['run:one:zero-downtime', 'run:two:zero-downtime']);
    expect(output()).not.toContain('Zero-downtime switch not used');
  });

  it('names the reason once when the zero-downtime switch cannot be used', async () => {
    const { ctx, output } = await context(mup(LE, 'cometDeploy: { zeroDowntime: false },'));
    const calls: string[] = [];
    const state = await inSyncState(ctx);
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    await r.prepare();
    await r.finish(await roll(r, ['one', 'two'], calls));
    expect(flow(calls)).toEqual(['run:one:restart', 'run:two:restart']);
    expect(output().split('Zero-downtime switch not used: cometDeploy.zeroDowntime is false').length).toBe(2);
  });

  it('deploy syncs the changed files on every proxy before the activation; restart only reads', async () => {
    const { ctx } = await context(mup(LE));
    const stale = { ...(await inSyncState(ctx)), vhost: { 'a.example.com': 'old' } };
    const calls: string[] = [];
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: stale, two: stale }, calls)))!;
    await r.prepare();
    expect(calls).toEqual(['sync:before:one:vhost', 'sync:before:two:vhost']);

    const calls2: string[] = [];
    const r2 = (await createProxyRollout(ctx, { action: 'restart', strategy: 'canary' }, fakeProxyDeps({ one: stale, two: stale }, calls2)))!;
    await r2.prepare();
    await r2.finish(await roll(r2, ['one', 'two'], calls2));
    expect(calls2.filter((c) => !c.startsWith('run:'))).toEqual([]);
  });

  it('without load balancing, --servers limits the proxies like every MUP command; with it every proxy takes part', async () => {
    const one = await context(mup(LE), 'one');
    const stale = { ...(await inSyncState(one.ctx)), vhost: { 'a.example.com': 'old' } };
    const calls: string[] = [];
    // Server two cannot even be reached: it is not selected, so it is not asked.
    const r = (await createProxyRollout(one.ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: stale, two: new Error('connect ETIMEDOUT') }, calls)))!;
    await r.prepare();
    expect(calls).toEqual(['sync:before:one:vhost']);

    const lb = await context(mup(LB), 'one');
    const p = createProxyRollout(lb.ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: await inSyncState(lb.ctx, { lb: 'keep' }), two: new Error('connect ETIMEDOUT') }, []));
    await expect(p).rejects.toThrow('Server "two": cannot read the proxy files: connect ETIMEDOUT');
  });

  it('stops before anything changes when the proxy does not run on a proxy server', async () => {
    const { ctx } = await context(mup(LE));
    const down = { ...(await inSyncState(ctx)), proxyRunning: false };
    const p = createProxyRollout(ctx, { action: 'restart', strategy: 'canary' }, fakeProxyDeps({ one: await inSyncState(ctx), two: down }, []));
    await expect(p).rejects.toThrow(
      'Server "two": the reverse proxy is not set up (container mup-nginx-proxy is missing or stopped). Run "comet-deploy proxy setup" first.',
    );
  });

  it('warns once about shared settings that differ, only when the config has proxy.shared', async () => {
    const shared = await context(mup("{ domains: 'a.example.com', shared: { clientUploadLimit: '20M' } }"));
    const state = await inSyncState(shared.ctx);
    const calls: string[] = [];
    const r = (await createProxyRollout(shared.ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls, { drift: true })))!;
    await r.prepare();
    expect(calls).toEqual(['shared:one', 'shared:two']);
    expect(shared.output().split('comet-deploy proxy reconfig-shared').length).toBe(2);

    const plain = await context(mup(LE));
    const calls2: string[] = [];
    const r2 = (await createProxyRollout(plain.ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls2, { drift: true })))!;
    await r2.prepare();
    expect(calls2).toEqual([]);
    expect(plain.output()).not.toContain('reconfig-shared');
  });

  it('finish never throws: a failed proxy step becomes a warning', async () => {
    const { ctx } = await context(mup(LB));
    const off = await inSyncState(ctx, { lb: 'off' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: off, two: off }, [], { failAfter: true })))!;
    await r.prepare();
    const warnings = (await r.finish(await roll(r, ['one', 'two'], []))).join('\n');
    expect(warnings).toMatch(/"one".*nginx -t failed/);
  });

  it('finish without prepare does nothing', async () => {
    const { ctx } = await context(mup(LB));
    const calls: string[] = [];
    const state = await inSyncState(ctx, { lb: 'keep' });
    const r = (await createProxyRollout(ctx, { action: 'deploy', strategy: 'canary' }, fakeProxyDeps({ one: state, two: state }, calls)))!;
    expect(await r.finish([])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('rolloutProxies', () => {
  it('is every proxy server with load balancing, else the selected ones', async () => {
    expect(rolloutProxies((await context(mup(LB), 'one')).ctx)).toEqual(['one', 'two']);
    expect(rolloutProxies((await context(mup(LE), 'one')).ctx)).toEqual(['one']);
    expect(rolloutProxies((await context(mup(LE))).ctx)).toEqual(['one', 'two']);
  });
});

describe('lockTargets', () => {
  it('locks every app server with load balancing, else the selected ones', async () => {
    expect(lockTargets((await context(mup(LB), 'one')).ctx)).toEqual(['one', 'two']);
    expect(lockTargets((await context(mup(LE), 'one')).ctx)).toEqual(['one']);
    expect(lockTargets((await context(mup(null), 'one')).ctx)).toEqual(['one']);
  });
});
