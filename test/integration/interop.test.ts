/**
 * Interchangeability with MUP 1.5.11 (spec §13, Review Focus 4): the same
 * mup.js works with both tools, in both directions, on one server.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, curlVia, imageId, mup, sampleProject, waitFor, writeTestConfig } from './helpers.js';

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
