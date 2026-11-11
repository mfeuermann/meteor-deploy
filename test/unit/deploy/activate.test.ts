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
  if (script.includes('echo "restored"')) return 'retag-restore';
  if (script.includes('echo "swapped"')) return 'retag-swap';
  if (script.includes('echo "reverted"')) return 'retag-revert';
  if (script.includes('# start app')) return 'meteor-start';
  return script.trim();
}

const BEFORE = 'before-latest=sha256:aaaaaaaaaaaa\nbefore-previous=sha256:bbbbbbbbbbbb\n';

/** `health`: one answer for every check, or one per check (the last one repeats). */
function mockConn(health: string | string[]) {
  const healthAnswers = Array.isArray(health) ? [...health] : [health];
  const nextHealth = () => (healthAnswers.length > 1 ? healthAnswers.shift()! : healthAnswers[0]);
  const calls: string[] = [];
  const writes: Record<string, string> = {};
  const answer = (l: string): string =>
    ({ health: l === 'health' ? nextHealth() : '', snapshot: 'ok\n', restore: 'ok\n', 'retag-revert': 'reverted\n', 'retag-activate': BEFORE + 'activated\n', 'retag-swap': BEFORE + 'swapped\n', 'retag-restore': 'restored\n' })[l] ?? '';
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
    const m = mockConn(['COMET_HEALTH fail crashed - 2\n', 'COMET_HEALTH ok 200 3\n']);
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('reverted');
    expect(r.logsTail).toContain('app crashed: boom');
    expect(m.calls.slice(6)).toEqual(['sudo docker logs --tail 100 myapp 2>&1', 'restore', 'retag-restore', 'sudo bash /opt/myapp/config/start.sh', 'health']);
  });

  it('reconfig: no retag, and the revert restores only the config', async () => {
    const m = mockConn(['COMET_HEALTH fail timeout 503 60\n', 'COMET_HEALTH ok 200 3\n']);
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

  it('rollback that fails the health check returns to the image that ran, never to an old config snapshot', async () => {
    const m = mockConn(['COMET_HEALTH fail crashed - 3\n', 'COMET_HEALTH ok 200 3\n']);
    const r = await activateServer(deps(m.conn), { version: '20261101-100000', mode: 'rollback' });
    expect(r.status).toBe('reverted');
    expect(m.calls).toContain('retag-restore');
    expect(m.calls).not.toContain('restore');
    expect(m.calls).not.toContain('snapshot');
  });

  it('rollback to :previous swaps latest and previous, so the current image is kept', async () => {
    const m = mockConn('COMET_HEALTH ok 200 1\n');
    const r = await activateServer(deps(m.conn), { version: null, mode: 'rollback' });
    expect(r.status).toBe('healthy');
    expect(m.calls).toEqual(['retag-swap', 'meteor-start', 'health']);
  });

  it('checks the health of the restored version too: reverted only when it answers', async () => {
    const ok = mockConn(['COMET_HEALTH fail crashed - 2\n', 'COMET_HEALTH ok 200 3\n']);
    const r1 = await activateServer(deps(ok.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r1.status).toBe('reverted');
    expect(ok.calls.filter((c) => c === 'health')).toHaveLength(2);

    const bad = mockConn('COMET_HEALTH fail crashed - 2\n');
    const r2 = await activateServer(deps(bad.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r2.status).toBe('revert-failed');
    expect(r2.error).toMatch(/restored version is not healthy/);
  });

  it('C2: revert re-tags exactly the images that ran before (same image re-activated → no downgrade)', async () => {
    const m = mockConn(['COMET_HEALTH fail timeout 503 60\n', 'COMET_HEALTH ok 200 3\n']);
    const scripts: string[] = [];
    const run = m.conn.runScriptOrThrow.bind(m.conn);
    (m.conn as unknown as { runScriptOrThrow: typeof run }).runScriptOrThrow = async (sc: string, ...rest: unknown[]) => {
      scripts.push(sc);
      return (run as (...a: unknown[]) => ReturnType<typeof run>)(sc, ...rest);
    };
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('reverted');
    expect(m.calls).not.toContain('retag-revert');
    const restore = scripts.find((x) => x.includes('echo "restored"'))!;
    expect(restore).toContain("'sha256:aaaaaaaaaaaa'");
    expect(restore).toContain("'sha256:bbbbbbbbbbbb'");
  });

  it('C2: a failure before anything changed reverts nothing and says so', async () => {
    const m = mockConn('COMET_HEALTH ok 200 1\n');
    const run = m.conn.runScriptOrThrow.bind(m.conn);
    (m.conn as unknown as { runScriptOrThrow: (s: string) => Promise<unknown> }).runScriptOrThrow = async (sc: string) => {
      if (sc.includes('Copies the current start.sh')) throw new Error('disk full');
      return run(sc, 'test');
    };
    const r = await activateServer(deps(m.conn), { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/disk full.*not changed/);
    expect(m.calls).not.toContain('restore');
    expect(m.calls).not.toContain('retag-restore');
    expect(m.calls).not.toContain('sudo bash /opt/myapp/config/start.sh');
  });

  it('M11: a config that cannot be rendered fails before the server is changed', async () => {
    const m = mockConn('COMET_HEALTH ok 200 1\n');
    const r = await activateServer({ ...deps(m.conn), settings: { big: 'y'.repeat(70 * 1024) } }, { version: '20261107-183005', mode: 'deploy' });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/64 KiB.*not changed/s);
    expect(m.calls).toEqual([]);
  });
});
