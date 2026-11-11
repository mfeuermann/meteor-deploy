import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { upstreamPort } from '../../../src/proxy/render.js';
import { desiredEntries, formatUpstream, parseUpstream, UpstreamController, type UpstreamEntry } from '../../../src/proxy/upstream.js';
import { mupUpstreamFile } from '../../oracle/mup-oracle.js';

const here = dirname(fileURLToPath(import.meta.url));

function lbConfig(o: { sticky?: boolean; port?: number; servers?: Record<string, string> } = {}): NormalizedConfig {
  const dir = join(here, '../../fixtures/configs/proxy-lb');
  const { raw, basePath } = loadConfig(dir, './mup.js');
  if (o.sticky !== undefined) raw.proxy.stickySessions = o.sticky;
  if (o.port !== undefined) raw.app.env.PORT = o.port;
  if (o.servers) {
    raw.servers = Object.fromEntries(Object.entries(o.servers).map(([n, ip]) => [n, { host: `h-${n}`, username: 'root', password: 'pw', privateIp: ip }]));
    raw.app.servers = Object.fromEntries(Object.keys(o.servers).map((n) => [n, {}]));
  }
  return normalizeConfig(raw, { basePath });
}

/**
 * A recording `apply` that also counts concurrent calls. `fail(proxy, call)` makes the write to
 * `proxy` fail on its `call`-th write (1-based); `failFor` fails every write to that proxy.
 */
function recorder(o: { failFor?: string; fail?: (proxy: string, call: number) => boolean } = {}) {
  const writes: string[] = [];
  const targets: string[][] = [];
  const files = new Map<string, string>();
  const count = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const apply = async (content: string, proxies: string[]) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    writes.push(content);
    targets.push([...proxies]);
    const failed: Array<{ proxy: string; error: string }> = [];
    for (const proxy of proxies) {
      const n = (count.get(proxy) ?? 0) + 1;
      count.set(proxy, n);
      if (proxy === o.failFor || o.fail?.(proxy, n)) failed.push({ proxy, error: 'connection lost' });
      else files.set(proxy, content);
    }
    active--;
    return { failed };
  };
  return { apply, writes, targets, files, maxActive: () => maxActive };
}

const entries = (c: NormalizedConfig, list: Array<[string, number, boolean?]>): UpstreamEntry[] => {
  void c;
  return list.map(([host, port, down]) => ({ host, port, down: !!down }));
};

/** The upstream file on proxies p1 and p2 (the same `list` on both unless `p2` is given). */
const onProxies = (c: NormalizedConfig, list: Array<[string, number, boolean?]>, p2?: Array<[string, number, boolean?]>) =>
  new Map([
    ['p1', formatUpstream(c, entries(c, list))],
    ['p2', formatUpstream(c, entries(c, p2 ?? list))],
  ]);

const hostsPorts = (content: string | undefined) => parseUpstream(content ?? '').map((e) => `${e.host}:${e.port}${e.down ? ' down' : ''}`);

describe('formatUpstream / parseUpstream', () => {
  for (const sticky of [false, true]) {
    it(`is byte-identical with MUP's upstream file (stickySessions ${sticky})`, () => {
      const c = lbConfig({ sticky });
      expect(formatUpstream(c, desiredEntries(c))).toBe(mupUpstreamFile(c));
    });
  }

  it('round-trips, including down marks', () => {
    const c = lbConfig({ sticky: true });
    const list: UpstreamEntry[] = [
      { host: '10.0.0.1', port: 4000, down: true },
      { host: '10.0.0.2', port: 4000, down: false },
    ];
    const text = formatUpstream(c, list);
    expect(text).toContain('server 10.0.0.1:4000 down;\n');
    expect(parseUpstream(text)).toEqual(list);
  });

  it('desiredEntries lists every app server up, on the app port, in app.servers order', () => {
    const c = lbConfig({ port: 4000 });
    expect(desiredEntries(c)).toEqual([
      { host: '10.0.0.1', port: 4000, down: false },
      { host: '10.0.0.2', port: 4000, down: false },
    ]);
    expect(upstreamPort(c)).toBe(4000);
  });
});

