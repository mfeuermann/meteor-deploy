/**
 * Interchangeability with MUP 1.5.11 (spec §13, Review Focus 4): the same
 * mup.js works with both tools, in both directions, on one server.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS_COMET_DOES_NOT_RUN, MUP_COMMAND_KEYS } from '../../src/hooks/registry.js';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, containerId, curlApp, curlVia, imageId, mup, sampleProject, waitFor, writeTestConfig } from './helpers.js';

describe('interop with MUP 1.5.11', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  let mupImage = '';
  const config = () => ['--config', join(p.deployDir, 'mup.js')];

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject();
    // MUP 1.5.11 without BuildKit COPYs the bundle root-owned and runs `npm install`
    // as the image's `app` user, which cannot chmod the bin files of packages such
    // as node-gyp-build (bcrypt): its own deploy fails with EPERM. With BuildKit MUP
    // extracts the bundle as `app`. comet-deploy ignores the option (COPY --chown).
    writeTestConfig(p.deployDir, [server], { docker: { useBuildKit: true } });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('mup setup + mup deploy', async () => {
    const setup = await mup(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await curlApp(server, '/native')).toBe('60');
    mupImage = await imageId(server, 'latest');
    expect(mupImage).not.toBe('');
  });

  it('history on a server without comet-deploy history is empty, not an error', async () => {
    const h = await cli(['history', ...config()], p.root);
    expect(h.code, h.output).toBe(0);
    expect(h.output).toMatch(/no deploy history/i);
  });

  it('our deploy after MUP; mup restart and mup logs keep working', async () => {
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await imageId(server, 'previous')).toBe(mupImage);
    const restart = await mup(['restart', ...config()], p.root);
    expect(restart.code, restart.output).toBe(0);
    const logs = await mup(['logs', '--tail', '5', ...config()], p.root);
    expect(logs.code, logs.output).toBe(0);
    expect(await curlApp(server, '/native')).toBe('60');
  });

  it('our rollback returns to the version MUP deployed (:previous)', async () => {
    const r = await cli(['rollback', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain(':previous');
    expect(await imageId(server, 'latest')).toBe(mupImage);
    expect(await curlApp(server, '/native')).toBe('60');
  });

  it('mup deploy still works afterwards', async () => {
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await curlApp(server, '/native')).toBe('60');
  });
});

/**
 * The same with the reverse proxy and load balancing (proxy plan Task 8): MUP and comet-deploy
 * take turns on one server, and comet-deploy leaves the proxy files exactly as MUP writes them.
 */
describe('interop with MUP 1.5.11 behind the proxy', () => {
  const DOMAIN = 'interop.test';
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  let mupFiles = '';
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  /** The app's files in the proxy, as `sha256sum` lines (symlinks followed). */
  const proxyFiles = async () =>
    (
      await server.exec(
        `cd /opt && sudo sha256sum mup-nginx-proxy/config/vhost.d/${DOMAIN}* mup-nginx-proxy/upstream/${APP_NAME} ${APP_NAME}/config/proxy-config-container.sh`,
      )
    ).stdout;
  const answers = () => waitFor(async () => (await curlVia(server, DOMAIN, '/native')) === '60', 120_000, 1000);

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject();
    // useBuildKit: see the describe above.
    writeTestConfig(p.deployDir, [server], { docker: { useBuildKit: true }, privateIp: true, proxy: { domains: DOMAIN, loadBalancing: true } });
  }, 1_500_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('mup setup + mup deploy', async () => {
    const setup = await mup(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await answers()).toBe(true);
    mupFiles = await proxyFiles();
    expect(mupFiles).toContain(`upstream/${APP_NAME}`);
    expect(mupFiles).toContain('proxy-config-container.sh');
  }, 1_200_000);

  it('our deploy after MUP leaves the proxy files as MUP wrote them', async () => {
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await answers()).toBe(true);
    expect(await proxyFiles()).toBe(mupFiles);
  });

  it('mup deploy, mup proxy setup and our deploy again', async () => {
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await answers()).toBe(true);
    const proxySetup = await mup(['proxy', 'setup', ...config()], p.root);
    expect(proxySetup.code, proxySetup.output).toBe(0);
    expect(await answers()).toBe(true);
    expect(await proxyFiles()).toBe(mupFiles);
    const ours = await cli(['deploy', ...config()], p.root);
    expect(ours.code, ours.output).toBe(0);
    expect(await answers()).toBe(true);
    expect(await proxyFiles()).toBe(mupFiles);
  });
});

