/**
 * The stream transfer end to end (stream plan Task 4): one fake server allows SSH forwarding,
 * the other does not. With the default `transfer: 'auto'` a deploy reaches both (the second
 * gets the whole image over SSH, with a warning), a rollback works on both, and no archive is
 * left on this machine; `transfer: 'tunnel'` stops in preflight instead.
 */
import { appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, imageId, sampleProject, writeTestConfig } from './helpers.js';

const archivesLeft = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`comet-deploy-${APP_NAME}-`));

describe('deploy to a server without SSH forwarding', () => {
  let tunnel: FakeServer;
  let noForward: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const both = () => [tunnel, noForward];

  beforeAll(async () => {
    [[tunnel], [noForward]] = await Promise.all([startFakeServers(1), startFakeServers(1, { allowTcpForwarding: false, namePrefix: 'n' })]);
    p = sampleProject();
    writeTestConfig(p.deployDir, both());
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
  });

  afterAll(async () => {
    await Promise.all([tunnel?.stop(), noForward?.stop()]);
  });

  it('deploy with transfer auto reaches both servers', async () => {
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('Server "n1": SSH port forwarding is off');
    expect(r.output).not.toContain('Server "s1": SSH port forwarding is off');
    expect(r.output).toMatch(/\[n1\] distribute .*\(whole image, [\d.]+ MB\)/);
    for (const s of both()) expect(await curlApp(s, '/native')).toBe('60');
    expect(archivesLeft()).toEqual([]);
  });

  it('a new version reaches both servers and rollback goes back on both', async () => {
    const before = await Promise.all(both().map((s) => imageId(s, 'latest')));
    appendFileSync(join(p.appDir, 'server/main.js'), `\n// stream test change ${Date.now()}\n`);
    const deploy = await cli(['deploy', ...config()], p.root);
    expect(deploy.code, deploy.output).toBe(0);
    const after = await Promise.all(both().map((s) => imageId(s, 'latest')));
    after.forEach((id, i) => expect(id).not.toBe(before[i]));
    const rollback = await cli(['rollback', ...config()], p.root);
    expect(rollback.code, rollback.output).toBe(0);
    expect(await Promise.all(both().map((s) => imageId(s, 'latest')))).toEqual(before);
    for (const s of both()) expect(await curlApp(s, '/native')).toBe('60');
    expect(archivesLeft()).toEqual([]);
  });

  it('transfer tunnel stops in preflight on the server without forwarding', async () => {
    const before = await Promise.all(both().map((s) => imageId(s, 'latest')));
    writeTestConfig(p.deployDir, both(), { cometDeploy: { transfer: 'tunnel' } });
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).not.toBe(0);
    expect(r.output).toContain('Server "n1": SSH reverse port forwarding does not work');
    expect(r.output).toContain('Or set cometDeploy.transfer to "auto" to send the whole image over SSH instead.');
    expect(r.output).not.toContain('==> Build');
    expect(await Promise.all(both().map((s) => imageId(s, 'latest')))).toEqual(before);
  });
});
