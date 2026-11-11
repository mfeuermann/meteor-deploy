/**
 * End-to-end as a non-root SSH user: Docker runs through passwordless sudo,
 * the base image is `zodern/meteor:root` and METEOR_SETTINGS is about 40 KB
 * (well under Docker's 64 KiB env-file line limit, but far above typical).
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, sampleProject, writeTestConfig } from '../integration/helpers.js';

const SETTINGS = { public: { s: 'big "settings" ü' }, blob: 'y'.repeat(40_000) };
const SPECIAL = 'deployer $USER';

describe('e2e: non-root SSH user, zodern/meteor:root, ~40 KB settings', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];

  beforeAll(async () => {
    [server] = await startFakeServers(1, { user: 'deployer' });
    p = sampleProject();
    writeTestConfig(p.deployDir, [server], { env: { SPECIAL }, settings: SETTINGS, docker: { image: 'zodern/meteor:root' } });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('setup and deploy work through sudo; settings and the native module arrive intact', async () => {
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);

    expect(await curlApp(server, '/native')).toBe('60');
    expect(JSON.parse(await curlApp(server, '/env'))).toEqual({ s: SETTINGS.public.s, e: SPECIAL });
    const envList = (await server.exec(`cat /opt/${APP_NAME}/config/env.list`)).stdout;
    expect(envList.length).toBeGreaterThan(40_000);
  });
});
