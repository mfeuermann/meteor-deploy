/**
 * Hooks end to end on one fake server (hooks plan Task 7): every form of hook runs in MUP's
 * order during a deploy, a method hook that changes the settings changes what the app gets, and
 * a failing hook before the activation leaves the old version running and no deploy lock.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServers, type FakeServer } from '../harness/fake-servers.js';
import { APP_NAME, cli, curlApp, imageId, sampleProject, writeTestConfig } from './helpers.js';

/** A method hook that appends `line` to /tmp/hooks.log on the (only) server through api.runSSHCommand. */
const sshAppend = (line: string) => `async (api) => {
  const r = await api.runSSHCommand(Object.values(api.getConfig().servers)[0], 'echo ${line} >> /tmp/hooks.log');
  if (r.code !== 0) throw new Error(r.output);
}`;

describe('hooks', () => {
  let server: FakeServer;
  let p: ReturnType<typeof sampleProject>;
  const config = () => ['--config', join(p.deployDir, 'mup.js')];
  const localLog = (file = 'hooks-local.log') => {
    const path = join(p.deployDir, file);
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  };
  const remoteLog = async () => (await server.exec('cat /tmp/hooks.log 2>/dev/null')).stdout.split('\n').filter(Boolean);

  beforeAll(async () => {
    [server] = await startFakeServers(1);
    p = sampleProject();
    writeTestConfig(p.deployDir, [server]);
    const setup = await cli(['setup', ...config()], p.root);
    expect(setup.code, setup.output).toBe(0);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('deploy runs the hooks of every form in MUP order', async () => {
    writeTestConfig(p.deployDir, [server], {
      hooks: `{
        'pre.deploy': {
          localCommand: 'echo pre.deploy:local >> hooks-local.log',
          method: ${sshAppend('pre.deploy:method')},
          remoteCommand: 'echo pre.deploy:remote >> /tmp/hooks.log',
        },
        'pre.meteor.build': { localCommand: 'echo pre.meteor.build >> hooks-local.log' },
        'post.meteor.prepareBundle': { remoteCommand: 'echo post.meteor.prepareBundle >> /tmp/hooks.log' },
        'pre.meteor.start': { method: ${sshAppend('pre.meteor.start')} },
        'post.deploy': { localCommand: 'echo post.deploy >> hooks-local.log', remoteCommand: 'echo post.deploy >> /tmp/hooks.log' },
      }`,
    });
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(localLog()).toEqual(['pre.deploy:local', 'pre.meteor.build', 'post.deploy']);
    expect(await remoteLog()).toEqual(['pre.deploy:method', 'pre.deploy:remote', 'post.meteor.prepareBundle', 'pre.meteor.start', 'post.deploy']);
    // The local hooks run before the build, the last one after the activation.
    expect(r.output.indexOf('> Running hook pre.meteor.build')).toBeLessThan(r.output.indexOf('==> Build'));
    expect(r.output.indexOf('> Running hook post.default.deploy')).toBeGreaterThan(r.output.indexOf('==> Activate'));
    expect(await curlApp(server, '/native')).toBe('60');
  });

  it('a method in pre.reconfig changes the settings the app gets', async () => {
    writeTestConfig(p.deployDir, [server], {
      hooks: `{ 'pre.reconfig': { method: (api) => { api.settings.public.s = 'from-hook'; } } }`,
    });
    const r = await cli(['reconfig', ...config()], p.root);
    expect(r.code, r.output).toBe(0);
    expect(JSON.parse(await curlApp(server, '/env')).s).toBe('from-hook');
    // The settings file is unchanged: the hook changed only what this command uses.
    expect(JSON.parse(readFileSync(join(p.deployDir, 'settings.json'), 'utf8'))).toEqual({ public: {} });
  });

  it('a failing pre.meteor.start leaves the old version running and no lock', async () => {
    const before = await imageId(server, 'latest');
    writeTestConfig(p.deployDir, [server], {
      hooks: `{
        'pre.meteor.start': { localCommand: 'exit 7' },
        'post.deploy': { localCommand: 'echo ran >> after-failure.log' },
      }`,
    });
    const r = await cli(['deploy', ...config()], p.root);
    expect(r.code, r.output).not.toBe(0);
    expect(r.output).toContain('Hook "pre.meteor.start" failed: "exit 7" exited with code 7.');
    expect(await imageId(server, 'latest')).toBe(before);
    expect(await curlApp(server, '/native')).toBe('60');
    expect((await server.exec(`test -e /opt/${APP_NAME}/config/deploy.lock`)).code).not.toBe(0);
    // No hook runs after the failure.
    expect(localLog('after-failure.log')).toEqual([]);
  });
});
