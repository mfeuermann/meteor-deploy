import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../../src/core/context.js';
import { CometError } from '../../../src/core/errors.js';
import { createPluginApi } from '../../../src/hooks/api.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecOptions, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

async function setup(argv: Record<string, unknown> = {}) {
  const dir = tempDir({
    '.deploy/mup.js': `module.exports = {
      servers: { one: { host: '192.0.2.1', username: 'root', password: 'pw' } },
      app: { name: 'myapp', path: '../app', servers: { one: {} }, env: { ROOT_URL: 'http://a.com', MONGO_URL: 'mongodb://db/x' }, docker: { image: 'zodern/meteor' } },
    };`,
    '.deploy/settings.json': '{"public":{"a":1}}',
    '.deploy/other.json': '{"x":2}',
    'app/.meteor/versions': 'meteor@3.0.0\nmontiapm:agent@2.49.0\n',
  });
  const execs: string[] = [];
  const conn = {
    name: 'one',
    exec: async (cmd: string, o?: ExecOptions) => {
      execs.push(cmd);
      o?.onStdout?.('out\n');
      o?.onStderr?.('err\n');
      return { code: 2, stdout: 'out\n', stderr: 'err\n' };
    },
  } as unknown as SshConnection;
  const ctx = await createContext(
    { config: '.deploy/mup.js', _: ['logs'], ...argv },
    { cwd: dir, reporter: createReporter({ verbose: false, tty: false, write: () => {} }), sshPoolFactory: () => ({ get: async () => conn, closeAll: async () => {} }) },
  );
  const ran: string[] = [];
  const api = createPluginApi(ctx, async (key) => void ran.push(key)) as any;
  return { ctx, api, dir, execs, ran };
}

describe('the api object of method hooks', () => {
  it('getConfig returns the live config and setConfig replaces it', async () => {
    const s = await setup();
    s.api.getConfig().app.env.FROM_HOOK = 'yes';
    expect(s.ctx.config.app.env.FROM_HOOK).toBe('yes');
    const next = { ...s.ctx.config, app: { ...s.ctx.config.app, servers: {} } };
    s.api.setConfig(next);
    expect(s.ctx.config).toBe(next);
    expect(s.api.config).toBe(next);
    expect(s.ctx.appServers()).toEqual([]);
  });

  it('settings set by a hook is what getSettings returns later', async () => {
    const s = await setup();
    s.api.getSettings().public.b = 2;
    expect(s.ctx.getSettings()).toEqual({ public: { a: 1, b: 2 } });
    expect(s.api.settings).toBe(s.ctx.getSettings());
    s.api.settings = { public: { replaced: true } };
    expect(s.ctx.getSettings()).toEqual({ public: { replaced: true } });
  });

  it('getArgs drops comet-deploy own options', async () => {
    const s = await setup({ tail: 50, verbose: true, servers: 'one' });
    expect(s.api.getArgs()).toEqual(['logs', '--tail', 50]);
    expect(s.api.args).toEqual(['logs', '--tail', 50]);
    expect(s.api.getOptions()).toBe(s.ctx.argv);
    expect(s.api.program).toBe(s.ctx.argv);
    expect(s.api.getVerbose()).toBe(true);
    expect(s.api.verbose).toBe(true);
  });

  it('paths: getBasePath, base, configPath, resolvePath', async () => {
    const s = await setup();
    expect(s.api.getBasePath()).toBe(s.ctx.basePath);
    expect(s.api.base).toBe(s.ctx.basePath);
    expect(s.api.configPath).toBe(s.ctx.configPath);
    expect(s.api.resolvePath('~/x', 'y')).toBe(join(homedir(), 'x', 'y'));
  });

  it('runSSHCommand uses the pool for a configured server and returns code, output and host', async () => {
    const s = await setup();
    const r = await s.api.runSSHCommand(s.ctx.config.servers.one, 'uptime');
    expect(r).toEqual({ code: 2, output: 'out\nerr\n', host: '192.0.2.1' });
    expect(s.execs).toEqual(['uptime']);
    expect(await s.api.runSSHCommand({ host: '192.0.2.1', username: 'root' }, 'id')).toMatchObject({ host: '192.0.2.1' });
  });

  it('hasMeteorPackage reads .meteor/versions of app.path', async () => {
    const s = await setup();
    expect(s.api.hasMeteorPackage('montiapm:agent')).toBe(true);
    expect(s.api.hasMeteorPackage('agent')).toBe(false);
  });

  it('swarmEnabled is false', async () => {
    expect((await setup()).api.swarmEnabled()).toBe(false);
  });

  it('validateConfig returns problems as strings and scrubConfig hides secrets', async () => {
    const s = await setup();
    s.ctx.config.app.env.ROOT_URL = 'not a url';
    expect(s.api.validateConfig().some((p: string) => p.startsWith('app.env.ROOT_URL '))).toBe(true);
    expect(JSON.stringify(s.api.scrubConfig())).not.toContain('mongodb://db/x');
    expect(s.ctx.config.app.env.MONGO_URL).toBe('mongodb://db/x');
  });

  it('getSettingsFromPath reads a JSON file and throws a CometError for a missing one', async () => {
    const s = await setup();
    expect(s.api.getSettingsFromPath(join(s.dir, '.deploy/other.json'))).toEqual({ x: 2 });
    expect(() => s.api.getSettingsFromPath(join(s.dir, 'missing.json'))).toThrow(CometError);
  });

  it('runCommand runs the key', async () => {
    const s = await setup();
    await s.api.runCommand('meteor.restart');
    expect(s.ran).toEqual(['meteor.restart']);
  });

  it('commandHistory lists the keys as { name }', async () => {
    const s = await setup();
    await s.ctx.runner.run('default.logs', async () => {});
    expect(s.api.commandHistory).toEqual([{ name: 'default.logs' }]);
  });

  it.each(['getSessions', 'getSessionsForServers', 'getManagerSession', 'runTaskList', 'getDockerLogs', 'getServerInfo', 'serverInfoStale', 'swarmInfo', 'dockerServiceInfo', 'forwardPort'])(
    '%s is not supported',
    async (name) => {
      const s = await setup();
      expect(() => s.api[name]()).toThrow(`api.${name}() is not supported by comet-deploy (it needs MUP's nodemiral sessions). Use api.runSSHCommand(server, command) or a remoteCommand hook.`);
    },
  );

  it('tasks and statusHelpers are not supported', async () => {
    const s = await setup();
    expect(() => s.api.tasks.addCreateService).toThrow('api.tasks.addCreateService() is not supported by comet-deploy');
    expect(() => s.api.statusHelpers.StatusDisplay).toThrow('api.statusHelpers.StatusDisplay() is not supported by comet-deploy');
  });
});