describe('UpstreamController', () => {
  const NO_WAIT = { waitMs: 0, applyConfig: true };

  it('drains one server, but never the last one that is up', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    expect(await ctl.drain('one')).toBe(true);
    expect(r.writes.at(-1)).toContain('server 10.0.0.1:4000 down;');
    expect(r.targets.at(-1)).toEqual(['p1', 'p2']);
    expect(ctl.downServers()).toEqual(['one']);
    expect(await ctl.drain('two')).toBe(false);
    expect(r.writes).toHaveLength(1);
  });

  it('counts a server that is already down as not up', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000, true], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    expect(await ctl.drain('two')).toBe(false);
    expect(r.writes).toHaveLength(0);
  });

  it('counts a server that is down on any proxy as down', async () => {
    const c = lbConfig({ port: 4000 });
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]], [['10.0.0.1', 4000], ['10.0.0.2', 4000, true]]), recorder().apply, NO_WAIT);
    expect(ctl.downServers()).toEqual(['two']);
  });

  it('moves a server to the new port only once it is healthy with the new config', async () => {
    const c = lbConfig({ port: 5000 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('one');
    await ctl.healthy('one', { applied: true });
    expect(hostsPorts(r.writes.at(-1))).toEqual(['10.0.0.1:5000', '10.0.0.2:4000']);
  });

  it('a reverted server keeps the port it runs, and finalize leaves every server that did not apply the config on its entry', async () => {
    // Production listens on 4000, the config says 4100; the canary reverts, the rest is skipped.
    const c = lbConfig({ port: 4100 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('one');
    await ctl.healthy('one', { applied: false });
    await ctl.finalize(new Set());
    expect(hostsPorts(r.files.get('p1'))).toEqual(['10.0.0.1:4000', '10.0.0.2:4000']);
    expect(hostsPorts(r.files.get('p2'))).toEqual(['10.0.0.1:4000', '10.0.0.2:4000']);
  });

  it('a deploy of one server with a new port leaves the other server on its port', async () => {
    const c = lbConfig({ port: 4100 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('one');
    await ctl.healthy('one', { applied: true });
    await ctl.finalize(new Set());
    expect(hostsPorts(r.files.get('p1'))).toEqual(['10.0.0.1:4100', '10.0.0.2:4000']);
  });

  it('without applyConfig (restart, rollback) only the down marks change: ports, addresses and other entries stay', async () => {
    // mup.js was edited (new PORT, a server removed) but not deployed: the servers still run their old start.sh.
    const c = lbConfig({ port: 4100 });
    const r = recorder();
    const files = onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000], ['10.0.0.9', 4000]]);
    const ctl = new UpstreamController(c, files, r.apply, { waitMs: 0, applyConfig: false });
    expect(await ctl.drain('one')).toBe(true);
    expect(hostsPorts(r.writes.at(-1))).toEqual(['10.0.0.1:4000 down', '10.0.0.2:4000', '10.0.0.9:4000']);
    await ctl.healthy('one', { applied: true });
    await ctl.finalize(new Set());
    expect(r.files.get('p1')).toBe(files.get('p1'));
    expect(ctl.missingServers()).toEqual([]);
  });

  it('a changed address drains the server: its old entry leaves the upstream before the restart', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.5', two: '10.0.0.2' } });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    expect(await ctl.drain('one')).toBe(true);
    expect(hostsPorts(r.writes.at(-1))).toEqual(['10.0.0.2:4000']);
    await ctl.healthy('one', { applied: true });
    expect(hostsPorts(r.writes.at(-1))).toEqual(['10.0.0.5:4000', '10.0.0.2:4000']);
  });

  it('removes an entry of a removed server at the first write, adds a new server after it is healthy', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.1', two: '10.0.0.2', four: '10.0.0.4' } });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000], ['10.0.0.3', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('one');
    expect(hostsPorts(r.writes[0])).toEqual(['10.0.0.1:4000 down', '10.0.0.2:4000']);
    expect(await ctl.drain('four')).toBe(false);
    await ctl.healthy('four', { applied: true });
    expect(hostsPorts(r.writes.at(-1))).toEqual(['10.0.0.1:4000 down', '10.0.0.2:4000', '10.0.0.4:4000']);
  });

  it('a new server that did not deploy is not added, and is reported as missing', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.1', two: '10.0.0.2', four: '10.0.0.4' } });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.healthy('four', { applied: false });
    await ctl.finalize(new Set());
    expect(r.files.get('p1')).toBeUndefined();
    expect(ctl.missingServers()).toEqual(['four']);
  });

  it('finalize writes the MUP form, keeping only the requested down marks', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000, true], ['10.0.0.2', 4000, true]]), r.apply, NO_WAIT);
    await ctl.finalize(new Set(['two']));
    expect(r.writes.at(-1)).toBe(formatUpstream(c, [{ host: '10.0.0.1', port: 4000, down: false }, { host: '10.0.0.2', port: 4000, down: true }]));
    await ctl.finalize(new Set());
    expect(r.writes.at(-1)).toBe(mupUpstreamFile(c));
  });

  it('finalize does not write when the file already has the final form', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, new Map([['p1', mupUpstreamFile(c)], ['p2', mupUpstreamFile(c)]]), r.apply, NO_WAIT);
    await ctl.finalize(new Set());
    expect(r.writes).toHaveLength(0);
  });

  it('finalize brings a file in the old format (stickySessions changed) to the MUP form without a drain', async () => {
    const c = lbConfig({ port: 4000, sticky: false });
    const old = formatUpstream(lbConfig({ port: 4000, sticky: true }), desiredEntries(c));
    const r = recorder();
    const ctl = new UpstreamController(c, new Map([['p1', old], ['p2', old]]), r.apply, NO_WAIT);
    await ctl.finalize(new Set());
    expect(r.files.get('p1')).toBe(mupUpstreamFile(c));
    expect(r.files.get('p2')).toBe(mupUpstreamFile(c));
  });

  it('serializes writes from parallel drains', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.1', two: '10.0.0.2', three: '10.0.0.3' } });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000], ['10.0.0.3', 4000]]), r.apply, NO_WAIT);
    const results = await Promise.all([ctl.drain('two'), ctl.drain('three')]);
    expect(results).toEqual([true, true]);
    expect(r.maxActive()).toBe(1);
    expect(ctl.downServers().sort()).toEqual(['three', 'two']);
  });

  it('writes only to the proxies whose file differs', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]], [['10.0.0.1', 4000], ['10.0.0.2', 4000, true]]), r.apply, NO_WAIT);
    await ctl.healthy('two', { applied: true });
    expect(r.targets).toEqual([['p2']]);
  });

  it('retries a proxy whose restore failed, so it does not keep the server down', async () => {
    const c = lbConfig({ port: 4000 });
    // p2's second write (the restore of two) fails once.
    const r = recorder({ fail: (proxy, call) => proxy === 'p2' && call === 2 });
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('two');
    await ctl.healthy('two', { applied: true });
    expect(hostsPorts(r.files.get('p2'))).toEqual(['10.0.0.1:4000', '10.0.0.2:4000 down']);
    await ctl.finalize(new Set(ctl.downServers()));
    expect(r.files.get('p2')).toBe(mupUpstreamFile(c));
    expect(ctl.failures()).toEqual([]);
  });

  it('reports a proxy that stays unreachable with the servers that may still be down there', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder({ fail: (proxy, call) => proxy === 'p2' && call >= 2 });
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    expect(await ctl.drain('one')).toBe(true);
    await ctl.healthy('one', { applied: true });
    await ctl.finalize(new Set(ctl.downServers()));
    expect(ctl.downServers()).toEqual([]);
    expect(ctl.failures()).toEqual([{ proxy: 'p2', error: 'connection lost', down: ['one'] }]);
  });

  it('a write that failed counts as unknown: the next write goes to that proxy again', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder({ fail: (proxy, call) => proxy === 'p2' && call === 1 });
    const ctl = new UpstreamController(c, onProxies(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, NO_WAIT);
    await ctl.drain('one');
    await ctl.healthy('one', { applied: true });
    expect(r.targets).toEqual([['p1', 'p2'], ['p1', 'p2']]);
    expect(ctl.failures()).toEqual([]);
  });
});
