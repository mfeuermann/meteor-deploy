/**
 * MUP 1.5.11 and comet-deploy on one server with a private registry (registry design §4.5,
 * §4.6): MUP's start.sh pulls `<prefix>/mup-<app>:latest` from the registry, comet-deploy's
 * never pulls. comet-deploy takes over the image MUP runs, keeps `:latest` in the registry on
 * its version for `mup reconfig`, and refuses a rollback while MUP's start.sh is on the server.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { forwardRegistry, isolatedDockerConfig, startTestRegistry, type TestRegistry } from '../harness/registry.js';
import { APP_NAME, cli, curlApp, imageId, mup, sampleProject, writeTestConfig } from './helpers.js';

describe('interop with MUP 1.5.11 through a private registry', () => {
  let server: FakeServer;
  let reg: TestRegistry;
  let dockerConfig: ReturnType<typeof isolatedDockerConfig>;
  let p: ReturnType<typeof sampleProject>;
  let mup1 = '';
  let comet1 = '';
  let mup2 = '';
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const containerImage = async () => (await server.exec(`docker inspect -f '{{.Image}}' ${APP_NAME} 2>/dev/null`)).stdout.trim();
  const change = () => appendFileSync(join(p.appDir, 'server/main.js'), `\n// registry interop change ${Date.now()}\n`);

  beforeAll(async () => {
    dockerConfig = isolatedDockerConfig();
    [[server], reg] = await Promise.all([startFakeServers(1), startTestRegistry()]);
    await forwardRegistry(server, reg);
    p = sampleProject();
    // useBuildKit: see interop.test.ts (MUP's own build).
    writeTestConfig(p.deployDir, [server], {
      docker: { useBuildKit: true },
      privateDockerRegistry: { host: reg.host, imagePrefix: `${reg.host}/comet`, username: reg.username, password: reg.password },
    });
  }, 1_500_000);

  afterAll(async () => {
    await Promise.all([server?.stop(), reg?.stop()]);
    dockerConfig?.restore();
  });

  it('mup setup + mup deploy with the registry', async () => {
    const setup = await mup(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await mup(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    expect(await curlApp(server, '/native')).toBe('60');
    mup1 = await containerImage();
    expect(mup1).not.toBe('');
  });

  it('comet deploy takes over the image MUP runs as :previous', async () => {
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(await imageId(server, 'previous')).toBe(mup1);
    comet1 = await imageId(server, 'latest');
    expect(await containerImage()).toBe(comet1);
    expect(r.output).toContain(':latest points to this version now');
  });

  it('mup reconfig runs the version comet-deploy deployed', async () => {
    const r = await mup(['reconfig', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(await containerImage()).toBe(comet1);
    expect(await curlApp(server, '/native')).toBe('60');
  });

  it('comet rollback refuses while MUP\'s registry start.sh is on the server', async () => {
    const r = await cli(['rollback', ...config()], p.root);
    expect(r.code, r.output).not.toBe(0);
    expect(r.output).toContain('was last deployed by MUP with privateDockerRegistry');
    expect(await containerImage()).toBe(comet1);
  });

  it('comet reconfig takes the server back, then rollback returns to MUP\'s version', async () => {
    const rc = await cli(['reconfig', ...config()], p.root);
    expect(rc.code, rc.output).toBe(0);
    expect(await containerImage()).toBe(comet1);
    const rb = await cli(['rollback', ...config()], p.root);
    expect(rb.code, rb.output).toBe(0);
    expect(await containerImage()).toBe(mup1);
    expect(await curlApp(server, '/native')).toBe('60');
  });

  it('taking turns: after another mup deploy, comet deploy makes MUP\'s new image :previous', async () => {
    change();
    const md = await mup(['deploy', ...config()], p.root);
    expect(md.code, md.output).toBe(0);
    mup2 = await containerImage();
    expect([mup1, comet1]).not.toContain(mup2);
    change();
    const d = await cli(['deploy', ...config()], p.root);
    expect(d.code, d.output).toBe(0);
    expect(await imageId(server, 'previous')).toBe(mup2);
    // As without a registry, the automatic rollback prefers the newest older comet-deploy
    // version that ran healthy over :previous.
    const rb = await cli(['rollback', ...config()], p.root);
    expect(rb.code, rb.output).toBe(0);
    expect(await containerImage()).toBe(comet1);
    expect(await curlApp(server, '/native')).toBe('60');
  });
});
