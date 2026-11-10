/**
 * End-to-end: the sample app (Meteor 3.5.4 + bcrypt) deployed to two fake
 * servers through the whole command set (spec §13 scenarios).
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, sampleProject, waitFor, writeTestConfig } from '../integration/helpers.js';

// Review Focus 1: values that break naive shell / env.list handling.
const SETTINGS = { public: { s: 'x$HOME "q" ü' } };
const SPECIAL = 'a b$c"d';

describe('e2e: deploy the sample app to two servers', () => {
  let servers: FakeServer[] = [];
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const writeConfig = (env: Record<string, string> = {}) => writeTestConfig(p.deployDir, servers, { env: { SPECIAL, ...env }, settings: SETTINGS });
  const containerRunning = async (s: FakeServer) => (await s.exec(`docker ps -q --filter name=^/${APP_NAME}$`)).stdout.trim() !== '';

  beforeAll(async () => {
    servers = await startFakeServers(2);
    p = sampleProject();
    writeConfig();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
  });

  it('1. setup', async () => {
    const r = await cli(['setup', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
  });

  it('2. deploy: native module works, settings and env arrive byte-exact on both servers', async () => {
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    for (const s of servers) {
      expect(await curlApp(s, '/native')).toBe('60');
      expect(JSON.parse(await curlApp(s, '/env'))).toEqual({ s: SETTINGS.public.s, e: SPECIAL });
    }
  });

  it('3. code-only change: the npm install layer is CACHED and the servers reuse layers', async () => {
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// e2e change ${Date.now()}\n`);
    const r = await cli(['deploy', '--verbose', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    const step = /#(\d+) \[[^\]]*\] RUN cd \/built_app\/programs\/server && npm install/.exec(r.output);
    expect(step, 'npm install step not found in the build output').not.toBeNull();
    expect(r.output).toMatch(new RegExp(`#${step![1]} CACHED`));
    expect(r.output).toContain('Already exists');
  });

  it('4. reconfig that crashes the app: canary reverted, the other server skipped, both still serve', async () => {
    writeConfig({ CRASH_ON_START: '1' });
    const r = await cli(['reconfig', ...config()], p.root);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toMatch(/s1\s+-\s+reverted/);
    expect(r.output).toMatch(/s2\s+-\s+skipped/);
    for (const s of servers) expect(await curlApp(s, '/native')).toBe('60');
    const envList = (await servers[0].exec(`cat /opt/${APP_NAME}/config/env.list`)).stdout;
    expect(envList).not.toContain('CRASH_ON_START');
    expect(envList).toContain('SPECIAL=');
    writeConfig();
  });

  it('5. rollback, then history shows deploy, the reverted reconfig and the rollback', async () => {
    const r = await cli(['rollback', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    for (const s of servers) expect(await curlApp(s, '/native')).toBe('60');
    const h = await cli(['history', ...config()], p.root);
    expect(h.code, h.output).toBe(0);
    expect(h.output).toMatch(/deploy/);
    expect(h.output).toMatch(/reconfig\s+-\s+reverted/);
    expect(h.output).toMatch(/rollback/);
  });

  it('6. a second deploy while the first runs fails on the lock', async () => {
    const first = cli(['deploy', ...config()], p.root);
    const locked = await waitFor(async () => (await servers[0].exec(`test -d /opt/${APP_NAME}/config/deploy.lock`)).code === 0, 300_000);
    expect(locked, 'the first deploy never took the lock').toBe(true);
    const second = await cli(['deploy', ...config()], p.root);
    expect(second.code).toBe(1);
    expect(second.output).toMatch(/lock/i);
    const r = await first;
    expect(r.code, r.output).toBe(0);
  });

  it('7. stop, then start', async () => {
    const stop = await cli(['stop', ...config()], p.root);
    expect(stop.code, stop.output).toBe(0);
    for (const s of servers) expect(await containerRunning(s)).toBe(false);
    const start = await cli(['start', ...config()], p.root);
    expect(start.code, start.output).toBe(0);
    for (const s of servers) {
      expect(await containerRunning(s)).toBe(true);
      expect(await curlApp(s, '/native')).toBe('60');
    }
  });
});
