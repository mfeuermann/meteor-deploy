import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../../src/config/normalize.js';
import { activateServer, type ActivateDeps } from '../../../src/deploy/activate.js';
import { createReporter } from '../../../src/output/reporter.js';
import { renderEnvList, renderStartSh } from '../../../src/remote/app-files.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';

const config = normalizeConfig(
  {
    servers: { one: { host: '192.0.2.1', username: 'root', password: 'x' } },
    app: { name: 'myapp', path: '/srv/x', servers: { one: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
  },
  { basePath: '/srv' },
);
const settings = { public: {} };

function label(script: string): string {
  if (script.includes('COMET_HEALTH')) return 'health';
  if (script.includes('Copies the current start.sh')) return 'snapshot';
  if (script.includes('cp -p "$CONFIG_DIR/.prev/start.sh"')) return 'restore';
  if (script.includes('echo "activated"') && script.includes('VERSION=')) return 'retag-activate';
  if (script.includes('echo "reverted"')) return 'retag-revert';
  if (script.includes('# start app')) return 'meteor-start';
  return script.trim();
}

function mockConn(health: string) {
  const calls: string[] = [];
  const writes: Record<string, string> = {};
  const answer = (l: string): string =>
    ({ health, snapshot: 'ok\n', restore: 'ok\n', 'retag-revert': 'reverted\n', 'retag-activate': 'activated\n' })[l] ?? '';
  const res = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
  const conn = {
    name: 'one',
    host: '192.0.2.1',
    async runScript(s: string) {
      const l = label(s);
      calls.push(l);
      return res(answer(l));
    },
    async runScriptOrThrow(s: string) {
      const l = label(s);
      calls.push(l);
      return res(answer(l));
    },
    async exec(cmd: string) {
      calls.push(cmd);
      return res(cmd.includes('docker logs') ? 'app crashed: boom\n' : '');
    },
    async writeFile(path: string, content: string) {
      calls.push(`write ${path}`);
      writes[path] = content;
    },
  };
  return { conn: conn as unknown as SshConnection, calls, writes };
}

const deps = (conn: SshConnection): ActivateDeps => ({
  conn,
  config,
  settings,
  serverName: 'one',
  cwd: '/srv',
  basePath: '/srv',
  reporter: createReporter({ verbose: false, tty: false, write: () => {} }),
});

describe('activateServer', () => {
  it('deploy: snapshot → retag → config files → start → health', async () => {
    const m = mockConn('COMET_HEALTH ok 200 4\n');
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('healthy');
    expect(r.health).toEqual({ ok: true, status: 200, seconds: 4 });
    expect(m.calls).toEqual([
      'snapshot',
      'retag-activate',
      'write /opt/myapp/config/start.sh',
      'write /opt/myapp/config/env.list',
      'meteor-start',
      'health',
    ]);
    expect(m.writes['/opt/myapp/config/start.sh']).toBe(await renderStartSh(config, 'one'));
    expect(m.writes['/opt/myapp/config/env.list']).toBe(await renderEnvList(config, settings, 'one', { cwd: '/srv', basePath: '/srv' }));
  });

  it('deploy: a failed health check prints logs and reverts image and config', async () => {
    const m = mockConn('COMET_HEALTH fail crashed - 2\n');
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('reverted');
    expect(r.logsTail).toContain('app crashed: boom');
    expect(m.calls.slice(6)).toEqual(['sudo docker logs --tail 100 myapp 2>&1', 'restore', 'retag-revert', 'sudo bash /opt/myapp/config/start.sh']);
  });

  it('reconfig: no retag, and the revert restores only the config', async () => {
    const m = mockConn('COMET_HEALTH fail timeout 503 60\n');
    const r = await activateServer(deps(m.conn), { version: null, mode: 'reconfig' });
    expect(r.status).toBe('reverted');
    expect(m.calls).not.toContain('retag-activate');
    expect(m.calls).not.toContain('retag-revert');
    expect(m.calls).toContain('restore');
  });

  it('rollback: retag only, the server config stays', async () => {
    const m = mockConn('COMET_HEALTH ok 200 1\n');
    const r = await activateServer(deps(m.conn), { version: '20261101-100000', mode: 'rollback' });
    expect(r.status).toBe('healthy');
    expect(m.calls).toEqual(['retag-activate', 'meteor-start', 'health']);
  });
});
