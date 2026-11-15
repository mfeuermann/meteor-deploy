/**
 * MUP's bundle mode (spec 2026-11-15 bundle mode §6): MUP 1.5.11 and comet-deploy take turns
 * on one server with `docker.prepareBundle: false`. MUP runs the base image with the bundle
 * mounted from /opt/<app>/current; comet-deploy runs images with the bundle in /bundle, takes
 * over MUP's version whenever MUP deployed last, and MUP keeps working after it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, imageId, mup, sampleProject, writeTestConfig } from './helpers.js';

describe('interop with MUP 1.5.11 in bundle mode', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];

  /** Makes the app answer `/v` with `v`, so each step deploys a new version. */
  const setVersion = (v: string) => {
    const main = join(p.appDir, 'server', 'main.js');
    const src = readFileSync(main, 'utf8').replace(/\n\/\/ bundle-test-version[\s\S]*$/, '');
    writeFileSync(main, `${src}\n// bundle-test-version\nWebApp.handlers.get('/v', (req, res) => res.end('${v}'));\n`);
  };
  /** Whether the app container has a mount at /bundle (MUP's way of running the bundle). */
  const mountsBundle = async () =>
    (await server.exec(`docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' ${APP_NAME}`)).stdout.split(' ').includes('/bundle');
  const label = async (tag: string) =>
    (await server.exec(`docker image inspect -f '{{index .Config.Labels "comet-deploy.bundle"}}' mup-${APP_NAME}:${tag}`)).stdout.trim();
  const ok = (r: { code: number; output: string }) => expect(r.code, r.output).toBe(0);

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject();
    // zodern/meteor:root runs as root, so it can unpack the bundle in /bundle. The longer wait
    // leaves time for the npm install and the Node download at every start.
    // zodern/meteor:root exists only for linux/amd64. MUP runs it on the (arm64) test server under
    // emulation; comet-deploy builds the bundle image for one platform of the base image, so the
    // platform is fixed to amd64 here, as with amd64 servers.
    writeTestConfig(p.deployDir, [server], {
      docker: { image: 'zodern/meteor:root', prepareBundle: false },
      cometDeploy: { platform: 'linux/amd64' },
    });
    const mupJs = join(p.deployDir, 'mup.js');
    writeFileSync(mupJs, readFileSync(mupJs, 'utf8').replace('"deployCheckWaitTime": 120', '"deployCheckWaitTime": 300'));
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('1. mup setup + mup deploy run the bundle mounted at /bundle', async () => {
    setVersion('v1');
    ok(await mup(['setup', ...config()], p.root));
    ok(await mup(['deploy', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v1');
    expect(await mountsBundle()).toBe(true);
  });

  it('2. our deploy takes over the MUP version as :previous', async () => {
    setVersion('v2');
    ok(await cli(['deploy', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v2');
    expect(await mountsBundle()).toBe(false);
    const adopted = await imageId(server, 'mup-bundle');
    expect(adopted).not.toBe('');
    expect(await imageId(server, 'previous')).toBe(adopted);
    expect(await label('mup-bundle')).toBe('1');
  });

  it('3. our rollback returns to the MUP version', async () => {
    ok(await cli(['rollback', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v1');
    expect(await mountsBundle()).toBe(false);
  });

  it('4. mup deploy right after the rollback runs its new version', async () => {
    // MUP's `docker rmi :latest` must work although :latest is the image the app runs.
    setVersion('v4');
    ok(await mup(['deploy', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v4');
    expect(await mountsBundle()).toBe(true);
  });

  it('5. our deploy keeps the MUP version as :previous; mup reconfig runs ours', async () => {
    setVersion('v5');
    ok(await cli(['deploy', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v5');
    expect(await imageId(server, 'previous')).toBe(await imageId(server, 'mup-bundle'));
    ok(await mup(['reconfig', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v5');
  });

  it('6. our restart after mup deploy runs the same MUP version from the taken-over image', async () => {
    setVersion('v6');
    ok(await mup(['deploy', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v6');
    ok(await cli(['restart', ...config()], p.root));
    expect(await curlApp(server, '/v')).toBe('v6');
    expect(await mountsBundle()).toBe(false);
    // The versions taken over before are gone: no untagged image of a takeover is left.
    expect((await server.exec(`docker images -q -f dangling=true -f label=comet-deploy.bundle=1`)).stdout.trim()).toBe('');
  });
});
