/**
 * Load balancing behind MUP's proxy on two fake servers (proxy plan Task 8, spec §4.4): the
 * upstream as MUP writes it, draining without a failed request, an interrupted deploy that
 * leaves its server drained until `restart`, no drain with the parallel strategy, a PORT
 * change, turning load balancing off and on, and two deploys that meet at the lock.
 *
 * `privateIp` is each fake server's container IP, so the proxies reach both apps over the
 * local Docker network, as they would over a private network.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { normalizeConfig } from '../../src/config/normalize.js';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { mupUpstreamFile } from '../oracle/mup-oracle.js';
import { APP_NAME, cli, curlVia, requestLoop, sampleProject, waitFor, writeTestConfig } from './helpers.js';

const DOMAIN = 'lb.test';
const UPSTREAM = `/opt/mup-nginx-proxy/upstream/${APP_NAME}`;

describe('proxy load balancing on two servers', () => {
  let servers: FakeServer[] = [];
  let s1: FakeServer;
  let s2: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const write = (o: { lb?: boolean; env?: Record<string, string> } = {}) =>
    writeTestConfig(p.deployDir, servers, {
      privateIp: true,
      env: o.env,
      proxy: { domains: DOMAIN, loadBalancing: o.lb ?? true, stickySessions: false },
    });
  const upstream = async (s: FakeServer) => (await s.exec(`sudo cat ${UPSTREAM} 2>/dev/null`)).stdout;
  const change = () => appendFileSync(join(p.appDir, 'server/main.js'), `\n// lb test change ${Date.now()}\n`);
  /** Runs `args` while requests go through the proxy on s1. */
  async function underLoad(args: string[]) {
    const loop = await requestLoop(s1, DOMAIN);
    const r = await cli(args, p.root);
    await new Promise((res) => setTimeout(res, 2000));
    return { ...r, requests: await loop.stop() };
  }
  const noFailures = (r: { requests: { failed: number; total: number; codes: string[] } }) =>
    expect(r.requests.failed, `failed requests (${r.requests.codes.join(',')}) of ${r.requests.total}`).toBe(0);

  beforeAll(async () => {
    servers = await startFakeServers(2);
    [s1, s2] = servers;
    p = sampleProject();
    write();
  }, 1_500_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
  });

  it('1. setup + deploy: both proxies have the upstream MUP writes', async () => {
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    const { raw, basePath } = loadConfig(p.deployDir, './mup.js');
    const expected = mupUpstreamFile(normalizeConfig(raw, { basePath }));
    expect(expected).toContain(`server ${s2.ip}:`);
    for (const s of servers) expect(await upstream(s), s.name).toBe(expected);
    expect(await waitFor(async () => (await curlVia(s1, DOMAIN, '/native')) === '60', 60_000, 1000)).toBe(true);
  }, 1_200_000);

  it('2. a deploy under load drains server by server without a failed request', async () => {
    change();
    const r = await underLoad(['deploy', ...config()]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/s1\b.*drain/);
    expect(r.output).toMatch(/s2\b.*drain/);
    noFailures(r);
    expect(await upstream(s1)).not.toContain(' down;');
  });

  it('3. an interrupted deploy leaves its server drained; setup keeps it so, restart brings it back', async () => {
    change();
    const deploy = cli(['deploy', ...config()], p.root);
    // s2's drain is written to both proxies before s2 restarts. Within the drain wait, s2 becomes
    // unreachable over SSH: new connections are refused and the deploy's sessions end (ending
    // only the sessions is not enough, the deploy connects again). The fake server's own
    // commands run through `docker exec`, and the proxies reach the apps on other ports.
    const s2Down = new RegExp(`server ${s2.ip.replace(/\./g, '\\.')}:\\d+ down;`);
    const drained = await waitFor(async () => s2Down.test(await upstream(s1)) && s2Down.test(await upstream(s2)), 900_000, 200);
    expect(drained, 's2 was never drained').toBe(true);
    const block = 'INPUT -p tcp --dport 22 -j REJECT --reject-with tcp-reset';
    await s2.exec(`iptables -I ${block} && (pkill -f 'sshd: root' || true)`);
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await deploy;
    } finally {
      await s2.exec(`iptables -D ${block}`);
    }
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain('comet-deploy restart --servers s2');
    // The deploy could not release its lock on s2.
    const unlock = await cli(['unlock', ...config()], p.root);
    expect(unlock.code, unlock.output).toBe(0);

    const status = async () => (await cli(['status', ...config()], p.root)).output;
    expect(await status()).toContain('Drained: s2');
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    expect(await status()).toContain('Drained: s2');
    const restart = await cli(['restart', '--servers', 's2', ...config()], p.root);
    expect(restart.code, restart.output).toBe(0);
    expect(await status()).not.toContain('Drained:');
    for (const s of servers) expect(await upstream(s), s.name).not.toContain(' down;');
  }, 1_200_000);

  it('4. --strategy parallel drains nothing', async () => {
    change();
    const r = await cli(['deploy', '--strategy', 'parallel', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toMatch(/drain/);
  });

  it('5. a new app.env.PORT reaches the upstream without a failed request', async () => {
    write({ env: { PORT: '4100' } });
    const r = await underLoad(['deploy', ...config()]);
    expect(r.code, r.output).toBe(0);
    noFailures(r);
    for (const s of servers) {
      const u = await upstream(s);
      expect(u, s.name).toContain(`server ${s1.ip}:4100;`);
      expect(u, s.name).toContain(`server ${s2.ip}:4100;`);
    }
  });

  it('6. turning load balancing off and on again drops no request', async () => {
    write({ lb: false, env: { PORT: '4100' } });
    const off = await underLoad(['deploy', ...config()]);
    expect(off.code, off.output).toBe(0);
    noFailures(off);
    for (const s of servers) expect(await upstream(s), s.name).toBe('');

    write({ env: { PORT: '4100' } });
    const on = await underLoad(['deploy', ...config()]);
    expect(on.code, on.output).toBe(0);
    noFailures(on);
    for (const s of servers) expect(await upstream(s), s.name).toContain(`server ${s2.ip}:4100;`);
  });

  it('7. two deploys of single servers at once: the second one stops at the lock', async () => {
    // Both reuse the last build, so they reach the lock at about the same time.
    const [a, b] = await Promise.all([
      cli(['deploy', '--cached-build', '--servers', 's1', ...config()], p.root),
      cli(['deploy', '--cached-build', '--servers', 's2', ...config()], p.root),
    ]);
    expect([a.code, b.code].sort(), `${a.output}\n----\n${b.output}`).toEqual([0, 1]);
    const loser = a.code === 1 ? a : b;
    expect(loser.output).toMatch(/locked by|lock is held by/);
  });
});
