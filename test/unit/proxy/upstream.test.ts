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

/** A recording `apply` that also counts concurrent calls. */
function recorder(o: { failFor?: string } = {}) {
  const writes: string[] = [];
  let active = 0;
  let maxActive = 0;
  const apply = async (content: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    writes.push(content);
    active--;
    return { failed: o.failFor ? [{ proxy: o.failFor, error: 'connection lost' }] : [] };
  };
  return { apply, writes, maxActive: () => maxActive };
}

const entries = (c: NormalizedConfig, list: Array<[string, number, boolean?]>): UpstreamEntry[] => {
  void c;
  return list.map(([host, port, down]) => ({ host, port, down: !!down }));
};

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
  it('drains one server, but never the last one that is up', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, desiredEntries(c), r.apply, { waitMs: 0 });
    expect(await ctl.drain('one')).toBe(true);
    expect(r.writes.at(-1)).toContain('server 10.0.0.1:4000 down;');
    expect(ctl.downServers()).toEqual(['one']);
    expect(await ctl.drain('two')).toBe(false);
    expect(r.writes).toHaveLength(1);
  });

  it('counts a server that is already down as not up', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, entries(c, [['10.0.0.1', 4000, true], ['10.0.0.2', 4000]]), r.apply, { waitMs: 0 });
    expect(await ctl.drain('two')).toBe(false);
    expect(r.writes).toHaveLength(0);
  });

  it('moves a server to the new port only once it is healthy', async () => {
    const c = lbConfig({ port: 5000 });
    const r = recorder();
    const ctl = new UpstreamController(c, entries(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000]]), r.apply, { waitMs: 0 });
    await ctl.drain('one');
    await ctl.healthy('one');
    expect(parseUpstream(r.writes.at(-1)!)).toEqual([
      { host: '10.0.0.1', port: 5000, down: false },
      { host: '10.0.0.2', port: 4000, down: false },
    ]);
  });

  it('removes an entry of a removed server at the first write, adds a new server after it is healthy', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.1', two: '10.0.0.2', four: '10.0.0.4' } });
    const r = recorder();
    const ctl = new UpstreamController(c, entries(c, [['10.0.0.1', 4000], ['10.0.0.2', 4000], ['10.0.0.3', 4000]]), r.apply, { waitMs: 0 });
    await ctl.drain('one');
    const first = parseUpstream(r.writes[0]).map((e) => e.host);
    expect(first).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(await ctl.drain('four')).toBe(false);
    await ctl.healthy('four');
    expect(parseUpstream(r.writes.at(-1)!).map((e) => `${e.host}${e.down ? ' down' : ''}`)).toEqual(['10.0.0.1 down', '10.0.0.2', '10.0.0.4']);
  });

  it('finalize writes the MUP form, keeping only the requested down marks', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, entries(c, [['10.0.0.1', 4000, true], ['10.0.0.2', 4000, true]]), r.apply, { waitMs: 0 });
    await ctl.finalize(new Set(['two']));
    expect(r.writes.at(-1)).toBe(formatUpstream(c, [{ host: '10.0.0.1', port: 4000, down: false }, { host: '10.0.0.2', port: 4000, down: true }]));
    await ctl.finalize(new Set());
    expect(r.writes.at(-1)).toBe(mupUpstreamFile(c));
  });

  it('finalize does not write when the file already has the final form', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder();
    const ctl = new UpstreamController(c, desiredEntries(c), r.apply, { waitMs: 0 });
    await ctl.finalize(new Set());
    expect(r.writes).toHaveLength(0);
  });

  it('serializes writes from parallel drains', async () => {
    const c = lbConfig({ port: 4000, servers: { one: '10.0.0.1', two: '10.0.0.2', three: '10.0.0.3' } });
    const r = recorder();
    const ctl = new UpstreamController(c, desiredEntries(c), r.apply, { waitMs: 0 });
    const results = await Promise.all([ctl.drain('two'), ctl.drain('three')]);
    expect(results).toEqual([true, true]);
    expect(r.maxActive()).toBe(1);
    expect(ctl.downServers().sort()).toEqual(['three', 'two']);
  });

  it('records proxies where a write failed and still counts the drain', async () => {
    const c = lbConfig({ port: 4000 });
    const r = recorder({ failFor: 'p2' });
    const ctl = new UpstreamController(c, desiredEntries(c), r.apply, { waitMs: 0 });
    expect(await ctl.drain('one')).toBe(true);
    expect(ctl.failures()).toEqual([{ proxy: 'p2', error: 'connection lost' }]);
  });
});
