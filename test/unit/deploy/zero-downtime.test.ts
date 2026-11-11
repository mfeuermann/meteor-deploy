import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { normalizeConfig } from '../../../src/config/normalize.js';
import type { NormalizedConfig } from '../../../src/config/types.js';
import { CometError } from '../../../src/core/errors.js';
import { activateServer, startServer, type ActivateDeps } from '../../../src/deploy/activate.js';
import { nextContainerScript, zeroDowntimeBlocker } from '../../../src/deploy/zero-downtime.js';
import { createReporter } from '../../../src/output/reporter.js';
import { renderStartSh } from '../../../src/remote/app-files.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/configs');

function load(name: string, edit: (raw: any) => void = () => {}): NormalizedConfig {
  const dir = join(fixtures, name);
  const { raw, basePath } = loadConfig(dir, './mup.js');
  edit(raw);
  return normalizeConfig(raw, { basePath });
}

const withProxy = (raw: any) => {
  raw.proxy = { domains: 'zd.example.com' };
};

/** The block start.sh's "remove the old container" part, as nextContainerScript cuts it. */
const REMOVE_BLOCK = /# Remove previous version of the app, if exists[\s\S]*?>&2 echo "Finished removing docker containers"\n?/;

describe('nextContainerScript', () => {
  for (const [name, edit] of [
    ['proxy-le', () => {}],
    ['aaa-like', withProxy],
    ['per-server-env', withProxy],
  ] as const) {
    it(`${name}: starts <app>-next beside the app and changes nothing else`, async () => {
      const c = load(name, edit);
      const server = Object.keys(c.app.servers)[0];
      const original = await renderStartSh(c, server);
      const next = nextContainerScript(original);
      expect(next).not.toContain('docker rm -f $APPNAME\n');
      expect(next).toContain('--name=$APPNAME-next');
      for (const line of next.split('\n').filter((l) => l.includes('docker network connect'))) expect(line).toMatch(/ \$APPNAME-next$/);
      expect(next.replaceAll('$APPNAME-next', '$APPNAME')).toBe(original.replace(REMOVE_BLOCK, ''));
    });
  }

  it('connects the next container to every docker.networks network', async () => {
    const c = load('proxy-le', (raw) => {
      raw.app.docker.networks = ['net-a', 'net-b'];
    });
    const next = nextContainerScript(await renderStartSh(c, 'one'));
    expect(next).toMatch(/docker network connect net-a \$APPNAME-next/);
    expect(next).toMatch(/docker network connect net-b \$APPNAME-next/);
  });

  it('refuses a start.sh it does not know', () => {
    expect(() => nextContainerScript('#!/bin/bash\necho hi\n')).toThrow(CometError);
    expect(() => nextContainerScript('#!/bin/bash\necho hi\n')).toThrow(/unknown form/);
  });
});

describe('zeroDowntimeBlocker', () => {
  it('allows the proxy without load balancing', () => {
    expect(zeroDowntimeBlocker(load('proxy-le'))).toBeNull();
  });

  it('names the reason otherwise', () => {
    expect(zeroDowntimeBlocker(load('proxy-lb'))).toMatch(/loadBalancing/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.app.docker.args = ['-p 9000:9000'])))).toMatch(/publishes a host port/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.app.docker.args = ['--publish=9000:9000'])))).toMatch(/publishes a host port/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.app.docker.args = ['--network=host'])))).toMatch(/host network/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.app.docker.args = ['--name foo'])))).toMatch(/--name/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.app.docker.networks = ['host'])))).toMatch(/host network/);
    expect(zeroDowntimeBlocker(load('proxy-le', (raw) => (raw.cometDeploy = { zeroDowntime: false })))).toMatch(/zeroDowntime/);
    expect(zeroDowntimeBlocker(load('aaa-like'))).toMatch(/proxy/);
  });
});

/** Labels for the calls of a zero-downtime activation. */
function label(s: string): string {
  if (s.includes('COMET_HEALTH')) return /CONTAINER='?myapp-next'?/.test(s) ? 'health next' : 'health app';
  if (s.includes('Copies the current start.sh')) return 'snapshot';
  if (s.includes('cp -p "$CONFIG_DIR/.prev/start.sh"')) return 'restore';
  if (s.includes('echo "activated"') && s.includes('VERSION=')) return 'retag-activate';
  if (s.includes('echo "restored"')) return 'retag-restore';
  if (s.includes('# zd-start.sh')) return 'zd-start';
  if (s.includes('# zd-finish.sh')) return 'zd-finish';
  if (s.includes('# start app')) return 'meteor-start';
  if (s.includes('docker rm -f myapp-next')) return 'rm next';
  if (s.includes('cat /opt/myapp/config/start.sh')) return 'read start.sh';
  if (s.includes('{{range .NetworkSettings.Networks}}')) return 'next ip';
  if (s.includes('cat /etc/nginx/conf.d/default.conf')) return 'default.conf';
  if (s.includes('docker logs')) return 'logs next';
  if (s.includes('docker inspect') && s.includes('Running')) return 'app running?';
  if (s.includes('sudo bash /opt/myapp/config/start.sh')) return 'start.sh';
  return s.trim();
}