/**
 * The same with MUP's built-in MongoDB (mongo plan Task 8): both tools write the same
 * /opt/mongodb files, so neither one recreates the other's MongoDB container.
 */
describe('interop with MUP 1.5.11 and the mongo section', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const mongoId = () => containerId(server, 'mongodb');
  const read = async () => (await curlApp(server, '/mongo/read')).trim();

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject({ mongo: true });
    // useBuildKit: see the first describe.
    writeTestConfig(p.deployDir, [server], { docker: { useBuildKit: true }, mongo: { version: '7.0.14', servers: { [server.name]: {} } } });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('mup setup + mup deploy, then our deploy reads and writes the same data', async () => {
    const setup = await mup(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await curlApp(server, '/mongo/write?v=mup')).toBe('ok');
    const ours = await cli(['deploy', ...config()], p.root);
    expect(ours.code, ours.output).toBe(0);
    expect(await curlApp(server, '/mongo/write?v=comet')).toBe('ok');
    expect(await read()).toBe('["comet","mup"]');
  });

  it('our setup keeps the MongoDB of MUP, and mup mongo start finds the same start script', async () => {
    const before = await mongoId();
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    expect(setup.output).toContain('MongoDB is up to date (container kept)');
    expect(await mongoId()).toBe(before);
    const start = await mup(['mongo', 'start', '--verbose', ...config()], p.root);
    expect(start.code, start.output).toBe(0);
    expect(start.output).toContain('Same start script');
    expect(await mongoId()).toBe(before);
  });

  it('mup setup after our setup keeps the container', async () => {
    const before = await mongoId();
    const setup = await mup(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    expect(await mongoId()).toBe(before);
    expect(await read()).toBe('["comet","mup"]');
  });
});

/**
 * Hooks next to MUP (hooks plan Task 7): with the mongo and proxy sections, a hook on every MUP
 * key runs at the same point with both tools, and `--show-hook-names` prints the same names.
 * MUP prints `Hook: post.default.<command>` before the nested steps, because its own work for
 * the command runs inside that hook (registered before the config's); the config's
 * `post.default.<command>` hooks run last in both tools.
 */
describe('MUP and comet-deploy run the hooks at the same points', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js'), '--show-hook-names'];
  const hookLines = (output: string) => output.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => l.startsWith('Hook: '));
  /** The hooks that ran since the last call, in order (each one appends its name to a file). */
  const ran = () => {
    const file = join(p.deployDir, 'hook-order.log');
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    writeFileSync(file, '');
    return lines;
  };
  const names = MUP_COMMAND_KEYS.filter((k) => !KEYS_COMET_DOES_NOT_RUN.includes(k)).flatMap((k) => [`pre.${k}`, `post.${k}`]);
  const hooks = `{\n${names.map((n) => `  '${n}': { localCommand: 'echo ${n} >> hook-order.log' },`).join('\n')}\n}`;

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject();
    // useBuildKit: see the first describe.
    writeTestConfig(p.deployDir, [server], {
      docker: { useBuildKit: true },
      proxy: { domains: 'hooks.test' },
      mongo: { version: '7.0.14', servers: { [server.name]: {} } },
      hooks,
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  for (const command of ['setup', 'deploy', 'reconfig', 'restart', 'stop', 'start', 'status']) {
    it(command, async () => {
      const theirs = await mup([command, ...config()], p.root);
      expect(theirs.code, theirs.output).toBe(0);
      const theirOrder = ran();
      const ours = await cli([command, ...config()], p.root);
      expect(ours.code, ours.output).toBe(0);
      const ourOrder = ran();
      expect(theirOrder.length).toBeGreaterThan(0);
      // MUP's proxy plugin does not wait for proxy.status (plugins/proxy/index.js has no return
      // in its post.default.status hook), so the config's post.default.status runs while
      // proxy.status still runs. comet-deploy runs it after proxy.status.
      const expected = command === 'status' ? [...theirOrder.filter((n) => n !== 'post.default.status'), 'post.default.status'] : theirOrder;
      expect(ourOrder).toEqual(expected);
      expect(hookLines(ours.output).sort()).toEqual(hookLines(theirs.output).sort());
    });
  }
});
