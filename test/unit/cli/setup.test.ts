import { describe, expect, it } from 'vitest';
import { destroyApp } from '../../../src/cli/commands/destroy.js';
import { dockerServers, setupAll, uniqueHosts } from '../../../src/cli/commands/setup.js';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

const MUP = (extra = '') => `module.exports = {
  servers: {
    one: { host: '192.0.2.1', username: 'root', password: 'pw' },
    two: { host: '192.0.2.1', username: 'root', password: 'pw' },
    three: { host: '192.0.2.3', username: 'root', password: 'pw' },
    four: { host: '192.0.2.4', username: 'root', password: 'pw' },
  },
  app: { name: 'myapp', path: '../app', servers: { one: {}, two: {}, three: {} }, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
  ${extra}
};`;

const label = (s: string) =>
  s.includes('minimumMajor=18')
    ? 'docker-setup'
    : s.includes('comet-deploy extras')
      ? 'destroy-extra'
      : s.includes('docker image prune')
        ? 'meteor-destroy'
        : s.includes('network disconnect')
          ? 'meteor-stop'
          : s.includes('sudo mkdir -p /opt/')
            ? 'meteor-setup'
            : s.trim().slice(0, 30);

async function setup(extra = '', servers?: string) {
  const dir = tempDir({ '.deploy/mup.js': MUP(extra), '.deploy/settings.json': '{"public":{}}' });
  const out: string[] = [];
  const log: string[] = [];
  const scripts: Record<string, string> = {};
  const timeline: string[] = [];
  const conn = (name: string) => {
    const run = async (s: string): Promise<ExecResult> => {
      const l = label(s);
      log.push(`${name}:${l}`);
      scripts[l] = s;
      timeline.push(`start:${name}:${l}`);
      await new Promise((r) => setTimeout(r, 5));
      timeline.push(`end:${name}:${l}`);
      return { code: 0, stdout: '', stderr: '' };
    };
    return { name, host: name, runScript: run, runScriptOrThrow: run, exec: run } as unknown as SshConnection;
  };
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js', servers },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    },
  );
  return { ctx, log, scripts, timeline, out: () => out.join('') };
}

describe('uniqueHosts', () => {
  it('drops a second server with the same host', async () => {
    const s = await setup();
    expect(uniqueHosts(s.ctx.config, ['one', 'two', 'three'])).toEqual(['one', 'three']);
  });

  it('keeps servers on the same host but another SSH port (port forwarding, test harness)', async () => {
    const s = await setup();
    s.ctx.config.servers.two = { ...s.ctx.config.servers.two, opts: { port: 2222 } } as never;
    expect(uniqueHosts(s.ctx.config, ['one', 'two', 'three'])).toEqual(['one', 'two', 'three']);
  });

  it('docker servers are app + mongo + proxy servers (MUP docker setup)', async () => {
    const s = await setup("mongo: { servers: { four: {} } },");
    expect(dockerServers(s.ctx)).toEqual(['one', 'two', 'three', 'four']);
  });
});

describe('setup', () => {
  it('installs docker on unique hosts, then sets up the app on app servers, in parallel, with MUP runner keys', async () => {
    const s = await setup("mongo: { servers: { four: {} } },");
    await setupAll(s.ctx);
    expect(s.ctx.runner.history).toEqual(['default.setup', 'docker.setup', 'meteor.setup']);
    const docker = s.log.filter((l) => l.endsWith(':docker-setup')).sort();
    expect(docker).toEqual(['four:docker-setup', 'one:docker-setup', 'three:docker-setup']);
    const meteor = s.log.filter((l) => l.endsWith(':meteor-setup')).sort();
    expect(meteor).toEqual(['one:meteor-setup', 'three:meteor-setup', 'two:meteor-setup']);
    // every docker setup finished before the first meteor setup; docker setups overlap
    expect(s.timeline.findIndex((t) => t.startsWith('start:') && t.endsWith(':meteor-setup'))).toBeGreaterThan(
      s.timeline.findLastIndex((t) => t.endsWith(':docker-setup')),
    );
    expect(s.timeline.slice(0, 2).every((t) => t.startsWith('start:'))).toBe(true);
    expect(s.out()).toMatch(/mongo.*phase 2/i);
    expect(s.out()).toMatch(/comet-deploy deploy/);
  });

  it('respects --servers', async () => {
    const s = await setup('', 'three');
    await setupAll(s.ctx);
    expect(s.log.sort()).toEqual(['three:docker-setup', 'three:meteor-setup']);
  });
});

describe('meteor destroy', () => {
  it('refuses without --force', async () => {
    const s = await setup();
    await expect(destroyApp(s.ctx, { force: false, sleep: async () => {} })).rejects.toThrow(CometError);
    expect(s.log).toEqual([]);
  });

  it('with --force stops the app and removes everything comet-deploy left, server by server', async () => {
    const s = await setup();
    let slept = 0;
    await destroyApp(s.ctx, { force: true, sleep: async (ms) => void (slept = ms) });
    expect(slept).toBe(5000);
    expect(s.log).toEqual([
      'one:meteor-stop',
      'one:meteor-destroy',
      'one:destroy-extra',
      'two:meteor-stop',
      'two:meteor-destroy',
      'two:destroy-extra',
      'three:meteor-stop',
      'three:meteor-destroy',
      'three:destroy-extra',
    ]);
    const extra = s.scripts['destroy-extra'];
    expect(extra).toContain("REPO='mup-myapp'");
    expect(extra).toContain('deploy-history.jsonl');
    expect(extra).toContain('deploy.lock');
    expect(extra).toContain('.prev');
  });
});

describe('docker ps through the CLI', () => {
  it('passes options through to docker ps on unique hosts', async () => {
    const { main } = await import('../../../src/cli/main.js');
    const { captureIO } = await import('../../helpers/fs.js');
    const dir = tempDir({ '.deploy/mup.js': MUP(), '.deploy/settings.json': '{"public":{}}' });
    const cmds: string[] = [];
    const sshPoolFactory = () => ({
      get: async (n: string) => ({ name: n, exec: async (c: string) => (cmds.push(`${n}:${c}`), { code: 0, stdout: 'CONTAINER ID\n', stderr: '' }) }) as unknown as SshConnection,
      closeAll: async () => {},
    });
    const io = captureIO();
    expect(await main(['docker', 'ps', '-a', '--config', '.deploy/mup.js'], io.io, { cwd: dir, sshPoolFactory })).toBe(0);
    expect(cmds).toEqual(['one:sudo docker ps -a 2>&1', 'three:sudo docker ps -a 2>&1']);
    expect(io.stdout()).toContain('[192.0.2.3] docker ps -a');
    const help = captureIO();
    expect(await main(['--help'], help.io, { cwd: dir })).toBe(0);
    for (const c of ['setup', 'deploy', 'reconfig', 'restart', 'rollback', 'history', 'unlock', 'status', 'logs', 'docker', 'meteor']) expect(help.stdout()).toContain(c);
  });
});