function zdConn(o: { health: string[]; routed: boolean; startSh: string }) {
  const answers = [...o.health];
  const calls: string[] = [];
  const res = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
  const answer = (l: string): string => {
    switch (l) {
      case 'health next':
      case 'health app':
        return answers.length > 1 ? answers.shift()! : answers[0];
      case 'snapshot':
      case 'restore':
        return 'ok\n';
      case 'retag-activate':
        return 'before-latest=sha256:aaaaaaaaaaaa\nbefore-previous=sha256:bbbbbbbbbbbb\nactivated\n';
      case 'retag-restore':
        return 'restored\n';
      case 'read start.sh':
        return o.startSh;
      case 'next ip':
        return '172.17.0.9 \n';
      case 'default.conf':
        return o.routed ? 'upstream zd.example.com {\n  server 172.17.0.8:3000;\n  server 172.17.0.9:3000;\n}\n' : 'upstream zd.example.com {\n  server 172.17.0.8:3000;\n}\n';
      case 'logs next':
        return 'next crashed: boom\n';
      case 'app running?':
        return 'true\n';
      default:
        return '';
    }
  };
  const run = async (s: string) => {
    const l = label(s);
    calls.push(l);
    return res(answer(l));
  };
  const conn = { name: 'one', host: '192.0.2.1', runScript: run, runScriptOrThrow: run, exec: run, writeFile: async (p: string) => void calls.push(`write ${p}`) };
  return { conn: conn as unknown as SshConnection, calls };
}

const zdConfig = load('proxy-le', (raw) => {
  raw.app.name = 'myapp';
});

const deps = (conn: SshConnection): ActivateDeps => ({
  conn,
  config: zdConfig,
  settings: { public: {} },
  serverName: 'one',
  cwd: '/srv',
  basePath: '/srv',
  reporter: createReporter({ verbose: false, tty: false, write: () => {} }),
});

describe('activateServer with the zero-downtime switch', () => {
  const ZD = { kind: 'zero-downtime' } as const;

  it('starts <app>-next, waits for nginx, then replaces the app', async () => {
    const m = zdConn({ health: ['COMET_HEALTH ok 200 4\n'], routed: true, startSh: await renderStartSh(zdConfig, 'one') });
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy', switch: ZD, pickupTimeoutMs: 0 });
    expect(r.status).toBe('healthy');
    expect(m.calls).toEqual([
      'snapshot',
      'retag-activate',
      'write /opt/myapp/config/start.sh',
      'write /opt/myapp/config/env.list',
      'rm next',
      'read start.sh',
      'zd-start',
      'health next',
      'next ip',
      'default.conf',
      'zd-finish',
    ]);
  });

  it('a failed health check keeps the old container: logs of next, rm next, restore, no start.sh', async () => {
    const m = zdConn({ health: ['COMET_HEALTH fail crashed - 2\n', 'COMET_HEALTH ok 200 1\n'], routed: true, startSh: await renderStartSh(zdConfig, 'one') });
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy', switch: ZD, pickupTimeoutMs: 0 });
    expect(r.status).toBe('reverted');
    expect(r.logsTail).toContain('next crashed: boom');
    const after = m.calls.slice(m.calls.indexOf('health next') + 1);
    expect(after).toEqual(['logs next', 'rm next', 'app running?', 'restore', 'retag-restore', 'health app']);
    expect(m.calls).not.toContain('start.sh');
    expect(m.calls).not.toContain('meteor-start');
    expect(m.calls).not.toContain('zd-finish');
  });

  it('nginx not routing to the new container in time is a failure with the same revert', async () => {
    const m = zdConn({ health: ['COMET_HEALTH ok 200 4\n'], routed: false, startSh: await renderStartSh(zdConfig, 'one') });
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy', switch: ZD, pickupTimeoutMs: 0 });
    expect(r.status).toBe('reverted');
    expect(r.error).toMatch(/nginx/);
    expect(m.calls).not.toContain('zd-finish');
    expect(m.calls.slice(-5)).toEqual(['rm next', 'app running?', 'restore', 'retag-restore', 'health app']);
  });

  it('restart switches too, without meteor-start.sh', async () => {
    const m = zdConn({ health: ['COMET_HEALTH ok 200 4\n'], routed: true, startSh: await renderStartSh(zdConfig, 'one') });
    const r = await startServer({ conn: m.conn, config: zdConfig, serverName: 'one', reporter: deps(m.conn).reporter }, { switch: ZD, pickupTimeoutMs: 0 });
    expect(r.status).toBe('healthy');
    expect(m.calls).toEqual(['rm next', 'read start.sh', 'zd-start', 'health next', 'next ip', 'default.conf', 'zd-finish']);
  });
});
